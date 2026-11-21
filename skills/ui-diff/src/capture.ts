import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { chromium, devices, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from 'playwright';
import { collectFocusOrder, runAxe, type AxeViolation, type FocusStop } from './a11y.js';
import { applyAuth, type ResolvedAuth } from './auth.js';
import type { ResolvedConfig, ResolvedRoute, ThemeConfig, ViewportConfig } from './config.js';
import { DEV_OVERLAY_SELECTORS, fontState, freezeAnimations, hideCss, initScript, pageHeight, scrollThrough, settleFonts, waitForFontsAndImages, type FontState } from './determinism.js';
import { exec } from './exec.js';
import type { Box } from './image.js';
import { log, redact, UiDiffError } from './log.js';
import type { SideFingerprint } from './report.js';
import type { SideName } from './sides.js';
import { runSteps } from './steps.js';
import { collectStyles } from './styles.js';
import { changedRegions, type UnsettledRegion } from './unsettled.js';

export interface CaptureTarget {
  id: string;
  side: SideName;
  route: ResolvedRoute;
  viewport: ViewportConfig;
  theme: ThemeConfig;
  url: string;
  file: string;
  styles?: { file: string; extraColors: string[] };
  a11y?: boolean;
  focusOrder?: boolean;
}

export interface CaptureRecord {
  id: string;
  side: SideName;
  ok: boolean;
  file?: string;
  width?: number;
  height?: number;
  httpStatus?: number;
  error?: string;
  consoleErrors: string[];
  pageErrors: string[];
  truncated: boolean;
  stable: boolean;
  attempts: number;
  /** Set when screenshots of this one page load kept changing; lists the areas when they could be found. */
  unsettled?: UnsettledRegion[];
  /** The page clock was paused for the final screenshots because something kept moving. */
  frozeTimers?: boolean;
  stylesFile?: string;
  /** The style snapshot (element map) hit capture.styleMaxElements. */
  stylesCapped?: boolean;
  /** Elements in the element map. */
  stylesCount?: number;
  /** Time spent on the style snapshot and on axe plus focus order, within durationMs. */
  stylesMs?: number;
  a11yMs?: number;
  axe?: AxeViolation[];
  focusOrder?: FocusStop[];
  /** Route actions skipped because no element matched them on this side. */
  skippedActions?: string[];
  /** Web fonts loaded, failed or still loading when the screenshot was taken. */
  fonts?: FontState;
  /** Capture environment measured in the page (the fingerprint without commit and data label). */
  environment?: Omit<SideFingerprint, 'commit' | 'data'>;
  /** `window.devicePixelRatio` measured in the page: device pixels per CSS pixel in the screenshot. */
  scale?: number;
  durationMs: number;
}

/** Names the element behind each changing area so the warning can say what to mask. */
async function describeRegions(page: Page, boxes: Box[], fullPage: boolean): Promise<UnsettledRegion[]> {
  if (boxes.length === 0) return [];
  return page
    .evaluate(
      ({ boxes, fullPage }) => {
        // No named helper functions in here: the test runner's transpiler wraps them in a helper the page lacks.
        const dpr = window.devicePixelRatio || 1;
        const helpers = (window as unknown as { __uiDiff?: { cssPath(el: Element): string } }).__uiDiff;
        const ox = fullPage ? window.scrollX : 0;
        const oy = fullPage ? window.scrollY : 0;
        const elements = Array.from(document.body?.querySelectorAll('*') ?? []);
        const pageHeight = document.documentElement.scrollHeight;
        const out: Array<{ selector?: string; box: { x: number; y: number; width: number; height: number } }> = [];
        for (const device of boxes) {
          const box = { x: Math.floor(device.x / dpr), y: Math.floor(device.y / dpr), width: Math.ceil(device.width / dpr), height: Math.ceil(device.height / dpr) };
          let best: Element | undefined;
          let bestArea = Infinity;
          for (const el of elements) {
            const r = el.getBoundingClientRect();
            const area = r.width * r.height;
            if (area === 0 || area >= bestArea) continue;
            const left = r.left + ox;
            const top = r.top + oy;
            if (left <= box.x + 2 && top <= box.y + 2 && left + r.width >= box.x + box.width - 2 && top + r.height >= box.y + box.height - 2) {
              best = el;
              bestArea = area;
            }
          }
          if (!best) {
            // Nothing covers both where it was and where it went (e.g. a positioned element that moves): take the
            // biggest overlap, looking a little around the box because the area it just left is empty.
            const near = { x: box.x - 16, y: box.y - 16, width: box.width + 32, height: box.height + 32 };
            let bestOverlap = 0;
            for (const el of elements) {
              const r = el.getBoundingClientRect();
              if (r.width * r.height === 0 || r.width * r.height > 4 * near.width * near.height) continue;
              const w = Math.min(r.left + ox + r.width, near.x + near.width) - Math.max(r.left + ox, near.x);
              const h = Math.min(r.top + oy + r.height, near.y + near.height) - Math.max(r.top + oy, near.y);
              if (w > 0 && h > 0 && w * h > bestOverlap) {
                best = el;
                bestOverlap = w * h;
              }
            }
          }
          // Carousels, tickers and marquees move inside a clipping box; that box, not the moving slide, is what to mask.
          let target = best;
          for (let cur = best, depth = 0; cur && cur !== document.body && depth < 6; cur = cur.parentElement ?? undefined, depth++) {
            if (cur.getBoundingClientRect().height >= pageHeight * 0.9) break;
            const style = getComputedStyle(cur);
            if (/hidden|clip|auto|scroll/.test(style.overflowX + style.overflowY)) {
              target = cur;
              break;
            }
          }
          const selector = (target && helpers?.cssPath(target)) || undefined;
          if (selector && out.some((o) => o.selector === selector)) continue;
          const r = target?.getBoundingClientRect();
          out.push({ selector, box: r ? { x: Math.round(r.left + ox), y: Math.round(r.top + oy), width: Math.round(r.width), height: Math.round(r.height) } : box });
        }
        return out;
      },
      { boxes, fullPage },
    )
    .catch((error: Error) => {
      log.debug(`could not name the areas that kept changing: ${error.message.split('\n')[0]}`);
      return [];
    });
}

/** How long a route action waits for its element to appear before it is skipped as missing on that side. */
const MISSING_ACTION_WAIT_MS = 3000;

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export function withQuery(url: string, params: Record<string, string> | undefined): string {
  if (!params || Object.keys(params).length === 0) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

export function routeUrl(root: string, routePath: string, params?: Record<string, string>): string {
  return withQuery(new URL(routePath.replace(/^\/+/, ''), `${root.replace(/\/$/, '')}/`).toString(), params);
}

export function contextOptions(viewport: ViewportConfig, theme: ThemeConfig | undefined, cfg: ResolvedConfig, motion = false): BrowserContextOptions {
  const device = viewport.device ? devices[viewport.device] : undefined;
  if (viewport.device && !device) throw new UiDiffError(`Unknown Playwright device "${viewport.device}" in viewport ${viewport.name}`);
  const isMobile = viewport.isMobile ?? device?.isMobile ?? false;
  return {
    viewport: { width: viewport.width ?? device!.viewport.width, height: viewport.height ?? device!.viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor ?? device?.deviceScaleFactor ?? 1,
    isMobile,
    hasTouch: viewport.hasTouch ?? device?.hasTouch ?? false,
    userAgent: viewport.userAgent ?? device?.userAgent ?? (isMobile ? MOBILE_UA : undefined),
    colorScheme: theme?.colorScheme ?? 'light',
    reducedMotion: motion || !cfg.freeze.animations ? 'no-preference' : 'reduce',
    locale: cfg.capture.locale,
    timezoneId: cfg.capture.timezoneId,
    serviceWorkers: 'block',
    bypassCSP: true,
  };
}

const require = createRequire(import.meta.url);

/** Installs Playwright's Chromium on first use unless a system browser channel is configured. */
const BROWSER_HINT =
  'Run `npx --prefix <skill folder> playwright install chromium` once you are online (behind a proxy set HTTPS_PROXY, or PLAYWRIGHT_DOWNLOAD_HOST for a mirror), or use an installed Chrome with UI_DIFF_BROWSER_CHANNEL=chrome.';

/** Which browser captures run in: a browser channel (an installed Chrome), a custom executable, or Playwright's Chromium. */
export interface BrowserChoice {
  channel?: string;
  executablePath?: string;
  /** Recorded in the fingerprint: the channel name, "chromium" (bundled) or "custom executable" (the path is never recorded). */
  label: string;
}

/**
 * UI_DIFF_CHROMIUM_PATH wins, then UI_DIFF_BROWSER_CHANNEL, then config browser.channel, then the
 * Chromium Playwright downloads. Resolved once per run, so base and head always share the browser.
 */
export function resolveBrowser(configChannel?: string, env: NodeJS.ProcessEnv = process.env): BrowserChoice {
  if (env.UI_DIFF_CHROMIUM_PATH) return { executablePath: env.UI_DIFF_CHROMIUM_PATH, label: 'custom executable' };
  const channel = env.UI_DIFF_BROWSER_CHANNEL || configChannel;
  if (channel) return { channel, label: channel };
  return { label: 'chromium' };
}

/** Installs Playwright's Chromium on first use unless an installed browser was chosen. */
export async function ensureBrowser(choice: BrowserChoice = resolveBrowser()): Promise<void> {
  if (choice.channel || choice.executablePath) return;
  if (existsSync(chromium.executablePath())) return;
  log.step('installing Playwright Chromium (first run only)');
  const cli = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
  try {
    await exec(process.execPath, [cli, 'install', 'chromium'], { timeoutMs: 10 * 60 * 1000 });
  } catch (error) {
    const detail = (error as Error).message.split('\n').find((l) => /error|ECONN|ENOTFOUND|EAI_AGAIN|timed out|403|404/i.test(l)) ?? 'download failed';
    throw new UiDiffError(`Chromium is not installed and could not be downloaded (${detail.trim()})`, { hint: BROWSER_HINT });
  }
}

export async function launchBrowser(choice: BrowserChoice = resolveBrowser()): Promise<Browser> {
  await ensureBrowser(choice);
  try {
    return await chromium.launch({
      headless: true,
      channel: choice.channel,
      executablePath: choice.executablePath,
      args: ['--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb', '--hide-scrollbars', '--disable-skia-runtime-opts'],
    });
  } catch (error) {
    const lines = (error as Error).message.split('\n').filter((l) => l.trim() && !/^\s*at /.test(l));
    throw new UiDiffError(`Could not start ${choice.label === 'chromium' ? 'Chromium' : choice.label}: ${lines.slice(0, 6).join(' ').replace(/\s+/g, ' ').slice(0, 600)}`, {
      hint: choice.channel
        ? `Install that browser (channel "${choice.channel}"), or unset UI_DIFF_BROWSER_CHANNEL / browser.channel to use Playwright's Chromium.`
        : 'On Linux install the system libraries with `npx --prefix <skill folder> playwright install --with-deps chromium`, or set UI_DIFF_BROWSER_CHANNEL=chrome to use an installed Chrome.',
    });
  }
}

export interface SessionOptions {
  cfg: ResolvedConfig;
  auth?: ResolvedAuth;
  /** Instant used when freeze.time is "run-start". */
  runStart: Date;
  /** Fingerprint name of the browser (BrowserChoice.label); defaults to "chromium". */
  browserLabel?: string;
}

/** The instant Date is frozen at for still captures, or undefined when freeze.clock is off. */
export function frozenTime(cfg: ResolvedConfig, runStart: Date): Date | undefined {
  if (!cfg.freeze.clock) return undefined;
  return cfg.freeze.time === 'run-start' ? runStart : new Date(cfg.freeze.time);
}

export class CaptureSession {
  constructor(
    private readonly browser: Browser,
    private readonly opts: SessionOptions,
  ) {}

  async newContext(viewport: ViewportConfig, theme: ThemeConfig | undefined, extra: Partial<BrowserContextOptions> = {}, motion = false): Promise<BrowserContext> {
    const { cfg } = this.opts;
    // Motion clips always run with prefers-reduced-motion: no-preference; static captures may stay reduced.
    const context = await this.browser.newContext({ ...contextOptions(viewport, theme, cfg, motion), ...extra, ...(motion ? { reducedMotion: 'no-preference' as const } : {}) });
    const instant = frozenTime(cfg, this.opts.runStart);
    if (instant && !motion) {
      await context.clock.setFixedTime(instant);
    } else if (!motion) {
      // Time keeps flowing; installed up front so timers can be paused later without performance.now() jumping.
      await context.clock.install();
    }
    await context.addInitScript({ content: initScript({ seed: cfg.freeze.random ? cfg.freeze.seed : undefined, localStorage: theme?.localStorage }) });
    await applyAuth(context, this.opts.auth);
    context.setDefaultTimeout(cfg.capture.timeoutMs);
    return context;
  }

  /** Measured in the page where it can be: what this capture was rendered with. */
  private async environment(page: Page, target: CaptureTarget, fonts: FontState): Promise<Omit<SideFingerprint, 'commit' | 'data'>> {
    const { cfg } = this.opts;
    const measured = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      deviceScaleFactor: window.devicePixelRatio,
      userAgent: navigator.userAgent,
      locale: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduce' : 'no-preference',
      colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'no-preference',
    }));
    const clock = frozenTime(cfg, this.opts.runStart);
    return {
      viewport: { width: measured.width, height: measured.height, deviceScaleFactor: measured.deviceScaleFactor, isMobile: contextOptions(target.viewport, target.theme, cfg).isMobile ?? false },
      browser: { name: this.opts.browserLabel ?? 'chromium', version: this.browser.version(), userAgent: measured.userAgent },
      fonts,
      freeze: { clock: clock ? clock.toISOString() : null, seed: cfg.freeze.random ? cfg.freeze.seed : null, animations: cfg.freeze.animations, fonts: cfg.freeze.fonts },
      media: { reducedMotion: measured.reducedMotion, colorScheme: measured.colorScheme, locale: measured.locale, timezone: measured.timezone },
    };
  }

  private async waitForFonts(page: Page, timeoutMs: number): Promise<void> {
    await settleFonts(page, timeoutMs);
    await waitForFontsAndImages(page, timeoutMs);
  }

  /**
   * Navigates and brings the page to a settled, deterministic state: network idle, fonts, lazy
   * content loaded by scrolling through the page, and only then the route's actions, so they can
   * target lazy-loaded elements and an opened menu or hover is not undone by that scroll.
   */
  async openAndSettle(page: Page, url: string, route: ResolvedRoute, opts: { freeze: boolean; fullPage: boolean }): Promise<{ status?: number; skippedActions: string[] }> {
    const { cfg } = this.opts;
    const response = await page.goto(url, { waitUntil: cfg.capture.waitUntil, timeout: cfg.capture.timeoutMs });
    if (cfg.capture.networkIdleTimeoutMs > 0) {
      await page.waitForLoadState('networkidle', { timeout: cfg.capture.networkIdleTimeoutMs }).catch(() => undefined);
    }
    if (route.waitFor) await page.locator(route.waitFor).first().waitFor({ state: 'visible', timeout: cfg.capture.timeoutMs });
    if (opts.freeze) await freezeAnimations(page);
    if (cfg.freeze.fonts) await this.waitForFonts(page, cfg.freeze.fontTimeoutMs);
    if (opts.fullPage && cfg.capture.scrollToLoad) {
      await scrollThrough(page, cfg.capture.maxHeight);
      if (cfg.freeze.fonts) await this.waitForFonts(page, Math.min(5000, cfg.freeze.fontTimeoutMs));
    }
    let skippedActions: string[] = [];
    if (route.actions.length) {
      await page.evaluate(() => window.scrollTo(0, 0));
      // An element that exists on only one side (new on head, removed on base) skips the action there with a warning.
      skippedActions = await runSteps(page, route.actions, { timeoutMs: cfg.capture.timeoutMs, skipMissing: true, waitForMissingMs: Math.min(cfg.capture.timeoutMs, MISSING_ACTION_WAIT_MS) });
    }
    if (opts.freeze) await freezeAnimations(page);
    if (!route.actions.some((a) => 'scroll' in a)) await page.evaluate(() => window.scrollTo(0, 0));
    if (cfg.capture.settleMs) await page.waitForTimeout(cfg.capture.settleMs);
    return { status: response?.status(), skippedActions };
  }

  async screenshot(
    page: Page,
    route: ResolvedRoute,
    fullPage: boolean,
  ): Promise<{ buffer: Buffer; stable: boolean; attempts: number; truncated: boolean; unsettled?: UnsettledRegion[]; frozeTimers: boolean }> {
    const { cfg } = this.opts;
    const masks = [...cfg.capture.mask, ...route.mask];
    const hidden = [...cfg.capture.hide, ...route.hide, ...(cfg.capture.hideDevOverlays ? DEV_OVERLAY_SELECTORS : [])];
    const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
    let truncated = false;
    let clip: { x: number; y: number; width: number; height: number } | undefined;
    if (fullPage) {
      const height = await pageHeight(page);
      if (height > cfg.capture.maxHeight) {
        truncated = true;
        clip = { x: 0, y: 0, width: viewport.width, height: cfg.capture.maxHeight };
      }
    }
    const shoot = () =>
      page.screenshot({
        fullPage,
        clip,
        animations: cfg.freeze.animations ? 'disabled' : 'allow',
        caret: 'hide',
        scale: 'device',
        mask: masks.map((s) => page.locator(s)),
        maskColor: cfg.capture.maskColor,
        style: hideCss(hidden),
        timeout: cfg.capture.timeoutMs,
      });
    const wanted = cfg.capture.stableShots;
    let previous = await shoot();
    let attempts = 1;
    let streak = 1;
    let changes = 0;
    let moving: Box[] = [];
    let frozeTimers = false;
    while (streak < wanted && attempts < wanted + 3) {
      await page.waitForTimeout(120 * attempts);
      const next = await shoot();
      attempts++;
      if (next.equals(previous)) {
        streak++;
      } else {
        streak = 1;
        changes++;
        moving = changedRegions(previous, next);
        // Changing twice in a row is not a late image or font but something that keeps moving
        // (requestAnimationFrame, timers): pause the page clock so the screenshot is one frame.
        if (changes >= 2 && !frozeTimers) {
          frozeTimers = true;
          // pauseAt pauses first, so the clock is paused even if it throws because that time has already passed.
          await page.evaluate(() => Date.now() + 100).then((t) => page.context().clock.pauseAt(t)).catch(() => undefined);
        }
      }
      previous = next;
    }
    const stable = streak >= wanted;
    const unsettled = changes >= 2 || !stable ? await describeRegions(page, moving, fullPage) : undefined;
    // The caller resumes the clock once the element map describes this same frame.
    return { buffer: previous, stable, attempts, truncated, unsettled, frozeTimers };
  }

  async capture(target: CaptureTarget): Promise<CaptureRecord> {
    const { cfg } = this.opts;
    const started = Date.now();
    const record: CaptureRecord = { id: target.id, side: target.side, ok: false, consoleErrors: [], pageErrors: [], truncated: false, stable: false, attempts: 0, durationMs: 0 };
    const fullPage = target.route.fullPage ?? cfg.capture.fullPage;
    let context: BrowserContext | undefined;
    try {
      context = await this.newContext(target.viewport, target.theme);
      const page = await context.newPage();
      page.on('console', (msg) => {
        if (msg.type() === 'error' && record.consoleErrors.length < 10) record.consoleErrors.push(redact(msg.text()).slice(0, 300));
      });
      page.on('pageerror', (error) => {
        if (record.pageErrors.length < 10) record.pageErrors.push(redact(error.message).slice(0, 300));
      });
      const opened = await this.openAndSettle(page, target.url, target.route, { freeze: cfg.freeze.animations, fullPage });
      record.httpStatus = opened.status;
      if (opened.skippedActions.length) record.skippedActions = opened.skippedActions;
      record.scale = await page.evaluate(() => window.devicePixelRatio);
      record.fonts = await fontState(page);
      record.environment = await this.environment(page, target, record.fonts);
      const shot = await this.screenshot(page, target.route, fullPage);
      mkdirSync(path.dirname(target.file), { recursive: true });
      writeFileSync(target.file, shot.buffer);
      Object.assign(record, { file: target.file, stable: shot.stable, attempts: shot.attempts, truncated: shot.truncated });
      if (shot.unsettled) record.unsettled = shot.unsettled;
      if (shot.frozeTimers) record.frozeTimers = true;
      if (target.styles) {
        const stylesStart = performance.now();
        const masked = [...cfg.capture.mask, ...target.route.mask, ...cfg.capture.hide, ...target.route.hide, ...(cfg.capture.hideDevOverlays ? DEV_OVERLAY_SELECTORS : [])];
        const { snapshot, capped } = await collectStyles(page, { maxElements: cfg.capture.styleMaxElements, ignore: cfg.tokens.ignoreSelectors, extraColors: target.styles.extraColors, masked });
        mkdirSync(path.dirname(target.styles.file), { recursive: true });
        writeFileSync(target.styles.file, JSON.stringify(snapshot));
        record.stylesFile = target.styles.file;
        if (capped) record.stylesCapped = true;
        record.stylesCount = snapshot.elements.length;
        record.stylesMs = Math.round(performance.now() - stylesStart);
      }
      if (shot.frozeTimers) await page.context().clock.resume().catch(() => undefined);
      const a11yStart = performance.now();
      if (target.a11y) record.axe = await runAxe(page, { tags: cfg.a11y.tags, rules: cfg.a11y.rules });
      if (target.focusOrder) record.focusOrder = await collectFocusOrder(page, cfg.a11y.maxTabStops);
      if (target.a11y || target.focusOrder) record.a11yMs = Math.round(performance.now() - a11yStart);
      record.ok = true;
    } catch (error) {
      record.error = redact((error as Error).message.split('\n')[0]);
    } finally {
      await context?.close().catch(() => undefined);
      record.durationMs = Date.now() - started;
    }
    return record;
  }
}
