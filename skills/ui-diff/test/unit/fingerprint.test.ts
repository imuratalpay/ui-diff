import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderComment } from '../../src/markdown.js';
import { autoSummary, fingerprintDifferences } from '../../src/report.js';
import { sampleReport, sideFingerprint } from './fixtures.js';

describe('capture fingerprint', () => {
  it('ignores the commit, which is supposed to differ', () => {
    assert.deepEqual(fingerprintDifferences(sideFingerprint(), sideFingerprint({ commit: '5d6e7f8a' })), []);
  });

  it('lists exactly what else differs', () => {
    const head = sideFingerprint({
      commit: '5d6e7f8a',
      viewport: { width: 1280, height: 800, deviceScaleFactor: 2, isMobile: false },
      fonts: { loaded: [], failed: ['Inter'], pending: [] },
      data: 'fixtures v2',
    });
    assert.deepEqual(fingerprintDifferences(sideFingerprint(), head), [
      'devicePixelRatio: base 1 · head 2',
      'fonts loaded: base Inter · head none',
      'fonts failed: base none · head Inter',
      'test data: base not declared · head fixtures v2',
    ]);
  });

  it('warns next to a changed capture whose environment differed, and in the automatic summary', () => {
    const r = sampleReport();
    r.captures[0].fingerprint = { base: sideFingerprint(), head: sideFingerprint({ commit: '5d6e7f8a', fonts: { loaded: [], failed: ['Inter'], pending: [] } }), differences: ['fonts loaded: base Inter · head none', 'fonts failed: base none · head Inter'] };
    const body = renderComment(r, { id: 'default', title: 'UI diff', link: (p) => p, summary: 'Custom.' });
    assert.match(body, /> ⚠️ \*\*The capture environment differed between base and head\*\*, so this diff may come from it rather than from the code: fonts loaded: base Inter · head none; fonts failed: base none · head Inter\./);
    assert.match(autoSummary(r), /Capture environment differed on `\/` desktop/);
  });

  it('stays quiet when the environments match', () => {
    const r = sampleReport();
    r.captures[0].fingerprint = { base: sideFingerprint(), head: sideFingerprint({ commit: '5d6e7f8a' }), differences: [] };
    assert.doesNotMatch(renderComment(r, { id: 'default', title: 'UI diff', link: (p) => p }), /capture environment differed/i);
    assert.doesNotMatch(autoSummary(r), /environment/);
  });
});
