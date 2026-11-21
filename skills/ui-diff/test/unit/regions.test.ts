import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diffElements, explainRegions, matchElements } from '../../src/elements.js';
import type { StyledElement, StyleSnapshot } from '../../src/tokens.js';

function el(over: Partial<StyledElement> & { tag: string; box: StyledElement['box'] }): StyledElement {
  return {
    selector: over.tag,
    text: Boolean(over.ownText),
    parent: null,
    styles: { color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)', borderColor: [], margin: [], padding: [], gap: [], radius: [], fontSize: '16px', fontWeight: '400', fontFamily: 'Arial', lineHeight: '24px' },
    ...over,
    deviceBox: { x: over.box.x * 2, y: over.box.y * 2, width: over.box.width * 2, height: over.box.height * 2 },
  };
}

const snap = (elements: StyledElement[]): StyleSnapshot => ({ elements, colors: {} });

describe('changed pixels to elements', () => {
  const base = [
    el({ tag: 'main', selector: 'main', box: { x: 0, y: 0, width: 800, height: 600 } }),
    el({ tag: 'a', selector: 'a.cta', name: "link 'Get started'", attrs: { testid: 'cta' }, parent: 0, box: { x: 40, y: 100, width: 100, height: 36 }, styles: { ...el({ tag: 'x', box: { x: 0, y: 0, width: 1, height: 1 } }).styles, padding: ['8px', '14px', '8px', '14px'] } }),
    el({ tag: 'img', selector: 'img.hero', name: "img 'Hero'", attrs: { testid: 'hero' }, src: '/hero.png', parent: 0, box: { x: 300, y: 100, width: 200, height: 120 } }),
    el({ tag: 'a', selector: 'nav a', name: "link 'Pricing'", attrs: { testid: 'plans' }, ownText: 'Pricing', parent: 0, box: { x: 40, y: 20, width: 60, height: 20 } }),
  ];
  const head = base.map((e) => ({ ...e, styles: { ...e.styles } }));
  head[1] = { ...head[1], box: { x: 40, y: 100, width: 108, height: 40 }, deviceBox: { x: 80, y: 200, width: 216, height: 80 }, styles: { ...head[1].styles, padding: ['10px', '18px', '10px', '18px'] } };
  head[3] = { ...head[3], ownText: 'Plans' };
  const changes = diffElements(snap(base), snap(head), matchElements(base, head));
  const explain = (region: { x: number; y: number; width: number; height: number }) => explainRegions([region], 2, snap(head), snap(base), changes)[0];

  it('names an area after the smallest element containing it and lists its measured changes', () => {
    const r = explain({ x: 80, y: 200, width: 224, height: 80 });
    assert.deepEqual(r.element, { name: "link 'Get started'", selector: 'a.cta' });
    assert.deepEqual(r.changes.map((i) => changes[i].changes.map((p) => p.property)), [['size', 'padding']]);
    assert.equal(r.note, undefined);
  });

  it('names a text change', () => {
    const r = explain({ x: 80, y: 40, width: 120, height: 40 });
    assert.deepEqual(r.changes.map((i) => changes[i].changes), [[{ property: 'text', group: 'content', before: "'Pricing'", after: "'Plans'", id: 'h3:text', kind: 'cause' }]]);
  });

  it('says "image content changed" when an image changed without a measured change', () => {
    assert.equal(explain({ x: 640, y: 240, width: 64, height: 64 }).note, "image content changed (img 'Hero')");
  });

  it('says pixels changed without a measured change, and that no element covers an area, instead of guessing', () => {
    assert.equal(explain({ x: 1000, y: 700, width: 64, height: 32 }).note, 'pixels changed, but no measured style, text or size change explains it');
    const outside = explain({ x: 1700, y: 1300, width: 64, height: 32 });
    assert.deepEqual([outside.element, outside.note], [undefined, 'no element covers this area, so it is not named']);
  });
});
