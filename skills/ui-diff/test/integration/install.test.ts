import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../../src/version.js';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The skill as a fresh clone has it: tracked and unignored files, no node_modules, no dist. */
function cleanCopy(dest: string): void {
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: skillRoot, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const file of files) {
    mkdirSync(path.dirname(path.join(dest, file)), { recursive: true });
    cpSync(path.join(skillRoot, file), path.join(dest, file));
  }
}

function npx(cwd: string, spec: string, ...args: string[]) {
  return spawnSync('npx', ['--yes', '--prefer-offline', '--package', spec, 'ui-diff', ...args], { cwd, encoding: 'utf8', timeout: 600_000 });
}

describe('npx from a clean directory', { timeout: 900_000 }, () => {
  let dir: string;
  let empty: string;

  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ui-diff-npx-'));
    empty = path.join(dir, 'empty');
    mkdirSync(empty);
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('runs from a packed tarball without installing or building anything more', () => {
    const source = path.join(dir, 'source');
    cleanCopy(source);
    execFileSync('npm', ['ci', '--no-audit', '--no-fund', '--prefer-offline', '--loglevel=error'], { cwd: source, stdio: 'ignore' });
    execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: source, stdio: 'ignore' });
    const tarball = path.join(dir, readdirSync(dir).find((f) => f.endsWith('.tgz'))!);
    assert.equal(path.basename(tarball), `ui-diff-${VERSION}.tgz`);
    const run = npx(empty, tarball, '--version');
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), VERSION);
    assert.doesNotMatch(run.stderr, /installing ui-diff dependencies|building ui-diff/, 'the package ships its build and npx installed its dependencies');
  });

  it('runs from a clean copy of the skill folder, installing and building once', () => {
    const copy = path.join(dir, 'copy');
    cleanCopy(copy);
    const first = npx(empty, copy, '--version');
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout.trim(), VERSION);
    assert.match(first.stderr, /building ui-diff/);
    const second = npx(empty, copy, '--version');
    assert.equal(second.status, 0, second.stderr);
    assert.doesNotMatch(second.stderr, /installing ui-diff dependencies|building ui-diff/);
  });
});
