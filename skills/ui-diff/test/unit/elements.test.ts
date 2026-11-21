import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchElements, type ElementMatch } from '../../src/elements.js';
import type { StyledElement } from '../../src/tokens.js';

let y = 0;
/** A minimal element map entry; boxes stack down the page unless given. */
function el(over: Partial<StyledElement> & { tag: string }): StyledElement {
  y += 40;
  return {
    selector: over.tag,
    box: { x: 0, y, width: 200, height: 30 },
    text: Boolean(over.ownText),
    styles: { color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)', borderColor: [], margin: [], padding: [], gap: [], radius: [], fontSize: '16px', fontWeight: '400', fontFamily: 'Arial', lineHeight: 'normal' },
    parent: null,
    ...over,
  };
}

function accountedFor(m: ElementMatch, base: number, head: number): void {
  const b = [...m.pairs.map((p) => p.base), ...m.removed].sort((x, z) => x - z);
  const h = [...m.pairs.map((p) => p.head), ...m.added].sort((x, z) => x - z);
  assert.deepEqual(b, [...Array(base).keys()], 'every base element is paired or removed');
  assert.deepEqual(h, [...Array(head).keys()], 'every head element is paired or added');
}

describe('matching base and head elements', () => {
  it('pairs on stable attributes first, with high confidence and the reason', () => {
    const base = [el({ tag: 'a', attrs: { testid: 'cta' }, selector: 'a.cta' }), el({ tag: 'div', attrs: { id: 'pro' } }), el({ tag: 'a', role: 'link', attrs: { ariaLabel: 'Home' } }), el({ tag: 'button', role: 'button', label: 'Subscribe' })];
    const head = [el({ tag: 'button', role: 'button', label: 'Subscribe' }), el({ tag: 'a', role: 'link', attrs: { ariaLabel: 'Home' } }), el({ tag: 'div', attrs: { id: 'pro' } }), el({ tag: 'a', attrs: { testid: 'cta' }, selector: 'a.primary' })];
    const m = matchElements(base, head);
    assert.deepEqual(
      m.pairs.map((p) => [p.base, p.head, p.confidence, p.reason]),
      [
        [3, 0, 'high', 'same button named "Subscribe"'],
        [2, 1, 'high', 'same aria-label "Home"'],
        [1, 2, 'high', 'same id "pro"'],
        [0, 3, 'high', 'same data-testid "cta"'],
      ],
    );
    accountedFor(m, 4, 4);
  });

  it('follows reordered items by their text instead of reporting them all as changed', () => {
    const list = (order: string[]) => [el({ tag: 'ul', selector: 'ul' }), ...order.map((t, i) => el({ tag: 'li', ownText: t, parent: 0, selector: `li:nth-of-type(${i + 1})` }))];
    const m = matchElements(list(['Starter', 'Pro', 'Team']), list(['Team', 'Starter', 'Pro']));
    const byText = (i: number) => ['ul', 'Starter', 'Pro', 'Team'][i];
    const headText = (i: number) => ['ul', 'Team', 'Starter', 'Pro'][i];
    for (const p of m.pairs.filter((x) => x.base > 0)) assert.equal(byText(p.base), headText(p.head));
    assert.deepEqual([m.added, m.removed], [[], []]);
    assert.ok(m.pairs.filter((p) => p.base > 0).every((p) => /^same text/.test(p.reason)));
  });

  it('reports an inserted element as added and keeps its siblings paired', () => {
    const base = [el({ tag: 'nav' }), el({ tag: 'a', ownText: 'Docs', parent: 0 }), el({ tag: 'a', ownText: 'Blog', parent: 0 })];
    const head = [el({ tag: 'nav' }), el({ tag: 'a', ownText: 'Docs', parent: 0 }), el({ tag: 'a', ownText: 'Pricing', parent: 0 }), el({ tag: 'a', ownText: 'Blog', parent: 0 })];
    const m = matchElements(base, head);
    assert.deepEqual(m.added, [2]);
    assert.deepEqual(m.removed, []);
    accountedFor(m, 3, 4);
  });

  it('pairs untexted children under matched parents, then falls back to position, and never drops an element', () => {
    const base = [el({ tag: 'section', selector: '#hero', attrs: { id: 'hero' } }), el({ tag: 'div', selector: 'div.dot', parent: 0 }), el({ tag: 'div', selector: 'div.dot', parent: 0 }), el({ tag: 'img', selector: 'img.hero', box: { x: 300, y: 10, width: 100, height: 50 } }), el({ tag: 'span' })];
    const head = [el({ tag: 'section', selector: '#hero', attrs: { id: 'hero' } }), el({ tag: 'div', selector: 'div.dot', parent: 0 }), el({ tag: 'div', selector: 'div.dot', parent: 0 }), el({ tag: 'img', selector: 'img.banner', box: { x: 304, y: 12, width: 100, height: 52 } }), el({ tag: 'p', ownText: 'New' })];
    const m = matchElements(base, head);
    assert.deepEqual(
      m.pairs.filter((p) => p.base === 1 || p.base === 2).map((p) => [p.base, p.head, p.confidence]),
      [
        [1, 1, 'medium'],
        [2, 2, 'medium'],
      ],
    );
    assert.equal(m.pairs.find((p) => p.base === 1)!.reason, 'same place under #hero');
    assert.deepEqual(m.pairs.find((p) => p.base === 3), { base: 3, head: 3, confidence: 'low', reason: 'same tag at about the same place' });
    assert.deepEqual([m.removed, m.added], [[4], [4]], 'a span that became a p is removed + added, not paired');
    accountedFor(m, 5, 5);
  });

  it('does not guess between duplicates', () => {
    const base = [el({ tag: 'button', role: 'button', label: 'Buy' }), el({ tag: 'button', role: 'button', label: 'Buy', box: { x: 500, y: 900, width: 80, height: 30 } })];
    const head = [el({ tag: 'button', role: 'button', label: 'Buy', box: { x: 0, y: 2000, width: 80, height: 30 } })];
    const m = matchElements(base, head);
    assert.equal(m.pairs.length, 0);
    accountedFor(m, 2, 1);
  });
});
