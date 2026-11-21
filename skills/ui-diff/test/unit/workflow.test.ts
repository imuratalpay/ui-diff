import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../../src/config.js';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const workflow = readFileSync(new URL('../../../../examples/workflows/ui-diff.yml', import.meta.url), 'utf8');

/** Pulls the shell script of the "Detect the package manager" step out of the workflow. */
function detectScript(): string {
  const lines = workflow.split('\n');
  const start = lines.findIndex((l) => l.includes('name: Detect the package manager'));
  const run = lines.findIndex((l, i) => i > start && /^\s+run: \|$/.test(l));
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (!line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
}

function detect(lockfile?: string): Record<string, string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'ui-diff-wf-'));
  try {
    if (lockfile) writeFileSync(path.join(dir, lockfile), '');
    const out = path.join(dir, 'out');
    writeFileSync(out, '');
    execFileSync('bash', ['-e', '-c', detectScript()], { cwd: dir, env: { ...process.env, GITHUB_OUTPUT: out } });
    return Object.fromEntries(
      readFileSync(out, 'utf8')
        .trim()
        .split('\n')
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The YAML block of a top-level job (its lines up to the next job). */
function job(name: string): string {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  assert.ok(start >= 0, `job ${name} not found`);
  const end = lines.findIndex((l, i) => i > start && /^ {2}[\w-]+:$/.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

/** The `run: |` script of the step with this name, with `${{ ... }}` expressions replaced. */
function stepScript(name: string, values: Record<string, string>): string {
  const lines = workflow.split('\n');
  const start = lines.findIndex((l) => l.includes(`name: ${name}`));
  const run = lines.findIndex((l, i) => i > start && /^\s+run: \|$/.test(l));
  const indent = lines[run].indexOf('run:') + 2;
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() && !line.startsWith(' '.repeat(indent))) break;
    body.push(line.slice(indent));
  }
  return body.join('\n').replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expr: string) => {
    if (!(expr in values)) throw new Error(`no value for ${expr}`);
    return values[expr];
  });
}

describe('example CI workflow: preflight', () => {
  it('runs detect first without installing the app or a browser, and gates the capture job on it', () => {
    const preflight = job('preflight');
    assert.match(preflight, /ui-diff\.mjs" detect/);
    assert.doesNotMatch(preflight, /playwright install/);
    assert.doesNotMatch(preflight, /steps\.pm\.outputs\.install|npm ci\n|pnpm install|yarn install|bun install/);
    assert.match(preflight, /status: \$\{\{ steps\.detect\.outputs\.status \}\}/);
    const capture = job('ui-diff');
    assert.match(capture, /needs: preflight/);
    assert.match(capture, /if: needs\.preflight\.outputs\.status == 'capture'/);
    assert.match(preflight, /- name: Report without capturing\n\s+if: steps\.detect\.outputs\.status != 'capture'/);
  });

  it('documents a paths filter that matches detect.include', () => {
    const paths = workflow
      .split('\n')
      .filter((l) => /^\s+#\s+- '/.test(l))
      .map((l) => /'([^']+)'/.exec(l)![1]);
    const include = parseConfig({}, { repoRoot: '/repo' }).detect.include;
    assert.deepEqual(paths.slice(0, include.length), include);
    assert.deepEqual(paths.slice(include.length), ['**/{pnpm-lock.yaml,yarn.lock,bun.lock,bun.lockb}']);
  });

  it('writes the status that detect prints, for a UI change and for a change without one', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ui-diff-preflight-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
      git('init', '-q', '-b', 'main');
      writeFileSync(path.join(dir, 'index.html'), '<h1>Hi</h1>');
      writeFileSync(path.join(dir, 'ui-diff.config.json'), JSON.stringify({ routes: [{ path: '/', files: ['index.html'] }] }));
      git('add', '-A');
      git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'base');
      git('branch', 'base');
      const statusAfter = (file: string, content: string) => {
        writeFileSync(path.join(dir, file), content);
        git('add', '-A');
        git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', file);
        const out = path.join(dir, '.out');
        writeFileSync(out, '');
        const script = stepScript('Detect changed UI', { 'github.base_ref': 'base', 'github.event.pull_request.head.sha': git('rev-parse', 'HEAD') }).replace('"origin/base"', '"base"');
        execFileSync('bash', ['-e', '-c', script], { cwd: dir, env: { ...process.env, SKILL: skillRoot, RUNNER_TEMP: dir, GITHUB_OUTPUT: out } });
        return readFileSync(out, 'utf8').trim();
      };
      assert.equal(statusAfter('server.py', 'print(1)'), 'status=no-ui-changes');
      assert.equal(statusAfter('index.html', '<h1>Hello</h1>'), 'status=capture');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('example CI workflow', () => {
  it('installs app dependencies with the package manager of the lockfile', () => {
    assert.deepEqual(detect('pnpm-lock.yaml'), { name: 'pnpm', install: 'pnpm install --frozen-lockfile' });
    assert.deepEqual(detect('yarn.lock'), { name: 'yarn', install: 'yarn install --immutable' });
    assert.deepEqual(detect('bun.lockb'), { name: 'bun', install: 'bun install --frozen-lockfile' });
    assert.deepEqual(detect('package-lock.json'), { name: 'npm', install: 'npm ci' });
    assert.deepEqual(detect(), { name: 'npm', install: 'npm ci' });
  });

  it('does not assume npm for the app', () => {
    assert.doesNotMatch(workflow, /cache: npm/);
    assert.doesNotMatch(workflow, /run: npm ci\n/);
    assert.match(workflow, /run: \$\{\{ steps\.pm\.outputs\.install \}\}/);
    assert.match(workflow, /corepack enable/);
  });
});
