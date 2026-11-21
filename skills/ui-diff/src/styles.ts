import type { Page } from 'playwright';
import type { StyleSnapshot } from './tokens.js';

export interface StyleCollectOptions {
  /** Visible elements recorded at most, in document order. */
  maxElements: number;
  /** Elements inside these selectors are left out. */
  ignore: string[];
  /** Color strings to normalize besides those found on the page (e.g. token values). */
  extraColors: string[];
}

/**
 * The element map of a settled page: every visible element (open shadow roots included) with a
 * stable id, a readable name, its parent, its box in CSS and device px, and the computed styles the
 * token audit and the style diff compare; every color is normalized by the browser. `capped` is
 * true when `maxElements` cut the list short.
 */
export async function collectStyles(page: Page, opts: StyleCollectOptions): Promise<{ snapshot: StyleSnapshot; capped: boolean }> {
  return page.evaluate(
    ({ max, ignore, extra }) => {
      type Snapshot = { elements: Array<{ styles: { color: string; backgroundColor: string; borderColor: string[]; borderColors?: string[] } }>; capped: boolean };
      const helpers = (window as unknown as { __uiDiff: { snapshotStyles(m: number, i: string[]): Snapshot; normalizeColors(l: string[]): Record<string, unknown> } }).__uiDiff;
      const { elements, capped } = helpers.snapshotStyles(max, ignore);
      const colors = new Set<string>(extra);
      for (const el of elements) {
        colors.add(el.styles.color);
        colors.add(el.styles.backgroundColor);
        for (const c of el.styles.borderColor) colors.add(c);
        for (const c of el.styles.borderColors ?? []) colors.add(c);
      }
      return { snapshot: { elements, colors: helpers.normalizeColors([...colors]) } as unknown as StyleSnapshot, capped };
    },
    { max: opts.maxElements, ignore: opts.ignore, extra: opts.extraColors },
  );
}

export function styleCapWarning(side: string, max: number): string {
  return `${side}: style snapshot stopped at ${max} elements (capture.styleMaxElements); elements further down the page were not recorded, so the token audit and the style diff do not cover them`;
}
