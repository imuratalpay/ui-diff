import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main } from '../../src/cli.js';
import { parseConfig } from '../../src/config.js';
import { getFreePort, loopbackCandidates, serverLogWarnings, ServerStartError, startServer, waitForUrl, withHostOf } from '../../src/server.js';
import { planInstall } from '../../src/sides.js';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function ipv6Available(): boolean {
  const probe = spawnSync(process.execPath, ['-e', "require('net').createServer().listen(0, '::1', function () { this.close(); }).on('error', () => process.exit(1))"]);
  return probe.status === 0;
}

describe('loopback hosts', () => {
  it('tries the configured URL first, then the other loopback hosts', () => {
    assert.deepEqual(loopbackCandidates('http://127.0.0.1:3000/health'), ['http://127.0.0.1:3000/health', 'http://localhost:3000/health', 'http://[::1]:3000/health']);
    assert.deepEqual(loopbackCandidates('http://localhost:5173/'), ['http://localhost:5173/', 'http://127.0.0.1:5173/', 'http://[::1]:5173/']);
    assert.deepEqual(loopbackCandidates('http://app.test:8080/'), ['http://app.test:8080/']);
    assert.equal(withHostOf('http://127.0.0.1:3000', 'http://[::1]:3000/'), 'http://[::1]:3000');
  });

  it('defaults baseUrl to localhost', () => {
    assert.equal(parseConfig({}, { repoRoot: '/repo' }).baseUrl, 'http://localhost:{port}');
  });

  it('finds a server that only listens on IPv6 loopback when 127.0.0.1 is configured', { skip: !ipv6Available() && 'no IPv6 loopback' }, async () => {
    const server = http.createServer((_q, s) => s.end('ok'));
    await new Promise<void>((r) => server.listen(0, '::1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const ready = await waitForUrl(loopbackCandidates(`http://127.0.0.1:${port}/`), { timeoutMs: 5000, intervalMs: 50 });
      assert.equal(ready.status, 200);
      assert.notEqual(new URL(ready.url).hostname, '127.0.0.1');
    } finally {
      server.close();
    }
  });
});

describe('dev server start failures', () => {
  it('reports "unreachable" when nothing answers', async () => {
    const port = await getFreePort();
    await assert.rejects(waitForUrl(`http://127.0.0.1:${port}/`, { timeoutMs: 500, intervalMs: 50 }), (e: unknown) => e instanceof ServerStartError && e.reason === 'unreachable');
  });

  it('gives up early on persistent 5xx when asked to', async () => {
    const server = http.createServer((_q, s) => {
      s.statusCode = 500;
      s.end('boom');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const started = Date.now();
    try {
      await assert.rejects(
        waitForUrl(`http://127.0.0.1:${port}/`, { timeoutMs: 20000, intervalMs: 50, failOn5xxAfterMs: 300 }),
        (e: unknown) => e instanceof ServerStartError && e.reason === 'http-error' && /HTTP 500/.test(e.message),
      );
      assert.ok(Date.now() - started < 5000);
    } finally {
      server.close();
    }
  });

  it('rejects (instead of crashing) when the working directory is missing', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-cwd-'));
    try {
      await assert.rejects(
        startServer({ label: 'base', command: 'node -e 0', cwd: path.join(dir, '.\\site'), port: 1, url: 'http://localhost:1', readyUrl: 'http://localhost:1/', env: process.env, logFile: path.join(dir, 'log'), timeoutMs: 1000 }),
        /does not exist/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serves captures from the loopback host that answered', { skip: !ipv6Available() && 'no IPv6 loopback' }, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-v6-'));
    writeFileSync(path.join(dir, 'server.mjs'), "import http from 'node:http'; http.createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT), '::1');");
    const port = await getFreePort();
    const server = await startServer({
      label: 'head',
      command: `"${process.execPath}" server.mjs`,
      cwd: dir,
      port,
      url: `http://127.0.0.1:${port}`,
      readyUrl: `http://127.0.0.1:${port}/`,
      env: process.env,
      logFile: path.join(dir, 'server.log'),
      timeoutMs: 10000,
    });
    try {
      assert.notEqual(new URL(server.url).hostname, '127.0.0.1');
      assert.equal((await fetch(`${server.url}/`)).status, 200);
    } finally {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags Next.js dev resources blocked for the capture host', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-log-'));
    const file = path.join(dir, 'server.log');
    writeFileSync(file, '⚠ Blocked cross-origin request to Next.js dev resource /_next/hmr from "127.0.0.1".\n');
    assert.match(serverLogWarnings(file, 'base')[0], /client components may not have hydrated.*localhost/);
    writeFileSync(file, '✓ Ready in 300ms\n');
    assert.deepEqual(serverLogWarnings(file, 'base'), []);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('dependency plan', () => {
  function checkout(root: string, deps: Record<string, string>): void {
    mkdirSync(path.join(root, 'node_modules', 'react'), { recursive: true });
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: deps }));
    writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}');
  }

  it('links node_modules when the lockfile matches, but installs for Next.js (Turbopack)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-plan-'));
    const repo = path.join(dir, 'repo');
    const worktree = path.join(dir, 'worktree');
    try {
      for (const [deps, kind] of [
        [{ vite: '8' }, 'link'],
        [{ next: '16' }, 'command'],
      ] as const) {
        rmSync(repo, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
        checkout(repo, deps);
        if (kind === 'command') writeFileSync(path.join(repo, 'package-lock.json'), '{"lockfileVersion":3,"other":true}');
        mkdirSync(worktree, { recursive: true });
        writeFileSync(path.join(worktree, 'package.json'), JSON.stringify({ dependencies: deps }));
        writeFileSync(path.join(worktree, 'package-lock.json'), '{"lockfileVersion":3}');
        const plan = planInstall(parseConfig({}, { repoRoot: repo }), worktree);
        assert.equal(plan.kind, kind, JSON.stringify(plan));
        if (kind === 'command') {
          assert.match(plan.reason, /Next\.js/);
          assert.equal(plan.share, 'copy', 'Next.js may share another side\'s install only as a copy, never through symlinks');
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('error output', () => {
  it('prints the hint even with --quiet', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-hint-'));
    const cwd = process.cwd();
    const lines: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      process.chdir(dir);
      assert.equal(await main(['detect', '--quiet']), 1);
    } finally {
      process.stderr.write = write;
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
    assert.ok(lines.some((l) => l.includes('error: Not inside a git repository')));
    assert.ok(lines.some((l) => l.includes('hint: Run ui-diff from the root of the app repository.')));
  });

  it('explains how to get Chromium when it cannot be downloaded', () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-nobrowser-'));
    try {
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', '-e', "import('./src/capture.ts').then((m) => m.ensureBrowser()).then(() => process.exit(0), (e) => { console.error(e.message + ' || ' + e.hint); process.exit(1); })"],
        { cwd: skillRoot, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: empty, PLAYWRIGHT_DOWNLOAD_HOST: 'http://127.0.0.1:9', UI_DIFF_BROWSER_CHANNEL: '', UI_DIFF_CHROMIUM_PATH: '' }, encoding: 'utf8', timeout: 120000 },
      );
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Chromium is not installed and could not be downloaded/);
      assert.match(result.stderr, /UI_DIFF_BROWSER_CHANNEL=chrome/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
