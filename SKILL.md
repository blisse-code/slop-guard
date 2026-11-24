---
name: slop-guard
description: Anti-slop rules for any AI-made work, split by context (websites, app and dashboard UI, decks, documents and reports, social and marketing copy, imagery, and code in JavaScript, TypeScript and Python), with a checker (check-slop.mjs) that needs no dependencies and a done checklist. Use before you deliver or review anything an AI helped make, such as a page, prototype, dashboard, deck, report, post, image brief or code change, and whenever a QA, review or proof step runs. It is the gate; impeccable, design-taste-frontend and the deslop skills are deeper tools to run alongside when they are installed.
---

# slop-guard

One set of anti-slop rules, split by context, with a checker for the rules a machine can find. **The rules are design and writing preferences. They are not a test of who or what made something.** Judge the result you can see, and never guess the author.

## Files

| File | What it is |
|---|---|
| `rules.json` | The rules. Each has an id, the pattern to avoid (`dont`), what to do instead, the contexts it applies to, how to check it (machine, screenshot, judgement), a severity, and a detector name when the checker can find it. Change rules here and nowhere else. |
| `check-slop.mjs` | The checker. It reads HTML, CSS, SVG, Markdown, plain text, and JavaScript, TypeScript and Python source, or text piped in with `--stdin`. No dependencies. |
| `RULES.md` | The rules listed per context. Generated: `node check-slop.mjs --rules-md > RULES.md`. |
| `profiles/` | Example profiles and the profile reference. |
| `tests/` | Planted problems, clean samples and the public-domain false-alarm set. Run `node --test tests/check-slop.test.mjs`. |
| `examples/` | A sloppy and a clean landing page, dashboard, post and JavaScript file, with the checker's output (and screenshots for the pages). |

## Which rules apply where

| Context | Use it for | The checker looks for | Check by eye |
|---|---|---|---|
| `web` | Websites, landing pages, portfolios | CSS and HTML patterns, page basics, copy tells, dead links, unlabelled fields, blocked zoom, small tap targets, straight quotes in visible text | Layout rhythm, the stock landing page, imagery, icons, colour balance |
| `app` | App and dashboard UI, HTML prototypes | CSS and HTML patterns, controls with no name, vague button labels, field types, charts with no text, hover-only actions, generic error copy | Repeated cards, filler charts, status chips that never change, missing states, form errors, action feedback |
| `deck` | Decks and slides | Copy tells in exported text; CSS patterns in HTML decks | Everything centred, tile grids, stock faces, type hierarchy |
| `doc` | Research reports, briefs, write-ups | Hype and filler words, rhetorical habits (", not ..." slogans, colon reveals, self-answered questions, repeated phrases, sentences of one length), placeholders, made-up proof, nameless authority, hedging, emoji and code-style headings, cutoff disclaimers, stock endings, bold sprinkled through paragraphs | Filler charts, heading order, line length, invented details, one thing called by many names |
| `copy` | Social posts, captions, emails, ads | Hype words, stock lines, stock hooks, punchline paragraphs, engagement bait, canned courtesies, exclamation marks | Claims about what it does and for whom; the same voice for every client |
| `image` | Generated or chosen imagery | Nothing yet | Floating 3D shapes, stock faces, blob crops, fake grain, the AI palette |
| `code` | Code changes in JavaScript, TypeScript and Python | Comments that narrate the code, debug output, dead and commented-out code, swallowed errors, pass-through wrappers, generic names, casts and `any`, TODO residue, style drift, unused imports, deep nesting, docstring bloat, vague error messages, notes files left in the change | Scope creep, tests that only test their mocks, layers nobody asked for |

Pick the context by the work, not the project. A research-only project uses `doc` (and `deck` for readouts), never the web rules. Code is checked only under `code`, and `code` skips pages and stylesheets.

## Quote marks

Text people read on a page, slide or document uses curly quotes and apostrophes (‘ ’ “ ”). Code, Markdown source, commands and HTML attributes keep straight quotes. The checker flags straight quotes only in the visible text of HTML, never in attributes, `<code>`, `<pre>` or Markdown.

## Typography: choose and record a pairing before you build

Any work that sets type (web, app, decks, documents) chooses a pairing first and writes it down, then builds.

- **Contrast** in letter structure (serif, sans, slab, mono), weight, width and size, and personality (one loud, one quiet).
- **Match** in x-height and proportions, mood and era, and tone.
- Mix the structure: serif with sans, or a slab or mono with a plain sans. Two near-identical fonts look like a mistake.
- One personality, one workhorse: the expressive face for headings and short labels, the quiet one for paragraphs, forms and buttons.
- Give every font a job. Two families are usually enough and three is the limit.
- Use free fonts, set heading and body tokens (`--font-display`, `--font-body`), and do not default to Inter, Roboto, Poppins or Space Grotesk.

The record goes in the project's tokens or design notes:

```markdown
## Type pairing
- Display: Archivo Black (--font-display), headings and short labels
- Body: Source Serif 4 (--font-body), paragraphs, forms, buttons
- Why: sans display over serif body (structure), heavy over regular (weight), similar x-height, both plain-spoken.
```

`check-slop.mjs --pairing <file>` fails when the record or any of its three lines is missing.

## How to use it

1. **Before you build,** read the rules for your context: `node check-slop.mjs --list --context app`.
2. **Before you deliver,** run the checker on the output:
   `node check-slop.mjs <files or folders> --context <c> [--pairing <record.md>] [--json out.json] [--strict]`
   A hit is evidence for a reviewer, not a verdict. A deliberate brand choice is fine when it is written down.
3. **Then check by eye** what the machine cannot: `node check-slop.mjs --rubric --context <c>` lists those rows. Look at anything on screen at 390, 820 and 1280 px.
4. **Report** what you checked and what you could not check, using the done checklist at the end of each context in `RULES.md`.

Severity: high is a defect (unreadable text, a control with no name, placeholder or made-up content). Medium is a pattern to remove or justify. Low asks you to confirm it was on purpose.

Every rule is also **hard** or **soft**. Hard rules are wrong in any voice or brand; soft rules are style defaults that a genre, a profile or the writer's own voice may override. `--fail-on hard` fails only on hard findings; `--strict` still fails on any high finding.

## Genres, profiles and the trend score

- **Genre** (`--genre social|email|docs|legal|clinical|academic|fiction|speech`): relaxes soft rules that do not fit the kind of writing, such as hedges in legal text or repetition in a speech. `--genres` lists what each one changes.
- **Profile** (`--profile file.json`): an optional file that tunes the checker for a team, brand or writer. It can switch rules off, change severities, allow words and ban others. Hard rules stay on unless it sets `allowHardOff`. With no profile, the neutral defaults apply. Keys and generic examples: `profiles/README.md`. A profile made for one person stays in their private files, never in this repo.
- **Trend score**: files of prose with 150 words or more get a 0–100 score. Use it to compare drafts of the same piece (`--history scores.jsonl` records runs). It is not a grade and not a comparison between writers.
- **Beyond single words** (v2.3): endings that restate the opening, "preview, body, recap" structure, superlatives and figures with no source, the same sentence on three or more pages of a folder, and the prose checks on alt text, meta descriptions, SVG text, JSX text and `--stdin` input (commit messages, pull request descriptions).
- **Edits, voice and reading level** (v2.4): `--before <file>` or `--git-base <rev>` reports findings an edit added and fixed, and whether figures, names and negations survived. `--build-voice <samples>` measures a person's own writing into a voice file (numbers and function words only). `--voice <file>`, or `voice` in a profile, gives a draft a 0–100 match and names where it drifts. Reading grade is checked against a target per context. A profile's `spelling` flags the other spelling. Samples and voice files of a real person stay in their private files.
- **Skipped text**: quotes, code, blockquotes and links are left out of the prose checks, and words used in their literal sense are kept ("elevated blood pressure"). Mark other regions with `<!-- slop-guard: off -->` and `<!-- slop-guard: on -->`.

## How it relates to other skills

slop-guard is the gate: one rules file, one checker, one checklist. The tools below go deeper, and you can run them alongside it when they are installed.

- `impeccable` gives design direction, critique and its own browser-based detector. Use it to design or fix a page. Use slop-guard to check the result.
- `design-taste-frontend` (taste-skill) builds whole company websites and runs its own copy linter and finish gate in a real browser.
- `deslop-ui` and `deslop-writing` are review checklists for interfaces and prose. `deslop-writing` has a much longer word list than this checker.
- A de-slop skill that edits code, product and prose in place does the cleaning; run the `code` context afterwards to check what is left.

When they disagree, record the choice you made and why.

## Adding or changing a rule

1. Edit `rules.json`: give the rule an id, `dont`, `instead`, `contexts`, `check`, `severity`, `kind` (hard or soft), and a `detector` if the checker can find it. A new prose rule must stay quiet on the public-domain set in `tests/fixtures/public-domain/`.
2. If it has a detector, add it to `check-slop.mjs` and plant it in `tests/check-slop.test.mjs` with a clean case that must stay quiet.
3. Bump `version` in `rules.json`, then run `node check-slop.mjs --rules-md > RULES.md` and `node --test tests/check-slop.test.mjs`.
4. Projects that keep a copy of the checker need the new `rules.json`, `check-slop.mjs` and `RULES.md` copied in.

## Sources

The rules draw on several sources, credited here once rather than rule by rule:

- Chiranjeet Banerjee's own anti-slop and type pairing rules
- [Impeccable](https://github.com/pbakaus/impeccable), Apache-2.0
- [taste-skill](https://github.com/Leonxlnx/taste-skill), MIT
- [ui-ux-pro-max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill), MIT
- The de-slop skill in [iamladi's primitives plugin](https://github.com/iamladi/cautious-computing-machine--primitives-plugin), MIT
- Ideas from [deslop-skills](https://github.com/kmaida/deslop-skills) and from the de-slop skill in [shipshitdev/skills](https://github.com/shipshitdev/skills), rewritten in our own words (neither has a licence file, so none of their text is used)
- General UI, accessibility, code review and plain-writing practice

The licence notices are in `NOTICE`.
