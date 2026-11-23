import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const CTA = '<a class="cta" href="#">Get started</a>';
const html = (cta = CTA) => `<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body>
<header><a class="logo" href="#">Acme</a><button id="burger" type="button">Menu</button>
<nav id="menu" aria-label="Main menu" hidden><a href="#">Pricing</a><a href="#">Docs</a></nav></header>
<main><h1>Plans</h1>
<section class="card" aria-label="Pro plan"><h2>Pro</h2><p class="price">$12 a month</p>${cta}</section>
<p class="note">Cancel anytime.</p></main>
<script>document.getElementById('burger').addEventListener('click', () => { const m = document.getElementById('menu'); m.hidden = !m.hidden; });</script>
</body></html>`;

const BASE_CSS = {
  page: 'body{margin:0;font:16px Arial,sans-serif;color:#0f172a} header{position:relative;display:flex;gap:16px;align-items:center;padding:16px 24px;border-bottom:1px solid #e5e7eb} main{padding:24px}',
  menu: '#menu{position:absolute;top:56px;right:24px;display:flex;flex-direction:column;gap:4px;padding:8px;background:#fff;border:1px solid #e5e7eb;border-radius:8px} #menu[hidden]{display:none} #menu a{color:#2563eb;padding:4px 8px}',
  card: '.card{display:inline-flex;flex-direction:column;align-items:flex-start;gap:8px;padding:16px;border:1px solid #e5e7eb;border-radius:12px} .card h2{margin:0;font-size:20px} .price{margin:0;color:#475569}',
  cta: '.cta{display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:8px;border-radius:6px} .cta:hover{background:#1d4ed8}',
  note: '.note{color:#64748b}',
};
const css = (over: Partial<typeof BASE_CSS> = {}) => Object.values({ ...BASE_CSS, ...over }).join('\n');

const FLOWS = [{ name: 'menu', route: '/', steps: [{ click: '#burger', checkpoint: 'after open' }] }];
const COMPONENTS = [
  { name: 'primary button', route: '/', selector: '.cta' },
  { name: 'pricing card', route: '/', selector: '.card' },
  { name: 'menu panel', flow: 'menu', checkpoint: 'after open', selector: '#menu' },
];

describe('component mode in a real run', { timeout: 900_000 }, () => {
  let dir: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const branch = (name: string, files: { css?: string; html?: string }) => {
    git('checkout', '-q', '-B', name, 'main');
    if (files.css !== undefined) writeFileSync(path.join(dir, 'app.css'), files.css);
    if (files.html !== undefined) writeFileSync(path.join(dir, 'index.html'), files.html);
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qam', name);
  };

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-components-'));
    git('init', '-q', '-b', 'main');
    writeFileSync(path.join(dir, 'serve.mjs'), SERVER);
    writeFileSync(path.join(dir, 'index.html'), html());
    writeFileSync(path.join(dir, 'app.css'), css());
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'base');
    branch('cta-padding', { css: css({ cta: BASE_CSS.cta.replace('padding:8px;', 'padding:10px;') }) });
    branch('note-color', { css: css({ note: '.note{color:#b91c1c}' }) });
    branch('cta-removed', { html: html('') });
    branch('css-comment', { css: `/* plans */\n${css()}` });
    branch('menu-padding', { css: css({ menu: BASE_CSS.menu.replace('padding:8px;', 'padding:12px;') }) });
    branch('cta-hover', { css: css({ cta: BASE_CSS.cta.replace('.cta:hover{background:#1d4ed8}', '.cta:hover{background:#1e3a8a}') }) });
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  const run = async (head: string, components: unknown[] = COMPONENTS, label = head) => {
    const cfg = parseConfig(
      {
        startCommand: 'node serve.mjs --port {port}',
        routes: [{ path: '/', name: 'home', files: ['index.html', 'app.css'] }],
        viewports: [{ name: 'desktop', width: 800, height: 600 }],
        flows: FLOWS,
        components,
        flowLimits: { stepTimeoutMs: 1500 },
      },
      { repoRoot: dir },
    );
    const outDir = path.join(dir, '.ui-diff', label);
    await runPipeline({ cfg, outDir, base: 'main', head, cache: false });
    return { outDir, report: JSON.parse(readFileSync(path.join(outDir, 'report.json'), 'utf8')) as Report, comment: readFileSync(path.join(outDir, 'comment.local.md'), 'utf8') };
  };
  /** Counted rows of each component group, "<component>: <element> <change>". */
  const componentRows = (report: Report) => (report.measured ?? []).filter((g) => g.component && g.kind !== 'effect').map((g) => `${g.component!.name}${g.component!.state === 'default' ? '' : ` · ${g.component!.state}`}: ${g.name} ${g.text}`);
  const status = (report: Report, id: string) => report.captures.find((c) => c.id === id)?.status;

  it('(a) shows a button padding change as exactly one measured change in its component row, with a tight crop', async () => {
    const { outDir, report, comment } = await run('cta-padding');
    assert.deepEqual(componentRows(report).filter((r) => r.startsWith('primary button:')), ["primary button: link 'Get started' padding 8px → 10px"]);
    const button = report.captures.find((c) => c.id === 'home__desktop__light__component-primary-button')!;
    assert.equal(button.status, 'changed');
    assert.equal(button.component!.rootChange, 'size 95×34 → 99×38px');
    const crop = button.component!.crop;
    assert.deepEqual([crop.base.width, crop.base.height], [crop.head.width, crop.head.height], 'the same box on both sides');
    const { before, after } = button.component!.root;
    assert.deepEqual([crop.head.width, crop.head.height], [Math.ceil(Math.max(before.width, after.width) + 16), Math.ceil(Math.max(before.height, after.height) + 16)], 'the larger box plus 8px on each side');
    assert.deepEqual([crop.head.x, crop.head.y], [Math.floor(after.x - 8), Math.floor(after.y - 8)]);
    assert.equal(comment.split('\n')[1], '### UI diff (local preview) — 1 measured change on 1 route', 'the component row repeats the route row, counted once');
    assert.match(comment, /\*\*component 'primary button'\*\* · `\/` · size 95×34 → 99×38px\n\n- `link 'Get started'` \(`a\.cta`\): padding 8px → 10px — desktop\n/);
    for (const file of ['home__desktop__light__component-primary-button.png', 'home__desktop__light__component-primary-button__pair-1.png', 'home__desktop__light__component-primary-button__blink-1.gif']) assert.ok(existsSync(path.join(outDir, 'compare', file)), file);
    assert.ok(componentRows(report).includes("pricing card: link 'Get started' padding 8px → 10px"), 'the card contains the button');
    assert.ok(report.timings!.extras!.componentsMs! > 0);
    assert.match(comment, /components \d+(\.\d)?s/);
  });

  it('(b) leaves a change outside the component out of its row', async () => {
    const { report, comment } = await run('note-color');
    assert.equal(status(report, 'home__desktop__light'), 'changed');
    assert.deepEqual((report.measured ?? []).map((g) => [g.component?.name, g.name, g.text]), [[undefined, "p 'Cancel anytime.'", 'color #64748b → #b91c1c']]);
    assert.equal(status(report, 'home__desktop__light__component-primary-button'), 'unchanged');
    assert.equal(status(report, 'home__desktop__light__component-pricing-card'), 'unchanged');
    assert.doesNotMatch(comment, /\*\*component '/);
  });

  it('(c) reports a component removed on head as removed, not as a failed capture', async () => {
    const { report, comment } = await run('cta-removed');
    const button = report.components!.find((c) => c.name === 'primary button')!;
    assert.deepEqual([button.change, button.finding, button.matches, button.capture], ['removed', "component 'primary button' removed on head: nothing matches .cta", { base: 1, head: 0 }, undefined]);
    assert.equal(report.stats.errors, 0);
    assert.match(comment.split('\n')[1], /1 component removed$/);
    assert.match(comment, /#### Components\n\n- component 'primary button' removed on head: nothing matches \.cta — desktop\n\n<img src="compare\/home__desktop__light__component-primary-button\.png"/);
    assert.ok(componentRows(report).includes("pricing card: link 'Get started' removed"), 'the card shows what left it');
  });

  it('(d) reports nothing when nothing changed', async () => {
    const { report, comment } = await run('css-comment');
    assert.equal(comment.split('\n')[1], '### UI diff (local preview) — No visual changes');
    assert.deepEqual(
      report.captures.filter((c) => c.component).map((c) => [c.id, c.status]),
      [
        ['home__desktop__light__component-primary-button', 'unchanged'],
        ['home__desktop__light__component-pricing-card', 'unchanged'],
        ['home__desktop__light__component-menu-panel', 'unchanged'],
      ],
    );
    assert.ok(report.components!.every((c) => !c.finding && !c.problem && c.matches.base === 1 && c.matches.head === 1));
    assert.equal(report.measured, undefined);
    assert.deepEqual(report.warnings, []);
    assert.doesNotMatch(comment, /#### Measured changes|#### Components|#### Warnings/);
  });

  it('(e) diffs a component a flow checkpoint shows', async () => {
    const { report, comment } = await run('menu-padding');
    assert.deepEqual(componentRows(report), ["menu panel: nav 'Main menu' padding 8px → 12px"]);
    assert.equal(status(report, 'home__desktop__light__component-primary-button'), 'unchanged');
    assert.match(comment, /\*\*component 'menu panel'\*\* · `\/` · flow 'menu' · after open · size 83×74 → 91×82px, moved 8px left\n\n- `nav 'Main menu'` \(`#menu`\): padding 8px → 12px — desktop\n/);
  });

  it('diffs a component in its hover state, and warns when its selector matches several elements on both sides', async () => {
    const { report, comment } = await run('cta-hover', [{ name: 'cta', route: '/', selector: '.cta', states: ['default', 'hover'] }, { name: 'links', route: '/', selector: '#menu a' }], 'hover');
    assert.equal(status(report, 'home__desktop__light__component-cta'), 'unchanged');
    assert.deepEqual(componentRows(report), ["cta · hover: link 'Get started' background #1d4ed8 → #1e3a8a"]);
    assert.match(comment, /\*\*component 'cta' · hover\*\* · `\/`\n\n- `link 'Get started'` \(`a\.cta`\): background #1d4ed8 → #1e3a8a — desktop\n/);
    assert.deepEqual(report.warnings, ["component 'links': #menu a matches 2 elements on base and head; check the component in the config (desktop)"]);
    assert.equal(report.stats.errors, 0);
  });
});
