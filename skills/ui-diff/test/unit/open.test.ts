import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { defaultOpener, openOutputs, openTargets } from '../../src/open.js';

const dirs: string[] = [];
function outDir(files: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ui-diff-open-'));
  dirs.push(dir);
  for (const f of files) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), '');
  }
  return dir;
}

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('check --open', () => {
  it('opens the images folder and report.json with the default app of each platform', () => {
    const dir = outDir(['compare/home__pair-1.png', 'report.json']);
    const calls: string[][] = [];
    const result = openOutputs(dir, { platform: 'linux', run: (cmd, args) => (calls.push([cmd, ...args]), { status: 0, error: undefined }) });
    assert.deepEqual(calls, [['xdg-open', path.join(dir, 'compare')], ['xdg-open', path.join(dir, 'report.json')]]);
    assert.equal(result.opener, 'xdg-open');
    assert.equal(result.opened.length, 2);
    assert.ok(result.opened[0].endsWith(`compare${path.sep}`) && result.opened[1].endsWith('report.json'));
    assert.deepEqual([defaultOpener('darwin'), defaultOpener('win32')], ['open', 'explorer']);
  });

  it('opens only what exists, and nothing when there is no output', () => {
    assert.deepEqual(openTargets(outDir(['report.json'])).map((t) => path.basename(t)), ['report.json']);
    assert.deepEqual(openTargets(outDir(['compare/.keep'])).map((t) => path.basename(t)), ['compare']);
    const empty = outDir([]);
    mkdirSync(path.join(empty, 'compare'));
    assert.deepEqual(openTargets(empty), [], 'an empty compare/ is not worth opening');
    const run = () => assert.fail('nothing should be run');
    assert.deepEqual(openOutputs(empty, { run }), { opened: [], failed: [] });
  });

  it('does not claim to have opened what the handler refused', () => {
    const dir = outDir(['compare/a.png', 'report.json']);
    const missing = openOutputs(dir, { platform: 'linux', run: () => ({ status: null, error: Object.assign(new Error('spawnSync xdg-open ENOENT'), { code: 'ENOENT' }) }) });
    assert.deepEqual(missing.opened, []);
    assert.match(missing.failed[0], /compare.* \(spawnSync xdg-open ENOENT\)$/);
    const refused = openOutputs(dir, { platform: 'darwin', run: (_, [target]) => ({ status: target.endsWith('.json') ? 1 : 0, error: undefined }) });
    assert.equal(refused.opened.length, 1);
    assert.match(refused.failed[0], /report\.json \(open exited with 1\)$/);
    const windows = openOutputs(dir, { platform: 'win32', run: () => ({ status: 1, error: undefined }) });
    assert.equal(windows.opened.length, 2, 'explorer exits 1 after opening');
  });
});
