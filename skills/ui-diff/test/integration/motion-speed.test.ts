import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../../src/config.js';
import { runPipeline } from '../../src/pipeline.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const commit = (cwd: string, message: string) => {
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.name=ui-diff-test', '-c', 'user.email=test@example.com', 'commit', '-qm', message);
  return git(cwd, 'rev-parse', 'HEAD');
};

const SERVER = `import http from 'node:http'; import { readFile } from 'node:fs/promises'; import path from 'node:path';
const root = path.dirname(new URL(import.meta.url).pathname);
http.createServer(async (req, res) => {
  const file = path.join(root, new URL(req.url, 'http://x').pathname.replace(/\\/$/, '/index.html'));
  try { const body = await readFile(file); res.writeHead(200, { 'content-type': file.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(body); }
  catch { res.writeHead(404); res.end('missing'); }
}).listen(Number(process.argv[3] ?? process.env.PORT), '127.0.0.1');`;

const page = (footer: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Motion</title><link rel="stylesheet" href="styles.css"></head>
<body><main><h1>Motion</h1><button class="btn">Hover me</button></main>
<footer>${footer}</footer></body></html>`;
const css = (ms: number) => `body { margin: 40px; font: 18px Arial, sans-serif; }
.btn { padding: 12px 20px; border: 0; background: #2563eb; color: #fff; transform: scale(1); transition: transform ${ms}ms linear, background ${ms}ms linear; }
.btn:hover { background: #f97316; transform: scale(1.4); }`;

const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

describe('motion clips: which routes, and how fast', { timeout: 300_000 }, () => {
  let dir: string;
  let repo: string;
  const shas: Record<string, string> = {};

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-motion-speed-'));
    repo = path.join(dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(repo, 'serve.mjs'), SERVER);
    writeFileSync(path.join(repo, 'index.html'), page('© 2025 Acme'));
    writeFileSync(path.join(repo, 'styles.css'), css(600));
    writeFileSync(
      path.join(repo, 'ui-diff.config.json'),
      JSON.stringify({
        startCommand: 'node serve.mjs --port {port}',
        routes: [{ path: '/', name: 'home', files: ['index.html', 'styles.css'], motion: { steps: [{ wait: 200 }, { hover: '.btn' }], durationMs: 1500 } }],
        viewports: [{ name: 'desktop', width: 800, height: 400 }],
        motion: { enabled: true, format: 'gif+webm', fps: 8 },
      }),
    );
    shas.base = commit(repo, 'base');
    writeFileSync(path.join(repo, 'index.html'), page('Copyright 2026, Acme Incorporated. All rights reserved.'));
    shas.footer = commit(repo, 'footer year');
    git(repo, 'checkout', '-q', shas.base);
    writeFileSync(path.join(repo, 'styles.css'), css(1000));
    shas.slower = commit(repo, 'slower hover transition');
    git(repo, 'checkout', '-q', 'main');
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('records no clip when the changed files touch no animation and no element the script uses', async () => {
    const { report } = await runPipeline({ cfg: loadConfig(repo, repo), outDir: path.join(dir, 'footer'), base: shas.base, head: shas.footer });
    assert.equal(report.captures[0].status, 'changed', JSON.stringify({ base: report.base, head: report.head, diff: report.captures[0].diff, routes: report.routes }));
    assert.deepEqual(report.motion, []);
    assert.deepEqual(report.motionNoAnimation, ['/']);
    assert.match(readFileSync(path.join(dir, 'footer', 'comment.local.md'), 'utf8'), /Motion not recorded for `\/`: their changed files touch no transition/);
  });

  it('records a transition-only change, base and head in parallel, GIF frames and WebM from the same page load, with the same result as one after the other', async () => {
    const cfg = loadConfig(repo, repo);
    const run = async (parallel: boolean) => {
      const outDir = path.join(dir, parallel ? 'parallel' : 'sequential');
      const { report } = await runPipeline({ cfg: { ...cfg, motion: { ...cfg.motion, parallel } }, outDir, base: shas.base, head: shas.slower });
      return { report, outDir };
    };
    const sequential = await run(false);
    const parallel = await run(true);
    for (const { report, outDir } of [sequential, parallel]) {
      assert.equal(report.motionNoAnimation, undefined);
      const clip = report.motion[0];
      assert.equal(clip.error, undefined);
      assert.ok(clip.frames!.base > 1 && clip.frames!.head > 1, JSON.stringify(clip.frames));
      assert.equal(clip.warnings, undefined);
      assert.equal(readFileSync(path.join(outDir, clip.gif!)).subarray(0, 3).toString(), 'GIF');
      for (const file of [clip.webm!.base!, clip.webm!.head!]) {
        assert.deepEqual(readFileSync(path.join(outDir, file)).subarray(0, 4), WEBM, file);
        assert.ok(statSync(path.join(outDir, file)).size > 1000);
      }
    }
    assert.equal(parallel.report.captures[0].status, 'unchanged', 'a transition-only change leaves the still capture unchanged, yet gets a clip');
    const [s, p] = [sequential.report.motion[0], parallel.report.motion[0]];
    assert.deepEqual({ steps: p.steps, frames: p.frames, warnings: p.warnings, webm: p.webm, gif: p.gif }, { steps: s.steps, frames: s.frames, warnings: s.warnings, webm: s.webm, gif: s.gif });
    assert.ok(parallel.report.timings!.extras!.motionMs! < sequential.report.timings!.extras!.motionMs!, `parallel ${parallel.report.timings!.extras!.motionMs} ms vs sequential ${sequential.report.timings!.extras!.motionMs} ms`);
  });
});
