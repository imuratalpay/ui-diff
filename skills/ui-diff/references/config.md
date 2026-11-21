# ui-diff.config.json

Everything is optional; `ui-diff init` writes a starter file. Put it at the repo root, or next to
the app in a monorepo (`apps/web/ui-diff.config.json`). ui-diff uses the nearest config above the
current directory, or `--config <file>`. The config is read from your checkout and applied to both
base and head. A JSON Schema lives at `schema/ui-diff.config.schema.json` in the skill folder.

**Paths and globs** are relative to the config file. A leading `/` means "relative to the repo
root", and `..` is allowed (`../../packages/ui/**`). Use `/` as the separator; a Windows-style `\`
is read as `/` too. Globs support `**`, `*`, `?`, `{a,b}`,
`[abc]` and `!negation`.

## Minimal

```json
{
  "startCommand": "npm run dev -- --port {port}",
  "routes": ["/", "/pricing", "/settings/profile"]
}
```

## Complete example

```json
{
  "startCommand": "pnpm dev --port {port}",
  "baseUrl": "http://127.0.0.1:{port}",
  "install": "auto",
  "routes": [
    { "path": "/", "files": ["src/app/page.tsx", "src/components/Hero/**"], "waitFor": "[data-ready]" },
    { "path": "/pricing", "files": ["src/app/pricing/**"], "variants": { "param": "plan", "values": "1..3" },
      "motion": { "steps": [{ "hover": ".cta" }, { "wait": 500 }, { "click": "[data-tab=yearly]" }] } },
    { "path": "/settings", "actions": [{ "click": "#open-advanced" }], "mask": ["[data-testid=last-login]"] }
  ],
  "globalFiles": ["src/styles/**", "tailwind.config.*", "src/app/layout.tsx"],
  "viewports": [
    { "name": "desktop", "width": 1280, "height": 800 },
    { "name": "mobile", "width": 390, "height": 844, "deviceScaleFactor": 2, "isMobile": true, "hasTouch": true }
  ],
  "themes": [
    { "name": "light", "colorScheme": "light" },
    { "name": "dark", "colorScheme": "dark", "query": { "theme": "dark" } }
  ],
  "capture": { "mask": ["[data-ui-diff-mask]"], "hide": [".intercom-launcher"] },
  "freeze": { "time": "2026-01-15T09:30:00Z" },
  "tokens": { "enabled": true, "files": ["src/styles/tokens.css"] },
  "a11y": { "enabled": true },
  "motion": { "enabled": true }
}
```

## Running the app

| Key | Default | Notes |
|---|---|---|
| `startCommand` | — | Starts the app. `{port}` is replaced with a free port; `PORT` is also set. Required for local (worktree) runs. |
| `baseUrl` | `http://localhost:{port}` | Where the started app listens. For a loopback host (`localhost`, `127.0.0.1`, `[::1]`) the other loopback addresses are tried too, because dev servers bind differently (Vite often listens on IPv6 `::1` only). Keep `localhost` for Next.js: its dev server blocks its own resources for `127.0.0.1`, so pages would not hydrate. |
| `buildCommand` | — | Runs before `startCommand` (e.g. `npm run build` + `startCommand: "npm start"`). |
| `install` | `"auto"` | `"auto"`: if the lockfile matches your checkout, link your installed `node_modules` (caches such as `.vite`/`.cache` are not shared); otherwise run the lockfile's install once (`npm ci`, `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`, `bun install`). Lockfiles are compared by content hash, ignoring line endings and trailing whitespace; when base and head share a lockfile that differs from your checkout, one side installs and the other links to it. Next.js apps never get symlinked `node_modules`, because Turbopack does not follow symlinks outside the project: instead each worktree gets a copy made of hard links (real directories, no download, almost no disk), from your checkout when the lockfile matches or from the other side's install when base and head share a lockfile, so dependencies are installed at most once per lockfile. A string runs that command; `false` skips. If the app exits or keeps answering 5xx with linked dependencies, ui-diff retries with a clean install after 30 s. |
| `cwd` | `"."` | Directory (relative to the config) where commands run. |
| `readyPath` | `"/"` | Polled until it answers with a status below 500. |
| `startTimeoutMs` | `120000` | How long to wait for `readyPath` to answer. |
| `env` | `{}` | Extra environment variables for install/build/start. |
| `copyFiles` | `.env`, `.env.local`, `.env.development.local` | Untracked files copied from your checkout into each worktree when present. |

Worktrees live in the system temp directory and are removed afterwards (`--keep-worktrees` keeps
them). Each server runs in its own process group; only those processes are stopped.

## Routes and detection

`routes` entries are a path string or an object:

| Key | Notes |
|---|---|
| `path` | Required, starts with `/`; may include a query string. |
| `name` | Used in file names and labels (defaults from the path). |
| `files` | Globs whose changes affect this route. Files matching them also count as entry points for the import graph. |
| `waitFor` | Selector that must be visible before capturing. |
| `actions` | Steps run before the static screenshot (same format as motion steps), e.g. open a menu. They run after the page settled (network idle, fonts, the lazy-load scroll), so they can target lazy-loaded elements. A step whose element does not appear within 3 s on one side (a control that is new on head) is skipped there and reported as a warning. |
| `mask` / `hide` | Per-route additions to `capture.mask` / `capture.hide`. |
| `fullPage` | Override `capture.fullPage`. |
| `viewports` / `themes` | Restrict this route to some viewports/themes. |
| `variants` | Variant compare, see `extras.md`. |
| `motion` | `true` or `{ steps, durationMs, viewport, theme, fromNavigation }`, see `extras.md`. |

`globalFiles`: globs whose changes affect every route (global CSS, theme, root layout).

`detect`:

| Key | Default | Notes |
|---|---|---|
| `conventions` | `true` | File-system routing: Next.js (app and pages), SvelteKit, Nuxt, Astro, Remix/React Router, TanStack Router (`src/routes`), plain HTML. |
| `imports` | `true` | Follow imports from changed files to pages, route files and layouts (a component used only in `app/layout.tsx`, `__root.tsx` or `pages/_app.tsx` maps to every route that layout wraps). |
| `aliases` | `{}` | Extra import aliases, e.g. `{ "~/": "src/" }`. tsconfig/jsconfig `paths` are read automatically, including configs reached through `references` (Vite's `tsconfig.app.json`) and relative `extends`, and package.json `#` imports. |
| `maxRoutes` | `12` | Further routes are listed as "not captured". |
| `include` / `exclude` | UI-ish extensions / tests, stories, build output, lockfiles | Which changed files count as UI. |

## Viewports and themes

Viewport: `name`, `width`, `height`, `deviceScaleFactor`, `isMobile`, `hasTouch`, `userAgent`, or a
Playwright `device` name (`"iPhone 13"`). On the CLI: `--viewports desktop,tablet:820x1180@2`.

Theme: `name`, `colorScheme` (`light`/`dark`/`no-preference`, sets `prefers-color-scheme`), `query`
(added to every URL, e.g. `{ "theme": "dark" }` → `?theme=dark`) and `localStorage` (set before
the page loads, e.g. `{ "theme": "dark" }` for next-themes).

## Capture (determinism)

| Key | Default | Notes |
|---|---|---|
| `fullPage` | `true` | |
| `maxHeight` | `4000` | Taller pages are clipped (reported as truncated). |
| `disableAnimations` / `waitForFonts` / `stableRandom` | `true` | Older switches: `false` turns off `freeze.animations` / `freeze.fonts` / `freeze.random`. |
| `fixedTime` | `false` | Older form of `freeze.time`: an ISO timestamp or `"run-start"` sets it (unless `freeze.time` is given). `false` no longer means "let time run": use `freeze.clock: false`. |
| `mask` | `[]` | Selectors painted over with `maskColor` on both sides (timestamps, avatars, live counters). Give masked elements a stable size, e.g. `font-variant-numeric: tabular-nums`. |
| `maskColor` | `#A3A3A3` | |
| `hide` | `[]` | Selectors hidden with `visibility: hidden` (layout preserved). |
| `hideDevOverlays` | `true` | Hides Next.js/Vite/Astro dev overlays and the Vercel toolbar. |
| `scrollToLoad` | `true` | Scrolls through the page to trigger lazy content, then back to the top. |
| `stableShots` | `2` | Retake until this many consecutive screenshots are identical. When the page keeps changing (`requestAnimationFrame` or timer animations), its JavaScript timers are paused for the final shots and a "page did not settle" warning names the element to mask. |
| `settleMs` | `250` | Extra wait before capturing. |
| `waitUntil` | `"load"` | Plus a bounded wait for network idle (`networkIdleTimeoutMs`, 3000). |
| `locale` / `timezoneId` | `en-US` / `UTC` | |
| `timeoutMs` | `30000` | Per navigation/step. |
| `styleMaxElements` | `2500` | Most visible elements whose computed styles are recorded per capture (used by the token audit). A capture with more gets a warning. Replaces `tokens.maxElements`, which is still honoured when this is not set. |

Service workers are blocked and CSP is bypassed in the capture browser so cached or blocked
assets do not differ between sides.

## Freeze (inputs)

Before every still capture, on base and head alike, ui-diff freezes the inputs that make two
renders of the same code differ. Each is on by default and can be turned off:

```json
{ "freeze": { "clock": true, "time": "run-start", "random": true, "seed": 795556381, "animations": true, "fonts": true, "fontTimeoutMs": 8000 } }
```

| Key | Default | Notes |
|---|---|---|
| `clock` | `true` | `Date` is fixed at `time` through Playwright's clock API, so clocks, dates and relative times ("2 min ago") match on both sides. Timers and `requestAnimationFrame` keep running, so the page still renders. |
| `time` | `"run-start"` | The instant: `"run-start"` (when the run began, the same on both sides) or an ISO timestamp such as `"2026-01-15T09:30:00Z"`, which also keeps it the same across runs. |
| `random` / `seed` | `true` / `795556381` | `Math.random`, `crypto.getRandomValues` and `crypto.randomUUID` are seeded with `seed`. |
| `animations` | `true` | CSS animations and transitions are finished, Web Animations completed, the caret hidden and `prefers-reduced-motion: reduce` set. Motion clips are not affected: they always play animations with a running clock. |
| `fonts` | `true` | Waits for `document.fonts.ready` and then until no font face is loading on two checks in a row (a font added by a script a moment later is waited for too), up to `fontTimeoutMs`, plus image decoding. Each capture records which web fonts loaded, failed or were still loading. |

**Rotating content** (carousels, tickers, live counters, ads) changes by itself even with a frozen
clock, because it runs on timers or `requestAnimationFrame`. Mask it: the element is painted over
with `capture.maskColor` on both sides, so whatever it shows does not count, and the rest of the
page is still compared.

```json
{ "capture": { "mask": [".hero-carousel", "[data-testid=live-visitors]"] }, "routes": [{ "path": "/", "mask": [".ticker"] }] }
```

A "page did not settle" warning names the element that kept moving and the `mask` to add. Give
masked elements a stable size (for example `font-variant-numeric: tabular-nums` on counters) so
they do not push the rest of the page around.

## Fingerprint

Each capture records what each side was rendered with, measured in the page: the commit, viewport
size, `devicePixelRatio` and `isMobile`, browser name, version and user agent, web fonts loaded,
failed or still loading, the freeze settings used (clock instant, seed, animations, font wait),
reduced motion, color scheme, locale and timezone, and the test data label. It never records
paths, host names, user names or environment variable values (font URLs are dropped; only family
names are kept). When base and head differ in anything but the commit, the comment warns next to
the diff that it may come from the capture environment and lists what differs.

| Key | Default | Notes |
|---|---|---|
| `fingerprint.dataLabel` | — | What data the app ran with (a fixture name, seed or dataset version). Shown as "not declared" when unset: ui-diff does not guess it. |

## Diff

| Key | Default | Notes |
|---|---|---|
| `threshold` | `0.1` | pixelmatch threshold (0–1, perceptual color distance). |
| `includeAA` | `false` | Count anti-aliasing differences. |
| `minChangedPixels` | `8` | Below this a capture counts as unchanged. |
| `maxFocusCrops` | `2` | Zoomed crops of the largest changed areas per capture. |
| `focusPadding` | `32` | CSS px around each crop. |
| `compositeMaxWidth` | `2400` | Composites wider than this are downscaled. |
| `highlightColor` | `#FF0080` | |
| `alignShifts` | `true` | Matches pixel rows that only moved up or down (a taller hero pushing sections down). Moved content is reported as `shifted` (CSS px, `dy` = after − before) and kept out of the changed percentage; a blue band on the diff's left edge marks it. |

## Publishing and the comment

| Key | Default | Notes |
|---|---|---|
| `publish.mode` | `"branch"` | `"branch"`: orphan assets branch in this repo. `"none"`: text-only comment. |
| `publish.branch` | `ui-diff-assets` | |
| `publish.remote` | `origin` | |
| `publish.keepRuns` | `1` | Runs kept per PR (older runs are removed from the branch). |
| `publish.allowPublicRepo` | `false` | Must be explicitly enabled to upload screenshots to a public repo. |
| `publish.linkBase` | derived | Override the image URL prefix (GitHub Enterprise, custom proxies). |
| `comment.id` | `default` | Separate sticky comments per app in a monorepo (`"web"`, `"docs"`). |
| `comment.title` | `UI diff` | |
| `comment.showUnchanged` | `true` | List unchanged captures in a collapsed section. |

`preview`, `auth`, `variants`, `motion`, `tokens` and `a11y` are described in `extras.md` and
`privacy.md`.
