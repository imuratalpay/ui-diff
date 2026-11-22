import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { parseConfig } from '../../src/config.js';
import { runPipeline } from '../../src/pipeline.js';
import type { Report } from '../../src/report.js';

const SERVER = `import http from 'node:http'; import { readFileSync } from 'node:fs';
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
http.createServer((req, res) => { const css = req.url === '/app.css'; res.writeHead(200, { 'content-type': css ? 'text/css' : 'text/html' }); res.end(readFileSync(css ? 'app.css' : 'index.html')); }).listen(port, '127.0.0.1');
`;
const HTML = `<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body>
<header><a class="logo" href="#">Acme</a></header>
<main><h1>Settings</h1><p class="lead">Manage your account.</p>
<form><label for="email">Email</label> <input id="email" value="ada@example.com">
<div class="actions"><button class="save" type="button">Save</button> <a class="cancel" href="#">Cancel</a></div></form>
<div class="far"><button type="button">Far away</button></div></main></body></html>`;

const BASE_CSS = {
  page: 'body{margin:0;font:16px Arial,sans-serif;color:#0f172a} header{padding:16px 24px;border-bottom:1px solid #e5e7eb} main{padding:24px} .lead{color:#475569} .far{margin-top:1200px}',
  input: 'input{border:1px solid #cbd5e1;padding:6px 8px;border-radius:4px} input:focus-visible{outline:2px solid #2563eb}',
  save: '.save{background:#2563eb;color:#fff;border:0;padding:8px 14px;border-radius:6px} .save:hover{background:#1d4ed8} .save:focus-visible{outline:2px solid #2563eb;outline-offset:2px}',
  links: 'a{color:#2563eb} a:hover{text-decoration:underline} .actions{margin-top:16px}',
};
const css = (over: Partial<typeof BASE_CSS> = {}) => Object.values({ ...BASE_CSS, ...over }).join('\n');

describe('hover and focus states in a real run', { timeout: 600_000 }, () => {
  let dir: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const branch = (name: string, over: Partial<typeof BASE_CSS>) => {
    git('checkout', '-q', '-B', name, 'main');
    writeFileSync(path.join(dir, 'app.css'), css(over));
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qam', name);
  };

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-states-'));
    git('init', '-q', '-b', 'main');
    writeFileSync(path.join(dir, 'serve.mjs'), SERVER);
    writeFileSync(path.join(dir, 'index.html'), HTML);
    writeFileSync(path.join(dir, 'app.css'), css());
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'base');
    branch('hover-color', { save: BASE_CSS.save.replace('.save:hover{background:#1d4ed8}', '.save:hover{background:#1e3a8a}') });
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  const run = async (head: string, states: Record<string, unknown> = {}) => {
    const cfg = parseConfig({ startCommand: 'node serve.mjs --port {port}', routes: [{ path: '/', name: 'settings', files: ['index.html', 'app.css'] }], viewports: [{ name: 'desktop', width: 800, height: 600 }], states }, { repoRoot: dir });
    const outDir = path.join(dir, '.ui-diff', `${head}-${JSON.stringify(states).replace(/\W/g, '')}`);
    await runPipeline({ cfg, outDir, base: 'main', head, cache: false });
    return { outDir, report: JSON.parse(readFileSync(path.join(outDir, 'report.json'), 'utf8')) as Report, comment: readFileSync(path.join(outDir, 'comment.local.md'), 'utf8') };
  };

  it('checks the interactive elements in the first viewport in hover and focus, and counts what it skipped', async () => {
    const { outDir, report } = await run('hover-color');
    const fp = report.captures[0].fingerprint!;
    for (const side of [fp.base!, fp.head!]) {
      assert.equal(side.states?.checked, 4, `logo, email field, Save and Cancel: ${JSON.stringify(side.states)}`);
      assert.equal(side.states?.skippedWhy['outside the viewport'], 1, 'the far button');
    }
    const crops = readdirSync(path.join(outDir, 'states', 'head')).sort();
    assert.ok(crops.includes('settings__desktop__light__3-hover.png') && crops.includes('settings__desktop__light__3-focus.png'), crops.join(', '));
    assert.deepEqual(fp.differences, [], 'state counts are not compared between the sides');
  });

  it('checks nothing when states are off', async () => {
    const { outDir, report } = await run('hover-color', { enabled: false });
    assert.equal(report.captures[0].fingerprint!.head!.states, undefined);
    assert.ok(!existsSync(path.join(outDir, 'states')));
  });
});
