import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PNG } from 'pngjs';
import { diffPngs } from '../../src/diff.js';
import { diffElements, matchElements } from '../../src/elements.js';
import { renderComment } from '../../src/markdown.js';
import { regionWarnings } from '../../src/pipeline.js';
import type { StyledElement } from '../../src/tokens.js';
import { sampleReport } from './fixtures.js';

function image(width: number, height: number, paint: Array<[number, number, number, number]> = []): PNG {
  const png = new PNG({ width, height });
  png.data.fill(255);
  for (const [x, y, w, h] of paint) for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) png.data.set([0, 0, 0, 255], (yy * width + xx) * 4);
  return png;
}

const opts = { threshold: 0.1, includeAA: false, minChangedPixels: 8, highlight: '#FF0080', alignShifts: false };

describe('focus and ignore regions', () => {
  it('limits the pixel diff to the focus boxes, and a size change alone does not count', () => {
    const before = image(200, 100);
    const after = image(200, 100, [[10, 10, 20, 20], [150, 60, 20, 20]]);
    assert.equal(diffPngs(before, after, opts).regions.length, 2);
    const focused = diffPngs(before, after, { ...opts, only: [{ x: 140, y: 50, width: 50, height: 40 }] });
    assert.equal(focused.changedPixels, 400);
    assert.deepEqual(focused.regions.length, 1);
    assert.ok(focused.regions[0].x >= 136);
    const taller = diffPngs(image(200, 100), image(200, 120), { ...opts, only: [{ x: 0, y: 0, width: 200, height: 50 }] });
    assert.equal(taller.changed, false, 'the page grew below the focus area');
  });

  it('limits the style diff to focused elements and what they contain', () => {
    const el = (over: Partial<StyledElement> & { tag: string }): StyledElement => ({
      selector: over.tag,
      box: { x: 0, y: 0, width: 100, height: 20 },
      text: false,
      parent: null,
      styles: { color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)', borderColor: [], margin: [], padding: [], gap: [], radius: [], fontSize: '16px', fontWeight: '400', fontFamily: 'Arial', lineHeight: '24px' },
      ...over,
    });
    const side = (price: string, promo: string) => [el({ tag: 'section', attrs: { id: 'pricing' }, focus: true }), el({ tag: 'p', attrs: { id: 'price' }, ownText: price, parent: 0 }), el({ tag: 'p', attrs: { id: 'promo' }, ownText: promo })];
    const [base, head] = [side('$9', 'Sale'), side('$12', 'Spring sale')];
    const snap = (elements: StyledElement[]) => ({ elements, colors: {} });
    const all = diffElements(snap(base), snap(head), matchElements(base, head));
    const focused = diffElements(snap(base), snap(head), matchElements(base, head), { focusOnly: true });
    assert.deepEqual(all.map((c) => c.selector).sort(), ['p', 'p']);
    assert.deepEqual(focused.map((c) => c.changes[0].after), ["'$12'"]);
  });

  it('warns about selectors that matched nothing, and when focus fell back to the whole page', () => {
    const regions = { focus: ['.pricing', '.missing'], ignore: ['.ad', '.gone'] };
    const hits = { focus: { '.pricing': 1, '.missing': 0 }, ignore: { '.ad': 2, '.gone': 0 } };
    assert.deepEqual(regionWarnings(regions, { base: hits, head: { ...hits, focus: { '.pricing': 0, '.missing': 0 } } }), [
      'focus selector `.pricing` matched nothing on head',
      'focus selector `.missing` matched nothing on base and head',
      'ignore selector `.gone` matched nothing on base and head',
    ]);
    assert.deepEqual(regionWarnings({ focus: ['.missing'], ignore: [] }, { base: { focus: { '.missing': 0 }, ignore: {} }, head: { focus: { '.missing': 0 }, ignore: {} } }), [
      'focus selector `.missing` matched nothing on base and head',
      'no focus selector matched, so the whole page was compared',
    ]);
  });

  it('says in one line which regions were focused or ignored', () => {
    const body = renderComment(sampleReport({ regions: { focus: ['.pricing'], ignore: ['.ad', '#live'] } }), { id: 'default', title: 'UI diff', link: (p) => p });
    assert.match(body, /<sub>Focused on `\.pricing` \(only changes inside are compared\); ignored `\.ad`, `#live`\.<\/sub>/);
    assert.match(renderComment(sampleReport({ regions: { focus: [], ignore: ['.ad'] } }), { id: 'default', title: 'UI diff', link: (p) => p }), /<sub>Ignored `\.ad`\.<\/sub>/);
  });
});
