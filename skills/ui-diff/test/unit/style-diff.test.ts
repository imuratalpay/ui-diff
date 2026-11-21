import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diffElements, matchElements } from '../../src/elements.js';
import type { StyledElement, StyleSnapshot } from '../../src/tokens.js';

type Over = Partial<Omit<StyledElement, 'styles'>> & { tag: string; styles?: Partial<StyledElement['styles']> };

function el(over: Over): StyledElement {
  return {
    selector: over.tag,
    box: { x: 0, y: 0, width: 100, height: 20 },
    text: Boolean(over.ownText),
    parent: null,
    ...over,
    styles: {
      color: 'rgb(17, 24, 39)',
      backgroundColor: 'rgba(0, 0, 0, 0)',
      borderColor: [],
      margin: ['0px', '0px', '0px', '0px'],
      padding: ['0px', '0px', '0px', '0px'],
      gap: ['normal', 'normal'],
      radius: ['0px', '0px', '0px', '0px'],
      fontSize: '16px',
      fontWeight: '400',
      fontFamily: 'Arial, sans-serif',
      lineHeight: '24px',
      letterSpacing: 'normal',
      opacity: '1',
      boxShadow: 'none',
      borderWidth: ['0px', '0px', '0px', '0px'],
      borderColors: ['rgb(17, 24, 39)', 'rgb(17, 24, 39)', 'rgb(17, 24, 39)', 'rgb(17, 24, 39)'],
      backgroundImage: 'none',
      display: 'block',
      flexDirection: 'row',
      gridAutoFlow: 'row',
      justifyContent: 'normal',
      alignItems: 'normal',
      ...over.styles,
    },
  };
}

const snap = (elements: StyledElement[], colors: StyleSnapshot['colors'] = {}): StyleSnapshot => ({ elements, colors });
const diff = (base: StyledElement[], head: StyledElement[], colors: StyleSnapshot['colors'] = {}) => diffElements(snap(base, colors), snap(head, colors), matchElements(base, head));
/** The elements with a change that counts (a cause, or geometry nothing explains). */
const counted = (changes: ReturnType<typeof diff>) => changes.filter((c) => c.kind !== 'changed' || c.changes.some((p) => p.kind !== 'effect'));

/** A hero with a button and a link side by side, and a section below it, as in the sample site. */
function page(cta: { padding: string[]; radius: string; width: number; height: number }) {
  const grow = cta.height - 36;
  return [
    el({ tag: 'main', box: { x: 0, y: 0, width: 800, height: 600 + grow } }),
    el({ tag: 'section', selector: 'section.hero', parent: 0, box: { x: 0, y: 0, width: 800, height: 200 + grow } }),
    el({ tag: 'div', selector: 'div.hero-actions', parent: 1, box: { x: 40, y: 120, width: 400, height: cta.height }, styles: { display: 'flex', gap: ['16px', '16px'] } }),
    el({ tag: 'a', selector: 'a.cta', name: "link 'Get started'", ownText: 'Get started', label: 'Get started', role: 'link', parent: 2, box: { x: 40, y: 120, width: cta.width, height: cta.height }, styles: { padding: cta.padding, radius: [cta.radius, cta.radius, cta.radius, cta.radius], color: 'rgb(255, 255, 255)', backgroundColor: 'rgb(37, 99, 235)' } }),
    el({ tag: 'a', selector: 'a.secondary', name: "link 'See how it works'", ownText: 'See how it works', label: 'See how it works', role: 'link', parent: 2, box: { x: 40 + cta.width + 16, y: 120, width: 120, height: 24 } }),
    el({ tag: 'section', selector: 'section.features', ownText: 'Features', parent: 0, box: { x: 0, y: 200 + grow, width: 800, height: 400 } }),
  ];
}

describe('measured style diff', () => {
  it('names the element whose padding changed, with the exact before → after, and what it pushed as its effects', () => {
    const before = page({ padding: ['8px', '14px', '8px', '14px'], radius: '4px', width: 100, height: 36 });
    const after = page({ padding: ['10px', '18px', '10px', '18px'], radius: '8px', width: 108, height: 40 });
    const changes = diff(before, after);
    assert.deepEqual(
      counted(changes).map((c) => ({ name: c.name, kind: c.kind, changes: c.changes.map((p) => `${p.kind} ${p.property} ${p.before} → ${p.after}`) })),
      [{ name: "link 'Get started'", kind: 'changed', changes: ['effect size 100×36px → 108×40px', 'cause padding 8px 14px → 10px 18px', 'cause border-radius 4px → 8px'] }],
    );
    const effects = changes.filter((c) => !counted(changes).includes(c));
    assert.deepEqual(effects.map((c) => `${c.selector} ${c.changes.map((p) => p.property).join()}`).sort(), ['a.secondary position', 'div.hero-actions size', 'main size', 'section.features position', 'section.hero size']);
    assert.ok(changes.flatMap((c) => c.changes).filter((p) => p.kind === 'effect').every((p) => p.cause === 'h3:padding'), 'all from the padding change');
    assert.equal(changes[0].confidence, 'high');
    assert.equal(changes[0].reason, 'same link named "Get started"');
  });

  it('does not flag identical values written differently (colors, sub-pixel px, shadows)', () => {
    const base = [el({ tag: 'div', selector: 'div.a', styles: { color: 'rgb(37, 99, 235)', backgroundColor: 'rgba(0, 0, 0, 0)', padding: ['8.24px', '10px', '8px', '10.0001px'], boxShadow: 'rgba(0, 0, 0, 0.1) 0px 1px 2px 0px', lineHeight: '24px' } })];
    const head = [el({ tag: 'div', selector: 'div.a', styles: { color: 'oklch(0.546 0.215 262.9)', backgroundColor: 'transparent', padding: ['8.26px', '10px', '8px', '10px'], boxShadow: 'rgba(0, 0, 0, 0.1) 0px 1.0001px 2px 0px', lineHeight: '24.1px' } })];
    const colors = { 'rgb(37, 99, 235)': [37, 99, 235, 1], 'oklch(0.546 0.215 262.9)': [37, 99, 235, 1], 'rgba(0, 0, 0, 0)': [0, 0, 0, 0], transparent: [0, 0, 0, 0] } as StyleSnapshot['colors'];
    assert.deepEqual(diff(base, head, colors), []);
  });

  it('reports a real color change once, on the element where it changed, not on every child that inherits it', () => {
    const base = [el({ tag: 'label', selector: 'label', ownText: 'Work email', styles: { color: 'rgb(17, 24, 39)' } }), el({ tag: 'span', selector: 'label > span', ownText: '*', parent: 0, styles: { color: 'rgb(17, 24, 39)' } })];
    const head = [el({ tag: 'label', selector: 'label', ownText: 'Work email', styles: { color: 'rgb(37, 99, 235)' } }), el({ tag: 'span', selector: 'label > span', ownText: '*', parent: 0, styles: { color: 'rgb(37, 99, 235)' } })];
    const changes = diff(base, head);
    assert.deepEqual(
      changes.map((c) => [c.selector, c.changes.map((p) => `${p.property} ${p.before} → ${p.after}`)]),
      [['label', ['color #111827 → #2563eb']]],
    );
  });

  it('reports text changes, and an added subtree as one entry', () => {
    const base = [el({ tag: 'nav', attrs: { id: 'nav' } }), el({ tag: 'a', selector: 'nav > a', attrs: { testid: 'plans' }, ownText: 'Pricing', parent: 0 })];
    const head = [
      el({ tag: 'nav', attrs: { id: 'nav' } }),
      el({ tag: 'a', selector: 'nav > a', attrs: { testid: 'plans' }, ownText: 'Plans', parent: 0 }),
      el({ tag: 'div', selector: 'div.promo', name: 'div.promo', box: { x: 0, y: 100, width: 300, height: 80 } }),
      el({ tag: 'p', selector: 'div.promo > p', ownText: 'Sale', parent: 2 }),
      el({ tag: 'a', selector: 'div.promo > a', ownText: 'Shop', parent: 2 }),
    ];
    const changes = diff(base, head);
    const text = changes.find((c) => c.kind === 'changed')!;
    assert.deepEqual(text.changes, [{ property: 'text', group: 'content', before: "'Pricing'", after: "'Plans'", id: 'h1:text', kind: 'cause' }]);
    const added = changes.filter((c) => c.kind === 'added');
    assert.deepEqual(added.map((c) => [c.selector, c.inside]), [['div.promo', 2]]);
  });

  it('reports an element that moved on its own, in px', () => {
    const base = [el({ tag: 'div', attrs: { id: 'card' }, box: { x: 0, y: 0, width: 400, height: 300 } }), el({ tag: 'img', selector: '#card img', label: 'Logo', role: 'img', parent: 0, box: { x: 10, y: 10, width: 40, height: 40 } })];
    const head = [el({ tag: 'div', attrs: { id: 'card' }, box: { x: 0, y: 0, width: 400, height: 300 } }), el({ tag: 'img', selector: '#card img', label: 'Logo', role: 'img', parent: 0, box: { x: 18, y: 10, width: 40, height: 40 }, styles: { margin: ['0px', '0px', '0px', '8px'] } })];
    assert.deepEqual(
      diff(base, head)[0].changes.map((p) => `${p.property} ${p.before} → ${p.after}`),
      ['margin 0px → 0px 0px 0px 8px', 'position  → moved 8px right'],
    );
  });

  it('reports reordered items once, as an order change of their parent, and their moves as its effects', () => {
    const list = (order: string[]) => [el({ tag: 'ul', attrs: { id: 'plans' }, box: { x: 0, y: 0, width: 300, height: 120 } }), ...order.map((t, i) => el({ tag: 'li', ownText: t, selector: `li:nth-of-type(${i + 1})`, parent: 0, box: { x: 0, y: i * 40, width: 300, height: 40 } }))];
    const changes = diff(list(['Starter', 'Pro', 'Team']), list(['Team', 'Starter', 'Pro']));
    assert.deepEqual(
      counted(changes).map((c) => [c.selector, c.changes.map((p) => `${p.property} ${p.before} → ${p.after}`)]),
      [['ul', ['order Starter, Pro, Team → Team, Starter, Pro']]],
    );
    assert.ok(changes.filter((c) => c.selector.startsWith('li')).every((c) => c.changes.every((p) => p.kind === 'effect' && p.cause === 'h0:order')));
  });

  it('leaves out masked elements and border colors without a border, and counts siblings pushed by a gap change as effects', () => {
    const row = (gap: string, cta: number, counter: string) => [
      el({ tag: 'div', selector: 'div.actions', attrs: { id: 'actions' }, box: { x: 0, y: 0, width: 600, height: 40 }, styles: { display: 'flex', gap: [gap, gap] } }),
      el({ tag: 'a', selector: 'a.cta', attrs: { testid: 'cta' }, parent: 0, box: { x: 0, y: 0, width: cta, height: 40 } }),
      el({ tag: 'a', selector: 'a.secondary', attrs: { testid: 'secondary' }, parent: 0, box: { x: cta + parseFloat(gap), y: 8, width: 120, height: 24 } }),
      el({ tag: 'span', selector: '#visitors', attrs: { id: 'visitors' }, ownText: counter, masked: true, box: { x: 0, y: 60, width: 40, height: 20 } }),
      el({ tag: 'label', selector: 'label', attrs: { id: 'email-label' }, box: { x: 0, y: 100, width: 100, height: 20 }, styles: { color: counter === '500' ? 'rgb(15, 23, 42)' : 'rgb(37, 99, 235)', borderColors: Array(4).fill(counter === '500' ? 'rgb(15, 23, 42)' : 'rgb(37, 99, 235)') } }),
    ];
    const changes = diff(row('16px', 134, '500'), row('17px', 142, '900'));
    assert.deepEqual(
      counted(changes).map((c) => [c.selector, c.changes.map((p) => `${p.kind} ${p.property}`)]).sort(),
      [
        ['a.cta', ['unexplained size']],
        ['div.actions', ['cause gap']],
        ['label', ['cause color']],
      ],
    );
    assert.deepEqual(changes.find((c) => c.selector === 'a.secondary')?.changes.map((p) => `${p.kind} ${p.property}`), ['effect position']);
  });

  it('is empty for identical maps', () => {
    const p = page({ padding: ['8px', '14px', '8px', '14px'], radius: '4px', width: 100, height: 36 });
    assert.deepEqual(diff(p, JSON.parse(JSON.stringify(p))), []);
  });
});
