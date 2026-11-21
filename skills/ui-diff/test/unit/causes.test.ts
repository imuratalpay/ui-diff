import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkSummary } from '../../src/check.js';
import { diffElements, matchElements, type ElementChange } from '../../src/elements.js';
import { renderComment } from '../../src/markdown.js';
import { computeStats, type Report } from '../../src/report.js';
import type { StyledElement, StyleSnapshot } from '../../src/tokens.js';
import { measuredGroups, verdict } from '../../src/verdict.js';
import { sampleReport } from './fixtures.js';

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
      borderColors: Array(4).fill('rgb(17, 24, 39)'),
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

/**
 * A centered hero row as in the CI run: the button grows by its padding, its row and the hero grow
 * with it, it moves up and left in the centered row, and the link beside it and the section below move.
 */
function hero(o: { padding: string; background: string; width: number; height: number; text?: string }): StyledElement[] {
  const grow = o.height - 40;
  const [pv, ph] = o.padding.split(' ');
  return [
    el({ tag: 'main', box: { x: 0, y: 0, width: 1000, height: 700 + grow } }),
    el({ tag: 'header', selector: 'header.hero', parent: 0, box: { x: 0, y: 0, width: 1000, height: 240 + grow } }),
    el({ tag: 'div', selector: 'div.actions', parent: 1, box: { x: 0, y: 160, width: 1000, height: o.height }, styles: { display: 'flex', justifyContent: 'center', alignItems: 'center', gap: ['16px', '16px'] } }),
    el({ tag: 'a', selector: 'a.cta', name: "link 'Start free trial'", ownText: o.text ?? 'Start free trial', label: o.text ?? 'Start free trial', role: 'link', parent: 2, box: { x: 400 - (o.width - 109.5) / 2, y: 160, width: o.width, height: o.height }, styles: { padding: [pv, ph, pv, ph], backgroundColor: o.background, color: 'rgb(255, 255, 255)' } }),
    el({ tag: 'a', selector: 'a.more', name: "link 'See how it works'", ownText: 'See how it works', label: 'See how it works', role: 'link', parent: 2, box: { x: 525.5 + (o.width - 109.5) / 2, y: 160 + (o.height - 24) / 2, width: 130, height: 24 } }),
    el({ tag: 'section', selector: 'section.plans', ownText: 'Plans', parent: 0, box: { x: 0, y: 240 + grow, width: 1000, height: 460 } }),
  ];
}

const BEFORE = { padding: '8px 14px', background: 'rgb(37, 99, 235)', width: 109.5, height: 40 };

function report(base: StyledElement[], head: StyledElement[]): { report: Report; changes: ElementChange[] } {
  const changes = diffElements({ elements: base, colors: {} } as StyleSnapshot, { elements: head, colors: {} } as StyleSnapshot, matchElements(base, head));
  for (const c of changes) if (c.changes.some((p) => p.kind !== 'effect') || c.kind !== 'changed') c.verified = true;
  const r = sampleReport();
  r.captures = [{ ...r.captures[0], styleDiff: { matched: { high: 6, medium: 0, low: 0 }, changes, regions: [] } }];
  r.stats = computeStats(r.captures);
  return { report: r, changes };
}

const kinds = (changes: ElementChange[]) => changes.flatMap((c) => c.changes.map((p) => `${c.selector} ${p.property} ${p.kind}${p.cause ? ` ← ${p.cause}` : ''}`));

describe('causes and effects', () => {
  it('counts the CI case (padding and background) as 2 changes, not 5', () => {
    const { report: r, changes } = report(hero(BEFORE), hero({ padding: '12px 18px', background: 'rgb(11, 122, 91)', width: 117.5, height: 48 }));
    assert.equal(verdict(r).text, '2 measured changes on 1 route');
    assert.deepEqual(kinds(changes).filter((k) => k.startsWith('a.cta')), ['a.cta size effect ← h3:padding', 'a.cta padding cause', 'a.cta background cause', 'a.cta position effect ← h3:padding']);
    const body = renderComment(r, { id: 'default', title: 'UI diff', link: (p) => p });
    assert.match(body, /- `link 'Start free trial'` \(`a\.cta`\): padding 8px 14px → 12px 18px — desktop\n {2}- size 109\.5×40px → 117\.5×48px, moved 4px left \(from the padding change\)\n/);
    assert.match(body, / {2}<details><summary>5 effects on other elements<\/summary>\n\n {2}- `main`: size 1000×700px → 1000×708px\n {2}- `header\.hero`: size 1000×240px → 1000×248px\n/);
    assert.match(body, /- `link 'Start free trial'` \(`a\.cta`\): background #2563eb → #0b7a5b — desktop\n/);
    assert.match(checkSummary(r, '/o').text, /\n {2}- link 'Start free trial' \(a\.cta\): padding 8px 14px → 12px 18px — desktop\n {6}size 109\.5×40px → 117\.5×48px, moved 4px left \(from the padding change\)\n {6}main: size 1000×700px → 1000×708px\n/);
  });

  it('gives a padding-only change 1, with its size and move as effects', () => {
    const { report: r, changes } = report(hero(BEFORE), hero({ ...BEFORE, padding: '12px 18px', width: 117.5, height: 48 }));
    assert.equal(verdict(r).text, '1 measured change on 1 route');
    assert.deepEqual(changes.flatMap((c) => c.changes).filter((p) => p.kind !== 'effect').map((p) => p.id), ['h3:padding']);
    assert.ok(changes.flatMap((c) => c.changes).filter((p) => p.kind === 'effect').every((p) => p.cause === 'h3:padding'));
  });

  it('keeps counting a size change that only a text change explains', () => {
    const { report: r, changes } = report(hero(BEFORE), hero({ ...BEFORE, text: 'Start your free trial', width: 151.5 }));
    assert.deepEqual(kinds(changes).filter((k) => k.startsWith('a.cta')), ['a.cta size unexplained', 'a.cta text cause', 'a.cta position effect ← h3:size']);
    assert.equal(verdict(r).text, '2 measured changes on 1 route', 'the text and the size it caused, both counted');
  });

  it('counts a parent that grew from a child padding change as an effect of it', () => {
    const { changes } = report(hero(BEFORE), hero({ ...BEFORE, padding: '12px 18px', width: 117.5, height: 48 }));
    assert.deepEqual(kinds(changes).filter((k) => /^(div\.actions|header\.hero|main) /.test(k)), ['main size effect ← h3:padding', 'header.hero size effect ← h3:padding', 'div.actions size effect ← h3:padding']);
  });

  it('keeps every change in report.json with its kind and, for effects, the row of the cause', () => {
    const { report: r } = report(hero(BEFORE), hero({ padding: '12px 18px', background: 'rgb(11, 122, 91)', width: 117.5, height: 48 }));
    const groups = measuredGroups(r);
    const padding = groups.find((g) => g.property === 'padding')!;
    assert.equal(padding.kind, 'cause');
    const effects = groups.filter((g) => g.kind === 'effect');
    assert.ok(effects.length >= 6 && effects.every((g) => g.cause === padding.id), JSON.stringify(effects.map((g) => [g.selector, g.property, g.cause])));
    assert.deepEqual(effects.find((g) => g.selector === 'a.cta' && g.property === 'size')!.variants.map((v) => [v.change, v.cause]), [['h3:size', 'h3:padding']]);
    assert.deepEqual(groups.filter((g) => g.kind !== 'effect').map((g) => g.property), ['padding', 'background']);
  });

  it('counts an effect whose cause cannot be found, instead of hiding it', () => {
    const { report: r, changes } = report(hero(BEFORE), hero({ ...BEFORE, padding: '12px 18px', width: 117.5, height: 48 }));
    const cta = changes.find((c) => c.selector === 'a.cta')!;
    cta.changes = cta.changes.filter((p) => p.property !== 'padding');
    assert.equal(verdict(r).text, '7 measured changes on 1 route', 'every size and move it would have explained counts on its own');
  });
});
