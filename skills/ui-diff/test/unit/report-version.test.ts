import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { computeStats, parseReport, REPORT_VERSION } from '../../src/report.js';
import { sampleReport } from './fixtures.js';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** A report as ui-diff 0.1 wrote it: version 1, without the fields version 2 added. */
function v1Report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const r = JSON.parse(JSON.stringify(sampleReport())) as Record<string, unknown> & { captures: Array<{ diff?: Record<string, unknown> }> };
  r.version = 1;
  delete r.notChecked;
  for (const c of r.captures) delete c.diff?.focusBoxes;
  return { ...r, ...overrides };
}

describe('report versions', () => {
  it('writes version 3', () => {
    assert.equal(REPORT_VERSION, 3);
    assert.equal(parseReport(JSON.parse(JSON.stringify(sampleReport())), 'report.json').version, 3);
  });

  it('reads a version 2 report as it is', () => {
    const v2 = { ...JSON.parse(JSON.stringify(sampleReport())), version: 2 };
    const r = parseReport(v2, 'report.json');
    assert.equal(r.version, 3);
    assert.deepEqual({ ...r, version: 2 }, v2);
  });

  it('reads a version 1 report and fills in what version 2 derives', () => {
    const r = parseReport(v1Report(), 'report.json');
    assert.equal(r.version, 3);
    assert.equal(r.captures.length, 2);
    assert.equal(r.notChecked, undefined);
    const empty = parseReport(v1Report({ routes: [], captures: [], stats: computeStats([]), detect: { uiFiles: [], unmatched: [], skippedRoutes: [], needsExample: [], notes: [] } }), 'report.json');
    assert.match(empty.notChecked ?? '', /no changed file is a UI file/);
  });

  it('refuses reports it cannot read, saying why', () => {
    assert.throws(() => parseReport({ ...v1Report(), version: 4 }, '.ui-diff/report.json'), /\.ui-diff\/report\.json has report version 4/);
    assert.throws(() => parseReport({ captures: [] }, 'report.json'), /report version undefined/);
    assert.throws(() => parseReport(null, 'report.json'), /not a ui-diff report/);
  });
});

describe('render and publish --dry-run with old and new reports', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-report-version-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  function repoWith(name: string, report: unknown): string {
    const repo = path.join(dir, name);
    mkdirSync(path.join(repo, '.ui-diff'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    writeFileSync(path.join(repo, '.ui-diff', 'report.json'), JSON.stringify(report));
    return repo;
  }

  function cli(repo: string, ...args: string[]) {
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), path.join(skillRoot, 'src', 'cli.ts'), ...args], { cwd: repo, encoding: 'utf8' });
    return { ...result, json: result.status === 0 ? (JSON.parse(result.stdout) as Record<string, unknown>) : undefined };
  }

  for (const [label, report] of [
    ['version 1 (CI artifact from ui-diff 0.1)', v1Report()],
    ['version 2 (feat/v2 before the style diff)', { ...JSON.parse(JSON.stringify(sampleReport())), version: 2 }],
    ['version 3', JSON.parse(JSON.stringify(sampleReport()))],
  ] as const) {
    it(`renders and dry-runs a ${label} report`, () => {
      const repo = repoWith(label.split(' ').slice(0, 2).join('-'), report);
      const rendered = cli(repo, 'render', '--quiet');
      assert.equal(rendered.status, 0, rendered.stderr);
      const body = readFileSync(path.join(repo, '.ui-diff', 'comment.preview.md'), 'utf8');
      assert.match(body, /### UI diff — 1 changed, 1 unchanged/);
      const dry = cli(repo, 'publish', '--pr', '3', '--dry-run', '--quiet');
      assert.equal(dry.status, 0, dry.stderr);
      assert.match(readFileSync(path.join(repo, '.ui-diff', 'comment.md'), 'utf8'), /home__desktop__light__focus-1\.png/);
    });
  }

  it('fails clearly on a report from a newer ui-diff', () => {
    const repo = repoWith('newer', { ...v1Report(), version: 4 });
    const rendered = cli(repo, 'render');
    assert.equal(rendered.status, 1);
    assert.match(rendered.stderr, /report version 4/);
  });
});
