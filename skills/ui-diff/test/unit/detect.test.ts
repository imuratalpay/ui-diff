import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseConfig } from '../../src/config.js';
import { detectStatus, mapChangesToRoutes } from '../../src/detect.js';
import type { ChangedFile } from '../../src/git.js';
import { aliasesFromPackageImports, aliasesFromTsconfig, extractSpecifiers, resolveSpecifier } from '../../src/imports.js';

function reader(files: Record<string, string>) {
  return async (paths: string[]) => new Map(paths.filter((p) => p in files).map((p) => [p, files[p]]));
}

const changed = (...paths: string[]): ChangedFile[] => paths.map((path) => ({ status: 'M', path }));

describe('mapChangesToRoutes', () => {
  it('uses configured route globs and global files', async () => {
    const cfg = parseConfig(
      { routes: [{ path: '/', files: ['index.html', 'home.css'] }, { path: '/about.html', files: ['about.html'] }], globalFiles: ['styles.css'] },
      { file: '/repo/site/ui-diff.config.json', repoRoot: '/repo' },
    );
    const headFiles = ['site/index.html', 'site/about.html', 'site/home.css', 'site/styles.css'];
    const onlyHome = await mapChangesToRoutes({ cfg, changed: changed('site/home.css'), headFiles, readFiles: reader({}) });
    assert.deepEqual(
      onlyHome.routes.map((r) => r.route.path),
      ['/'],
    );
    assert.equal(onlyHome.routes[0].confidence, 'high');
    assert.match(onlyHome.routes[0].reasons[0], /site\/home\.css matches site\/home\.css/);

    const global = await mapChangesToRoutes({ cfg, changed: changed('site/styles.css'), headFiles, readFiles: reader({}) });
    assert.deepEqual(global.routes.map((r) => r.route.path).sort(), ['/', '/about.html']);
    assert.deepEqual(global.globalFiles, ['site/styles.css']);
  });

  it('maps framework pages and layouts by convention', async () => {
    const cfg = parseConfig({}, { repoRoot: '/repo' });
    const headFiles = ['app/page.tsx', 'app/pricing/page.tsx', 'app/blog/[slug]/page.tsx', 'app/layout.tsx', 'app/dashboard/page.tsx'];
    const result = await mapChangesToRoutes({ cfg, changed: changed('app/pricing/page.tsx', 'app/blog/[slug]/page.tsx'), headFiles, readFiles: reader({}) });
    assert.deepEqual(result.routes.map((r) => r.route.path), ['/pricing']);
    assert.deepEqual(result.needsExample, [{ file: 'app/blog/[slug]/page.tsx', route: '/blog/[slug]' }]);

    const layout = await mapChangesToRoutes({ cfg, changed: changed('app/layout.tsx'), headFiles, readFiles: reader({}) });
    assert.deepEqual(layout.routes.map((r) => r.route.path).sort(), ['/', '/dashboard', '/pricing']);
    assert.ok(layout.routes.every((r) => r.confidence === 'medium'));
  });

  it('follows imports from components, aliases and CSS to pages', async () => {
    const cfg = parseConfig({ detect: { aliases: { '~/': 'src/' } } }, { repoRoot: '/repo' });
    const files: Record<string, string> = {
      'src/pages/index.tsx': "import { Hero } from '../components/Hero';\nexport default () => <Hero/>;",
      'src/pages/about.tsx': "import Card from '@/components/Card';\nimport '~/styles/about.css';",
      'src/components/Hero.tsx': "import { Button } from './Button';\nimport styles from './Hero.module.css';",
      'src/components/Button.tsx': 'export const Button = () => null;',
      'src/components/Hero.module.css': ".hero { background: url('../assets/hero.png') }",
      'src/components/Card.tsx': "export default function Card() { return <img src='/logo.svg'/> }",
      'src/styles/about.css': "@import './shared.css';",
      'src/styles/shared.css': 'body{}',
      'tsconfig.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }',
    };
    const headFiles = [...Object.keys(files), 'src/assets/hero.png', 'public/logo.svg', 'src/utils/unused.ts'];
    const result = await mapChangesToRoutes({
      cfg,
      changed: changed('src/components/Button.tsx', 'src/styles/shared.css', 'src/assets/hero.png', 'public/logo.svg', 'src/utils/unused.ts'),
      headFiles,
      readFiles: reader(files),
    });
    const byRoute = Object.fromEntries(result.routes.map((r) => [r.route.path, r.reasons.join(' | ')]));
    assert.match(byRoute['/'], /src\/components\/Button\.tsx → … → src\/pages\/index\.tsx/);
    assert.match(byRoute['/'], /src\/assets\/hero\.png/);
    assert.match(byRoute['/about'], /src\/styles\/shared\.css/);
    assert.match(byRoute['/about'], /public\/logo\.svg/);
    assert.deepEqual(result.unmatched, ['src/utils/unused.ts']);
  });

  it('caps the number of routes and reports the rest', async () => {
    const cfg = parseConfig({ detect: { maxRoutes: 2 } }, { repoRoot: '/repo' });
    const headFiles = ['pages/a.tsx', 'pages/b.tsx', 'pages/c.tsx'];
    const result = await mapChangesToRoutes({ cfg, changed: changed(...headFiles), headFiles, readFiles: reader({}) });
    assert.equal(result.routes.length, 2);
    assert.equal(result.skippedRoutes.length, 1);
    assert.match(result.notes[0], /beyond detect.maxRoutes=2/);
  });

  it('ignores files outside the UI include list', async () => {
    const cfg = parseConfig({}, { repoRoot: '/repo' });
    const result = await mapChangesToRoutes({ cfg, changed: changed('README.md', 'src/a.test.tsx', 'package.json'), headFiles: [], readFiles: reader({}) });
    assert.deepEqual(result.uiFiles, []);
    assert.deepEqual(result.routes, []);
  });
});

describe('imports', () => {
  it('extracts specifiers from JS, CSS and HTML', () => {
    assert.deepEqual(extractSpecifiers("import a from './a';\nimport type { B } from \"../b\";\nexport * from './c';\nconst d = import('./d');\nrequire('./e')", 'x.ts').sort(), ['../b', './a', './c', './d', './e']);
    assert.deepEqual(extractSpecifiers("@import 'base.css';\n.x { background: url(\"img/bg.png\") }", 'x.css').sort(), ['base.css', 'img/bg.png']);
    assert.deepEqual(extractSpecifiers('<link href="styles.css"><script src="/app.js"></script><a href="https://x.dev">', 'index.html').sort(), ['/app.js', 'styles.css']);
    assert.deepEqual(extractSpecifiers("import { Hero } from '#/components/hero';\nconst a = <a href=\"#top\">top</a>;", 'x.tsx'), ['#/components/hero']);
  });

  it('resolves extensions, index files, TS-style .js imports and SCSS partials', () => {
    const ctx = { files: new Set(['src/a.ts', 'src/b/index.tsx', 'src/c.ts', 'styles/_vars.scss', 'site/styles.css']), aliases: {}, packages: {}, webRoots: ['site'] };
    assert.equal(resolveSpecifier('./a', 'src/x.ts', ctx), 'src/a.ts');
    assert.equal(resolveSpecifier('./b', 'src/x.ts', ctx), 'src/b/index.tsx');
    assert.equal(resolveSpecifier('./c.js', 'src/x.ts', ctx), 'src/c.ts');
    assert.equal(resolveSpecifier('vars', 'styles/main.scss', ctx), 'styles/_vars.scss');
    assert.equal(resolveSpecifier('/styles.css', 'site/index.html', ctx), 'site/styles.css');
    assert.equal(resolveSpecifier('react', 'src/x.ts', ctx), undefined);
  });

  it('turns tsconfig paths into aliases', () => {
    const aliases = aliasesFromTsconfig('{ // comment\n "compilerOptions": { "baseUrl": "./", "paths": { "@/*": ["./src/*"], "@ui": ["../../packages/ui/index.ts"] } } }', 'apps/web');
    assert.deepEqual(aliases, { '@/': 'apps/web/src/', '@ui': 'packages/ui/index.ts' });
  });

  it('turns package.json subpath imports into aliases', () => {
    const pkg = JSON.stringify({ imports: { '#/*': './src/*', '#ui': { types: './ui.d.ts', default: './src/ui/index.ts' }, '#ext/*': 'some-package/*', '#bad': './x/*' } });
    assert.deepEqual(aliasesFromPackageImports(pkg, 'apps/web'), { '#/': 'apps/web/src/', '#ui': 'apps/web/src/ui/index.ts' });
    assert.deepEqual(aliasesFromPackageImports('not json', ''), {});
  });

  it('maps TanStack Router pages through package.json # imports', async () => {
    const cfg = parseConfig({}, { repoRoot: '/repo' });
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'web', imports: { '#/*': './src/*' } }),
      'src/routes/__root.tsx': 'export const Route = 1;',
      'src/routes/_marketing/pricing.tsx': "import { Hero } from '#/components/hero';",
      'src/routes/_marketing/index.tsx': "import { Footer } from '#/components/footer';",
      'src/components/hero.tsx': 'export const Hero = 1;',
      'src/components/footer.tsx': 'export const Footer = 1;',
    };
    const result = await mapChangesToRoutes({ cfg, changed: changed('src/components/hero.tsx'), headFiles: Object.keys(files), readFiles: reader(files) });
    assert.deepEqual(result.routes.map((r) => r.route.path), ['/pricing']);
  });
});

describe('detect status', () => {
  it('says whether a run would capture, report unmapped UI files, or have nothing to do', () => {
    const route = { route: { path: '/' } } as unknown as Parameters<typeof detectStatus>[0]['routes'][number];
    assert.equal(detectStatus({ routes: [route], uiFiles: ['index.html'] }), 'capture');
    assert.equal(detectStatus({ routes: [], uiFiles: ['src/widgets/Chart.tsx'] }), 'nothing-mapped');
    assert.equal(detectStatus({ routes: [], uiFiles: [] }), 'no-ui-changes');
  });
});
