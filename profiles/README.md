# Profiles

A profile is an optional JSON file you pass with `--profile <file>` (or the `SLOP_GUARD_PROFILE` environment variable). Without one, slop-guard uses the neutral defaults in `rules.json`. Profiles let a team, a brand or a writer tune the checker without forking it. The files here are examples: copy one and edit it.

| Key | What it does |
|---|---|
| `name`, `description` | Shown in the output and the JSON report. |
| `genre` | One of the genres in `rules.json` (`--genres` lists them): its allowances switch some soft rules off or lower them. `--genre` on the command line wins. |
| `off` | Rule ids to switch off. Hard rules stay on unless `allowHardOff` is `true`, and the output then says so. |
| `severity` | `{ "rule-id": "high" | "medium" | "low" }` to raise or lower a rule. Same limit on hard rules. |
| `allow` | Words or phrases that are fine for you (a product name that looks like a hype word, a client pseudonym). A finding whose evidence is one of them is dropped. |
| `ban` | Extra words or phrases to flag, as strings or `{ "phrase", "instead", "message", "severity" }`. They report under the `profile-words` rule. |
| `mask` | `{ "quotes", "code", "blockquotes", "urls" }`, each `true` by default: what is left out of the prose checks. `false` checks everything. |
| `minScoreWords` | Texts shorter than this get no trend score (default 150). |
| `spelling` | `"en-GB"` or `"en-US"`: flags words spelled the other way (from v2.4). |
| `readingGrade` | `{ "copy": 8, "doc": 12 }`: the reading grade each context should stay under (from v2.4). |
| `voice` | Path to a voice file made with `--build-voice`, relative to the profile (from v2.4). Keep personal voice files and samples out of public repos. |

Unknown keys, unknown rule ids and unknown genres stop the run with a message that names them, so a typo never silently switches nothing off.

## Hard and soft

Every rule is **hard** or **soft** (`kind` in `rules.json`). Hard rules are wrong in any voice: placeholder text, made-up proof, unreadable type, a control with no name. Soft rules are style defaults that a profile, a genre or a writer's own voice may override. `--fail-on hard` fails a run only on hard findings; `--strict` still fails on any high finding.

## Personal profiles stay private

A profile built for one person (their banned words, their voice file, their samples) belongs in their own private files, not in this repo or any shared copy of it. The examples here are deliberately generic.
