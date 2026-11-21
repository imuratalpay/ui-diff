import type { Report, SideFingerprint } from '../../src/report.js';

export function sampleReport(overrides: Partial<Report> = {}): Report {
  return {
    version: 2,
    tool: { name: 'ui-diff', version: '0.1.0' },
    createdAt: '2026-11-18T12:00:00.000Z',
    base: { label: 'main @ 1a2b3c4', mode: 'worktree', sha: '1a2b3c4d', shortSha: '1a2b3c4' },
    head: { label: 'feature @ 5d6e7f8', mode: 'worktree', sha: '5d6e7f8a', shortSha: '5d6e7f8' },
    routes: [{ path: '/', name: 'home', reasons: ['index.html matches index.html'], confidence: 'high' }],
    viewports: ['desktop', 'mobile'],
    themes: ['light'],
    captures: [
      {
        id: 'home__desktop__light',
        route: { path: '/', name: 'home', slug: 'home' },
        viewport: 'desktop',
        theme: 'light',
        status: 'changed',
        urls: {},
        diff: { changedPixels: 5000, ratio: 0.0423, regions: [{ x: 0, y: 0, width: 10, height: 10 }], scale: 1, sizeBefore: [1280, 1600], sizeAfter: [1280, 1744], sizeChanged: true },
        images: { base: 'captures/base/home__desktop__light.png', head: 'captures/head/home__desktop__light.png', compare: 'compare/home__desktop__light.png', focus: ['compare/home__desktop__light__focus-1.png'] },
        warnings: [],
        truncated: false,
      },
      {
        id: 'home__mobile__light',
        route: { path: '/', name: 'home', slug: 'home' },
        viewport: 'mobile',
        theme: 'light',
        status: 'unchanged',
        urls: {},
        diff: { changedPixels: 0, ratio: 0, regions: [], scale: 2, sizeBefore: [780, 3000], sizeAfter: [780, 3000], sizeChanged: false },
        images: { focus: [] },
        warnings: [],
        truncated: false,
      },
    ],
    variants: [
      {
        id: 'home__desktop__light__hero',
        route: { path: '/', name: 'home', slug: 'home' },
        param: 'hero',
        viewport: 'desktop',
        theme: 'light',
        items: [
          { value: '1', image: 'variants/hero-1.png' },
          { value: '2', image: 'variants/hero-2.png' },
        ],
      },
    ],
    motion: [{ id: 'home__desktop__light', route: { path: '/', name: 'home', slug: 'home' }, viewport: 'desktop', theme: 'light', steps: ['hover .cta'], gif: 'motion/home.gif' }],
    a11y: {
      tags: ['wcag2aa'],
      audited: ['home__desktop__light', 'home__mobile__light'],
      added: [
        {
          rule: 'color-contrast',
          impact: 'serious',
          help: 'Elements must meet minimum color contrast ratio thresholds',
          helpUrl: 'https://dequeuniversity.com/rules/axe/4.14/color-contrast',
          category: 'contrast',
          target: '.badge',
          html: '<span class="badge">',
          summary: '',
          captures: ['/ desktop/light', '/ mobile/light'],
        },
      ],
      fixed: [],
      focus: [],
      errors: [],
    },
    tokens: {
      files: ['tokens.json'],
      scope: 'changed-regions',
      audited: ['home__desktop__light'],
      skipped: [],
      findings: [{ property: 'background-color', value: '#ff5a1f', count: 1, selectors: ['span.badge'], captures: ['/ desktop/light'], isNew: true }],
    },
    warnings: [],
    stats: { captures: 2, changed: 1, unchanged: 1, added: 0, removed: 0, errors: 0 },
    ...overrides,
  };
}

export function sideFingerprint(overrides: Partial<SideFingerprint> = {}): SideFingerprint {
  return {
    commit: '1a2b3c4d',
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false },
    browser: { name: 'chromium', version: '159.0.8154.6', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/159.0.8154.6' },
    fonts: { loaded: ['Inter'], failed: [], pending: [] },
    freeze: { clock: '2026-11-21T09:00:00.000Z', seed: 795556381, animations: true, fonts: true },
    media: { reducedMotion: 'reduce', colorScheme: 'light', locale: 'en-US', timezone: 'UTC' },
    data: 'not declared',
    ...overrides,
  };
}
