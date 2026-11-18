#!/bin/sh
# Re-run the checker on every example and save its text and JSON output next to the file.
# Run from the repo root: sh examples/run-checks.sh
set -e
cd "$(dirname "$0")"
run() { # folder file context [pairing]
  ( cd "$1"
    extra=""; [ -n "$4" ] && extra="--pairing $4"
    node ../../check-slop.mjs "$2" --context "$3" --year 2026 --json "${2%.*}.json" $extra > "${2%.*}.txt" )
}
run landing sloppy.html web
run landing clean.html web type-pairing.md
run dashboard sloppy.html app
run dashboard clean.html app type-pairing.md
run writing sloppy.md copy
run writing clean.md copy
