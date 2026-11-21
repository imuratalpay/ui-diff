import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkSummary } from '../../src/check.js';
import type { ElementChange, PropertyChange } from '../../src/elements.js';
import { renderComment } from '../../src/markdown.js';
import { computeStats, type CaptureResult, type Report } from '../../src/report.js';
import { measuredGroups, measurements, variantsLabel, verdict } from '../../src/verdict.js';
import { sampleReport } from './fixtures.js';

const prop = (property: string, before: string, after: string): PropertyChange => ({ property, group: 'box', before, after });
const button = (changes: PropertyChange[]): ElementChange => ({ kind: 'changed', name: "link 'Start free trial'", selector: 'a.cta', changes, box: { x: 0, y: 0, width: 10, height: 10 }, magnitude: 8 });

/** One route on desktop/mobile × light/dark; the button's padding is the same everywhere, its background differs in dark, its size by viewport. */
function grid(): Report {
  const r = sampleReport();
  const base = r.captures[0];
  r.viewports = ['desktop', 'mobile'];
  r.themes = ['light', 'dark'];
  r.captures = (['desktop', 'mobile'] as const).flatMap((viewport) =>
    (['light', 'dark'] as const).map((theme): CaptureResult => ({
      ...base,
      id: `home__${viewport}__${theme}`,
      viewport,
      theme,
      styleDiff: {
        matched: { high: 5, medium: 0, low: 0 },
        changes: [button([prop('size', viewport === 'desktop' ? '134.5×40px' : '120×40px', viewport === 'desktop' ? '142.5×44px' : '128×44px'), prop('padding', '8px 14px', '10px 18px'), prop('background-color', theme === 'dark' ? '#1e40af' : '#2563eb', '#0b7a5b')])],
        regions: [],
      },
    })),
  );
  r.stats = computeStats(r.captures);
  return r;
}

describe('measured changes grouped by element, property and value', () => {
  it('writes an identical change once with its variants, and a value that differs by variant once per value', () => {
    const [route] = measurements(grid());
    assert.deepEqual(
      route.rows.map((row) => `${row.text} — ${row.where}`),
      [
        'size 134.5×40px → 142.5×44px — desktop · light, dark',
        'size 120×40px → 128×44px — mobile · light, dark',
        'padding 8px 14px → 10px 18px — desktop, mobile · light, dark',
        'background-color #2563eb → #0b7a5b — desktop, mobile · light',
        'background-color #1e40af → #0b7a5b — desktop, mobile · dark',
      ],
    );
    assert.equal(verdict(grid()).text, '5 measured changes on 1 route', 'the verdict counts the rows');
  });

  it('lists the same rows in the comment and in check', () => {
    const r = grid();
    const body = renderComment(r, { id: 'default', title: 'UI diff', link: (p) => p });
    assert.equal(body.split('\n')[1], '### UI diff — 5 measured changes on 1 route');
    assert.match(body, /- `link 'Start free trial'` \(`a\.cta`\): padding 8px 14px → 10px 18px — desktop, mobile · light, dark\n/);
    assert.equal(body.match(/^- `link 'Start free trial'`/gm)?.length, 5, 'one line per row, not per capture');
    const text = checkSummary(r, '/o').text;
    assert.match(text, /^ui-diff check: 5 measured changes on 1 route/);
    assert.match(text, /\n {2}- link 'Start free trial' \(a\.cta\): background-color #1e40af → #0b7a5b — desktop, mobile · dark\n/);
    assert.equal(text.match(/^ {2}- link 'Start free trial'/gm)?.length, 5);
  });

  it('keeps the per-variant detail of each group for report.json', () => {
    const groups = measuredGroups(grid());
    const padding = groups.find((g) => g.property === 'padding')!;
    assert.deepEqual([padding.route, padding.before, padding.after], ['/', '8px 14px', '10px 18px']);
    assert.deepEqual(padding.variants.map((v) => v.capture), ['home__desktop__light', 'home__desktop__dark', 'home__mobile__light', 'home__mobile__dark']);
    assert.equal(groups.length, 5);
  });

  it('names the combinations when they are not a full grid', () => {
    const report = { viewports: ['desktop', 'mobile'], themes: ['light', 'dark'] };
    assert.equal(variantsLabel([{ viewport: 'desktop', theme: 'dark' }, { viewport: 'mobile', theme: 'light' }], report), 'desktop/dark, mobile/light');
    assert.equal(variantsLabel([{ viewport: 'mobile', theme: 'light' }], { viewports: ['desktop', 'mobile'], themes: ['light'] }), 'mobile');
  });
});
