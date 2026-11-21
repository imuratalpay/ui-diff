import type { StyledElement } from './tokens.js';

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
