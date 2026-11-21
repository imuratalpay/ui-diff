import { categorize } from './a11y.js';
import { autoSummary, captureLabel, describeCapture, notCheckedNotice, notCheckedReason, type CaptureResult, type Report, type SideTiming, type Timings } from './report.js';

export const MAX_COMMENT_LENGTH = 65000;

export function stickyMarker(id: string): string {
  return `<!-- ui-diff:sticky id=${id} -->`;
}

const PICK_RE = /^\s*[-*] \[([ xX])\][^\n]*<!-- ui-diff-pick:([^ ]+) -->/gm;

/** Keys of variant checkboxes that reviewers ticked in a previous version of the comment. */
export function extractPicks(body: string | undefined): Set<string> {
  const picks = new Set<string>();
  if (!body) return picks;
  for (const m of body.matchAll(PICK_RE)) if (m[1].toLowerCase() === 'x') picks.add(m[2]);
  return picks;
}

export function code(text: string): string {
  const clean = text.replace(/\r?\n/g, ' ');
  return clean.includes('`') ? `\`\` ${clean} \`\`` : `\`${clean}\``;
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Escapes text placed in markdown prose (quotes stay readable). */
function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** "/ (all 4)" or "/ desktop/light, mobile/light" from labels shaped "<route> <viewport>/<theme>". */
export function compressWhere(labels: string[], totals: Map<string, number>): string {
  const byRoute = new Map<string, string[]>();
  for (const label of labels) {
    const i = label.lastIndexOf(' ');
    const route = i > 0 ? label.slice(0, i) : label;
    byRoute.set(route, [...(byRoute.get(route) ?? []), i > 0 ? label.slice(i + 1) : '']);
  }
  return [...byRoute]
    .map(([route, where]) => {
      const total = totals.get(route) ?? 0;
      if (total > 1 && where.length >= total) return `${code(route)} (all ${total})`;
      return `${code(route)} ${where.filter(Boolean).join(', ')}`.trim();
    })
    .join('; ');
}

function captureHeading(c: CaptureResult, themes: number): string {
  return `**${code(c.route.path)}** · ${c.viewport}${themes > 1 || c.theme !== 'light' ? ` · ${c.theme}` : ''}`;
}

function imagesOn(opts: RenderOptions): boolean {
  return opts.images !== false;
}

function img(opts: RenderOptions, src: string, alt: string, width?: number): string {
  if (!imagesOn(opts)) return `_${escapeHtml(alt)} — image not uploaded_`;
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${width ? ` width="${width}"` : ''}>`;
}

export interface RenderOptions {
  id: string;
  title: string;
  link: (relPath: string) => string;
  summary?: string;
  previousBody?: string;
  storageNote?: string;
  showUnchanged?: boolean;
  maxLength?: number;
  /** Rendering tiers: 0 = everything, higher drops detail to fit the size limit. */
  compact?: number;
  /** False for text-only comments (nothing uploaded). */
  images?: boolean;
}

function sideLabel(side: Report['base']): string {
  return side.includesUncommitted ? `${side.label} + uncommitted changes` : side.label;
}

function changedSection(report: Report, captures: CaptureResult[], opts: RenderOptions): string[] {
  const out: string[] = [];
  const themes = report.themes.length;
  for (const c of captures) {
    out.push(`${captureHeading(c, themes)} — ${describeCapture(c)}`);
    if (c.urls.head) out.push(`<sub>head: ${c.urls.head}</sub>`);
    out.push('');
    const alt = `${captureLabel(c, themes)}: before, after and highlighted diff`;
    if (c.images.focus.length && (opts.compact ?? 0) < 3) {
      for (const f of c.images.focus) out.push(img(opts, opts.link(f), `${alt} (zoomed)`), '');
      if (c.images.compare && (opts.compact ?? 0) < 1) {
        out.push('<details><summary>Full page</summary>', '', img(opts, opts.link(c.images.compare), alt), '', '</details>', '');
      }
    } else if (c.images.compare) {
      out.push(img(opts, opts.link(c.images.compare), alt), '');
    } else if (c.status === 'removed' && c.images.base) {
      out.push(img(opts, opts.link(c.images.base), `${captureLabel(c, themes)} (base; missing on head)`, 480), '');
    } else if (c.images.head) {
      out.push(img(opts, opts.link(c.images.head), `${captureLabel(c, themes)} (head)`, 480), '');
    }
    const env = c.fingerprint?.differences ?? [];
    if (env.length) out.push(`> ⚠️ ${environmentWarning(env)}`, '');
    for (const w of c.warnings.slice(0, INLINE_WARNINGS)) out.push(`> ${w}`, '');
  }
  return out;
}

const INLINE_WARNINGS = 3;

export function environmentWarning(differences: string[]): string {
  return `**The capture environment differed between base and head**, so this diff may come from it rather than from the code: ${escapeText(differences.join('; '))}.`;
}
/** Truncation has its own "Partial captures" notice. */
const TRUNCATION_WARNING = /taller than capture\.maxHeight|cut at capture\.maxHeight/;

function isShownChange(c: CaptureResult): boolean {
  return c.status === 'changed' || c.status === 'added' || c.status === 'removed';
}

/**
 * Every warning not already printed next to a changed capture: report-level ones (dev server,
 * detection notes) and those of unchanged or failed captures, grouped by capture.
 */
function warningsSection(report: Report, opts: RenderOptions): string[] {
  const groups: Array<{ label?: string; items: string[] }> = [];
  const general = report.warnings.filter((w) => !TRUNCATION_WARNING.test(w));
  if (general.length) groups.push({ items: general });
  for (const c of report.captures) {
    const items = c.warnings.filter((w) => !TRUNCATION_WARNING.test(w)).slice(isShownChange(c) ? INLINE_WARNINGS : 0);
    if (items.length) groups.push({ label: captureLabel(c, report.themes.length), items });
  }
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  if (total === 0) return [];
  const limit = (opts.compact ?? 0) >= 2 ? 10 : 60;
  const lines: string[] = [];
  let shown = 0;
  for (const g of groups) {
    const items = g.items.slice(0, Math.max(0, limit - shown));
    shown += items.length;
    if (items.length === 0) break;
    if (!g.label) for (const w of items) lines.push(`- ${escapeText(w)}`);
    else if (items.length === 1) lines.push(`- ${code(g.label)}: ${escapeText(items[0])}`);
    else lines.push(`- ${code(g.label)}:`, ...items.map((w) => `  - ${escapeText(w)}`));
  }
  if (total > shown) lines.push(`- …and ${total - shown} more in \`report.json\``);
  if (total > 5) return [`<details><summary>Warnings (${total})</summary>`, '', ...lines, '', '</details>', ''];
  return ['#### Warnings', '', ...lines, ''];
}

function utc(iso: string): string {
  return iso.replace('T', ' ').replace(/\.\d+Z$|Z$/, ' UTC');
}

function distinct(values: string[]): string {
  return [...new Set(values)].join(' / ');
}

/** One user agent, or one per viewport when they differ (mobile viewports send a phone's). */
function userAgents(pairs: Array<[string, string]>): string {
  const byViewport = new Map<string, string>();
  for (const [viewport, ua] of pairs) if (!byViewport.has(viewport)) byViewport.set(viewport, ua);
  const unique = [...new Set(byViewport.values())];
  if (unique.length === 1) return code(unique[0]);
  return [...byViewport].map(([viewport, ua]) => `${viewport} ${code(ua)}`).join('; ');
}

/** One row value per side, summarizing that side's fingerprints across captures. */
function settingsRows(report: Report, side: 'base' | 'head'): Array<[string, string]> | undefined {
  const captures = report.captures.filter((c) => c.fingerprint?.[side]);
  if (captures.length === 0) return undefined;
  const fps = captures.map((c) => c.fingerprint![side]!);
  const viewports = new Map<string, string>();
  for (const c of captures) {
    const v = c.fingerprint![side]!.viewport;
    if (!viewports.has(c.viewport)) viewports.set(c.viewport, `${c.viewport} ${v.width}×${v.height} @${v.deviceScaleFactor}x${v.isMobile ? ' mobile' : ''}`);
  }
  const union = (pick: (f: (typeof fps)[number]) => string[]) => [...new Set(fps.flatMap(pick))].sort();
  const loaded = union((f) => f.fonts.loaded);
  const failed = union((f) => f.fonts.failed);
  const pending = union((f) => f.fonts.pending);
  const fonts = [loaded.length ? loaded.join(', ') : 'none', failed.length && `failed: ${failed.join(', ')}`, pending.length && `still loading: ${pending.join(', ')}`].filter(Boolean).join('; ');
  const commit = fps.find((f) => f.commit)?.commit;
  const frozen = distinct(
    fps.map((f) =>
      [f.freeze.clock ? `clock ${utc(f.freeze.clock)}` : 'clock running', f.freeze.seed === null ? 'not seeded' : `seed ${f.freeze.seed}`, f.freeze.animations ? 'animations off' : 'animations on', f.freeze.fonts ? 'fonts awaited' : 'fonts not awaited'].join(' · '),
    ),
  );
  const schemes = [...new Set(fps.map((f) => f.media.colorScheme))].join('/');
  const media = distinct(fps.map((f) => [f.media.reducedMotion === 'reduce' ? 'reduced motion' : 'motion allowed', schemes, f.media.locale, f.media.timezone].join(' · ')));
  return [
    ['Commit', commit ? code(commit.slice(0, 7)) : 'deployed preview'],
    ['Viewports', [...viewports.values()].join(' · ')],
    ['Browser', distinct(fps.map((f) => `${f.browser.name} ${f.browser.version}`))],
    ['Web fonts', fonts],
    ['Frozen', frozen],
    ['Media', media],
    ['Test data', distinct(fps.map((f) => f.data))],
    ['User agent', userAgents(captures.map((c) => [c.viewport, c.fingerprint![side]!.browser.userAgent]))],
  ];
}

/** Collapsed table of what base and head were captured with (the fingerprints), "same" where head matches. */
export function captureSettingsSection(report: Report): string[] {
  const base = settingsRows(report, 'base');
  const head = settingsRows(report, 'head');
  if (!base && !head) return [];
  const rows = (base ?? head)!.map(([label], i) => [label, base?.[i][1] ?? '—', head?.[i][1] ?? '—'] as const);
  const table = rows
    .filter(([label]) => label !== 'User agent')
    .map(([label, b, h]) => `| ${label} | ${cell(b)} | ${label !== 'Commit' && h === b ? 'same' : cell(h)} |`);
  const [, uaBase, uaHead] = rows.find(([label]) => label === 'User agent')!;
  const ua = uaBase === uaHead ? `User agent: ${uaBase}` : `User agent: base ${uaBase}; head ${uaHead}`;
  return ['<details><summary>Capture settings</summary>', '', '| | Base | Head |', '|---|---|---|', ...table, '', `<sub>${ua}</sub>`, '', '</details>', ''];
}

/** A measured duration for people: 0.3s, 3.2s, 41s, 1m 12s. */
export function duration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function sideSteps(t: SideTiming): string[] {
  if (t.mode === 'url') return ['deployed preview'];
  return [
    t.checkoutMs !== undefined ? `checkout ${duration(t.checkoutMs)}` : '',
    t.install ? `install ${duration(t.install.ms)} (${t.install.kind}${t.install.retried ? ', after a failed start' : ''})` : '',
    t.buildMs !== undefined ? `build ${duration(t.buildMs)}` : '',
    t.bootMs !== undefined ? `boot ${duration(t.bootMs)}` : '',
  ].filter(Boolean);
}

function sideBrief(t: SideTiming): string {
  if (t.mode === 'url') return 'deployed preview';
  return [t.install && `${t.install.kind} ${duration(t.install.ms)}`, t.buildMs !== undefined && `build ${duration(t.buildMs)}`, t.bootMs !== undefined && `boot ${duration(t.bootMs)}`].filter(Boolean).join(', ');
}

const EXTRA_LABELS: Array<[keyof NonNullable<Timings['extras']>, string, string]> = [
  ['variantsMs', 'variants', 'variant screenshots'],
  ['motionMs', 'motion', 'motion clips'],
  ['a11yMs', 'a11y', 'axe and focus order (during capture) and the delta'],
  ['tokensMs', 'tokens', 'style snapshots (during capture) and the audit'],
];

/** The whole run on one line; every number is measured. */
export function timingLine(t: Timings): string {
  const parts = [`⏱ ${duration(t.totalMs)} total`, `detect ${duration(t.detectMs)}`];
  if (t.prepare) parts.push(`prepare ${duration(t.prepare.wallMs)} (base: ${sideBrief(t.prepare.base)} ‖ head: ${sideBrief(t.prepare.head)})`);
  if (t.browserMs !== undefined) parts.push(`browser ${duration(t.browserMs)}`);
  if (t.capture) parts.push(`capture ${duration(t.capture.ms)} (${t.capture.count} screenshot${t.capture.count === 1 ? '' : 's'}${t.capture.slowest ? `, slowest ${duration(t.capture.slowest.ms)}` : ''})`);
  if (t.diffMs !== undefined) parts.push(`diff ${duration(t.diffMs)}`);
  for (const [key, label] of EXTRA_LABELS) if (t.extras?.[key] !== undefined) parts.push(`${label} ${duration(t.extras[key]!)}`);
  return parts.join(' · ');
}

/** timingLine as the summary of a collapsed table with one row per phase. */
export function timingSection(t: Timings): string[] {
  const rows: Array<[string, number, string]> = [['detect', t.detectMs, 'changed files → routes']];
  if (t.prepare) {
    rows.push(['base', t.prepare.base.totalMs, sideSteps(t.prepare.base).join(' · ')], ['head', t.prepare.head.totalMs, sideSteps(t.prepare.head).join(' · ')]);
    rows.push(['prepare', t.prepare.wallMs, 'base and head at the same time (wall clock)']);
  }
  if (t.browserMs !== undefined) rows.push(['browser', t.browserMs, 'Chromium check and launch']);
  if (t.capture) {
    const slowest = t.capture.slowest ? ` · slowest ${code(t.capture.slowest.id)} (${t.capture.slowest.side}) ${duration(t.capture.slowest.ms)}` : '';
    rows.push(['capture', t.capture.ms, `${t.capture.count} screenshots${slowest}`]);
  }
  if (t.diffMs !== undefined) rows.push(['diff', t.diffMs, 'pixel diffs and composites']);
  for (const [key, label, note] of EXTRA_LABELS) if (t.extras?.[key] !== undefined) rows.push([label, t.extras[key]!, note]);
  rows.push(['total', t.totalMs, 'wall clock until the report was written']);
  return [`<details><summary>${timingLine(t)}</summary>`, '', '| Phase | Time | |', '|---|---|---|', ...rows.map(([phase, ms, note]) => `| ${phase} | ${duration(ms)} | ${cell(note)} |`), '', '</details>', ''];
}

function unmatchedSection(report: Report): string[] {
  const files = report.detect?.unmatched ?? [];
  if (files.length === 0) return [];
  const label = 'Changed UI files that match no route (not captured)';
  if (files.length <= 8) return [`${label}: ${files.map(code).join(', ')}`, ''];
  return [`<details><summary>${label}: ${files.length}</summary>`, '', ...files.slice(0, 100).map((f) => `- ${code(f)}`), files.length > 100 ? `- …and ${files.length - 100} more` : '', '</details>', ''];
}

function variantSection(report: Report, opts: RenderOptions): string[] {
  if (report.variants.length === 0) return [];
  const picks = extractPicks(opts.previousBody);
  const out: string[] = ['#### Variants', ''];
  for (const group of report.variants) {
    out.push(`**${code(group.route.path)} · ${group.viewport}${report.themes.length > 1 ? ` · ${group.theme}` : ''}** — compare \`?${group.param}=\` and pick one`, '');
    const width = Math.max(140, Math.min(360, Math.floor(880 / Math.max(1, group.items.length))));
    out.push('<table><tr>');
    for (const item of group.items) out.push(`<th>${escapeHtml(`${group.param}=${item.value}`)}</th>`);
    out.push('</tr><tr>');
    for (const item of group.items) {
      if (item.image && !imagesOn(opts)) {
        out.push(`<td valign="top">${img(opts, '', `${group.param}=${item.value}`)}</td>`);
      } else if (item.image) {
        const href = escapeHtml(opts.link(item.image));
        out.push(`<td valign="top"><a href="${href}">${img(opts, opts.link(item.image), `${group.route.path} ${group.param}=${item.value}`, width)}</a></td>`);
      } else {
        out.push(`<td valign="top">capture failed: ${escapeHtml(item.error ?? 'unknown')}</td>`);
      }
    }
    out.push('</tr></table>', '');
    for (const item of group.items) {
      const key = `${group.route.slug}:${group.viewport}:${group.param}=${item.value}`;
      out.push(`- [${picks.has(key) ? 'x' : ' '}] ${code(`${group.param}=${item.value}`)} <!-- ui-diff-pick:${key} -->`);
    }
    out.push('');
  }
  return out;
}

function motionSection(report: Report, opts: RenderOptions): string[] {
  if (report.motion.length === 0) return [];
  const out: string[] = ['#### Motion', ''];
  for (const clip of report.motion) {
    const steps = clip.steps.length ? clip.steps.join(', ') : 'page load';
    out.push(`**${code(clip.route.path)}** · ${clip.viewport} — ${escapeText(steps)}`, '');
    if (clip.error) {
      out.push(`> clip failed: ${clip.error}`, '');
      continue;
    }
    if (clip.gif) out.push(img(opts, opts.link(clip.gif), `${clip.route.path} motion: before and after`), '');
    for (const w of clip.warnings ?? []) out.push(`> ⚠️ ${escapeText(w)}`, '');
    const links = imagesOn(opts)
      ? [clip.webm?.base && `[before.webm](${opts.link(clip.webm.base)})`, clip.webm?.head && `[after.webm](${opts.link(clip.webm.head)})`].filter(Boolean)
      : [];
    if (links.length) out.push(links.join(' · '), '');
  }
  return out;
}

function a11ySection(report: Report, opts: RenderOptions): string[] {
  const a = report.a11y;
  if (!a) return [];
  const out: string[] = [`#### Accessibility — ${a.added.length} new, ${a.fixed.length} fixed`, ''];
  if (a.added.length === 0 && a.fixed.length === 0) out.push('No axe issues were introduced or fixed by this change.', '');
  const limit = (opts.compact ?? 0) >= 2 ? 8 : 25;
  const rows = [...a.added.map((i) => ({ kind: 'New', i })), ...a.fixed.map((i) => ({ kind: 'Fixed', i }))];
  const totals = new Map<string, number>();
  for (const id of a.audited) {
    const c = report.captures.find((x) => x.id === id);
    if (c) totals.set(c.route.path, (totals.get(c.route.path) ?? 0) + 1);
  }
  if (rows.length) {
    out.push('| | Issue | Impact | Element | Where |', '|---|---|---|---|---|');
    for (const { kind, i } of rows.slice(0, limit)) {
      const category = categorize(i.rule);
      const label = category === 'other' ? '' : ` _(${category})_`;
      out.push(`| ${kind} | [${cell(i.help)}](${i.helpUrl}) ${code(i.rule)}${label} | ${i.impact ?? '—'} | ${cell(code(i.target))} | ${cell(compressWhere(i.captures, totals))} |`);
    }
    if (rows.length > limit) out.push(`| | …and ${rows.length - limit} more in \`report.json\` | | | |`);
    out.push('');
  }
  for (const { capture, delta } of a.focus) {
    if (!delta.changed && delta.fixedOrderJumps.length === 0) continue;
    const notes: string[] = [];
    if (delta.newOrderJumps.length) notes.push(`focus now jumps against reading order: ${delta.newOrderJumps.slice(0, 3).map(escapeText).join('; ')}`);
    if (delta.reordered) notes.push('tab order of existing controls changed');
    if (delta.added.length) notes.push(`new tab stops: ${delta.added.slice(0, 5).map(escapeText).join(', ')}`);
    if (delta.removed.length) notes.push(`no longer focusable: ${delta.removed.slice(0, 5).map(escapeText).join(', ')}`);
    if (delta.renamed.length) notes.push(`accessible name changed: ${delta.renamed.slice(0, 5).map(escapeText).join(', ')}`);
    if (delta.fixedOrderJumps.length) notes.push(`fixed reading-order jumps: ${delta.fixedOrderJumps.slice(0, 3).map(escapeText).join('; ')}`);
    out.push(`**Focus order** on ${code(capture)}: ${notes.join('; ')}.`, '');
    if ((opts.compact ?? 0) < 2 && (delta.reordered || delta.newOrderJumps.length)) {
      out.push('<details><summary>Tab sequence</summary>', '', `Before: ${delta.before.map(escapeText).join(' → ')}`, '', `After: ${delta.after.map(escapeText).join(' → ')}`, '', '</details>', '');
    }
  }
  if (a.errors.length) out.push(`> axe could not run on: ${a.errors.join(', ')}`, '');
  return out;
}

function tokenSection(report: Report, opts: RenderOptions): string[] {
  const t = report.tokens;
  if (!t) return [];
  const fresh = t.findings.filter((f) => f.isNew);
  const existing = t.findings.filter((f) => !f.isNew);
  const scope = t.scope === 'changed-regions' ? 'changed areas' : 'changed screens';
  const out: string[] = [`#### Design tokens — ${fresh.length} new off-token value${fresh.length === 1 ? '' : 's'}`, ''];
  if (t.audited.length === 0) {
    out.push('No changed screens to audit.', '');
    return out;
  }
  const table = (rows: typeof t.findings, limit: number) => {
    const lines = ['| Property | Value | Nearest token | Elements |', '|---|---|---|---|'];
    for (const f of rows.slice(0, limit)) {
      const more = f.count > f.selectors.length ? ` (+${f.count - f.selectors.length})` : '';
      lines.push(`| ${f.property} | ${code(f.value)} | ${f.nearest ? code(f.nearest) : '—'} | ${cell(f.selectors.map(code).join(', '))}${more} |`);
    }
    if (rows.length > limit) lines.push(`| …${rows.length - limit} more in \`report.json\` | | | |`);
    return lines;
  };
  if (fresh.length) out.push(...table(fresh, (opts.compact ?? 0) >= 2 ? 8 : 20), '');
  else out.push(`Every audited color, spacing and type value in the ${scope} maps to a token.`, '');
  if (existing.length && (opts.compact ?? 0) < 2) {
    out.push(`<details><summary>${existing.length} off-token value${existing.length === 1 ? '' : 's'} that already existed on base</summary>`, '', ...table(existing, 15), '', '</details>', '');
  }
  if (t.skipped.length) {
    out.push(
      `**Not audited:** ${t.skipped.join(', ')}: no tokens of that kind were recognized in ${t.files.map(code).join(', ')}. Name them like \`--space-4\` / \`--font-size-sm\`, or map them with \`tokens.categories\`.`,
      '',
    );
  }
  out.push(`<sub>Audited the ${scope} of ${t.audited.length} capture${t.audited.length === 1 ? '' : 's'}.</sub>`, '');
  return out;
}

function renderOnce(report: Report, opts: RenderOptions): string {
  const compact = opts.compact ?? 0;
  const s = report.stats;
  const out: string[] = [stickyMarker(opts.id)];
  const notChecked = notCheckedReason(report);
  const counts = notChecked
    ? 'nothing checked'
    : [s.changed && `${s.changed} changed`, s.added && `${s.added} new`, s.removed && `${s.removed} removed`, s.errors && `${s.errors} failed`, `${s.unchanged} unchanged`].filter(Boolean).join(', ');
  out.push(`### ${opts.title} — ${counts}`, '');
  out.push(
    `**Base** ${code(sideLabel(report.base))} → **Head** ${code(sideLabel(report.head))} · ${report.routes.length} route${report.routes.length === 1 ? '' : 's'} · ${report.viewports.join(', ')} · ${report.themes.join(', ')}`,
    '',
  );
  const summary = opts.summary?.trim();
  if (notChecked) out.push(`> ${notCheckedNotice(notChecked)}`, '');
  if (summary || !notChecked) out.push('#### Summary', '', (summary || autoSummary(report)).trim(), '');

  const changed = report.captures.filter(isShownChange);
  const failed = report.captures.filter((c) => c.status === 'error');
  const unchanged = report.captures.filter((c) => c.status === 'unchanged');
  if (changed.length) out.push('#### Changes', '', ...changedSection(report, changed, opts));
  out.push(...captureSettingsSection(report));
  if (failed.length) {
    out.push('#### Failed captures', '');
    for (const c of failed) out.push(`- ${code(captureLabel(c, report.themes.length))}: ${c.error ?? 'unknown error'}`);
    out.push('');
  }
  if (unchanged.length && opts.showUnchanged !== false) {
    const list = unchanged.slice(0, compact >= 2 ? 10 : 60).map((c) => `- ${code(captureLabel(c, report.themes.length))}`);
    if (unchanged.length > list.length) list.push(`- …and ${unchanged.length - list.length} more`);
    out.push(`<details><summary>Unchanged (${unchanged.length})</summary>`, '', ...list, '', '</details>', '');
  }
  out.push(...variantSection(report, opts), ...motionSection(report, opts), ...a11ySection(report, opts), ...tokenSection(report, opts));
  out.push(...warningsSection(report, opts), ...unmatchedSection(report));
  const notCaptured = [...(report.detect?.skippedRoutes ?? []), ...(report.detect?.needsExample ?? []).map((n) => n.route)];
  if (notCaptured.length) out.push(`<sub>Affected but not captured: ${notCaptured.map(code).join(', ')}</sub>`, '');
  const cut = report.captures.filter((c) => c.truncated);
  if (cut.length) {
    out.push(`> ⚠️ Partial captures: only the top of ${cut.map((c) => code(captureLabel(c, report.themes.length))).join(', ')} was compared (\`capture.maxHeight\`). Changes below that line are not shown.`, '');
  }
  if (report.timings) out.push(...timingSection(report.timings));
  const footer = [`ui-diff ${report.tool.version}`, report.base.shortSha && `base ${code(report.base.shortSha)}`, report.head.shortSha && `head ${code(report.head.shortSha)}`, opts.storageNote, `generated ${report.createdAt.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}`]
    .filter(Boolean)
    .join(' · ');
  out.push(`<sub>${footer}</sub>`);
  out.push(metaLine(report));
  if (compact >= 3) out.push('', '<sub>Some details were omitted to fit GitHub’s comment size limit; see `.ui-diff/report.json`.</sub>');
  return `${out.join('\n')}\n`;
}

function metaLine(report: Report): string {
  const meta = { head: report.head.sha ?? report.head.url ?? null, base: report.base.sha ?? report.base.url ?? null, createdAt: report.createdAt };
  return `<!-- ui-diff:meta ${JSON.stringify(meta)} -->`;
}

/** One-line replacement for an existing sticky comment once the PR no longer changes UI files. */
export function noUiChangeComment(report: Report, opts: { id: string; title: string }): string {
  const head = report.head.shortSha ?? report.head.sha?.slice(0, 7) ?? report.head.label;
  return `${stickyMarker(opts.id)}\n### ${opts.title} — no UI files changed in ${code(head)}\n${metaLine(report)}\n`;
}

/** Renders the sticky PR comment, dropping detail in tiers until it fits GitHub's size limit. */
export function renderComment(report: Report, opts: RenderOptions): string {
  const max = opts.maxLength ?? MAX_COMMENT_LENGTH;
  let body = '';
  for (let compact = opts.compact ?? 0; compact <= 3; compact++) {
    body = renderOnce(report, { ...opts, compact });
    if (body.length <= max) return body;
  }
  return `${body.slice(0, max - 200)}\n\n<sub>Truncated to fit GitHub’s comment size limit.</sub>\n${stickyMarker(opts.id)}\n`;
}

/** Report-relative image paths referenced by the comment (what needs uploading). */
export function referencedImages(report: Report, opts: Omit<RenderOptions, 'link'>): string[] {
  const refs = new Set<string>();
  renderComment(report, {
    ...opts,
    maxLength: Number.MAX_SAFE_INTEGER,
    link: (p) => {
      refs.add(p);
      return p;
    },
  });
  return [...refs];
}
