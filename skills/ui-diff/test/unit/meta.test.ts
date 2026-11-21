import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parseConfig } from '../../src/config.js';
import { configJsonSchema } from '../../src/schema.js';
import { VERSION } from '../../src/version.js';

const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

describe('package metadata', () => {
  it('keeps VERSION in sync with package.json', () => {
    assert.equal(VERSION, JSON.parse(read('package.json')).version);
  });

  it('has a CHANGELOG entry for this version, and the lockfile says the same version', () => {
    assert.match(read('../../CHANGELOG.md'), new RegExp(`^## ${VERSION.replace(/\./g, '\\.')}$`, 'm'));
    const lock = JSON.parse(read('package-lock.json'));
    assert.deepEqual([lock.version, lock.packages[''].version], [VERSION, VERSION]);
  });

  it('ships what npx needs to run without a build step', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.ok(pkg.files.includes('dist') && pkg.files.includes('tsconfig.json'), 'the build and what rebuilds it');
    assert.equal(pkg.scripts.prepare, undefined, 'no build on install: a linked folder has no compiler yet');
    assert.equal(pkg.scripts.prepack, 'tsc -p tsconfig.json');
  });

  it('keeps the committed JSON schema up to date (run `npm run schema`)', () => {
    assert.deepEqual(JSON.parse(read('schema/ui-diff.config.schema.json')), configJsonSchema());
  });

  it('has SKILL.md frontmatter with a matching name and a description', () => {
    const skill = read('SKILL.md');
    const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? '';
    assert.match(front, /^name: ui-diff$/m);
    const description = /^description: (.+)$/m.exec(front)?.[1] ?? '';
    assert.ok(description.length > 80 && description.length <= 1024, `description length ${description.length}`);
  });

  it('accepts the example configuration in the repository', () => {
    const example = JSON.parse(read('../../examples/sample-site/ui-diff.config.json'));
    assert.doesNotThrow(() => parseConfig(example, { repoRoot: '/repo', file: '/repo/examples/sample-site/ui-diff.config.json' }));
  });
});
