import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { describe, it } from 'node:test';
import { matchElements, verifyChanges, type ElementChange } from '../../src/elements.js';
import { cropsDiffer, diffStates, stateCounts, verifyStateChanges, type StateCapture, type StateStyles } from '../../src/states.js';
import type { StyledElement, StyleSnapshot } from '../../src/tokens.js';
import { checkSummary } from '../../src/check.js';
import { renderComment } from '../../src/markdown.js';
import { computeStats } from '../../src/report.js';
import { verdict } from '../../src/verdict.js';
import { sampleReport } from './fixtures.js';

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

  it('needs pixel evidence only from matches that are not high confidence, and none for the cursor', () => {
    const changes = [
      ...diff(side('base', { 'button.save': { hover: { background: '#2563eb' } } }), side('head', { 'button.save': { hover: { background: '#1d4ed8' } } })),
      ...diff(side('base', { 'a.cancel': { hover: { cursor: 'pointer' } } }), side('head', { 'a.cancel': { hover: { cursor: 'default' } } })),
    ];
    const medium = { ...changes[0], confidence: 'medium' as const, reason: 'same text', changes: [...changes[0].changes] };
    const all = [...changes, medium];
    verifyStateChanges(all, 'medium', () => false);
    assert.deepEqual(all.map((c) => [c.name, c.confidence, c.verified, c.unverified]), [
      ["button 'Save'", 'high', true, undefined],
      ["link 'Cancel'", 'high', true, undefined],
      ["button 'Save'", 'medium', false, ['no changed pixels in its hover crops']],
    ]);
    verifyStateChanges(all, 'medium', () => true);
    assert.equal(medium.verified, true);
  });

  it('compares state crops exactly, so a one-shade hover step counts as changed', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ui-diff-crops-'));
    try {
      const fill = (file: string, rgb: [number, number, number]) => {
        const png = new PNG({ width: 40, height: 20 });
        for (let i = 0; i < png.data.length; i += 4) png.data.set([...rgb, 255], i);
        writeFileSync(path.join(dir, file), PNG.sync.write(png));
        return path.join(dir, file);
      };
      const [base, head, same] = [fill('a.png', [0x25, 0x63, 0xeb]), fill('b.png', [0x1d, 0x4e, 0xd8]), fill('c.png', [0x25, 0x63, 0xeb])];
      assert.equal(cropsDiffer(base, head), true, '#2563eb → #1d4ed8');
      assert.equal(cropsDiffer(base, head, 0.1), false, 'the threshold of the page diff is too loose for it');
      assert.equal(cropsDiffer(base, same), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe('hover and focus changes in the comment and in check', () => {
  /** sampleReport with its changed capture made unchanged, and one verified hover change on it. */
  function stateOnly() {
    const r = sampleReport();
    const c = r.captures[0];
    const changes = diff(side('base', { 'button.save': { hover: { background: '#1d4ed8' } } }), side('head', { 'button.save': { hover: { background: '#1e3a8a' } } }));
    changes[0].verified = true;
    r.captures[0] = { ...c, status: 'unchanged', diff: undefined, images: { focus: [], states: [{ file: 'compare/home__desktop__light__hover-1.png', name: "button 'Save'", state: 'hover', text: 'background #1d4ed8 → #1e3a8a' }] }, styleDiff: { matched: { high: 2, medium: 0, low: 0 }, changes, regions: [] } };
    r.stats = computeStats(r.captures);
    return r;
  }

  it('counts a hover change on a page whose default state did not change, and lists it under its element', () => {
    const r = stateOnly();
    assert.deepEqual([verdict(r).kind, verdict(r).text], ['visual changes', '1 measured change on 1 route']);
    const body = renderComment(r, { id: 'default', title: 'UI diff', link: (p) => p });
    assert.match(body, /<sub>2 captures · 2 unchanged · 1 with hover or focus changes<\/sub>/);
    assert.match(body, /<summary>Unchanged \(1\)<\/summary>\n\n- `\/ · mobile`\n/, 'the capture with a hover change is not listed as unchanged');
    assert.match(body, /#### Measured changes\n\n\*\*`\/`\*\*\n\n- `button 'Save'` \(`button\.save`\) · hover: background #1d4ed8 → #1e3a8a — desktop\n/);
    assert.match(body, /#### Images\n\n\*\*`\/`\*\* · desktop — no change in the default state\n\n<img src="compare\/home__desktop__light__hover-1\.png" alt="\/ · desktop: button 'Save' on hover, before and after">\n\n<sub>button 'Save' · hover: background #1d4ed8 → #1e3a8a<\/sub>\n/);
    const check = checkSummary(r, '/o');
    assert.equal(check.exitCode, 1);
    assert.match(check.text, /\n {2}- button 'Save' \(button\.save\) · hover: background #1d4ed8 → #1e3a8a — desktop\n/);
    assert.match(check.text, /Images \(0 of 2 captures changed, 1 more with hover or focus changes\)\n {2}\/ {2}desktop {2}no change in the default state\n {4}\/o\/compare\/home__desktop__light__hover-1\.png\n/);
  });

  it('puts an unverified state change on the unverified line, and counts nothing', () => {
    const r = stateOnly();
    const change = r.captures[0].styleDiff!.changes[0];
    change.verified = false;
    change.unverified = ['no changed pixels in its hover crops'];
    r.captures[0].images.states = undefined;
    assert.equal(verdict(r).text, 'No visual changes');
    assert.match(renderComment(r, { id: 'default', title: 'UI diff', link: (p) => p }), /Unverified \(not matched confidently, or no changed pixels in their area\): button 'Save' · hover: background #1d4ed8 → #1e3a8a \(no changed pixels in its hover crops\)/);
  });
});
