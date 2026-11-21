import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const commit = (cwd: string, message: string) => {
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.name=ui-diff-test', '-c', 'user.email=test@example.com', 'commit', '-qm', message);
};

const SERVER = `import http from 'node:http'; import { readFile } from 'node:fs/promises'; import path from 'node:path';
const root = path.dirname(new URL(import.meta.url).pathname);
http.createServer(async (req, res) => {
  const file = path.join(root, new URL(req.url, 'http://x').pathname.replace(/\\/$/, '/index.html'));
  try { const body = await readFile(file); res.writeHead(200, { 'content-type': file.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(body); }
  catch { res.writeHead(404); res.end('missing'); }
}).listen(Number(process.argv[3] ?? process.env.PORT), '127.0.0.1');`;
const HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Check</title><link rel="stylesheet" href="styles.css"></head><body><h1>Check</h1><a class="cta" href="/go">Get started</a></body></html>';
const css = (padding: string) => `body { margin: 32px; font: 18px Arial, sans-serif; } .cta { display: inline-block; padding: ${padding}; background: #2563eb; color: #fff; }`;

describe('ui-diff check', { timeout: 300_000 }, () => {
  let dir: string;
  let repo: string;
  const check = (...args: string[]) => spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), path.join(skillRoot, 'src', 'cli.ts'), 'check', ...args], { cwd: repo, encoding: 'utf8' });

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-check-'));
    repo = path.join(dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(repo, 'serve.mjs'), SERVER);
    writeFileSync(path.join(repo, 'index.html'), HTML);
    writeFileSync(path.join(repo, 'styles.css'), css('8px 14px'));
    writeFileSync(path.join(repo, 'ui-diff.config.json'), JSON.stringify({ startCommand: 'node serve.mjs --port {port}', routes: [{ path: '/', name: 'home', files: ['index.html', 'styles.css'] }], viewports: [{ name: 'desktop', width: 800, height: 400 }] }));
    commit(repo, 'main');
    git(repo, 'checkout', '-q', '-b', 'feature');
    writeFileSync(path.join(repo, 'index.html'), HTML.replace('<h1>Check</h1>', '<h1>Check</h1>\n'));
    commit(repo, 'feature work');
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('diffs uncommitted changes against the merge base, prints the measured change, writes .ui-diff/out and exits 1', () => {
    writeFileSync(path.join(repo, 'styles.css'), css('10px 18px'));
    const result = check('--open');
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /^ui-diff check: 1 measured change on 1 route \(exit 1\)\nbase main @ [0-9a-f]{7} → head working tree @ [0-9a-f]{7} \+ uncommitted changes/);
    assert.match(result.stdout, /\nMeasured changes on \/\n {2}- link 'Get started' \(a\.cta\): size .* · padding 8px 14px → 10px 18px\n/);
    assert.match(result.stdout, /Report: \.ui-diff\/out\/report\.json · images: \.ui-diff\/out\/compare\//);
    assert.ok(existsSync(path.join(repo, '.ui-diff', 'out', 'report.json')));
    assert.ok(existsSync(path.join(repo, '.ui-diff', 'out', 'compare', 'home__desktop__light.png')));
    assert.match(result.stderr, /no HTML report in \.ui-diff\/out, so nothing to open/);
    assert.equal(git(repo, 'branch', '--list', 'ui-diff-assets'), '', 'nothing pushed or published');
    assert.equal(git(repo, 'status', '--porcelain'), 'M styles.css', 'outputs and cache stay out of git status');
  });

  it('exits 0 when the working tree looks the same as the merge base, reusing the cached base', () => {
    writeFileSync(path.join(repo, 'styles.css'), css('8px 14px'));
    const result = check('--json');
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout) as { verdict: string; exitCode: number; timing: string };
    assert.deepEqual([json.verdict, json.exitCode], ['no visual changes', 0]);
    assert.match(json.timing, /base: cached/);
  });

  it('exits 2 on errors', () => {
    assert.equal(check('--head', 'HEAD').status, 2);
    writeFileSync(path.join(repo, 'ui-diff.config.json'), JSON.stringify({ startCommand: 'node missing-server.mjs --port {port}', startTimeoutMs: 3000, routes: ['/'] }));
    try {
      const broken = check('--no-cache', '--all-routes');
      assert.equal(broken.status, 2, broken.stderr);
      assert.match(broken.stderr, /server did not start/);
    } finally {
      git(repo, 'checkout', '-q', '--', 'ui-diff.config.json');
    }
  });
});
