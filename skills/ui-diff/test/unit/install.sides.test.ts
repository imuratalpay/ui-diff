import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parseConfig } from '../../src/config.js';
import { lockfileHash, lockfileHasPackages, planInstall, SharedInstalls } from '../../src/sides.js';

const LOCK = '{\n  "name": "app",\n  "lockfileVersion": 3,\n  "packages": {\n    "": { "name": "app" },\n    "node_modules/a": { "version": "1.0.0" }\n  }\n}\n';
/** What npm writes for an app without dependencies: only the root package. */
const EMPTY_LOCK = '{\n  "name": "app",\n  "lockfileVersion": 3,\n  "packages": {\n    "": { "name": "app" }\n  }\n}\n';

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-install-'));
  const repo = path.join(dir, 'repo');
  mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
  writeFileSync(path.join(repo, 'package.json'), '{"name":"app"}');
  writeFileSync(path.join(repo, 'package-lock.json'), LOCK);
  const worktree = (name: string, lock: string) => {
    const wt = path.join(dir, name);
    mkdirSync(wt, { recursive: true });
    writeFileSync(path.join(wt, 'package.json'), '{"name":"app"}');
    writeFileSync(path.join(wt, 'package-lock.json'), lock);
    return wt;
  };
  const cfg = parseConfig({ startCommand: 'node serve.mjs {port}' }, { repoRoot: repo });
  return { dir, repo, worktree, cfg };
}

describe('dependency installs in worktrees', () => {
  it('reuses your node_modules when the lockfile only differs in line endings or trailing whitespace', () => {
    const { dir, worktree, cfg } = setup();
    try {
      const wt = worktree('head', LOCK.replace(/\n/g, '\r\n') + '\n\n');
      assert.equal(lockfileHash(path.join(wt, 'package-lock.json')), lockfileHash(path.join(cfg.repoRoot, 'package-lock.json')));
      const plan = planInstall(cfg, wt);
      assert.equal(plan.kind, 'link');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('installs when the lockfile really differs, with a key shared by identical lockfiles', () => {
    const { dir, worktree, cfg } = setup();
    try {
      const other = LOCK.replace('"node_modules/a": { "version": "1.0.0" }', '"node_modules/x": { "version": "1.0.0" }');
      const base = planInstall(cfg, worktree('base', other));
      const head = planInstall(cfg, worktree('head', other.replace(/\n/g, '\r\n')));
      const third = planInstall(cfg, worktree('third', LOCK.replace('"app"', '"app2"')));
      assert.equal(base.kind, 'command');
      assert.match(base.command!, /^npm ci/);
      assert.ok(base.lockKey);
      assert.equal(head.lockKey, base.lockKey);
      assert.notEqual(third.lockKey, base.lockKey);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says the checkout has no node_modules to reuse when only that is missing, instead of calling the lockfile different', () => {
    const { dir, worktree, cfg } = setup();
    try {
      rmSync(path.join(cfg.repoRoot, 'node_modules'), { recursive: true });
      const plan = planInstall(cfg, worktree('head', LOCK));
      assert.equal(plan.kind, 'command');
      assert.equal(plan.reason, 'package-lock.json matches your checkout, but your checkout has no node_modules to reuse');
      assert.ok(plan.lockKey, 'base and head can still share the one install');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips the install when the lockfile lists no packages', () => {
    const { dir, worktree, cfg } = setup();
    try {
      rmSync(path.join(cfg.repoRoot, 'node_modules'), { recursive: true });
      writeFileSync(path.join(cfg.repoRoot, 'package-lock.json'), EMPTY_LOCK);
      for (const lock of [EMPTY_LOCK, '{"lockfileVersion":1,"requires":true}', '{"lockfileVersion":1,"dependencies":{}}']) {
        const plan = planInstall(cfg, worktree('head', lock));
        assert.deepEqual([plan.kind, plan.reason], ['none', 'package-lock.json lists no packages, so there is nothing to install']);
      }
      const stale = worktree('stale', EMPTY_LOCK);
      writeFileSync(path.join(stale, 'package.json'), '{"name":"app","dependencies":{"left-pad":"^1.3.0"}}');
      assert.equal(planInstall(cfg, stale).kind, 'command', 'package.json declares dependencies the lockfile lacks: install');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads whether other lockfiles list packages', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-lock-'));
    try {
      const has = (file: string, text: string) => {
        writeFileSync(path.join(dir, file), text);
        return lockfileHasPackages(path.join(dir, file));
      };
      assert.equal(has('pnpm-lock.yaml', "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n"), false);
      assert.equal(has('pnpm-lock.yaml', "lockfileVersion: '9.0'\n\npackages:\n\n  left-pad@1.3.0:\n    resolution: {integrity: sha512-x}\n"), true);
      assert.equal(has('yarn.lock', '# THIS IS AN AUTOGENERATED FILE.\n# yarn lockfile v1\n\n\n'), false);
      assert.equal(has('yarn.lock', '# yarn lockfile v1\n\nleft-pad@^1.3.0:\n  version "1.3.0"\n'), true);
      assert.equal(has('yarn.lock', '__metadata:\n  version: 8\n  cacheKey: 10c0\n\n"app@workspace:.":\n  version: 0.0.0-use.local\n'), false);
      assert.equal(has('bun.lock', '{\n  "lockfileVersion": 1,\n  "workspaces": { "": { "name": "app" } },\n  "packages": {}\n}\n'), false);
      assert.equal(has('bun.lock', '{\n  "lockfileVersion": 1,\n  "packages": {\n    "left-pad": ["left-pad@1.3.0", "", {}, "sha512-x"],\n  },\n}\n'), true);
      assert.equal(has('bun.lockb', 'binary'), true, 'unreadable: assume it has packages');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs one install per lockfile and lets the other side link to it', async () => {
    const shared = new SharedInstalls();
    let installs = 0;
    const install = async () => {
      installs++;
      await new Promise((r) => setTimeout(r, 20));
    };
    const [base, head] = await Promise.all([shared.run('k', '/tmp/base', install), shared.run('k', '/tmp/head', install)]);
    assert.equal(installs, 1);
    assert.equal(base, undefined);
    assert.equal(head, '/tmp/base');
    assert.equal(await shared.run('other', '/tmp/x', install), undefined);
    assert.equal(installs, 2);
  });

  it('installs on its own when the shared install failed', async () => {
    const shared = new SharedInstalls();
    let calls = 0;
    const failing = shared.run('k', '/tmp/base', async () => {
      calls++;
      throw new Error('boom');
    });
    const second = shared.run('k', '/tmp/head', async () => {
      calls++;
    });
    await assert.rejects(failing, /boom/);
    assert.equal(await second, undefined);
    assert.equal(calls, 2);
  });
});
