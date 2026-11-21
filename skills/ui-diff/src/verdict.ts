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

export interface MeasuredRow {
  name: string;
  selector: string;
  text: string;
  magnitude: number;
  /** "desktop", "mobile/dark": the captures of the route it was measured on. */
  where: string[];
}

export interface RouteMeasurements {
  route: string;
  /** Changed captures of the route that have a style diff. */
  captures: CaptureResult[];
  /** Verified changes, the same change on several captures once, biggest first. */
  rows: MeasuredRow[];
  /** "name: change" → why it was not verified. */
  unverified: Map<string, string>;
}

/** The measured changes of every changed route, in the order the routes were captured. */
export function measurements(report: Report): RouteMeasurements[] {
  const themes = report.themes.length;
  const changed = report.captures.filter((c) => c.status === 'changed' && c.styleDiff);
  const out: RouteMeasurements[] = [];
  for (const route of [...new Set(changed.map((c) => c.route.path))]) {
    const captures = changed.filter((c) => c.route.path === route);
    const rows = new Map<string, MeasuredRow>();
    const unverified = new Map<string, string>();
    for (const c of captures) {
      const where = `${c.viewport}${themes > 1 ? `/${c.theme}` : ''}`;
      for (const change of c.styleDiff!.changes) {
        const text = changeText(change);
        if (change.verified === false) {
          unverified.set(`${change.name}: ${text}`, change.unverified?.join('; ') ?? '');
          continue;
        }
        const key = `${change.name}\u0000${change.selector}\u0000${text}`;
        const row = rows.get(key) ?? { name: change.name, selector: change.selector, text, magnitude: 0, where: [] };
        row.magnitude = Math.max(row.magnitude, change.magnitude);
        if (!row.where.includes(where)) row.where.push(where);
        rows.set(key, row);
      }
    }
    out.push({ route, captures, rows: [...rows.values()].sort((a, b) => b.magnitude - a.magnitude), unverified });
  }
  return out;
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
