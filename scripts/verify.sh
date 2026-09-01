#!/usr/bin/env bash
#
# The gate, as a script rather than a chain of `&&` in package.json.
#
# `set -o pipefail` is the whole reason this file exists. A `&&` chain is
# already fail-fast, so the old form was correct — but a *pipe* anywhere in it,
# now or later, would report the exit status of the last command in the pipe
# and nothing else. That is this project's most-repeated defect wearing its
# plumbing costume: `pnpm test | grep`, `prettier --write 2>/dev/null`,
# `pnpm verify | tail -5 && git commit`. The last of those put a red commit in
# this repository's history at 21:46 tonight.
#
# The habit failed three times in one weekend, so it stops being a habit.
# Anything piped inside this file now fails the gate rather than hiding in it.
#
# `-u` catches an unset variable rather than expanding it to nothing, which is
# how a path becomes `/` in a script that deletes things. `-e` is belt for the
# `&&` braces.
set -euo pipefail

pnpm run format:check
pnpm run build
pnpm run smoke
pnpm run check:site
pnpm run lint
pnpm run typecheck
pnpm run test:coverage
pnpm run knip
node scripts/record-verified.mjs
