import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { CaptureSession, launchBrowser } from '../../src/capture.js';
import { loadConfig } from '../../src/config.js';
import { runPipeline } from '../../src/pipeline.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** Any TrueType font on this machine, served by the fixture as a slow web font. */
const FONT = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/Library/Fonts/Arial.ttf',
].find((f) => existsSync(f));

// late.ttf answers after 1.5 s; missing.ttf is a 404.
const SERVER = `import http from 'node:http'; import { readFile } from 'node:fs/promises'; import path from 'node:path';
const root = path.dirname(new URL(import.meta.url).pathname);
http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/late.ttf') await new Promise((r) => setTimeout(r, 1500));
  const file = path.join(root, pathname.replace(/\\/$/, '/index.html'));
  try { const body = await readFile(file); res.writeHead(200, { 'content-type': file.endsWith('.ttf') ? 'font/ttf' : 'text/html' }); res.end(body); }
  catch { res.writeHead(404); res.end('missing'); }
}).listen(Number(process.argv[3] ?? process.env.PORT), '127.0.0.1');`;

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Freeze</title><style>
@font-face { font-family: Late; src: url(/late.ttf) format('truetype'); font-display: swap; }
@font-face { font-family: Gone; src: url(/missing.ttf) format('truetype'); }
body { margin: 24px; font: 18px/1.5 monospace; }
h1 { font: 40px Late, monospace; }
.gone { font-family: Gone, serif; }
.spin { width: 60px; height: 60px; background: linear-gradient(90deg, #2563eb, #f97316); animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
input { font-size: 20px; }
</style></head><body>
<h1>Late web font</h1>
<h2 id="js">Font added by a script</h2>
<p class="gone">Text whose font fails to load</p>
<p>Now <span id="now"></span> · posted <span id="ago"></span></p>
<p>Random <span id="rand"></span> · id <span id="uuid"></span></p>
<div class="spin"></div>
<input id="field" value="caret blinks here" autofocus>
<script>
const posted = Date.parse('2026-01-01T00:00:00Z');
const tick = () => {
  document.getElementById('now').textContent = new Date().toISOString();
  document.getElementById('ago').textContent = Math.round((Date.now() - posted) / 1000) + ' seconds ago';
};
tick();
setInterval(tick, 50);
document.getElementById('rand').textContent = String(Math.random());
document.getElementById('uuid').textContent = crypto.randomUUID();
setTimeout(() => {
  const face = new FontFace('LateJs', 'url(/late.ttf?js)');
  document.fonts.add(face);
  face.load();
  document.getElementById('js').style.fontFamily = 'LateJs, monospace';
}, 300);
</script></body></html>`;

describe('input freeze', { timeout: 300_000, skip: !FONT && 'no TrueType font found on this machine for the web-font fixture' }, () => {
  let dir: string;
  let repo: string;
  let sha: string;

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-freeze-'));
    repo = path.join(dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(repo, 'serve.mjs'), SERVER);
    writeFileSync(path.join(repo, 'index.html'), PAGE);
    copyFileSync(FONT!, path.join(repo, 'late.ttf'));
    // No network-idle wait, so only the font wait stands between the slow font and the screenshot.
    writeFileSync(
      path.join(repo, 'ui-diff.config.json'),
      JSON.stringify({ startCommand: 'node serve.mjs --port {port}', routes: [{ path: '/', name: 'freeze' }], viewports: [{ name: 'desktop', width: 800, height: 600 }], capture: { networkIdleTimeoutMs: 0 } }),
    );
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'fixture');
    sha = git(repo, 'rev-parse', 'HEAD');
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('captures a clock, random output, a CSS animation, a caret and late web fonts identically on both sides', async () => {
    const { report } = await runPipeline({ cfg: loadConfig(repo, repo), outDir: path.join(dir, 'frozen'), base: sha, head: sha, allRoutes: true });
    const capture = report.captures[0];
    assert.equal(capture.error, undefined);
    assert.equal(capture.status, 'unchanged', `expected zero diff, got ${capture.diff?.changedPixels} changed pixels`);
    assert.equal(capture.diff?.changedPixels, 0);
  });

  it('shows the same page as changed when the clock is not frozen (the fixture really moves)', async () => {
    const cfg = loadConfig(repo, repo);
    const { report } = await runPipeline({ cfg: { ...cfg, freeze: { ...cfg.freeze, clock: false } }, outDir: path.join(dir, 'running'), base: sha, head: sha, allRoutes: true });
    assert.equal(report.captures[0].status, 'changed');
  });

  it('records which web fonts loaded and which failed', async () => {
    const cfg = loadConfig(repo, repo);
    const port = 40000 + Math.floor(Math.random() * 20000);
    const server = spawn(process.execPath, [path.join(repo, 'serve.mjs'), '--port', String(port)], { stdio: 'ignore' });
    const browser = await launchBrowser();
    try {
      for (let i = 0; i < 50; i++) {
        if (await fetch(`http://127.0.0.1:${port}/`).then((r) => r.ok).catch(() => false)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const session = new CaptureSession(browser, { cfg, runStart: new Date() });
      const route = cfg.routes[0];
      const record = await session.capture({ id: 'freeze', side: 'head', route, viewport: cfg.viewports[0], theme: cfg.themes[0], url: `http://127.0.0.1:${port}/`, file: path.join(dir, 'fonts.png') });
      assert.equal(record.ok, true, record.error ?? '');
      assert.deepEqual(record.fonts, { loaded: ['Late', 'LateJs'], failed: ['Gone'], pending: [] });
    } finally {
      await browser.close();
      server.kill();
    }
  });
});
