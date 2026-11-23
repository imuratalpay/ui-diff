import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseConfig } from '../../src/config.js';

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
