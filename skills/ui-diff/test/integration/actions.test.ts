import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../../src/config.js';
import { readPng } from '../../src/image.js';
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
  try { const body = await readFile(file); res.writeHead(200, { 'content-type': 'text/html' }); res.end(body); }
  catch { res.writeHead(404); res.end('missing'); }
}).listen(Number(process.argv[3] ?? process.env.PORT), '127.0.0.1');`;

const FILLER = Array.from({ length: 12 }, (_, i) => `<p style="height:120px;margin:0">Paragraph ${i + 1}</p>`).join('');
// The button is only created once its placeholder scrolls into view (lazy-loaded content).
const LAZY = `<div id="slot" style="height:60px"></div>
<script>new IntersectionObserver((entries, observer) => {
  if (!entries.some((e) => e.isIntersecting)) return;
  observer.disconnect();
  const button = document.createElement('button');
  button.id = 'lazy-button';
  button.textContent = 'Open';
  button.onclick = () => { document.body.style.background = 'rgb(0, 128, 0)'; };
  document.getElementById('slot').appendChild(button);
}).observe(document.getElementById('slot'));</script>`;
const page = (lazy: boolean) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Actions</title><style>body{margin:0;font:16px Arial;background:#fff}</style></head><body>${FILLER}${lazy ? LAZY : ''}</body></html>`;

describe('route actions run after the page settled', { timeout: 300_000 }, () => {
  let dir: string;
  let repo: string;
  let baseSha: string;
  let headSha: string;

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-actions-'));
    repo = path.join(dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(repo, 'serve.mjs'), SERVER);
    writeFileSync(path.join(repo, 'index.html'), page(false));
    writeFileSync(
      path.join(repo, 'ui-diff.config.json'),
      JSON.stringify({
        startCommand: 'node serve.mjs --port {port}',
        routes: [{ path: '/', name: 'home', actions: [{ click: '#lazy-button' }] }],
        viewports: [{ name: 'desktop', width: 800, height: 600 }],
        capture: { fixedTime: '2026-01-01T00:00:00Z', timeoutMs: 5000 },
      }),
    );
    baseSha = commit(repo, 'no button');
    writeFileSync(path.join(repo, 'index.html'), page(true));
    headSha = commit(repo, 'lazy button');
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('clicks a lazy-loaded element on head and warns that it is missing on base', async () => {
    const cfg = loadConfig(repo, repo);
    const outDir = path.join(dir, 'out');
    const { report } = await runPipeline({ cfg, outDir, base: baseSha, head: headSha, allRoutes: true });
    const capture = report.captures[0];
    assert.equal(capture.error, undefined, 'neither side may fail because of the action');
    assert.equal(capture.status, 'changed');
    const head = readPng(path.join(outDir, capture.images.head!));
    assert.deepEqual([...head.data.subarray(0, 3)], [0, 128, 0], 'the click on the lazy-loaded button ran before the head screenshot');
    const base = readPng(path.join(outDir, capture.images.base!));
    assert.deepEqual([...base.data.subarray(0, 3)], [255, 255, 255]);
    const warning = capture.warnings.find((w) => w.startsWith('base: route action'));
    assert.equal(warning, 'base: route action "click #lazy-button" skipped: no element matches it on base');
    assert.ok(!capture.warnings.some((w) => w.startsWith('head: route action')), JSON.stringify(capture.warnings));
    assert.match(readFileSync(path.join(outDir, 'comment.local.md'), 'utf8'), /route action "click #lazy-button" skipped/);
  });
});
