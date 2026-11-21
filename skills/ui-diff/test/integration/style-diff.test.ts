import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../../src/config.js';
import { runPipeline } from '../../src/pipeline.js';
import type { Report } from '../../src/report.js';

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

const page = (o: { nav?: string[]; actions?: string; plans?: string[] } = {}) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shop</title><link rel="stylesheet" href="styles.css"></head><body>
<header><nav>${(o.nav ?? ['Pricing', 'Docs', 'Blog']).map((t) => `<a href="/${t.toLowerCase()}">${t}</a>`).join('')}</nav></header>
<main>
  <section class="hero"><h1>Ship faster</h1>
    <div class="hero-actions">${o.actions ?? '<a class="cta" href="/start">Get started</a><a class="secondary" href="/tour">See how it works</a>'}</div>
  </section>
  <ul class="plans">${(o.plans ?? ['Starter', 'Pro', 'Team']).map((t) => `<li>${t}</li>`).join('')}</ul>
  <footer>Made with care</footer>
</main></body></html>`;

const css = (cta = 'padding: 8px 14px;') => `body { margin: 0; font: 16px/24px Arial, sans-serif; color: #111827; }
header { padding: 12px 24px; background: #f3f4f6; }
nav a { margin-right: 16px; color: #111827; }
.hero { padding: 32px 24px; }
.hero-actions { display: flex; gap: 16px; align-items: center; }
.cta { display: inline-block; ${cta} border-radius: 6px; background: #2563eb; color: #fff; text-decoration: none; }
.secondary, .ghost { color: #2563eb; }
.plans { margin: 0 24px; padding: 0; list-style: none; }
.plans li { padding: 8px 0; border-bottom: 1px solid #e5e7eb; }
footer { padding: 24px; }`;

describe('measured style diff in reports and comments', { timeout: 300_000 }, () => {
  let dir: string;
  let repo: string;
  const sha: Record<string, string> = {};

  const variant = (name: string, files: { html?: string; css?: string }) => {
    git(repo, 'checkout', '-q', sha.base);
    if (files.html) writeFileSync(path.join(repo, 'index.html'), files.html);
    if (files.css) writeFileSync(path.join(repo, 'styles.css'), files.css);
    sha[name] = commit(repo, name);
  };

  const run = async (head: string): Promise<{ report: Report; comment: string }> => {
    const outDir = path.join(dir, `out-${head}`);
    const { report } = await runPipeline({ cfg: loadConfig(repo, repo), outDir, base: sha.base, head: sha[head], allRoutes: true });
    return { report, comment: readFileSync(path.join(outDir, 'comment.local.md'), 'utf8') };
  };

  /** "name: change · change" lines of the measured changes that count (effects left out). */
  const measured = (report: Report) =>
    report.captures
      .flatMap((c) => c.styleDiff?.changes ?? [])
      .map((c) => ({ ...c, changes: c.changes.filter((p) => p.kind !== 'effect') }))
      .filter((c) => c.kind !== 'changed' || c.changes.length)
      .map((c) => `${c.name}: ${c.kind === 'changed' ? c.changes.map((p) => (p.property === 'position' ? p.after : `${p.property} ${p.before} → ${p.after}`)).join(' · ') : c.kind}`);
  /** "name: change" of the effects, with their cause. */
  const effects = (report: Report) => report.captures.flatMap((c) => c.styleDiff?.changes ?? []).flatMap((c) => c.changes.filter((p) => p.kind === 'effect').map((p) => `${c.name}: ${p.property} ← ${p.cause}`));

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-style-diff-'));
    repo = path.join(dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(repo, 'serve.mjs'), SERVER);
    writeFileSync(path.join(repo, 'index.html'), page());
    writeFileSync(path.join(repo, 'styles.css'), css());
    writeFileSync(
      path.join(repo, 'ui-diff.config.json'),
      JSON.stringify({ startCommand: 'node serve.mjs --port {port}', routes: [{ path: '/', name: 'home' }], viewports: [{ name: 'desktop', width: 900, height: 600 }] }),
    );
    sha.base = commit(repo, 'base');
    variant('padding', { css: css('padding: 10px 18px;') });
    variant('text', { html: page({ nav: ['Plans', 'Docs', 'Blog'] }) });
    variant('added', { html: page({ actions: '<a class="cta" href="/start">Get started</a><a class="ghost" href="/demo">Book a demo</a><a class="secondary" href="/tour">See how it works</a>' }) });
    variant('reorder', { html: page({ plans: ['Team', 'Starter', 'Pro'] }) });
    git(repo, 'checkout', '-q', 'main');
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('names the element whose padding changed, with the exact before → after, and only it', async () => {
    const { report, comment } = await run('padding');
    assert.equal(report.version, 3);
    const lines = measured(report);
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.match(lines[0], /^link 'Get started': padding 8px 14px → 10px 18px$/);
    const cta = report.captures[0].styleDiff!.changes.find((c) => c.name === "link 'Get started'")!;
    assert.match(cta.changes.find((p) => p.property === 'size')!.before + ' → ' + cta.changes.find((p) => p.property === 'size')!.after, /^\d+(\.5)?×40px → \d+(\.5)?×44px$/, 'its size is still measured, as an effect');
    assert.ok(effects(report).length >= 3 && effects(report).every((e) => e.endsWith(`← ${cta.changes.find((p) => p.property === 'padding')!.id}`)), JSON.stringify(effects(report)));
    assert.deepEqual(report.measured!.filter((g) => g.selector === 'a.cta').map((g) => [g.route, g.kind, g.property, g.variants.map((v) => v.capture)]), [['/', 'cause', 'padding', [report.captures[0].id]], ['/', 'effect', 'size', [report.captures[0].id]]], 'report.json has the same groups, with their kinds and captures');
    assert.equal(comment.split('\n')[1], '### UI diff (local preview) — 1 measured change on 1 route', 'the verdict is the first line: the padding, its size change follows from it');
    assert.ok(comment.indexOf('#### Measured changes') < comment.indexOf('#### Images'), 'measured changes before the images');
    assert.match(comment, /#### Measured changes\n\n\*\*`\/`\*\*\n\n- `link 'Get started'` \(`a\.cta`\): padding 8px 14px → 10px 18px — \w+\n {2}- size [^\n]* \(from the padding change\)\n/);
    assert.match(comment, /<sub>link 'Get started': padding 8px 14px → 10px 18px<\/sub>/, 'the zoomed crop says what was changed, not what followed');
    const { regions, changes } = report.captures[0].styleDiff!;
    const explained = regions.find((r) => r.changes.some((i) => changes[i].name === "link 'Get started'"));
    assert.ok(explained, `a changed area is explained by the button: ${JSON.stringify(regions)}`);
    assert.ok(["link 'Get started'", 'div.hero-actions', 'section.hero'].includes(explained.element!.name), `named after the button or what contains it, got ${explained.element?.name}`);
  });

  it('reports a text change as text, not as a restyle of its neighbours', async () => {
    const { report, comment } = await run('text');
    const lines = measured(report);
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.match(lines[0], /^link 'Plans': size .* · text 'Pricing' → 'Plans'$/);
    assert.match(comment, /text 'Pricing' → 'Plans'/);
  });

  it('reports an added element as added, and does not list the link it pushed aside', async () => {
    const { report } = await run('added');
    assert.deepEqual(measured(report), ["link 'Book a demo': added"]);
    assert.ok(effects(report).some((e) => /^link 'See how it works': position ← h\d+:added$/.test(e)), `the pushed link is an effect of the added one: ${JSON.stringify(effects(report))}`);
  });

  it('reports reordered items as one order change, not every item as changed', async () => {
    const { report, comment } = await run('reorder');
    assert.equal(report.captures[0].status, 'changed');
    assert.deepEqual(measured(report), ['ul.plans: order Starter, Pro, Team → Team, Starter, Pro']);
    assert.ok(effects(report).filter((e) => e.startsWith('li ')).length === 3 && effects(report).every((e) => /← h\d+:order$/.test(e) || !e.startsWith('li ')), JSON.stringify(effects(report)));
    assert.match(comment, /- `ul\.plans`: order Starter, Pro, Team → Team, Starter, Pro/);
  });

  it('stays empty and quiet when nothing changed', async () => {
    sha.same = sha.base;
    const { report, comment } = await run('same');
    assert.equal(report.captures[0].status, 'unchanged');
    assert.deepEqual(report.captures[0].styleDiff?.changes, []);
    assert.ok(report.captures[0].styleDiff!.matched.high + report.captures[0].styleDiff!.matched.medium > 10);
    assert.doesNotMatch(comment, /Measured changes/);
  });
});
