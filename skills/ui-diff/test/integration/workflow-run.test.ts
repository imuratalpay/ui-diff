import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = readFileSync(new URL('../../../../examples/workflows/ui-diff.yml', import.meta.url), 'utf8');

/** The shell command of a step (single-line, `|` or `>` run), with `${{ ... }}` expressions filled in. */
function step(name: string, values: Record<string, string>): string {
  const lines = workflow.split('\n');
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(start >= 0, `step ${name} not found`);
  const at = lines.findIndex((l, i) => i > start && /^\s+run:/.test(l));
  const head = lines[at].trim().slice('run:'.length).trim();
  let script = head;
  if (head === '|' || head === '>') {
    const indent = lines[at].indexOf('run:') + 2;
    const body: string[] = [];
    for (const line of lines.slice(at + 1)) {
      if (line.trim() && !line.startsWith(' '.repeat(indent))) break;
      if (line.trim().startsWith('#')) break;
      body.push(line.slice(indent));
    }
    script = head === '>' ? body.join(' ').trim() : body.join('\n');
  }
  return script.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expr: string) => {
    if (!(expr in values)) throw new Error(`no value for ${expr}`);
    return values[expr];
  });
}

const PAGE = (padding: string) => `<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body><main><h1>Plans</h1><a class="cta" href="#">Start</a></main></body></html>`.replace('</head>', `<style>.cta{padding:${padding}}</style></head>`);

describe('example CI workflow, run step by step on an app repository', { timeout: 900_000 }, () => {
  let dir: string;
  const env = () => ({ ...process.env, SKILL: '.claude/skills/ui-diff', RUNNER_TEMP: path.join(dir, '.runner'), GITHUB_OUTPUT: path.join(dir, '.runner', 'output'), UI_DIFF_BROWSER_CHANNEL: '' });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const sh = (script: string) => execFileSync('bash', ['-e', '-c', script], { cwd: dir, env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000 });

  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ui-diff-workflow-'));
    mkdirSync(path.join(dir, '.runner'));
    writeFileSync(path.join(dir, '.runner', 'output'), '');
    git('init', '-q', '-b', 'main');
    const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: skillRoot, encoding: 'utf8' }).split('\0').filter(Boolean);
    for (const file of files) {
      const dest = path.join(dir, '.claude/skills/ui-diff', file);
      mkdirSync(path.dirname(dest), { recursive: true });
      cpSync(path.join(skillRoot, file), dest);
    }
    writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\ndist/\n.ui-diff/\n.runner/\n');
    writeFileSync(path.join(dir, 'serve.mjs'), "import http from 'node:http';\nimport { readFileSync } from 'node:fs';\nconst port = Number(process.argv[process.argv.indexOf('--port') + 1]);\nhttp.createServer((req, res) => { const css = req.url === '/app.css'; res.writeHead(200, { 'content-type': css ? 'text/css' : 'text/html' }); res.end(readFileSync(css ? 'app.css' : 'index.html')); }).listen(port, '127.0.0.1');\n");
    writeFileSync(path.join(dir, 'app.css'), 'body{margin:24px;font:16px Arial,sans-serif} .cta{display:inline-block;background:#2563eb;color:#fff}');
    writeFileSync(path.join(dir, 'index.html'), PAGE('8px 14px'));
    writeFileSync(path.join(dir, 'ui-diff.config.json'), JSON.stringify({ startCommand: 'node serve.mjs --port {port}', routes: [{ path: '/', name: 'home', files: ['index.html', 'app.css'] }], viewports: [{ name: 'desktop', width: 800, height: 600 }], a11y: { enabled: false }, tokens: { enabled: false } }));
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'base');
    git('checkout', '-q', '-b', 'feature');
    writeFileSync(path.join(dir, 'index.html'), PAGE('10px 18px'));
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qam', 'bigger button');
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('installs ui-diff, computes the base cache key, captures, and renders the comment', () => {
    const values = { 'github.base_ref': 'main', 'github.event.pull_request.head.sha': git('rev-parse', 'HEAD'), 'github.event.pull_request.number': '7', 'steps.base-cache.outputs.key': 'unused' };
    const local = (script: string) => script.replaceAll('"origin/main"', '"main"');
    sh(step('Install ui-diff', values));
    assert.ok(existsSync(path.join(dir, '.claude/skills/ui-diff/node_modules/playwright')));

    sh(local(step('Base cache key', values)));
    assert.match(readFileSync(path.join(dir, '.runner', 'output'), 'utf8'), /^key=ui-diff-base-[0-9a-f]{12}-[0-9a-f]{16}$/m);

    sh(local(step('Capture and diff', values)));
    const report = JSON.parse(readFileSync(path.join(dir, '.ui-diff', 'report.json'), 'utf8')) as { stats: { changed: number } };
    assert.equal(report.stats.changed, 1);

    // No GitHub here: the publish step as written, plus --dry-run.
    const out = sh(`${step('Publish the sticky comment', values)} --dry-run --quiet`);
    assert.equal((JSON.parse(out) as { dryRun: boolean }).dryRun, true);
    const comment = readFileSync(path.join(dir, '.ui-diff', 'comment.md'), 'utf8');
    assert.match(comment.split('\n')[1], /^### UI diff — 1 measured change on 1 route$/);
    assert.match(comment, /padding 8px 14px → 10px 18px/);
  });
});
