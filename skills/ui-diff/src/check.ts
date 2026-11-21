import path from 'node:path';
import { changeText, timingLine } from './markdown.js';
import { describeCapture, notCheckedReason, type Report } from './report.js';

export type CheckVerdict = 'no visual changes' | 'visual changes' | 'capture errors' | 'nothing checked';

/** Exit codes of `ui-diff check`: usable as a pre-push gate. */
export const CHECK_EXIT = { clean: 0, changes: 1, error: 2 } as const;

export interface CheckSummary {
  verdict: CheckVerdict;
  exitCode: number;
  /** Plain text for the terminal. */
  text: string;
}

function rel(file: string): string {
  const r = path.relative(process.cwd(), file);
  return r.startsWith('..') ? file : r || '.';
}

/**
 * The verdict and terminal summary of a local check: which captures changed, the measured changes
 * per route, warnings, where the report is, and the timing. Exit code 0 when nothing changed
 * visually (or nothing UI-related changed), 1 when something did, 2 when a capture failed.
 */
export function checkSummary(report: Report, outDir: string): CheckSummary {
  const s = report.stats;
  const notChecked = notCheckedReason(report);
  const changed = report.captures.filter((c) => c.status === 'changed' || c.status === 'added' || c.status === 'removed');
  const verdict: CheckVerdict = s.errors ? 'capture errors' : notChecked ? 'nothing checked' : changed.length ? 'visual changes' : 'no visual changes';
  const exitCode = s.errors ? CHECK_EXIT.error : changed.length ? CHECK_EXIT.changes : CHECK_EXIT.clean;
  const themes = report.themes.length;
  const where = (c: (typeof report.captures)[number]) => `${c.viewport}${themes > 1 ? `/${c.theme}` : ''}`;
  const lines = [`ui-diff check: ${verdict} (exit ${exitCode})`];
  const head = report.head.includesUncommitted ? `${report.head.label} + uncommitted changes` : report.head.label;
  lines.push(`base ${report.base.label} → head ${head} · ${report.routes.length} route${report.routes.length === 1 ? '' : 's'} · ${report.viewports.join(', ')} · ${report.themes.join(', ')}`);
  if (notChecked) lines.push('', `Nothing was checked: ${notChecked}.`);

  if (changed.length) {
    lines.push('', `Changed (${changed.length} of ${s.captures} capture${s.captures === 1 ? '' : 's'})`);
    for (const c of changed) lines.push(`  ${c.route.path}  ${where(c)}  ${describeCapture(c)}`);
    for (const route of [...new Set(changed.map((c) => c.route.path))]) {
      const rows = new Map<string, { magnitude: number; where: string[] }>();
      const ofRoute = changed.filter((c) => c.route.path === route && c.styleDiff);
      for (const c of ofRoute) {
        for (const change of c.styleDiff!.changes) {
          const text = `${change.name}${change.name === change.selector ? '' : ` (${change.selector})`}: ${changeText(change)}`;
          const row = rows.get(text) ?? { magnitude: 0, where: [] };
          row.magnitude = Math.max(row.magnitude, change.magnitude);
          if (!row.where.includes(where(c))) row.where.push(where(c));
          rows.set(text, row);
        }
      }
      if (ofRoute.length === 0) continue;
      lines.push('', `Measured changes on ${route}`);
      if (rows.size === 0) lines.push('  none: the pixels changed without a measured style, text or size change');
      for (const [text, row] of [...rows].sort((a, b) => b[1].magnitude - a[1].magnitude)) lines.push(`  - ${text}${row.where.length < ofRoute.length ? ` (${row.where.join(', ')})` : ''}`);
    }
  }
  const failed = report.captures.filter((c) => c.status === 'error');
  if (failed.length) {
    lines.push('', `Failed (${failed.length})`);
    for (const c of failed) lines.push(`  ${c.route.path}  ${where(c)}  ${c.error ?? 'unknown error'}`);
  }
  const warnings = [...report.warnings, ...report.captures.flatMap((c) => c.warnings.map((w) => `${c.route.path} ${where(c)}: ${w}`))];
  if (warnings.length) {
    lines.push('', `Warnings (${warnings.length})`);
    for (const w of warnings.slice(0, 10)) lines.push(`  ${w}`);
    if (warnings.length > 10) lines.push(`  …and ${warnings.length - 10} more in report.json`);
  }
  lines.push('', `Report: ${rel(path.join(outDir, 'report.json'))} · images: ${rel(path.join(outDir, 'compare'))}${path.sep} · preview: ${rel(path.join(outDir, 'comment.local.md'))}`);
  if (report.timings) lines.push(timingLine(report.timings));
  return { verdict, exitCode, text: `${lines.join('\n')}\n` };
}
