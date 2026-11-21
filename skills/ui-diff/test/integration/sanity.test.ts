import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../../src/config.js';
import { runPipeline } from '../../src/pipeline.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const commit = (cwd: string, message: string) => {
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.name=ui-diff-test', '-c', 'user.email=test@example.com', 'commit', '-qm', message);
  return git(cwd, 'rev-parse', 'HEAD');
};
const SERVER = `import http from 'node:http'; import { readFile } from 'node:fs/promises'; import path from 'node:path';
const root = path.dirname(new URL(import.meta.url).pathname);
http.createServer(async (req, res) => {
  const file = path.join(root, new URL(req.url, 'http://x').pathname.replace(/\\/$/, '/index.html'));
  try { const body = await readFile(file); res.writeHead(200, { 'content-type': file.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(body); }
  catch { res.writeHead(404); res.end('missing'); }
}).listen(Number(process.argv[3] ?? process.env.PORT), '127.0.0.1');`;
// Things that make naive screenshots flaky: a clock, randomness, an endless animation, a caret.
const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sanity</title><link rel="stylesheet" href="styles.css"></head><body>
<h1>Sanity</h1><p>Now <span id="now"></span> · lucky <span id="r"></span></p><div class="spin"></div>
<a class="cta" href="/go">Get started</a> <a class="more" href="/more">Learn more</a><input value="caret" autofocus>
<script>document.getElementById('now').textContent = new Date().toISOString(); document.getElementById('r').textContent = Math.random();</script></body></html>`;
const css = (padding: string) => `body { margin: 24px; font: 16px/24px Arial, sans-serif; }
.spin { width: 40px; height: 40px; background: #2563eb; animation: spin 1s linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }
.cta { display: inline-block; padding: ${padding}; background: #2563eb; color: #fff; border-radius: 6px; }`;

describe('sanity: no flakes, and a 1px change is always named', { timeout: 600_000 }, () => {
  let dir: string;
  let repo: string;
  let base: string;
  let onePx: string;

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-sanity-'));
    repo = path.join(dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(repo, 'serve.mjs'), SERVER);
    writeFileSync(path.join(repo, 'index.html'), HTML);
    writeFileSync(path.join(repo, 'styles.css'), css('8px 14px'));
    writeFileSync(path.join(repo, 'ui-diff.config.json'), JSON.stringify({ startCommand: 'node serve.mjs --port {port}', routes: [{ path: '/', name: 'home' }], viewports: [{ name: 'desktop', width: 800, height: 400 }, { name: 'mobile', width: 390, height: 700, deviceScaleFactor: 2, isMobile: true }] }));
    base = commit(repo, 'base');
    writeFileSync(path.join(repo, 'styles.css'), css('9px 14px 8px'));
    onePx = commit(repo, '1px more top padding');
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('reports no change on identical commits five runs in a row, each capturing both sides afresh', async () => {
    for (let run = 1; run <= 5; run++) {
      const { report } = await runPipeline({ cfg: loadConfig(repo, repo), outDir: path.join(dir, `same-${run}`), base, head: base, allRoutes: true, cache: false });
      assert.equal(report.stats.errors, 0, `run ${run}`);
      for (const c of report.captures) {
        assert.equal(c.status, 'unchanged', `run ${run} ${c.id}: ${c.diff?.changedPixels} changed pixels`);
        assert.deepEqual(c.styleDiff?.changes, [], `run ${run} ${c.id}`);
      }
      assert.equal(report.notComparable, undefined, `run ${run}`);
    }
  });

  it('names a 1px padding change, verified, on every run', async () => {
    for (let run = 1; run <= 3; run++) {
      const { report } = await runPipeline({ cfg: loadConfig(repo, repo), outDir: path.join(dir, `px-${run}`), base, head: onePx, allRoutes: true, cache: run === 1 ? false : undefined });
      for (const c of report.captures) {
        assert.equal(c.status, 'changed', `run ${run} ${c.id}`);
        const named = c.styleDiff!.changes.filter((x) => x.verified);
        assert.equal(named.length, 1, `run ${run} ${c.id}: ${JSON.stringify(c.styleDiff!.changes.map((x) => [x.name, x.verified, x.unverified]))}`);
        assert.equal(named[0].name, "link 'Get started'");
        assert.ok(named[0].changes.some((p) => p.property === 'padding' && p.before === '8px 14px' && p.after === '9px 14px 8px'), JSON.stringify(named[0].changes));
      }
    }
  });
});
