import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { componentCrop, componentOutcome, insideRoot, matchMiss, rootChange, scopeChanges, shiftSnapshot, toDevice } from '../../src/components.js';
import { parseConfig } from '../../src/config.js';
import { diffElements, matchElements, type ElementChange } from '../../src/elements.js';
import { captureKey, keyId } from '../../src/key.js';
import type { StyledElement, StyleSnapshot } from '../../src/tokens.js';
import { checkSummary } from '../../src/check.js';
import { renderComment, timingLine } from '../../src/markdown.js';
import { autoSummary, computeStats, type CaptureResult, type ComponentResult, type Report } from '../../src/report.js';
import { measuredGroups, verdict } from '../../src/verdict.js';
import { sampleReport } from './fixtures.js';

const parse = (raw: unknown) => parseConfig(raw, { repoRoot: '/repo' });
const MENU = { name: 'menu', route: '/', steps: [{ click: '#burger', checkpoint: 'after open' }, { press: 'Escape', checkpoint: 'closed' }] };

describe('component config', () => {
  it('has no components by default, and caps at 10 with an 8px crop padding', () => {
    const cfg = parse({});
    assert.deepEqual(cfg.components, []);
    assert.deepEqual(cfg.componentLimits, { maxComponents: 10, padding: 8 });
  });

  it('reads a component on a route, in the default state unless states are given', () => {
    const cfg = parse({ components: [{ name: 'Primary button', route: '/', selector: '.cta' }, { name: 'card', route: '/pricing', selector: '.card', states: ['default', 'hover', 'focus', 'hover'], viewports: ['mobile'] }] });
    assert.deepEqual(cfg.components[0], { name: 'Primary button', slug: 'primary-button', route: '/', selector: '.cta', states: ['default'], viewports: undefined, themes: undefined });
    assert.deepEqual(cfg.components[1].states, ['default', 'hover', 'focus']);
    assert.deepEqual(cfg.components[1].viewports, ['mobile']);
  });

  it('reads a component shown by a flow checkpoint, at the last checkpoint by default, on the flow route and viewports', () => {
    const cfg = parse({ flows: [{ ...MENU, viewports: ['mobile'] }], components: [{ name: 'panel', flow: 'menu', checkpoint: 'after open', selector: '#menu' }, { name: 'burger', flow: 'menu', selector: '#burger' }] });
    const [panel, burger] = cfg.components;
    assert.equal(panel.route, '/');
    assert.deepEqual([panel.flow?.def.name, panel.flow?.checkpoint.name, panel.flow?.checkpoint.step], ['menu', 'after open', 0]);
    assert.deepEqual(panel.viewports, ['mobile']);
    assert.equal(burger.flow?.checkpoint.name, 'closed');
  });

  it('rejects a component without exactly one of route and flow, or with a bad selector or state, through the schema', () => {
    const bad = (c: unknown, flows: unknown[] = [MENU]) => () => parse({ flows, components: [c] });
    assert.throws(bad({ name: 'c', selector: '.c' }), /components\.0\.route: give either route or flow/);
    assert.throws(bad({ name: 'c', route: '/', flow: 'menu', selector: '.c' }), /components\.0\.route: give either route or flow/);
    assert.throws(bad({ name: 'c', route: '/', checkpoint: 'x', selector: '.c' }), /components\.0\.checkpoint: checkpoint needs a flow/);
    assert.throws(bad({ name: 'c', route: '/', selector: '' }), /components\.0\.selector/);
    assert.throws(bad({ name: 'c', route: '/', selector: '.c', states: ['active'] }), /components\.0\.states/);
    assert.throws(bad({ name: 'c', route: '/', selector: '.c', states: [] }), /components\.0\.states/);
    assert.throws(bad({ name: 'c', route: 'home', selector: '.c' }), /components\.0\.route/);
    assert.throws(bad({ name: 'c', route: '/', selector: '.c', extra: 1 }), /components\.0/);
  });

  it('rejects unknown flows, checkpoints, viewports and themes, duplicate names and file name clashes', () => {
    const one = (c: object) => () => parse({ flows: [MENU], components: [{ name: 'c', selector: '.c', ...c }] });
    assert.throws(one({ flow: 'nav' }), /Component "c" references unknown flow "nav"/);
    assert.throws(one({ flow: 'menu', checkpoint: 'open' }), /unknown checkpoint "open" of flow "menu"/);
    assert.throws(one({ route: '/', viewports: ['tablet'] }), /Component "c" references unknown viewport "tablet"/);
    assert.throws(one({ route: '/', themes: ['dark'] }), /Component "c" references unknown theme "dark"/);
    assert.throws(() => parse({ components: [{ name: 'Card', route: '/', selector: '.a' }, { name: 'card', route: '/', selector: '.b' }] }), /Components "Card" and "card" have the same name/);
    assert.throws(() => parse({ components: [{ name: 'card hover', route: '/', selector: '.a' }, { name: 'card', route: '/', selector: '.b', states: ['hover'] }] }), /would share the file name component-card-hover/);
  });

  it('validates the limits', () => {
    assert.equal(parse({ componentLimits: { maxComponents: 0 } }).componentLimits.maxComponents, 0);
    assert.throws(() => parse({ componentLimits: { padding: 100 } }), /componentLimits\.padding/);
  });
});

describe('component selector matches', () => {
  it('needs exactly one element', () => {
    assert.deepEqual([0, 1, 2, 7].map(matchMiss), ['none', undefined, 'many', 'many']);
  });

  it('reports a component found on one side only as removed or added, several matches as not compared, and neither side as a warning', () => {
    const c = { name: 'primary button', state: 'default' };
    const ok = { reached: true, matches: 1, selector: '.cta' };
    const none = { reached: false, miss: 'none' as const, matches: 0, selector: '.cta' };
    assert.deepEqual(componentOutcome(c, ok, ok), {});
    assert.deepEqual(componentOutcome(c, ok, none), { change: 'removed', finding: "component 'primary button' removed on head: nothing matches .cta" });
    assert.deepEqual(componentOutcome(c, none, ok), { change: 'added', finding: "component 'primary button' added on head (nothing matches .cta on base)" });
    assert.deepEqual(componentOutcome(c, ok, { reached: false, miss: 'many', matches: 3, selector: '.cta' }), { change: 'not compared', finding: "component 'primary button' not compared: .cta matches 3 elements on head" });
    assert.deepEqual(componentOutcome(c, ok, { reached: false, miss: 'hidden', matches: 1, selector: '.cta' }), { change: 'removed', finding: "component 'primary button' removed on head: .cta is not visible" });
    assert.deepEqual(componentOutcome({ name: 'card', state: 'focus' }, { reached: false, miss: 'state', matches: 1, selector: '.card', note: 'nothing in it can take keyboard focus' }, ok), { change: 'not compared', finding: "component 'card' · focus not compared: nothing in it can take keyboard focus on base" });
    assert.deepEqual(componentOutcome(c, none, none), { problem: "component 'primary button': nothing matches .cta on base and head; check the component in the config" });
    assert.deepEqual(componentOutcome(c, none, { reached: false, miss: 'many', matches: 2, selector: '.cta' }), { problem: "component 'primary button': nothing matches .cta on base, .cta matches 2 elements on head; check the component in the config" });
  });
});

describe('component crop', () => {
  const pages = { base: { width: 800, height: 1200 }, head: { width: 800, height: 1200 } };
  it('pads the box when the size did not change', () => {
    const box = { x: 100, y: 200, width: 120, height: 40 };
    assert.deepEqual(componentCrop(box, box, 8, pages), { base: { x: 92, y: 192, width: 136, height: 56 }, head: { x: 92, y: 192, width: 136, height: 56 } });
  });

  it('uses the union of both boxes, the same size on both sides, when the size changed', () => {
    assert.deepEqual(componentCrop({ x: 100, y: 200, width: 120, height: 40 }, { x: 100, y: 200, width: 124, height: 44 }, 8, pages), { base: { x: 92, y: 192, width: 140, height: 60 }, head: { x: 92, y: 192, width: 140, height: 60 } });
    assert.deepEqual(componentCrop({ x: 100, y: 200, width: 120, height: 48 }, { x: 100, y: 200, width: 96, height: 52 }, 0, pages).head, { x: 100, y: 200, width: 120, height: 52 });
    assert.deepEqual(componentCrop({ x: 100.4, y: 200.6, width: 119.2, height: 40 }, { x: 100.4, y: 200.6, width: 119.2, height: 40 }, 0, pages).base, { x: 100, y: 200, width: 120, height: 40 });
  });

  it('places each crop at its own root, so a component that only moved crops to the same pixels', () => {
    const crops = componentCrop({ x: 100, y: 200, width: 120, height: 40 }, { x: 100, y: 260, width: 120, height: 40 }, 8, pages);
    assert.deepEqual([crops.base.y, crops.head.y, crops.base.height, crops.head.height], [192, 252, 56, 56]);
  });

  it('clamps to the page by shifting the crop, and shrinks it only for a smaller page', () => {
    const at = (x: number, y: number) => ({ x, y, width: 50, height: 20 });
    assert.deepEqual(componentCrop(at(2, 3), at(2, 3), 8, pages).base, { x: 0, y: 0, width: 66, height: 36 });
    assert.deepEqual(componentCrop(at(750, 1180), at(750, 1180), 8, pages).head, { x: 734, y: 1164, width: 66, height: 36 });
    assert.deepEqual(componentCrop(at(0, 0), at(0, 0), 8, { base: { width: 40, height: 30 }, head: { width: 800, height: 600 } }).base, { x: 0, y: 0, width: 40, height: 30 });
    assert.deepEqual(toDevice({ x: 734, y: 1164, width: 66, height: 36 }, 2, { width: 1600, height: 2400 }), { x: 1468, y: 2328, width: 132, height: 72 });
    assert.deepEqual(toDevice({ x: 734, y: 1164, width: 66, height: 36 }, 2, { width: 1500, height: 2380 }), { x: 1468, y: 2328, width: 32, height: 52 });
  });

  it('says how the root box changed', () => {
    assert.equal(rootChange({ x: 0, y: 0, width: 320, height: 48 }, { x: 0, y: 0, width: 320, height: 52 }), 'size 320×48 → 320×52px');
    assert.equal(rootChange({ x: 10, y: 100, width: 320, height: 48 }, { x: 8, y: 124, width: 324, height: 48 }), 'size 320×48 → 324×48px, moved 2px left, 24px down');
    assert.equal(rootChange({ x: 10, y: 100, width: 320, height: 48 }, { x: 10.2, y: 100, width: 320.3, height: 48 }), undefined);
  });

  it('names component captures apart from flows, states and zoom crops', () => {
    const at = (component?: { name: string; state: string }) => keyId(captureKey({ slug: 'home' }, { name: 'desktop' }, { name: 'light' }, undefined, undefined, component));
    assert.equal(at({ name: 'primary-button', state: 'default' }), 'home__desktop__light__component-primary-button');
    assert.equal(at({ name: 'primary-button', state: 'hover' }), 'home__desktop__light__component-primary-button-hover');
    assert.ok(at({ name: 'x', state: 'focus' }).startsWith(`${at()}__component-`));
  });
});

describe('measured changes scoped to the component', () => {
  const el = (selector: string, parent: number | null, box: StyledElement['box'], padding = '8px', extra: Partial<StyledElement> = {}): StyledElement => ({
    selector,
    name: selector,
    tag: selector.split(/[.#]/)[0] || 'div',
    attrs: { testid: selector },
    box,
    deviceBox: box,
    text: false,
    parent,
    styles: { color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)', borderColor: [], margin: [], padding: [padding, padding, padding, padding], gap: [], radius: [], fontSize: '16px', fontWeight: '400', fontFamily: 'Arial', lineHeight: 'normal' },
    ...extra,
  });
  const map = (cta: string, title: string, ctaBox = { x: 20, y: 60, width: 100, height: 32 }): StyleSnapshot => ({
    elements: [el('main', null, { x: 0, y: 0, width: 400, height: 300 }), el('h1', 0, { x: 20, y: 10, width: 200, height: 30 }, title), el('div.card', 0, { x: 10, y: 50, width: 200, height: 100 }), el('button.cta', 2, ctaBox, cta), el('span.icon', 3, { x: 30, y: 68, width: 16, height: 16 })],
    colors: {},
  });
  const text = (cs: ElementChange[]) => cs.map((c) => `${c.selector}: ${c.changes.map((p) => `${p.property} ${p.before} → ${p.after}`).join(', ')}`);

  it('keeps only the changes of the root and what it contains', () => {
    const [base, head] = [map('8px', '0px'), map('10px', '4px', { x: 20, y: 60, width: 104, height: 36 })];
    const changes = diffElements(base, head, matchElements(base.elements, head.elements));
    assert.deepEqual(text(changes).sort(), ['button.cta: size 100×32px → 104×36px, padding 8px → 10px', 'h1: padding 0px → 4px']);
    assert.deepEqual(text(scopeChanges(changes, base.elements, head.elements, { base: 2, head: 2 })), ['button.cta: size 100×32px → 104×36px, padding 8px → 10px']);
    assert.deepEqual(text(scopeChanges(changes, base.elements, head.elements, { base: 3, head: 3 })), ['button.cta: size 100×32px → 104×36px, padding 8px → 10px']);
    assert.deepEqual(scopeChanges(changes, base.elements, head.elements, { base: 4, head: 4 }), []);
  });

  it('keeps a removed element by its place in the base map', () => {
    const base = map('8px', '0px');
    const head: StyleSnapshot = { elements: base.elements.slice(0, 4), colors: {} };
    const changes = diffElements(base, head, matchElements(base.elements, head.elements));
    assert.deepEqual(scopeChanges(changes, base.elements, head.elements, { base: 2, head: 2 }).map((c) => [c.kind, c.selector]), [['removed', 'span.icon']]);
    assert.ok(insideRoot(base.elements, 4, 2) && !insideRoot(base.elements, 1, 2));
  });

  it('moves the element map into the crop', () => {
    const m = map('8px', '0px');
    shiftSnapshot(m, { x: 2, y: 42 }, 2);
    assert.deepEqual([m.elements[3].box, m.elements[3].deviceBox], [{ x: 18, y: 18, width: 100, height: 32 }, { x: 36, y: 36, width: 200, height: 64 }]);
  });
});

describe('components in the comment, in check and in the verdict', () => {
  const padding: ElementChange = {
    kind: 'changed',
    name: "button 'Get started'",
    selector: 'a.cta',
    base: 3,
    head: 3,
    confidence: 'high',
    reason: 'same link',
    changes: [
      { property: 'size', group: 'box', before: '109.5×40px', after: '113.5×44px', id: 'h3:size', kind: 'effect', cause: 'h3:padding' },
      { property: 'padding', group: 'box', before: '8px', after: '10px', id: 'h3:padding', kind: 'cause' },
    ],
    box: { x: 8, y: 8, width: 113.5, height: 44 },
    deviceBox: { x: 8, y: 8, width: 114, height: 44 },
    magnitude: 6,
    verified: true,
  };
  const result = (extra: Partial<ComponentResult> = {}): ComponentResult => ({
    name: 'primary button',
    state: 'default',
    selector: '.cta',
    route: { path: '/', name: 'home', slug: 'home' },
    viewport: 'desktop',
    theme: 'light',
    matches: { base: 1, head: 1 },
    capture: 'home__desktop__light__component-primary-button',
    base: { ms: 700 },
    head: { ms: 720 },
    ...extra,
  });

  /** sampleReport whose still captures are unchanged (or carry `still`), plus a changed component capture. */
  function withComponent(still: ElementChange[] = []): Report {
    const r = sampleReport({ variants: [], motion: [], a11y: undefined, tokens: undefined });
    const desktop = r.captures[0];
    r.captures[0] = still.length
      ? { ...desktop, styleDiff: { matched: { high: 4, medium: 0, low: 0 }, changes: still, regions: [] } }
      : { ...desktop, status: 'unchanged', diff: { ...desktop.diff!, ratio: 0, changedPixels: 0, regions: [] }, images: { focus: [] } };
    const component: CaptureResult = {
      id: 'home__desktop__light__component-primary-button',
      route: { path: '/', name: 'home', slug: 'home' },
      viewport: 'desktop',
      theme: 'light',
      component: { name: 'primary button', state: 'default', selector: '.cta', crop: { base: { x: 92, y: 192, width: 130, height: 60 }, head: { x: 92, y: 192, width: 130, height: 60 } }, root: { before: { x: 100, y: 200, width: 109.5, height: 40 }, after: { x: 100, y: 200, width: 113.5, height: 44 } }, rootChange: 'size 109.5×40 → 113.5×44px' },
      status: 'changed',
      urls: {},
      diff: { changedPixels: 600, ratio: 0.08, regions: [{ x: 0, y: 0, width: 130, height: 60 }], scale: 1, sizeBefore: [130, 60], sizeAfter: [130, 60], sizeChanged: false, focusBoxes: [{ x: 0, y: 0, width: 130, height: 60 }] },
      images: { compare: 'compare/home__desktop__light__component-primary-button.png', focus: ['compare/home__desktop__light__component-primary-button__focus-1.png'], pairs: ['compare/home__desktop__light__component-primary-button__pair-1.png'] },
      warnings: [],
      truncated: false,
      styleDiff: { matched: { high: 4, medium: 0, low: 0 }, changes: [padding], regions: [] },
    };
    r.captures.push(component);
    r.components = [result()];
    r.stats = computeStats(r.captures);
    return r;
  }
  const render = (r: Report) => renderComment(r, { id: 'default', title: 'UI diff', link: (p) => p });

  it("gives a changed component its own group, with how its root box changed", () => {
    const r = withComponent();
    assert.equal(verdict(r).text, '1 measured change on 1 route');
    const body = render(r);
    assert.match(body, /#### Measured changes\n\n\*\*component 'primary button'\*\* · `\/` · size 109\.5×40 → 113\.5×44px\n\n- `button 'Get started'` \(`a\.cta`\): padding 8px → 10px — desktop\n {2}- size 109\.5×40px → 113\.5×44px \(from the padding change\)\n/);
    assert.match(body, /\*\*`\/`\*\* · desktop · component 'primary button' — 8\.00% of pixels changed · 1 area\n\n<img src="compare\/home__desktop__light__component-primary-button__pair-1\.png"/);
    const check = checkSummary(r, '/o');
    assert.equal(check.exitCode, 1);
    assert.match(check.text, /\nMeasured changes in component 'primary button' on \/ · size 109\.5×40 → 113\.5×44px\n {2}- button 'Get started' \(a\.cta\): padding 8px → 10px — desktop\n/);
    assert.deepEqual(measuredGroups(r).map((g) => [g.component, g.kind, g.property]), [
      [{ name: 'primary button', state: 'default' }, 'cause', 'padding'],
      [{ name: 'primary button', state: 'default' }, 'effect', 'size'],
    ]);
    assert.match(autoSummary(r), /`\/` changed on desktop \(component 'primary button'\)/);
  });

  it('counts a change once when the route lists it too, and says so under the component', () => {
    const r = withComponent([padding]);
    assert.equal(verdict(r).text, '1 measured change on 1 route');
    const body = render(r);
    assert.equal(body.match(/: padding 8px → 10px — desktop/g)?.length, 2);
    assert.match(body, /<sub>All also listed under `\/`, counted once\.<\/sub>/);
    assert.match(checkSummary(r, '/o').text, /padding 8px → 10px — desktop \(also under \/\)/);
  });

  it('reports a component removed on head as a change, with a crop of base, and one missing on both sides as a warning only', () => {
    const r = withComponent();
    r.captures.pop();
    r.stats = computeStats(r.captures);
    const finding = "component 'primary button' removed on head: nothing matches .cta";
    r.components = [result({ capture: undefined, matches: { base: 1, head: 0 }, change: 'removed', finding, image: 'compare/home__desktop__light__component-primary-button.png' })];
    assert.deepEqual([verdict(r).kind, verdict(r).text], ['visual changes', '1 component removed']);
    assert.match(render(r), /#### Components\n\n- component 'primary button' removed on head: nothing matches \.cta — desktop\n\n<img src="compare\/home__desktop__light__component-primary-button\.png"/);
    const check = checkSummary(r, '/o');
    assert.equal(check.exitCode, 1);
    assert.match(check.text, /\nComponents\n {2}- component 'primary button' removed on head: nothing matches \.cta — desktop\n {4}\/o\/compare\/home__desktop__light__component-primary-button\.png\n/);
    assert.doesNotMatch(autoSummary(r), /No visual changes/);

    r.components = [result({ capture: undefined, matches: { base: 0, head: 0 }, problem: "component 'primary button': nothing matches .cta on base and head; check the component in the config" })];
    r.warnings = ["component 'primary button': nothing matches .cta on base and head; check the component in the config (desktop)"];
    assert.equal(verdict(r).text, 'No visual changes');
    assert.doesNotMatch(render(r), /#### Components/);
  });

  it('puts components on the timing line', () => {
    assert.match(timingLine({ totalMs: 20000, detectMs: 10, extras: { componentsMs: 4200 } }), /components 4\.2s/);
  });
});
