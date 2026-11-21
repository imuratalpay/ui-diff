import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkSummary } from '../../src/check.js';
import type { ElementChange } from '../../src/elements.js';
import { renderComment } from '../../src/markdown.js';
import { computeStats, type CaptureResult, type Report } from '../../src/report.js';
import { verdict } from '../../src/verdict.js';
import { sampleReport } from './fixtures.js';

function change(name: string, property: string, before: string, after: string, extra: Partial<ElementChange> = {}): ElementChange {
  return { kind: 'changed', name, selector: name, changes: [{ property, group: 'box', before, after }], box: { x: 0, y: 0, width: 10, height: 10 }, magnitude: 5, ...extra };
}

function onRoute(base: CaptureResult, path: string, changes: ElementChange[], regions: NonNullable<CaptureResult['styleDiff']>['regions'] = []): CaptureResult {
  return { ...base, id: `${path}-desktop`, route: { path, name: path, slug: path.replace(/\W/g, '') || 'home' }, styleDiff: { matched: { high: 4, medium: 0, low: 0 }, changes, regions } };
}

/** "/" with two measured changes, "/pricing" with one and an area nothing measured explains, one unchanged. */
function twoRoutes(): Report {
  const r = sampleReport();
  const [changed, unchanged] = r.captures;
  r.captures = [
    onRoute(changed, '/', [change('Sign up', 'padding', '8px 14px', '10px 18px'), change('Hero title', 'font-size', '32px', '36px')]),
    onRoute(changed, '/pricing', [change('Pro price', 'text', "'$9'", "'$12'")], [{ region: { x: 0, y: 400, width: 120, height: 40 }, changes: [], note: 'no measured style, text or size change' }]),
    unchanged,
  ];
  r.routes = [r.routes[0], { ...r.routes[0], path: '/pricing', name: '/pricing' }];
  r.stats = computeStats(r.captures);
  r.timings = { totalMs: 22_000, detectMs: 100 } as Report['timings'];
  return r;
}

describe('verdict first', () => {
  it('says what the run found in plain words', () => {
    assert.equal(verdict(twoRoutes()).text, '3 measured changes on 2 routes');
    const clean = sampleReport();
    clean.captures = clean.captures.map((c) => ({ ...c, status: 'unchanged' as const }));
    clean.stats = computeStats(clean.captures);
    assert.equal(verdict(clean).text, 'No visual changes');
    const differently = { ...twoRoutes(), notComparable: [{ key: 'fonts loaded', captures: ['/ desktop/light'] }] };
    assert.equal(verdict(differently).text, 'Changes found, but captures were not comparable');
    const pixels = twoRoutes();
    pixels.captures[0].styleDiff!.changes = [];
    pixels.captures[1].styleDiff!.changes = [];
    assert.equal(verdict(pixels).text, 'Visual changes on 2 routes, none measured');
    const failed = twoRoutes();
    failed.captures.push({ ...failed.captures[2], id: 'x', status: 'error', error: 'timeout' });
    failed.stats = computeStats(failed.captures);
    assert.equal(verdict(failed).text, '3 measured changes on 2 routes, 1 capture failed');
    const unverified = twoRoutes();
    unverified.captures[1].styleDiff!.changes[0] = { ...unverified.captures[1].styleDiff!.changes[0], verified: false, unverified: ['no changed pixels in its area'] };
    assert.equal(verdict(unverified).text, '2 measured changes on 1 route, pixel changes on 1 more route', 'unverified changes are not counted');
  });

  it('orders the comment: verdict, measured changes by route, image pairs, pixel-only areas, then settings and timing', () => {
    const r = twoRoutes();
    r.captures[0].images = { ...r.captures[0].images, pairs: ['compare/home__pair-1.png'], blinks: ['compare/home__blink-1.gif'] };
    const body = renderComment(r, { id: 'default', title: 'UI diff', link: (p) => p });
    const lines = body.split('\n');
    assert.equal(lines[1], '### UI diff — 3 measured changes on 2 routes');
    assert.match(body, /#### Measured changes\n\n\*\*`\/`\*\*\n\n- `Sign up`: padding 8px 14px → 10px 18px\n- `Hero title`: font-size 32px → 36px\n\n\*\*`\/pricing`\*\*\n\n- `Pro price`: text '\$9' → '\$12'\n/);
    assert.match(body, /#### Pixel changes with no measured change\n\n- `\/pricing · desktop` 120×40px at 0,400 — no measured style, text or size change\n/);
    const order = ['#### Measured changes', '#### Images', 'compare/home__pair-1.png', '<details><summary>Blink and diff</summary>', '#### Pixel changes with no measured change', '<summary>Timing · ⏱ 22s</summary>', '[report.json](report.json)'].map((x) => body.indexOf(x));
    assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), `in reading order: ${order.join(', ')}`);
  });

  it('leaves out the lowest-priority sections to fit the size limit and points to report.json', () => {
    const r = twoRoutes();
    r.warnings = Array.from({ length: 40 }, (_, i) => `warning number ${i} with a fairly long explanation of what went wrong in the run`);
    const shortest = renderComment(r, { id: 'default', title: 'UI diff', link: (p) => p, compact: 3 });
    assert.match(shortest, /<sub>Shortened to fit GitHub’s comment size limit\. Everything is in \[report\.json\]\(report\.json\)\.<\/sub>/);
    const max = shortest.length - 300;
    const body = renderComment(r, { id: 'default', title: 'UI diff', link: (p) => p, maxLength: max });
    assert.ok(body.length <= max, `${body.length} <= ${max}`);
    assert.match(body, /<sub>Left out to fit GitHub’s comment size limit: [^<]*\. Everything is in \[report\.json\]\(report\.json\)\.<\/sub>/);
    assert.match(body, /### UI diff — 3 measured changes on 2 routes/);
    assert.match(body, /#### Measured changes/, 'the measured changes stay');
    assert.match(body, /<!-- ui-diff:meta /);
    const left = /size limit: ([^.]*)\./.exec(body)![1].split(', ');
    assert.equal(left[0], 'capture settings and timing', 'the lowest priority goes first');
    assert.ok(!left.includes('measured changes'));
  });

  it('prints the check summary in the same order', () => {
    const r = twoRoutes();
    r.captures[0].images = { ...r.captures[0].images, pairs: ['compare/home__pair-1.png'] };
    const s = checkSummary(r, '/repo/.ui-diff');
    const text = s.text;
    assert.match(text, /^ui-diff check: 3 measured changes on 2 routes \(exit 1\)\n/);
    const order = ['Measured changes on /\n', 'Measured changes on /pricing\n', 'Images (2 of 3 captures changed)', '/repo/.ui-diff/compare/home__pair-1.png', 'Pixel changes with no measured change', '⏱ 22s total', 'Report: '].map((x) => text.indexOf(x));
    assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), `in reading order: ${order.join(', ')}\n${text}`);
  });
});
