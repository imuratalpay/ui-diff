# Changelog

## 2.0.0

ui-diff 2.0 tells you what changed, not only where pixels moved, and says plainly when a result
cannot be trusted.

### Breaking

- **The comment reads verdict first.** The first line says what the run found ("No visual changes",
  "3 measured changes on 2 routes", "Changes found, but captures were not comparable"). Measured
  changes grouped by route come next, then the images, then pixel changes nothing measured explains,
  and last one collapsed block with the capture settings and timing. Without a written summary the
  comment no longer adds the automatic one; it is still written to `.ui-diff/summary.auto.md`.
- **report.json is version 3.** `render` and `publish` still read version 1 and 2 reports.
- **Clock, randomness, animations and fonts are frozen by default** (`freeze`). The older
  `capture.fixedTime`, `stableRandom`, `disableAnimations` and `waitForFonts` keep working;
  `capture.fixedTime: false` now means "not set".
- **Package dependency changes count as UI changes** when they touch a UI package
  (`detect.uiPackages`), so they capture every route (or `detect.dependencyRoutes`).
- **publish posts nothing on a PR without UI changes.** An existing comment keeps its last result,
  collapsed, under a "no UI files changed in <sha>" line.

### Measured changes

- An element map of every capture matches base and head elements with a confidence and a reason
  (test id, id, label or role and name; then text, position under a matched parent or selector;
  then place and size) and measures their style changes: box, type, color, shape, layout, content,
  size and position. The comment says `link 'Get started': padding 8px 14px → 10px 18px`.
- Inherited values, moves caused by a sibling, containers that only grew with their children and
  masked elements are left out. Added or removed subtrees are one entry.
- Measured changes are one row per element, property and old → new value, with the variants it was
  seen on (`desktop, mobile · light, dark`); a value that differs by variant gets one row per value.
  The verdict counts these rows, `check` prints the same ones, and `report.json` keeps them under
  `measured` with the captures of each.
- Causes are told from effects: only authored changes, and size or position changes nothing
  measured explains, count. A size, a move, a parent that grew or a sibling that shifted because of
  a cause is listed under it as its effect, and `report.json` gives every change its kind and every
  effect its cause. An element's own text or image explains its resize, and a sibling that resized
  for a measured reason explains a neighbour it squeezed or wrapped in the same row; a longer label
  is one change, with the wrapped link beside it among its effects.
- Every changed pixel area is named after the element it is in, with the changes that explain it.
  Areas nothing measured explains are listed apart.
- Each measured change is verified before it is shown: it needs at least
  `styleDiff.minConfidence` (default `medium`) and a changed pixel area under its box. Changes that
  fail go to an "Unverified" line with the reason; none is dropped.

### Trust

- A fingerprint per side records what each capture was taken with (viewport, pixel ratio, browser
  and version, web fonts, frozen inputs, media settings, test data label). When base and head
  differ, the run is flagged as captured differently and never reported as clean. No paths, host
  names, user names or environment values are recorded.
- Device pixel ratio is measured in the page, so device and mobile viewports are diffed at the
  scale they rendered at.
- Route actions run after the page settled; a step whose element is missing on one side is skipped
  there with a warning instead of failing the capture.
- Every warning reaches the comment, unmatched UI files are listed, and a run that captured nothing
  says "Nothing was checked" instead of looking clean.
- Identical commits report no change on repeated runs, and a 1px padding change is named on every
  run (both covered by tests).

- The token audit suggests a color token only when it is close (CIEDE2000 difference under 5);
  otherwise it says "no close token" instead of naming an unrelated color.

### Images

- Every changed area gets a still base | head pair with the changed boxes outlined, shown first,
  and a blink GIF with the before | after | diff crop in a collapsed block below it.

### Local check, cache and regions

- `ui-diff check` compares your working tree, uncommitted changes included, with the merge base of
  the default branch, posts nothing, and prints the same order as the comment. Exit code 0 means no
  visual changes, 1 changes, 2 errors, so it can gate a pre-push hook. `--open` opens the images
  folder and `report.json` with the system's default app.
- Base captures are cached in `.ui-diff/cache/` and reused while the base commit, capture settings,
  browser and ui-diff version stay the same. `--no-cache` captures base again; `ui-diff cache-key`
  prints the key for a CI cache. The ten newest entries are kept.
- `focus` and `ignore` (top level and per route) take CSS selectors: only changes inside the focus
  are compared, ignored areas are painted over and left out of the style diff, and crops stay
  inside the focus. A selector that matches nothing is a warning, never a failure.

### Speed

- In CI a preflight job runs detection with only ui-diff's own dependencies, so a PR without UI
  changes finishes in seconds.
- The browser can be an installed channel (`browser.channel` or `UI_DIFF_BROWSER_CHANNEL`); the
  example workflow uses the runner's preinstalled one, so nothing is downloaded.
- Motion clips load each side once, record both sides at the same time, and are recorded only for
  routes whose changed files touch motion or the elements the steps target.
- Worktrees of apps whose dev server does not follow symlinked `node_modules` get a hard-linked copy
  instead of a fresh install.
- An app whose lockfile lists no packages installs nothing in the worktrees, and when the checkout
  has no installed packages to reuse, the log says that instead of calling the lockfile different.
- Each phase of a run is timed and shown in the comment and in `check`.

### Comment size

- When the comment would pass the PR comment size limit, it is shortened in steps and then whole
  sections are left out, lowest priority first. The comment names what was left out and links the
  full `report.json`, which `publish` now uploads next to the images.

### Install

- ui-diff runs from a packed tarball or a clean copy of the skill folder: dependencies are found
  wherever they were installed, and the package is built when it is packed, not when it is
  installed.

### CI workflow example

- Its actions are on the majors that run on Node 24; self-hosted runners need runner 2.327.1 or newer.
- The app needs a lockfile: a `package.json` without one stops the job with an error naming the fix,
  and an app without `package.json` installs nothing.
- The report artifact now really contains `.ui-diff`: the hidden folder was left out of the upload.
  The base cache is not part of it.

## 0.1.0

First release: before/after screenshots of the routes a pull request changes, pixel diffs, variant
compare, motion clips, token audit, accessibility delta and one sticky PR comment.
