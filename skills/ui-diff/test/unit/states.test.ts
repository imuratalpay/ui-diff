import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchElements, verifyChanges, type ElementChange } from '../../src/elements.js';
import { diffStates, stateCounts, verifyStateChanges, type StateCapture, type StateStyles } from '../../src/states.js';
import type { StyledElement, StyleSnapshot } from '../../src/tokens.js';

const NONE: StateStyles = { color: '#ffffff', background: '#2563eb', 'border-color': 'none', outline: 'none', 'box-shadow': 'none', transform: 'none', opacity: '1', 'text-decoration': 'none', cursor: 'pointer' };

function el(selector: string, name: string, extra: Partial<StyledElement> = {}): StyledElement {
  return { selector, name, tag: selector.split('.')[0], role: 'button', label: name, attrs: { testid: selector }, box: { x: 10, y: 10, width: 80, height: 32 }, deviceBox: { x: 10, y: 10, width: 80, height: 32 }, text: true, parent: null, styles: {} as StyledElement['styles'], ...extra };
}

const MAP: StyleSnapshot = { elements: [el('button.save', "button 'Save'"), el('a.cancel', "link 'Cancel'", { role: 'link' })], colors: {} };

/** One side's states: per selector its default values and its hover and focus values. */
function side(name: string, values: Record<string, { defaults?: Partial<StateStyles>; hover?: Partial<StateStyles>; focus?: Partial<StateStyles> }>): StateCapture {
  const targets = Object.entries(values).map(([selector, v]) => ({ selector, defaults: { ...NONE, ...v.defaults } }));
  const shots = Object.entries(values).flatMap(([selector, v]) =>
    (['hover', 'focus'] as const).filter((s) => v[s]).map((state) => ({ selector, state, styles: { ...NONE, ...v.defaults, ...v[state] }, file: `/${name}/${selector}-${state}.png` })),
  );
  return { checked: targets.length, skipped: 0, skippedWhy: {}, targets, shots };
}

const diff = (base: StateCapture, head: StateCapture) => diffStates(base, head, MAP, MAP, matchElements(MAP.elements, MAP.elements));
const text = (changes: ElementChange[]) => changes.map((c) => `${c.name} · ${c.state}: ${c.changes.map((p) => `${p.property} ${p.before} → ${p.after}`).join(', ')}`);

describe('hover and focus state diff', () => {
  it('reports a hover-only background change on its element, as a cause', () => {
    const changes = diff(side('base', { 'button.save': { hover: { background: '#1d4ed8' }, focus: {} } }), side('head', { 'button.save': { hover: { background: '#1e3a8a' }, focus: {} } }));
    assert.deepEqual(text(changes), ["button 'Save' · hover: background #1d4ed8 → #1e3a8a"]);
    assert.deepEqual(changes[0].changes.map((p) => [p.id, p.kind]), [['h0:hover:background', 'cause']]);
    assert.deepEqual([changes[0].base, changes[0].head, changes[0].confidence], [0, 0, 'high']);
  });

  it('reports a focus ring that was removed', () => {
    const ring = { outline: '2px solid #2563eb, offset 2px' };
    const changes = diff(side('base', { 'button.save': { hover: {}, focus: ring } }), side('head', { 'button.save': { hover: {}, focus: { outline: 'none' } } }));
    assert.deepEqual(text(changes), ["button 'Save' · focus: outline 2px solid #2563eb, offset 2px → none"]);
  });

  it('leaves out a state value that only follows a default-state change', () => {
    // The text color changed in the default state; hover does not set it, so hover shows the same change.
    const changes = diff(side('base', { 'a.cancel': { hover: { 'text-decoration': 'underline' } } }), side('head', { 'a.cancel': { defaults: { color: '#1d4ed8' }, hover: { 'text-decoration': 'underline' } } }));
    assert.deepEqual(changes, []);
  });

  it('reports a state that now overrides what the default changed', () => {
    const changes = diff(side('base', { 'a.cancel': { hover: {} } }), side('head', { 'a.cancel': { defaults: { color: '#1d4ed8' }, hover: { color: '#ffffff', background: '#1d4ed8' } } }));
    assert.deepEqual(text(changes), ["link 'Cancel' · hover: background #2563eb → #1d4ed8"]);
  });

  it('is empty when the states are the same on both sides, or a state was recorded on one side only', () => {
    const same = { 'button.save': { hover: { background: '#1d4ed8' }, focus: { outline: '2px solid #2563eb' } } };
    assert.deepEqual(diff(side('base', same), side('head', same)), []);
    assert.deepEqual(diff(side('base', { 'button.save': { hover: { background: '#1d4ed8' } } }), side('head', { 'button.save': { focus: { outline: 'none' } } })), []);
    assert.deepEqual(diffStates(undefined, side('head', same), MAP, MAP, matchElements(MAP.elements, MAP.elements)), []);
  });

  it('verifies a state change by its match and its crops, except for the cursor, which a screenshot cannot show', () => {
    const changes = [
      ...diff(side('base', { 'button.save': { hover: { background: '#1d4ed8' } } }), side('head', { 'button.save': { hover: { background: '#1e3a8a' } } })),
      ...diff(side('base', { 'a.cancel': { hover: { cursor: 'pointer' } } }), side('head', { 'a.cancel': { hover: { cursor: 'default' } } })),
    ];
    verifyStateChanges(changes, 'medium', () => false);
    assert.deepEqual(changes.map((c) => [c.name, c.verified, c.unverified]), [
      ["button 'Save'", false, ['no changed pixels in its hover crops']],
      ["link 'Cancel'", true, undefined],
    ]);
    verifyStateChanges(changes, 'medium', () => true);
    assert.equal(changes[0].verified, true);
  });

  it('is left alone by the default-state verification', () => {
    const changes = diff(side('base', { 'button.save': { hover: { background: '#1d4ed8' } } }), side('head', { 'button.save': { hover: { background: '#1e3a8a' } } }));
    verifyChanges(changes, [], 'medium');
    assert.equal(changes[0].verified, undefined);
  });

  it('says how many it checked and skipped, with why', () => {
    assert.equal(stateCounts({ checked: 4, skipped: 3, skippedWhy: { hidden: 1, 'outside the viewport': 2 } }), '4 checked, 3 skipped (2 outside the viewport, 1 hidden)');
  });
});
