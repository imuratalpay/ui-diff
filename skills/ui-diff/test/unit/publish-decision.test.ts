import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { publishDecision, type Comment } from '../../src/github.js';
import { renderComment, stickyMarker } from '../../src/markdown.js';
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

  it('replaces only the top line of an existing comment and keeps the last result collapsed below', () => {
    const last = renderComment(sampleReport(), { id: 'default', title: 'UI diff', link: (p) => p });
    const decision = publishDecision(noUiReport(), { ...existing, body: last }, OPTS);
    assert.ok(decision.action === 'note');
    const lines = decision.body.split('\n');
    assert.equal(lines[0], stickyMarker('default'), 'keeps the sticky marker so later runs find it');
    assert.equal(lines[1], '### UI diff — no UI files changed in `5d6e7f8`');
    assert.match(decision.body, /<details><summary>Last result with UI changes \(head `5d6e7f8`\)<\/summary>/);
    assert.match(decision.body, /### UI diff — Visual changes on 1 route/, 'the previous result is kept');
    assert.match(decision.body, /home__desktop__light__focus-1\.png/, 'with its images');
    assert.equal(decision.body.match(/<!-- ui-diff:sticky /g)?.length, 1);
    assert.equal(decision.body.match(/<!-- ui-diff:meta /g)?.length, 1, 'only the meta of this run');
    assert.doesNotMatch(decision.body, /0 unchanged/);
  });

  it('keeps the same last result when another push has no UI changes either', () => {
    const last = renderComment(sampleReport(), { id: 'default', title: 'UI diff', link: (p) => p });
    const first = publishDecision(noUiReport(), { ...existing, body: last }, OPTS);
    assert.ok(first.action === 'note');
    const later = noUiReport();
    later.head = { ...later.head, sha: '9f9f9f9f', shortSha: '9f9f9f9' };
    const second = publishDecision(later, { ...existing, body: first.body }, OPTS);
    assert.ok(second.action === 'note');
    assert.equal(second.body.split('\n')[1], '### UI diff — no UI files changed in `9f9f9f9`');
    assert.equal(second.body.match(/<details><summary>Last result/g)?.length, 1, 'not nested');
    assert.match(second.body, /Last result with UI changes \(head `5d6e7f8`\)/);
    assert.match(second.body, /### UI diff — Visual changes on 1 route/);
  });

  it('stays a single line when the existing comment was a note without a kept result', () => {
    const oldNote = `${stickyMarker('default')}\n### UI diff — no UI files changed in \`1111111\`\n<!-- ui-diff:meta {"head":"1111111a"} -->\n`;
    const decision = publishDecision(noUiReport(), { ...existing, body: oldNote }, OPTS);
    assert.ok(decision.action === 'note');
    const visible = decision.body.split('\n').filter((l) => l.trim() && !l.startsWith('<!--'));
    assert.deepEqual(visible, ['### UI diff — no UI files changed in `5d6e7f8`']);
  });

  it('still comments when UI files changed but none mapped to a route', () => {
    const r = noUiReport();
    r.detect = { ...r.detect!, uiFiles: ['src/widgets/Chart.tsx'], unmatched: ['src/widgets/Chart.tsx'] };
    assert.deepEqual(publishDecision(r, undefined, OPTS), { action: 'comment' });
  });
});
