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
#   --max-time DUR      per-pass cap, e.g. 600, 10m, 1h $AGENTIC_REVIEW_MAX_TIME
#   --prompt FILE       review instructions           $AGENTIC_REVIEW_PROMPT
#   --skill FILE        appended to the system prompt $AGENTIC_REVIEW_SKILL
#   --max-findings N    0 disables the cap            $AGENTIC_REVIEW_MAX_FINDINGS
#   --passes N          repeat the review N times and merge   $AGENTIC_REVIEW_PASSES
#   --lenses a,b,c      one pass per concern, e.g. security,correctness,docs
#                                                     $AGENTIC_REVIEW_LENSES
#   --max-parallel N    concurrent pass limit         $AGENTIC_REVIEW_MAX_PARALLEL
#   --min-votes N       experimental threshold; always inconclusive, preserves unsafe drops
#   --review-mode M     summary|inline|suggest        $AGENTIC_REVIEW_MODE
#                       suggest prints the fixes it would offer on a PR
#   --omp-version V     npm version or dist-tag       $AGENTIC_REVIEW_OMP_VERSION
#   --out FILE          write a human-readable findings document here
#   --publication-out FILE atomically write findings, metadata, and reviewed scope here
#                                                     $AGENTIC_REVIEW_PUBLICATION_OUT
#   --diagnostics-out FILE write bounded per-attempt failure diagnostics
#   --partition-shadow write an optional local partition-planning shadow
#   --partition-shadow-out FILE destination for the local partition shadow
#                           (required with --partition-shadow)
#                                                     no hosted environment
#                                                     interface
#   --execution-profile-out FILE write the trusted ordered descriptor profile
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
# Default high. Historical testing with the default model improved tool use
# from 2 to 25 calls and measured recall from 5/11 to 8/11. Lower it only when
# the wall-clock and cost trade-off matters more than recall.
THINKING="${AGENTIC_REVIEW_THINKING:-high}"
TOOLS="${AGENTIC_REVIEW_TOOLS:-read,grep,glob}"
MAX_TIME="${AGENTIC_REVIEW_MAX_TIME:-}"
PROMPT_FILE="${AGENTIC_REVIEW_PROMPT:-review/prompt.md}"
SKILL="${AGENTIC_REVIEW_SKILL:-}"
REVIEW_PHASE="${AGENTIC_REVIEW_PHASE:-discovery}"
KNOWN_FINDINGS_FILE="${AGENTIC_REVIEW_KNOWN_FINDINGS:-}"
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
MAX_PARALLEL="${AGENTIC_REVIEW_MAX_PARALLEL:-3}"
MIN_VOTES="${AGENTIC_REVIEW_MIN_VOTES:-1}"
PUBLICATION_OUT="${AGENTIC_REVIEW_PUBLICATION_OUT:-}"
DIAGNOSTICS_OUT="${AGENTIC_REVIEW_DIAGNOSTICS_OUT:-}"
PARTITION_SHADOW_INPUT="${AGENTIC_REVIEW_PARTITION_SHADOW:-false}"
PARTITION_SHADOW_OUT="${AGENTIC_REVIEW_PARTITION_SHADOW_OUT:-}"
case "$PARTITION_SHADOW_INPUT" in
  true) PARTITION_SHADOW=1 ;;
  false) PARTITION_SHADOW=0 ;;
  *) printf '%s\n' "AGENTIC_REVIEW_PARTITION_SHADOW must be true or false" >&2; exit 2 ;;
esac
unset AGENTIC_REVIEW_PARTITION_SHADOW AGENTIC_REVIEW_PARTITION_SHADOW_OUT
PARTITION_SHADOW_OUT_DIR_FD=""
PARTITION_SHADOW_OUT_FD_PATH=""
EXECUTION_PROFILE_OUT=""
PASS_MAX_ATTEMPTS=2
PASS_DIAGNOSTIC_STDERR_BYTES=4096
PASS_DIAGNOSTIC_STDERR_LINES=64
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
    --max-parallel) MAX_PARALLEL="${2:-}"; shift 2 ;;
    --min-votes)    MIN_VOTES="${2:-}"; shift 2 ;;
    --omp-version)  OMP_VERSION="${2:-}"; shift 2 ;;
    --out)          OUT="${2:-}"; shift 2 ;;
    --publication-out) PUBLICATION_OUT="${2:-}"; shift 2 ;;
    --diagnostics-out) DIAGNOSTICS_OUT="${2:-}"; shift 2 ;;
    --partition-shadow) PARTITION_SHADOW=1; shift ;;
    --partition-shadow-out) PARTITION_SHADOW_OUT="${2:-}"; shift 2 ;;
    --execution-profile-out) EXECUTION_PROFILE_OUT="${2:-}"; shift 2 ;;
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
case "$MAX_PARALLEL" in
  ''|*[!0-9]*) printf '%s\n' "--max-parallel must be a positive integer (got '$MAX_PARALLEL')" >&2; exit 2 ;;
  *[1-9]*) ;;
  *) printf '%s\n' "--max-parallel must be a positive integer (got '$MAX_PARALLEL')" >&2; exit 2 ;;
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
if [ -n "$PUBLICATION_OUT" ] && [ -L "$PUBLICATION_OUT" ]; then
  die "--publication-out cannot be a symlink destination"
fi
if [ -n "$DIAGNOSTICS_OUT" ] && [ -L "$DIAGNOSTICS_OUT" ]; then
  die "--diagnostics-out cannot be a symlink destination"
fi

if [ -n "$OUT" ]; then
  OUT_IDENTITY="$(destination_identity "$OUT")"
fi
if [ -n "$PUBLICATION_OUT" ]; then
  PUBLICATION_IDENTITY="$(destination_identity "$PUBLICATION_OUT")"
fi
if [ -n "$DIAGNOSTICS_OUT" ]; then
  DIAGNOSTICS_IDENTITY="$(destination_identity "$DIAGNOSTICS_OUT")"
fi

if [ -n "$OUT" ] && [ -n "$PUBLICATION_OUT" ] \
   && [ "$OUT_IDENTITY" = "$PUBLICATION_IDENTITY" ]; then
  die "--out and --publication-out resolve to the same destination"
fi
if [ -n "$DIAGNOSTICS_OUT" ] && {
  { [ -n "$OUT" ] && [ "$DIAGNOSTICS_IDENTITY" = "$OUT_IDENTITY" ]; } \
    || { [ -n "$PUBLICATION_OUT" ] \
      && [ "$DIAGNOSTICS_IDENTITY" = "$PUBLICATION_IDENTITY" ]; }
}; then
  die "--diagnostics-out must be distinct from review output destinations"
fi
if [ "$PARTITION_SHADOW" = 1 ] && [ -z "$PARTITION_SHADOW_OUT" ]; then
  die "--partition-shadow requires --partition-shadow-out FILE"
fi
if [ "$PARTITION_SHADOW" = 1 ] && [ -L "$PARTITION_SHADOW_OUT" ]; then
  die "--partition-shadow-out cannot be a symlink destination"
fi
if [ "$PARTITION_SHADOW" = 1 ]; then
  PARTITION_SHADOW_OUT_IDENTITY="$(destination_identity "$PARTITION_SHADOW_OUT")"
  if { [ -n "$OUT" ] && [ "$PARTITION_SHADOW_OUT_IDENTITY" = "$OUT_IDENTITY" ]; } \
     || { [ -n "$PUBLICATION_OUT" ] \
       && [ "$PARTITION_SHADOW_OUT_IDENTITY" = "$PUBLICATION_IDENTITY" ]; } \
     || { [ -n "$DIAGNOSTICS_OUT" ] \
       && [ "$PARTITION_SHADOW_OUT_IDENTITY" = "$DIAGNOSTICS_IDENTITY" ]; }; then
    die "--partition-shadow-out must be distinct from review output destinations"
  fi
  PARTITION_SHADOW_OUT_PARENT="$(dirname "$PARTITION_SHADOW_OUT_IDENTITY")"
  PARTITION_SHADOW_OUT_NAME="$(basename "$PARTITION_SHADOW_OUT_IDENTITY")"
  if ! exec {PARTITION_SHADOW_OUT_DIR_FD}<"$PARTITION_SHADOW_OUT_PARENT"; then
    die "could not hold --partition-shadow-out parent directory"
  fi
  PARTITION_SHADOW_OUT_FD_PATH="/proc/self/fd/$PARTITION_SHADOW_OUT_DIR_FD/$PARTITION_SHADOW_OUT_NAME"
fi

if [ -n "$DIAGNOSTICS_OUT" ]; then
  rm -f -- "$DIAGNOSTICS_OUT" \
    || die "could not clear stale diagnostics at $DIAGNOSTICS_OUT"
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
OMP_USES_BUNX=0
OMP_PACKAGE=""
if [ "$OMP_VERSION" = "latest" ] && command -v omp >/dev/null 2>&1; then
  OMP=(omp); ok "omp $(omp --version 2>/dev/null | head -1)"
elif command -v bunx >/dev/null 2>&1; then
  bunv="$(bun --version 2>/dev/null || echo 0)"
  ver_ge "$bunv" "$BUN_MIN" \
    || die "bun $bunv is too old — omp needs >= $BUN_MIN (it crashes with a minified SyntaxError otherwise). Upgrade with: bun upgrade"
  OMP_PACKAGE="@oh-my-pi/pi-coding-agent@${OMP_VERSION}"
  OMP=(bunx --bun "$OMP_PACKAGE")
  OMP_USES_BUNX=1
  ok "using bunx (bun $bunv)"
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
PASS_WORKER_PIDS=()
PASS_WORKER_PGIDS=()
PASS_TREE_PIDS=()
PASS_SCAN_PROBE_PID=""
PASS_RUN_TOKEN="agentic-review-$$-$RANDOM-$RANDOM"
RUNNER_PGID="$(ps -o pgid= -p "$$" | tr -d ' ')"
freeze_pass_tree() {
  local parent="$1" child
  if ! kill -STOP "$parent" 2>/dev/null; then return; fi
  for child in $(ps -eo pid=,ppid= | while read -r pid ppid; do
    if [ "$ppid" = "$parent" ]; then printf '%s\n' "$pid"; fi
  done); do
    freeze_pass_tree "$child"
  done
  PASS_TREE_PIDS+=("$parent")
}
tagged_pass_pids() {
  # Each model PID is held in SIGSTOP until this scan can rediscover that exact
  # other process. OMP descendants inherit the verified credentials and
  # dumpability; a host that hides same-credential processes fails before exec.
  if [ -d /proc ] && [ "${AGENTIC_REVIEW_FORCE_PS_SCAN:-0}" != 1 ]; then
    node -e '
      const fs = require("node:fs");
      const needle = Buffer.from(`AGENTIC_REVIEW_RUN_TOKEN=${process.argv[1]}\0`);
      for (const entry of fs.readdirSync("/proc")) {
        if (!/^[0-9]+$/.test(entry)) continue;
        try {
          if (fs.readFileSync(`/proc/${entry}/environ`).includes(needle)) {
            process.stdout.write(`${entry}\n`);
          }
        } catch {}
      }
    ' "$PASS_RUN_TOKEN"
  fi
  ps eww -A -o pid= -o command= 2>/dev/null | while read -r pid command; do
    case "$command" in
      *"AGENTIC_REVIEW_RUN_TOKEN=$PASS_RUN_TOKEN"*) printf '%s\n' "$pid" ;;
    esac
  done
}
verify_tagged_pass_visibility() {
  local attempt pid tagged_pids target_pid="${1:-}" owns_probe=0 seen=0
  if [ -z "$target_pid" ]; then
    AGENTIC_REVIEW_RUN_TOKEN="$PASS_RUN_TOKEN" sleep 30 &
    PASS_SCAN_PROBE_PID=$!
    target_pid="$PASS_SCAN_PROBE_PID"
    owns_probe=1
  fi
  for attempt in {1..20}; do
    tagged_pids="$(tagged_pass_pids || :)"
    for pid in $tagged_pids; do
      if [ "$pid" = "$target_pid" ]; then seen=1; break 2; fi
    done
    sleep 0.05
  done
  if [ "$owns_probe" = 1 ]; then
    kill -KILL "$target_pid" 2>/dev/null || :
    wait "$target_pid" 2>/dev/null || :
    PASS_SCAN_PROBE_PID=""
  fi
  [ "$seen" = 1 ]
}
kill_tagged_passes() {
  local attempt pid killed
  for attempt in {1..20}; do
    killed=0
    for pid in $(tagged_pass_pids); do
      if kill -KILL "$pid" 2>/dev/null; then killed=1; fi
    done
    if [ "$killed" = 0 ]; then return; fi
  done
}
stop_pass_workers() {
  local index pid pgid model_pid
  if [ -n "$PASS_SCAN_PROBE_PID" ]; then
    kill -KILL "$PASS_SCAN_PROBE_PID" 2>/dev/null || :
    wait "$PASS_SCAN_PROBE_PID" 2>/dev/null || :
    PASS_SCAN_PROBE_PID=""
  fi
  PASS_TREE_PIDS=()
  for index in "${!PASS_WORKER_PIDS[@]}"; do
    pid="${PASS_WORKER_PIDS[index]:-}"
    if [ -n "$pid" ]; then freeze_pass_tree "$pid"; fi
    if [ -n "$pid" ] && [ -f "$RUN_TMP/out.$index.pid" ] \
       && IFS= read -r model_pid < "$RUN_TMP/out.$index.pid"; then
      freeze_pass_tree "$model_pid"
    fi
  done
  kill_tagged_passes
  for pid in "${PASS_TREE_PIDS[@]}"; do kill -KILL "$pid" 2>/dev/null || :; done
  for index in "${!PASS_WORKER_PIDS[@]}"; do
    pid="${PASS_WORKER_PIDS[index]:-}"
    pgid="${PASS_WORKER_PGIDS[index]:-}"
    if [ -z "$pid" ]; then continue; fi
    if [ -n "$pgid" ] && [ "$pgid" != "$RUNNER_PGID" ]; then
      kill -KILL -- "-$pgid" 2>/dev/null || :
    else
      kill -KILL "$pid" 2>/dev/null || :
    fi
  done
  for pid in "${PASS_WORKER_PIDS[@]+"${PASS_WORKER_PIDS[@]}"}"; do
    if [ -n "$pid" ]; then wait "$pid" 2>/dev/null || :; fi
  done
  PASS_TREE_PIDS=()
  PASS_WORKER_PIDS=()
  PASS_WORKER_PGIDS=()
}
cleanup_worktree() {
  stop_pass_workers
  if [ -n "$WORKTREE" ]; then
    git worktree remove --force "$WORKTREE" 2>/dev/null || rm -rf -- "$WORKTREE"
    WORKTREE=""
  fi
  if [ -n "$PARTITION_SHADOW_OUT_DIR_FD" ]; then
    eval "exec ${PARTITION_SHADOW_OUT_DIR_FD}<&-"
    PARTITION_SHADOW_OUT_DIR_FD=""
  fi
  if [ -n "$RUN_TMP" ]; then rm -rf -- "$RUN_TMP"; RUN_TMP=""; fi
}
trap cleanup_worktree EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

step "Working out what changed"
STAGED_TARGET_SHA=""
if [ "$STAGED" = 1 ]; then
  # Capture the parent and index tree once, then represent that exact pair as a
  # dangling commit. Later restaging cannot change the review target.
  SOURCE_BASE_SHA="$(git rev-parse --verify 'HEAD^{commit}')"
  SOURCE_INDEX_TREE="$(git write-tree)"
  SOURCE_TARGET_SHA="$(GIT_AUTHOR_NAME=agentic-review GIT_AUTHOR_EMAIL=agentic-review@localhost GIT_COMMITTER_NAME=agentic-review GIT_COMMITTER_EMAIL=agentic-review@localhost git commit-tree "$SOURCE_INDEX_TREE" -p "$SOURCE_BASE_SHA" -m 'agentic-review: staged state')"
  STAGED_TARGET_SHA="$SOURCE_TARGET_SHA"
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

git diff --no-ext-diff --no-textconv --quiet "$SOURCE_BASE_SHA" "$SOURCE_TARGET_SHA" \
  && die "$([ "$STAGED" = 1 ] && printf 'nothing staged' || printf 'no changes vs %s' "$BASE")"
DIFFSTAT="$(git diff --no-ext-diff --no-textconv --stat "$SOURCE_BASE_SHA" "$SOURCE_TARGET_SHA")"
DIFFTEXT="$(git diff --no-ext-diff --no-textconv --no-color "$SOURCE_BASE_SHA" "$SOURCE_TARGET_SHA" && printf x)" \
  || die "could not render canonical diff"
DIFFTEXT="${DIFFTEXT%x}"
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
    printf '%s' "$DIFFTEXT"
    case "$DIFFTEXT" in *$'\n') ;; *) printf '\n' ;; esac
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
      git --literal-pathspecs diff --no-ext-diff --no-textconv --no-color "$SOURCE_BASE_SHA" "$SOURCE_TARGET_SHA" -- "$path"
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
case "$REVIEW_PHASE" in
  discovery) ;;
  verification)
    [ -n "$KNOWN_FINDINGS_FILE" ] \
      || die "verification phase requires AGENTIC_REVIEW_KNOWN_FINDINGS"
    node "$MERGE" --check "$KNOWN_FINDINGS_FILE" 2>/dev/null \
      || die "verification findings are not valid structured findings"
    ;;
  *) die "review phase must be discovery or verification (got '$REVIEW_PHASE')" ;;
esac

RUN_TMP="$(mktemp -d)"
if [ "$OMP_USES_BUNX" = 1 ] && [ "$MAX_PARALLEL" -gt 1 ]; then
  OMP_INSTALL_ROOT="$RUN_TMP/omp-package"
  mkdir -p "$OMP_INSTALL_ROOT"
  bun add --cwd="$OMP_INSTALL_ROOT" --no-save --silent "$OMP_PACKAGE" \
    || die "could not install omp@$OMP_VERSION before parallel passes"
  OMP_BINARY="$OMP_INSTALL_ROOT/node_modules/.bin/omp"
  [ -x "$OMP_BINARY" ] \
    || die "omp@$OMP_VERSION did not install its executable"
  OMP=("$OMP_BINARY")
  ok "prepared one private omp executable for parallel passes"
fi
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
git diff --no-ext-diff --no-textconv --name-only -z "$SOURCE_BASE_SHA" "$SOURCE_TARGET_SHA" > "$CHANGED_PATHS_FILE"
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
    changed="$(git diff --no-ext-diff --no-textconv --name-only "$SOURCE_BASE_SHA" "$SOURCE_TARGET_SHA")"
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
    if [ "$REVIEW_PHASE" = "verification" ]; then
      echo "## Verification phase"
      echo
      echo "Re-check only the persisted findings below and the affected invariants"
      echo "directly changed by their remediation. Do not report unrelated findings,"
      echo "even if broader review discovers them. Return a finding only when it still"
      echo "reproduces, or when the remediation caused a directly linked regression."
      echo "For a linked regression, copy the causal finding's verification_id into"
      echo "verification_of and set verification_classification to linked_regression."
      echo "The runner rejects unlinked new identities from verification output."
      echo
      echo '```json'
      cat "$KNOWN_FINDINGS_FILE"
      echo
      echo '```'
      echo
    else
      echo "## Discovery phase"
      echo
      echo "Search the reviewed scope broadly for new defects. This is the phase that"
      echo "may add findings to the review cycle."
      echo
    fi
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
REVIEW_PHASE="$REVIEW_PHASE" KNOWN_FINDINGS_FILE="$KNOWN_FINDINGS_FILE" \
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
    review_phase: process.env.REVIEW_PHASE,
    known_findings_content: process.env.KNOWN_FINDINGS_FILE
      ? fs.readFileSync(process.env.KNOWN_FINDINGS_FILE, "utf8")
      : "",
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
SCOPE_FILE="$RUN_TMP/scope.json"
BASE_SHA="$BASE_SHA" HEAD_SHA="$HEAD_SHA" \
CONFIGURATION_FINGERPRINT="$CONFIGURATION_FINGERPRINT" node -e '
  const fs = require("node:fs");
  const fullDiff = fs.readFileSync(process.argv[1]);
  fs.writeFileSync(process.argv[3], JSON.stringify({
    base_sha: process.env.BASE_SHA,
    bytes: fullDiff.length,
    configuration_fingerprint: process.env.CONFIGURATION_FINGERPRINT,
    diff_base64: fullDiff.toString("base64"),
    head_sha: process.env.HEAD_SHA,
    included_bytes: fs.statSync(process.argv[2]).size,
  }));
' "$RUN_TMP/diff.full" "$RUN_TMP/diff.included" "$SCOPE_FILE"
node "$RESULT_HELPER" scope "$SCOPE_FILE" >/dev/null \
  || die "could not validate review scope"

SHADOW_SETUP_STATUS=""
if [ "$PARTITION_SHADOW" = 1 ] || [ -n "$EXECUTION_PROFILE_OUT" ]; then
  SHADOW_LIMITS_FILE="$RUN_TMP/shadow-limits.json"
  SHADOW_PROFILE_FILE="$RUN_TMP/shadow-profile.json"
  SHADOW_CONFIG_FILE="$RUN_TMP/shadow-config.json"
  cat > "$SHADOW_LIMITS_FILE" <<'EOF'
{"schema_version":1,"max_patch_bytes":8388608,"max_raw_z_bytes":8388608,"max_single_blob_bytes":16777216,"max_total_blob_bytes":67108864,"max_capture_seconds":30}
EOF
  cat > "$SHADOW_CONFIG_FILE" <<'EOF'
{"schema_version":1,"benchmark_revision":"","atom_target_bytes":16000,"unit_target_bytes":64000,"max_frontier_units":128,"max_shadow_artifact_bytes":4194304}
EOF
  if ! node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";
    import { pathToFileURL } from "node:url";
    const [configurationFile, profileFile, canonicalJsonFile, attempts] = process.argv.slice(1);
    const { canonicalSha256 } = await import(pathToFileURL(canonicalJsonFile).href);
    const configuration = JSON.parse(readFileSync(configurationFile, "utf8"));
    const descriptors = configuration.pass_descriptors;
    const profile = {
      schema_version: 1,
      descriptors: descriptors.map(({ id }) => id),
      descriptor_content_hashes: descriptors.map(({ lens, lens_content, skill_content }) =>
        canonicalSha256({ lens, lens_content, skill_content })),
      max_output_attempts: Number(attempts),
    };
    writeFileSync(profileFile, `${JSON.stringify(profile)}\n`, { mode: 0o600 });
  ' "$CONFIG_FILE" "$SHADOW_PROFILE_FILE" "$SELF_ROOT/scripts/lib-canonical-json.mjs" \
    "$PASS_MAX_ATTEMPTS" 2>/dev/null; then
    SHADOW_SETUP_STATUS="planner_failed"
  fi
  if [ -n "$EXECUTION_PROFILE_OUT" ]; then
    [ ! -L "$EXECUTION_PROFILE_OUT" ] || die "--execution-profile-out cannot be a symlink destination"
    cp "$SHADOW_PROFILE_FILE" "$EXECUTION_PROFILE_OUT" \
      || die "could not write --execution-profile-out"
  fi
fi

step "Reviewing with $MODEL"
say "read-only tools: $TOOLS${THINKING:+ | thinking: $THINKING} | passes: ${#PASS_IDS[@]} | max parallel: $MAX_PARALLEL"

PASS_CHILD_PID=""
stop_pass_child() {
  if [ -z "$PASS_CHILD_PID" ]; then return; fi
  kill -TERM "$PASS_CHILD_PID" 2>/dev/null || :
  wait "$PASS_CHILD_PID" 2>/dev/null || :
  PASS_CHILD_PID=""
}

run_pass() {
  local prompt_file="$1" out_file="$2" skill_file="$3" pass_id="$4" status
  local attempt child_state=""
  local -a args=()
  if [ -s "$skill_file" ]; then args+=(--append-system-prompt="$skill_file"); fi
  if [ -n "$THINKING" ]; then args+=(--thinking="$THINKING"); fi
  if [ -n "$MAX_TIME" ]; then args+=(--max-time="$MAX_TIME"); fi
  if [ ${#PASSTHRU[@]} -gt 0 ]; then args+=("${PASSTHRU[@]}"); fi
  AGENTIC_REVIEW_RUN_TOKEN="$PASS_RUN_TOKEN" AGENTIC_REVIEW_PASS_ID="$pass_id" \
    bash -c 'kill -STOP "$$"; exec "$@"' agentic-review-pass "${OMP[@]}" -p \
    --model="$MODEL" \
    --no-session \
    "${args[@]+"${args[@]}"}" \
    --tools="$TOOLS" \
    --approval-mode=always-ask \
    --cwd="$REVIEW_ROOT" \
    "@$prompt_file" \
    < /dev/null > "$out_file" 2>"$out_file.err" &
  PASS_CHILD_PID=$!
  printf '%s\n' "$PASS_CHILD_PID" > "$out_file.pid"
  for attempt in {1..100}; do
    child_state="$(ps -o stat= -p "$PASS_CHILD_PID" 2>/dev/null | tr -d ' ')"
    case "$child_state" in T*) break ;; esac
    sleep 0.01
  done
  case "$child_state" in
    T*) ;;
    *)
      kill -KILL "$PASS_CHILD_PID" 2>/dev/null || :
      wait "$PASS_CHILD_PID" 2>/dev/null || :
      rm -f "$out_file.pid"
      PASS_CHILD_PID=""
      die "model process did not stop for cleanup verification in pass $pass_id"
      ;;
  esac
  if ! verify_tagged_pass_visibility "$PASS_CHILD_PID"; then
    kill -KILL "$PASS_CHILD_PID" 2>/dev/null || :
    wait "$PASS_CHILD_PID" 2>/dev/null || :
    rm -f "$out_file.pid"
    PASS_CHILD_PID=""
    die "could not verify cleanup access to model process for pass $pass_id"
  fi
  kill -CONT "$PASS_CHILD_PID" 2>/dev/null \
    || die "could not start verified model process for pass $pass_id"
  if wait "$PASS_CHILD_PID"; then status=0; else status=$?; fi
  rm -f "$out_file.pid"
  PASS_CHILD_PID=""
  return "$status"
}

write_pass_attempt_record() {
  local pass_index="$1" pass_id="$2" attempt="$3" attempt_status="$4"
  local process_status="$5" validator_error="$6" stderr_file="$7" prompt_file="$8"
  local record="$RUN_TMP/attempt.$pass_index.$attempt.json"
  local record_tmp="$record.tmp.$$"
  [ -n "$DIAGNOSTICS_OUT" ] || return 0
  node -e '
    const { readFileSync, renameSync, writeFileSync } = require("node:fs");
    const [
      recordTmp, record, passIndex, passId, attempt, status, processStatus,
      validatorError, stderrFile, promptFile, maxBytes, maxLines,
    ] = process.argv.slice(1);
    const read = (path) => {
      try { return readFileSync(path, "utf8"); } catch { return ""; }
    };
    const prompt = read(promptFile);
    const safeDiagnostic = /(?:^|\b)(?:error|failed|failure|provider|model|request|response|rate|quota|timeout|status|http|openrouter|unauthori[sz]ed|forbidden|connection|network|socket|too many|overload|429|5\d\d)(?:\b|:)/i;
    const secrets = [
      process.env.OPENROUTER_API_KEY,
      process.env.GH_TOKEN,
      process.env.GITHUB_TOKEN,
      process.env.AGENTIC_REVIEW_RUN_TOKEN,
    ].filter((value) => typeof value === "string" && value.length >= 4);
    const overlapsPrompt = (line) => {
      const stripped = line.replace(
        /^(?:\[[^\]]+\]\s*)?(?:error|failed|failure|provider|model|request|response)\s*[:=-]\s*/i,
        "",
      ).trim();
      for (const candidate of [line.trim(), stripped]) {
        if (candidate.length < 8) continue;
        if (prompt.includes(candidate)) return true;
        for (let index = 0; index + 24 <= candidate.length; index += 12) {
          if (prompt.includes(candidate.slice(index, index + 24))) return true;
        }
      }
      return false;
    };
    const sanitize = (source) => {
      let line = source
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
        .trim();
      if (!line) return "";
      if (overlapsPrompt(line)) return "<redacted review input>";
      for (const secret of secrets) line = line.split(secret).join("<redacted secret>");
      line = line
        .replace(/\b(?:sk-or-v1|github_pat|gh[pousr])[-_A-Za-z0-9]{8,}\b/g, "<redacted token>")
        .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s]+/ig, "$1<redacted token>")
        .replace(/https:\/\/openrouter\.ai\/workspaces\/[^\s/]+\/keys\/[^\s]+/ig, "https://openrouter.ai/settings/keys")
        .replace(/(https?:\/\/[^\s?]+)\?[^\s]*/g, "$1");
      if (!safeDiagnostic.test(line)) return "<redacted stderr line>";
      return line.length > 512 ? `${line.slice(0, 509)}...` : line;
    };
    const raw = status === "valid" ? "" : read(stderrFile);
    const sanitized = raw
      .split(/\r?\n/)
      .slice(-Number(maxLines))
      .map(sanitize)
      .filter(Boolean);
    let stderrTail = sanitized.join("\n");
    while (Buffer.byteLength(stderrTail, "utf8") > Number(maxBytes)) {
      stderrTail = stderrTail.slice(1);
    }
    const value = {
      pass_index: Number(passIndex),
      pass_id: passId,
      attempt: Number(attempt),
      status,
      process_exit_status: Number(processStatus),
      stderr_tail: stderrTail,
      validator_error: validatorError || null,
    };
    writeFileSync(recordTmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    renameSync(recordTmp, record);
  ' "$record_tmp" "$record" "$pass_index" "$pass_id" "$attempt" "$attempt_status" \
    "$process_status" "$validator_error" "$stderr_file" "$prompt_file" \
    "$PASS_DIAGNOSTIC_STDERR_BYTES" "$PASS_DIAGNOSTIC_STDERR_LINES" \
    || die "could not record bounded diagnostics for pass $pass_id attempt $attempt"
}

run_pass_worker() {
  local pass_index="$1" out_file="$RUN_TMP/out.$1" record="$RUN_TMP/pass.$1.record"
  local record_tmp="$RUN_TMP/pass.$1.record.tmp" diagnostics="$RUN_TMP/pass.$1.diagnostics"
  local attempt attempts=0 status=failed count=0 capped=false
  local process_status attempt_status validator_error classification diagnosis
  trap stop_pass_child EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  : > "$diagnostics"
  for ((attempt = 1; attempt <= PASS_MAX_ATTEMPTS; attempt++)); do
    attempts="$attempt"
    if run_pass "$RUN_TMP/prompt.$pass_index" "$out_file" \
       "$RUN_TMP/skill.$pass_index" "${PASS_IDS[pass_index]}"; then
      process_status=0
    else
      process_status=$?
    fi
    validator_error=""
    if [ "$process_status" -ne 0 ]; then
      attempt_status=process_exit
    elif [ ! -s "$out_file" ]; then
      attempt_status=empty_stdout
    else
      diagnosis="$(node "$MERGE" --diagnose "$out_file")" \
        || die "could not classify output for pass ${PASS_IDS[pass_index]}"
      classification="$(node -e '
        const value = JSON.parse(process.argv[1]);
        process.stdout.write(`${value.status}\t${value.reason ?? ""}`);
      ' "$diagnosis")"
      attempt_status="${classification%%$'\t'*}"
      validator_error="${classification#*$'\t'}"
    fi
    write_pass_attempt_record "$pass_index" "${PASS_IDS[pass_index]}" "$attempt" \
      "$attempt_status" "$process_status" "$validator_error" "$out_file.err" \
      "$RUN_TMP/prompt.$pass_index"
    case "$attempt_status" in
      valid)
        status=valid
        break
        ;;
      process_exit)
        printf 'model process exited %s (attempt %s)\n' \
          "$process_status" "$attempt" >> "$diagnostics"
        ;;
      empty_stdout)
        printf 'empty model stdout (attempt %s)\n' "$attempt" >> "$diagnostics"
        ;;
      invalid_json)
        printf 'invalid JSON (attempt %s)\n' "$attempt" >> "$diagnostics"
        ;;
      schema_invalid)
        printf 'schema invalid: %s (attempt %s)\n' \
          "$validator_error" "$attempt" >> "$diagnostics"
        ;;
      *)
        die "unknown output classification for pass ${PASS_IDS[pass_index]}: $attempt_status"
        ;;
    esac
  done
  if [ "$status" = valid ]; then
    count="$(node -e 'const fs=require("node:fs"); process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).findings.length))' "$out_file")"
    if [ "$MAX_FINDINGS" != "0" ] && [ "$count" -ge "$MAX_FINDINGS" ]; then capped=true; fi
  fi
  printf '%s\t%s\t%s\t%s\n' "$status" "$attempts" "$count" "$capped" > "$record_tmp"
  mv "$record_tmp" "$record"
}

ACTIVE_PASS_WORKERS=0
reap_completed_pass() {
  local index pid record running_pid worker_running completed status running_workers
  while :; do
    if [ "${PASS_CANCEL_STATUS:-0}" != 0 ]; then exit "$PASS_CANCEL_STATUS"; fi
    running_workers="$(jobs -pr)"
    for index in "${!PASS_WORKER_PIDS[@]}"; do
      pid="${PASS_WORKER_PIDS[index]:-}"
      if [ -z "$pid" ]; then continue; fi
      record="$RUN_TMP/pass.$index.record"
      completed=0
      if [ -f "$record" ]; then
        completed=1
      else
        worker_running=0
        for running_pid in $running_workers; do
          if [ "$running_pid" = "$pid" ]; then worker_running=1; break; fi
        done
        if [ "$worker_running" = 0 ]; then
          if [ -f "$record" ]; then
            completed=1
          else
            if wait "$pid"; then status=0; else status=$?; fi
            die "pass worker $index exited unexpectedly (status $status)"
          fi
        fi
      fi
      if [ "$completed" = 1 ]; then
        wait "$pid" 2>/dev/null || :
        rm -f "$RUN_TMP/out.$index.pid"
        PASS_WORKER_PIDS[index]=""
        PASS_WORKER_PGIDS[index]=""
        ACTIVE_PASS_WORKERS=$((ACTIVE_PASS_WORKERS - 1))
        return
      fi
    done
    sleep 0.05
  done
}
publish_pass_diagnostics() {
  [ -n "$DIAGNOSTICS_OUT" ] || return 0
  local manifest_tmp="$RUN_TMP/pass-diagnostics.json"
  node -e '
    const { readFileSync, readdirSync, writeFileSync } = require("node:fs");
    const [runTmp, manifestTmp, maxBytes, maxLines] = process.argv.slice(1);
    const attempts = readdirSync(runTmp)
      .filter((name) => /^attempt\.[0-9]+\.[0-9]+\.json$/.test(name))
      .map((name) => JSON.parse(readFileSync(`${runTmp}/${name}`, "utf8")))
      .sort((left, right) =>
        left.pass_index - right.pass_index || left.attempt - right.attempt);
    if (!attempts.some(({ status }) => status !== "valid")) process.exit(0);
    const passIds = readFileSync(`${runTmp}/pass-ids`, "utf8")
      .trimEnd()
      .split("\n");
    const passes = passIds.map((id, passIndex) => {
      const [finalStatus] = readFileSync(
        `${runTmp}/pass.${passIndex}.record`,
        "utf8",
      ).trim().split("\t");
      return {
        id,
        final_status: finalStatus,
        attempts: attempts
          .filter((value) => value.pass_index === passIndex)
          .map(({
            attempt, status, process_exit_status, stderr_tail, validator_error,
          }) => ({
            attempt,
            status,
            process_exit_status,
            stderr_tail,
            validator_error,
          })),
      };
    });
    const manifest = {
      schema_version: 1,
      stderr_limit_bytes: Number(maxBytes),
      stderr_limit_lines: Number(maxLines),
      passes,
    };
    writeFileSync(manifestTmp, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
  ' "$RUN_TMP" "$manifest_tmp" "$PASS_DIAGNOSTIC_STDERR_BYTES" \
    "$PASS_DIAGNOSTIC_STDERR_LINES" \
    || die "could not assemble bounded pass diagnostics"
  if [ -s "$manifest_tmp" ]; then
    node -e '
      const fs = require("node:fs");
      const { randomBytes } = require("node:crypto");
      const { basename, dirname, join } = require("node:path");
      const [source, destination] = process.argv.slice(1);
      const directory = dirname(destination);
      let descriptor;
      let temporary;
      try {
        for (let attempt = 0; attempt < 10; attempt += 1) {
          temporary = join(
            directory,
            `.${basename(destination)}.tmp-${randomBytes(8).toString("hex")}`,
          );
          try {
            descriptor = fs.openSync(temporary, "wx", 0o600);
            break;
          } catch (error) {
            if (error.code !== "EEXIST") throw error;
          }
        }
        if (descriptor === undefined) throw new Error("could not allocate diagnostics staging file");
        fs.writeFileSync(descriptor, fs.readFileSync(source));
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporary, destination);
        temporary = undefined;
      } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
        if (temporary !== undefined) {
          try { fs.unlinkSync(temporary); } catch {}
        }
      }
    ' "$manifest_tmp" "$DIAGNOSTICS_OUT" \
      || die "could not atomically publish pass diagnostics at $DIAGNOSTICS_OUT"
    ok "pass diagnostics written to $DIAGNOSTICS_OUT"
  fi
}


PASS_STATUSES=()
PASS_ATTEMPTS=()
PASS_COUNTS=()
PASS_CAPPED=()
PASS_OUTS=()
VALID_OUTS=()
verify_tagged_pass_visibility \
  || die "could not verify detached-process cleanup before starting model work"

set -m
PASS_CANCEL_STATUS=0
trap 'PASS_CANCEL_STATUS=130' INT
trap 'PASS_CANCEL_STATUS=143' TERM
for ((i = 0; i < ${#PASS_IDS[@]}; i++)); do
  if [ "$PASS_CANCEL_STATUS" != 0 ]; then exit "$PASS_CANCEL_STATUS"; fi
  PASS_OUTS+=("$RUN_TMP/out.$i")
  AGENTIC_REVIEW_RUN_TOKEN="$PASS_RUN_TOKEN" run_pass_worker "$i" &
  PASS_WORKER_PIDS[i]=$!
  PASS_WORKER_PGIDS[i]="$(ps -o pgid= -p "${PASS_WORKER_PIDS[i]}" | tr -d ' ')"
  ACTIVE_PASS_WORKERS=$((ACTIVE_PASS_WORKERS + 1))
  if [ "$PASS_CANCEL_STATUS" != 0 ]; then exit "$PASS_CANCEL_STATUS"; fi
  if [ "$ACTIVE_PASS_WORKERS" -ge "$MAX_PARALLEL" ]; then reap_completed_pass; fi
done
trap 'exit 130' INT
trap 'exit 143' TERM
if [ "$PASS_CANCEL_STATUS" != 0 ]; then exit "$PASS_CANCEL_STATUS"; fi
while [ "$ACTIVE_PASS_WORKERS" -gt 0 ]; do reap_completed_pass; done
set +m

for ((i = 0; i < ${#PASS_IDS[@]}; i++)); do
  if [ -s "$RUN_TMP/pass.$i.diagnostics" ]; then
    while IFS= read -r diagnostic; do say "pass ${PASS_IDS[i]}: $diagnostic"; done \
      < "$RUN_TMP/pass.$i.diagnostics"
  fi
  if ! IFS=$'\t' read -r status attempts count capped < "$RUN_TMP/pass.$i.record"; then
    die "pass ${PASS_IDS[i]} did not produce a result"
  fi
  PASS_STATUSES+=("$status")
  PASS_ATTEMPTS+=("$attempts")
  PASS_COUNTS+=("$count")
  PASS_CAPPED+=("$capped")
  if [ "$status" = valid ]; then
    VALID_OUTS+=("${PASS_OUTS[i]}")
    say "pass ${PASS_IDS[i]} valid (${count} finding(s), attempt $attempts)"
  else
    say "pass ${PASS_IDS[i]} failed after $attempts attempts"
  fi
done
publish_pass_diagnostics


TMP_OUT="$RUN_TMP/merged.json"
write_publication() {
  local merge_succeeded="$1" execution_failed="${2:-0}" records="$RUN_TMP/pass-records"
  : > "$records"
  for ((j = 0; j < ${#PASS_IDS[@]}; j++)); do
    printf '%s\t%s\t%s\t%s\t%s\n' \
      "${PASS_IDS[j]}" "${PASS_STATUSES[j]}" "${PASS_ATTEMPTS[j]}" \
      "${PASS_COUNTS[j]}" "${PASS_CAPPED[j]}" >> "$records"
  done
  BASE_SHA="$BASE_SHA" HEAD_SHA="$HEAD_SHA" CONFIGURATION_FINGERPRINT="$CONFIGURATION_FINGERPRINT" \
  SNAPSHOT_IMMUTABLE="$SNAPSHOT_IMMUTABLE" \
  MAX_FINDINGS="$MAX_FINDINGS" MIN_VOTES="$MIN_VOTES" \
  MERGE_SUCCEEDED="$merge_succeeded" EXECUTION_FAILED="$execution_failed" \
  node --input-type=module -e '
    import fs from "node:fs";
    import { pathToFileURL } from "node:url";

    const {
      createReviewPublication,
      deriveTrustedScopeMetadata,
      enrichRunMetadata,
    } = await import(pathToFileURL(process.argv[3]).href);
    const trustedScope = JSON.parse(fs.readFileSync(process.argv[4], "utf8"));
    const trustedMetadata = deriveTrustedScopeMetadata(trustedScope);
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
    const run = {
      schema_version: 1,
      base_sha: process.env.BASE_SHA,
      head_sha: process.env.HEAD_SHA,
      configuration_fingerprint: process.env.CONFIGURATION_FINGERPRINT,
      snapshot_immutable: process.env.SNAPSHOT_IMMUTABLE === "1",
      diff: trustedMetadata.diff,
      finding_cap: Number(process.env.MAX_FINDINGS),
      min_votes: Number(process.env.MIN_VOTES),
      passes: {
        requested: results.map(({ id }) => id),
        completed: results.filter(({ status }) => status === "valid").map(({ id }) => id),
        results,
      },
    };
    if (process.env.MERGE_SUCCEEDED === "true") run.merge_succeeded = true;
    if (process.env.MERGE_SUCCEEDED === "false") run.merge_succeeded = false;
    const metadata = enrichRunMetadata(run, {
      scopeHash: trustedMetadata.scope_hash,
      executionFailed: process.env.EXECUTION_FAILED === "1" ? true : undefined,
    });
    const findings = JSON.parse(fs.readFileSync(process.argv[5], "utf8")).findings;
    const publication = createReviewPublication(metadata, trustedScope, findings);
    fs.writeFileSync(process.argv[2], JSON.stringify(metadata, null, 2));
    fs.writeFileSync(process.argv[6], JSON.stringify(publication, null, 2));
  ' "$records" "$RUN_TMP/metadata.json" "$RESULT_HELPER" "$SCOPE_FILE" "$TMP_OUT" "$RUN_TMP/publication.json" \
    || die "could not derive review publication"
  node "$RESULT_HELPER" validate "$RUN_TMP/publication.json" >/dev/null \
    || die "generated review publication failed validation"
  if [ -n "$PUBLICATION_OUT" ]; then
    local publication_tmp="$RUN_TMP/publication-out.json"
    if ! cp "$RUN_TMP/publication.json" "$publication_tmp"; then
      rm -f "$publication_tmp"
      die "could not stage review publication for $PUBLICATION_OUT"
    fi
    if ! node "$RESULT_HELPER" validate "$publication_tmp" >/dev/null; then
      rm -f "$publication_tmp"
      die "staged review publication failed validation"
    fi
    node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' \
      "$publication_tmp" "$PUBLICATION_OUT" || {
      rm -f "$publication_tmp"
      die "could not atomically publish review publication at $PUBLICATION_OUT"
    }
    ok "publication written to $PUBLICATION_OUT"
  fi
}

publish_findings() {
  node "$MERGE" --check "$TMP_OUT" 2>/dev/null \
    || die "review result is not a structured findings document"
  if [ -n "$OUT" ]; then
    local out_tmp="${OUT}.tmp.$$"
    cp "$TMP_OUT" "$out_tmp" || die "could not write review beside $OUT"
    if ! node "$MERGE" --check "$out_tmp" 2>/dev/null; then
      rm -f "$out_tmp"
      die "structured review at $out_tmp failed validation"
    fi
    mv -f "$out_tmp" "$OUT" || {
      rm -f "$out_tmp"
      die "could not publish review at $OUT"
    }
    ok "written to $OUT"
  fi
}

run_shadow_command() {
  local stderr_file="$1" fifo="${1}.fifo" reader command_status
  shift
  rm -f -- "$stderr_file" "$fifo"
  mkfifo "$fifo" || return 125
  node -e '
    const fs = require("node:fs");
    const output = fs.openSync(process.argv[1], "wx", 0o600);
    let written = 0;
    process.stdin.on("data", (chunk) => {
      const remaining = 512 - written;
      if (remaining <= 0) return;
      const admitted = chunk.subarray(0, remaining);
      fs.writeSync(output, admitted);
      written += admitted.length;
    });
    process.stdin.on("end", () => fs.closeSync(output));
  ' "$stderr_file" <"$fifo" &
  reader=$!
  if "$@" 2>"$fifo"; then command_status=0; else command_status=$?; fi
  wait "$reader" || :
  rm -f -- "$fifo"
  return "$command_status"
}

stage_shadow_helper_diagnostic() {
  local requested_status="$1" reason="$2" stderr_file="$3" staged_local="$4"
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { pathToFileURL } from "node:url";
    const [
      helper, configFile, captureFile, destination, requestedStatus, reason,
      baseSha, headSha, stderrFile,
    ] = process.argv.slice(1);
    const { buildShadowDiagnostic, writeShadowOutput } =
      await import(pathToFileURL(helper).href);
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    let capture;
    try { capture = JSON.parse(readFileSync(captureFile, "utf8")); } catch {}
    const stderrPresent = (() => {
      try { return readFileSync(stderrFile).length > 0; } catch { return false; }
    })();
    const canReportPlannerFailure = requestedStatus === "planner_failed"
      && capture?.status === "complete";
    const details = {
      status: canReportPlannerFailure ? "planner_failed" : "capture_failed",
      base_sha: baseSha,
      head_sha: headSha,
      benchmark_revision: config.benchmark_revision,
      reason_codes: [canReportPlannerFailure ? reason : "capture_result_unavailable"],
      diagnostic: stderrPresent
        ? "Shadow helper failed; stderr redacted."
        : "Shadow helper failed without stderr.",
      observed_lower_bounds: {
        patch_bytes: 0, raw_z_bytes: 0, blob_bytes: 0, blob_count: 0,
        elapsed_milliseconds: 0,
      },
      counts: {},
    };
    if (canReportPlannerFailure) details.capture = capture;
    writeShadowOutput(destination,
      buildShadowDiagnostic(details, config.max_shadow_artifact_bytes));
  ' "$SELF_ROOT/scripts/review-units.mjs" "$SHADOW_CONFIG_FILE" \
    "$RUN_TMP/shadow-capture.json" "$staged_local" "$requested_status" "$reason" \
    "$BASE_SHA" "$HEAD_SHA" "$stderr_file" 2>/dev/null
}

run_partition_shadow() {
  [ "$PARTITION_SHADOW" = 1 ] || return 0
  local status="$SHADOW_SETUP_STATUS" capture_helper units_helper staged_local
  local capture_stderr="$RUN_TMP/shadow-capture.stderr"
  local units_stderr="$RUN_TMP/shadow-units.stderr"
  staged_local="$RUN_TMP/shadow-local.staged.json"
  capture_helper="$(support_exec scripts/review-capture.mjs || :)"
  units_helper="$(support_exec scripts/review-units.mjs || :)"
  if [ -n "$status" ] || [ -z "$capture_helper" ]; then
    stage_shadow_helper_diagnostic capture_failed capture_helper_unavailable \
      "$capture_stderr" "$staged_local" || :
  elif ! run_shadow_command "$capture_stderr" \
    node "$capture_helper" capture \
    --repo "$REVIEW_ROOT" --base "$BASE_SHA" --head "$HEAD_SHA" \
    --limits "$SHADOW_LIMITS_FILE" \
    --out "$RUN_TMP/shadow-capture.json"; then
    stage_shadow_helper_diagnostic capture_failed capture_helper_failed \
      "$capture_stderr" "$staged_local" || :
  elif [ ! -s "$RUN_TMP/shadow-capture.json" ]; then
    stage_shadow_helper_diagnostic capture_failed capture_output_missing \
      "$capture_stderr" "$staged_local" || :
  elif [ -z "$units_helper" ]; then
    stage_shadow_helper_diagnostic planner_failed planner_helper_unavailable \
      "$units_stderr" "$staged_local" || :
  elif ! run_shadow_command "$units_stderr" \
    node "$units_helper" shadow \
    --capture "$RUN_TMP/shadow-capture.json" \
    --profile "$SHADOW_PROFILE_FILE" \
    --config "$SHADOW_CONFIG_FILE" \
    --local-out "$staged_local"; then
    stage_shadow_helper_diagnostic planner_failed planner_helper_failed \
      "$units_stderr" "$staged_local" || :
  elif [ ! -s "$staged_local" ]; then
    stage_shadow_helper_diagnostic planner_failed planner_output_missing \
      "$units_stderr" "$staged_local" || :
  fi
  if [ -s "$staged_local" ]; then
    status="$(node -e '
      const fs = require("node:fs");
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (typeof value.status !== "string" || !/^[a-z_]{1,64}$/.test(value.status)) process.exit(1);
      process.stdout.write(value.status);
    ' "$staged_local" 2>/dev/null || printf planner_failed)"
    if ! node -e '
      const fs = require("node:fs");
      const { basename, dirname, join } = require("node:path");
      const { randomBytes } = require("node:crypto");
      const [source, destination] = process.argv.slice(1);
      if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) {
        throw new Error("refusing to replace a symbolic-link output path");
      }
      let descriptor;
      let temporary;
      try {
        for (let attempt = 0; attempt < 10; attempt += 1) {
          temporary = join(dirname(destination),
            `.${basename(destination)}.tmp-${randomBytes(8).toString("hex")}`);
          try {
            descriptor = fs.openSync(temporary, "wx", 0o600);
            break;
          } catch (error) {
            if (error.code !== "EEXIST") throw error;
          }
        }
        if (descriptor === undefined) throw new Error("could not allocate shadow staging file");
        fs.writeFileSync(descriptor, fs.readFileSync(source));
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporary, destination);
        temporary = undefined;
      } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
        if (temporary !== undefined) {
          try { fs.unlinkSync(temporary); } catch {}
        }
      }
    ' "$staged_local" "$PARTITION_SHADOW_OUT_FD_PATH" 2>/dev/null; then
      status="planner_failed"
    fi
  elif [ -z "$status" ]; then
    status="capture_failed"
  fi
  say "partition shadow: $status"
}

if [ ${#VALID_OUTS[@]} -eq 0 ]; then
  printf '%s\n' '{"findings":[]}' > "$TMP_OUT"
  write_publication not-run 1
  publish_findings
  run_partition_shadow
  die "every configured pass failed"
fi
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
  if node "$MERGE" --min-votes "$MIN_VOTES" "${VALID_OUTS[@]}" > "$TMP_OUT" \
     && node "$MERGE" --check "$TMP_OUT" 2>/dev/null; then
    if ! cmp -s "$UNION_OUT" "$TMP_OUT"; then
      say "min-votes $MIN_VOTES would hide valid evidence — preserving the union"
      mv -f "$UNION_OUT" "$TMP_OUT"
    fi
  else
    MERGE_SUCCEEDED=false
    say "min-votes $MIN_VOTES merge failed — preserving the union"
    mv -f "$UNION_OUT" "$TMP_OUT"
  fi
fi
if [ "$REVIEW_PHASE" = "verification" ]; then
  verification_input_count="$(node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).findings.length))' "$TMP_OUT")"
  verification_out="$RUN_TMP/verification.json"
  node "$MERGE" --known-only "$KNOWN_FINDINGS_FILE" "$TMP_OUT" > "$verification_out" \
    || die "could not enforce verification finding identities"
  verification_output_count="$(node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).findings.length))' "$verification_out")"
  if [ "$verification_output_count" -lt "$verification_input_count" ]; then
    MERGE_SUCCEEDED=false
    say "verification identity filtering withheld evidence — preserving inconclusive analysis"
  fi
  mv -f "$verification_out" "$TMP_OUT"
fi
publish_findings
write_publication "$MERGE_SUCCEEDED"
ANALYSIS_STATE="$(node "$RESULT_HELPER" analysis "$RUN_TMP/metadata.json")" \
  || die "could not derive validated analysis state"

LOCAL_UNRESOLVED_FILE="$RUN_TMP/local-unresolved.json"
printf '%s\n' '{"findings":[]}' > "$LOCAL_UNRESOLVED_FILE"
LOCAL_RECONCILIATION_KNOWN=false
local_unresolved_tmp="$LOCAL_UNRESOLVED_FILE.tmp"
if ST="$(support_exec scripts/local-state.mjs)"; then
  state_ready=1
  if [ "$RECORD_STATE" = 1 ]; then
    if _delta="$(AGENTIC_REVIEW_STAGED_TARGET="$STAGED_TARGET_SHA" \
      node "$ST" record "$TMP_OUT" "$BASE_SHA" "$HEAD_SHA" "$ANALYSIS_STATE" 2>/dev/null)"; then
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
  HEAD_SHA="$HEAD_SHA" REVIEW_PUBLICATION_FILE="$RUN_TMP/publication.json" \
    UNRESOLVED_FINDINGS_FILE="$LOCAL_UNRESOLVED_FILE" \
    RECONCILIATION_KNOWN="$LOCAL_RECONCILIATION_KNOWN" \
    REVIEW_MODE="$REVIEW_MODE" RENDER=1 node "$RENDERER" || cat "$TMP_OUT"
else
  cat "$TMP_OUT"
fi
run_partition_shadow

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
