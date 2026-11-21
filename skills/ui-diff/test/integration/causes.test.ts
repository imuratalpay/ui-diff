import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { parseConfig } from '../../src/config.js';
import { runPipeline } from '../../src/pipeline.js';
import type { Report } from '../../src/report.js';

const SERVER = `import http from 'node:http'; import { readFileSync } from 'node:fs';
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
http.createServer((req, res) => { const css = req.url === '/app.css'; res.writeHead(200, { 'content-type': css ? 'text/css' : 'text/html' }); res.end(readFileSync(css ? 'app.css' : 'index.html')); }).listen(port, '127.0.0.1');
`;
const HTML = `<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body>
<header class="hero"><h1>Plans for every team</h1><p>Start free, upgrade when you grow.</p>
<div class="actions"><a class="cta" href="#">Start free trial</a><a class="more" href="#">See how it works</a></div></header>
<main><section class="card"><h2>Pro</h2><p>Everything in Free, plus more.</p></section></main></body></html>`;
const css = (padding: string, background: string) =>
  `body{margin:0;font:16px Arial,sans-serif;color:#0f172a} .hero{padding:48px 24px;text-align:center} .actions{display:flex;justify-content:center;align-items:center;gap:16px} .cta{display:inline-block;padding:${padding};background:${background};color:#fff;border-radius:6px;text-decoration:none} .more{color:#2563eb} main{padding:24px} .card{border:1px solid #e5e7eb;padding:16px}`;

describe('causes and effects in a real run', { timeout: 300_000 }, () => {
  let dir: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const commit = (padding: string, background: string, branch: string) => {
    git('checkout', '-q', '-B', branch, 'main');
    writeFileSync(path.join(dir, 'app.css'), css(padding, background));
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qam', branch);
  };

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-causes-'));
    git('init', '-q', '-b', 'main');
    writeFileSync(path.join(dir, 'serve.mjs'), SERVER);
    writeFileSync(path.join(dir, 'index.html'), HTML);
    writeFileSync(path.join(dir, 'app.css'), css('8px 14px', '#2563eb'));
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'base');
    commit('12px 18px', '#0b7a5b', 'padding-and-background');
    commit('12px 18px', '#2563eb', 'padding-only');
    // A narrow actions row, then only a longer label: the link beside it wraps to two lines.
    git('checkout', '-q', '-B', 'narrow', 'main');
    writeFileSync(path.join(dir, 'app.css'), css('8px 14px', '#2563eb').replace('gap:16px}', 'gap:16px;width:320px;margin:0 auto}'));
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qam', 'narrow');
    git('checkout', '-q', '-B', 'label', 'narrow');
    writeFileSync(path.join(dir, 'index.html'), HTML.replace('>Start free trial<', '>Start your free 14-day trial<'));
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qam', 'label');
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  const run = async (head: string, base = 'main') => {
    const cfg = parseConfig({ startCommand: 'node serve.mjs --port {port}', routes: [{ path: '/', name: 'home', files: ['index.html', 'app.css'] }], viewports: [{ name: 'desktop', width: 1000, height: 700 }] }, { repoRoot: dir });
    const outDir = path.join(dir, '.ui-diff', head);
    await runPipeline({ cfg, outDir, base, head, cache: false });
    return { report: JSON.parse(readFileSync(path.join(outDir, 'report.json'), 'utf8')) as Report, comment: readFileSync(path.join(outDir, 'comment.local.md'), 'utf8') };
  };

  it('counts a padding and background change as 2, with the size, the move and the pushed elements as effects of the padding', async () => {
    const { report, comment } = await run('padding-and-background');
    assert.equal(comment.split('\n')[1], '### UI diff (local preview) — 2 measured changes on 1 route');
    assert.match(comment, /- `link 'Start free trial'` \(`a\.cta`\): padding 8px 14px → 12px 18px — desktop\n {2}- size [\d.]+×[\d.]+px → [\d.]+×[\d.]+px, moved 4px left \(from the padding change\)\n/);
    assert.match(comment, /- `link 'Start free trial'` \(`a\.cta`\): background #2563eb → #0b7a5b — desktop\n/);
    const groups = report.measured!;
    const padding = groups.find((g) => g.property === 'padding')!;
    assert.deepEqual(groups.filter((g) => g.kind !== 'effect').map((g) => `${g.kind} ${g.property}`), ['cause padding', 'cause background']);
    const effects = groups.filter((g) => g.kind === 'effect');
    assert.ok(effects.length >= 3 && effects.every((g) => g.cause === padding.id), JSON.stringify(effects.map((g) => [g.selector, g.property, g.cause])));
    assert.ok(effects.some((g) => g.selector !== 'a.cta' && g.property === 'size'), 'the row and the hero grew with it');
  });

  it('counts a longer label as 1, with its size and the link it wrapped under the text change', async () => {
    const { report, comment } = await run('label', 'narrow');
    assert.equal(comment.split('\n')[1], '### UI diff (local preview) — 1 measured change on 1 route');
    assert.match(comment, /: text 'Start free trial' → 'Start your free 14-day trial' — desktop\n {2}- size [^\n]* \(from the text change\)\n/);
    const text = report.measured!.find((g) => g.property === 'text')!;
    const wrapped = report.measured!.filter((g) => g.selector === 'a.more');
    assert.deepEqual(wrapped.map((g) => `${g.kind} ${g.property}`).sort(), ['effect position', 'effect size']);
    assert.ok(wrapped.every((g) => g.cause === text.id), 'chained to the text change');
  });

  it('counts a padding-only change as 1', async () => {
    const { comment } = await run('padding-only');
    assert.equal(comment.split('\n')[1], '### UI diff (local preview) — 1 measured change on 1 route');
  });
});
