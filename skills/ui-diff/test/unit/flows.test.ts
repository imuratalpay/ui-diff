import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Page } from 'playwright';
import { parseConfig, type FlowStep } from '../../src/config.js';
import { describeFlowStep, flowOutcome, runFlow, stopReason, type FlowStop } from '../../src/flows.js';
import { captureKey, keyId } from '../../src/key.js';

const parse = (raw: unknown) => parseConfig(raw, { repoRoot: '/repo' });

/**
 * A page with elements by selector. An element can fail its action (a timeout or another error),
 * and clicking one can add others (a menu that opens).
 */
function fakePage(elements: Record<string, { name?: string; fails?: 'timeout' | 'error'; opens?: string[] }>) {
  const dom = new Map(Object.entries(elements));
  const calls: string[] = [];
  const locator = (selector: string) => {
    const el = () => dom.get(selector);
    const action = (verb: string) => async (...args: unknown[]) => {
      const target = el();
      if (!target) throw new Error(`locator.${verb}: Timeout 100ms exceeded.`);
      if (target.fails === 'timeout') throw new Error(`locator.${verb}: Timeout 100ms exceeded.\nCall log:\n  - waiting for element to be visible`);
      if (target.fails === 'error') throw new Error(`locator.${verb}: Error: Element is not a <select> element\nCall log: …`);
      calls.push([verb, selector, ...args.filter((a) => typeof a === 'string')].join(' '));
      if (verb === 'click') for (const s of target.opens ?? []) dom.set(s, { name: `region '${s}'` });
    };
    const self = {
      count: async () => (el() ? 1 : 0),
      first: () => self,
      waitFor: async (o: { state: string }) => {
        if (!el()) throw new Error('locator.waitFor: Timeout 100ms exceeded.');
        if (o.state === 'visible') await action('waitFor')();
      },
      evaluate: async () => el()?.name ?? null,
      click: action('click'),
      hover: action('hover'),
      focus: action('focus'),
      fill: action('fill'),
      selectOption: action('selectOption'),
      scrollIntoViewIfNeeded: action('scrollIntoView'),
    };
    return self;
  };
  const page = {
    locator,
    keyboard: { press: async (key: string) => void calls.push(`press ${key}`) },
    evaluate: async (_fn: unknown, top: number) => void calls.push(`scrollTo ${top}`),
    waitForTimeout: async (ms: number) => void calls.push(`wait ${ms}`),
  };
  return { page: page as unknown as Page, calls };
}

async function replay(elements: Parameters<typeof fakePage>[0], steps: FlowStep[]) {
  const { page, calls } = fakePage(elements);
  const checkpoints: Array<[string, number]> = [];
  const result = await runFlow(page, steps, { timeoutMs: 100, onCheckpoint: async (name, step) => void checkpoints.push([name, step]) });
  return { ...result, calls, checkpoints };
}

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

describe('flow step runner', () => {
  it('runs the steps in order and captures after each checkpoint step', async () => {
    const r = await replay({ '#burger': { name: "button 'Menu'", opens: ['#menu'] }, '#email': { name: "textbox 'Email'" }, '#plan': {}, '.footer': {} }, [
      { checkpoint: 'closed' },
      { click: '#burger' },
      { wait: '#menu', checkpoint: 'after open' },
      { press: 'Escape' },
      { type: '#email', text: 'ada@example.com' },
      { select: '#plan', value: 'yearly' },
      { scroll: 300 },
      { scroll: '.footer' },
      { wait: 50, checkpoint: 'done' },
    ]);
    assert.equal(r.stoppedAt, undefined);
    assert.deepEqual(r.calls, ['click #burger', 'waitFor #menu', 'press Escape', 'fill #email ada@example.com', 'selectOption #plan yearly', 'scrollTo 300', 'scrollIntoView .footer', 'wait 50']);
    assert.deepEqual(r.checkpoints, [
      ['closed', 0],
      ['after open', 2],
      ['done', 8],
    ]);
    assert.deepEqual(r.names, [null, "button 'Menu'", "region '#menu'", null, "textbox 'Email'", null, null, null, null]);
  });

  it('stops at the first step whose element never appears, and captures nothing after it', async () => {
    const r = await replay({ '#email': { name: "textbox 'Email'" } }, [{ type: '#email', text: 'a', checkpoint: 'filled' }, { click: 'button.pay' }, { wait: '.thanks', checkpoint: 'paid' }]);
    assert.deepEqual(r.stoppedAt, { step: 2, action: 'click button.pay', verb: 'click', selector: 'button.pay', kind: 'missing', timeoutMs: 100 });
    assert.deepEqual(r.checkpoints, [['filled', 0]]);
    assert.deepEqual(r.calls, ['fill #email a']);
  });

  it('tells an action that ran out of time from one that failed', async () => {
    const timeout = await replay({ 'button.pay': { name: "button 'Pay'", fails: 'timeout' } }, [{ click: 'button.pay' }]);
    assert.deepEqual([timeout.stoppedAt?.kind, timeout.stoppedAt?.step, timeout.names[0]], ['timeout', 1, "button 'Pay'"]);
    const failed = await replay({ '#plan': { fails: 'error' } }, [{ hover: '#plan' }, { select: '#plan', value: 'x' }]);
    assert.equal(failed.stoppedAt?.kind, 'error');
    assert.equal(failed.stoppedAt?.step, 1);
    assert.equal(failed.stoppedAt?.message, 'locator.hover: Error: Element is not a <select> element');
    const hidden = await replay({ '#menu': { fails: 'timeout' } }, [{ wait: '#menu' }]);
    assert.equal(stopReason(hidden.stoppedAt!), '#menu did not appear within 0.1s');
  });

  it('describes each step in plain words', () => {
    const steps: FlowStep[] = [{ click: 'a.pricing' }, { hover: '.card' }, { focus: '#q' }, { type: '#q', text: 'shoes' }, { press: 'Enter' }, { select: '#size', value: 'M' }, { scroll: 400 }, { scroll: '.faq' }, { wait: 300 }, { wait: '.results' }, { checkpoint: 'start' }];
    assert.deepEqual(steps.map(describeFlowStep), ['click a.pricing', 'hover .card', 'focus #q', 'type "shoes" into #q', 'press Enter', 'select "M" in #size', 'scroll to 400px', 'scroll to .faq', 'wait 300ms', 'wait for .results', "checkpoint 'start'"]);
  });
});

describe('broken flows', () => {
  const stop = (step: number, extra: Partial<FlowStop> = {}): FlowStop => ({ step, action: 'click button.pay', verb: 'click', selector: 'button.pay', kind: 'missing', timeoutMs: 5000, ...extra });
  const names = [null, null, "button 'Pay'"];

  it('reports a flow that stops on one side only as a finding, naming the element from the side that found it', () => {
    assert.deepEqual(flowOutcome('checkout', { names }, { names: [null, null, null], stoppedAt: stop(3) }), { finding: "flow 'checkout' stops at step 3 on head: button 'Pay' not found" });
    assert.deepEqual(flowOutcome('checkout', { names: [null, null, null], stoppedAt: stop(3) }, { names }), { finding: "flow 'checkout' stops at step 3 on base: button 'Pay' not found" });
    assert.deepEqual(flowOutcome('checkout', { names: [null, null, null] }, { names: [null, null, null], stoppedAt: stop(3) }), { finding: "flow 'checkout' stops at step 3 on head: nothing matches button.pay" });
    assert.deepEqual(flowOutcome('checkout', { names }, { names, stoppedAt: stop(3, { kind: 'timeout' }) }), { finding: "flow 'checkout' stops at step 3 on head: could not click button 'Pay' within 5s" });
  });

  it('reports a flow that stops at the same step on both sides as a config problem', () => {
    assert.deepEqual(flowOutcome('checkout', { names: [], stoppedAt: stop(3) }, { names: [], stoppedAt: stop(3) }), { problem: "flow 'checkout' stops at step 3 on base and head: nothing matches button.pay; check the flow in the config" });
  });

  it('reports the side that stops first when both stop', () => {
    assert.deepEqual(flowOutcome('checkout', { names, stoppedAt: stop(5) }, { names: [], stoppedAt: stop(3) }), { finding: "flow 'checkout' stops at step 3 on head: button 'Pay' not found (base stops later, at step 5)" });
  });

  it('reports nothing when both sides finish', () => {
    assert.deepEqual(flowOutcome('checkout', { names }, { names }), {});
  });
});

describe('flow checkpoint naming', () => {
  it('names a checkpoint capture after its capture, flow and checkpoint, apart from state, zoom and variant images', () => {
    const [flow] = parse({ flows: [{ name: 'Menu', route: '/', steps: [{ click: '#burger', checkpoint: 'after open' }] }] }).flows;
    const key = captureKey({ slug: 'home' }, { name: 'desktop' }, { name: 'light' }, undefined, { name: flow.slug, checkpoint: flow.checkpoints[0].slug });
    const id = keyId(key);
    assert.equal(id, 'home__desktop__light__flow-menu-after-open');
    const capture = keyId(captureKey({ slug: 'home' }, { name: 'desktop' }, { name: 'light' }));
    const others = [`${capture}`, `${capture}__focus-1`, `${capture}__pair-1`, `${capture}__blink-1`, `${capture}__hover-1`, `${capture}__focus-1`, keyId(captureKey({ slug: 'home' }, { name: 'desktop' }, { name: 'light' }, { param: 'hero', value: '2' }))];
    assert.ok(!others.includes(id));
    assert.ok(id.startsWith(`${capture}__flow-`));
  });
});
