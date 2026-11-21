import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { changedLines } from '../../src/git.js';
import { isAnimationPackage, stepTokens, touchesAnimation } from '../../src/motion.js';

describe('which changes can change a motion clip', () => {
  it('collects the class, id and attribute names a motion script targets', () => {
    assert.deepEqual(stepTokens([{ wait: 400 }, { hover: '.cta' }, { click: '[data-tab=yearly]' }, { focus: '#nav a.item' }]), ['cta', 'data-tab', 'yearly', 'nav', 'item']);
  });

  it('counts motion keywords, interaction states and the targeted elements, nothing else', () => {
    assert.ok(touchesAnimation('a.css', ['  transition: background 300ms ease-out;']));
    assert.ok(touchesAnimation('a.css', ['.card:hover { color: red; }']));
    assert.ok(touchesAnimation('a.tsx', ['<motion.div animate={{ x: 10 }} />']));
    assert.ok(touchesAnimation('home.css', ['.cta {'], ['cta']), 'a style change of the hovered button');
    assert.ok(!touchesAnimation('home.css', ['  padding: 10px 18px;'], ['cta']));
    assert.ok(!touchesAnimation('a.tsx', ['<button className="cta-secondary">'], ['cta']), 'whole names only');
    assert.ok(!touchesAnimation('footer.html', ['<p>© 2026 Acme</p>']));
    assert.ok(!touchesAnimation('hero.png', ['transition']), 'binary assets never count');
  });

  it('knows animation packages', () => {
    for (const name of ['framer-motion', 'motion', 'gsap', '@react-spring/web', 'tailwindcss-animate']) assert.ok(isAnimationPackage(name), name);
    for (const name of ['react', 'tailwindcss', 'motion-utils-extra']) assert.ok(!isAnimationPackage(name), name);
  });

  it('reads changed lines per file between commits and in the working tree, untracked files included', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-lines-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
      git('init', '-q', '-b', 'main');
      writeFileSync(path.join(dir, 'a.css'), '.a { color: red; }\n.b { color: blue; }\n');
      git('add', '-A');
      git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD');
      writeFileSync(path.join(dir, 'a.css'), '.a { color: red; transition: color 1s; }\n.b { color: blue; }\n');
      git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qam', 'head');
      const head = git('rev-parse', 'HEAD');
      assert.deepEqual([...(await changedLines(base, head, ['a.css'], dir))], [['a.css', ['.a { color: red; }', '.a { color: red; transition: color 1s; }']]]);
      writeFileSync(path.join(dir, 'b.css'), '.cta {\n  padding: 8px;\n  color: red;\n}\n');
      git('add', '-A');
      git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'b');
      const before = git('rev-parse', 'HEAD');
      writeFileSync(path.join(dir, 'b.css'), '.cta {\n  padding: 10px;\n  color: red;\n}\n');
      git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qam', 'padding');
      const lines = (await changedLines(before, git('rev-parse', 'HEAD'), ['b.css'], dir)).get('b.css')!;
      assert.deepEqual(lines, ['.cta {', '  padding: 8px;', '  padding: 10px;'], 'the enclosing selector comes with a changed declaration');
      assert.ok(touchesAnimation('b.css', lines, ['cta']));
      git('reset', '-q', '--hard', head);
      writeFileSync(path.join(dir, 'new.css'), '.n:hover { color: green; }\n');
      const working = await changedLines(base, undefined, ['a.css', 'new.css'], dir);
      assert.deepEqual(working.get('new.css'), ['.n:hover { color: green; }', '']);
      assert.equal(working.get('a.css')!.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
