#!/usr/bin/env bash
# Run the same agentic review CI runs, locally, before opening a PR.
#
#   ./scripts/run-review.sh                          # vs the default branch
#   ./scripts/run-review.sh --base main
#   ./scripts/run-review.sh --staged                 # only what's staged
#   ./scripts/run-review.sh --model openrouter/anthropic/claude-sonnet-5
#   ./scripts/run-review.sh --thinking high --max-time 10m
#   ./scripts/run-review.sh --review-mode suggest   # show proposed fixes
#   ./scripts/run-review.sh --json | jq '.findings[] | .file'
#   ./scripts/run-review.sh -- --print-thoughts     # safe display-only omp flag
#
# Options (every one has an AGENTIC_REVIEW_* env default, so you can set them
# once in your shell profile instead of typing them):
#
#   --base REF          base to diff against          $AGENTIC_REVIEW_BASE
#   --staged            review staged changes instead
#   --model SLUG        provider-prefixed model       $AGENTIC_REVIEW_MODEL
#   --thinking LEVEL    off|minimal|low|medium|high|xhigh|max|auto
#                                                     $AGENTIC_REVIEW_THINKING
#   --tools LIST        comma-separated omp tools     $AGENTIC_REVIEW_TOOLS
#   --max-time DUR      hard cap, e.g. 600, 10m, 1h   $AGENTIC_REVIEW_MAX_TIME
#   --prompt FILE       review instructions           $AGENTIC_REVIEW_PROMPT
#   --skill FILE        appended to the system prompt $AGENTIC_REVIEW_SKILL
#   --max-findings N    0 disables the cap            $AGENTIC_REVIEW_MAX_FINDINGS
#   --passes N          repeat the review N times and merge   $AGENTIC_REVIEW_PASSES
#   --lenses a,b,c      one pass per concern, e.g. security,correctness,docs
#                                                     $AGENTIC_REVIEW_LENSES
#   --min-votes N       experimental threshold; always inconclusive, preserves unsafe drops
#   --review-mode M     summary|inline|suggest        $AGENTIC_REVIEW_MODE
#                       suggest prints the fixes it would offer on a PR
#   --omp-version V     npm version or dist-tag       $AGENTIC_REVIEW_OMP_VERSION
#   --out FILE          write the review here
#   --metadata-out FILE write bounded-run metadata here $AGENTIC_REVIEW_METADATA_OUT
#   --no-state          do not update local review history
#   --open              list findings still open from previous runs
#   --all               list every tracked finding, including dismissed
#   --history           list past runs
#   --dismiss ID...     stop reporting these findings
#   --trust-repo        only used if a worktree cannot be created: proceed
#                       despite agent config in your own checkout
#   --no-codegraph      skip the symbol index (for A/B measurement)
#   --json              raw findings JSON on stdout, for piping
#   --no-fail           exit 0 even when findings are reported
#   -- ARGS...          display-only omp flags: --print-thoughts,
#                       --hide-thinking, --no-title
#
# Uses the same trusted prompt, tools, skill injection, and execution owner as
# .github/workflows/agentic-review.yml. Local-only state and ensemble overrides
# are listed above; hosted-only presentation controls remain workflow inputs.
#
# Needs: OPENROUTER_API_KEY in the environment (or OPENROUTER_API_KEY_FILE
# pointing at a file holding it), and bun (omp is bun-only).
# Read-only: no writes, no shell, no network beyond the model call.

set -euo pipefail

# omp's full read-only tool set. --tools is checked against this before we
# invoke anything, so a slip here fails with a readable message rather than
# handing an agent that reads attacker-authored diffs a shell.
#
# `lsp` is absent deliberately. omp discovers language-server config from the
# PROJECT directory (lsp.json, .lsp.json, lsp.yaml...), so a repository can
# name an arbitrary command there; lsp is read-tier, so the approval mode
# auto-approves it and omp spawns that command. That is arbitrary execution
# via the one tool included for reading code.
READ_ONLY_TOOLS="read grep glob"

# omp ships `#!/usr/bin/env bun`, imports `bun:` builtins, and declares
# engines.bun >= 1.3.14. It cannot run under node at all, and an older bun
# fails with a minified SyntaxError, so both are checked explicitly below.
BUN_MIN="1.3.14"

BASE="${AGENTIC_REVIEW_BASE:-}"
MODEL="${AGENTIC_REVIEW_MODEL:-openrouter/openai/gpt-5.6-luna}"
# Default high. At the model's default the agent made 3 turns and 2 tool calls
# on a 43-file diff — it read the diff and answered, which is the single-shot
# behaviour this project exists to beat. At `high` the same input produced 11
# turns and 25 tool calls, and measured recall went 5/11 to 8/11. Roughly 5x
# the wall clock and 4x the cost of a pass, and worth both.
THINKING="${AGENTIC_REVIEW_THINKING:-high}"
TOOLS="${AGENTIC_REVIEW_TOOLS:-read,grep,glob}"
MAX_TIME="${AGENTIC_REVIEW_MAX_TIME:-}"
PROMPT_FILE="${AGENTIC_REVIEW_PROMPT:-review/prompt.md}"
SKILL="${AGENTIC_REVIEW_SKILL:-}"
SKILL_DEFAULT="skills/infra-review/SKILL.md,skills/security-review/SKILL.md"
MAX_FINDINGS="${AGENTIC_REVIEW_MAX_FINDINGS:-20}"
# suggest by default. summary was the old default and it quietly disabled two
# advertised features: local state cannot track markdown, so `--open` and
# `--dismiss` had nothing to work with, and the proposed fixes were never shown.
# There is no pull request locally, so suggest simply renders the fixes to the
# terminal, which is strictly more useful than prose.
REVIEW_MODE="${AGENTIC_REVIEW_MODE:-suggest}"
OMP_VERSION="${AGENTIC_REVIEW_OMP_VERSION:-latest}"
MAX_DIFF_BYTES="${AGENTIC_REVIEW_MAX_DIFF_BYTES:-400000}"
PASSES="${AGENTIC_REVIEW_PASSES:-1}"
# The bounded default is one general review plus two additive specialist passes.
LENSES="${AGENTIC_REVIEW_LENSES:-correctness,boundaries}"
MIN_VOTES="${AGENTIC_REVIEW_MIN_VOTES:-1}"
METADATA_OUT="${AGENTIC_REVIEW_METADATA_OUT:-}"
TRUSTED_DATA_ROOT="${AGENTIC_REVIEW_TRUSTED_DATA_ROOT:-}"
STAGED=0; OUT=""; FAIL_ON_FINDINGS=1; AS_JSON=0; USE_CODEGRAPH=1; VIEW=""; TRUST_REPO="${TRUST_REPO:-0}"; RECORD_STATE=1
PASSTHRU=()

while [ $# -gt 0 ]; do
  case "$1" in
    --base)         BASE="${2:-}"; shift 2 ;;
    --model)        MODEL="${2:-}"; shift 2 ;;
    --thinking)     THINKING="${2:-}"; shift 2 ;;
    --tools)        TOOLS="${2:-}"; shift 2 ;;
    --max-time)     MAX_TIME="${2:-}"; shift 2 ;;
    --prompt)       PROMPT_FILE="${2:-}"; shift 2 ;;
    --skill)        SKILL="${2:-}"; shift 2 ;;
    --max-findings) MAX_FINDINGS="${2:-}"; shift 2 ;;
    --review-mode)  REVIEW_MODE="${2:-}"; shift 2 ;;
    --passes)       PASSES="${2:-}"; shift 2 ;;
    --lenses)       LENSES="${2:-}"; shift 2 ;;
    --min-votes)    MIN_VOTES="${2:-}"; shift 2 ;;
    --omp-version)  OMP_VERSION="${2:-}"; shift 2 ;;
    --out)          OUT="${2:-}"; shift 2 ;;
    --metadata-out) METADATA_OUT="${2:-}"; shift 2 ;;
    --staged)       STAGED=1; shift ;;
    --no-fail)      FAIL_ON_FINDINGS=0; shift ;;
    --no-codegraph) USE_CODEGRAPH=0; shift ;;
    --trust-repo)   TRUST_REPO=1; shift ;;
    --no-state)     RECORD_STATE=0; shift ;;
    --open)         VIEW=open; shift ;;
    --history)      VIEW=runs; shift ;;
    --all)          VIEW=all; shift ;;
    --dismiss)      VIEW=dismiss; shift; DISMISS_IDS="$*"; break ;;
    --json)         AS_JSON=1; shift ;;
    --)             shift; PASSTHRU=("$@"); break ;;
    # Print the header comment, stopping at the first line that isn't one.
    # A line range would silently start leaking code every time the header grows.
    -h|--help)      awk 'NR>1 && !/^#/{exit} NR>1{sub(/^# ?/,""); print}' "$0"; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

case "$PASSES" in
  ''|*[!0-9]*|0) printf '%s\n' "--passes must be a positive integer (got '$PASSES')" >&2; exit 2 ;;
esac
case "$MAX_FINDINGS" in
  ''|*[!0-9]*) printf '%s\n' "--max-findings must be a non-negative integer (got '$MAX_FINDINGS')" >&2; exit 2 ;;
esac
case "$MAX_DIFF_BYTES" in
  ''|*[!0-9]*) printf '%s\n' "AGENTIC_REVIEW_MAX_DIFF_BYTES must be a non-negative integer (got '$MAX_DIFF_BYTES')" >&2; exit 2 ;;
esac
case "$MIN_VOTES" in
  ''|*[!0-9]*|0) printf '%s\n' "--min-votes must be a positive integer (got '$MIN_VOTES')" >&2; exit 2 ;;
esac

# All progress goes to stderr, so stdout carries nothing but the review. That
# is what makes `--json | jq` and `--review-mode suggest > out.md` work.
_c() { if [ -t 2 ]; then printf '\033[%sm' "$1" >&2; fi; }
say()  { _c "0;36"; printf '  %s\n' "$*" >&2; _c "0"; }
ok()   { _c "0;32"; printf '  ✓ %s\n' "$*" >&2; _c "0"; }
die()  { _c "0;31"; printf '  ✗ %s\n' "$*" >&2; _c "0"; exit 1; }
step() { printf '\n' >&2; _c "1;37"; printf '▸ %s\n' "$*" >&2; _c "0"; }

# Where this script lives, with symlinks resolved — so `ln -s .../run-review.sh
# ~/bin/review` still finds review/prompt.md. Support files were previously
# looked up relative to the CURRENT directory, which meant the local runner only
# worked inside this repository: the one place you least need it.
_self="${BASH_SOURCE[0]}"
while [ -L "$_self" ]; do
  _dir="$(cd -P "$(dirname "$_self")" && pwd)"
  _self="$(readlink "$_self")"
  case "$_self" in /*) ;; *) _self="$_dir/$_self" ;; esac
done
SELF_ROOT="$(cd -P "$(dirname "$_self")/.." && pwd)"

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not in a git repository"
cd "$REPO_ROOT"

# Data and executable support have opposite trust requirements. Executable
# helpers always come from SELF_ROOT. Data keeps the local repository-first
# behavior unless a hosted caller supplies a trusted root.
canonical_file() {
  local path="$1" target dir
  [ -f "$path" ] || return 1
  while [ -L "$path" ]; do
    dir="$(cd -P "$(dirname "$path")" && pwd)" || return 1
    target="$(readlink "$path")" || return 1
    case "$target" in /*) path="$target" ;; *) path="$dir/$target" ;; esac
  done
  dir="$(cd -P "$(dirname "$path")" && pwd)" || return 1
  printf '%s/%s' "$dir" "$(basename "$path")"
}

if [ -n "$TRUSTED_DATA_ROOT" ]; then
  [ -d "$TRUSTED_DATA_ROOT" ] || die "trusted data root is not a directory: $TRUSTED_DATA_ROOT"
  TRUSTED_DATA_ROOT="$(cd -P "$TRUSTED_DATA_ROOT" && pwd)"
fi

support() {
  local requested="$1" resolved
  case "$requested" in
    /*) canonical_file "$requested"; return $? ;;
  esac
  if [ -n "$TRUSTED_DATA_ROOT" ]; then
    resolved="$(canonical_file "$TRUSTED_DATA_ROOT/$requested")" || return 1
    case "$resolved" in "$TRUSTED_DATA_ROOT"/*) printf '%s' "$resolved" ;; *) return 1 ;; esac
    return
  fi
  if [ -f "$requested" ]; then printf '%s' "$requested"; return 0; fi
  if [ -f "$SELF_ROOT/$requested" ]; then printf '%s' "$SELF_ROOT/$requested"; return 0; fi
  return 1
}
support_exec() {
  if [ -f "$SELF_ROOT/$1" ]; then printf '%s' "$SELF_ROOT/$1"; return 0; fi
  return 1
}

# Viewing stored state needs no model and no key — answer and exit.
if [ -n "$VIEW" ]; then
  _self2="${BASH_SOURCE[0]}"
  while [ -L "$_self2" ]; do _d="$(cd -P "$(dirname "$_self2")" && pwd)"; _self2="$(readlink "$_self2")"; case "$_self2" in /*) ;; *) _self2="$_d/$_self2";; esac; done
  ST="$(cd -P "$(dirname "$_self2")" && pwd)/local-state.mjs"
  case "$VIEW" in
    dismiss) # shellcheck disable=SC2086
             node "$ST" dismiss ${DISMISS_IDS:-} ;;
    runs)    node "$ST" runs ;;
    *)       node "$ST" list "$VIEW" ;;
  esac
  exit $?
fi

# Validate package selection and pass-through tokens before prerequisite checks
# or package resolution. A second `--` would stop omp option parsing before the
# enforced tool/approval/cwd flags, while prompt, config, and session flags can
# inject instructions or code through paths outside the reviewed snapshot.
valid_omp_version() {
  [[ "$1" =~ ^[A-Za-z][A-Za-z0-9._-]*$ ]] \
    || [[ "$1" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?(\+[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]]
}
valid_omp_version "$OMP_VERSION" \
  || die "--omp-version must be a safe npm dist-tag or exact semver (got '$OMP_VERSION')"
for a in "${PASSTHRU[@]+"${PASSTHRU[@]}"}"; do
  case "$a" in
    --print-thoughts|--hide-thinking|--no-title) ;;
    *)
      die "$a cannot be passed after --; permitted display flags: --print-thoughts --hide-thinking --no-title" ;;
  esac
done

destination_identity() {
  local path="$1" target dir
  case "$path" in /*) ;; *) path="$REPO_ROOT/$path" ;; esac
  while [ -L "$path" ]; do
    dir="$(cd -P "$(dirname "$path")" && pwd)" \
      || die "output parent directory does not exist: $(dirname "$path")"
    target="$(readlink "$path")" || die "could not resolve output path: $path"
    case "$target" in /*) path="$target" ;; *) path="$dir/$target" ;; esac
  done
  dir="$(cd -P "$(dirname "$path")" && pwd)" \
    || die "output parent directory does not exist: $(dirname "$path")"
  printf '%s/%s' "$dir" "$(basename "$path")"
}

if [ -n "$OUT" ] && [ -L "$OUT" ]; then
  die "--out cannot be a symlink destination"
fi
if [ -n "$METADATA_OUT" ] && [ -L "$METADATA_OUT" ]; then
  die "--metadata-out cannot be a symlink destination"
fi

if [ -n "$OUT" ] && [ -n "$METADATA_OUT" ]; then
  OUT_IDENTITY="$(destination_identity "$OUT")"
  METADATA_IDENTITY="$(destination_identity "$METADATA_OUT")"
  if [ "$OUT_IDENTITY" = "$METADATA_IDENTITY" ]; then
    die "--out and --metadata-out resolve to the same destination"
  fi
fi

step "Checking prerequisites"

# A key passed inline lands in shell history and in anything capturing the
# terminal. OPENROUTER_API_KEY_FILE reads it from a file instead, the way Docker
# handles secrets.
if [ -z "${OPENROUTER_API_KEY:-}" ] && [ -n "${OPENROUTER_API_KEY_FILE:-}" ]; then
  [ -r "$OPENROUTER_API_KEY_FILE" ] || die "OPENROUTER_API_KEY_FILE is not readable: $OPENROUTER_API_KEY_FILE"
  OPENROUTER_API_KEY="$(tr -d '\r\n' < "$OPENROUTER_API_KEY_FILE")"
  export OPENROUTER_API_KEY
fi
[ -n "${OPENROUTER_API_KEY:-}" ] || die "OPENROUTER_API_KEY is not set (or point OPENROUTER_API_KEY_FILE at a file containing it)"

# Catch a pasted placeholder here rather than letting it become an invalid HTTP
# header three minutes into a run. An explicit allowed set, because the obvious
# alternatives do not work: [!\ -~] is ambiguous inside a bracket expression and
# matches plain ASCII, and [![:print:]] treats a UTF-8 ellipsis as printable, so
# both let "sk-or-…" straight through.
case "$OPENROUTER_API_KEY" in
  *[!A-Za-z0-9._-]*)
    die "OPENROUTER_API_KEY contains a character that cannot appear in a key — a placeholder such as 'sk-or-…' was probably pasted literally" ;;
esac
case "$OPENROUTER_API_KEY" in
  sk-or-*) ;;
  *) say "warning: the key does not start with 'sk-or-' — OpenRouter keys normally do" ;;
esac

bad=""
for t in ${TOOLS//,/ }; do
  case " $READ_ONLY_TOOLS " in
    *" $t "*) ;;
    *) bad="$bad $t" ;;
  esac
done
[ -z "$bad" ] || die "tools not permitted:$bad — this reviewer only runs read-only tools ($READ_ONLY_TOOLS)"


# Version-compare without sort -V, which is absent on some BSD/macOS setups.
#
# Splitting with IFS rather than a here-string on purpose: `read <<<` needs a
# temp file, and when that fails the arrays come back EMPTY, every component
# defaults to 0, the versions compare equal and the check passes. A version
# gate that fails open is worse than none — it reports success while letting a
# known-broken runtime through.
ver_ge() { # ver_ge A B  -> 0 when A >= B
  local i x y
  local -a a b
  local IFS=.
  # shellcheck disable=SC2206  # deliberate IFS split
  a=(${1%%-*})
  # shellcheck disable=SC2206
  b=(${2%%-*})
  unset IFS
  for i in 0 1 2; do
    x="${a[i]:-0}"; y="${b[i]:-0}"
    if [ "$x" -gt "$y" ] 2>/dev/null; then return 0; fi
    if [ "$x" -lt "$y" ] 2>/dev/null; then return 1; fi
  done
  return 0
}

# An installed omp is used only when no specific version was asked for —
# otherwise --omp-version / AGENTIC_REVIEW_OMP_VERSION would be silently
# ignored on every machine that happens to have omp on PATH, which is most of
# them, and a "pinned" review would not be pinned at all.
if [ "$OMP_VERSION" = "latest" ] && command -v omp >/dev/null 2>&1; then
  OMP=(omp); ok "omp $(omp --version 2>/dev/null | head -1)"
elif command -v bunx >/dev/null 2>&1; then
  bunv="$(bun --version 2>/dev/null || echo 0)"
  ver_ge "$bunv" "$BUN_MIN" \
    || die "bun $bunv is too old — omp needs >= $BUN_MIN (it crashes with a minified SyntaxError otherwise). Upgrade with: bun upgrade"
  OMP=(bunx --bun "@oh-my-pi/pi-coding-agent@${OMP_VERSION}"); ok "using bunx (bun $bunv)"
else
  # There is deliberately no npx fallback. omp's entrypoint is
  # `#!/usr/bin/env bun` and it imports `bun:` builtins, so node exits with
  # ERR_UNSUPPORTED_ESM_URL_SCHEME. Offering npx here would print a reassuring
  # "using npx" and then fail with an error that points nowhere near the cause.
  die "need bun >= $BUN_MIN — omp does not run under node. Install: curl -fsSL https://bun.sh/install | bash"
fi

# Reviewing a branch is not consenting to execute it.
#
# omp loads MCP server definitions from agent-configuration directories and
# spawns the commands they name at startup — before --tools and before
# --approval-mode apply — so the read-only allowlist is not the boundary it
# looks like. CI deletes that configuration. Locally we used to only *refuse*,
# because deleting a developer's own .claude/ is indefensible.
#
# That was true only because the review ran in the working tree, and it does not
# have to. Reviewing a throwaway worktree makes stripping free: your checkout is
# never touched, and the agent sees exactly the committed state the diff
# describes rather than the working tree's uncommitted drift — which is also
# more correct, since the diff it is given is committed-only.
#
# REVIEW_ROOT is what omp and optional symbol tools see. REPO_ROOT stays the
# real repository because git range resolution and local state belong to it.
REVIEW_ROOT="$REPO_ROOT"
WORKTREE=""
RUN_TMP=""
SNAPSHOT_IMMUTABLE=0
cleanup_worktree() {
  if [ -n "$WORKTREE" ]; then
    git worktree remove --force "$WORKTREE" 2>/dev/null || rm -rf -- "$WORKTREE"
    WORKTREE=""
  fi
  if [ -n "$RUN_TMP" ]; then rm -rf -- "$RUN_TMP"; RUN_TMP=""; fi
}
trap cleanup_worktree EXIT

step "Working out what changed"
if [ "$STAGED" = 1 ]; then
  # Capture the parent and index tree once, then represent that exact pair as a
  # dangling commit. Later restaging cannot change the review target.
  SOURCE_BASE_SHA="$(git rev-parse --verify 'HEAD^{commit}')"
  SOURCE_INDEX_TREE="$(git write-tree)"
  SOURCE_TARGET_SHA="$(git commit-tree "$SOURCE_INDEX_TREE" -p "$SOURCE_BASE_SHA" -m 'agentic-review: staged state')"
  RANGE="--staged"
  INTENT=""
else
  if [ -z "$BASE" ]; then
    BASE="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
    [ -n "$BASE" ] || for c in origin/main origin/master main master; do
      git rev-parse --verify --quiet "$c" >/dev/null && { BASE="$c"; break; }
    done
    [ -n "$BASE" ] || die "could not determine a base branch — pass --base"
  fi
  SOURCE_TARGET_SHA="$(git rev-parse --verify 'HEAD^{commit}')" \
    || die "could not resolve HEAD"
  SOURCE_BASE_TIP="$(git rev-parse --verify "$BASE^{commit}")" \
    || die "unknown base ref: $BASE"
  SOURCE_BASE_SHA="$(git merge-base "$SOURCE_TARGET_SHA" "$SOURCE_BASE_TIP")"
  INTENT="$(git log --reverse -n 40 --format='- %s' "$SOURCE_BASE_SHA..$SOURCE_TARGET_SHA")"
  RANGE="$BASE"
fi

git diff --quiet "$SOURCE_BASE_SHA" "$SOURCE_TARGET_SHA" \
  && die "$([ "$STAGED" = 1 ] && printf 'nothing staged' || printf 'no changes vs %s' "$BASE")"
DIFFSTAT="$(git diff --stat "$SOURCE_BASE_SHA" "$SOURCE_TARGET_SHA")"
DIFFTEXT="$(git diff --no-color "$SOURCE_BASE_SHA" "$SOURCE_TARGET_SHA")"
ok "reviewing against $RANGE"
printf '%s\n' "$DIFFSTAT" | sed 's/^/    /' >&2
SOURCE_CODEGRAPH_OPT_IN=0
if [ "$USE_CODEGRAPH" = 1 ] && [ -d "$REPO_ROOT/.codegraph" ]; then
  SOURCE_CODEGRAPH_OPT_IN=1
fi

# support_exec, not support: this deletes files, so it must come from the
# installed copy and never from the repository under review.
_strip=""
if _strip="$(support_exec scripts/strip-agent-config.sh)" && [ -n "$_strip" ]; then
  _wt="$(mktemp -d)"
  rm -rf -- "$_wt"
  if git worktree add --detach "$_wt" "$SOURCE_TARGET_SHA" >/dev/null 2>&1; then
    WORKTREE="$_wt"; REVIEW_ROOT="$_wt"; SNAPSHOT_IMMUTABLE=1
    _removed="$(bash "$_strip" --strip "$REVIEW_ROOT")"
    if [ -n "$_removed" ]; then ok "throwaway worktree — $_removed"; else ok "reviewing a throwaway worktree"; fi
  else
    rm -rf -- "$_wt"
  fi
fi

# Fallback only: a worktree could not be created, so the actual checkout cannot
# be stripped. Refuse executable agent configuration unless the owner opts in.
if [ -z "$WORKTREE" ]; then
  [ -n "$_strip" ] || die "scripts/strip-agent-config.sh is missing from $SELF_ROOT — refusing to run an unguarded review"
  _agent_cfg=""
  if _found="$(bash "$_strip" --check "$REPO_ROOT")"; then :; else _agent_cfg="$_found"; fi
  if [ -n "$_agent_cfg" ] && [ "${TRUST_REPO:-0}" != "1" ]; then
    _c "0;31"
    printf '  ✗ could not create a worktree, so this runs in your checkout, which contains\n' >&2
    printf '    agent configuration: %s\n' "$_agent_cfg" >&2
    printf '    omp loads it at startup and runs whatever command it names, before\n' >&2
    printf '    any tool restriction applies. If it is yours, re-run with --trust-repo.\n' >&2
    _c "0"
    exit 1
  fi
fi

# Emit the immutable diff with a pass-dependent file rotation. Paths stay
# NUL-delimited until each literal pathspec reaches git, so deletions, newlines,
# and pathspec metacharacters cannot disappear or select another file.
ordered_diff() {
  local pass="$1" rotation
  if [ "$pass" -le 1 ] || [ "$TRUNCATED" = 1 ] || [ "$CHANGED_PATH_COUNT" -le 1 ]; then
    printf '%s\n' "$DIFFTEXT"
    return 0
  fi
  rotation=$(( (pass - 1) % CHANGED_PATH_COUNT ))
  node -e '
    const fs = require("node:fs");
    const bytes = fs.readFileSync(process.argv[1]);
    const paths = [];
    let start = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] !== 0) continue;
      paths.push(bytes.subarray(start, index));
      start = index + 1;
    }
    const offset = Number(process.argv[2]);
    const rotated = [...paths.slice(offset), ...paths.slice(0, offset)];
    process.stdout.write(Buffer.concat(rotated.flatMap((path) => [path, Buffer.from([0])])));
  ' "$CHANGED_PATHS_FILE" "$rotation" \
  | while IFS= read -r -d '' path; do
      git --literal-pathspecs diff --no-color "$SOURCE_BASE_SHA" "$SOURCE_TARGET_SHA" -- "$path"
    done
}

step "Building prompt"
case "$REVIEW_MODE" in
  summary|inline|suggest) ;;
  *) die "--review-mode must be summary, inline or suggest (got '$REVIEW_MODE')" ;;
esac

_prompt_requested="$PROMPT_FILE"
PROMPT_FILE="$(support "$PROMPT_FILE")" \
  || die "no review instructions at $_prompt_requested"
FORMAT_FILE="$(support "review/format-json.md")" \
  || die "no output format at review/format-json.md"
RESULT_HELPER="$(support_exec scripts/review-result.mjs)" \
  || die "scripts/review-result.mjs is missing from $SELF_ROOT"
MERGE="$(support_exec scripts/merge-findings.mjs)" \
  || die "scripts/merge-findings.mjs is missing from $SELF_ROOT"
command -v node >/dev/null 2>&1 || die "node is required for structured review results"

RUN_TMP="$(mktemp -d)"
CODEGRAPH_READY=0
CG=""
CODEGRAPH_VERSION_FILE="$RUN_TMP/codegraph-version"
CODEGRAPH_CONTEXT_FILE="$RUN_TMP/codegraph-context"
: > "$CODEGRAPH_VERSION_FILE"
: > "$CODEGRAPH_CONTEXT_FILE"
if [ "$SOURCE_CODEGRAPH_OPT_IN" = 1 ] && [ "$SNAPSHOT_IMMUTABLE" = 1 ] \
   && command -v codegraph >/dev/null 2>&1 \
   && CG="$(support_exec scripts/codegraph.sh)"; then
  codegraph --version > "$RUN_TMP/codegraph-version.tmp" 2>/dev/null || :
  mv -f "$RUN_TMP/codegraph-version.tmp" "$CODEGRAPH_VERSION_FILE"
  # The live index only records local opt-in. Rebuild against the pinned tree so
  # stale symbols and concurrent checkout changes cannot enter any pass.
  _codegraph_prepared=1
  rm -rf -- "$REVIEW_ROOT/.codegraph" 2>/dev/null || _codegraph_prepared=0
  rm -rf -- "$REVIEW_ROOT/codegraph.json" 2>/dev/null || _codegraph_prepared=0
  if [ "$_codegraph_prepared" = 1 ] \
     && git cat-file -e "$SOURCE_BASE_SHA:codegraph.json" 2>/dev/null; then
    git show "$SOURCE_BASE_SHA:codegraph.json" > "$REVIEW_ROOT/codegraph.json" \
      || _codegraph_prepared=0
  fi
  if [ "$_codegraph_prepared" = 1 ] \
     && (cd "$REVIEW_ROOT" && CODEGRAPH_TELEMETRY=0 codegraph init . >/dev/null 2>&1) \
     && [ -d "$REVIEW_ROOT/.codegraph" ]; then
    CODEGRAPH_READY=1
  fi
  # The base config is trusted indexing input, not part of the reviewed target.
  # Remove it before restoring so a target symlink can never redirect the write.
  rm -rf -- "$REVIEW_ROOT/codegraph.json" \
    || die "could not restore codegraph.json in the review snapshot"
  if git cat-file -e "$SOURCE_TARGET_SHA:codegraph.json" 2>/dev/null; then
    git -C "$REVIEW_ROOT" restore --source="$SOURCE_TARGET_SHA" --worktree -- codegraph.json \
      || die "could not restore codegraph.json in the review snapshot"
  fi
  if [ "$CODEGRAPH_READY" = 1 ]; then
    if BASE_SHA="$SOURCE_BASE_SHA" HEAD_SHA="$SOURCE_TARGET_SHA" PROJECT="$REVIEW_ROOT" \
      bash "$CG" > "$RUN_TMP/codegraph-context.tmp" 2>/dev/null; then
      mv -f "$RUN_TMP/codegraph-context.tmp" "$CODEGRAPH_CONTEXT_FILE"
    else
      rm -f "$RUN_TMP/codegraph-context.tmp"
    fi
  fi
fi
CHANGED_PATHS_FILE="$RUN_TMP/changed-paths"
git diff --name-only -z "$SOURCE_BASE_SHA" "$SOURCE_TARGET_SHA" > "$CHANGED_PATHS_FILE"
CHANGED_PATH_COUNT="$(node -e '
  const fs = require("node:fs");
  const bytes = fs.readFileSync(process.argv[1]);
  let count = 0;
  for (const byte of bytes) if (byte === 0) count += 1;
  process.stdout.write(String(count));
' "$CHANGED_PATHS_FILE")"
printf '%s' "$DIFFTEXT" > "$RUN_TMP/diff.full"
DIFF_BYTES="$(wc -c < "$RUN_TMP/diff.full" | tr -d ' ')"
TRUNCATED=0
if [ "$MAX_DIFF_BYTES" != "0" ] && [ "$DIFF_BYTES" -gt "$MAX_DIFF_BYTES" ]; then
  node -e '
    const fs = require("node:fs");
    fs.writeFileSync(process.argv[2], fs.readFileSync(process.argv[1]).subarray(0, Number(process.argv[3])));
  ' "$RUN_TMP/diff.full" "$RUN_TMP/diff.included" "$MAX_DIFF_BYTES"
  DIFFTEXT="$(cat "$RUN_TMP/diff.included"; printf x)"
  DIFFTEXT="${DIFFTEXT%x}"
  TRUNCATED=1
fi
printf '%s' "$DIFFTEXT" > "$RUN_TMP/diff.included"
INCLUDED_DIFF_BYTES="$(wc -c < "$RUN_TMP/diff.included" | tr -d ' ')"

BASE_SHA="$SOURCE_BASE_SHA"
HEAD_SHA="$SOURCE_TARGET_SHA"

PASS_IDS=()
PASS_LENSES=()
PASS_LENS_FILES=()
unique_pass_id() {
  local base="$1" candidate="$1" suffix=2 existing
  while :; do
    existing=0
    for id in "${PASS_IDS[@]+"${PASS_IDS[@]}"}"; do
      if [ "$id" = "$candidate" ]; then existing=1; break; fi
    done
    if [ "$existing" = 0 ]; then UNIQUE_PASS_ID="$candidate"; return; fi
    candidate="${base}-${suffix}"
    suffix=$((suffix + 1))
  done
}
add_pass_descriptor() {
  local requested_id="$1" lens="$2" lens_file="${3:-}"
  unique_pass_id "$requested_id"
  PASS_IDS+=("$UNIQUE_PASS_ID")
  PASS_LENSES+=("$lens")
  PASS_LENS_FILES+=("$lens_file")
}

for ((i = 1; i <= PASSES; i++)); do
  if [ "$i" = 1 ]; then add_pass_descriptor general "" ""
  else add_pass_descriptor "general-$i" "" ""
  fi
done
IFS=',' read -ra _lenses <<< "$LENSES"
for lens in "${_lenses[@]}"; do
  lens="$(printf '%s' "$lens" | tr -d '[:space:]')"
  [ -n "$lens" ] || continue
  case "$lens" in *[!A-Za-z0-9._-]*) die "invalid lens name: $lens" ;; esac
  lens_file="$(support "review/lenses/$lens.md")" || die "no such lens: $lens"
  add_pass_descriptor "$lens" "$lens" "$lens_file"
done

lens_focus_file() {
  grep -v '^<!-- skills:' "$1"
}
lens_skills_file() {
  grep -oE '<!-- skills: [^>]*-->' "$1" | sed 's/<!-- skills: //; s/ *-->//' || :
}

prepare_skill() {
  local spec="$1" destination="$2" select="$3" sk resolved selected changed
  : > "$destination"
  spec="${spec// /,}"
  IFS=',' read -ra _skills <<< "$spec"
  for sk in "${_skills[@]}"; do
    sk="$(printf '%s' "$sk" | tr -d '[:space:]')"
    [ -n "$sk" ] || continue
    if resolved="$(support "$sk")"; then
      cat "$resolved" >> "$destination"
      printf '\n\n' >> "$destination"
    fi
  done
  if [ "$select" = 1 ] && [ -s "$destination" ] \
     && SEL="$(support_exec scripts/select-skills.mjs)"; then
    changed="$(git diff --name-only "$SOURCE_BASE_SHA" "$SOURCE_TARGET_SHA")"
    selected="${destination}.selected"
    if CHANGED_FILES="$changed" SKILL_FILES="$destination" node "$SEL" > "$selected" 2>"${destination}.log" \
       && [ -s "$selected" ]; then
      mv "$selected" "$destination"
      if [ -s "${destination}.log" ]; then sed 's/^/ /' "${destination}.log" >&2; fi
    else
      rm -f "$selected"
    fi
    rm -f "${destination}.log"
  fi
}

build_prompt() {
  local pass_index="$1" destination="$2" lens_file="$3"
  {
    cat "$PROMPT_FILE"
    echo
    if [ -n "$lens_file" ]; then echo; lens_focus_file "$lens_file"; echo; fi
    if [ -n "${INTENT:-}" ]; then
      echo "## What this change is meant to do"
      echo
      printf '%s\n' "$INTENT"
      echo
      echo "Check the change against this. An instruction or setting that cannot"
      echo "achieve what is stated here is a defect, even if the code is valid."
      echo
    fi
    cat "$FORMAT_FILE"
    echo
    echo "## Changed files"
    echo
    echo '```'
    printf '%s\n' "$DIFFSTAT"
    echo '```'
    echo
    echo "## The diff"
    echo
    if [ "$TRUNCATED" = 1 ]; then
      echo "NOTE: this diff was truncated at $MAX_DIFF_BYTES of $DIFF_BYTES bytes."
      echo "Files after the cut-off are missing. Say so if it limits the review."
      echo
    fi
    echo '```diff'
    ordered_diff "$pass_index"
    echo '```'
    echo
    echo "The working tree is checked out at the post-change state, so you can read any"
    echo "file as it will be after this branch lands. Use that to check what the diff depends on."
    if [ "$MAX_FINDINGS" != "0" ]; then
      echo
      echo "Report at most $MAX_FINDINGS findings. If you have more, keep the most severe."
    fi
    if [ "$CODEGRAPH_READY" = 1 ] && [ -s "$CODEGRAPH_CONTEXT_FILE" ]; then
      cat "$CODEGRAPH_CONTEXT_FILE"
    fi
    echo
    echo "Reply with the single JSON object described above and nothing else — no prose, no code fence."
  } > "$destination"
}

[ -n "$SKILL" ] || SKILL="$SKILL_DEFAULT"
for ((i = 0; i < ${#PASS_IDS[@]}; i++)); do
  prompt="$RUN_TMP/prompt.$i"
  skill="$RUN_TMP/skill.$i"
  lens_copy="$RUN_TMP/lens.$i"
  if [ -n "${PASS_LENS_FILES[i]}" ]; then
    cp "${PASS_LENS_FILES[i]}" "$lens_copy"
    lens_skill_spec="$(lens_skills_file "${PASS_LENS_FILES[i]}")"
    prepare_skill "$lens_skill_spec" "$skill" 0
  else
    : > "$lens_copy"
    prepare_skill "$SKILL" "$skill" 1
  fi
  build_prompt $((i + 1)) "$prompt" "${PASS_LENS_FILES[i]}"
done
ok "$(wc -c < "$RUN_TMP/prompt.0" | tr -d ' ') bytes (diff ${DIFF_BYTES}B, truncated=$TRUNCATED)"

printf '%s\n' "${PASS_IDS[@]}" > "$RUN_TMP/pass-ids"
printf '%s\n' "${PASS_LENSES[@]}" > "$RUN_TMP/pass-lenses"
CONFIG_FILE="$RUN_TMP/configuration.json"
MODEL="$MODEL" THINKING="$THINKING" TOOLS="$TOOLS" MAX_TIME="$MAX_TIME" \
OMP_VERSION="$OMP_VERSION" MAX_DIFF_BYTES="$MAX_DIFF_BYTES" MAX_FINDINGS="$MAX_FINDINGS" \
MIN_VOTES="$MIN_VOTES" USE_CODEGRAPH="$USE_CODEGRAPH" CODEGRAPH_READY="$CODEGRAPH_READY" \
PROMPT_FILE="$PROMPT_FILE" FORMAT_FILE="$FORMAT_FILE" node -e '
  const fs = require("node:fs");
  const output = process.argv[1];
  const root = process.argv[2];
  const lines = (name) => {
    const values = fs.readFileSync(`${root}/${name}`, "utf8").split("\n");
    if (values.at(-1) === "") values.pop();
    return values;
  };
  const ids = lines("pass-ids");
  const lenses = lines("pass-lenses");
  const pass_descriptors = ids.map((id, index) => ({
    id,
    lens: lenses[index] || null,
    lens_content: fs.readFileSync(`${root}/lens.${index}`, "utf8"),
    skill_content: fs.readFileSync(`${root}/skill.${index}`, "utf8"),
  }));
  const config = {
    model: process.env.MODEL,
    reasoning: process.env.THINKING,
    tools: process.env.TOOLS.split(",").map((value) => value.trim()).filter(Boolean),
    max_time: process.env.MAX_TIME,
    omp_version: process.env.OMP_VERSION,
    prompt_content: fs.readFileSync(process.env.PROMPT_FILE, "utf8"),
    format_content: fs.readFileSync(process.env.FORMAT_FILE, "utf8"),
    diff_cap: Number(process.env.MAX_DIFF_BYTES),
    finding_cap: Number(process.env.MAX_FINDINGS),
    min_votes: Number(process.env.MIN_VOTES),
    codegraph_enabled: process.env.USE_CODEGRAPH === "1",
    codegraph_ready: process.env.CODEGRAPH_READY === "1",
    codegraph_version: fs.readFileSync(`${root}/codegraph-version`, "utf8"),
    codegraph_context: fs.readFileSync(`${root}/codegraph-context`, "utf8"),
    pass_descriptors,
    extra_omp_args: process.argv.slice(3),
  };
  fs.writeFileSync(output, JSON.stringify(config));
' "$CONFIG_FILE" "$RUN_TMP" "${PASSTHRU[@]+"${PASSTHRU[@]}"}"
CONFIGURATION_FINGERPRINT="$(node "$RESULT_HELPER" fingerprint "$CONFIG_FILE")" \
  || die "could not fingerprint review configuration"

step "Reviewing with $MODEL"
say "read-only tools: $TOOLS${THINKING:+ | thinking: $THINKING} | passes: ${#PASS_IDS[@]}"

run_pass() {
  local prompt_file="$1" out_file="$2" skill_file="$3"
  local -a args=()
  if [ -s "$skill_file" ]; then args+=(--append-system-prompt="$skill_file"); fi
  if [ -n "$THINKING" ]; then args+=(--thinking="$THINKING"); fi
  if [ -n "$MAX_TIME" ]; then args+=(--max-time="$MAX_TIME"); fi
  if [ ${#PASSTHRU[@]} -gt 0 ]; then args+=("${PASSTHRU[@]}"); fi
  "${OMP[@]}" -p \
    --model="$MODEL" \
    --no-session \
    "${args[@]+"${args[@]}"}" \
    --tools="$TOOLS" \
    --approval-mode=always-ask \
    --cwd="$REVIEW_ROOT" \
    "@$prompt_file" \
    < /dev/null > "$out_file" 2>"$out_file.err"
}

run_pass_checked() {
  local prompt_file="$1" out_file="$2" skill_file="$3" attempt
  LAST_ATTEMPTS=0
  for attempt in 1 2; do
    LAST_ATTEMPTS="$attempt"
    if run_pass "$prompt_file" "$out_file" "$skill_file" && [ -s "$out_file" ] \
       && node "$MERGE" --check "$out_file" 2>/dev/null; then
      return 0
    fi
    say "output unparseable (attempt $attempt)"
  done
  return 1
}

PASS_STATUSES=()
PASS_ATTEMPTS=()
PASS_COUNTS=()
PASS_CAPPED=()
PASS_OUTS=()
VALID_OUTS=()
for ((i = 0; i < ${#PASS_IDS[@]}; i++)); do
  out="$RUN_TMP/out.$i"
  PASS_OUTS+=("$out")
  if run_pass_checked "$RUN_TMP/prompt.$i" "$out" "$RUN_TMP/skill.$i"; then
    count="$(node -e 'const fs=require("node:fs"); process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).findings.length))' "$out")"
    capped=false
    if [ "$MAX_FINDINGS" != "0" ] && [ "$count" -ge "$MAX_FINDINGS" ]; then capped=true; fi
    PASS_STATUSES+=("valid")
    PASS_ATTEMPTS+=("$LAST_ATTEMPTS")
    PASS_COUNTS+=("$count")
    PASS_CAPPED+=("$capped")
    VALID_OUTS+=("$out")
    say "pass ${PASS_IDS[i]} valid (${count} finding(s), attempt $LAST_ATTEMPTS)"
  else
    PASS_STATUSES+=("failed")
    PASS_ATTEMPTS+=("$LAST_ATTEMPTS")
    PASS_COUNTS+=("0")
    PASS_CAPPED+=("false")
    say "pass ${PASS_IDS[i]} failed after $LAST_ATTEMPTS attempts"
  fi
done

write_metadata() {
  local merge_succeeded="$1" records="$RUN_TMP/pass-records" raw="$RUN_TMP/metadata.raw.json"
  : > "$records"
  for ((j = 0; j < ${#PASS_IDS[@]}; j++)); do
    printf '%s\t%s\t%s\t%s\t%s\n' \
      "${PASS_IDS[j]}" "${PASS_STATUSES[j]}" "${PASS_ATTEMPTS[j]}" \
      "${PASS_COUNTS[j]}" "${PASS_CAPPED[j]}" >> "$records"
  done
  BASE_SHA="$BASE_SHA" HEAD_SHA="$HEAD_SHA" CONFIGURATION_FINGERPRINT="$CONFIGURATION_FINGERPRINT" \
  SNAPSHOT_IMMUTABLE="$SNAPSHOT_IMMUTABLE" DIFF_BYTES="$DIFF_BYTES" \
  INCLUDED_DIFF_BYTES="$INCLUDED_DIFF_BYTES" TRUNCATED="$TRUNCATED" \
  MAX_FINDINGS="$MAX_FINDINGS" MERGE_SUCCEEDED="$merge_succeeded" node -e '
    const fs = require("node:fs");
    const results = fs.readFileSync(process.argv[1], "utf8").trimEnd().split("\n").filter(Boolean)
      .map((line) => {
        const [id, status, attempts, finding_count, capped] = line.split("\t");
        return {
          id,
          status,
          attempts: Number(attempts),
          finding_count: Number(finding_count),
          capped: capped === "true",
          base_sha: process.env.BASE_SHA,
          head_sha: process.env.HEAD_SHA,
          configuration_fingerprint: process.env.CONFIGURATION_FINGERPRINT,
        };
      });
    const metadata = {
      schema_version: 1,
      base_sha: process.env.BASE_SHA,
      head_sha: process.env.HEAD_SHA,
      configuration_fingerprint: process.env.CONFIGURATION_FINGERPRINT,
      snapshot_immutable: process.env.SNAPSHOT_IMMUTABLE === "1",
      analysis_state: "inconclusive",
      diff: {
        bytes: Number(process.env.DIFF_BYTES),
        included_bytes: Number(process.env.INCLUDED_DIFF_BYTES),
        truncated: process.env.TRUNCATED === "1",
      },
      finding_cap: Number(process.env.MAX_FINDINGS),
      passes: {
        requested: results.map(({ id }) => id),
        completed: results.filter(({ status }) => status === "valid").map(({ id }) => id),
        results,
      },
    };
    if (process.env.MERGE_SUCCEEDED === "false") metadata.merge_succeeded = false;
    fs.writeFileSync(process.argv[2], JSON.stringify(metadata));
  ' "$records" "$raw"
  ANALYSIS_STATE="$(node "$RESULT_HELPER" analysis "$raw")" \
    || die "could not derive review analysis state"
  ANALYSIS_STATE="$ANALYSIS_STATE" node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    value.analysis_state = process.env.ANALYSIS_STATE;
    fs.writeFileSync(process.argv[2], JSON.stringify(value, null, 2));
  ' "$raw" "$RUN_TMP/metadata.json"
  node "$RESULT_HELPER" validate "$RUN_TMP/metadata.json" >/dev/null \
    || die "generated review metadata failed validation"
  if [ -n "$METADATA_OUT" ]; then
    metadata_tmp="${METADATA_OUT}.tmp.$$"
    cp "$RUN_TMP/metadata.json" "$metadata_tmp" || die "could not write metadata beside $METADATA_OUT"
    if ! node "$RESULT_HELPER" validate "$metadata_tmp" >/dev/null; then
      rm -f "$metadata_tmp"
      die "metadata at $metadata_tmp failed validation"
    fi
    mv -f "$metadata_tmp" "$METADATA_OUT"
    ok "metadata written to $METADATA_OUT"
  fi
}

if [ ${#VALID_OUTS[@]} -eq 0 ]; then
  write_metadata not-run
  die "every configured pass failed"
fi

TMP_OUT="$RUN_TMP/merged.json"
UNION_OUT="$RUN_TMP/union.json"
MERGE_SUCCEEDED=true
if ! node "$MERGE" --min-votes 1 "${VALID_OUTS[@]}" > "$UNION_OUT" \
   || ! node "$MERGE" --check "$UNION_OUT" 2>/dev/null; then
  MERGE_SUCCEEDED=false
  say "merge failed — preserving the first valid structured pass as inconclusive"
  cp "${VALID_OUTS[0]}" "$TMP_OUT"
elif [ "$MIN_VOTES" = 1 ]; then
  mv "$UNION_OUT" "$TMP_OUT"
else
  MERGE_SUCCEEDED=false
  if node "$MERGE" --min-votes "$MIN_VOTES" "${VALID_OUTS[@]}" > "$TMP_OUT" \
     && node "$MERGE" --check "$TMP_OUT" 2>/dev/null; then
    if ! cmp -s "$UNION_OUT" "$TMP_OUT"; then
      say "min-votes $MIN_VOTES would hide valid evidence — preserving the union"
      mv -f "$UNION_OUT" "$TMP_OUT"
    fi
  else
    say "min-votes $MIN_VOTES merge failed — preserving the union"
    mv -f "$UNION_OUT" "$TMP_OUT"
  fi
fi
node "$MERGE" --check "$TMP_OUT" 2>/dev/null \
  || die "review result is not a structured findings document"

if [ -n "$OUT" ]; then
  out_tmp="${OUT}.tmp.$$"
  cp "$TMP_OUT" "$out_tmp" || die "could not write review beside $OUT"
  if ! node "$MERGE" --check "$out_tmp" 2>/dev/null; then
    rm -f "$out_tmp"
    die "structured review at $out_tmp failed validation"
  fi
  mv -f "$out_tmp" "$OUT"
  ok "written to $OUT"
fi
write_metadata "$MERGE_SUCCEEDED"
ANALYSIS_STATE="$(node "$RESULT_HELPER" analysis "$RUN_TMP/metadata.json")" \
  || die "could not derive validated analysis state"

LOCAL_UNRESOLVED_FILE="$RUN_TMP/local-unresolved.json"
printf '%s\n' '{"findings":[]}' > "$LOCAL_UNRESOLVED_FILE"
LOCAL_RECONCILIATION_KNOWN=false
local_unresolved_tmp="$LOCAL_UNRESOLVED_FILE.tmp"
if ST="$(support_exec scripts/local-state.mjs)"; then
  state_ready=1
  if [ "$RECORD_STATE" = 1 ]; then
    if _delta="$(node "$ST" record "$TMP_OUT" "$BASE_SHA" "$HEAD_SHA" "$ANALYSIS_STATE" 2>/dev/null)"; then
      say "state: $_delta"
    else
      state_ready=0
    fi
  fi
  if [ "$state_ready" = 1 ] \
    && node "$ST" export-open > "$local_unresolved_tmp" 2>/dev/null \
    && node "$MERGE" --check "$local_unresolved_tmp" 2>/dev/null; then
    mv -f "$local_unresolved_tmp" "$LOCAL_UNRESOLVED_FILE"
    LOCAL_RECONCILIATION_KNOWN=true
  fi
fi
if [ "$LOCAL_RECONCILIATION_KNOWN" != true ]; then
  rm -f "$local_unresolved_tmp"
  say "state reconciliation unavailable"
fi

CLEAN=0
if [ "$LOCAL_RECONCILIATION_KNOWN" = true ] && node -e '
  const fs = require("node:fs");
  const current = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).findings;
  const unresolved = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).findings;
  process.exit(current.length === 0 && unresolved.length === 0 ? 0 : 1);
' "$TMP_OUT" "$LOCAL_UNRESOLVED_FILE"; then
  CLEAN=1
fi

if [ "$AS_JSON" = 1 ]; then
  cat "$TMP_OUT"
elif RENDERER="$(support_exec scripts/post-review.mjs)"; then
  FINDINGS_FILE="$TMP_OUT" REVIEW_METADATA_FILE="$RUN_TMP/metadata.json" \
    UNRESOLVED_FINDINGS_FILE="$LOCAL_UNRESOLVED_FILE" \
    RECONCILIATION_KNOWN="$LOCAL_RECONCILIATION_KNOWN" \
    REVIEW_MODE="$REVIEW_MODE" RENDER=1 node "$RENDERER" || cat "$TMP_OUT"
else
  cat "$TMP_OUT"
fi

printf '\n' >&2
if [ "$CLEAN" = 1 ] && [ "$ANALYSIS_STATE" = "complete" ]; then
  ok "no findings"
elif [ "$CLEAN" = 1 ]; then
  say "no findings in available passes; analysis inconclusive"
elif [ "$FAIL_ON_FINDINGS" = 1 ]; then
  _c "0;33"; printf '  ! review above is not clean — review before pushing\n' >&2; _c "0"
  exit 1
else
  _c "0;33"; printf '  ! review above is not clean (--no-fail set)\n' >&2; _c "0"
fi
