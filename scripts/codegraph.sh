#!/usr/bin/env bash
# Emit a symbol and dependency index for the files a branch changes, using
# codegraph (https://github.com/colbymchenry/codegraph), as markdown on stdout.
#
# WHY THIS AND NOT A HOME-GROWN INDEX. codegraph parses with tree-sitter across
# 30+ languages and, critically, never executes the project's build system —
# which is the property that rules out every SCIP-class indexer for a reviewer
# pointed at attacker-authored pull requests. Its CLI mirrors the MCP tools
# one-for-one (`node` is documented as the same output as `codegraph_node`), so
# invoking it ourselves costs only on-demand iteration, not fidelity.
#
# WHAT THE AGENT GETS. Per changed file: every symbol it defines with a line
# number, and which other indexed files depend on it. That is the cross-file
# context a diff cannot show — the blast radius of a changed method, and
# whether anything at all uses what was touched.
#
# Env:
#   BASE_SHA, HEAD_SHA   diff range              (required unless STAGED=1)
#   STAGED=1             use staged changes
#   PROJECT              project root            (default: cwd)
#   MAX_FILES            files to describe       (default 40)
#   MAX_BYTES            output cap              (default 24000)
#
# Exits 0 and prints nothing when codegraph is unavailable or the project is
# not indexed. A missing index degrades the review; it must not fail it.

set -euo pipefail

PROJECT="${PROJECT:-$PWD}"
MAX_FILES="${MAX_FILES:-40}"
MAX_BYTES="${MAX_BYTES:-24000}"

command -v codegraph >/dev/null 2>&1 || exit 0
[ -d "$PROJECT/.codegraph" ] || exit 0

# A file list rather than an array. `mapfile` is bash 4+, and on bash 3.2 —
# which is what macOS ships — expanding an EMPTY array under `set -u` is an
# unbound-variable error, so the no-changes path would abort instead of exiting
# quietly. A temp file sidesteps both.
list="$(mktemp)"
out="$(mktemp)"
trap 'rm -f "$list" "$out"' EXIT

if [ "${STAGED:-}" = "1" ]; then
  git diff --no-ext-diff --no-textconv --cached --name-only --diff-filter=d > "$list"
else
  git diff --no-ext-diff --no-textconv --name-only --diff-filter=d "$BASE_SHA" "$HEAD_SHA" > "$list"
fi
total="$(grep -c . "$list" || true)"
[ "${total:-0}" -gt 0 ] || exit 0

{
  echo "## Symbol and dependency index"
  echo
  echo "For each changed file: the symbols it defines, and which other files in"
  echo "the repository depend on it. Built with codegraph (tree-sitter). Use it to"
  echo "see the blast radius of a change and to spot a symbol nothing uses."
  echo
} > "$out"

described=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ "$described" -lt "$MAX_FILES" ] || break
  # Files codegraph did not index (docs, config, unknown extensions) return
  # nothing useful; skip them rather than printing an empty section per file.
  body="$(codegraph node --path "$PROJECT" --file "$f" --symbols-only 2>/dev/null || true)"
  # The real message is "_No indexed symbols in this file._" — the earlier
  # pattern matched "No symbols" and never fired, so every unindexed file
  # contributed a heading plus a line saying it had nothing. On a repo codegraph
  # does not parse (YAML, shell, HCL) that is the WHOLE index: pure prompt noise
  # in the place where the useful content was supposed to go.
  case "$body" in
    ""|*"not found"*|*"No indexed symbols"*|*"No symbols"*) continue ;;
  esac
  # The trailing hint is addressed to an interactive agent that can call the
  # tool again; here it is noise.
  # shellcheck disable=SC2016  # a literal pattern, not an expansion
  printf '%s\n\n' "$(printf '%s\n' "$body" | grep -v '^> Drop `symbolsOnly`')" >> "$out"
  described=$((described + 1))
done < "$list"

[ "$described" -gt 0 ] || exit 0

if [ "$total" -gt "$described" ]; then
  printf '_%d of %d changed files are indexed; the rest are not source codegraph parses._\n' \
    "$described" "$total" >> "$out"
fi

if [ "$(wc -c < "$out")" -gt "$MAX_BYTES" ]; then
  head -c "$MAX_BYTES" "$out"
  printf '\n\n_(index truncated)_\n'
else
  cat "$out"
fi
