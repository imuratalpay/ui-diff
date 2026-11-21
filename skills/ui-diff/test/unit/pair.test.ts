import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PNG } from 'pngjs';
import { blinkFrames, clipToFocus, composePair, diffPngs } from '../../src/diff.js';
import { renderComment } from '../../src/markdown.js';
import { encodeBlinkGif } from '../../src/motion.js';
import { sampleReport } from './fixtures.js';

function image(width: number, height: number, paint: Array<[number, number, number, number]> = []): PNG {
  const png = new PNG({ width, height });
  png.data.fill(255);
  for (const [x, y, w, h] of paint) for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) png.data.set([0, 0, 0, 255], (yy * width + xx) * 4);
  return png;
}

const diff = diffPngs(image(400, 200), image(400, 200, [[100, 80, 40, 20]]), { threshold: 0.1, includeAA: false, minChangedPixels: 8, highlight: '#FF0080', alignShifts: false });
const box = { x: 60, y: 40, width: 160, height: 100 };
const labels = { before: 'BEFORE 1a2b3c4', after: 'AFTER 5d6e7f8' };

describe('still pair and blink of a changed area', () => {
  it('puts base and head side by side with the changed box outlined on both', () => {
    const pair = composePair(diff, box, labels, { highlight: '#FF0080', scale: 1 });
    assert.ok(pair.width > 2 * box.width && pair.width < 2 * box.width + 200, `two panels: ${pair.width}`);
    let magenta = 0;
    for (let i = 0; i < pair.data.length; i += 4) if (pair.data[i] === 255 && pair.data[i + 1] === 0 && pair.data[i + 2] === 128) magenta++;
    assert.ok(magenta > 2 * 2 * (40 + 20), `the region outline is drawn on both panels (${magenta} px)`);
  });

  it('thickens the outline when a wide crop will be scaled down', () => {
    // A 2px line scaled to half blends into a pale 1px line; it should stay a saturated one.
    const saturated = (png: PNG) => {
      let n = 0;
      for (let i = 0; i < png.data.length; i += 4) if (png.data[i] > 220 && png.data[i + 1] < 40 && png.data[i + 2] > 90 && png.data[i + 2] < 170) n++;
      return n;
    };
    const shrunk = composePair(diff, box, labels, { highlight: '#FF0080', scale: 1, maxWidth: 160 });
    assert.ok(saturated(shrunk) > 60, `the outline survives the scale-down (${saturated(shrunk)} saturated px)`);
  });

  it('makes two frames of the same size and a looping two-frame GIF', () => {
    const [a, b] = blinkFrames(diff, box, labels, { highlight: '#FF0080', scale: 1, maxWidth: 800 });
    assert.deepEqual([a.width, a.height], [b.width, b.height]);
    const gif = encodeBlinkGif([a, b]);
    assert.equal(gif.subarray(0, 6).toString(), 'GIF89a');
    let frames = 0;
    for (let i = 0; i < gif.length - 2; i++) if (gif[i] === 0x21 && gif[i + 1] === 0xf9 && gif[i + 2] === 0x04) frames++;
    assert.equal(frames, 2);
  });

  it('keeps a crop inside the focused elements it touches', () => {
    assert.deepEqual(clipToFocus({ x: 0, y: 0, width: 400, height: 200 }, [{ x: 50, y: 20, width: 100, height: 60 }, { x: 900, y: 900, width: 10, height: 10 }]), { x: 50, y: 20, width: 100, height: 60 });
    assert.deepEqual(clipToFocus(box, undefined), box);
  });

  it('shows the still pair first and folds the blink and the diff away', () => {
    const r = sampleReport();
    r.captures[0].images = { ...r.captures[0].images, pairs: ['compare/home__desktop__light__pair-1.png'], blinks: ['compare/home__desktop__light__blink-1.gif'] };
    const body = renderComment(r, { id: 'default', title: 'UI diff', link: (p) => p });
    const pair = body.indexOf('pair-1.png');
    const details = body.indexOf('<details><summary>Blink and diff</summary>');
    assert.ok(pair > 0 && pair < details, 'pair before the details');
    assert.ok(body.indexOf('blink-1.gif') > details && body.indexOf('focus-1.png') > details, 'the GIF and the diff crop inside');
  });
});
