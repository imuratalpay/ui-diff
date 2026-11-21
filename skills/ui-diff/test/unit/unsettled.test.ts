import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createImage, encodePng, fillRect } from '../../src/image.js';
import { changedRegions, onlyInUnsettled, unsettledWarning } from '../../src/unsettled.js';

function shot(rects: Array<[number, number, number, number]>, width = 200, height = 120): Buffer {
  const png = createImage(width, height);
  for (const [x, y, w, h] of rects) fillRect(png, { x, y, width: w, height: h }, [37, 99, 235, 255]);
  return encodePng(png);
}

describe('unsettled pages', () => {
  it('finds the exact area that changed between two screenshots', () => {
    assert.deepEqual(changedRegions(shot([[20, 30, 10, 10]]), shot([[23, 30, 10, 10]])), [
      { x: 20, y: 30, width: 13, height: 10 },
    ]);
    assert.deepEqual(changedRegions(shot([]), shot([])), []);
    assert.deepEqual(changedRegions(shot([], 200, 120), shot([], 200, 130)), [], 'a page that grew has no single area to blame');
  });

  it('names the element and the config that fixes it', () => {
    const warning = unsettledWarning('base', { stable: true, frozeTimers: true, unsettled: [{ selector: 'div.track', box: { x: 40, y: 98, width: 602, height: 202 } }] });
    assert.match(warning, /^base: page did not settle: div\.track \(602×202 px at 40,98\) kept changing between screenshots/);
    assert.match(warning, /timers were paused for the screenshot/);
    assert.match(warning, /"capture": \{ "mask": \["div\.track"\] \}/);
    assert.match(warning, /freeze\.clock/);
    assert.doesNotMatch(unsettledWarning('head', { stable: false, frozeTimers: true, unsettled: [{ box: { x: 0, y: 0, width: 5, height: 5 } }] }), /timers were paused/);
    assert.match(unsettledWarning('head', { stable: false }), /^head: page did not settle .*capture\.mask.*freeze\.clock/);
  });

  it('tells when every difference is inside areas that moved by themselves', () => {
    const unsettled = [
      { selector: '#bar', box: { x: 313, y: 98, width: 40, height: 40 } },
      { selector: '#bar', box: { x: 325, y: 98, width: 40, height: 40 } },
    ];
    assert.equal(onlyInUnsettled([{ x: 626, y: 196, width: 104, height: 80 }], unsettled, 2), true, 'base and head stopped at different spots');
    assert.equal(onlyInUnsettled([{ x: 626, y: 196, width: 104, height: 80 }, { x: 0, y: 400, width: 50, height: 20 }], unsettled, 2), false);
    assert.equal(onlyInUnsettled([{ x: 0, y: 0, width: 10, height: 10 }], [], 1), false);
  });
});
