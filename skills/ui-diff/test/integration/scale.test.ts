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
  try { const body = await readFile(file); res.writeHead(200, { 'content-type': 'text/html' }); res.end(body); }
  catch { res.writeHead(404); res.end('missing'); }
}).listen(Number(process.argv[3] ?? process.env.PORT), '127.0.0.1');`;

const BANNER_HEIGHT = 20;
const page = (banner: boolean) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Scale</title>
<style>body{margin:0;font:16px/24px Arial,sans-serif;color:#111827;background:#fff} .banner{height:${BANNER_HEIGHT}px;background:#f97316}
section{padding:24px;border-top:1px solid #e5e7eb} h2{margin:0 0 8px}</style></head>
<body>${banner ? '<div class="banner"></div>' : ''}${['Features', 'Pricing', 'Questions', 'Contact', 'Footer']
  .map((t, i) => `<section><h2>${t}</h2><p>${t} line one, item ${i * 7 + 3}.</p><p>${t} line two, item ${i * 7 + 5}.</p></section>`)
  .join('')}</body></html>`;

describe('device scale comes from the page', { timeout: 300_000 }, () => {
  let dir: string;
  let repo: string;
  let baseSha: string;
  let headSha: string;

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-scale-'));
    repo = path.join(dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(repo, 'serve.mjs'), SERVER);
    writeFileSync(path.join(repo, 'index.html'), page(false));
    writeFileSync(
      path.join(repo, 'ui-diff.config.json'),
      JSON.stringify({
        startCommand: 'node serve.mjs --port {port}',
        routes: [{ path: '/', name: 'home' }],
        viewports: [
          { name: 'phone', device: 'iPhone 13' },
          { name: 'mobile', width: 390, height: 700, isMobile: true, hasTouch: true },
          { name: 'desktop', width: 800, height: 600 },
        ],
        capture: { fixedTime: '2026-01-01T00:00:00Z' },
      }),
    );
    baseSha = commit(repo, 'before');
    writeFileSync(path.join(repo, 'index.html'), page(true));
    headSha = commit(repo, 'banner on top');
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('sizes regions, shifts and focus crops with the measured devicePixelRatio (3x device, mobile without a scale, 1x desktop)', async () => {
    const cfg = loadConfig(repo, repo);
    const { report } = await runPipeline({ cfg, outDir: path.join(dir, 'out'), base: baseSha, head: headSha, allRoutes: true });
    assert.equal(report.stats.errors, 0, JSON.stringify(report.captures.map((c) => c.error)));
    const expected: Record<string, { scale: number; cssWidth: number }> = {
      phone: { scale: 3, cssWidth: 390 },
      mobile: { scale: 1, cssWidth: 390 },
      desktop: { scale: 1, cssWidth: 800 },
    };
    for (const [viewport, want] of Object.entries(expected)) {
      const c = report.captures.find((x) => x.viewport === viewport)!;
      assert.equal(c.status, 'changed', viewport);
      const d = c.diff!;
      assert.equal(d.scale, want.scale, `${viewport}: scale`);
      assert.equal(d.sizeAfter[0], want.cssWidth * want.scale, `${viewport}: screenshot width`);
      assert.ok(d.shifted?.some((r) => r.dy === BANNER_HEIGHT), `${viewport}: content should shift down ${BANNER_HEIGHT} CSS px, got ${JSON.stringify(d.shifted)}`);
      const cssRegions = d.regions.map((r) => ({ x: r.x / d.scale, y: r.y / d.scale, width: r.width / d.scale, height: r.height / d.scale }));
      assert.ok(
        cssRegions.some((r) => r.y <= 1 && r.height >= BANNER_HEIGHT && r.height <= BANNER_HEIGHT + 8 && r.width >= want.cssWidth - 8),
        `${viewport}: the banner region in CSS px, got ${JSON.stringify(cssRegions)}`,
      );
      assert.equal(c.images.focus.length, 1, viewport);
      const crop = d.focusBoxes?.[0];
      assert.ok(crop, `${viewport}: focus crop box recorded`);
      assert.equal(crop.width, want.cssWidth, `${viewport}: focus crop spans the full-width banner (CSS px)`);
      assert.equal(crop.height, 220, `${viewport}: focus crop height (CSS px)`);
    }
  });
});
