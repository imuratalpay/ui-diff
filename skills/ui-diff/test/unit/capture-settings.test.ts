import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { captureSettingsSection, renderComment } from '../../src/markdown.js';
import { sampleReport, sideFingerprint } from './fixtures.js';

const link = (p: string) => p;

function withFingerprints() {
  const r = sampleReport();
  const mobile = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true };
  r.captures[0].fingerprint = { base: sideFingerprint(), head: sideFingerprint({ commit: '5d6e7f8a', fonts: { loaded: ['Inter', 'Late'], failed: ['Gone'], pending: [] } }), differences: ['x'] };
  r.captures[1].fingerprint = { base: sideFingerprint({ viewport: mobile }), head: sideFingerprint({ commit: '5d6e7f8a', viewport: mobile }), differences: [] };
  return r;
}

describe('capture settings in the comment', () => {
  it('is a short collapsed table next to the diff, with "same" where head matches base', () => {
    const section = captureSettingsSection(withFingerprints()).join('\n');
    assert.equal(
      section,
      [
        '<details><summary>Capture settings</summary>',
        '',
        '| | Base | Head |',
        '|---|---|---|',
        '| Commit | `1a2b3c4` | `5d6e7f8` |',
        '| Viewports | desktop 1280×800 @1x · mobile 390×844 @2x mobile | same |',
        '| Browser | chromium 159.0.8154.6 | same |',
        '| Web fonts | Inter | Inter, Late; failed: Gone |',
        '| Frozen | clock 2026-11-21 09:00:00 UTC · seed 795556381 · animations off · fonts awaited | same |',
        '| Media | reduced motion · light · en-US · UTC | same |',
        '| Test data | not declared | same |',
        '',
        '<sub>User agent: `Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/159.0.8154.6`</sub>',
        '',
        '</details>',
        '',
      ].join('\n'),
    );
  });

  it('lists the user agent per viewport when they differ', () => {
    const r = withFingerprints();
    const phone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148';
    for (const side of ['base', 'head'] as const) r.captures[1].fingerprint![side]!.browser.userAgent = phone;
    assert.match(captureSettingsSection(r).join('\n'), new RegExp(`<sub>User agent: desktop \`Mozilla/5\\.0 \\(X11; Linux x86_64\\) HeadlessChrome/159\\.0\\.8154\\.6\`; mobile \`${phone.replace(/[.()]/g, '\\$&')}\`</sub>`));
  });

  it('sits collapsed at the end, with the commit pair still at the top', () => {
    const body = renderComment(withFingerprints(), { id: 'default', title: 'UI diff', link });
    const lines = body.split('\n');
    assert.match(lines[3], /^\*\*Base\*\* `main @ 1a2b3c4` → \*\*Head\*\* `feature @ 5d6e7f8`/);
    const settings = body.indexOf('<summary>Capture settings</summary>');
    assert.ok(settings > body.indexOf('<summary>Unchanged') && settings < body.indexOf('<sub>ui-diff '), 'after everything else, before the footer');
  });

  it('is left out for reports without fingerprints (older reports)', () => {
    assert.deepEqual(captureSettingsSection(sampleReport()), []);
    assert.doesNotMatch(renderComment(sampleReport(), { id: 'default', title: 'UI diff', link }), /Capture settings/);
  });
});
