import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderComment } from '../../src/markdown.js';
import { autoSummary, computeStats, notCheckedReason, type Report } from '../../src/report.js';
import { sampleReport } from './fixtures.js';

const link = (p: string) => p;
const render = (r: Report, summary?: string) => renderComment(r, { id: 'default', title: 'UI diff', link, summary });

function detect(overrides: Partial<NonNullable<Report['detect']>> = {}): NonNullable<Report['detect']> {
  return { uiFiles: [], unmatched: [], skippedRoutes: [], needsExample: [], notes: [], ...overrides };
}

function nothingCaptured(d: NonNullable<Report['detect']>): Report {
  return sampleReport({ routes: [], captures: [], variants: [], motion: [], a11y: undefined, tokens: undefined, stats: computeStats([]), detect: d });
}

describe('warnings in the comment', () => {
  it('shows warnings of a capture that is not the first one, even when it is unchanged', () => {
    const r = sampleReport();
    r.captures[1] = { ...r.captures[1], warnings: ['head: uncaught page error: boom on mobile'] };
    const body = render(r, 'Custom summary.');
    assert.match(body, /#### Warnings/);
    assert.match(body, /`\/ · mobile`: head: uncaught page error: boom on mobile/);
  });

  it('shows report-level warnings such as dev-server problems', () => {
    const r = sampleReport({ warnings: ['head: Next.js blocked its dev resources for "127.0.0.1", so client components may not have hydrated'] });
    assert.match(render(r, 'Custom summary.'), /Next\.js blocked its dev resources/);
  });

  it('groups warnings by capture and collapses a long list', () => {
    const r = sampleReport();
    r.captures[1] = { ...r.captures[1], warnings: Array.from({ length: 7 }, (_, i) => `base: warning number ${i + 1}`) };
    const body = render(r);
    assert.match(body, /<details><summary>Warnings \(7\)<\/summary>/);
    assert.match(body, /warning number 7/);
    assert.equal(body.match(/`\/ · mobile`/g)?.length, 2, 'the capture is named once in the warnings (plus once in the unchanged list)');
  });

  it('does not repeat warnings already shown next to a changed capture', () => {
    const r = sampleReport();
    r.captures[0] = { ...r.captures[0], warnings: ['head: inline only'] };
    const body = render(r);
    assert.equal(body.match(/inline only/g)?.length, 1);
    assert.doesNotMatch(body, /#### Warnings/);
  });
});

describe('changed files that match no route', () => {
  it('are listed in the comment', () => {
    const r = sampleReport({ detect: detect({ uiFiles: ['src/a.tsx', 'src/widgets/Chart.tsx'], unmatched: ['src/widgets/Chart.tsx'] }) });
    const body = render(r, 'Custom summary.');
    assert.match(body, /Changed UI files that match no route \(not captured\): `src\/widgets\/Chart\.tsx`/);
  });
});

describe('nothing captured', () => {
  it('says that nothing was checked when no UI file changed', () => {
    const r = nothingCaptured(detect());
    assert.match(notCheckedReason(r) ?? '', /no changed file is a UI file/);
    const body = render(r);
    assert.match(body, /### UI diff — Nothing was checked\n/);
    assert.match(body, /\*\*Nothing was checked\.\*\*/);
    assert.match(body, /not a visual all-clear/);
    assert.doesNotMatch(body, /0 unchanged|No routes were captured/);
  });

  it('names the UI files that changed but could not be mapped', () => {
    const r = nothingCaptured(detect({ uiFiles: ['src/widgets/Chart.tsx', 'src/pages/blog/[slug].tsx'], unmatched: ['src/widgets/Chart.tsx'], needsExample: [{ file: 'src/pages/blog/[slug].tsx', route: '/blog/[slug]' }] }));
    const reason = notCheckedReason(r) ?? '';
    assert.match(reason, /2 UI files changed but none could be mapped to a route/);
    assert.match(reason, /\/blog\/\[slug\]/);
    const summary = autoSummary(r);
    assert.match(summary, /Nothing was checked/);
    assert.match(render(r), /`src\/widgets\/Chart\.tsx`/);
  });

  it('keeps the explicit state under a custom summary too', () => {
    assert.match(render(nothingCaptured(detect()), 'Looks fine.'), /\*\*Nothing was checked\.\*\*/);
  });

  it('is not used when captures exist', () => {
    assert.equal(notCheckedReason(sampleReport()), undefined);
  });
});
