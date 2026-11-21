# Examples

## `sample-site/`

A tiny static landing page used to verify ui-diff end to end inside this repository. It is
committed twice:

| Commit | Side | What it contains |
|---|---|---|
| `6737326` | base | Blue CTA, two pricing cards, labelled newsletter field, chart image without alt text |
| `cc13cab` | head | Same page, with the primary button padding 10×18px (was 8×14) and radius 8px (was 4), a 17px gap before the secondary link (was 16), and a brand-blue "Work email" label |

`serve.mjs` is a zero-dependency static server (`node serve.mjs --port 4173`). With
`SAMPLE_PREVIEW_TOKEN` set it requires an `x-preview-token` header or `preview_token` cookie,
which is how the protected-preview path was tested. `ui-diff.config.json` enables every extra:
dark theme via `?theme=dark`, variants, a motion script, the token audit against `tokens.json`
(W3C format; `tokens.css` holds the same tokens as CSS variables) and the accessibility delta.
The footer shows a frozen clock, a seeded random tip and a masked live counter. The page does
not branch on `?hero=`, and the motion script's `[data-tab=yearly]` click has no target, so a
run reports identical variant shots and a single-frame clip.

Reproduce from the repository root:

```bash
SKILL=skills/ui-diff
CFG=examples/sample-site/ui-diff.config.json

node $SKILL/bin/ui-diff.mjs detect --config $CFG --base 6737326 --head cc13cab
node $SKILL/bin/ui-diff.mjs run    --config $CFG --base 6737326 --head cc13cab
# write .ui-diff/summary.md (docs/example/comment.md shows the one used here), then:
node $SKILL/bin/ui-diff.mjs render --config $CFG --output docs/example/comment.md --copy-images
node $SKILL/bin/ui-diff.mjs publish --config $CFG --pr 1 --dry-run     # nothing is pushed or posted

# determinism check: the same commit on both sides → every capture unchanged
node $SKILL/bin/ui-diff.mjs run --config $CFG --base cc13cab --head cc13cab --all-routes

# real upload path against a throwaway local remote, without posting a comment
git init --bare /tmp/assets.git
node $SKILL/bin/ui-diff.mjs publish --config $CFG --pr 1 --remote /tmp/assets.git \
  --link-base https://github.com/OWNER/REPO/raw/ui-diff-assets --no-comment --assume-private
```

## `workflows/ui-diff.yml`

GitHub Actions workflow for an app repository: runs ui-diff on every PR push and updates the
sticky comment, which leads with the verdict and the measured changes. See the comments in the file.
