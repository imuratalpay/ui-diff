import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Browser } from 'playwright';
import { diffFocusOrder, diffViolations, type A11yIssue } from './a11y.js';
import { resolveAuth, sanitizeUrl, type ResolvedAuth } from './auth.js';
import { CaptureSession, ensureBrowser, launchBrowser, resolveBrowser, routeUrl, type CaptureRecord, type CaptureTarget } from './capture.js';
import { parseVariantFlag, pickThemes, pickViewports, resolveRoute, type ResolvedConfig, type ResolvedRoute, type Step, type ThemeConfig, type VariantSpec, type ViewportConfig } from './config.js';
import { detectChanges, resolveBaseRef, type DetectResult } from './detect.js';
import { composeCompare, diffPngs, focusBoxes } from './diff.js';
import { git, gitCommonDir, mergeBase, revParse, shortSha } from './git.js';
import { COLORS, composeRow, readPng, resizeToWidth, writePng } from './image.js';
import { captureKey, keyId, type CaptureKey } from './key.js';
import { log, noteAfterError, UiDiffError, writeRedacted } from './log.js';
import { renderComment } from './markdown.js';
import { distinctFrames, encodeSideBySideGif, motionWarning, moveFile, recordFrames, writeFile, type RawFrame } from './motion.js';
import { realpathIfExists } from './paths.js';
import { autoSummary, computeStats, fingerprintDifferences, notCheckedReason, pct, REPORT_VERSION, truncationWarning, type CaptureFingerprint, type CaptureResult, type MotionResult, type Report, type SideFingerprint, type SideSummary, type Timings, type VariantGroup } from './report.js';
import { killAllServers, serverLogWarnings } from './server.js';
import { SideManager, type Side, type SideRequest } from './sides.js';
import { describeStep, runSteps } from './steps.js';
import { styleCapWarning } from './styles.js';
import { aggregateFindings, auditSnapshot, buildTokenSet, detectTokenFiles, findingKeys, hasCategory, loadTokenFiles, tokenColorStrings, type StyleSnapshot, type TokenSet } from './tokens.js';
import { onlyInUnsettled, unsettledWarning } from './unsettled.js';
import { VERSION } from './version.js';

export interface RunOptions {
  cfg: ResolvedConfig;
  outDir: string;
  base?: string;
  head?: string;
  baseUrl?: string;
  headUrl?: string;
  routes?: string[];
  allRoutes?: boolean;
  viewports?: string[];
  themes?: string[];
  variants?: string[];
  motion?: boolean;
  /** Record motion clips for routes without visual changes too. */
  motionAll?: boolean;
  tokens?: string[];
  a11y?: boolean;
  keepWorktrees?: boolean;
  /** Internal: record computed styles of every capture even without the token audit (which always records them). */
  collectStyles?: boolean;
}

export interface RunOutcome {
  report: Report;
  reportFile: string;
  previewFile: string;
  noChanges: boolean;
}

const FAILED_MARKER = 'last-run-failed.json';
// comment.preview.md comes from `render`; a new successful run makes it stale, so it is dropped with the rest.
const OUTPUT_ENTRIES = ['captures', 'diff', 'compare', 'variants', 'motion', 'styles', 'report.json', 'comment.local.md', 'comment.md', 'comment.preview.md', 'summary.auto.md', FAILED_MARKER];

export interface RunFailure {
  failedAt: string;
  error: string;
  /** `createdAt` of the report that was kept. */
  previousReport?: string;
}

function processAlive(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Creates the directory a run writes into, inside `outDir`. The previous results stay untouched
 * until `commitOutDir`; only `logs/` is reset, so it always holds the latest run, failed or not.
 */
export function stageOutDir(outDir: string): string {
  mkdirSync(outDir, { recursive: true });
  for (const entry of readdirSync(outDir)) {
    const pid = /^\.(?:run|old)-(\d+)$/.exec(entry)?.[1];
    if (pid && !processAlive(Number(pid))) rmSync(path.join(outDir, entry), { recursive: true, force: true });
  }
  rmSync(path.join(outDir, 'logs'), { recursive: true, force: true });
  const stage = path.join(outDir, `.run-${process.pid}`);
  mkdirSync(stage, { recursive: true });
  return stage;
}

/** Replaces the previous results in `outDir` with the staged ones. */
export function commitOutDir(stage: string, outDir: string): void {
  const old = path.join(outDir, `.old-${process.pid}`);
  rmSync(old, { recursive: true, force: true });
  mkdirSync(old);
  const staged = readdirSync(stage);
  for (const entry of new Set([...OUTPUT_ENTRIES, ...staged])) {
    if (existsSync(path.join(outDir, entry))) renameSync(path.join(outDir, entry), path.join(old, entry));
  }
  for (const entry of staged) renameSync(path.join(stage, entry), path.join(outDir, entry));
  rmSync(stage, { recursive: true, force: true });
  rmSync(old, { recursive: true, force: true });
}

/**
 * Leaves a note next to the kept report so `render` and `publish` can say it is not from the latest run.
 * Returns the warning to show the user, if a report was kept.
 */
export function markRunFailed(outDir: string, error: unknown): string | undefined {
  const reportFile = path.join(outDir, 'report.json');
  if (!existsSync(reportFile)) return undefined;
  let previousReport: string | undefined;
  try {
    previousReport = (JSON.parse(readFileSync(reportFile, 'utf8')) as Report).createdAt;
  } catch {
    // unreadable report: still record the failure
  }
  const failure: RunFailure = { failedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error), previousReport };
  writeRedacted(path.join(outDir, FAILED_MARKER), `${JSON.stringify(failure, null, 2)}\n`);
  const shown = path.relative(process.cwd(), outDir);
  return `kept the previous report in ${shown.startsWith('..') ? outDir : shown || '.'} (from ${previousReport ?? 'an earlier run'}); it does not include this run`;
}

export function lastRunFailure(outDir: string): RunFailure | undefined {
  const file = path.join(outDir, FAILED_MARKER);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as RunFailure;
  } catch {
    return { failedAt: 'unknown', error: 'unknown error' };
  }
}

/** Keeps the output directory out of `git status` without touching tracked files. */
export async function excludeFromGit(repoRoot: string, outDir: string): Promise<void> {
  // Both sides resolved: on macOS a /tmp or /var path and its /private target would differ.
  const rel = path.relative(realpathIfExists(repoRoot), realpathIfExists(outDir)).split(path.sep).join('/');
  if (!rel || rel.startsWith('..')) return;
  try {
    const exclude = path.join(await gitCommonDir(repoRoot), 'info', 'exclude');
    const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    const line = `/${rel}/`;
    if (!current.split('\n').includes(line)) {
      mkdirSync(path.dirname(exclude), { recursive: true });
      appendFileSync(exclude, `${current.endsWith('\n') || !current ? '' : '\n'}# ui-diff output\n${line}\n`);
    }
  } catch {
    // not fatal
  }
}

function sideSummary(side: Side): SideSummary {
  return { label: side.label, mode: side.mode, sha: side.sha, shortSha: side.shortSha, ref: side.ref, url: side.mode === 'url' ? sanitizeUrl(side.url) : undefined, includesUncommitted: side.includesUncommitted };
}

function captureId(route: ResolvedRoute, viewport: ViewportConfig, theme: ThemeConfig, variant?: CaptureKey['variant']): string {
  return keyId(captureKey(route, viewport, theme, variant));
}

function rel(outDir: string, file: string): string {
  return path.relative(outDir, file).split(path.sep).join('/');
}

interface Plan {
  route: ResolvedRoute;
  viewport: ViewportConfig;
  theme: ThemeConfig;
  key: CaptureKey;
  /** `keyId(key)`: the capture id in the report and the stem of its file names. */
  id: string;
  a11y: boolean;
  focus: boolean;
}

/** Where base and head come from, after detection. */
interface Detected {
  detection?: DetectResult;
  baseUrl?: string;
  headUrl?: string;
  baseRequest: SideRequest;
  headRequest: SideRequest;
}

/** What will be captured and with which extras; no app is running yet. */
interface Prepared {
  routes: ResolvedRoute[];
  viewports: ViewportConfig[];
  themes: ThemeConfig[];
  plans: Plan[];
  reportBase: Omit<Report, 'base' | 'head' | 'captures' | 'variants' | 'motion' | 'warnings' | 'stats'>;
  motionOn: boolean;
  a11yOn: boolean;
  tokens?: { set: TokenSet; files: string[] };
  stylesOn: boolean;
  auth?: ResolvedAuth;
}

interface Booted {
  base: Side;
  head: Side;
  browser: Browser;
  session: CaptureSession;
  /** Wall-clock time of preparing base and head together. */
  prepareMs: number;
  browserMs: number;
}

function since(start: number): number {
  return Math.round(performance.now() - start);
}

function slowestCapture(records: Map<string, CaptureRecord>): NonNullable<Timings['capture']>['slowest'] {
  let slowest: CaptureRecord | undefined;
  for (const r of records.values()) if (!slowest || r.durationMs > slowest.durationMs) slowest = r;
  return slowest && { id: slowest.id, side: slowest.side, ms: slowest.durationMs };
}

async function selectRoutes(opts: RunOptions, detection: DetectResult | undefined): Promise<ResolvedRoute[]> {
  const { cfg } = opts;
  if (opts.routes?.length) {
    return opts.routes.map((p) => cfg.routes.find((r) => r.path === p) ?? resolveRoute(p, cfg.dirRel, false));
  }
  if (opts.allRoutes || !detection) {
    if (cfg.routes.length === 0) throw new UiDiffError('No routes to capture', { hint: 'Pass --routes "/,/pricing" or add "routes" to ui-diff.config.json.' });
    return cfg.routes;
  }
  return detection.routes.map((h) => h.route);
}

function variantSpecs(opts: RunOptions, routes: ResolvedRoute[]): Map<string, VariantSpec> {
  const specs = new Map<string, VariantSpec>();
  if (!opts.cfg.variants.enabled && !opts.variants?.length) return specs;
  if (opts.cfg.variants.enabled) for (const r of routes) if (r.variants) specs.set(r.path, r.variants);
  for (const flag of opts.variants ?? []) {
    const { route, spec } = parseVariantFlag(flag);
    const targets = route ? routes.filter((r) => r.path === route) : routes;
    if (route && targets.length === 0) throw new UiDiffError(`--variants targets ${route}, which is not among the captured routes`);
    for (const r of targets) specs.set(r.path, { ...r.variants, ...spec, viewports: r.variants?.viewports, themes: r.variants?.themes });
  }
  return specs;
}

/** Runs into a staging directory and swaps the results in only on success, so a failed run keeps the previous report. */
export async function runPipeline(opts: RunOptions): Promise<RunOutcome> {
  const stage = stageOutDir(opts.outDir);
  await excludeFromGit(opts.cfg.repoRoot, opts.outDir);
  try {
    const outcome = await runStaged({ ...opts, outDir: stage }, opts.outDir);
    commitOutDir(stage, opts.outDir);
    const final = (file: string) => path.join(opts.outDir, path.relative(stage, file));
    return { ...outcome, reportFile: final(outcome.reportFile), previewFile: final(outcome.previewFile) };
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    const kept = markRunFailed(opts.outDir, error);
    if (kept) noteAfterError(error, kept);
    throw error;
  }
}

/** `opts.outDir` is the staging directory; server logs go to `finalDir/logs`, where error hints point. */
async function runStaged(opts: RunOptions, finalDir: string): Promise<RunOutcome> {
  const { cfg, outDir } = opts;
  const runStart = new Date();
  const started = performance.now();
  const warnings: string[] = [];
  const detected = await detectStage(opts, warnings);
  const detectMs = since(started);
  const prepared = await prepareStage(opts, detected, runStart);
  if (prepared.routes.length === 0) {
    const report = await emptyReport(cfg, prepared, detected, warnings);
    report.timings = { totalMs: since(started), detectMs };
    return writeOutputs(report, outDir, true);
  }

  const sides = new SideManager(cfg, { outDir: finalDir, keepWorktrees: opts.keepWorktrees });
  const onSignal = () => {
    killAllServers();
    sides.cleanupSync();
    rmSync(outDir, { recursive: true, force: true });
    const kept = markRunFailed(finalDir, 'interrupted');
    if (kept) log.warn(kept);
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  let booted: Booted | undefined;
  try {
    booted = await bootStage(sides, detected, prepared, { cfg, runStart });
    const { base, head } = booted;
    const captureStart = performance.now();
    const records = await captureStage(booted, prepared, outDir);
    const captureMs = since(captureStart);
    const diffStart = performance.now();
    const captures = diffStage(prepared.plans, records, { base, head, cfg, outDir });
    const diffMs = since(diffStart);
    const { extras, timings: extrasTimings } = await extrasStage(opts, booted, prepared, captures, records);
    const cutWarning = truncationWarning(captures, cfg.capture.maxHeight);
    if (cutWarning) warnings.push(cutWarning);
    for (const side of [base, head]) if (side.server) warnings.push(...serverLogWarnings(side.server.logFile, side.name));
    const report: Report = {
      ...prepared.reportBase,
      base: sideSummary(base),
      head: sideSummary(head),
      captures,
      ...extras,
      warnings,
      stats: computeStats(captures),
    };
    report.timings = {
      totalMs: since(started),
      detectMs,
      prepare: { wallMs: booted.prepareMs, base: base.timings, head: head.timings },
      browserMs: booted.browserMs,
      capture: { ms: captureMs, count: records.size, slowest: slowestCapture(records) },
      diffMs,
      extras: extrasTimings,
    };
    return writeOutputs(report, outDir, false);
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await booted?.browser.close().catch(() => undefined);
    await sides.cleanup();
  }
}

/** Detection (changed files → routes) and the refs or URLs each side is built from. */
async function detectStage(opts: RunOptions, warnings: string[]): Promise<Detected> {
  const { cfg } = opts;
  const baseUrl = opts.baseUrl ?? cfg.preview.base;
  const headUrl = opts.headUrl ?? cfg.preview.head;
  let detection: DetectResult | undefined;
  let baseRequest: SideRequest = { name: 'base', url: baseUrl };
  let headRequest: SideRequest = { name: 'head', url: headUrl };

  const wantsDetect = !opts.routes?.length && !opts.allRoutes;
  const canDetect = !baseUrl || !headUrl || Boolean(opts.base);
  if (wantsDetect && canDetect) {
    log.step('detecting changed UI files');
    detection = await detectChanges(cfg, { base: opts.base, head: opts.head });
    log.info(`${detection.uiFiles.length} UI file(s) changed → ${detection.routes.length} route(s): ${detection.routes.map((r) => r.route.path).join(', ') || 'none'}`);
    for (const note of detection.notes) warnings.push(note);
  }
  if (!baseUrl) {
    const baseRef = await resolveBaseRef(cfg.repoRoot, opts.base);
    const baseSha = await revParse(baseRef, cfg.repoRoot);
    const headSha = await revParse(opts.head ?? 'HEAD', cfg.repoRoot);
    const mb = detection?.mergeBase ?? (await mergeBase(baseSha, headSha, cfg.repoRoot));
    baseRequest = { name: 'base', ref: mb, displayRef: baseRef };
  }
  if (!headUrl) headRequest = opts.head ? { name: 'head', ref: opts.head, displayRef: opts.head } : { name: 'head', workingTree: true };
  return { detection, baseUrl, headUrl, baseRequest, headRequest };
}

/** Routes, viewports, themes, the capture plan, token set and credentials. Runs nothing. */
async function prepareStage(opts: RunOptions, detected: Detected, runStart: Date): Promise<Prepared> {
  const { cfg } = opts;
  const { detection } = detected;
  const routes = await selectRoutes(opts, detection);
  const viewports = pickViewports(cfg, opts.viewports);
  const themes = pickThemes(cfg, opts.themes);
  const reportBase: Prepared['reportBase'] = {
    version: REPORT_VERSION,
    tool: { name: 'ui-diff' as const, version: VERSION },
    createdAt: runStart.toISOString(),
    routes: routes.map((r) => {
      const hit = detection?.routes.find((h) => h.route.path === r.path);
      return { path: r.path, name: r.name, reasons: hit?.reasons ?? [opts.routes?.length ? 'requested' : 'configured'], confidence: hit?.confidence ?? 'high' };
    }),
    detect: detection
      ? {
          uiFiles: detection.uiFiles,
          unmatched: detection.unmatched,
          skippedRoutes: detection.skippedRoutes.map((h) => h.route.path),
          needsExample: detection.needsExample,
          notes: detection.notes,
          ...(detection.dependencies.length ? { dependencies: detection.dependencies } : {}),
          ...(detection.unparsedLockfiles.length ? { unparsedLockfiles: detection.unparsedLockfiles } : {}),
        }
      : undefined,
    viewports: viewports.map((v) => v.name),
    themes: themes.map((t) => t.name),
  };
  const motionOn = cfg.motion.enabled || Boolean(opts.motion);
  const a11yOn = cfg.a11y.enabled || Boolean(opts.a11y);
  if (routes.length === 0) return { routes, viewports, themes, plans: [], reportBase, motionOn, a11yOn, stylesOn: false };

  const tokens = cfg.tokens.enabled || Boolean(opts.tokens?.length) ? await loadTokens(opts) : undefined;
  const previewUrls = [detected.baseUrl, detected.headUrl].filter((u): u is string => Boolean(u));
  const auth = previewUrls.length || cfg.auth?.origins?.length ? resolveAuth(cfg.auth, previewUrls) : undefined;
  if (cfg.auth && !auth && previewUrls.length === 0) log.debug('auth configured but both sides run locally; credentials not used');
  return { routes, viewports, themes, plans: planCaptures(cfg, routes, viewports, themes, a11yOn), reportBase, motionOn, a11yOn, tokens, stylesOn: Boolean(tokens) || Boolean(opts.collectStyles), auth };
}

async function loadTokens(opts: RunOptions): Promise<{ set: TokenSet; files: string[] }> {
  const { cfg } = opts;
  const requested = (opts.tokens ?? []).filter((f) => f !== 'auto');
  let files = (requested.length ? requested.map((f) => realpathIfExists(path.resolve(process.cwd(), f))) : cfg.tokens.files.map((f) => path.resolve(cfg.dir, f))).filter(Boolean);
  if (files.length === 0) {
    const tracked = (await git(['ls-files', '-z'], { cwd: cfg.dir })).split('\0').filter(Boolean);
    files = detectTokenFiles(cfg.dir, tracked).map((f) => path.join(cfg.dir, f));
    if (files.length) log.info(`auto-detected token files: ${files.map((f) => path.relative(cfg.repoRoot, f)).join(', ')}`);
  }
  if (files.length === 0) throw new UiDiffError('Token audit is enabled but no token files were configured or found', { hint: 'Set tokens.files in ui-diff.config.json or pass --tokens path/to/tokens.json (JSON, CSS or StyleX *.stylex.ts)' });
  const set = buildTokenSet(loadTokenFiles(files), cfg.tokens.remBase, cfg.tokens.categories);
  log.info(`loaded ${set.values.length} design tokens from ${files.map((f) => path.relative(cfg.repoRoot, f)).join(', ')}`);
  return { set, files };
}

function planCaptures(cfg: ResolvedConfig, routes: ResolvedRoute[], viewports: ViewportConfig[], themes: ThemeConfig[], a11yOn: boolean): Plan[] {
  const plans: Plan[] = [];
  for (const route of routes) {
    const vps = route.viewports ? viewports.filter((v) => route.viewports!.includes(v.name)) : viewports;
    const ths = route.themes ? themes.filter((t) => route.themes!.includes(t.name)) : themes;
    for (const viewport of vps) {
      for (const theme of ths) {
        const a11y = a11yOn && (!cfg.a11y.viewports || cfg.a11y.viewports.includes(viewport.name)) && (!cfg.a11y.themes || cfg.a11y.themes.includes(theme.name));
        const key = captureKey(route, viewport, theme);
        plans.push({ route, viewport, theme, key, id: keyId(key), a11y, focus: a11y && cfg.a11y.focusOrder && theme.name === ths[0].name });
      }
    }
  }
  return plans;
}

/** Report for a run that captured nothing (no route was affected or selected). */
async function emptyReport(cfg: ResolvedConfig, prepared: Prepared, detected: Detected, warnings: string[]): Promise<Report> {
  const { baseRequest, headRequest, detection } = detected;
  const shas = async (sha: string | undefined) => (sha ? { sha, shortSha: await shortSha(sha, cfg.repoRoot) } : {});
  const report: Report = {
    ...prepared.reportBase,
    base: { label: baseRequest.ref ?? baseRequest.url ?? 'base', mode: baseRequest.url ? 'url' : 'worktree', ...(await shas(baseRequest.ref)) },
    head: { label: headRequest.ref ?? headRequest.url ?? 'working tree', mode: headRequest.url ? 'url' : 'worktree', ...(await shas(detection?.head.sha)) },
    captures: [],
    variants: [],
    motion: [],
    warnings,
    stats: computeStats([]),
  };
  report.notChecked = notCheckedReason(report);
  return report;
}

/** Worktrees, installs and dev servers (or preview URLs) for both sides, then the browser. */
async function bootStage(sides: SideManager, detected: Detected, prepared: Prepared, ctx: { cfg: ResolvedConfig; runStart: Date }): Promise<Booted> {
  const ensureStart = performance.now();
  const choice = resolveBrowser(ctx.cfg.browser.channel);
  await ensureBrowser(choice);
  let browserMs = since(ensureStart);
  const prepareStart = performance.now();
  const results = await Promise.allSettled([sides.prepare(detected.baseRequest), sides.prepare(detected.headRequest)]);
  const prepareMs = since(prepareStart);
  const failed = results.find((p): p is PromiseRejectedResult => p.status === 'rejected');
  if (failed) throw failed.reason;
  const [base, head] = results.map((p) => (p as PromiseFulfilledResult<Side>).value);
  log.info(`base: ${base.label} (${base.mode}) · head: ${head.label} (${head.mode})`);
  const launchStart = performance.now();
  const browser = await launchBrowser(choice);
  browserMs += since(launchStart);
  log.info(`browser: ${choice.label} ${browser.version()}`);
  return { base, head, browser, session: new CaptureSession(browser, { cfg: ctx.cfg, auth: prepared.auth, runStart: ctx.runStart, browserLabel: choice.label }), prepareMs, browserMs };
}

/** Screenshots (and style, axe and focus-order data) of every plan on both sides, keyed `<side>:<id>`. */
async function captureStage(booted: Booted, prepared: Prepared, outDir: string): Promise<Map<string, CaptureRecord>> {
  const { plans, stylesOn, tokens } = prepared;
  const records = new Map<string, CaptureRecord>();
  const extraColors = tokens ? tokenColorStrings(tokens.set) : [];
  let n = 0;
  for (const plan of plans) {
    for (const side of [booted.base, booted.head]) {
      n++;
      const target: CaptureTarget = {
        id: plan.id,
        side: side.name,
        route: plan.route,
        viewport: plan.viewport,
        theme: plan.theme,
        url: routeUrl(side.url, plan.route.path, plan.theme.query),
        file: path.join(outDir, 'captures', side.name, `${plan.id}.png`),
        styles: stylesOn ? { file: path.join(outDir, 'styles', side.name, `${plan.id}.json`), extraColors } : undefined,
        a11y: plan.a11y,
        focusOrder: plan.focus,
      };
      log.step(`capture ${n}/${plans.length * 2}: ${side.name} ${plan.route.path} (${plan.viewport.name}, ${plan.theme.name})`);
      const record = await booted.session.capture(target);
      if (!record.ok) log.warn(`${side.name} ${plan.id}: ${record.error}`);
      else if (!record.stable || record.unsettled) log.warn(unsettledWarning(`${side.name} ${plan.id}`, record));
      for (const action of record.skippedActions ?? []) log.warn(`${plan.id}: ${skippedActionWarning(side.name, action)}`);
      records.set(`${side.name}:${plan.id}`, record);
    }
  }
  return records;
}

/** Pixel diffs and composites per plan, plus the warnings each side's capture left. */
function diffStage(plans: Plan[], records: Map<string, CaptureRecord>, ctx: { base: Side; head: Side; cfg: ResolvedConfig; outDir: string }): CaptureResult[] {
  const { cfg } = ctx;
  const captures = plans.map((plan) => compareCapture(plan, records.get(`base:${plan.id}`)!, records.get(`head:${plan.id}`)!, ctx));
  for (const c of captures) {
    const b = records.get(`base:${c.id}`);
    const h = records.get(`head:${c.id}`);
    for (const [label, r] of [['base', b], ['head', h]] as const) {
      for (const action of r?.skippedActions ?? []) c.warnings.push(skippedActionWarning(label, action));
      if (r?.stylesCapped) c.warnings.push(styleCapWarning(label, cfg.capture.styleMaxElements));
      if (r?.pageErrors.length) c.warnings.push(`${label}: uncaught page error: ${r.pageErrors[0]}`);
      if (r && r.ok && (!r.stable || r.unsettled)) c.warnings.push(unsettledWarning(label, r));
    }
    if (b?.truncated || h?.truncated) {
      c.truncated = true;
      c.warnings.push(`page is taller than capture.maxHeight (${cfg.capture.maxHeight}px); only the top part was compared`);
    }
  }
  return captures;
}

/** Variants, motion clips, the token audit and the accessibility delta, with how long each took. */
async function extrasStage(
  opts: RunOptions,
  booted: Booted,
  prepared: Prepared,
  captures: CaptureResult[],
  records: Map<string, CaptureRecord>,
): Promise<{ extras: Pick<Report, 'variants' | 'motion' | 'motionSkipped' | 'tokens' | 'a11y'>; timings: NonNullable<Timings['extras']> }> {
  const { cfg, outDir } = opts;
  const { routes, viewports, themes } = prepared;
  const { session, base, head } = booted;
  const timings: NonNullable<Timings['extras']> = {};
  const sum = (pick: (r: CaptureRecord) => number | undefined) => [...records.values()].reduce((n, r) => n + (pick(r) ?? 0), 0);

  let start = performance.now();
  const specs = variantSpecs(opts, routes);
  const variants = await captureVariants(session, { routes, viewports, themes, head, outDir, cfg, specs });
  if (specs.size) timings.variantsMs = since(start);
  const changedRoutes = new Set(captures.filter((c) => c.status === 'changed' || c.status === 'added' || c.status === 'removed').map((c) => c.route.path));
  const motionSkipped: string[] = [];
  let motion: MotionResult[] = [];
  if (prepared.motionOn) {
    start = performance.now();
    motion = await captureMotion(session, { routes, viewports, themes, base, head, outDir, cfg, explicit: Boolean(opts.motion), all: cfg.motion.all || Boolean(opts.motionAll), changedRoutes, skipped: motionSkipped });
    timings.motionMs = since(start);
  }
  let tokens: Report['tokens'];
  if (prepared.tokens) {
    start = performance.now();
    tokens = auditTokens(captures, { outDir, tokenSet: prepared.tokens.set, cfg, files: prepared.tokens.files });
    timings.tokensMs = since(start) + sum((r) => r.stylesMs);
  }
  let a11y: Report['a11y'];
  if (prepared.a11yOn) {
    start = performance.now();
    a11y = a11yDelta(captures, prepared.plans, records, cfg);
    timings.a11yMs = since(start) + sum((r) => r.a11yMs);
  }
  return { extras: { variants, motion, motionSkipped: motionSkipped.length ? motionSkipped : undefined, tokens, a11y }, timings };
}

function captureFingerprint(baseRec: CaptureRecord, headRec: CaptureRecord, ctx: { base: Side; head: Side; cfg: ResolvedConfig }): CaptureFingerprint | undefined {
  const side = (rec: CaptureRecord, s: Side): SideFingerprint | undefined =>
    rec.environment ? { ...(s.sha ? { commit: s.sha } : {}), ...rec.environment, data: ctx.cfg.fingerprint.dataLabel ?? 'not declared' } : undefined;
  const base = side(baseRec, ctx.base);
  const head = side(headRec, ctx.head);
  if (!base && !head) return undefined;
  return { base, head, differences: base && head ? fingerprintDifferences(base, head) : [] };
}

export function skippedActionWarning(side: string, action: string): string {
  return `${side}: route action "${action}" skipped: no element matches it on ${side}`;
}

/** Comparing two error pages says nothing about the UI, so HTTP errors fail the capture. */
export function httpProblem(side: 'base' | 'head', status: number | undefined): string | undefined {
  if (status === undefined || status < 400) return undefined;
  if (status === 401 || status === 403) return `${side} returned HTTP ${status} (protected page? configure auth.headers / auth.cookies)`;
  if (status === 404 || status === 410) return `${side} returned HTTP ${status} (check the route path)`;
  return `${side} returned HTTP ${status}`;
}

function compareCapture(plan: Plan, baseRec: CaptureRecord, headRec: CaptureRecord, ctx: { base: Side; head: Side; cfg: ResolvedConfig; outDir: string }): CaptureResult {
  const { cfg, outDir } = ctx;
  const result: CaptureResult = {
    id: plan.id,
    route: { path: plan.route.path, name: plan.route.name, slug: plan.route.slug },
    viewport: plan.viewport.name,
    theme: plan.theme.name,
    status: 'error',
    urls: {
      base: ctx.base.mode === 'url' ? sanitizeUrl(routeUrl(ctx.base.url, plan.route.path, plan.theme.query)) : undefined,
      head: ctx.head.mode === 'url' ? sanitizeUrl(routeUrl(ctx.head.url, plan.route.path, plan.theme.query)) : undefined,
    },
    images: { focus: [] },
    warnings: [],
    truncated: false,
  };
  result.fingerprint = captureFingerprint(baseRec, headRec, ctx);
  if (baseRec.file) result.images.base = rel(outDir, baseRec.file);
  if (headRec.file) result.images.head = rel(outDir, headRec.file);
  const missing = (r: CaptureRecord) => r.httpStatus === 404 || r.httpStatus === 410;
  if (!baseRec.ok || !headRec.ok) {
    result.error = [!baseRec.ok && `base: ${baseRec.error}`, !headRec.ok && `head: ${headRec.error}`].filter(Boolean).join('; ');
    return result;
  }
  if (missing(baseRec) && !missing(headRec) && (headRec.httpStatus ?? 200) < 400) {
    result.status = 'added';
    return result;
  }
  if (!missing(baseRec) && missing(headRec) && (baseRec.httpStatus ?? 200) < 400) {
    result.status = 'removed';
    return result;
  }
  const httpErrors = [httpProblem('base', baseRec.httpStatus), httpProblem('head', headRec.httpStatus)].filter(Boolean);
  if (httpErrors.length) {
    result.error = httpErrors.join('; ');
    return result;
  }
  const scale = headRec.scale ?? baseRec.scale ?? 1;
  if (baseRec.scale !== undefined && headRec.scale !== undefined && baseRec.scale !== headRec.scale) {
    result.warnings.push(`base and head rendered at different device pixel ratios (${baseRec.scale}× and ${headRec.scale}×); sizes use head's`);
  }
  const diff = diffPngs(readPng(baseRec.file!), readPng(headRec.file!), {
    threshold: cfg.diff.threshold,
    includeAA: cfg.diff.includeAA,
    minChangedPixels: cfg.diff.minChangedPixels,
    highlight: cfg.diff.highlightColor,
    scale,
    alignShifts: cfg.diff.alignShifts,
  });
  const css = (n: number) => Math.round(n / scale);
  result.status = diff.changed ? 'changed' : 'unchanged';
  result.diff = {
    changedPixels: diff.changedPixels,
    ratio: diff.ratio,
    regions: diff.regions,
    scale,
    sizeBefore: [diff.before.width, diff.before.height],
    sizeAfter: [diff.after.width, diff.after.height],
    sizeChanged: diff.sizeChanged,
  };
  if (diff.shifted.length) result.diff.shifted = diff.shifted.map((r) => ({ beforeY: css(r.beforeY), afterY: css(r.afterY), height: css(r.height), dy: css(r.dy) }));
  if (diff.removedRows) result.diff.removedHeight = css(diff.removedRows);
  if (!diff.changed) return result;
  if (onlyInUnsettled(diff.regions, [...(baseRec.unsettled ?? []), ...(headRec.unsettled ?? [])], scale)) {
    result.warnings.push('every difference is inside an area that kept changing by itself (see "page did not settle"), so it is probably not caused by this change');
  }
  const labels = {
    before: `BEFORE ${ctx.base.shortSha ?? 'BASE'}`,
    after: `AFTER ${ctx.head.shortSha ?? 'HEAD'}`,
    diff: `DIFF ${pct(diff.ratio)}`,
  };
  const diffFile = path.join(outDir, 'diff', `${plan.id}.png`);
  writePng(diffFile, diff.diffImage);
  result.images.diff = rel(outDir, diffFile);
  const compareFile = path.join(outDir, 'compare', `${plan.id}.png`);
  writePng(compareFile, composeCompare(diff, labels, { maxWidth: cfg.diff.compositeMaxWidth }));
  result.images.compare = rel(outDir, compareFile);
  const boxes = focusBoxes(diff.regions, diff.width, diff.height, { max: cfg.diff.maxFocusCrops, padding: cfg.diff.focusPadding * scale, scale });
  if (boxes.length) result.diff.focusBoxes = boxes.map((b) => ({ x: css(b.x), y: css(b.y), width: css(b.width), height: css(b.height) }));
  boxes.forEach((box, i) => {
    const file = path.join(outDir, 'compare', `${plan.id}__focus-${i + 1}.png`);
    writePng(file, composeCompare(diff, labels, { box, maxWidth: cfg.diff.compositeMaxWidth, upscaleBelow: 360 * scale }));
    result.images.focus.push(rel(outDir, file));
  });
  return result;
}

async function captureVariants(
  session: CaptureSession,
  ctx: { routes: ResolvedRoute[]; viewports: ViewportConfig[]; themes: ThemeConfig[]; head: Side; outDir: string; cfg: ResolvedConfig; specs: Map<string, VariantSpec> },
): Promise<VariantGroup[]> {
  const groups: VariantGroup[] = [];
  for (const route of ctx.routes) {
    const spec = ctx.specs.get(route.path);
    if (!spec) continue;
    const vps = spec.viewports ? ctx.viewports.filter((v) => spec.viewports!.includes(v.name)) : ctx.viewports;
    const ths = spec.themes ? ctx.themes.filter((t) => spec.themes!.includes(t.name)) : ctx.themes.slice(0, 1);
    for (const viewport of vps) {
      for (const theme of ths) {
        const id = captureId(route, viewport, theme, { param: spec.param });
        const group: VariantGroup = { id, route: { path: route.path, name: route.name, slug: route.slug }, param: spec.param, viewport: viewport.name, theme: theme.name, items: [] };
        for (const value of spec.values) {
          log.step(`variant ${route.path} ${spec.param}=${value} (${viewport.name}, ${theme.name})`);
          const file = path.join(ctx.outDir, 'variants', `${captureId(route, viewport, theme, { param: spec.param, value })}.png`);
          const record = await session.capture({
            id: `${id}=${value}`,
            side: 'head',
            route,
            viewport,
            theme,
            url: routeUrl(ctx.head.url, route.path, { ...theme.query, [spec.param]: value }),
            file,
          });
          const problem = httpProblem('head', record.httpStatus);
          group.items.push(record.ok && !problem ? { value, image: rel(ctx.outDir, file) } : { value, error: record.error ?? problem });
        }
        const images = group.items.filter((i) => i.image).map((i) => ({ value: i.value, png: readPng(path.join(ctx.outDir, i.image!)) }));
        if (images.length > 1) {
          const panelWidth = Math.min(...images.map((i) => i.png.width), 720);
          const strip = composeRow(
            images.map((i) => ({ image: resizeToWidth(i.png, panelWidth), label: `${spec.param}=${i.value}`, accent: COLORS.variant })),
            { maxWidth: ctx.cfg.diff.compositeMaxWidth },
          );
          const stripFile = path.join(ctx.outDir, 'variants', `${id}__strip.png`);
          writePng(stripFile, strip);
          group.strip = rel(ctx.outDir, stripFile);
        }
        groups.push(group);
      }
    }
  }
  return groups;
}

async function captureMotion(
  session: CaptureSession,
  ctx: {
    routes: ResolvedRoute[];
    viewports: ViewportConfig[];
    themes: ThemeConfig[];
    base: Side;
    head: Side;
    outDir: string;
    cfg: ResolvedConfig;
    explicit: boolean;
    all: boolean;
    changedRoutes: Set<string>;
    skipped: string[];
  },
): Promise<MotionResult[]> {
  const { cfg } = ctx;
  const declared = ctx.routes.filter((r) => r.motion);
  const candidates = declared.length ? declared : ctx.explicit ? ctx.routes : [];
  const targets = motionTargets(candidates, ctx.changedRoutes, ctx.all);
  for (const route of candidates) if (!targets.includes(route)) ctx.skipped.push(route.path);
  if (ctx.skipped.length) log.info(`motion: skipping unchanged route(s) ${ctx.skipped.join(', ')} (use --motion-all to record them)`);
  const results: MotionResult[] = [];
  for (const route of targets) {
    const m = route.motion ?? {};
    const viewport = ctx.viewports.find((v) => v.name === (m.viewport ?? cfg.motion.viewport)) ?? ctx.viewports[0];
    const theme = ctx.themes.find((t) => t.name === (m.theme ?? cfg.motion.theme)) ?? ctx.themes[0];
    const steps = m.steps ?? cfg.motion.steps;
    const durationMs = m.durationMs ?? cfg.motion.durationMs;
    const id = captureId(route, viewport, theme);
    const result: MotionResult = { id, route: { path: route.path, name: route.name, slug: route.slug }, viewport: viewport.name, theme: theme.name, steps: steps.map(describeStep) };
    log.step(`motion ${route.path} (${viewport.name}): ${result.steps.join(', ') || 'page load'}`);
    try {
      const frames: Record<'base' | 'head', RawFrame[]> = { base: [], head: [] };
      for (const side of [ctx.base, ctx.head]) {
        const context = await session.newContext(viewport, theme, { deviceScaleFactor: 1 }, true);
        try {
          const page = await context.newPage();
          const url = routeUrl(side.url, route.path, theme.query);
          const size = page.viewportSize() ?? { width: 1280, height: 800 };
          const recordOpts = { durationMs, width: size.width, height: size.height, timeoutMs: cfg.capture.timeoutMs };
          let recorded: Awaited<ReturnType<typeof recordFrames>>;
          if (m.fromNavigation) {
            await page.goto('about:blank');
            recorded = await recordFrames(page, steps, { ...recordOpts, beforeSteps: async () => void (await page.goto(url, { waitUntil: 'load' })) });
          } else {
            await session.openAndSettle(page, url, { ...route, actions: [] }, { freeze: false, fullPage: false });
            recorded = await recordFrames(page, steps, recordOpts);
          }
          frames[side.name] = recorded.frames;
          const reduced = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches).catch(() => false);
          if (reduced) (result.warnings ??= []).push(`${side.name}: the page saw prefers-reduced-motion: reduce while recording`);
          for (const s of recorded.skipped) result.steps = result.steps.map((d) => (d === s ? `${d} (not on ${side.name})` : d));
        } finally {
          await context.close().catch(() => undefined);
        }
      }
      result.frames = { base: distinctFrames(frames.base), head: distinctFrames(frames.head) };
      const still = motionWarning(result.frames);
      if (still) {
        (result.warnings ??= []).push(still);
        log.warn(`motion ${route.path}: ${still}`);
      }
      if (cfg.motion.format !== 'webm') {
        const gif = encodeSideBySideGif(frames.base, frames.head, {
          fps: cfg.motion.fps,
          durationMs,
          scale: cfg.motion.scale,
          labels: { before: `BEFORE ${ctx.base.shortSha ?? ''}`.trim(), after: `AFTER ${ctx.head.shortSha ?? ''}`.trim() },
        });
        const file = path.join(ctx.outDir, 'motion', `${id}.gif`);
        writeFile(file, gif);
        result.gif = rel(ctx.outDir, file);
      }
      if (cfg.motion.format !== 'gif') result.webm = await recordWebm(session, route, viewport, theme, steps, durationMs, ctx);
    } catch (error) {
      result.error = (error as Error).message.split('\n')[0];
      log.warn(`motion ${route.path}: ${result.error}`);
    }
    results.push(result);
  }
  return results;
}

/** Routes that get a motion clip: those with a visual change, or all of them with --motion-all. */
export function motionTargets<T extends { path: string }>(candidates: T[], changedRoutes: Set<string>, all: boolean): T[] {
  return all ? candidates : candidates.filter((r) => changedRoutes.has(r.path));
}

async function recordWebm(
  session: CaptureSession,
  route: ResolvedRoute,
  viewport: ViewportConfig,
  theme: ThemeConfig,
  steps: Step[],
  durationMs: number,
  ctx: { base: Side; head: Side; outDir: string; cfg: ResolvedConfig },
): Promise<{ base?: string; head?: string }> {
  const out: { base?: string; head?: string } = {};
  const id = captureId(route, viewport, theme);
  for (const side of [ctx.base, ctx.head]) {
    const tmpDir = path.join(ctx.outDir, 'motion', `.tmp-${side.name}`);
    const size = { width: viewport.width ?? 1280, height: viewport.height ?? 800 };
    const context = await session.newContext(viewport, theme, { deviceScaleFactor: 1, recordVideo: { dir: tmpDir, size } }, true);
    const page = await context.newPage();
    try {
      await session.openAndSettle(page, routeUrl(side.url, route.path, theme.query), { ...route, actions: [] }, { freeze: false, fullPage: false });
      const start = Date.now();
      await runSteps(page, steps, { timeoutMs: ctx.cfg.capture.timeoutMs, skipMissing: true });
      const remaining = durationMs - (Date.now() - start);
      if (remaining > 0) await page.waitForTimeout(remaining);
    } finally {
      await context.close();
    }
    const video = await page.video()?.path();
    if (video) {
      const file = path.join(ctx.outDir, 'motion', `${id}__${side.name === 'base' ? 'before' : 'after'}.webm`);
      moveFile(video, file);
      out[side.name] = rel(ctx.outDir, file);
    }
    rmSync(tmpDir, { recursive: true, force: true });
  }
  return out;
}

function auditTokens(captures: CaptureResult[], ctx: { outDir: string; tokenSet: TokenSet; cfg: ResolvedConfig; files: string[] }): Report['tokens'] {
  const { cfg, tokenSet } = ctx;
  const perCapture: Array<{ capture: string; findings: ReturnType<typeof auditSnapshot>; baseValues?: Set<string> }> = [];
  const audited: string[] = [];
  const opts = { properties: cfg.tokens.properties, colorTolerance: cfg.tokens.colorTolerance, pxTolerance: cfg.tokens.pxTolerance, allow: cfg.tokens.allow };
  for (const c of captures) {
    if (c.status !== 'changed' && c.status !== 'added') continue;
    const headFile = path.join(ctx.outDir, 'styles', 'head', `${c.id}.json`);
    if (!existsSync(headFile)) continue;
    const head = JSON.parse(readFileSync(headFile, 'utf8')) as StyleSnapshot;
    const scale = c.diff?.scale ?? 1;
    const regions =
      cfg.tokens.scope === 'changed-regions' && c.status === 'changed' && c.diff
        ? c.diff.regions.map((r) => ({ x: r.x / scale, y: r.y / scale, width: r.width / scale, height: r.height / scale }))
        : undefined;
    const findings = auditSnapshot(head, tokenSet, { ...opts, regions });
    const baseFile = path.join(ctx.outDir, 'styles', 'base', `${c.id}.json`);
    const baseValues = c.status === 'changed' && existsSync(baseFile) ? findingKeys(auditSnapshot(JSON.parse(readFileSync(baseFile, 'utf8')) as StyleSnapshot, tokenSet, opts)) : undefined;
    perCapture.push({ capture: `${c.route.path} ${c.viewport}/${c.theme}`, findings, baseValues });
    audited.push(c.id);
  }
  const categories: Array<[string, Parameters<typeof hasCategory>[1]]> = [
    ['color', 'color'],
    ['spacing', 'spacing'],
    ['radius', 'radius'],
    ['font-size', 'fontSize'],
    ['font-weight', 'fontWeight'],
    ['font-family', 'fontFamily'],
  ];
  const skipped = categories.filter(([, cat]) => !hasCategory(tokenSet, cat)).map(([name]) => name);
  return {
    files: ctx.files.map((f) => path.relative(cfg.repoRoot, f).split(path.sep).join('/')),
    scope: cfg.tokens.scope,
    audited,
    skipped,
    findings: aggregateFindings(perCapture).slice(0, cfg.tokens.maxFindings),
  };
}

function a11yDelta(captures: CaptureResult[], plans: Plan[], records: Map<string, CaptureRecord>, cfg: ResolvedConfig): Report['a11y'] {
  const added = new Map<string, A11yIssue & { captures: string[] }>();
  const fixed = new Map<string, A11yIssue & { captures: string[] }>();
  const focus: Array<{ capture: string; delta: ReturnType<typeof diffFocusOrder> }> = [];
  const audited: string[] = [];
  const errors: string[] = [];
  for (const plan of plans.filter((p) => p.a11y)) {
    const b = records.get(`base:${plan.id}`);
    const h = records.get(`head:${plan.id}`);
    const label = `${plan.route.path} ${plan.viewport.name}/${plan.theme.name}`;
    const status = captures.find((c) => c.id === plan.id)?.status;
    if (!h?.axe || status === 'error') {
      errors.push(label);
      continue;
    }
    audited.push(plan.id);
    const delta = diffViolations(status === 'added' ? [] : (b?.axe ?? []), h.axe);
    for (const [list, map] of [
      [delta.added, added],
      [delta.fixed, fixed],
    ] as const) {
      for (const issue of list) {
        const key = `${issue.rule}|${issue.target}`;
        const existing = map.get(key);
        if (existing) {
          if (!existing.captures.includes(label)) existing.captures.push(label);
        } else {
          map.set(key, { ...issue, captures: [label] });
        }
      }
    }
    if (plan.focus && b?.focusOrder && h.focusOrder) {
      focus.push({ capture: `${plan.route.path} ${plan.viewport.name}`, delta: diffFocusOrder(b.focusOrder, h.focusOrder) });
    }
  }
  const impactRank: Record<string, number> = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  const sort = (list: Array<A11yIssue & { captures: string[] }>) => list.sort((a, b) => (impactRank[a.impact ?? 'minor'] ?? 4) - (impactRank[b.impact ?? 'minor'] ?? 4) || a.rule.localeCompare(b.rule));
  return { tags: cfg.a11y.tags, audited, added: sort([...added.values()]), fixed: sort([...fixed.values()]), focus, errors };
}

function writeOutputs(report: Report, outDir: string, noChanges: boolean): RunOutcome {
  const reportFile = path.join(outDir, 'report.json');
  writeRedacted(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  writeRedacted(path.join(outDir, 'summary.auto.md'), `${autoSummary(report)}\n`);
  const previewFile = path.join(outDir, 'comment.local.md');
  writeRedacted(previewFile, renderComment(report, { id: 'preview', title: 'UI diff (local preview)', link: (p) => p, storageNote: 'local preview — nothing uploaded' }));
  return { report, reportFile, previewFile, noChanges };
}
