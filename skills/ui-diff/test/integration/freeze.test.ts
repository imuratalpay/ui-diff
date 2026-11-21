import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('records a measured capture fingerprint per side, without paths, hosts, users or env values', async () => {
    const outDir = path.join(dir, 'fingerprint');
    const { report } = await runPipeline({ cfg: loadConfig(repo, repo), outDir, base: sha, head: sha, allRoutes: true });
    const fp = report.captures[0].fingerprint!;
    assert.deepEqual(fp.differences, []);
    for (const side of [fp.base!, fp.head!]) {
      assert.equal(side.commit, sha);
      assert.deepEqual(side.viewport, { width: 800, height: 600, deviceScaleFactor: 1, isMobile: false });
      assert.equal(side.browser.name, 'chromium');
      assert.match(side.browser.version, /^\d+\.\d+/);
      assert.match(side.browser.userAgent, /Chrome\//);
      assert.deepEqual(side.fonts, { loaded: ['Late', 'LateJs'], failed: ['Gone'], pending: [] });
      // Frozen at this run's start, or, when base came from the base cache, at the instant it was captured, on both sides.
      assert.deepEqual(side.freeze, { clock: report.baseCache?.hit ? fp.base!.freeze.clock : report.createdAt, seed: 795556381, animations: true, fonts: true });
      assert.equal(side.freeze.clock, fp.head!.freeze.clock);
      assert.deepEqual(side.media, { reducedMotion: 'reduce', colorScheme: 'light', locale: 'en-US', timezone: 'UTC' });
      assert.equal(side.data, 'not declared');
    }
    const stored = readFileSync(path.join(outDir, 'report.json'), 'utf8');
    const json = JSON.stringify(report.captures[0].fingerprint);
    for (const secret of [dir, repo, os.homedir(), os.hostname(), os.userInfo().username, process.env.PATH ?? '']) {
      if (secret.length > 3) assert.ok(!json.includes(secret), `fingerprint contains ${secret}`);
    }
    assert.ok(stored.includes('"fingerprint"'));
  });

  it('warns in the comment when base and head were captured in different environments', async () => {
    writeFileSync(path.join(repo, 'index.html'), PAGE.replace("url(/missing.ttf) format('truetype')", "url(/late.ttf?gone) format('truetype')"));
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'the missing font now loads');
    const head = git(repo, 'rev-parse', 'HEAD');
    try {
      const cfg = loadConfig(repo, repo);
      const outDir = path.join(dir, 'env-diff');
      const { report } = await runPipeline({ cfg: { ...cfg, fingerprint: { dataLabel: 'fixture page v1' } }, outDir, base: sha, head, allRoutes: true });
      const capture = report.captures[0];
      assert.equal(capture.status, 'changed');
      assert.deepEqual(capture.fingerprint!.differences, ['fonts loaded: base Late, LateJs · head Gone, Late, LateJs', 'fonts failed: base Gone · head none']);
      assert.equal(capture.fingerprint!.head!.data, 'fixture page v1');
      assert.match(readFileSync(path.join(outDir, 'comment.local.md'), 'utf8'), /The capture environment differed between base and head\*\*.*fonts failed: base Gone · head none/);
    } finally {
      git(repo, 'reset', '-q', '--hard', sha);
    }
  });

  it('measures where the run spent its time', async () => {
    const cfg = loadConfig(repo, repo);
    const outDir = path.join(dir, 'timings');
    const before = Date.now();
    const { report } = await runPipeline({ cfg: { ...cfg, a11y: { ...cfg.a11y, enabled: true } }, outDir, base: sha, head: sha, allRoutes: true });
    const elapsed = Date.now() - before;
    const t = report.timings!;
    assert.ok(t.totalMs > 0 && t.totalMs <= elapsed, `total ${t.totalMs} within the ${elapsed} ms the call took`);
    for (const side of [t.prepare!.base, t.prepare!.head]) {
      assert.equal(side.mode, 'worktree');
      assert.deepEqual(side.install && side.install.kind, 'none', 'the fixture has no package.json');
      assert.ok(side.bootMs! > 0 && side.checkoutMs! >= 0 && side.totalMs >= side.bootMs!);
    }
    assert.ok(t.prepare!.wallMs >= Math.max(t.prepare!.base.totalMs, t.prepare!.head.totalMs) - 5, 'sides prepare in parallel');
    assert.equal(t.capture!.count, 2);
    assert.ok(['base', 'head'].includes(t.capture!.slowest!.side) && t.capture!.slowest!.id === report.captures[0].id);
    assert.ok(t.capture!.slowest!.ms <= t.capture!.ms);
    assert.ok(t.extras!.a11yMs! > 0);
    assert.equal(t.extras!.motionMs, undefined);
    const phases = t.detectMs + t.prepare!.wallMs + t.browserMs! + t.capture!.ms + t.diffMs! + (t.extras!.a11yMs ?? 0);
    assert.ok(phases <= t.totalMs + t.extras!.a11yMs!, `phases ${phases} fit in total ${t.totalMs} (a11y overlaps capture)`);
    assert.match(readFileSync(path.join(outDir, 'comment.local.md'), 'utf8'), /<details><summary>⏱ .* total · detect .* · prepare .*\(base: none .*, boot .* ‖ head: none .*, boot .*\)/);
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
