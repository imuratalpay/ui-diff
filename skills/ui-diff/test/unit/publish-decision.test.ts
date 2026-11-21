import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { publishDecision, type Comment } from '../../src/github.js';
import { stickyMarker } from '../../src/markdown.js';
import { computeStats, type Report } from '../../src/report.js';
import { sampleReport } from './fixtures.js';

function noUiReport(): Report {
  return sampleReport({
    routes: [],
    captures: [],
    variants: [],
    motion: [],
    a11y: undefined,
    tokens: undefined,
    stats: computeStats([]),
    detect: { uiFiles: [], unmatched: [], skippedRoutes: [], needsExample: [], notes: [] },
  });
}

const OPTS = { id: 'default', title: 'UI diff' };
const existing: Comment = { id: 7, login: 'github-actions[bot]', body: `${stickyMarker('default')}\n### UI diff — 2 changed, 0 unchanged\n…` };

describe('publish decision', () => {
  it('posts the full comment when the run captured something', () => {
    assert.deepEqual(publishDecision(sampleReport(), undefined, OPTS), { action: 'comment' });
    assert.deepEqual(publishDecision(sampleReport(), existing, OPTS), { action: 'comment' });
  });

  it('posts nothing on a PR without UI changes and no ui-diff comment yet', () => {
    const decision = publishDecision(noUiReport(), undefined, OPTS);
    assert.equal(decision.action, 'skip');
  });

  it('turns an existing comment into a one-line "no UI files changed" note', () => {
    const decision = publishDecision(noUiReport(), existing, OPTS);
    assert.equal(decision.action, 'note');
    assert.ok(decision.action === 'note');
    assert.ok(decision.body.startsWith(stickyMarker('default')), 'keeps the sticky marker so later runs find it');
    const visible = decision.body.split('\n').filter((l) => l.trim() && !l.startsWith('<!--'));
    assert.deepEqual(visible, ['### UI diff — no UI files changed in `5d6e7f8`']);
    assert.doesNotMatch(decision.body, /0 unchanged/);
  });

  it('still comments when UI files changed but none mapped to a route', () => {
    const r = noUiReport();
    r.detect = { ...r.detect!, uiFiles: ['src/widgets/Chart.tsx'], unmatched: ['src/widgets/Chart.tsx'] };
    assert.deepEqual(publishDecision(r, undefined, OPTS), { action: 'comment' });
  });
});
