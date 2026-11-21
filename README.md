# ui-diff

Before/after screenshots, highlighted pixel diffs and a short UX summary for pull requests that
change UI, posted as **one sticky PR comment**. Images stay private: they are committed to an
orphan branch of the same repository, so only people who can read the repo can see them.

It is an agent skill (Claude Code, Cursor, Codex) with a TypeScript CLI that humans and CI can run
directly.

Site: [skills.muratalpay.me/ui-diff](https://skills.muratalpay.me/ui-diff).

<p align="center">
  <img src="docs/example/compare/home__mobile__light__focus-1.png" alt="ui-diff composite of the mobile home page: before, after and a highlighted diff of a primary button a few pixels larger, with rounder corners, and the link beside it shifted right" width="900">
</p>

## Contents

- [Quick start](#quick-start)
- [What it does](#what-it-does)
- [Install](#install)
- [Use](#use)
  - [Local check](#local-check)
  - [The comment](#the-comment)
  - [Base cache](#base-cache)
- [Configure](#configure)
  - [Focus and ignore](#focus-and-ignore)
- [Privacy and image hosting](#privacy-and-image-hosting)
- [Verified example](#verified-example)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Roadmap](#roadmap)

## Quick start

You need git and Node.js 20.10+. On Windows, use WSL2. The GitHub CLI (`gh auth login`) is only
needed to publish: `ui-diff publish` and `--pr <number>`, which reads the pull request from GitHub.

```bash
git clone https://github.com/imuratalpay/ui-diff.git ~/src/ui-diff
~/src/ui-diff/install.sh --claude                   # Claude Code; Cursor reads it too. --codex for Codex
alias ui-diff='node ~/src/ui-diff/skills/ui-diff/bin/ui-diff.mjs'

cd ~/src/my-app        # on your feature branch
ui-diff init           # writes ui-diff.config.json: check startCommand and routes
ui-diff check          # your working tree vs the merge base: a short summary, nothing posted
```

The first `run` downloads Chromium (~150 MB). Results are in `.ui-diff/`: open
`.ui-diff/comment.local.md` for the comment preview and `.ui-diff/compare/` for the images. Nothing is posted until you run `ui-diff publish`. In an agent
session, ask: *"Run the ui-diff skill on PR #123 and update the sticky PR comment."*
If something fails, see [Troubleshooting](#troubleshooting).

## What it does

1. **Detects changed UI files** between base and head and maps them to routes through
   `ui-diff.config.json` (`routes[].files`, `globalFiles`), framework routing conventions (Next.js,
   SvelteKit, Nuxt, Astro, Remix, TanStack Router, plain HTML) and an import graph (aliases, workspace packages,
   CSS `@import`/`url()`, HTML `href`/`src`). A changed UI dependency (React, Tailwind, a
   component library) in `package.json` or a lockfile marks every route as affected; other
   dependency changes are listed as not checked. Unplaceable files and dynamic routes are listed
   for the agent to resolve.
2. **Runs base and head** in temporary git worktrees (dependencies linked or installed, each app
   on a free port in its own process group), or uses existing preview URLs. Base captures are
   cached in `.ui-diff/cache/` and reused while the base commit and capture settings stay the same.
3. **Captures with Playwright, deterministically**: the same inputs on both sides (frozen clock,
   seeded `Math.random`/`crypto`, animations and caret stopped, late web fonts awaited), masked selectors, hidden
   scrollbars and dev overlays, scroll reset, service workers blocked, and each shot retaken until
   consecutive screenshots match. Viewports default to desktop and mobile; themes such as
   `?theme=dark` are configurable.
4. **Diffs with pixelmatch** and, for each changed area, writes a still `base | head` pair with the
   changed boxes outlined, a blink GIF of the same crop and a `before | after | diff` crop with the
   changed pixels highlighted, plus a full-page composite.
5. **Names what changed**: an element map of each capture matches base and head elements and
   measures their style changes, so the comment says `link 'Get started': padding 8px 14px →
   10px 18px` instead of only "N pixels changed". Each measured change is checked against the
   match confidence and the changed pixels before it is shown.
6. **Writes a UX summary**: the agent writes it from the images and measurements (a data-driven
   draft is written to `.ui-diff/summary.auto.md`; without a summary the comment leads with the
   verdict and the measured changes).
7. **Creates or updates one PR comment** via `gh`, found by a hidden marker, that starts with the
   verdict ([The comment](#the-comment)). Reruns edit it in place; nothing stacks.

Extras, each behind a flag or config key:

| | Flag / config | |
|---|---|---|
| Variant compare | `--variants hero=1..4` | Every value of a query param side by side in one table, with tick boxes reviewers use to pick (ticks survive updates). |
| Motion clips | `--motion`, `routes[].motion.steps` | Before/after GIF (and optional WebM) of a scripted hover/click/scroll, for routes that changed (`--motion-all` for every route). Warns when nothing moved. |
| Token audit | `--tokens tokens.json` | Computed colors, spacing, radii and type in the changed areas that match no design token (JSON, CSS variables or StyleX `defineVars`, auto-detected when no files are set), with selectors and the nearest token. |
| Protected previews | `--base-url/--head-url` + `auth` | Vercel Authentication and similar, with a header/cookie from env sent only to the preview origin; never share or bypass links. |
| Accessibility delta | `--a11y` | axe-core on both sides, reporting only new and fixed issues (contrast, labels, focus) plus tab-order changes. |

## Install

Requirements: macOS or Linux (on Windows, WSL2), git and Node.js 20.10+. The GitHub CLI signed in
(`gh auth login`) is only needed to publish (`ui-diff publish` posts the comment with it) and for
`--pr <number>`; local runs work without it. The first run installs the skill's npm dependencies
and builds it (about a minute); the first capture downloads Playwright's Chromium (~150 MB) into
`~/.cache/ms-playwright`. To use an installed Chrome instead, set `UI_DIFF_BROWSER_CHANNEL=chrome`
or `"browser": { "channel": "chrome" }` in the config; the example CI workflow does this with the
runner's preinstalled Chrome.

The app needs a lockfile (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` or `bun.lock`) if it
has dependencies. ui-diff then reuses your installed `node_modules` in the base and head worktrees
while the lockfile matches, and otherwise installs once from the lockfile, so both sides get the
same packages. Without a lockfile it runs `npm install` in each worktree: slower, and base and head
can end up with different versions. A lockfile that lists no packages installs nothing. The
example CI workflow stops with an error when the app has a `package.json` but no lockfile.

```bash
git clone https://github.com/imuratalpay/ui-diff.git ~/src/ui-diff
cd ~/src/ui-diff
```

The skill is the folder `skills/ui-diff/` (it contains `SKILL.md`). `install.sh` symlinks it for
your user (so `git pull` updates every agent) or copies it into a project (so it can be committed
and used in CI and by cloud agents).

### Claude Code

```bash
./install.sh --claude                          # ~/.claude/skills/ui-diff
./install.sh --claude --project ~/src/my-app   # ~/src/my-app/.claude/skills/ui-diff (commit it)
# or by hand:
ln -s ~/src/ui-diff/skills/ui-diff ~/.claude/skills/ui-diff
```

Start a new session (skills load at startup); `/skills` should list `ui-diff`.

### Cursor

Cursor also loads skills from `~/.claude/skills` and `.claude/skills`, so the Claude Code install
already works. For a Cursor-only setup:

```bash
./install.sh --cursor                          # ~/.cursor/skills/ui-diff
./install.sh --cursor --project ~/src/my-app   # .cursor/skills/ui-diff
```

Cloud agents only see `~/.cursor/skills` once synced, so for Cursor Cloud Agents and self-hosted
workers commit the skill into the project.

### Codex

```bash
./install.sh --codex                           # ~/.agents/skills/ui-diff
./install.sh --codex --project ~/src/my-app    # .agents/skills/ui-diff (Cursor reads this too)
```

(`~/.codex/skills` still works in Codex but is the legacy location.)

To do the one-time setup ahead of time:
`npm --prefix skills/ui-diff install && npx --prefix skills/ui-diff playwright install chromium`.
Remove an install with the same flags plus `--uninstall`.

## Use

### One-line prompt

> Run the ui-diff skill on PR #123: capture before/after for the affected routes, write the UX summary, and update the sticky PR comment.

Other things to ask:

- "Show me what my branch changes visually before I open the PR." (local preview, nothing posted)
- "Compare `?hero=1..4` on the home page and add them to PR #88 so design can pick one."
- "Record the hover and tab transitions on /pricing for PR #88."
- "Check PR #88 for new accessibility issues and off-token colors in dark mode too."
- "Use the protected Vercel previews of PR #88 instead of running the app locally."

The agent detects the routes, runs the capture, reviews the images, writes the summary, shows it
to you, and asks before posting.

### CLI

```bash
alias ui-diff='node ~/src/ui-diff/skills/ui-diff/bin/ui-diff.mjs'
cd ~/src/my-app

ui-diff init                         # suggest ui-diff.config.json (start command, routes)
ui-diff doctor                       # git, gh, browser, config, repo visibility
ui-diff detect --pr 123              # changed UI files → routes, with reasons
ui-diff check                        # working tree vs merge base; exit 0 no changes, 1 changes, 2 errors
ui-diff run --pr 123                 # capture + diff → .ui-diff/report.json and images
$EDITOR .ui-diff/summary.md          # your UX summary (start from .ui-diff/summary.auto.md)
ui-diff render                       # preview the final comment: .ui-diff/comment.preview.md
ui-diff publish --pr 123 --dry-run   # list uploads and say if a real publish would be refused; pushes and posts nothing
ui-diff publish --pr 123             # upload to ui-diff-assets + create/update the sticky comment
ui-diff prune --closed               # remove images of closed PRs
```

More `run` options:

```bash
ui-diff run                                            # working tree (incl. uncommitted) vs the default branch
ui-diff run --base origin/main --head HEAD --routes /,/pricing
ui-diff run --pr 123 --viewports desktop,tablet:820x1180@2 --themes light,dark
ui-diff run --pr 123 --variants hero=1..4 --variants "/pricing:plan=basic,pro"
ui-diff run --pr 123 --motion --a11y --tokens src/styles/tokens.css
VERCEL_AUTOMATION_BYPASS_SECRET=… ui-diff run --base-url https://app-git-main-acme.vercel.app \
  --head-url https://app-git-feature-acme.vercel.app --routes /,/pricing
```

Every command prints JSON on stdout (logs go to stderr), so agents can parse results; `check`
prints a short text summary instead unless you pass `--json`.

### Local check

`ui-diff check` answers "did my change move anything?" before you push. Head is your working tree,
uncommitted and untracked changes included; base is the merge base with the default branch, or
`--base <ref>`. It runs the same capture and diff as `run`, writes the report and images to
`.ui-diff/out/`, and posts and pushes nothing.

```text
ui-diff check: 1 measured change on 1 route (exit 1)
base main @ 3075b4c → head working tree @ 8103b60 + uncommitted changes · 1 route · desktop, mobile · light, dark

Measured changes on /
  - link 'Start free trial' (a.cta): size 142.5×44px → 146.5×48px · padding 10px 18px → 12px 20px

Images (4 of 4 captures changed)
  /  desktop/light  0.33% of pixels changed · 1 area · content shifted down 4px (unchanged, not counted) · page height 1607 → 1611px
    .ui-diff/out/compare/home__desktop__light__pair-1.png
  …

Captured with chromium 159.0.8154.6 · clock 2026-01-15T09:30:00.000Z · en-US UTC
⏱ 23s total · detect 0.1s · prepare 0.5s (base: cached 0.0s ‖ head: none 0.0s, boot 0.4s) · capture 6.9s (4 screenshots, slowest 1.8s) · diff 3.9s · …
Report: .ui-diff/out/report.json · images: .ui-diff/out/compare/ · preview: .ui-diff/out/comment.local.md
```

The summary follows the order of the PR comment: the verdict, measured changes by route, the image
pairs, pixel changes nothing measured explains, failures and warnings, then how it was captured
and the timing. The exit code is 0 when nothing changed visually (or no UI file changed), 1 when
something did and 2 on any error, so it can gate a pre-push hook:
`ui-diff check --quiet || exit 1` in `.git/hooks/pre-push`. `--json` prints the verdict, exit code
and stats instead. `--open` opens `.ui-diff/out/compare/` and `.ui-diff/out/report.json` with your
system's default app and says which it opened, or that there was nothing to open. `check` shares the [base cache](#base-cache) with `run`, so a second check
against the same base skips capturing base.

### The comment

The comment is built so the first line answers the question and everything after it is evidence,
most useful first:

1. **Verdict**, in plain words: "No visual changes", "3 measured changes on 2 routes", "Visual
   changes on 1 route, none measured", "Changes found, but captures were not comparable", or
   "Nothing was checked" when no route was captured. Below it: base and head, routes, viewports,
   themes, capture counts, the focused and ignored regions, and a warning when base and head were
   captured differently (fonts, browser, viewport, pixel ratio, clock…), in which case the run is
   never reported as clean.
2. **Your summary**, when the agent or you wrote `.ui-diff/summary.md`.
3. **Measured changes**, grouped by route, one row per element, property and `old → new` value,
   biggest element first, each with the variants it was seen on (`desktop, mobile · light, dark`).
   A value that differs by variant (a background that is different in dark mode) gets one row per
   value. Only causes count: an authored change (padding, color, text, an added element…), or a
   size or position change that nothing measured explains. What a cause changed besides itself sits
   under it in one line, such as `size 109.5×40px → 117.5×48px, moved 4px left (from the padding
   change)`; effects on other elements (a parent that grew, siblings that moved) follow, collapsed
   past three. The verdict counts the causes, and `report.json` keeps every row under `measured`
   with its kind (`cause`, `effect` or `unexplained`), the cause of each effect and the captures of
   each. Changes that could not
   be verified (matched with less than `styleDiff.minConfidence`, or with no changed pixels under
   them) sit on a small "Unverified" line with the reason; none is dropped.
4. **Images**: per changed area a still `base | head` pair with the changed boxes outlined and a
   line naming what it shows, then a collapsed "Blink and diff" block with the blink GIF and the
   `before | after | diff` crop, and the full page collapsed below. The still pair comes first so
   people who find blinking images hard to read can compare side by side.
5. **Pixel changes with no measured change**: changed areas no measured change explains, with their
   size, place and the element they are in.
6. Failed and partial captures, warnings, variants, motion, accessibility, design tokens,
   unmatched files and dependency changes, and the unchanged captures, collapsed.
7. **Capture settings and timing**, in one collapsed block: what each side was captured with, side
   by side, and how long each phase took.

The footer links the full `report.json`, which `publish` uploads next to the images. When the
comment would pass the PR comment size limit it is shortened in steps and then leaves out whole
sections, lowest priority first (capture settings and timing, then the unchanged list, and so on;
the verdict and measured changes stay), and says which ones are in `report.json` instead.

### Base cache

Base rarely changes between pushes to a PR, so base captures are kept in `.ui-diff/cache/` and
reused. The key is `base-<base sha, 12 hex>-<hash>`, the hash covering the base commit, the capture
plan and settings (routes, viewports, themes, capture, freeze, focus and ignore, style and token
settings, and how the app is installed, built and started, including the contents of
`copyFiles`), the browser and its version, and the ui-diff version. On a hit base is not checked
out, installed, built, started or captured, head is frozen at the same instant as the cached base,
and the timing line says `base: cached`. Any mismatch or missing file captures base again; an
entry is written whole or not at all. The ten newest entries are kept.

```bash
ui-diff run --no-cache     # capture base again
ui-diff cache-key          # the key a run would use, for a CI cache
```

The capture settings in the comment show whether base was reused and the key. The example CI
workflow restores and saves `.ui-diff/cache` under that key.

### CI

[`examples/workflows/ui-diff.yml`](examples/workflows/ui-diff.yml) runs on every PR push with the
repository's own `GITHUB_TOKEN` (`contents: write` for the assets branch, `pull-requests: write`
for the comment). A `preflight` job runs `ui-diff detect` with only ui-diff's own dependencies (no
app install, no browser) and prints a `status`; when nothing maps to a route the run ends there,
successfully, and the capture job (app install, browser, `run`, `publish`) is skipped. It expects
the skill committed into the app repository (`./install.sh --claude --project <app>`) and a
lockfile in the app (a `package.json` without one fails the job with an error naming the fix; an
app without `package.json` installs nothing), skips fork PRs, and posts without a written summary, so its comments lead with the verdict and the measured
changes. On PRs whose changed files include no UI file it posts
nothing; on a sticky comment from an earlier push only the top line changes, to "no UI files
changed in <sha>", and the last result with UI changes stays below it, collapsed.
The capture job restores and saves the [base cache](#base-cache) under the key `ui-diff cache-key`
prints, so later pushes to the same PR capture only head. The workflow also documents an optional
`paths:` filter for skipping the workflow on GitHub's side. Its actions (`actions/checkout@v7`,
`actions/setup-node@v7`, `actions/cache@v6`, `actions/upload-artifact@v7`) run on Node 24, so
self-hosted runners need runner version 2.327.1 or newer. The full `.ui-diff` folder, without the
base cache, is kept as the `ui-diff-report` artifact for 14 days.

## Configure

```json
{
  "startCommand": "npm run dev -- --port {port}",
  "routes": [
    { "path": "/", "files": ["src/app/page.tsx", "src/components/Hero/**"] },
    { "path": "/pricing", "files": ["src/app/pricing/**"], "variants": { "param": "plan", "values": "1..3" } }
  ],
  "globalFiles": ["src/styles/**", "tailwind.config.*"],
  "themes": [{ "name": "light" }, { "name": "dark", "colorScheme": "dark", "query": { "theme": "dark" } }],
  "capture": { "mask": [".hero-carousel"] },
  "ignore": [".ad-slot"],
  "freeze": { "time": "2026-01-15T09:30:00Z" },
  "a11y": { "enabled": true },
  "tokens": { "enabled": true, "files": ["src/styles/tokens.css"] }
}
```

### Focus and ignore

Both take CSS selectors, at the top level or per route:

```json
{
  "focus": [".pricing"],
  "ignore": [".ad-slot", "[data-live]"],
  "routes": [{ "path": "/checkout", "focus": ["form.payment"] }]
}
```

- `focus` limits the comparison to the matching elements: the pixel diff counts changes inside
  their boxes only (a page that grew elsewhere is unchanged), the style diff lists only those
  elements and what they contain, and the image crops stay inside them.
- `ignore` paints the matching elements over on both sides, like `capture.mask`, and leaves them
  out of the style diff.
- Selectors are resolved on every capture. One that matches nothing on a side is a warning in the
  report and the comment, never a failure; when no focus selector matches at all the whole page is
  compared and the warning says so.
- The comment names the focused and ignored regions under the verdict, and both are part of the
  base cache key.

All options: [`skills/ui-diff/references/config.md`](skills/ui-diff/references/config.md).
Extras: [`references/extras.md`](skills/ui-diff/references/extras.md). JSON Schema:
[`schema/ui-diff.config.schema.json`](skills/ui-diff/schema/ui-diff.config.schema.json).

## Privacy and image hosting

Screenshots of private company code are as sensitive as the code, so ui-diff never sends them to
public or third-party image hosts. By default `publish`:

- commits the images to an orphan branch, `ui-diff-assets`, of the **same repository** with git
  plumbing (your working tree, index and branches are untouched) and links them as
  `https://github.com/<owner>/<repo>/raw/ui-diff-assets/…`, which renders only for signed-in users
  with read access;
- keeps the branch to a single commit (replaced with `--force-with-lease`), carries over other PRs'
  files and drops older runs of the same PR, so clones stay small;
- checks repository visibility first and **refuses public repositories** unless you pass
  `--allow-public-repo`; unknown visibility needs `--assume-private`.

Trade-offs to know: everyone with read access to the repo (including outside collaborators) can
open the images; full clones download the current assets snapshot; deleted images may persist in
GitHub caches for a while; GitHub Mobile and email notifications may not render them. Alternatives
are a text-only comment (`--no-upload`), CI artifacts, or a separate private assets repository
(`publish.remote` + `publish.linkBase`). Protected previews take credentials only from environment
variables, send them only to the preview origins, redact them everywhere, and refuse URLs that
carry bypass or share tokens. Details: [`references/privacy.md`](skills/ui-diff/references/privacy.md).

## Verified example

[`examples/sample-site`](examples/sample-site) is a tiny static page committed twice in this
repository: [`6737326`](../../commit/6737326b2e051665eb7b14a33d39acee32ff22de) (before) and
[`cc13cab`](../../commit/cc13cab81ca4c056ebe8ed861cce6747f2495e59) (after: the primary button's
padding grows from 8×14px to 10×18px, its corner radius from 4px to 8px, the gap before the
secondary link from 16px to 17px, and the "Work email" label turns brand blue). Running ui-diff
on those two commits produced [`docs/example/comment.md`](docs/example/comment.md), the exact
comment body that `publish` would post (with local image paths, and without a `summary.md`, as in
CI), and the images and `report.json` next to it.

Its verdict is "5 measured changes on 1 route": the button's padding and corner radius, the
actions' gap, and the label's color in light and in dark mode (the old color differs, so two
rows). The button's size, the taller actions row and hero, the link beside it and every section
below that moved down 4px are listed under the padding change as its effects.

It found 4 changed captures (desktop/mobile × light/dark), about 0.34% of pixels on desktop and
0.40% on mobile. The taller button shifts the rest of the page down 4px (desktop height 1603 →
1607px); that shift is aligned out of the changed percentage. There is 1 new accessibility issue
(the email label is 3.45:1 in dark mode) and 3 new off-token spacing values (`10px`, `18px`,
`17px`). `?hero=1..4` is still configured and every value renders this same page. The motion clip
is a single frame: the button has no hover animation, and the yearly tab the script clicks is not
on the page. Comparing the after commit with itself (`--all-routes`) reports "No visual changes"
with 8/8 captures unchanged. Publishing was
verified against a local bare remote; no real PR was contacted. Reproduce with
[`examples/README.md`](examples/README.md).

## Troubleshooting

The common cases, with fixes, are in
[`references/troubleshooting.md`](skills/ui-diff/references/troubleshooting.md):

- **Server never ready**: Vite and similar servers bind `localhost` (often IPv6 only) and Next.js
  blocks its dev resources for `127.0.0.1`, so use `"baseUrl": "http://localhost:{port}"`; make
  sure `startCommand` passes `{port}`; raise `startTimeoutMs` for slow boots.
- **"No UI changes" / `unmatched` files**: check `ui-diff detect` reasons; add aliases that only
  live in bundler config to `detect.aliases`, map shared code with `routes[].files`, or pass `--routes`.
- **Diffs on identical commits**: the clock, randomness, animations and fonts are frozen by default
  (`freeze`); mask carousels, tickers and live data with `capture.mask`.
- **Publish refused**: the repository is public or its visibility is unknown; read the dry run's
  `problems` before posting.

## Development

```bash
cd skills/ui-diff
npm install
npm run typecheck          # tsc (TypeScript 7) over src, tests and scripts
npm test                   # unit tests (node:test + tsx), ~10 s
npm run test:integration   # full pipeline with Chromium on throwaway repos, ~6 min
npm run schema             # regenerate schema/ui-diff.config.schema.json from the zod schema
```

```
skills/ui-diff/
├── SKILL.md                 agent workflow (frontmatter: name, description)
├── bin/ui-diff.mjs          entry point: installs/builds on first use, then runs the CLI
├── src/
│   ├── cli.ts               init · doctor · detect · cache-key · run · check · render · publish · prune
│   ├── config.ts schema.ts  zod config schema, defaults, JSON Schema
│   ├── detect.ts conventions.ts imports.ts glob.ts   changed files → routes
│   ├── sides.ts server.ts git.ts                     worktrees, installs, dev servers, previews
│   ├── capture.ts determinism.ts steps.ts auth.ts    Playwright capture
│   ├── diff.ts image.ts font.ts                      pixelmatch, regions, composites, labels
│   ├── motion.ts tokens.ts a11y.ts                   extras
│   ├── elements.ts styles.ts                         element map, matching, style diff, verification
│   ├── cache.ts check.ts                             base cache, local check
│   ├── report.ts verdict.ts markdown.ts pipeline.ts  report, verdict, comment
│   └── publish.ts github.ts                          assets branch, sticky comment via gh
├── references/              config.md · extras.md · privacy.md · troubleshooting.md
├── schema/                  ui-diff.config.schema.json
└── test/                    unit/ · integration/
```

## Roadmap

Not built yet; ideas that would make reviews better for design engineers:

1. **Figma fidelity check.** Compare head against a linked Figma frame (token kept private) to catch
   drift from the approved design, not just from the previous build.
2. **Responsive and content stress sweep.** Capture a breakpoint range (320–1440px) plus long-text,
   RTL and pseudo-localized variants of changed screens to catch breakage that two fixed viewports
   and happy-path copy miss.
3. **Design sign-off gate.** A `ui-diff/design-review` commit status that stays pending until a
   designer ticks "Approved" in the sticky comment, tied to the head SHA so new pushes need a new
   approval.

## License

[MIT](LICENSE) © 2026 Murat Alpay
