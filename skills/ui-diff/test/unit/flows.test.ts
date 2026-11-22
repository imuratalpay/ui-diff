import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseConfig } from '../../src/config.js';

const parse = (raw: unknown) => parseConfig(raw, { repoRoot: '/repo' });

describe('flow config', () => {
  it('has no flows by default, and caps at 5 flows of 15 steps', () => {
    const cfg = parse({});
    assert.deepEqual(cfg.flows, []);
    assert.deepEqual(cfg.flowLimits, { maxFlows: 5, maxSteps: 15, stepTimeoutMs: 5000 });
  });

  it('reads every kind of step, with named checkpoints', () => {
    const cfg = parse({
      flows: [
        {
          name: 'checkout',
          route: '/cart',
          steps: [
            { checkpoint: 'start' },
            { hover: '.summary' },
            { focus: '#email' },
            { type: '#email', text: 'ada@example.com' },
            { select: '#plan', value: 'yearly' },
            { press: 'Tab' },
            { scroll: 400 },
            { scroll: '.pay' },
            { wait: 200 },
            { wait: '.pay:not([disabled])' },
            { click: 'button.pay', checkpoint: 'after pay' },
          ],
        },
      ],
    });
    const [flow] = cfg.flows;
    assert.equal(flow.slug, 'checkout');
    assert.equal(flow.steps.length, 11);
    assert.deepEqual(flow.checkpoints, [
      { name: 'start', slug: 'start', step: 0 },
      { name: 'after pay', slug: 'after-pay', step: 10 },
    ]);
  });

  it('names the last step "end" when no checkpoint is named', () => {
    const [flow] = parse({ flows: [{ name: 'Mobile menu', route: '/', viewports: ['mobile'], steps: [{ click: '#burger' }, { wait: '#menu' }] }] }).flows;
    assert.equal(flow.slug, 'mobile-menu');
    assert.deepEqual(flow.checkpoints, [{ name: 'end', slug: 'end', step: 1 }]);
    assert.deepEqual(flow.steps[1], { wait: '#menu', checkpoint: 'end' });
    assert.deepEqual(flow.viewports, ['mobile']);
  });

  it('rejects malformed steps through the schema, with the path of the step', () => {
    const bad = (step: unknown) => () => parse({ flows: [{ name: 'f', route: '/', steps: [{ click: 'a' }, step] }] });
    for (const step of [{ type: '#email' }, { click: 'a', text: 'x' }, { tap: 'a' }, { select: '#plan' }, { wait: 20000 }, { click: '' }, { click: 'a', checkpoint: '!' }]) {
      assert.throws(bad(step), /flows\.0\.steps\.1/, JSON.stringify(step));
    }
    assert.throws(bad({ tap: 'a' }), /a step is one of click, hover, focus, type \(with text\), press, select \(with value\), scroll, wait or checkpoint/);
    assert.throws(() => parse({ flows: [{ name: 'f', route: '/', steps: [] }] }), /flows\.0\.steps/);
    assert.throws(() => parse({ flows: [{ name: 'f', route: 'cart', steps: [{ click: 'a' }] }] }), /flows\.0\.route/);
    assert.throws(() => parse({ flows: [{ name: 'f', route: '/', steps: [{ click: 'a' }], extra: 1 }] }), /flows\.0/);
  });

  it('rejects duplicate names, file name clashes and unknown viewports or themes', () => {
    const flow = (name: string, steps: unknown[], extra = {}) => ({ name, route: '/', steps, ...extra });
    assert.throws(() => parse({ flows: [flow('Menu', [{ click: 'a' }]), flow('menu', [{ click: 'b' }])] }), /Flows "Menu" and "menu" have the same name/);
    assert.throws(() => parse({ flows: [flow('f', [{ click: 'a', checkpoint: 'Open' }, { click: 'b', checkpoint: 'open' }])] }), /two checkpoints named like "open" \(steps 1 and 2\)/);
    assert.throws(() => parse({ flows: [flow('a-b', [{ click: 'a', checkpoint: 'c' }]), flow('a', [{ click: 'a', checkpoint: 'b-c' }])] }), /would share the file name flow-a-b-c/);
    assert.throws(() => parse({ flows: [flow('f', [{ click: 'a' }], { viewports: ['tablet'] })] }), /Flow "f" references unknown viewport "tablet"/);
    assert.throws(() => parse({ flows: [flow('f', [{ click: 'a' }], { themes: ['dark'] })] }), /Flow "f" references unknown theme "dark"/);
  });

  it('validates the limits', () => {
    assert.equal(parse({ flowLimits: { maxFlows: 0 } }).flowLimits.maxFlows, 0);
    assert.throws(() => parse({ flowLimits: { maxSteps: 0 } }), /flowLimits\.maxSteps/);
    assert.throws(() => parse({ flowLimits: { stepTimeoutMs: 50 } }), /flowLimits\.stepTimeoutMs/);
  });
});
