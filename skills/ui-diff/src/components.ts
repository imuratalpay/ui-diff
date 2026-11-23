import type { ComponentState } from './config.js';
import type { ElementChange } from './elements.js';
import { unionBox, type Box } from './image.js';
import type { StyledElement, StyleSnapshot } from './tokens.js';

/** Why a component state was not captured on one side. */
export type ComponentMiss = 'none' | 'many' | 'hidden' | 'flow' | 'state';

/** One side's capture of a component in one state, kept on its record. */
export interface ComponentRunInfo {
  name: string;
  state: ComponentState;
  selector: string;
  /** Elements the selector matched. */
  matches: number;
  /** The root's element-map selector and box (CSS px, in the screenshot's coordinates). */
  root?: { selector: string; box: Box };
  /** False when nothing was captured for this state: see `miss`. */
  reached: boolean;
  miss?: ComponentMiss;
  /** The flow's stop or why the state could not be entered. */
  note?: string;
  /** The whole run on this side, page load and every state included. */
  ms: number;
}

/** Zero or several matches: the selector does not name one component. */
export function matchMiss(count: number): ComponentMiss | undefined {
  return count === 0 ? 'none' : count > 1 ? 'many' : undefined;
}

/**
 * The crop of a component, the same box on both sides: the union of its boxes on base and head
 * (so blink and side-by-side line up when it changed size), plus `padding`, clamped to the page.
 * CSS px, whole pixels.
 */
export function componentCrop(base: Box, head: Box, padding: number, page: { width: number; height: number }): Box {
  const u = unionBox(base, head);
  const x = Math.max(0, Math.floor(u.x - padding));
  const y = Math.max(0, Math.floor(u.y - padding));
  const right = Math.min(page.width, Math.ceil(u.x + u.width + padding));
  const bottom = Math.min(page.height, Math.ceil(u.y + u.height + padding));
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/** A device-px box for a CSS-px box at `scale`, clamped to the image. */
export function toDevice(box: Box, scale: number, size: { width: number; height: number }): Box {
  const x = Math.min(size.width, Math.round(box.x * scale));
  const y = Math.min(size.height, Math.round(box.y * scale));
  return { x, y, width: Math.max(0, Math.min(size.width, Math.round((box.x + box.width) * scale)) - x), height: Math.max(0, Math.min(size.height, Math.round((box.y + box.height) * scale)) - y) };
}

/** Moves an element map so its boxes are relative to the crop (CSS px `origin`, device px at `scale`). */
export function shiftSnapshot(snapshot: StyleSnapshot, origin: { x: number; y: number }, scale: number): void {
  for (const e of snapshot.elements) {
    e.box = { ...e.box, x: e.box.x - origin.x, y: e.box.y - origin.y };
    e.deviceBox = { x: Math.round(e.box.x * scale), y: Math.round(e.box.y * scale), width: Math.round(e.box.width * scale), height: Math.round(e.box.height * scale) };
  }
}

/** The element is the root or inside it, by its element map's parent chain. */
export function insideRoot(list: StyledElement[], index: number | undefined, root: number): boolean {
  for (let i: number | null | undefined = index; i != null; i = list[i]?.parent) if (i === root) return true;
  return false;
}

/** The changes of elements inside the component: added and changed ones on head, removed ones on base. */
export function scopeChanges(changes: ElementChange[], base: StyledElement[], head: StyledElement[], roots: { base: number; head: number }): ElementChange[] {
  return changes.filter((c) => (c.kind === 'removed' ? insideRoot(base, c.base, roots.base) : insideRoot(head, c.head, roots.head)));
}

function px(n: number): string {
  const r = Math.round(n * 2) / 2;
  return `${Object.is(r, -0) ? 0 : r}`;
}

/** "size 320×48 → 320×52px, moved 4px down": how the component's root box changed, or undefined. */
export function rootChange(before: Box, after: Box): string | undefined {
  const parts: string[] = [];
  if (Math.abs(before.width - after.width) >= 0.5 || Math.abs(before.height - after.height) >= 0.5) parts.push(`size ${px(before.width)}×${px(before.height)} → ${px(after.width)}×${px(after.height)}px`);
  const [dx, dy] = [after.x - before.x, after.y - before.y];
  const moves = [Math.abs(dx) >= 0.5 && `${px(Math.abs(dx))}px ${dx > 0 ? 'right' : 'left'}`, Math.abs(dy) >= 0.5 && `${px(Math.abs(dy))}px ${dy > 0 ? 'down' : 'up'}`].filter(Boolean);
  if (moves.length) parts.push(`moved ${moves.join(', ')}`);
  return parts.length ? parts.join(', ') : undefined;
}

/** "component 'primary button'", "component 'card' · hover". */
export function componentLabel(c: { name: string; state: string }): string {
  return `component '${c.name}'${c.state === 'default' ? '' : ` · ${c.state}`}`;
}

type SideRun = Pick<ComponentRunInfo, 'reached' | 'miss' | 'matches' | 'note' | 'selector'>;

function why(side: SideRun): string {
  if (side.miss === 'none') return `nothing matches ${side.selector}`;
  if (side.miss === 'many') return `${side.selector} matches ${side.matches} elements`;
  if (side.miss === 'hidden') return `${side.selector} is not visible`;
  return side.note ?? 'not captured';
}

export interface ComponentOutcome {
  /** One side has it and the other does not (removed, added), or it could not be compared there. */
  change?: 'removed' | 'added' | 'not compared';
  finding?: string;
  /** Neither side was captured: a problem with the component entry, listed as a warning. */
  problem?: string;
}

/**
 * Compares whether each side captured a component state. Found on one side only: removed or
 * added (also when hidden there). Several matches, a flow that stopped or a state that could not
 * be entered on one side: not compared. Neither side: a warning about the entry, not a finding.
 */
export function componentOutcome(c: { name: string; state: string }, base: SideRun, head: SideRun): ComponentOutcome {
  if (base.reached && head.reached) return {};
  const label = componentLabel(c);
  if (!base.reached && !head.reached) {
    const [b, h] = [why(base), why(head)];
    return { problem: `${label}: ${b === h ? `${b} on base and head` : `${b} on base, ${h} on head`}; check the component in the config` };
  }
  const [side, missing] = head.reached ? (['base', base] as const) : (['head', head] as const);
  const gone = missing.miss === 'none' || missing.miss === 'hidden';
  if (gone && side === 'head') return { change: 'removed', finding: `${label} removed on head: ${why(missing)}` };
  if (gone) return { change: 'added', finding: `${label} added on head (${why(missing)} on base)` };
  return { change: 'not compared', finding: `${label} not compared: ${why(missing)} on ${side}` };
}
