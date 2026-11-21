import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadConfig, type ResolvedConfig } from '../../src/config.js';
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
const page = (price: string, promo: string, ad: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Regions</title>
<style>body{margin:24px;font:18px Arial,sans-serif} section{margin-bottom:24px;padding:16px;border:1px solid #e5e7eb} .ad{background:#fef3c7;height:60px}</style></head>
<body><section class="pricing"><h2>Pro</h2><p class="price">${price}</p></section><section class="promo"><p>${promo}</p></section><div class="ad">${ad}</div></body></html>`;

describe('focus and ignore regions in a run', { timeout: 300_000 }, () => {
  let dir: string;
  let repo: string;
  let base: string;
  let head: string;
  const run = async (cfg: ResolvedConfig, name: string) => {
    const outDir = path.join(dir, name);
    const { report } = await runPipeline({ cfg, outDir, base, head, allRoutes: true });
    return { report, comment: readFileSync(path.join(outDir, 'comment.local.md'), 'utf8') };
  };

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-regions-'));
    repo = path.join(dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(repo, 'serve.mjs'), SERVER);
    writeFileSync(path.join(repo, 'index.html'), page('$9 / month', 'Spring sale ends Friday', 'Ad: buy shoes'));
    writeFileSync(
      path.join(repo, 'ui-diff.config.json'),
      JSON.stringify({ startCommand: 'node serve.mjs --port {port}', routes: [{ path: '/', name: 'home' }], viewports: [{ name: 'desktop', width: 800, height: 600 }], focus: ['.pricing', '.missing'], ignore: ['.ad', '.gone'] }),
    );
    base = commit(repo, 'base');
    writeFileSync(path.join(repo, 'index.html'), page('$12 / month', 'Summer sale starts Monday', 'Ad: rent a car today'));
    head = commit(repo, 'head');
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('diffs only inside the focus, leaves the ignored area out, and warns about selectors that matched nothing', async () => {
    const cfg = loadConfig(repo, repo);
    const { report, comment } = await run(cfg, 'focused');
    const c = report.captures[0];
    assert.equal(c.status, 'changed');
    assert.deepEqual(c.styleDiff!.changes.map((x) => x.changes.map((p) => `${p.property} ${p.before} → ${p.after}`)), [["text '$9 / month' → '$12 / month'"]], 'only the focused price, not the promo or the ad');
    assert.ok(c.diff!.regions.every((r) => r.y < 150), `every changed area is in the pricing section at the top: ${JSON.stringify(c.diff!.regions)}`);
    assert.deepEqual(c.regions, { focus: ['.pricing', '.missing'], ignore: ['.ad', '.gone'], focusOnly: true });
    assert.ok(c.warnings.includes('focus selector `.missing` matched nothing on base and head'));
    assert.ok(c.warnings.includes('ignore selector `.gone` matched nothing on base and head'));
    assert.match(comment, /<sub>Focused on `\.pricing`, `\.missing` \(only changes inside are compared\); ignored `\.ad`, `\.gone`\.<\/sub>/);
    assert.match(comment, /focus selector `\.missing` matched nothing on base and head/);
  });

  it('writes a still pair and a blink GIF per changed area, cropped inside the focus', async () => {
    const outDir = path.join(dir, 'focused');
    const report = JSON.parse(readFileSync(path.join(outDir, 'report.json'), 'utf8')) as { captures: Array<{ images: { pairs: string[]; blinks: string[]; focus: string[] }; diff: { focusBoxes: Array<{ x: number; y: number; height: number }> } }> };
    const c = report.captures[0];
    assert.equal(c.images.pairs.length, c.images.focus.length);
    assert.equal(c.images.blinks.length, c.images.focus.length);
    assert.equal(readFileSync(path.join(outDir, c.images.blinks[0])).subarray(0, 3).toString(), 'GIF');
    // The padding would reach past the section edge at (24, 24); the promo section starts below 190.
    for (const b of c.diff.focusBoxes) assert.ok(b.x >= 24 && b.y >= 24 && b.y + b.height < 190, `crop stays inside the pricing section: ${JSON.stringify(b)}`);
  });

  it('compares the whole page when no focus selector matches, still ignoring the ignored area', async () => {
    const cfg = loadConfig(repo, repo);
    const { report } = await run({ ...cfg, focus: ['.missing'] }, 'fallback');
    const c = report.captures[0];
    assert.equal(c.regions!.focusOnly, false);
    assert.ok(c.warnings.includes('no focus selector matched, so the whole page was compared'));
    const texts = c.styleDiff!.changes.map((x) => x.changes.map((p) => p.after).join());
    assert.deepEqual(texts.sort(), ["'$12 / month'", "'Summer sale starts Monday'"], 'the promo now counts; the ad is still ignored');
  });

  it('keys the base cache on the regions', async () => {
    const cfg = loadConfig(repo, repo);
    const a = (await run(cfg, 'key-a')).report.baseCache!.key;
    const b = (await run({ ...cfg, ignore: ['.ad'] }, 'key-b')).report.baseCache!.key;
    assert.notEqual(a, b);
  });
});
