#!/usr/bin/env node
// Entry point for agents and humans. Installs dependencies and builds on first use (or after the
// sources change), then runs the CLI. Playwright's Chromium is installed lazily by `ui-diff run`.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const cli = path.join(root, 'dist', 'cli.js');

function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs);
  }
  return newest;
}

function npmRun(args, what) {
  process.stderr.write(`[ui-diff] ${what}…\n`);
  // Node 20.12+ refuses to spawn a .cmd without a shell (EINVAL), so npm.cmd runs through one on
  // Windows; the command is passed as a single string so Node does not warn about unescaped args.
  const options = { cwd: root, stdio: ['ignore', process.stderr, process.stderr] };
  const result = process.platform === 'win32'
    ? spawnSync([npm, ...args].join(' '), { ...options, shell: true })
    : spawnSync(npm, args, options);
  if (result.status !== 0) {
    process.stderr.write(`[ui-diff] error: \`npm ${args.join(' ')}\` failed in ${root}\n`);
    process.exit(result.status ?? 1);
  }
}

if (!existsSync(path.join(root, 'node_modules', 'playwright')) || !existsSync(path.join(root, 'node_modules', 'typescript'))) {
  npmRun(['install', '--no-audit', '--no-fund'], 'installing ui-diff dependencies (first run only)');
}
if (!existsSync(cli) || newestMtime(path.join(root, 'src')) > statSync(cli).mtimeMs) {
  npmRun(['run', '--silent', 'build'], 'building ui-diff');
}

const { main } = await import(pathToFileURL(cli).href);
process.exit(await main(process.argv.slice(2)));
