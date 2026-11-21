import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkSummary } from '../../src/check.js';
import { computeStats } from '../../src/report.js';
import { sampleReport } from './fixtures.js';

describe('ui-diff check summary', () => {
  it('exits 1 and lists changed captures and measured changes', () => {
    const r = sampleReport();
    r.captures[0].styleDiff = {
      matched: { high: 3, medium: 1, low: 0 },
      changes: [{ kind: 'changed', name: "link 'Get started'", selector: 'a.cta', changes: [{ property: 'padding', group: 'box', before: '8px 14px', after: '10px 18px' }], box: { x: 0, y: 0, width: 1, height: 1 }, magnitude: 10 }],
      regions: [],
    };
    const s = checkSummary(r, '/repo/.ui-diff/out');
    assert.equal(s.verdict, 'visual changes');
    assert.equal(s.exitCode, 1);
    assert.match(s.text, /^ui-diff check: 1 measured change on 1 route \(exit 1\)\nbase main @ 1a2b3c4 → head feature @ 5d6e7f8 · 1 route/);
    assert.match(s.text, /\nMeasured changes on \/\n {2}- link 'Get started' \(a\.cta\): padding 8px 14px → 10px 18px\n/);
    assert.match(s.text, /\nImages \(1 of 2 captures changed\)\n {2}\/ {2}desktop {2}4\.23% of pixels changed/);
    assert.ok(s.text.indexOf('Measured changes on') < s.text.indexOf('Images ('), 'measured changes before the images, as in the comment');
  });

  it('exits 0 when nothing changed, and when no UI file changed', () => {
    const clean = sampleReport();
    clean.captures = clean.captures.map((c) => ({ ...c, status: 'unchanged' as const }));
    clean.stats = computeStats(clean.captures);
    assert.deepEqual([checkSummary(clean, '/o').verdict, checkSummary(clean, '/o').exitCode], ['no visual changes', 0]);
    const none = sampleReport({ routes: [], captures: [], stats: computeStats([]), detect: { uiFiles: [], unmatched: [], skippedRoutes: [], needsExample: [], notes: [] } });
    const s = checkSummary(none, '/o');
    assert.deepEqual([s.verdict, s.exitCode], ['nothing checked', 0]);
    assert.match(s.text, /Nothing was checked: no changed file is a UI file/);
  });

  it('exits 2 when a capture failed', () => {
    const r = sampleReport();
    r.captures[1] = { ...r.captures[1], status: 'error', error: 'head returned HTTP 500' };
    r.stats = computeStats(r.captures);
    const s = checkSummary(r, '/o');
    assert.deepEqual([s.verdict, s.exitCode], ['capture errors', 2]);
    assert.match(s.text, /Failed \(1\)\n {2}\/ {2}mobile {2}head returned HTTP 500/);
  });
});
