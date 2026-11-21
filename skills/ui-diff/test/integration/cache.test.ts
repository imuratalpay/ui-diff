import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../../src/config.js';
import { runPipeline, type RunOptions } from '../../src/pipeline.js';

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

// The clock line differs between runs unless both sides are frozen at the same instant.
const page = (title: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Cache</title><link rel="stylesheet" href="styles.css"></head>
<body><h1>${title}</h1><p>Now <span id="now"></span></p><button class="btn">Hover me</button>
<script>document.getElementById('now').textContent = new Date().toISOString();</script></body></html>`;
const css = (ms: number) => `body { margin: 32px; font: 18px Arial, sans-serif; }
.btn { padding: 10px 16px; border: 0; background: #2563eb; color: #fff; transition: background ${ms}ms linear; }
.btn:hover { background: #f97316; }`;

describe('base cache', { timeout: 300_000 }, () => {
  let dir: string;
  let repo: string;
  let baseSha: string;
  let headSha: string;
  let cacheDir: string;
  const options = (extra: Partial<RunOptions> = {}): RunOptions => ({ cfg: loadConfig(repo, repo), outDir: path.join(dir, `out-${Math.random().toString(36).slice(2)}`), base: baseSha, head: headSha, ...extra });

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-cache-run-'));
    repo = path.join(dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(repo, 'serve.mjs'), SERVER);
    writeFileSync(path.join(repo, 'index.html'), page('Welcome'));
    writeFileSync(path.join(repo, 'styles.css'), css(300));
    writeFileSync(
      path.join(repo, 'ui-diff.config.json'),
      JSON.stringify({
        startCommand: 'node serve.mjs --port {port}',
        routes: [{ path: '/', name: 'home', files: ['index.html', 'styles.css'], motion: { steps: [{ wait: 100 }, { hover: '.btn' }], durationMs: 1000 } }],
        viewports: [{ name: 'desktop', width: 800, height: 400 }],
        motion: { enabled: true, fps: 8 },
      }),
    );
    baseSha = commit(repo, 'base');
    writeFileSync(path.join(repo, 'index.html'), page('Welcome back'));
    writeFileSync(path.join(repo, 'styles.css'), css(600));
    headSha = commit(repo, 'head');
    cacheDir = path.join(repo, '.ui-diff', 'cache');
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('stores the base captures on a cold run, and a warm run reuses them without building or capturing base', async () => {
    const cold = (await runPipeline(options())).report;
    assert.equal(cold.baseCache?.hit, false);
    assert.equal(cold.baseCache?.stored, true);
    assert.ok(existsSync(path.join(cacheDir, cold.baseCache!.key, 'entry.json')));
    assert.equal(cold.timings!.prepare!.base.cached, undefined);

    const warm = (await runPipeline(options())).report;
    assert.deepEqual({ key: warm.baseCache?.key, hit: warm.baseCache?.hit }, { key: cold.baseCache!.key, hit: true });
    assert.equal(warm.timings!.prepare!.base.cached, true);
    assert.equal(warm.timings!.prepare!.base.bootMs, undefined, 'base was not started for the captures');
    assert.equal(warm.timings!.capture!.count, 1, 'only head was captured');
    const [c, w] = [cold.captures[0], warm.captures[0]];
    assert.deepEqual([w.status, w.diff?.changedPixels, w.styleDiff?.changes.map((x) => x.name)], [c.status, c.diff?.changedPixels, c.styleDiff?.changes.map((x) => x.name)]);
    assert.deepEqual(w.fingerprint!.base!.cache, { hit: true, key: cold.baseCache!.key });
    assert.equal(w.fingerprint!.base!.freeze.clock, w.fingerprint!.head!.freeze.clock, 'head is frozen at the instant base was captured');
    assert.equal(warm.base.label, cold.base.label);
    const clip = warm.motion[0];
    assert.ok(clip && clip.frames!.base > 1 && clip.frames!.head > 1, `the motion clip still replays base: ${JSON.stringify(clip)}`);
  });

  it('captures base again with --no-cache, after a config change, and when an entry is incomplete', async () => {
    assert.equal((await runPipeline(options({ cache: false }))).report.baseCache?.hit, false);
    const cfg = loadConfig(repo, repo);
    const wider = await runPipeline(options({ cfg: { ...cfg, viewports: [{ name: 'desktop', width: 900, height: 400 }] } }));
    assert.equal(wider.report.baseCache?.hit, false, 'a capture setting changed, so the key changed');
    const key = (await runPipeline(options())).report.baseCache!.key;
    rmSync(path.join(cacheDir, key, 'captures', 'home__desktop__light.png'));
    const repaired = (await runPipeline(options())).report;
    assert.equal(repaired.baseCache?.hit, false);
    assert.equal(repaired.baseCache?.stored, true);
    assert.equal((await runPipeline(options())).report.baseCache?.hit, true);
  });

  it('prints the key a run uses, and says when the cache was used in the timing line', async () => {
    const skillRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
    const stdout = execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), path.join(skillRoot, 'src', 'cli.ts'), 'cache-key', '--base', baseSha, '--head', headSha, '--quiet'], { cwd: repo, encoding: 'utf8' });
    const printed = JSON.parse(stdout) as { key: string; cacheDir: string };
    const outDir = path.join(dir, 'timing');
    const { report } = await runPipeline({ ...options(), outDir });
    assert.equal(printed.key, report.baseCache!.key);
    assert.equal(printed.cacheDir, '.ui-diff/cache');
    assert.match(readFileSync(path.join(outDir, 'comment.local.md'), 'utf8'), /prepare .*\(base: cached \d+\.\ds ‖ head: none/);
    assert.match(readFileSync(path.join(outDir, 'comment.local.md'), 'utf8'), /\| Base cache \| reused \(`base-[0-9a-f]{12}-[0-9a-f]{16}`\) \| — \|/);
    assert.ok(readdirSync(cacheDir).every((n) => n.startsWith('base-')), 'no temporary directories left behind');
    assert.match(readFileSync(path.join(git(repo, 'rev-parse', '--git-common-dir').startsWith('/') ? '' : repo, git(repo, 'rev-parse', '--git-common-dir'), 'info', 'exclude'), 'utf8'), /\/\.ui-diff\/cache\/|\/\.ui-diff\//);
  });
});
