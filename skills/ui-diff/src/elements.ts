import type { Box } from './image.js';
import { colorDistance, parseCssColor, toHex, type RGBAValue, type StyledElement, type StyleSnapshot } from './tokens.js';

export type MatchConfidence = 'high' | 'medium' | 'low';

/** A base element and the head element it is taken to be, with how sure the match is and why. */
export interface ElementPair {
  base: number;
  head: number;
  confidence: MatchConfidence;
  reason: string;
}

/** Every element of both maps ends up in exactly one of these. */
export interface ElementMatch {
  pairs: ElementPair[];
  /** Head elements with no base counterpart. */
  added: number[];
  /** Base elements with no head counterpart. */
  removed: number[];
}

/** Roles whose accessible name identifies an element (a "generic" div's text does not). */
const NAMED_ROLES = new Set(['button', 'link', 'heading', 'img', 'textbox', 'checkbox', 'radio', 'combobox', 'slider', 'tab', 'menuitem', 'option', 'switch', 'dialog', 'navigation', 'region']);

function roleOf(e: StyledElement): string {
  return e.tag && /^h[1-6]$/.test(e.tag) ? 'heading' : (e.role ?? e.tag ?? '');
}

/** Tag plus the last selector step without its position: "li.item", "a.cta". */
function signature(e: StyledElement): string {
  const last = e.selector.split(/\s+>>?\s+/).pop() ?? e.selector;
  return `${e.tag ?? ''}|${last.replace(/:nth-of-type\(\d+\)/g, '')}`;
}

function quote(text: string): string {
  return `"${text.length > 40 ? `${text.slice(0, 39)}…` : text}"`;
}

/**
 * Pairs the elements of two element maps. Strongest evidence first: stable attributes
 * (data-testid, id, aria-label, role and accessible name; high confidence), then own text,
 * then structure (the same kind of child under an already matched parent, the same selector;
 * medium), then position (the same tag at about the same place; low). A key only pairs when it is
 * unique on both sides, so duplicates never guess.
 */
export function matchElements(base: StyledElement[], head: StyledElement[]): ElementMatch {
  const pairs: ElementPair[] = [];
  const baseTaken = new Int32Array(base.length).fill(-1);
  const headTaken = new Int32Array(head.length).fill(-1);
  const pair = (b: number, h: number, confidence: MatchConfidence, reason: string) => {
    baseTaken[b] = h;
    headTaken[h] = b;
    pairs.push({ base: b, head: h, confidence, reason });
  };

  const byUniqueKey = (key: (e: StyledElement) => string | undefined, confidence: MatchConfidence, reason: (e: StyledElement) => string) => {
    const index = (list: StyledElement[], taken: Int32Array) => {
      const map = new Map<string, number[]>();
      list.forEach((e, i) => {
        if (taken[i] >= 0) return;
        const k = key(e);
        if (k !== undefined) map.set(k, [...(map.get(k) ?? []), i]);
      });
      return map;
    };
    const b = index(base, baseTaken);
    const h = index(head, headTaken);
    for (const [k, bs] of b) {
      const hs = h.get(k);
      if (bs.length === 1 && hs?.length === 1) pair(bs[0], hs[0], confidence, reason(base[bs[0]]));
    }
  };

  byUniqueKey((e) => e.attrs?.testid, 'high', (e) => `same data-testid ${quote(e.attrs!.testid!)}`);
  byUniqueKey((e) => e.attrs?.id, 'high', (e) => `same id ${quote(e.attrs!.id!)}`);
  byUniqueKey((e) => (e.attrs?.ariaLabel ? `${roleOf(e)}|${e.attrs.ariaLabel}` : undefined), 'high', (e) => `same aria-label ${quote(e.attrs!.ariaLabel!)}`);
  byUniqueKey((e) => (e.label && NAMED_ROLES.has(roleOf(e)) ? `${roleOf(e)}|${e.label}` : undefined), 'high', (e) => `same ${roleOf(e)} named ${quote(e.label!)}`);
  byUniqueKey((e) => (e.ownText ? `${e.tag}|${e.ownText}` : undefined), 'medium', (e) => `same text ${quote(e.ownText!)}`);

  // Children of matched parents, kind by kind, when both sides have as many of that kind.
  for (let k = 0; k < pairs.length; k++) {
    const { base: pb, head: ph } = pairs[k];
    const kids = (list: StyledElement[], parent: number, taken: Int32Array) => {
      const groups = new Map<string, number[]>();
      list.forEach((e, i) => {
        if (e.parent === parent && taken[i] < 0) groups.set(signature(e), [...(groups.get(signature(e)) ?? []), i]);
      });
      return groups;
    };
    const hk = kids(head, ph, headTaken);
    for (const [sig, bs] of kids(base, pb, baseTaken)) {
      const hs = hk.get(sig);
      if (!hs || hs.length !== bs.length) continue;
      bs.forEach((b, i) => pair(b, hs[i], 'medium', `same place under ${base[pb].name ?? base[pb].selector}`));
    }
  }

  byUniqueKey((e) => e.selector, 'medium', () => 'same selector');

  // Position: the same tag whose box is about where it was and about as big.
  const near = (a: StyledElement, b: StyledElement) => {
    const ca = [a.box.x + a.box.width / 2, a.box.y + a.box.height / 2];
    const cb = [b.box.x + b.box.width / 2, b.box.y + b.box.height / 2];
    const distance = Math.hypot(ca[0] - cb[0], ca[1] - cb[1]);
    const ratio = (a.box.width * a.box.height) / Math.max(1, b.box.width * b.box.height);
    return { ok: distance <= Math.max(16, Math.min(a.box.width, a.box.height) / 2) && ratio >= 0.5 && ratio <= 2, distance };
  };
  const leftBase = base.map((_, i) => i).filter((i) => baseTaken[i] < 0);
  const leftHead = head.map((_, i) => i).filter((i) => headTaken[i] < 0);
  if (leftBase.length * leftHead.length <= 250_000) {
    const candidates: Array<[number, number, number]> = [];
    for (const b of leftBase) {
      for (const h of leftHead) {
        if (base[b].tag !== head[h].tag) continue;
        const { ok, distance } = near(base[b], head[h]);
        if (ok) candidates.push([distance, b, h]);
      }
    }
    candidates.sort((x, y) => x[0] - y[0]);
    for (const [, b, h] of candidates) if (baseTaken[b] < 0 && headTaken[h] < 0) pair(b, h, 'low', 'same tag at about the same place');
  }

  return {
    pairs: pairs.sort((a, b) => a.head - b.head),
    added: head.map((_, i) => i).filter((i) => headTaken[i] < 0),
    removed: base.map((_, i) => i).filter((i) => baseTaken[i] < 0),
  };
}

export type ChangeGroup = 'box' | 'type' | 'color' | 'shape' | 'layout' | 'content';

/** One measured difference of a matched element: "padding 8px 14px → 10px 18px" (position: before is empty, after says how it moved). */
export interface PropertyChange {
  property: string;
  group: ChangeGroup;
  before: string;
  after: string;
}

/** What happened to one element between base and head. */
export interface ElementChange {
  kind: 'changed' | 'added' | 'removed';
  name: string;
  selector: string;
  /** Indices in the base and head element maps. */
  base?: number;
  head?: number;
  confidence?: MatchConfidence;
  reason?: string;
  changes: PropertyChange[];
  /** Head box (base box for removed elements), CSS and device px. */
  box: Box;
  deviceBox?: Box;
  /** For added and removed elements: how many elements inside it were added or removed with it. */
  inside?: number;
  /** For sorting, biggest first; no unit. */
  magnitude: number;
}

/** Inherited properties: a change on an element repeats on every descendant that inherits it. */
const INHERITED = new Set(['color', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing']);

const PX = /(-?\d*\.?\d+)px/g;

function nums(value: string): number[] {
  return [...value.matchAll(PX)].map((m) => Number(m[1]));
}

function halfPx(n: number): string {
  const r = Math.round(n * 2) / 2;
  return `${Object.is(r, -0) ? 0 : r}px`;
}

/** Values compare equal when every px number differs by less than a quarter pixel and the rest is the same text. */
function samePx(a: string, b: string): boolean {
  if (a === b) return true;
  const [na, nb] = [nums(a), nums(b)];
  if (na.length !== nb.length || a.replace(PX, '#') !== b.replace(PX, '#')) return false;
  return na.every((n, i) => Math.abs(n - nb[i]) < 0.25);
}

/** rgb()/rgba() inside compound values (shadows, gradients) as hex; px rounded to 0.5 for display. */
function tidy(value: string, round = true): string {
  const colored = value.replace(/rgba?\([^)]*\)/g, (c) => {
    const rgba = parseCssColor(c);
    return rgba ? (rgba[3] === 0 ? 'transparent' : toHex(rgba)) : c;
  });
  return round ? colored.replace(PX, (_, n: string) => halfPx(Number(n))) : colored;
}

/** A compared value: `value` for display, `exact` (unrounded) for the comparison. */
interface Measure {
  value: string;
  exact: string;
}

function one(value: string | undefined): Measure | undefined {
  return value === undefined ? undefined : { value: tidy(value), exact: tidy(value, false) };
}

/** Four sides (top, right, bottom, left) shown like the CSS shorthand, compared side by side. */
function sides(values: string[] | undefined): Measure | undefined {
  if (!values || values.length === 0) return undefined;
  const v = values.map((x) => tidy(x));
  const exact = values.map((x) => tidy(x, false)).join(' ');
  if (v.length === 2) return { value: v[0] === v[1] ? v[0] : `${v[0]} ${v[1]}`, exact };
  const [t, r, b, l] = v;
  const value = t === r && r === b && b === l ? t : t === b && r === l ? `${t} ${r}` : r === l ? `${t} ${r} ${b}` : `${t} ${r} ${b} ${l}`;
  return { value, exact };
}

function colorOf(value: string | undefined, colors: StyleSnapshot['colors']): string | undefined {
  if (value === undefined) return undefined;
  const rgba = colors[value] ?? parseCssColor(value);
  if (!rgba) return value;
  return rgba[3] === 0 ? 'transparent' : toHex(rgba);
}

function family(value: string): string {
  return value
    .split(',')
    .map((f) => f.trim().replace(/^["']|["']$/g, ''))
    .join(', ');
}

/** The compared properties of one element, normalized; absent when the snapshot predates them. */
function measured(e: StyledElement, colors: StyleSnapshot['colors']): Array<[string, ChangeGroup, Measure | undefined]> {
  const s = e.styles;
  const text = (value: string | undefined): Measure | undefined => (value === undefined ? undefined : { value, exact: value });
  // A border color without a border (width 0) is only the text color again.
  const bordered = !s.borderWidth || s.borderWidth.some((w) => parseFloat(w) > 0);
  const borderColors = bordered ? s.borderColors?.map((c) => colorOf(c, colors)!) : undefined;
  return [
    ['padding', 'box', sides(s.padding)],
    ['margin', 'box', e.autoMarginX ? sides([s.margin[0], 'auto', s.margin[2], 'auto']) : sides(s.margin)],
    ['gap', 'box', sides(s.gap)],
    ['font-family', 'type', text(family(s.fontFamily))],
    ['font-size', 'type', one(s.fontSize)],
    ['font-weight', 'type', text(s.fontWeight)],
    ['line-height', 'type', one(s.lineHeight)],
    ['letter-spacing', 'type', one(s.letterSpacing)],
    ['color', 'color', text(colorOf(s.color, colors))],
    ['background', 'color', text(colorOf(s.backgroundColor, colors))],
    ['background-image', 'color', one(s.backgroundImage)],
    ['border-color', 'color', borderColors && (new Set(borderColors).size === 1 ? text(borderColors[0]) : sides(borderColors))],
    ['opacity', 'color', text(s.opacity && String(Math.round(Number(s.opacity) * 100) / 100))],
    ['border-width', 'shape', sides(s.borderWidth)],
    ['border-radius', 'shape', sides(s.radius)],
    ['box-shadow', 'shape', one(s.boxShadow)],
    ['display', 'layout', text(s.display)],
    ['flex-direction', 'layout', text(s.flexDirection)],
    ['grid-auto-flow', 'layout', text(s.gridAutoFlow)],
    ['justify-content', 'layout', text(s.justifyContent)],
    ['align-items', 'layout', text(s.alignItems)],
    ['text', 'content', text(e.ownText && `'${e.ownText}'`)],
    ['image', 'content', text(e.src)],
  ];
}

const GROUP_WEIGHT: Record<ChangeGroup, number> = { box: 1, type: 1, color: 1, shape: 1, layout: 25, content: 20 };

function weight(change: PropertyChange, colors: { before?: RGBAValue; after?: RGBAValue }): number {
  if (change.group === 'color' && colors.before && colors.after) return 5 + colorDistance(colors.before, colors.after) / 2;
  const [a, b] = [nums(change.before), nums(change.after)];
  if (a.length && a.length === b.length) return Math.min(40, a.reduce((n, v, i) => n + Math.abs(v - b[i]), 0)) + 2;
  return GROUP_WEIGHT[change.group];
}

/**
 * Measured differences of matched elements, plus added and removed ones. Noise is kept out: an
 * inherited property is reported only where it changed (not on every descendant), a box that
 * moved because an earlier sibling grew or that resized because its children changed is a
 * consequence and not listed, and an added or removed subtree is one entry.
 */
export function diffElements(base: StyleSnapshot, head: StyleSnapshot, match: ElementMatch): ElementChange[] {
  const baseOf = new Map(match.pairs.map((p) => [p.head, p] as const));
  const raw = new Map<number, { pair: ElementPair; changes: PropertyChange[]; dx: number; dy: number; dw: number; dh: number }>();

  for (const pair of match.pairs) {
    const [b, h] = [base.elements[pair.base], head.elements[pair.head]];
    if (b.masked || h.masked) continue;
    const [mb, mh] = [measured(b, base.colors), measured(h, head.colors)];
    const changes: PropertyChange[] = [];
    mb.forEach(([property, group, before], i) => {
      const after = mh[i][2];
      if (before === undefined || after === undefined || samePx(before.exact, after.exact)) return;
      changes.push({ property, group, before: before.value, after: after.value });
    });
    // Position relative to the parent, so content pushed along with its parent is not "moved".
    const origin = (e: StyledElement, list: StyledElement[]) => (e.parent != null ? list[e.parent].box : { x: 0, y: 0 });
    const [ob, oh] = [origin(b, base.elements), origin(h, head.elements)];
    raw.set(pair.head, {
      pair,
      changes,
      dx: h.box.x - oh.x - (b.box.x - ob.x),
      dy: h.box.y - oh.y - (b.box.y - ob.y),
      dw: h.box.width - b.box.width,
      dh: h.box.height - b.box.height,
    });
  }

  const childrenOf = new Map<number | null, number[]>();
  head.elements.forEach((e, i) => childrenOf.set(e.parent ?? null, [...(childrenOf.get(e.parent ?? null) ?? []), i]));

  // Reordered children: one "order" change on their parent, and their moves are its consequence.
  const reordered = new Set<number>();
  const short = (e: StyledElement) => e.label ?? e.ownText ?? e.name ?? e.selector;
  for (const [parent, kids] of childrenOf) {
    if (parent === null || !raw.has(parent)) continue;
    const matched = kids.filter((k) => baseOf.has(k));
    const order = matched.map((k) => baseOf.get(k)!.base);
    if (matched.length < 2 || order.every((b, i) => i === 0 || b > order[i - 1])) continue;
    for (const k of matched) reordered.add(k);
    const list = (names: string[]) => (names.length > 6 ? `${names.slice(0, 6).join(', ')}, …` : names.join(', '));
    const before = [...order].sort((a, b) => a - b).map((b) => short(base.elements[b]));
    const after = matched.map((k) => short(head.elements[k]));
    raw.get(parent)!.changes.push({ property: 'order', group: 'layout', before: list(before), after: list(after) });
  }

  const out: ElementChange[] = [];
  for (const [hi, r] of raw) {
    const h = head.elements[hi];
    const b = base.elements[r.pair.base];
    // Inherited: drop what the matched parent changed the same way.
    const parentRaw = h.parent != null ? raw.get(h.parent) : undefined;
    const changes = r.changes.filter((c) => !(INHERITED.has(c.property) && parentRaw?.changes.some((p) => p.property === c.property && p.before === c.before && p.after === c.after)));
    const resized = Math.abs(r.dw) >= 0.5 || Math.abs(r.dh) >= 0.5;
    const moved = Math.abs(r.dx) >= 0.5 || Math.abs(r.dy) >= 0.5;
    const kids = childrenOf.get(hi) ?? [];
    const kidChanged = kids.some((k) => {
      const kr = raw.get(k);
      return !baseOf.has(k) || (kr && (kr.changes.length > 0 || Math.abs(kr.dw) >= 0.5 || Math.abs(kr.dh) >= 0.5 || Math.abs(kr.dx) >= 0.5 || Math.abs(kr.dy) >= 0.5));
    });
    if (resized && (changes.length > 0 || !kidChanged)) changes.unshift({ property: 'size', group: 'box', before: `${halfPx(b.box.width).replace('px', '')}×${halfPx(b.box.height)}`, after: `${halfPx(h.box.width).replace('px', '')}×${halfPx(h.box.height)}` });
    if (moved && !reordered.has(hi)) {
      // Pushed by an earlier sibling that changed size, or by one that was added or removed: a consequence.
      const siblings = (childrenOf.get(h.parent ?? null) ?? []).filter((s) => s < hi);
      // The parent's gap and padding move its children too.
      const [pb, ph] = [b.parent != null ? base.elements[b.parent] : undefined, h.parent != null ? head.elements[h.parent] : undefined];
      const delta = (pick: (e: StyledElement) => string[] | undefined, i: number) => (pb && ph ? Math.abs(parseFloat(pick(ph)?.[i] ?? '0') - parseFloat(pick(pb)?.[i] ?? '0')) || 0 : 0);
      const gapDelta = Math.max(delta((e) => e.styles.gap, 0), delta((e) => e.styles.gap, 1));
      const grew = siblings.reduce(
        (acc, s) => {
          const sr = raw.get(s);
          if (!baseOf.has(s)) return { w: Infinity, h: Infinity };
          return sr ? { w: acc.w + Math.abs(sr.dw), h: acc.h + Math.abs(sr.dh) } : acc;
        },
        { w: delta((e) => e.styles.padding, 3) + gapDelta * siblings.length, h: delta((e) => e.styles.padding, 0) + gapDelta * siblings.length },
      );
      const removedBefore = match.removed.some((ri) => base.elements[ri].parent === b.parent && ri < r.pair.base);
      const pushed = removedBefore || (Math.abs(r.dx) <= grew.w + 0.5 && Math.abs(r.dy) <= grew.h + 0.5);
      if (!pushed) {
        const dir = [r.dx && `${halfPx(Math.abs(r.dx))} ${r.dx > 0 ? 'right' : 'left'}`, r.dy && `${halfPx(Math.abs(r.dy))} ${r.dy > 0 ? 'down' : 'up'}`].filter((d) => d && !/^0px/.test(d));
        if (dir.length) changes.push({ property: 'position', group: 'box', before: '', after: `moved ${dir.join(', ')}` });
      }
    }
    if (changes.length === 0) continue;
    let magnitude = 0;
    for (const c of changes) {
      const colors = c.group === 'color' ? { before: parseCssColor(c.before), after: parseCssColor(c.after) } : {};
      magnitude += weight(c, colors);
    }
    out.push({ kind: 'changed', name: h.name ?? h.selector, selector: h.selector, base: r.pair.base, head: hi, confidence: r.pair.confidence, reason: r.pair.reason, changes, box: h.box, deviceBox: h.deviceBox, magnitude });
  }

  const subtree = (list: StyledElement[], indices: number[], kind: 'added' | 'removed') => {
    const set = new Set(indices);
    for (const i of indices) {
      const e = list[i];
      if (e.masked || (e.parent != null && set.has(e.parent))) continue;
      let inside = 0;
      for (const j of indices) for (let p = list[j].parent; p != null; p = list[p].parent) if (p === i) inside++;
      const area = e.box.width * e.box.height;
      out.push({ kind, name: e.name ?? e.selector, selector: e.selector, [kind === 'added' ? 'head' : 'base']: i, changes: [], box: e.box, deviceBox: e.deviceBox, ...(inside ? { inside } : {}), magnitude: 10 + Math.min(60, Math.sqrt(area) / 2) });
    }
  };
  subtree(head.elements, match.added, 'added');
  subtree(base.elements, match.removed, 'removed');
  return out.sort((a, b) => b.magnitude - a.magnitude);
}

/** A changed pixel area, explained by the element map. */
export interface RegionExplanation {
  /** The changed area in device px (head screenshot), as in the capture's diff regions. */
  region: Box;
  /** The smallest head element that contains the whole area; absent when none does. */
  element?: { name: string; selector: string };
  /** Indices into the capture's element changes that touch the area, biggest first. */
  changes: number[];
  /** Plain words when no measured change touches the area. */
  note?: string;
}

const MEDIA = new Set(['img', 'picture', 'video', 'canvas', 'svg', 'iframe', 'object', 'embed']);

function deviceBoxOf(e: StyledElement, scale: number): Box {
  return e.deviceBox ?? { x: e.box.x * scale, y: e.box.y * scale, width: e.box.width * scale, height: e.box.height * scale };
}

function containsBox(outer: Box, inner: Box, tolerance: number): boolean {
  return outer.x <= inner.x + tolerance && outer.y <= inner.y + tolerance && outer.x + outer.width >= inner.x + inner.width - tolerance && outer.y + outer.height >= inner.y + inner.height - tolerance;
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Names each changed pixel area after the smallest element containing it and lists the measured
 * changes inside it. Areas without a measured change say what they can ("image content changed")
 * or that pixels changed without one; areas no element contains say that instead of guessing.
 */
export function explainRegions(regions: Box[], scale: number, head: StyleSnapshot, base: StyleSnapshot, changes: ElementChange[]): RegionExplanation[] {
  // Diff regions snap to an 8 px grid (times the scale), so they can stick out of an element by almost a cell.
  const tolerance = 8 * scale;
  return regions.map((region) => {
    let container: StyledElement | undefined;
    for (const e of head.elements) {
      const box = deviceBoxOf(e, scale);
      if (!containsBox(box, region, tolerance)) continue;
      if (!container || box.width * box.height < deviceBoxOf(container, scale).width * deviceBoxOf(container, scale).height) container = e;
    }
    const inside = changes
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => {
        const list = c.kind === 'removed' ? base.elements : head.elements;
        const e = list[(c.kind === 'removed' ? c.base : c.head)!];
        return e !== undefined && overlaps(deviceBoxOf(e, scale), region);
      })
      .map(({ i }) => i);
    const explanation: RegionExplanation = { region, ...(container ? { element: { name: container.name ?? container.selector, selector: container.selector } } : {}), changes: inside };
    if (inside.length === 0) {
      const media = head.elements.find((e) => e.tag && MEDIA.has(e.tag) && overlaps(deviceBoxOf(e, scale), region));
      if (!container) explanation.note = 'no element covers this area, so it is not named';
      else if (media) explanation.note = `image content changed (${media.name ?? media.selector})`;
      else explanation.note = 'pixels changed, but no measured style, text or size change explains it';
    }
    return explanation;
  });
}
