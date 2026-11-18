# slop-guard

Rules for spotting the habits that make AI-made work look generic, and a small checker that finds the ones a machine can see. It covers web pages, app screens, decks, documents, copy and images. Each context gets its own rules.

The checker is one Node file with no dependencies. It reads HTML, CSS, Markdown and plain text. A hit is evidence for a reviewer, not a verdict. The rules are preferences about design and writing. They are not a test of who or what made something.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/flow-dark.svg">
  <img alt="How slop-guard works: rules from several sources go into rules.json, are filtered by context, then checked by the checker, by screenshot and by judgement, ending in a done checklist." src="docs/flow-light.svg" width="100%">
</picture>

## Install

**As a Claude Code skill.** Clone it into your skills folder:

```sh
git clone https://github.com/blisse-code/slop-guard ~/.claude/skills/slop-guard
```

**With the skills CLI**, for Claude Code and other agents:

```sh
npx skills add blisse-code/slop-guard
```

**As a command**, with nothing installed:

```sh
npx github:blisse-code/slop-guard page.html --context web
```

**With plain Node** (version 20 or later), from a clone:

```sh
node check-slop.mjs page.html --context web
```

## Use

```sh
node check-slop.mjs <files or folders> --context <web|app|deck|doc|copy|image>
                    [--pairing type-pairing.md] [--json out.json] [--strict] [--year 2026]
node check-slop.mjs --list --context app      # the rules for one context
node check-slop.mjs --rubric --context doc    # only the rows you check by eye
```

`--strict` exits with code 1 when there is a high-severity finding, so you can use it in CI. `--pairing` checks that a type pairing was chosen and written down before the build started (see `SKILL.md`).

## Contexts

| Context | Use it for |
|---|---|
| `web` | Websites, landing pages, portfolios |
| `app` | App and dashboard UI, HTML prototypes |
| `deck` | Decks and slides |
| `doc` | Research reports, briefs, write-ups |
| `copy` | Social posts, captions, emails, ads |
| `image` | Generated or chosen imagery |

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/contexts-dark.svg">
  <img alt="Rules per context: web 110 rules with 81 found by the checker; app 80 with 59; deck 89 with 66; doc 46 with 35; copy 33 with 28; image 8 with 4." src="docs/contexts-light.svg" width="100%">
</picture>

All 119 rules, by context: [RULES.md](RULES.md).

## Examples

Each example has a sloppy version and a clean version of the same content. The checker's text and JSON output sits next to each file. The screenshots were taken in a headless browser.

### Landing page

| Before: 68 findings | After: 0 findings |
|---|---|
| ![Sloppy landing page with a violet gradient hero, gradient text, emoji and a sparkle ticker](examples/landing/before.png) | ![Clean landing page for a tool lending library with opening hours and one button](examples/landing/after.png) |

[sloppy.html](examples/landing/sloppy.html) · [its findings](examples/landing/sloppy.txt) · [clean.html](examples/landing/clean.html) · [type pairing](examples/landing/type-pairing.md)

### Dashboard

| Before: 37 findings | After: 0 findings |
|---|---|
| ![Sloppy dark dashboard with glowing cards, filler sparklines and a pulsing live dot](examples/dashboard/before.png) | ![Clean loans dashboard with three counts and a table of overdue tools](examples/dashboard/after.png) |

[sloppy.html](examples/dashboard/sloppy.html) · [its findings](examples/dashboard/sloppy.txt) · [clean.html](examples/dashboard/clean.html) · [type pairing](examples/dashboard/type-pairing.md)

### Post

| Before: 31 findings | After: 0 findings |
|---|---|
| ![Sloppy social post with hype words, staged reveals and hashtags](examples/writing/before.png) | ![Clean post saying when the library opens and what it costs](examples/writing/after.png) |

[sloppy.md](examples/writing/sloppy.md) · [its findings](examples/writing/sloppy.txt) · [clean.md](examples/writing/clean.md)

What the checker prints on the sloppy post:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/terminal-dark.svg">
  <img alt="Terminal output of check-slop.mjs on the sloppy post, listing findings such as hype-copy, staged-reveals and stock-lines, and a summary of 31 findings." src="docs/terminal-light.svg" width="100%">
</picture>

The checker only sees what is in the files. Layout, imagery and tone still need a person. `node check-slop.mjs --rubric --context web` lists what to look at.

## Add a rule

1. Add the rule to `rules.json`: an `id`, the pattern to avoid (`dont`), what to do `instead`, its `contexts`, how to `check` it, a `severity`, and a `detector` name if the checker can find it.
2. For a detector, add the code to `check-slop.mjs`. Then plant the pattern in `tests/check-slop.test.mjs`, with a clean case that must stay quiet.
3. Bump `version` in `rules.json` and regenerate the list: `node check-slop.mjs --rules-md > RULES.md`.
4. Run `node --test tests/check-slop.test.mjs`. CI runs the same tests on Node 20, 22 and 24, and checks that `RULES.md` matches `rules.json`.

To rebuild the screenshots and diagrams: `sh examples/run-checks.sh` refreshes the checker output, and `node docs/build-docs.mjs` redraws the diagrams.

## Sources

The rules draw on several sources:

- Chiranjeet Banerjee's own anti-slop and type pairing rules
- [Impeccable](https://github.com/pbakaus/impeccable), Apache-2.0
- [taste-skill](https://github.com/Leonxlnx/taste-skill), MIT
- The ideas behind [deslop-skills](https://github.com/kmaida/deslop-skills), rewritten in our own words
- General UI, accessibility and plain-writing practice

If you use those tools too, slop-guard is the quick gate and they are the deeper passes. See `SKILL.md` for how they fit together.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
