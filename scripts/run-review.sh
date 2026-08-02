#!/usr/bin/env bash
# Run the same agentic review CI runs, locally, before opening a PR.
#
#   ./scripts/run-review.sh                 # vs the default branch
#   ./scripts/run-review.sh --base main
#   ./scripts/run-review.sh --staged        # only what's staged
#   ./scripts/run-review.sh --model openrouter/anthropic/claude-sonnet-5
#
# Identical prompt, tools and skill injection to .github/workflows/
# agentic-review.yml — both read review/prompt.md, so local results and CI
# results cannot drift.
#
# Needs: OPENROUTER_API_KEY in the environment. Read-only: no writes, no shell,
# no network beyond the model call.

set -euo pipefail

BASE=""; MODEL="openrouter/openai/gpt-5.6-luna"; STAGED=0; OUT=""
SKILL_DEFAULT="skills/infra-review/SKILL.md"; SKILL=""

while [ $# -gt 0 ]; do
  case "$1" in
    --base)   BASE="${2:-}"; shift 2 ;;
    --model)  MODEL="${2:-}"; shift 2 ;;
    --skill)  SKILL="${2:-}"; shift 2 ;;
    --out)    OUT="${2:-}"; shift 2 ;;
    --staged) STAGED=1; shift ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

_c() { [ -t 1 ] && printf '\033[%sm' "$1" || true; }
say()  { _c "0;36"; printf '  %s\n' "$*"; _c "0"; }
ok()   { _c "0;32"; printf '  ✓ %s\n' "$*"; _c "0"; }
die()  { _c "0;31"; printf '  ✗ %s\n' "$*" >&2; _c "0"; exit 1; }
step() { printf '\n'; _c "1;37"; printf '▸ %s\n' "$*"; _c "0"; }

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not in a git repository"
cd "$REPO_ROOT"

step "Checking prerequisites"
[ -n "${OPENROUTER_API_KEY:-}" ] || die "OPENROUTER_API_KEY is not set"
if command -v omp >/dev/null 2>&1; then
  OMP=(omp); ok "omp $(omp --version 2>/dev/null | head -1)"
elif command -v bunx >/dev/null 2>&1; then
  OMP=(bunx --bun @oh-my-pi/pi-coding-agent@latest); ok "using bunx (omp not installed)"
elif command -v npx >/dev/null 2>&1; then
  OMP=(npx -y @oh-my-pi/pi-coding-agent@latest); ok "using npx (omp not installed)"
else
  die "need omp, bun or npm — https://omp.sh/install"
fi

step "Working out what changed"
if [ "$STAGED" = 1 ]; then
  RANGE="--staged"
  git diff --cached --quiet && die "nothing staged"
  DIFFSTAT="$(git diff --cached --stat)"
  DIFFCMD="git diff --cached"
else
  if [ -z "$BASE" ]; then
    # origin/HEAD is the reliable default-branch pointer; fall back sensibly.
    BASE="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
    [ -n "$BASE" ] || for c in origin/main origin/master main master; do
      git rev-parse --verify --quiet "$c" >/dev/null && { BASE="$c"; break; }
    done
    [ -n "$BASE" ] || die "could not determine a base branch — pass --base"
  fi
  git rev-parse --verify --quiet "$BASE" >/dev/null || die "unknown base ref: $BASE"
  MERGE_BASE="$(git merge-base HEAD "$BASE")"
  # Two-dot from the merge base = only this branch's work, excluding changes
  # that landed on the base since. Same range CI reviews.
  git diff --quiet "$MERGE_BASE" HEAD && die "no changes vs $BASE"
  DIFFSTAT="$(git diff --stat "$MERGE_BASE" HEAD)"
  DIFFCMD="git diff $MERGE_BASE HEAD"
  RANGE="$BASE"
fi
ok "reviewing against $RANGE"
printf '%s\n' "$DIFFSTAT" | sed 's/^/    /'

step "Building prompt"
PROMPT_FILE="review/prompt.md"
[ -f "$PROMPT_FILE" ] || die "missing $PROMPT_FILE — run from a repo that has it, or copy it in"
TMP_PROMPT="$(mktemp)"
{
  echo "Changed files:"
  printf '%s\n' "$DIFFSTAT"
  echo
  echo "The diff is: $DIFFCMD"
  echo
  cat "$PROMPT_FILE"
} > "$TMP_PROMPT"
ok "$(wc -c < "$TMP_PROMPT" | tr -d ' ') bytes"

APPEND=()
[ -n "$SKILL" ] || { [ -f "$SKILL_DEFAULT" ] && SKILL="$SKILL_DEFAULT"; }
if [ -n "$SKILL" ] && [ -f "$SKILL" ]; then
  APPEND=(--append-system-prompt="$SKILL"); ok "knowledge base: $SKILL"
else
  say "no skill file — running without injected knowledge"
fi

step "Reviewing with $MODEL"
say "read-only tools: read, grep, glob, lsp, ast_grep"
TMP_OUT="$(mktemp)"
# Same allowlist as CI. omp validates these names, so a typo fails loudly.
if ! "${OMP[@]}" -p \
      --model="$MODEL" \
      --tools=read,grep,glob,lsp,ast_grep \
      --no-session \
      "${APPEND[@]}" \
      --cwd="$REPO_ROOT" \
      < "$TMP_PROMPT" > "$TMP_OUT" 2>"$TMP_OUT.err"; then
  printf '\n'; sed 's/^/    /' "$TMP_OUT.err" | tail -20
  rm -f "$TMP_PROMPT" "$TMP_OUT" "$TMP_OUT.err"
  die "review failed"
fi

# Read the verdict BEFORE cleanup: $OUT is empty when printing to stdout and
# the temp file is gone by then, so a check placed afterwards can never fire.
# (`if` rather than `grep … && CLEAN=1` purely for clarity — a failing
# non-final command in a && list is exempt from set -e, so both are correct.)
CLEAN=0
if grep -qx "No findings." "$TMP_OUT"; then CLEAN=1; fi

printf '\n'
if [ -n "$OUT" ]; then
  cp "$TMP_OUT" "$OUT"; ok "written to $OUT"
else
  cat "$TMP_OUT"
fi
rm -f "$TMP_PROMPT" "$TMP_OUT" "$TMP_OUT.err"

printf '\n'
if [ "$CLEAN" = 1 ]; then
  ok "no findings"
else
  # Non-zero exit so this is usable as a pre-push hook or in a pipeline.
  _c "0;33"; printf '  ! findings above — review before pushing\n'; _c "0"
  exit 1
fi
