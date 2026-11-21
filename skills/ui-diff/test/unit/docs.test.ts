import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { COMMANDS, parse } from '../../src/cli.js';
import { parseConfig } from '../../src/config.js';
import { renderComment } from '../../src/markdown.js';
import { parseReport } from '../../src/report.js';

const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const DOCS = ['../../README.md', '../../CHANGELOG.md', '../../docs/release/v2.0.0.md', '../../examples/README.md', '../../examples/workflows/ui-diff.yml', 'SKILL.md', ...readdirSync(new URL('../../references/', import.meta.url)).map((f) => `references/${f}`)];

/** Code in a doc: fenced blocks, inline code spans, and every line of a YAML file, with `\` continuations joined. */
function codeOf(text: string, yaml: boolean): string[] {
  if (yaml) return text.replace(/\\\n\s*/g, ' ').split('\n');
  const blocks = [...text.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].flatMap((m) => m[1].replace(/\\\n\s*/g, ' ').split('\n'));
  const spans = [...text.replace(/^```[\s\S]*?^```/gm, '').matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  return [...blocks, ...spans];
}

/** "ui-diff run --pr 123 --motion" → ['run', '--pr', '123', '--motion'], stopping at shell syntax and comments. */
function invocations(line: string): string[][] {
  const out: string[][] = [];
  for (const m of line.matchAll(/(?:^|[\s'"(])(?:ui-diff|ui-diff\.mjs"?)\s+([a-z][\w-]*(?:\s+[^\s#|;&<>`)]+)*)/g)) {
    const args = m[1].split(/\s+/).map((a) => a.replace(/^["']|["']$/g, ''));
    out.push(args);
  }
  return out;
}

describe('docs', () => {
  it('only show ui-diff commands and options that exist', () => {
    const known = new Set<string>([...COMMANDS, 'help']);
    let checked = 0;
    for (const doc of DOCS) {
      for (const line of codeOf(read(doc), doc.endsWith('.yml'))) {
        for (const args of invocations(line)) {
          if (!known.has(args[0])) continue;
          checked++;
          assert.doesNotThrow(() => parse(args), `${doc}: \`ui-diff ${args.join(' ')}\``);
        }
      }
    }
    assert.ok(checked >= 35, `found the documented invocations (${checked})`);
  });

  it('name every command in the README, and no HTML report', () => {
    const readme = read('../../README.md');
    for (const command of COMMANDS) assert.match(readme, new RegExp(`ui-diff ${command}\\b`), command);
    for (const doc of DOCS) assert.doesNotMatch(read(doc), /report\.html/, doc);
  });

  it('keep the changelog and the release draft free of other product names', () => {
    const products = /\b(github|gitlab|playwright|pixelmatch|chrome|chromium|npm|npx|pnpm|yarn|bun|node\.js|vercel|figma|react|vue|svelte|next\.js|tailwind|axe|stylex|turbopack|claude|cursor|codex)\b/i;
    for (const doc of ['../../CHANGELOG.md', '../../docs/release/v2.0.0.md']) {
      const hit = read(doc).split('\n').find((line) => products.test(line));
      assert.equal(hit, undefined, `${doc}: ${hit}`);
    }
  });

  it('keep the verified example the comment the current code renders from its report, without an empty summary', () => {
    const cfg = parseConfig(JSON.parse(read('../../examples/sample-site/ui-diff.config.json')), { repoRoot: '/repo' });
    const report = parseReport(JSON.parse(read('../../docs/example/report.json')), 'docs/example/report.json');
    const rendered = renderComment(report, { id: cfg.comment.id, title: cfg.comment.title, storageNote: 'rendered locally — nothing uploaded', showUnchanged: cfg.comment.showUnchanged, link: (p) => p });
    assert.equal(read('../../docs/example/comment.md'), rendered, 'regenerate docs/example (see examples/README.md)');
    assert.doesNotMatch(rendered, /#### Summary/, 'no summary.md, as in CI');
    for (const empty of ['', '  \n\n']) assert.doesNotMatch(renderComment(report, { id: 'default', title: 'UI diff', summary: empty, link: (p) => p }), /#### Summary/, 'an empty summary.md adds no section');
  });

  it('catches an option that does not exist', () => {
    assert.throws(() => parse(['check', '--html']));
  });
});
