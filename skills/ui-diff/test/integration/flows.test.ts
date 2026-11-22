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
const PAY = '<button class="pay" type="button">Pay</button>';
const html = (pay = PAY) => `<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body>
<header><a class="logo" href="#">Acme</a><button id="burger" type="button">Menu</button>
<nav id="menu" aria-label="Main menu" hidden><a href="#">Pricing</a><a href="#">Docs</a></nav></header>
<main><h1>Checkout</h1><form><label for="email">Email</label> <input id="email"> ${pay}</form></main>
<script>
document.getElementById('burger').addEventListener('click', () => { const m = document.getElementById('menu'); m.hidden = !m.hidden; });
document.querySelector('.pay')?.addEventListener('click', () => document.querySelector('main').insertAdjacentHTML('beforeend', '<p class="thanks">Thanks, ' + document.getElementById('email').value + '</p>'));
</script></body></html>`;

const BASE_CSS = {
  page: 'body{margin:0;font:16px Arial,sans-serif;color:#0f172a} header{position:relative;display:flex;gap:16px;align-items:center;padding:16px 24px;border-bottom:1px solid #e5e7eb} main{padding:24px}',
  menu: '#menu{position:absolute;top:56px;right:24px;display:flex;flex-direction:column;gap:4px;padding:8px;background:#fff;border:1px solid #e5e7eb;border-radius:8px} #menu[hidden]{display:none} #menu a{color:#2563eb;padding:4px 8px}',
  form: 'input{border:1px solid #cbd5e1;padding:6px 8px} .pay{background:#2563eb;color:#fff;border:0;padding:8px 14px;border-radius:6px} .thanks{color:#15803d}',
};
const css = (over: Partial<typeof BASE_CSS> = {}) => Object.values({ ...BASE_CSS, ...over }).join('\n');

const FLOWS = [
  { name: 'menu', route: '/', steps: [{ click: '#burger', checkpoint: 'after open' }] },
  { name: 'checkout', route: '/', steps: [{ type: '#email', text: 'ada@example.com' }, { click: 'button.pay' }, { wait: '.thanks', checkpoint: 'paid' }] },
];

describe('recorded flows in a real run', { timeout: 900_000 }, () => {
  let dir: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const branch = (name: string, files: { css?: string; html?: string }, from = 'main') => {
    git('checkout', '-q', '-B', name, from);
    if (files.css !== undefined) writeFileSync(path.join(dir, 'app.css'), files.css);
    if (files.html !== undefined) writeFileSync(path.join(dir, 'index.html'), files.html);
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qam', name);
  };

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-flows-'));
    git('init', '-q', '-b', 'main');
    writeFileSync(path.join(dir, 'serve.mjs'), SERVER);
    writeFileSync(path.join(dir, 'index.html'), html());
    writeFileSync(path.join(dir, 'app.css'), css());
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'base');
    branch('menu-padding', { css: css({ menu: BASE_CSS.menu.replace('padding:8px;', 'padding:12px;') }) });
    branch('pay-removed', { html: html('') });
    branch('css-comment', { css: `/* checkout styles */\n${css()}` });
    branch('pay-back', { html: html() }, 'pay-removed');
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  const runs = new Map<string, Promise<{ outDir: string; report: Report; comment: string }>>();
  const run = (head: string, opts: { flows?: unknown[]; cache?: boolean; label?: string; base?: string } = {}) => {
    const label = opts.label ?? head;
    if (!runs.has(label)) {
      runs.set(
        label,
        (async () => {
          const cfg = parseConfig(
            {
              startCommand: 'node serve.mjs --port {port}',
              routes: [{ path: '/', name: 'home', files: ['index.html', 'app.css'] }],
              viewports: [
                { name: 'desktop', width: 800, height: 600 },
                { name: 'mobile', width: 390, height: 700 },
              ],
              flows: opts.flows ?? FLOWS,
              flowLimits: { stepTimeoutMs: 1500 },
            },
            { repoRoot: dir },
          );
          const outDir = path.join(dir, '.ui-diff', label);
          await runPipeline({ cfg, outDir, base: opts.base ?? 'main', head, cache: opts.cache ?? false, cacheDir: path.join(dir, '.ui-diff', 'cache') });
          return { outDir, report: JSON.parse(readFileSync(path.join(outDir, 'report.json'), 'utf8')) as Report, comment: readFileSync(path.join(outDir, 'comment.local.md'), 'utf8') };
        })(),
      );
    }
    return runs.get(label)!;
  };
  const causes = (report: Report) => (report.measured ?? []).filter((g) => g.kind !== 'effect').map((g) => `${g.flow ? `flow '${g.flow.name}' · ${g.flow.checkpoint}: ` : ''}${g.name} ${g.text} — ${g.where}`);

  it('(a) finds a padding change that only shows with the menu open, as one verified cause under the flow checkpoint', async () => {
    const { outDir, report, comment } = await run('menu-padding');
    const still = report.captures.filter((c) => !c.flow);
    assert.deepEqual(
      still.map((c) => [c.id, c.status]),
      [
        ['home__desktop__light', 'unchanged'],
        ['home__mobile__light', 'unchanged'],
      ],
      'the closed menu did not change',
    );
    assert.deepEqual(causes(report), ["flow 'menu' · after open: nav 'Main menu' padding 8px → 12px — desktop, mobile"]);
    const open = report.captures.find((c) => c.id === 'home__desktop__light__flow-menu-after-open')!;
    assert.equal(open.status, 'changed');
    assert.deepEqual(open.flow, { name: 'menu', checkpoint: 'after open' });
    const menu = open.styleDiff!.changes.find((x) => x.selector === '#menu')!;
    assert.equal(menu.verified, true);
    assert.equal(report.captures.find((c) => c.id === 'home__desktop__light__flow-checkout-paid')?.status, 'unchanged');
    assert.equal(comment.split('\n')[1], '### UI diff (local preview) — 1 measured change on 1 route');
    assert.match(comment, /\*\*`\/`\*\* · flow 'menu' · after open\n\n- `nav 'Main menu'` \(`#menu`\): padding 8px → 12px — desktop, mobile\n/);
    assert.match(comment, /\*\*`\/`\*\* · desktop · flow 'menu' · after open — /);
    for (const file of ['home__desktop__light__flow-menu-after-open.png', 'home__desktop__light__flow-menu-after-open__pair-1.png']) assert.ok(existsSync(path.join(outDir, 'compare', file)), file);
    assert.deepEqual(
      report.flows!.map((f) => [f.name, f.viewport, f.finding, f.problem]),
      [
        ['menu', 'desktop', undefined, undefined],
        ['menu', 'mobile', undefined, undefined],
        ['checkout', 'desktop', undefined, undefined],
        ['checkout', 'mobile', undefined, undefined],
      ],
    );
    assert.ok(report.timings!.extras!.flowsMs! > 0);
    assert.ok(report.flows!.every((f) => f.base.ms > 0 && f.head.ms > 0));
    const fp = open.fingerprint!;
    assert.deepEqual(fp.differences, [], 'both sides of a checkpoint are captured with the same frozen inputs');
    assert.equal(fp.base!.viewport.width, 800);
  });

  it('(b) reports the step where a flow stops on head when its button is gone', async () => {
    const { report, comment } = await run('pay-removed');
    const finding = "flow 'checkout' stops at step 2 on head: button 'Pay' not found";
    assert.deepEqual(
      report.flows!.filter((f) => f.name === 'checkout').map((f) => [f.viewport, f.finding, f.head.stoppedAt?.kind, f.base.stoppedAt]),
      [
        ['desktop', finding, 'missing', undefined],
        ['mobile', finding, 'missing', undefined],
      ],
    );
    assert.equal(report.captures.find((c) => c.flow?.name === 'checkout'), undefined, 'head never reached the checkpoint, so it is not compared');
    assert.deepEqual(report.flows!.find((f) => f.name === 'checkout')!.checkpoints, [{ name: 'paid', step: 3 }]);
    assert.match(comment, /\n#### Flows\n\n- flow 'checkout' stops at step 2 on head: button 'Pay' not found — desktop, mobile\n/);
    assert.match(comment.split('\n')[1], /1 broken flow$/);
    assert.equal(report.stats.errors, 0, 'a broken flow is not a failed capture');
  });

  it('(c) reports nothing for flows whose pages did not change', async () => {
    const { report, comment } = await run('css-comment');
    assert.equal(comment.split('\n')[1], '### UI diff (local preview) — No visual changes');
    assert.deepEqual(
      report.captures.map((c) => [c.id, c.status]),
      [
        ['home__desktop__light', 'unchanged'],
        ['home__mobile__light', 'unchanged'],
        ['home__desktop__light__flow-menu-after-open', 'unchanged'],
        ['home__mobile__light__flow-menu-after-open', 'unchanged'],
        ['home__desktop__light__flow-checkout-paid', 'unchanged'],
        ['home__mobile__light__flow-checkout-paid', 'unchanged'],
      ],
    );
    assert.equal(report.measured, undefined);
    assert.ok(report.flows!.every((f) => !f.finding && !f.problem));
    assert.deepEqual(report.warnings, []);
    assert.doesNotMatch(comment, /#### Measured changes|#### Flows|#### Warnings/);
  });

  it('warns about a flow that stops at the same step on both sides, without failing the run', async () => {
    const { report, comment } = await run('css-comment', { label: 'typo', flows: [{ name: 'typo', route: '/', steps: [{ click: '#burger' }, { click: '#menu a.missing', checkpoint: 'opened' }] }] });
    assert.deepEqual(report.warnings, ["flow 'typo' stops at step 2 on base and head: nothing matches #menu a.missing; check the flow in the config (desktop, mobile)"]);
    assert.equal(comment.split('\n')[1], '### UI diff (local preview) — No visual changes');
    assert.equal(report.stats.errors, 0);
  });

  it('reuses base flow checkpoints from the base cache, including one base never reached', async () => {
    const opts = { base: 'pay-removed', cache: true, flows: [FLOWS[1]] };
    const first = await run('pay-back', { ...opts, label: 'cache-1' });
    const second = await run('pay-back', { ...opts, label: 'cache-2' });
    assert.equal(first.report.baseCache?.hit, false);
    assert.equal(first.report.baseCache?.stored, true, 'a checkpoint base never reached does not keep the set out of the cache');
    assert.equal(second.report.baseCache?.hit, true);
    const finding = "flow 'checkout' stops at step 2 on base: button 'Pay' not found";
    for (const { report } of [first, second]) assert.deepEqual(report.flows!.map((f) => f.finding), [finding, finding]);
    assert.ok(second.report.flows!.every((f) => f.base.cached));
    assert.ok(!first.report.flows!.some((f) => f.base.cached));
  });
});
