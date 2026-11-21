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
- [Configure](#configure)
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
ui-diff run            # your branch, uncommitted changes included, vs the default branch
```

The first `run` downloads Chromium (~150 MB). Results are in `.ui-diff/`: open
`.ui-diff/comment.local.md` for the comment preview and `.ui-diff/compare/` for the
`before | after | diff` images. Nothing is posted until you run `ui-diff publish`. In an agent
session, ask: *"Run the ui-diff skill on PR #123 and update the sticky PR comment."*
If something fails, see [Troubleshooting](#troubleshooting).

## What it does

1. **Detects changed UI files** between base and head and maps them to routes through
   `ui-diff.config.json` (`routes[].files`, `globalFiles`), framework routing conventions (Next.js,
   SvelteKit, Nuxt, Astro, Remix, TanStack Router, plain HTML) and an import graph (aliases, workspace packages,
   CSS `@import`/`url()`, HTML `href`/`src`). Unplaceable files and dynamic routes are listed for
   the agent to resolve.
2. **Runs base and head** in temporary git worktrees (dependencies linked or installed, each app
   on a free port in its own process group), or uses existing preview URLs.
3. **Captures with Playwright, deterministically**: animations and transitions finished, fonts and
   images awaited, `Math.random`/`crypto` seeded, optional frozen clock, masked selectors, hidden
   scrollbars and dev overlays, scroll reset, service workers blocked, and each shot retaken until
   consecutive screenshots match. Viewports default to desktop and mobile; themes such as
   `?theme=dark` are configurable.
4. **Diffs with pixelmatch** and composes `before | after | diff` images: a full-page composite and
   zoomed crops of the largest changed areas, with changed pixels highlighted and boxed.
5. **Writes a UX summary**: the agent writes it from the images and measurements (a data-driven
   fallback summary is generated for CI).
6. **Creates or updates one PR comment** via `gh`, found by a hidden marker. Reruns edit it in
   place; nothing stacks.

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
`~/.cache/ms-playwright`. To use an installed Chrome instead, set `UI_DIFF_BROWSER_CHANNEL=chrome`.

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

Every command prints JSON on stdout (logs go to stderr), so agents can parse results.

### CI

[`examples/workflows/ui-diff.yml`](examples/workflows/ui-diff.yml) runs `run` and `publish` on
every PR push with the repository's own `GITHUB_TOKEN` (`contents: write` for the assets branch,
`pull-requests: write` for the comment). It expects the skill committed into the app repository
(`./install.sh --claude --project <app>`), skips fork PRs, and uses the automatic summary. On PRs
whose changed files include no UI file it posts nothing; a sticky comment from an earlier push is
reduced to a one-line "no UI files changed" note.

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
  "capture": { "mask": ["[data-testid=timestamp]"], "fixedTime": "run-start" },
  "a11y": { "enabled": true },
  "tokens": { "enabled": true, "files": ["src/styles/tokens.css"] }
}
```

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
comment body that `publish` would post (with local image paths), and the images next to it.

It found 4 changed captures (desktop/mobile × light/dark), about 0.34% of pixels on desktop and
0.40% on mobile. The taller button shifts the rest of the page down 4px (desktop height 1603 →
1607px); that shift is aligned out of the changed percentage. There is 1 new accessibility issue
(the email label is 3.45:1 in dark mode) and 3 new off-token spacing values (`10px`, `18px`,
`17px`). `?hero=1..4` is still configured and every value renders this same page. The motion clip
is a single frame: the button has no hover animation, and the yearly tab the script clicks is not
on the page. Comparing the after commit with itself reports 8/8 captures unchanged. Publishing was
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
- **Diffs on identical commits**: mask JavaScript animations, carousels and live data, or freeze the
  clock with `capture.fixedTime`.
- **Publish refused**: the repository is public or its visibility is unknown; read the dry run's
  `problems` before posting.

## Development

```bash
cd skills/ui-diff
npm install
npm run typecheck          # tsc (TypeScript 7) over src, tests and scripts
npm test                   # unit tests (node:test + tsx), ~3 s
npm run test:integration   # full pipeline with Chromium on throwaway repos, ~1 min
npm run schema             # regenerate schema/ui-diff.config.schema.json from the zod schema
```

```
skills/ui-diff/
├── SKILL.md                 agent workflow (frontmatter: name, description)
├── bin/ui-diff.mjs          entry point: installs/builds on first use, then runs the CLI
├── src/
│   ├── cli.ts               init · doctor · detect · run · render · publish · prune
│   ├── config.ts schema.ts  zod config schema, defaults, JSON Schema
│   ├── detect.ts conventions.ts imports.ts glob.ts   changed files → routes
│   ├── sides.ts server.ts git.ts                     worktrees, installs, dev servers, previews
│   ├── capture.ts determinism.ts steps.ts auth.ts    Playwright capture
│   ├── diff.ts image.ts font.ts                      pixelmatch, regions, composites, labels
│   ├── motion.ts tokens.ts a11y.ts                   extras
│   ├── report.ts markdown.ts pipeline.ts             report, summary, comment
│   └── publish.ts github.ts                          assets branch, sticky comment via gh
├── references/              config.md · extras.md · privacy.md · troubleshooting.md
├── schema/                  ui-diff.config.schema.json
└── test/                    unit/ · integration/
```

## Roadmap

Not built yet; ideas that would make reviews better for design engineers:

1. **Measured style changes per region.** List exact before → after computed values for elements in
   changed areas (`padding 8px 14px → 12px 24px`, `#2563eb → #7c3aed`) so reviewers verify intent
   instead of eyeballing pixels.
2. **Figma fidelity check.** Compare head against a linked Figma frame (token kept private) to catch
   drift from the approved design, not just from the previous build.
3. **Responsive and content stress sweep.** Capture a breakpoint range (320–1440px) plus long-text,
   RTL and pseudo-localized variants of changed screens to catch breakage that two fixed viewports
   and happy-path copy miss.
4. **Design sign-off gate.** A `ui-diff/design-review` commit status that stays pending until a
   designer ticks "Approved" in the sticky comment, tied to the head SHA so new pushes need a new
   approval.

## License

[MIT](LICENSE) © 2026 Murat Alpay
