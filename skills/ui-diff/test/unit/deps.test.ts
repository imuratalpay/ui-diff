import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parseConfig } from '../../src/config.js';
import { DEFAULT_UI_PACKAGES, diffDependencies, isUiPackage, lockfileVersions } from '../../src/deps.js';
import { detectChanges, detectStatus, mapChangesToRoutes } from '../../src/detect.js';
import { renderComment } from '../../src/markdown.js';
import { autoSummary } from '../../src/report.js';
import { sampleReport } from './fixtures.js';

const pkg = (deps: Record<string, string>, dev: Record<string, string> = {}) => JSON.stringify({ name: 'app', dependencies: deps, devDependencies: dev });

describe('dependency changes', () => {
  it('classifies UI packages with wildcards', () => {
    for (const name of ['react', 'next', 'tailwindcss', '@radix-ui/react-dialog', 'postcss-nesting', '@fontsource/inter', 'framer-motion']) assert.ok(isUiPackage(name, DEFAULT_UI_PACKAGES), name);
    for (const name of ['lodash', 'zod', 'react-query-devtools', '@types/node', 'eslint']) assert.ok(!isUiPackage(name, DEFAULT_UI_PACKAGES), name);
  });

  it('diffs package.json ranges and prefers the versions a lockfile resolved', () => {
    const lock = (react: string, lodash: string) =>
      JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/react': { version: react }, 'node_modules/lodash': { version: lodash }, 'node_modules/a/node_modules/lodash': { version: '3.0.0' } } });
    const { changes, unparsed } = diffDependencies(
      [
        { file: 'package.json', base: pkg({ react: '^18.2.0', lodash: '^4.17.20' }), head: pkg({ react: '^18.3.0', lodash: '^4.17.20' }, { zod: '^4.0.0' }) },
        { file: 'package-lock.json', base: lock('18.2.0', '4.17.20'), head: lock('18.3.1', '4.17.21') },
      ],
      DEFAULT_UI_PACKAGES,
    );
    assert.deepEqual(unparsed, []);
    assert.deepEqual(changes, [
      { name: 'react', from: '18.2.0', to: '18.3.1', file: 'package-lock.json', ui: true },
      { name: 'lodash', from: '3.0.0, 4.17.20', to: '3.0.0, 4.17.21', file: 'package-lock.json', ui: false },
      { name: 'zod', from: undefined, to: '^4.0.0', file: 'package.json', ui: false },
    ]);
  });

  it('reads pnpm, yarn (classic and berry) and bun.lock, and gives up on bun.lockb', () => {
    const pnpm = "lockfileVersion: '9.0'\npackages:\n  '@radix-ui/react-dialog@1.1.2':\n    resolution: {}\n  react-dom@18.3.1(react@18.3.1):\n    dependencies: {}\n";
    assert.deepEqual([...lockfileVersions('pnpm-lock.yaml', pnpm)!].map(([n, v]) => [n, [...v]]), [['@radix-ui/react-dialog', ['1.1.2']], ['react-dom', ['18.3.1']], ['react', ['18.3.1']]]);
    const yarn1 = '# yarn lockfile v1\n\n"react@^18.2.0", react@^18.3.0:\n  version "18.3.1"\n  resolved "x"\n\n"@emotion/react@^11.0.0":\n  version "11.13.3"\n';
    assert.deepEqual([...lockfileVersions('yarn.lock', yarn1)!].map(([n, v]) => [n, [...v]]), [['react', ['18.3.1']], ['@emotion/react', ['11.13.3']]]);
    const berry = '__metadata:\n  version: 8\n\n"tailwindcss@npm:^4.0.0":\n  version: 4.0.7\n  resolution: "tailwindcss@npm:4.0.7"\n';
    assert.deepEqual([...lockfileVersions('yarn.lock', berry)!.get('tailwindcss')!], ['4.0.7']);
    const bun = '{ "lockfileVersion": 1, "packages": { "next": ["next@15.1.0", "", {}, "sha512-x"] } }';
    assert.deepEqual([...lockfileVersions('bun.lock', bun)!.get('next')!], ['15.1.0']);
    assert.equal(lockfileVersions('bun.lockb', '\u0000binary'), undefined);
    assert.deepEqual(diffDependencies([{ file: 'bun.lockb', base: 'a', head: 'b' }], DEFAULT_UI_PACKAGES), { changes: [], unparsed: ['bun.lockb'] });
  });
});

describe('dependency changes in route mapping', () => {
  const cfg = (extra: Record<string, unknown> = {}) => parseConfig({ routes: ['/', '/pricing', '/about'], ...extra }, { repoRoot: '/repo' });
  const input = (c: ReturnType<typeof cfg>, changes: Array<{ name: string; from?: string; to?: string; ui: boolean }>) => ({
    cfg: c,
    changed: [{ path: 'package.json', status: 'M' }],
    headFiles: ['package.json', 'index.html'],
    readFiles: async () => new Map<string, string>(),
    dependencies: { changes: changes.map((d) => ({ ...d, file: 'package.json' })), unparsed: [] },
  });

  it('captures every route when a UI package changed', async () => {
    const r = await mapChangesToRoutes(input(cfg(), [{ name: 'react', from: '18.2.0', to: '18.3.1', ui: true }]));
    assert.deepEqual(r.routes.map((h) => h.route.path).sort(), ['/', '/about', '/pricing']);
    assert.deepEqual(r.routes[0].reasons, ['UI dependency changed: react 18.2.0 → 18.3.1']);
    assert.equal(detectStatus(r), 'capture');
  });

  it('captures only detect.dependencyRoutes when they are set', async () => {
    const r = await mapChangesToRoutes(input(cfg({ detect: { dependencyRoutes: ['/pricing'] } }), [{ name: 'tailwindcss', from: '3.4.1', to: '4.0.0', ui: true }]));
    assert.deepEqual(r.routes.map((h) => h.route.path), ['/pricing']);
  });

  it('captures nothing for other packages, and keeps them listed', async () => {
    const r = await mapChangesToRoutes(input(cfg(), [{ name: 'lodash', from: '4.17.20', to: '4.17.21', ui: false }]));
    assert.deepEqual(r.routes, []);
    assert.equal(detectStatus(r), 'no-ui-changes');
    assert.deepEqual(r.dependencies.map((d) => d.name), ['lodash']);
  });

  it('reads both sides of package.json from git', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-deps-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
      const commit = (msg: string) => {
        git('add', '-A');
        git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', msg);
        return git('rev-parse', 'HEAD');
      };
      git('init', '-q', '-b', 'main');
      writeFileSync(path.join(dir, 'index.html'), '<h1>Hi</h1>');
      writeFileSync(path.join(dir, 'ui-diff.config.json'), JSON.stringify({ routes: ['/'] }));
      writeFileSync(path.join(dir, 'package.json'), pkg({ react: '^18.2.0', lodash: '^4.17.20' }));
      const base = commit('base');
      writeFileSync(path.join(dir, 'package.json'), pkg({ react: '^18.2.0', lodash: '^4.17.21' }));
      const other = commit('lodash');
      writeFileSync(path.join(dir, 'package.json'), pkg({ react: '^19.0.0', lodash: '^4.17.21' }));
      const ui = commit('react');
      const config = parseConfig({ routes: ['/'] }, { repoRoot: dir });
      const quiet = await detectChanges(config, { base, head: other });
      assert.equal(detectStatus(quiet), 'no-ui-changes');
      assert.deepEqual(quiet.dependencies, [{ name: 'lodash', from: '^4.17.20', to: '^4.17.21', file: 'package.json', ui: false }]);
      const loud = await detectChanges(config, { base, head: ui });
      assert.equal(detectStatus(loud), 'capture');
      assert.deepEqual(loud.routes.map((h) => h.reasons[0]), ['UI dependency changed: react ^18.2.0 → ^19.0.0']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('dependency changes in the comment', () => {
  it('names UI dependencies that caused captures and lists the rest as not checked', () => {
    const r = sampleReport();
    r.detect = {
      uiFiles: [],
      unmatched: [],
      skippedRoutes: [],
      needsExample: [],
      notes: [],
      dependencies: [
        { name: 'react', from: '18.2.0', to: '18.3.1', file: 'package-lock.json', ui: true },
        { name: 'lodash', from: '4.17.20', to: '4.17.21', file: 'package-lock.json', ui: false },
      ],
      unparsedLockfiles: ['bun.lockb'],
    };
    const body = renderComment(r, { id: 'default', title: 'UI diff', link: (p) => p, summary: 'Custom.' });
    assert.match(body, /UI dependency changes \(routes captured because of them\): `react 18\.2\.0 → 18\.3\.1`/);
    assert.match(body, /Dependency changes not checked visually: `lodash 4\.17\.20 → 4\.17\.21`/);
    assert.match(body, /`bun\.lockb` changed, but its packages could not be read/);
    assert.match(autoSummary(r), /1 dependency change not checked visually \(lodash 4\.17\.20 → 4\.17\.21\)/);
  });
});
