import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { expandValues, parseConfig, parseVariantFlag, pickThemes, pickViewports, routeSlug, toRepoGlob } from '../../src/config.js';
import { UiDiffError } from '../../src/log.js';

describe('config', () => {
  it('applies nested defaults to an empty config', () => {
    const cfg = parseConfig({}, { repoRoot: '/repo' });
    assert.equal(cfg.capture.disableAnimations, true);
    assert.equal(cfg.capture.waitForFonts, true);
    assert.equal(cfg.capture.fixedTime, false);
    assert.equal(cfg.diff.threshold, 0.1);
    assert.equal(cfg.publish.branch, 'ui-diff-assets');
    assert.equal(cfg.publish.allowPublicRepo, false);
    assert.deepEqual(
      cfg.viewports.map((v) => v.name),
      ['desktop', 'mobile'],
    );
    assert.equal(cfg.a11y.enabled, false);
    assert.equal(cfg.dirRel, '');
  });

  it('freezes clock, randomness, animations and fonts by default', () => {
    const { freeze } = parseConfig({}, { repoRoot: '/repo' });
    assert.deepEqual(freeze, { clock: true, time: 'run-start', random: true, seed: 0x2f6b3a1d, animations: true, fonts: true, fontTimeoutMs: 8000 });
    assert.equal(parseConfig({ freeze: { clock: false } }, { repoRoot: '/repo' }).freeze.clock, false);
    assert.throws(() => parseConfig({ freeze: { time: 'yesterday' } }, { repoRoot: '/repo' }), /freeze\.time: must be "run-start" or an ISO timestamp/);
  });

  it('keeps the older capture switches working', () => {
    const legacy = parseConfig({ capture: { fixedTime: '2026-01-01T00:00:00Z', stableRandom: false, disableAnimations: false, waitForFonts: false } }, { repoRoot: '/repo' }).freeze;
    assert.equal(legacy.time, '2026-01-01T00:00:00Z');
    assert.equal(legacy.clock, true);
    assert.equal(legacy.random, false);
    assert.equal(legacy.animations, false);
    assert.equal(legacy.fonts, false);
    assert.equal(parseConfig({ capture: { fixedTime: '2026-01-01T00:00:00Z' }, freeze: { time: '2027-05-05T00:00:00Z' } }, { repoRoot: '/repo' }).freeze.time, '2027-05-05T00:00:00Z');
    assert.equal(parseConfig({ capture: { fixedTime: false } }, { repoRoot: '/repo' }).freeze.clock, true, 'what init used to write now means "not set"');
    assert.throws(() => parseConfig({ capture: { fixedTime: 'soon' } }, { repoRoot: '/repo' }), /capture\.fixedTime is not a valid date: soon/);
  });

  it('resolves route globs relative to the config directory', () => {
    const cfg = parseConfig(
      { routes: ['/', { path: '/pricing', files: ['src/pricing/**', '../../packages/ui/**', '/shared/*.css'] }], globalFiles: ['styles.css'] },
      { file: '/repo/apps/web/ui-diff.config.json', repoRoot: '/repo' },
    );
    assert.equal(cfg.dirRel, 'apps/web');
    assert.deepEqual(cfg.routes[1].files, ['/apps/web/src/pricing/**', '/packages/ui/**', '/shared/*.css']);
    assert.deepEqual(cfg.globalFiles, ['/apps/web/styles.css']);
    assert.equal(cfg.routes[0].slug, 'home');
    assert.equal(cfg.routes[1].slug, 'pricing');
  });

  it('expands variant ranges and lists', () => {
    assert.deepEqual(expandValues('1..4'), ['1', '2', '3', '4']);
    assert.deepEqual(expandValues('4..1'), ['4', '3', '2', '1']);
    assert.deepEqual(expandValues('0..10..5'), ['0', '5', '10']);
    assert.deepEqual(expandValues('a, b,c'), ['a', 'b', 'c']);
    assert.deepEqual(expandValues([1, 'x']), ['1', 'x']);
    assert.throws(() => expandValues('1..40'), UiDiffError);
  });

  it('parses --variants flags with optional route', () => {
    assert.deepEqual(parseVariantFlag('hero=1..3'), { route: undefined, spec: { param: 'hero', values: ['1', '2', '3'] } });
    assert.deepEqual(parseVariantFlag('/pricing:plan=a,b'), { route: '/pricing', spec: { param: 'plan', values: ['a', 'b'] } });
    assert.throws(() => parseVariantFlag('nonsense'), UiDiffError);
  });

  it('rejects secret values where an environment variable name is expected', () => {
    assert.throws(
      () => parseConfig({ auth: { headers: [{ name: 'x-vercel-protection-bypass', env: 'abc123-secret value' }] } }, { repoRoot: '/repo' }),
      /environment variable/,
    );
    assert.throws(
      () => parseConfig({ auth: { cookies: [{ name: '_vercel_jwt', env: 'kP3xV9qLm2TzR8wYb4NcJ7hF5sD1gA6e' }] } }, { repoRoot: '/repo' }),
      /UPPER_SNAKE_CASE/,
    );
    const ok = parseConfig({ auth: { headers: [{ name: 'x-vercel-protection-bypass', env: 'VERCEL_AUTOMATION_BYPASS_SECRET' }] } }, { repoRoot: '/repo' });
    assert.equal(ok.auth?.headers[0].env, 'VERCEL_AUTOMATION_BYPASS_SECRET');
  });

  it('reports unknown keys and bad references clearly', () => {
    assert.throws(() => parseConfig({ startCmd: 'x' }, { repoRoot: '/repo' }), /Invalid configuration/);
    assert.throws(() => parseConfig({ routes: [{ path: '/', viewports: ['tablet'] }] }, { repoRoot: '/repo' }), /unknown viewport "tablet"/);
  });

  it('picks viewports by name or inline size', () => {
    const cfg = parseConfig({}, { repoRoot: '/repo' });
    assert.equal(pickViewports(cfg, ['mobile'])[0].width, 390);
    assert.deepEqual(pickViewports(cfg, ['tablet:820x1180@2'])[0], { name: 'tablet', width: 820, height: 1180, deviceScaleFactor: 2 });
    assert.throws(() => pickViewports(cfg, ['watch']), UiDiffError);
    assert.throws(() => pickThemes(cfg, ['dark']), UiDiffError);
  });

  it('builds route slugs', () => {
    assert.equal(routeSlug('/'), 'home');
    assert.equal(routeSlug('/pricing/plans'), 'pricing-plans');
    assert.equal(routeSlug('/about.html'), 'about');
    assert.equal(routeSlug('/x', 'Checkout Flow'), 'checkout-flow');
    assert.equal(toRepoGlob('!**/*.test.ts', 'web'), '!/web/**/*.test.ts');
  });
});
