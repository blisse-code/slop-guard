# Changelog

## 2.4.0 (2026-11-24)

Edits, voice and reading level.

- **Diff mode.** `--before <file>` compares one file with an earlier version; `--git-base <rev>` compares each file with git. The output lists the findings the edit added and the ones it fixed, plus a fact check under the new `facts-changed` rule:
  - figures that disappeared or appeared;
  - names that were dropped;
  - a change in the number of negations.

  The JSON report adds a `diff` object.
- **Voice.** `--build-voice <files or folders>` writes a voice file from samples a person wrote themselves (`--split <regex>` divides one file into samples). The file holds:
  - sentence and paragraph lengths and their spread;
  - word length;
  - punctuation, contractions, pronouns and figures, per thousand words;
  - rates for 88 common function words.

  It holds no sentences and no content words. `--voice <file>`, or `voice` in a profile, adds a voice match from 0 to 100 and a `voice-drift` finding naming the furthest features. It is a guide to drafting, not an authorship test.
- **Reading grade** (`reading-grade`). Flesch-Kincaid grade for prose of 60 words or more, against a target per context: copy, web and app 9, deck 10, doc 13. A profile can set its own targets with `readingGrade`. The legal, clinical, academic and fiction genres switch it off.
- **Spelling** (`spelling-variant`). A profile's `spelling` (`en-GB` or `en-US`) flags about 60 words with a clear British or American form. Quoted text is left alone.
- `examples/voice/` builds a voice for a made-up writer and checks one draft in that voice and one far from it.
- 186 rules.

## 2.3.0 (2026-11-24)

Checks that look past single words: how the ideas are arranged, claims with no source, repetition across a site, and text outside the page body.

- **Four new rules** (182 in all):
  - `recap-endings`: the last paragraph restates the first.
  - `signposted-structure`: an introduction that names the section headings, plus an ending that repeats the opening.
  - `unsourced-claims`: commercial superlatives, proof words ("proven to", "award-winning") and figures ("40% faster") with no citation, link or named source in that sentence or the next. Figures also pass in a document with a Sources or References section.
  - `repeated-across-files`: one sentence on three or more files in a run. Navigation, headers, footers and asides are left out.
- **Text outside the page body:**
  - HTML alt text, titles, ARIA labels and meta or Open Graph descriptions get the word-level prose checks.
  - `.svg` files are read for their visible text.
  - Words in JSX and TSX components are checked under the web rules.
- **`--stdin`** checks piped text, such as a commit message or a pull request description. `--kind html` and `--name` are optional.

## 2.2.0 (2026-11-24)

Fewer false alarms, rhetoric and rhythm rules, and ways to tune the checker without forking it.

- **Skipped text.** Prose checks ignore quoted text (double quotes, curly quotes, and single quotes used as quote marks), code blocks and inline code, blockquotes and links. Regions marked `<!-- slop-guard: off -->` … `<!-- slop-guard: on -->` and files marked `<!-- slop-guard: ignore-file -->` are skipped. `RULES.md` carries that mark, so the catalogue no longer flags itself.
- **Literal-sense guards.** Literal uses pass: "elevated blood pressure", "seamless steel tubes", an engine's flywheel, a chemical substrate, financial leverage, "the company name on the invoice", a sample company marked as a pseudonym, and "studies show" or a customer count with a citation in the same sentence.
- **Nine new rules** (178 in all):
  - `not-slogans`: three or more sentences ending on ", not …".
  - `colon-reveals`: "Here's the thing:", "The truth is:".
  - `hook-formulas`: "Ever wondered…", "Picture this", "Unpopular opinion:".
  - `self-answered-questions`: "The result? A faster team."
  - `punch-paragraphs`: many one-line paragraphs of a few words.
  - `repeated-phrases`: one four-word phrase used four or more times.
  - `uniform-rhythm`: sentences or paragraphs of one length.
  - `rule-of-three`: lists of exactly three, again and again.
  - `profile-words`: a profile's own banned words.
- **Hard and soft.** Every rule now has a `kind`. Hard rules (every high rule, plus cutoff disclaimers, dead controls, debug output and TODO residue) are wrong in any voice. Soft rules are style defaults. New flag `--fail-on hard|high|medium|low`. `--strict` is unchanged: it still fails on any high finding.
- **Genres.** `--genre social|email|docs|legal|clinical|academic|fiction|speech` switches off or lowers soft rules that do not fit that kind of writing. `--genres` lists them.
- **Profiles.** `--profile file.json` (or the `SLOP_GUARD_PROFILE` environment variable) loads an optional profile that can switch rules off, change severities, allow words and ban others. It cannot touch hard rules unless it sets `allowHardOff`. Unknown keys, rule ids and genres stop the run with a clear message. There are four generic examples in `profiles/`.
- **Trend score.** Every file with 150 or more words of prose gets a score from 0 to 100, weighted by severity and length. `--history scores.jsonl` records each run and shows the change since the last one. The JSON report includes the scores, and its `counts` now include `hard`.
- **False-alarm set.** Eight public-domain texts in `tests/fixtures/public-domain/` must raise nothing at medium or above in either `doc` or `copy`.
- The summary line adds the hard count and any genre or profile in use. Each hard finding is tagged `[hard]`.

## 2.1.0 (2026-11-19)

- New `code` context for JavaScript, TypeScript and Python: 17 rules.
- Interface rules: touch targets, labels, field types, zoom, navigation, charts, layout shift, hover-only actions and more.
- Curly quotes in visible text.
- 169 rules in all.

## 2.0.0 (2026-11-18)

- One combined rule set: 119 rules across six contexts.
- A checker with no dependencies.
- Examples and diagrams.
- CI on Node 20, 22 and 24.
