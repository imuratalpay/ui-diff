import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { verifyChanges, type ElementChange } from '../../src/elements.js';
import { renderComment } from '../../src/markdown.js';
import { autoSummary, comparability, computeStats } from '../../src/report.js';
import { sampleReport, sideFingerprint } from './fixtures.js';

const change = (over: Partial<ElementChange>): ElementChange => ({
  kind: 'changed',
  name: "link 'Get started'",
  selector: 'a.cta',
  confidence: 'high',
  reason: 'same data-testid "cta"',
  changes: [{ property: 'padding', group: 'box', before: '8px 14px', after: '10px 18px' }],
  box: { x: 0, y: 0, width: 100, height: 40 },
  deviceBox: { x: 0, y: 0, width: 100, height: 40 },
  magnitude: 10,
  ...over,
});

describe('verification pass', () => {
  it('verifies confident matches whose box overlaps changed pixels, and says why the others are not', () => {
    const area = [{ x: 0, y: 0, width: 64, height: 32 }];
    const changes = [
      change({}),
      change({ confidence: 'low', reason: 'same tag at about the same place' }),
      change({ deviceBox: { x: 500, y: 500, width: 10, height: 10 } }),
      change({ kind: 'added', confidence: undefined, reason: undefined }),
    ];
    verifyChanges(changes, area, 'medium');
    assert.deepEqual(
      changes.map((c) => [c.verified, c.unverified]),
      [
        [true, undefined],
        [false, ['matched with low confidence only (same tag at about the same place)']],
        [false, ['no changed pixels in its area']],
        [true, undefined],
      ],
    );
    const none = [change({})];
    verifyChanges(none, [], 'medium');
    assert.deepEqual(none[0].unverified, ['no changed pixels in its area'], 'nothing is verified on a capture without changed pixels');
  });

  it('keeps unverified changes out of the main list but shows them on a small line', () => {
    const r = sampleReport();
    r.captures[0].styleDiff = { matched: { high: 1, medium: 0, low: 1 }, changes: [change({ verified: true }), change({ name: 'div.card', selector: 'div.card', verified: false, unverified: ['matched with low confidence only (same tag at about the same place)'] })], regions: [] };
    const body = renderComment(r, { id: 'default', title: 'UI diff', link: (p) => p });
    assert.match(body, /- `link 'Get started'` \(`a\.cta`\): padding 8px 14px → 10px 18px/);
    assert.doesNotMatch(body, /- `div\.card`/);
    assert.match(body, /<sub>Unverified \(not matched confidently, or no changed pixels in their area\): div\.card: padding 8px 14px → 10px 18px \(matched with low confidence only/);
  });

  it('flags runs captured differently and does not claim a clean result', () => {
    const r = sampleReport();
    r.captures = r.captures.map((c) => ({ ...c, status: 'unchanged' as const }));
    r.stats = computeStats(r.captures);
    r.captures[1].fingerprint = { base: sideFingerprint(), head: sideFingerprint({ fonts: { loaded: [], failed: ['Inter'], pending: [] } }), differences: ['fonts loaded: base Inter · head none', 'fonts failed: base none · head Inter'] };
    Object.assign(r, comparability(r.captures));
    assert.deepEqual(r.notComparable, [{ key: 'fonts loaded', captures: ['/ mobile/light'] }, { key: 'fonts failed', captures: ['/ mobile/light'] }]);
    const body = renderComment(r, { id: 'default', title: 'UI diff', link: (p) => p });
    assert.match(body, /> ⚠️ \*\*Base and head were captured differently\*\* \(fonts loaded on \/ mobile\/light; fonts failed on \/ mobile\/light\)/);
    assert.match(body, /\(captured differently, not a clean result\)/);
    assert.match(autoSummary(r), /but base and head were captured differently \(fonts loaded, fonts failed\), so this is not a clean result/);
    assert.doesNotMatch(autoSummary(r), /^No visual changes across/);
  });
});
