import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { baseCacheKey, pruneBaseCache, restoreBaseCache, storeBaseCache, type BaseCacheInputs } from '../../src/cache.js';
import type { CaptureRecord } from '../../src/capture.js';

const inputs: BaseCacheInputs = {
  baseSha: '6737326b2e051665eb7b14a33d39acee32ff22de',
  config: { plans: [{ id: 'home__desktop__light', viewport: { width: 1280, height: 800 } }], freeze: { clock: true, time: 'run-start' } },
  browser: { name: 'chromium', version: '159.0.8154.6' },
  uiDiffVersion: '0.1.0',
};

function record(dir: string, id: string, ok = true): CaptureRecord {
  const file = path.join(dir, 'captures', 'base', `${id}.png`);
  const stylesFile = path.join(dir, 'styles', 'base', `${id}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  mkdirSync(path.dirname(stylesFile), { recursive: true });
  writeFileSync(file, `png ${id}`);
  writeFileSync(stylesFile, `{"elements":[],"colors":{},"id":"${id}"}`);
  return { id, side: 'base', ok, file, stylesFile, consoleErrors: [], pageErrors: [], truncated: false, stable: true, attempts: 2, durationMs: 900, scale: 1 };
}

describe('base cache key', () => {
  it('is stable for the same inputs and changes with any of them', () => {
    const { key } = baseCacheKey(inputs);
    assert.match(key, /^base-6737326b2e05-[0-9a-f]{16}$/);
    assert.equal(baseCacheKey(structuredClone(inputs)).key, key);
    const variants: BaseCacheInputs[] = [
      { ...inputs, baseSha: 'cc13cab81ca4c056ebe8ed861cce6747f2495e59' },
      { ...inputs, config: { ...(inputs.config as object), plans: [{ id: 'home__desktop__light', viewport: { width: 1440, height: 800 } }] } },
      { ...inputs, config: { ...(inputs.config as object), freeze: { clock: false, time: 'run-start' } } },
      { ...inputs, browser: { name: 'chromium', version: '160.0.0.0' } },
      { ...inputs, browser: { name: 'chrome', version: '159.0.8154.6' } },
      { ...inputs, uiDiffVersion: '0.2.0' },
    ];
    for (const v of variants) assert.notEqual(baseCacheKey(v).key, key, JSON.stringify(v));
  });
});

describe('base cache entries', () => {
  it('stores a complete capture set and restores it with the same file names', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-cache-'));
    try {
      const cache = path.join(dir, 'cache');
      const run = path.join(dir, 'run1');
      const { key } = baseCacheKey(inputs);
      const records = [record(run, 'home__desktop__light'), record(run, 'home__mobile__light')];
      assert.equal(storeBaseCache(cache, { key, createdAt: '2026-11-21T10:00:00.000Z', frozenAt: '2026-11-21T09:59:59.000Z', side: { sha: inputs.baseSha, shortSha: '6737326' }, records }), true);
      const out = path.join(dir, 'run2');
      const entry = restoreBaseCache(cache, key, out)!;
      assert.equal(entry.frozenAt, '2026-11-21T09:59:59.000Z');
      assert.deepEqual(entry.records.map((r) => path.relative(out, r.file!)), ['captures/base/home__desktop__light.png', 'captures/base/home__mobile__light.png']);
      assert.equal(readFileSync(entry.records[1].stylesFile!, 'utf8'), '{"elements":[],"colors":{},"id":"home__mobile__light"}');
      assert.equal(entry.records[0].durationMs, 900);
      assert.equal(restoreBaseCache(cache, baseCacheKey({ ...inputs, uiDiffVersion: '9' }).key, out), undefined, 'another key is a miss');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never reuses a partial entry', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-cache-'));
    try {
      const cache = path.join(dir, 'cache');
      const { key } = baseCacheKey(inputs);
      assert.equal(storeBaseCache(cache, { key, createdAt: 'now', side: { sha: 'a', shortSha: 'a' }, records: [record(dir, 'a'), record(dir, 'b', false)] }), false, 'a set with a failed capture is not stored');
      assert.equal(existsSync(path.join(cache, key)), false);
      storeBaseCache(cache, { key, createdAt: 'now', side: { sha: 'a', shortSha: 'a' }, records: [record(dir, 'a'), record(dir, 'b')] });
      rmSync(path.join(cache, key, 'captures', 'b.png'));
      assert.equal(restoreBaseCache(cache, key, path.join(dir, 'out')), undefined, 'a missing file is a miss');
      rmSync(path.join(cache, key), { recursive: true });
      mkdirSync(path.join(cache, key, 'captures'), { recursive: true });
      writeFileSync(path.join(cache, key, 'captures', 'a.png'), 'png');
      assert.equal(restoreBaseCache(cache, key, path.join(dir, 'out')), undefined, 'no manifest (interrupted write) is a miss');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stores and restores the hover and focus crops, and misses when one is gone', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-cache-states-'));
    try {
      const cache = path.join(dir, 'cache');
      const rec = record(dir, 'home');
      const crop = path.join(dir, 'states', 'base', 'home__1-hover.png');
      mkdirSync(path.dirname(crop), { recursive: true });
      writeFileSync(crop, 'png hover');
      const styles = { color: '#ffffff', background: '#1d4ed8', 'border-color': 'none', outline: 'none', 'box-shadow': 'none', transform: 'none', opacity: '1', 'text-decoration': 'none', cursor: 'pointer' };
      rec.states = { checked: 1, skipped: 0, skippedWhy: {}, targets: [{ selector: 'button.save', defaults: { ...styles, background: '#2563eb' } }], shots: [{ selector: 'button.save', state: 'hover', styles, file: crop }] };
      const { key } = baseCacheKey(inputs);
      assert.equal(storeBaseCache(cache, { key, createdAt: 'now', side: { sha: 'a', shortSha: 'a' }, records: [rec] }), true);
      const out = path.join(dir, 'out');
      const entry = restoreBaseCache(cache, key, out)!;
      const shot = entry.records[0].states!.shots[0];
      assert.equal(shot.file, path.join(out, 'states', 'base', 'home__1-hover.png'));
      assert.equal(readFileSync(shot.file, 'utf8'), 'png hover');
      assert.deepEqual(entry.records[0].states!.targets, rec.states.targets);
      rmSync(path.join(cache, key, 'states', 'home__1-hover.png'));
      assert.equal(restoreBaseCache(cache, key, path.join(dir, 'out2')), undefined, 'a missing crop is a miss');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps only the most recent entries', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-cache-'));
    try {
      for (let i = 0; i < 4; i++) {
        mkdirSync(path.join(dir, `base-${i}`));
        utimesSync(path.join(dir, `base-${i}`), new Date(1000 * i), new Date(1000 * i));
      }
      pruneBaseCache(dir, 2);
      assert.deepEqual(readdirSync(dir).sort(), ['base-2', 'base-3']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
