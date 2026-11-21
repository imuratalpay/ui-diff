import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { duration, renderComment, timingLine, timingSection } from '../../src/markdown.js';
import type { Timings } from '../../src/report.js';
import { sampleReport } from './fixtures.js';

const TIMINGS: Timings = {
  totalMs: 72400,
  detectMs: 310,
  prepare: {
    wallMs: 53200,
    base: { mode: 'worktree', checkoutMs: 480, install: { kind: 'installed', ms: 40900 }, bootMs: 11800, totalMs: 53200 },
    head: { mode: 'worktree', checkoutMs: 420, install: { kind: 'linked', ms: 60 }, bootMs: 10900, totalMs: 11400 },
  },
  browserMs: 420,
  capture: { ms: 38200, count: 24, slowest: { id: 'home__desktop__dark', side: 'head', ms: 2140 } },
  diffMs: 3240,
  extras: { motionMs: 6020, a11yMs: 3110, tokensMs: 870 },
};

describe('timing breakdown', () => {
  it('formats measured durations', () => {
    assert.equal(duration(0), '0.0s');
    assert.equal(duration(310), '0.3s');
    assert.equal(duration(3240), '3.2s');
    assert.equal(duration(40900), '41s');
    assert.equal(duration(72400), '1m 12s');
  });

  it('fits the run into one line, base and head side by side because they prepare in parallel', () => {
    assert.equal(
      timingLine(TIMINGS),
      '⏱ 1m 12s total · detect 0.3s · prepare 53s (base: installed 41s, boot 12s ‖ head: linked 0.1s, boot 11s) · browser 0.4s · capture 38s (24 screenshots, slowest 2.1s) · diff 3.2s · motion 6.0s · a11y 3.1s · tokens 0.9s',
    );
  });

  it('puts the details in a collapsed table under that line', () => {
    const section = timingSection(TIMINGS).join('\n');
    assert.match(section, /^<details><summary>⏱ 1m 12s total · detect 0\.3s/);
    assert.match(section, /\| base \| 53s \| checkout 0\.5s · install 41s \(installed\) · boot 12s \|/);
    assert.match(section, /\| head \| 11s \| checkout 0\.4s · install 0\.1s \(linked\) · boot 11s \|/);
    assert.match(section, /\| prepare \| 53s \| base and head at the same time \(wall clock\) \|/);
    assert.match(section, /\| capture \| 38s \| 24 screenshots · slowest `home__desktop__dark` \(head\) 2\.1s \|/);
    assert.match(section, /\| a11y \| 3\.1s \| axe and focus order \(during capture\) and the delta \|/);
    assert.match(section, /\| total \| 1m 12s \| wall clock until the report was written \|/);
  });

  it('shows deployed previews and runs that captured nothing', () => {
    const preview: Timings = { ...TIMINGS, prepare: { wallMs: 0, base: { mode: 'url', totalMs: 0 }, head: { mode: 'url', totalMs: 0 } } };
    assert.match(timingLine(preview), /prepare 0\.0s \(base: deployed preview ‖ head: deployed preview\)/);
    assert.equal(timingLine({ totalMs: 420, detectMs: 300 }), '⏱ 0.4s total · detect 0.3s');
  });

  it('sits at the end of the comment, and is absent for reports without timings', () => {
    const body = renderComment(sampleReport({ timings: TIMINGS }), { id: 'default', title: 'UI diff', link: (p) => p });
    assert.ok(body.indexOf('<summary>Timing · ⏱ 1m 12s</summary>') > body.indexOf('#### Design tokens'));
    assert.ok(body.indexOf('<summary>Timing · ⏱ 1m 12s</summary>') < body.indexOf('<sub>ui-diff 0.1.0'));
    assert.match(body, /\*\*Timing\*\*\n\n⏱ 1m 12s total · detect/);
    assert.doesNotMatch(renderComment(sampleReport(), { id: 'default', title: 'UI diff', link: (p) => p }), /⏱/);
  });
});
