import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { code, compressWhere, extractPicks, referencedImages, renderComment, stickyMarker } from '../../src/markdown.js';
import { autoSummary, computeStats, pct, truncationWarning } from '../../src/report.js';
import { sampleReport } from './fixtures.js';

const link = (p: string) => `https://github.com/acme/app/raw/ui-diff-assets/pr-1/${p}`;

describe('comment rendering', () => {
  it('starts with the hidden sticky marker and includes every section', () => {
    const body = renderComment(sampleReport(), { id: 'default', title: 'UI diff', link, summary: '**What changed**\n- Buttons are now pills.' });
    assert.ok(body.startsWith(stickyMarker('default')));
    assert.match(body, /### UI diff — 1 changed, 1 unchanged/);
    assert.match(body, /\*\*Base\*\* `main @ 1a2b3c4` → \*\*Head\*\* `feature @ 5d6e7f8`/);
    assert.match(body, /Buttons are now pills/);
    assert.match(body, /4\.23% of pixels changed · 1 area · page height 1600 → 1744px/);
    assert.match(body, /<img src="https:\/\/github\.com\/acme\/app\/raw\/ui-diff-assets\/pr-1\/compare\/home__desktop__light__focus-1\.png"/);
    assert.match(body, /<details><summary>Unchanged \(1\)<\/summary>/);
    assert.match(body, /#### Variants/);
    assert.match(body, /- \[ \] `hero=2` <!-- ui-diff-pick:home:desktop:hero=2 -->/);
    assert.match(body, /#### Motion/);
    assert.match(body, /#### Accessibility — 1 new, 0 fixed/);
    assert.match(body, /\| New \| \[Elements must meet minimum color contrast ratio thresholds\]/);
    assert.match(body, /`\/` \(all 2\)/);
    assert.match(body, /#### Design tokens — 1 new off-token value/);
    assert.match(body, /<!-- ui-diff:meta \{"head":"5d6e7f8a"/);
  });

  it('falls back to the automatic summary', () => {
    const body = renderComment(sampleReport(), { id: 'default', title: 'UI diff', link });
    assert.match(body, /`\/` changed on desktop/);
  });

  it('keeps variant picks that reviewers ticked', () => {
    const previous = '- [ ] `hero=1` <!-- ui-diff-pick:home:desktop:hero=1 -->\n- [x] `hero=2` <!-- ui-diff-pick:home:desktop:hero=2 -->';
    assert.deepEqual([...extractPicks(previous)], ['home:desktop:hero=2']);
    const body = renderComment(sampleReport(), { id: 'default', title: 'UI diff', link, previousBody: previous });
    assert.match(body, /- \[x\] `hero=2`/);
    assert.match(body, /- \[ \] `hero=1`/);
  });

  it('drops detail to stay under the size limit', () => {
    const many = sampleReport();
    many.captures = Array.from({ length: 80 }, (_, i) => ({ ...many.captures[0], id: `r${i}`, route: { path: `/route-${i}`, name: `r${i}`, slug: `r${i}` } }));
    many.stats = computeStats(many.captures);
    const full = renderComment(many, { id: 'default', title: 'UI diff', link });
    assert.ok(full.length > 30000);
    assert.match(full, /<details><summary>Full page<\/summary>/);
    const compact = renderComment(many, { id: 'default', title: 'UI diff', link, maxLength: 30000 });
    assert.ok(compact.length <= 30000);
    assert.doesNotMatch(compact, /<summary>Full page<\/summary>/);
    const tiny = renderComment(many, { id: 'default', title: 'UI diff', link, maxLength: 5000 });
    assert.ok(tiny.length <= 5000);
    assert.ok(tiny.startsWith(stickyMarker('default')));
  });

  it('renders a text-only comment when nothing is uploaded', () => {
    const body = renderComment(sampleReport(), { id: 'default', title: 'UI diff', link, images: false });
    assert.doesNotMatch(body, /<img /);
    assert.match(body, /image not uploaded/);
  });

  it('keeps a text-only render text-only when another render runs meanwhile', () => {
    const report = sampleReport();
    const nested = (p: string) => {
      renderComment(report, { id: 'other', title: 'UI diff', link, images: true });
      return link(p);
    };
    const body = renderComment(report, { id: 'default', title: 'UI diff', link: nested, images: false });
    assert.doesNotMatch(body, /<img /);
    assert.match(renderComment(report, { id: 'default', title: 'UI diff', link }), /<img /);
  });

  it('lists exactly the images it references', () => {
    const refs = referencedImages(sampleReport(), { id: 'default', title: 'UI diff' });
    assert.deepEqual(refs.sort(), ['compare/home__desktop__light.png', 'compare/home__desktop__light__focus-1.png', 'motion/home.gif', 'variants/hero-1.png', 'variants/hero-2.png']);
  });

  it('formats helpers', () => {
    assert.equal(code('a`b'), '`` a`b ``');
    assert.equal(pct(0), '0%');
    assert.equal(pct(0.00001), '<0.01%');
    assert.equal(pct(0.1234), '12.3%');
    assert.equal(compressWhere(['/ desktop/light', '/ mobile/light', '/about desktop/light'], new Map([['/', 2], ['/about', 2]])), '`/` (all 2); `/about` desktop/light');
    assert.match(autoSummary(sampleReport({ captures: [], stats: computeStats([]) })), /Nothing was checked/);
  });
});

describe('truncated captures', () => {
  const cutReport = () => {
    const r = sampleReport();
    r.captures[1] = { ...r.captures[1], truncated: true };
    return r;
  };

  it('builds a report warning that names the cut captures and the limit', () => {
    const r = cutReport();
    const warning = truncationWarning(r.captures, 4000);
    assert.match(warning ?? '', /^1 capture was cut at capture\.maxHeight \(4000px\): home__mobile__light\./);
    assert.equal(truncationWarning(sampleReport().captures, 4000), undefined);
  });

  it('mentions partial captures in the automatic summary', () => {
    assert.match(autoSummary(cutReport()), /1 capture only cover the top of the page/);
    assert.doesNotMatch(autoSummary(sampleReport()), /top of the page/);
  });

  it('warns in the comment even when a custom summary is used', () => {
    const body = renderComment(cutReport(), { id: 'default', title: 'UI diff', link, summary: 'Custom summary.' });
    assert.match(body, /Partial captures: only the top of `\/ · mobile` was compared/);
    assert.doesNotMatch(renderComment(sampleReport(), { id: 'default', title: 'UI diff', link }), /Partial captures/);
  });
});
