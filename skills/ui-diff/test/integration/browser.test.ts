import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { chromium } from 'playwright';
import { loadConfig } from '../../src/config.js';
import { runPipeline } from '../../src/pipeline.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const CHROME = ['/usr/bin/google-chrome', '/opt/google/chrome/chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => existsSync(p));

describe('browser choice in a run', { timeout: 180_000 }, () => {
  let dir: string;
  let repo: string;
  let sha: string;

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-browser-'));
    repo = path.join(dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(repo, 'index.html'), '<!doctype html><html lang="en"><head><title>b</title></head><body><h1>Browser</h1></body></html>');
    writeFileSync(
      path.join(repo, 'ui-diff.config.json'),
      JSON.stringify({ startCommand: 'python3 -m http.server {port} --bind 127.0.0.1', baseUrl: 'http://127.0.0.1:{port}', routes: [{ path: '/', name: 'home' }], viewports: [{ name: 'desktop', width: 800, height: 600 }] }),
    );
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'page');
    sha = git(repo, 'rev-parse', 'HEAD');
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('captures base and head in the installed Chrome when browser.channel is "chrome", and records it', { skip: !CHROME && 'Google Chrome is not installed' }, async () => {
    const cfg = loadConfig(repo, repo);
    const saved = process.env.UI_DIFF_BROWSER_CHANNEL;
    delete process.env.UI_DIFF_BROWSER_CHANNEL;
    try {
      const { report } = await runPipeline({ cfg: { ...cfg, browser: { channel: 'chrome' } }, outDir: path.join(dir, 'chrome'), base: sha, head: sha, allRoutes: true });
      const { base, head } = report.captures[0].fingerprint!;
      assert.equal(base!.browser.name, 'chrome');
      assert.deepEqual(base!.browser, head!.browser, 'base and head share the browser');
      const installed = execFileSync(CHROME!, ['--version'], { encoding: 'utf8' }).match(/\d+\.\d+\.\d+\.\d+/)![0];
      assert.equal(base!.browser.version, installed);
      assert.equal(report.captures[0].status, 'unchanged');
    } finally {
      if (saved !== undefined) process.env.UI_DIFF_BROWSER_CHANNEL = saved;
    }
  });

  it('records a custom executable without its path', async () => {
    const saved = process.env.UI_DIFF_CHROMIUM_PATH;
    process.env.UI_DIFF_CHROMIUM_PATH = chromium.executablePath();
    try {
      const { report } = await runPipeline({ cfg: loadConfig(repo, repo), outDir: path.join(dir, 'custom'), base: sha, head: sha, allRoutes: true });
      const fp = report.captures[0].fingerprint!;
      assert.equal(fp.base!.browser.name, 'custom executable');
      assert.ok(!JSON.stringify(fp).includes(chromium.executablePath()));
    } finally {
      if (saved === undefined) delete process.env.UI_DIFF_CHROMIUM_PATH;
      else process.env.UI_DIFF_CHROMIUM_PATH = saved;
    }
  });
});
