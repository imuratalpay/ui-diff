import type { ElementChange } from './elements.js';
import { notCheckedReason, type CaptureResult, type Report } from './report.js';

export type CheckVerdict = 'no visual changes' | 'no visual changes found, captured differently' | 'visual changes' | 'capture errors' | 'nothing checked';

/** "padding 8px 14px → 10px 18px · border-radius 4px → 8px", "added (+2 inside)". */
export function changeText(c: ElementChange): string {
  if (c.kind !== 'changed') return `${c.kind}${c.inside ? ` (+${c.inside} inside)` : ''}`;
  return c.changes.map((p) => (p.property === 'position' ? p.after : `${p.property} ${p.before} → ${p.after}`)).join(' · ');
}

export function isShownChange(c: CaptureResult): boolean {
  return c.status === 'changed' || c.status === 'added' || c.status === 'removed';
}

function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

export interface MeasuredVariant {
  capture: string;
  viewport: string;
  theme: string;
  magnitude: number;
}

/** One measured change: an element's property going from one value to another, on the variants it was seen on. */
export interface MeasuredRow {
  name: string;
  selector: string;
  /** The CSS property, "size", "position", "text", or the kind ("added", "removed") of a whole element. */
  property: string;
  before?: string;
  after?: string;
  /** "padding 8px 14px → 10px 18px", "added (+2 inside)". */
  text: string;
  magnitude: number;
  variants: MeasuredVariant[];
  /** "desktop, mobile · light, dark", or "desktop/dark, mobile/dark" when not every combination. */
  where: string;
}

export interface RouteMeasurements {
  route: string;
  /** Changed captures of the route that have a style diff. */
  captures: CaptureResult[];
  /** Verified changes grouped by element, property and old → new value, biggest element first. */
  rows: MeasuredRow[];
  /** "name: change" → why it was not verified. */
  unverified: Map<string, string>;
}

/** The variants a row was seen on, as compactly as they read: a full grid as its two lists. */
export function variantsLabel(variants: Array<Pick<MeasuredVariant, 'viewport' | 'theme'>>, report: Pick<Report, 'viewports' | 'themes'>): string {
  const order = (list: string[], all: string[]) => [...new Set(list)].sort((a, b) => all.indexOf(a) - all.indexOf(b));
  const viewports = order(variants.map((v) => v.viewport), report.viewports);
  const themes = order(variants.map((v) => v.theme), report.themes);
  const showThemes = report.themes.length > 1;
  const pairs = new Set(variants.map((v) => `${v.viewport}/${v.theme}`));
  if (pairs.size === viewports.length * themes.length) return showThemes ? `${viewports.join(', ')} · ${themes.join(', ')}` : viewports.join(', ');
  const combos = report.viewports.flatMap((v) => report.themes.map((t) => [v, t])).filter(([v, t]) => pairs.has(`${v}/${t}`));
  return combos.map(([v, t]) => (showThemes ? `${v}/${t}` : v)).join(', ');
}

function propertyRows(change: ElementChange): Array<Pick<MeasuredRow, 'property' | 'before' | 'after' | 'text'>> {
  if (change.kind !== 'changed') return [{ property: change.kind, text: changeText(change) }];
  return change.changes.map((p) => ({ property: p.property, before: p.before, after: p.after, text: p.property === 'position' ? p.after : `${p.property} ${p.before} → ${p.after}` }));
}

/** The measured changes of every changed route, in the order the routes were captured. */
export function measurements(report: Report): RouteMeasurements[] {
  const changed = report.captures.filter((c) => c.status === 'changed' && c.styleDiff);
  const out: RouteMeasurements[] = [];
  for (const route of [...new Set(changed.map((c) => c.route.path))]) {
    const captures = changed.filter((c) => c.route.path === route);
    const rows = new Map<string, Omit<MeasuredRow, 'where'>>();
    const elementMagnitude = new Map<string, number>();
    const unverified = new Map<string, string>();
    for (const c of captures) {
      for (const change of c.styleDiff!.changes) {
        if (change.verified === false) {
          unverified.set(`${change.name}: ${changeText(change)}`, change.unverified?.join('; ') ?? '');
          continue;
        }
        const element = `${change.name}\u0000${change.selector}`;
        elementMagnitude.set(element, Math.max(elementMagnitude.get(element) ?? 0, change.magnitude));
        for (const p of propertyRows(change)) {
          const key = `${element}\u0000${p.property}\u0000${p.before ?? ''}\u0000${p.after ?? ''}\u0000${p.text}`;
          const row = rows.get(key) ?? { name: change.name, selector: change.selector, ...p, magnitude: 0, variants: [] };
          row.magnitude = Math.max(row.magnitude, change.magnitude);
          if (!row.variants.some((v) => v.capture === c.id)) row.variants.push({ capture: c.id, viewport: c.viewport, theme: c.theme, magnitude: change.magnitude });
          rows.set(key, row);
        }
      }
    }
    // Biggest element first; its properties in the order they were first measured, the values of one property together.
    const elementOrder = [...elementMagnitude].sort((a, b) => b[1] - a[1]).map(([key]) => key);
    const all = [...rows.values()];
    const firstOf = (row: (typeof all)[number]) => all.findIndex((r) => r.name === row.name && r.selector === row.selector && r.property === row.property);
    const sorted = all
      .map((row, i) => ({ row, i, p: firstOf(row) }))
      .sort((a, b) => elementOrder.indexOf(`${a.row.name}\u0000${a.row.selector}`) - elementOrder.indexOf(`${b.row.name}\u0000${b.row.selector}`) || a.p - b.p || a.i - b.i)
      .map(({ row }) => ({ ...row, where: variantsLabel(row.variants, report) }));
    out.push({ route, captures, rows: sorted, unverified });
  }
  return out;
}

/** Every route's grouped rows, for report.json. */
export function measuredGroups(report: Report): Array<MeasuredRow & { route: string }> {
  return measurements(report).flatMap((r) => r.rows.map((row) => ({ route: r.route, ...row })));
}

export interface PixelOnlyArea {
  capture: CaptureResult;
  /** CSS px. */
  box: { x: number; y: number; width: number; height: number };
  /** The element the area is inside, when one was found. */
  element?: string;
  note?: string;
}

/** Changed areas that no verified measured change explains, per changed capture with a style diff. */
export function pixelOnlyAreas(report: Report): PixelOnlyArea[] {
  const out: PixelOnlyArea[] = [];
  for (const c of report.captures) {
    if (c.status !== 'changed' || !c.styleDiff) continue;
    const scale = c.diff?.scale ?? 1;
    for (const r of c.styleDiff.regions) {
      if (r.changes.some((i) => c.styleDiff!.changes[i]?.verified !== false)) continue;
      const box = { x: Math.round(r.region.x / scale), y: Math.round(r.region.y / scale), width: Math.round(r.region.width / scale), height: Math.round(r.region.height / scale) };
      out.push({ capture: c, box, element: r.element?.name, note: r.note });
    }
  }
  return out;
}

export interface Verdict {
  kind: CheckVerdict;
  /** The first line of the comment and of `ui-diff check`, in plain words. */
  text: string;
}

/**
 * "No visual changes", "3 measured changes on 2 routes", "Changes found, but captures were not
 * comparable": what the run found, before any detail.
 */
export function verdict(report: Report): Verdict {
  const s = report.stats;
  const changed = report.captures.filter(isShownChange);
  const kind: CheckVerdict = s.errors ? 'capture errors' : notCheckedReason(report) ? 'nothing checked' : changed.length ? 'visual changes' : report.notComparable ? 'no visual changes found, captured differently' : 'no visual changes';
  if (kind === 'nothing checked') return { kind, text: 'Nothing was checked' };
  const failed = s.errors ? plural(s.errors, 'capture failed', 'captures failed') : '';
  if (changed.length === 0) {
    const text = report.notComparable ? 'No visual changes, but captures were not comparable' : 'No visual changes';
    if (!failed) return { kind, text };
    return { kind, text: s.errors === s.captures ? capitalize(failed) : `${capitalize(failed)}; ${text[0].toLowerCase()}${text.slice(1)} in the rest` };
  }
  if (report.notComparable) return { kind, text: `Changes found, but captures were not comparable${failed ? `; ${failed}` : ''}` };
  const routes = measurements(report);
  const measured = routes.filter((r) => r.rows.length);
  const count = measured.reduce((n, r) => n + r.rows.length, 0);
  const pixelOnly = new Set(changed.filter((c) => c.status === 'changed' && !measured.some((r) => r.route === c.route.path)).map((c) => c.route.path)).size;
  const parts: string[] = [];
  if (count) parts.push(`${plural(count, 'measured change')} on ${plural(measured.length, 'route')}`);
  // Reports without a style diff (older ones, or styleDiff.enabled false) never measured anything.
  const anyMeasured = changed.some((c) => c.styleDiff);
  if (pixelOnly) parts.push(count ? `pixel changes on ${plural(pixelOnly, 'more route')}` : `Visual changes on ${plural(pixelOnly, 'route')}${anyMeasured ? ', none measured' : ''}`);
  if (s.added) parts.push(plural(s.added, 'new page'));
  if (s.removed) parts.push(`${plural(s.removed, 'page')} no longer ${s.removed === 1 ? 'renders' : 'render'}`);
  if (failed) parts.push(failed);
  return { kind, text: capitalize(parts.join(', ')) };
}

function capitalize(text: string): string {
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}
