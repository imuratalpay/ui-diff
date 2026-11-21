import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parseConfig } from '../../src/config.js';
import { copyNodeModules, planInstall, SideManager } from '../../src/sides.js';

const LOCK = '{"lockfileVersion":3,"packages":{}}';
const NEXT_PKG = JSON.stringify({ name: 'app', dependencies: { next: '16.0.0' } });

/** A checkout with installed node_modules: a package, a .bin symlink, a workspace symlink and a cache folder. */
function installedCheckout(root: string): void {
  mkdirSync(path.join(root, 'node_modules', 'next', 'dist'), { recursive: true });
  writeFileSync(path.join(root, 'node_modules', 'next', 'package.json'), '{"name":"next","version":"16.0.0"}');
  writeFileSync(path.join(root, 'node_modules', 'next', 'dist', 'server.js'), 'module.exports = 1;');
  mkdirSync(path.join(root, 'node_modules', '.bin'));
  symlinkSync('../next/dist/server.js', path.join(root, 'node_modules', '.bin', 'next'));
  mkdirSync(path.join(root, 'packages', 'ui'), { recursive: true });
  writeFileSync(path.join(root, 'packages', 'ui', 'index.js'), 'export {};');
  mkdirSync(path.join(root, 'node_modules', '@acme'));
  symlinkSync('../../packages/ui', path.join(root, 'node_modules', '@acme', 'ui'));
  mkdirSync(path.join(root, 'node_modules', '.cache', 'next'), { recursive: true });
  writeFileSync(path.join(root, 'node_modules', '.cache', 'next', 'x'), 'cache');
}

describe('Next.js dependencies in worktrees', () => {
  it('reuses your install as a hard-linked copy when the lockfile matches, and shares one install per lockfile otherwise', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-next-plan-'));
    try {
      const repo = path.join(dir, 'repo');
      mkdirSync(repo);
      writeFileSync(path.join(repo, 'package.json'), NEXT_PKG);
      writeFileSync(path.join(repo, 'package-lock.json'), LOCK);
      installedCheckout(repo);
      const cfg = parseConfig({}, { repoRoot: repo });
      const same = path.join(dir, 'same');
      mkdirSync(same);
      writeFileSync(path.join(same, 'package.json'), NEXT_PKG);
      writeFileSync(path.join(same, 'package-lock.json'), LOCK);
      const plan = planInstall(cfg, same);
      assert.equal(plan.kind, 'copy', JSON.stringify(plan));
      assert.match(plan.reason, /Next\.js/);

      const other = path.join(dir, 'other');
      mkdirSync(other);
      writeFileSync(path.join(other, 'package.json'), NEXT_PKG);
      writeFileSync(path.join(other, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"node_modules/x":{}}}');
      const differs = planInstall(cfg, other);
      assert.equal(differs.kind, 'command');
      assert.ok(differs.lockKey, 'the two sides share one install of the same lockfile');
      assert.equal(differs.share, 'copy', 'and the second side gets a copy, never symlinks');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('copies node_modules as real directories with hard-linked files, keeping relative symlinks inside the worktree', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-next-copy-'));
    try {
      const from = path.join(dir, 'repo');
      const to = path.join(dir, 'worktree');
      installedCheckout(from);
      mkdirSync(path.join(to, 'packages', 'ui'), { recursive: true });
      assert.equal(copyNodeModules(from, to), true);
      const nm = path.join(to, 'node_modules');
      assert.ok(lstatSync(nm).isDirectory() && !lstatSync(nm).isSymbolicLink());
      assert.ok(lstatSync(path.join(nm, 'next')).isDirectory() && !lstatSync(path.join(nm, 'next')).isSymbolicLink(), 'no symlink out of the project');
      const file = path.join(nm, 'next', 'dist', 'server.js');
      assert.equal(statSync(file).ino, statSync(path.join(from, 'node_modules', 'next', 'dist', 'server.js')).ino, 'hard link, not a byte copy');
      assert.equal(readlinkSync(path.join(nm, '.bin', 'next')), '../next/dist/server.js');
      assert.equal(realpathSync(path.join(nm, '@acme', 'ui')), realpathSync(path.join(to, 'packages', 'ui')), 'workspace links resolve inside the worktree');
      assert.equal(existsSync(path.join(nm, '.cache')), false, 'build caches are not shared');
      assert.equal(copyNodeModules(from, to), false, 'leaves an existing node_modules alone');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts a Next.js-style worktree without installing when the lockfile matches your checkout', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-next-side-'));
    const repo = path.join(dir, 'repo');
    const outDir = path.join(dir, 'out');
    try {
      mkdirSync(repo);
      const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
      git('init', '-q', '-b', 'main');
      writeFileSync(path.join(repo, 'package.json'), NEXT_PKG);
      writeFileSync(path.join(repo, 'package-lock.json'), LOCK);
      writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
      writeFileSync(
        path.join(repo, 'serve.cjs'),
        "const v = require('next/package.json').version; require('http').createServer((q, s) => s.end('next ' + v)).listen(Number(process.env.PORT), '127.0.0.1');",
      );
      git('add', '-A');
      git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'app');
      installedCheckout(repo);
      const cfg = parseConfig({ startCommand: 'node serve.cjs', baseUrl: 'http://127.0.0.1:{port}', install: 'auto' }, { repoRoot: repo });
      const sides = new SideManager(cfg, { outDir });
      try {
        const head = await sides.prepare({ name: 'head', ref: 'HEAD' });
        assert.equal(await (await fetch(head.url)).text(), 'next 16.0.0');
        assert.equal(lstatSync(path.join(head.dir!, 'node_modules', 'next')).isSymbolicLink(), false);
        assert.equal(existsSync(path.join(outDir, 'logs', 'install-head.log')), false, 'no install ran');
      } finally {
        await sides.cleanup();
      }
      assert.match(readFileSync(path.join(repo, 'node_modules', 'next', 'dist', 'server.js'), 'utf8'), /module\.exports/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
