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
#   ./scripts/run-review.sh -- --add-dir ../shared   # extra omp flags
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
#   --min-votes N       drop findings seen in fewer passes   $AGENTIC_REVIEW_MIN_VOTES
#   --review-mode M     summary|inline|suggest        $AGENTIC_REVIEW_MODE
#                       suggest prints the fixes it would offer on a PR
#   --omp-version V     npm version or dist-tag       $AGENTIC_REVIEW_OMP_VERSION
#   --out FILE          write the review here
#   --open              list findings still open from previous runs
#   --all               list every tracked finding, including dismissed
#   --history           list past runs
#   --dismiss ID...     stop reporting these findings
#   --trust-repo        proceed despite agent config in the checkout
#   --no-codegraph      skip the symbol index (for A/B measurement)
#   --json              raw findings JSON on stdout, for piping
#   --no-fail           exit 0 even when findings are reported
#   -- ARGS...          everything after -- is passed to omp verbatim
#
# Identical prompt, tools and skill injection to .github/workflows/
# agentic-review.yml — both read review/prompt.md, so local results and CI
# results cannot drift. The flag names match the workflow's inputs one-for-one.
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
READ_ONLY_TOOLS="read grep glob ast_grep inspect_image todo"

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
TOOLS="${AGENTIC_REVIEW_TOOLS:-read,grep,glob,ast_grep}"
MAX_TIME="${AGENTIC_REVIEW_MAX_TIME:-}"
PROMPT_FILE="${AGENTIC_REVIEW_PROMPT:-review/prompt.md}"
SKILL="${AGENTIC_REVIEW_SKILL:-}"
SKILL_DEFAULT="skills/infra-review/SKILL.md,skills/security-review/SKILL.md"
MAX_FINDINGS="${AGENTIC_REVIEW_MAX_FINDINGS:-20}"
# summary by default locally: there is no pull request to anchor comments to,
# so suggest/inline render the proposed fixes to the terminal instead.
REVIEW_MODE="${AGENTIC_REVIEW_MODE:-summary}"
OMP_VERSION="${AGENTIC_REVIEW_OMP_VERSION:-latest}"
MAX_DIFF_BYTES="${AGENTIC_REVIEW_MAX_DIFF_BYTES:-400000}"
PASSES="${AGENTIC_REVIEW_PASSES:-1}"
# Separate passes per concern. Macroscope runs security / correctness / docs as
# distinct passes, and AgenticSCR measured that MIXING knowledge sources hurt
# (13.0% -> 12.6%, "semantic noise or conflicting signals"). Splitting also cuts
# rules-per-prompt, which is what predicts whether injected knowledge is used.
LENSES="${AGENTIC_REVIEW_LENSES:-}"
MIN_VOTES="${AGENTIC_REVIEW_MIN_VOTES:-1}"
STAGED=0; OUT=""; FAIL_ON_FINDINGS=1; AS_JSON=0; USE_CODEGRAPH=1; VIEW=""; TRUST_REPO="${TRUST_REPO:-0}"
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
    --staged)       STAGED=1; shift ;;
    --no-fail)      FAIL_ON_FINDINGS=0; shift ;;
    --no-codegraph) USE_CODEGRAPH=0; shift ;;
    --trust-repo)   TRUST_REPO=1; shift ;;
    --open)         VIEW=open; shift ;;
    --history)      VIEW=runs; shift ;;
    --all)          VIEW=all; shift ;;
    --dismiss)      VIEW=dismiss; shift; DISMISS_IDS="$*"; break ;;
    --json)         AS_JSON=1; REVIEW_MODE="${REVIEW_MODE/#summary/suggest}"; shift ;;
    --)             shift; PASSTHRU=("$@"); break ;;
    # Print the header comment, stopping at the first line that isn't one.
    # A line range would silently start leaking code every time the header grows.
    -h|--help)      awk 'NR>1 && !/^#/{exit} NR>1{sub(/^# ?/,""); print}' "$0"; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

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

# Two lookups, because the two kinds of file have opposite trust requirements.
#
# DATA — prompts, skills, output formats — may be overridden by the repository,
# because a project shipping its own review conventions is the feature.
#
# CODE — anything this script then executes — must come from where this script
# lives and nowhere else. Preferring the repository's copy meant that running
# `review` inside someone else's checkout ran their scripts/post-review.mjs and
# scripts/codegraph.sh on your machine. Reviewing a branch is not consenting to
# execute it.
support() { # support <relative-path> -> data file, repo first
  if [ -f "$1" ]; then printf '%s' "$1"; return 0; fi
  if [ -f "$SELF_ROOT/$1" ]; then printf '%s' "$SELF_ROOT/$1"; return 0; fi
  return 1
}
support_exec() { # support_exec <relative-path> -> executable, installed copy only
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

# The escape hatch must not be able to undo the envelope the flags above set.
for a in "${PASSTHRU[@]+"${PASSTHRU[@]}"}"; do
  case "$a" in
    --tools|--tools=*|--no-tools)
      die "$a cannot be passed after -- (it would undo the read-only allowlist); use --tools" ;;
    --system-prompt|--system-prompt=*)
      die "$a cannot be passed after -- (it would replace the review prompt); use --prompt or --skill" ;;
    --api-key|--api-key=*)
      die "$a cannot be passed after -- ; set OPENROUTER_API_KEY in the environment instead" ;;
  esac
done

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

# Local runs are NOT stripped: this is your own working tree and deleting a
# developer's .claude/ or .omp/ would be indefensible. But the exposure is real
# whenever the branch under review came from someone else, so it is named.
#
# omp loads MCP server definitions from these directories and spawns the
# commands they name, at startup, regardless of --tools or --approval-mode.
# Refuse, rather than warn. omp loads these at startup and spawns whatever they
# name, before any tool restriction applies — so a warning printed one line
# above the thing it warns about is not a control, it is a note attached to an
# already-made decision. CI deletes them; locally we cannot delete a developer's
# own files, so the choice is explicit.
_agent_cfg=""
# `if`, not `[ test ] && assign`. When the test fails it is the last command in
# that list, so under `set -e` the script exits — silently, with no message and
# a zero-length output file. This is the same trap already documented in the
# workflow's argument assembly, repeated here three lines apart.
for _d in .omp .claude .cursor .codex .gemini .opencode .windsurf; do
  if [ -f "$_d/mcp.json" ]; then _agent_cfg="$_agent_cfg $_d/mcp.json"; fi
done
if [ -f mcp.json ]; then _agent_cfg="$_agent_cfg mcp.json"; fi
if [ -f .mcp.json ]; then _agent_cfg="$_agent_cfg .mcp.json"; fi
if [ -n "$_agent_cfg" ] && [ "${TRUST_REPO:-0}" != "1" ]; then
  _c "0;31"
  printf '  ✗ this checkout contains agent configuration:%s\n' "$_agent_cfg" >&2
  printf '    omp loads it at startup and runs whatever command it names, before\n' >&2
  printf '    any tool restriction applies. If it is yours, re-run with --trust-repo.\n' >&2
  _c "0"
  exit 1
fi

step "Working out what changed"
if [ "$STAGED" = 1 ]; then
  RANGE="--staged"
  git diff --cached --quiet && die "nothing staged"
  DIFFSTAT="$(git diff --cached --stat)"
  DIFFTEXT="$(git diff --cached --no-color)"
  INTENT=""
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
  DIFFTEXT="$(git diff --no-color "$MERGE_BASE" HEAD)"
  # -n rather than `| head`: head closes the pipe, git takes SIGPIPE, and with
  # `set -o pipefail` the whole assignment fails and `set -e` exits the script
  # with no message at all. It only showed up once this branch had enough
  # commits to fill sixty lines — which is to say, once the tool was used on a
  # real branch. Subjects only; the bodies here run to hundreds of lines.
  INTENT="$(git log --reverse -n 40 --format='- %s' "$MERGE_BASE"..HEAD)"
  RANGE="$BASE"
fi
ok "reviewing against $RANGE"
printf '%s\n' "$DIFFSTAT" | sed 's/^/    /' >&2

# Emit the diff with files in a pass-dependent order. Bugbot randomises diff
# order across its eight passes because it "nudged the model toward different
# lines of reasoning" — with a U-shaped attention bias, what sits in the middle
# changes with the order, and so does what gets noticed. Rotation rather than
# RNG so a given pass is reproducible.
ordered_diff() { # ordered_diff <pass-index>
  local pass="$1"
  # Later passes rebuild the diff per file, which bypasses the truncation the
  # first pass applied — a capped diff would silently become uncapped.
  if [ "$pass" -le 1 ] || [ "$TRUNCATED" = 1 ]; then printf '%s\n' "$DIFFTEXT"; return 0; fi
  local files n i
  if [ "$STAGED" = 1 ]; then files="$(git diff --cached --name-only --diff-filter=d)"
  else files="$(git diff --name-only --diff-filter=d "$MERGE_BASE" HEAD)"; fi
  n="$(printf '%s\n' "$files" | grep -c . || true)"
  [ "$n" -gt 1 ] || { printf '%s\n' "$DIFFTEXT"; return 0; }
  i=$(( (pass - 1) % n ))
  { printf '%s\n' "$files" | tail -n +$((i + 1)); printf '%s\n' "$files" | head -n "$i"; } \
  | while IFS= read -r f; do
      [ -n "$f" ] || continue
      if [ "$STAGED" = 1 ]; then git diff --cached --no-color -- "$f"
      else git diff --no-color "$MERGE_BASE" HEAD -- "$f"; fi
    done
}

step "Building prompt"
PROMPT_FILE="$(support "$PROMPT_FILE")" \
  || die "no review instructions at $PROMPT_FILE (looked in this repo and in $SELF_ROOT)"

# Same split as CI: review instructions and output format are separate files,
# so asking for suggested fixes does not fork the "what to look for" half.
case "$REVIEW_MODE" in
  summary) FORMAT_FILE="review/format-markdown.md" ;;
  suggest|inline) FORMAT_FILE="review/format-json.md" ;;
  *) die "--review-mode must be summary, inline or suggest (got '$REVIEW_MODE')" ;;
esac
FORMAT_FILE="$(support "$FORMAT_FILE")" \
  || die "no output format at $FORMAT_FILE (looked in this repo and in $SELF_ROOT)"

TMP_PROMPT="$(mktemp)"
# Per-lens focus text and the skill files that lens wants. A lens with an empty
# skills list gets none — the docs lens works from its own instructions, and
# giving it the infra catalogue would be the heterogeneous-knowledge mistake.
lens_focus() { # lens_focus <name>; prints the focus block, or nothing
  local f; f="$(support "review/lenses/$1.md" 2>/dev/null)" || return 1
  grep -v '^<!-- skills:' "$f"
}
lens_skills() { # lens_skills <name>; prints space-separated skill paths
  local f; f="$(support "review/lenses/$1.md" 2>/dev/null)" || return 1
  grep -oE '<!-- skills: [^>]*-->' "$f" | sed 's/<!-- skills: //; s/ *-->//'
}

build_prompt() { # build_prompt <pass-index> <destination> [lens]
# The diff goes in verbatim. It used to say only "The diff is: git diff A B",
# but the tool allowlist has no shell and no git, so the agent could never run
# that — it was reviewing the working tree while guessing from filenames what
# had changed.
DIFF_BYTES=${#DIFFTEXT}
TRUNCATED=0
if [ "$MAX_DIFF_BYTES" != "0" ] && [ "$DIFF_BYTES" -gt "$MAX_DIFF_BYTES" ]; then
  DIFFTEXT="${DIFFTEXT:0:$MAX_DIFF_BYTES}"
  TRUNCATED=1
fi
{
  cat "$PROMPT_FILE"
  echo
  if [ -n "${3:-}" ]; then echo; lens_focus "$3"; echo; fi
  # WHAT THE CHANGE IS FOR. Several defects are only visible against intent —
  # a documented token scope that cannot work, a CIDR that cannot route. With
  # no statement of intent there is nothing to contradict, and those were
  # exactly the findings this reviewer never produced. Locally the commit
  # messages are the closest thing to a PR description.
  if [ -n "${INTENT:-}" ]; then
    echo "## What this change is meant to do"
    echo
    printf '%s\n' "$INTENT"
    echo
    echo "Check the change against this. An instruction or setting that cannot"
    echo "achieve what is stated here is a defect, even if the code is valid."
    echo
  fi
  # Output contract before the diff — see the workflow for why.
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
  ordered_diff "${1:-1}"
  echo '```'
  echo
  echo "The working tree is checked out at the post-change state, so you can read any"
  echo "file as it will be after this branch lands. Use that to check what the diff depends on."
  if [ "${MAX_FINDINGS:-0}" != "0" ]; then
    echo
    echo "Report at most $MAX_FINDINGS findings. If you have more, keep the most severe."
  fi
  # Symbol/dependency index, when the project is already indexed. Deliberately
  # NOT auto-initialised: `codegraph init` writes a .codegraph/ directory into
  # the repository, and a review tool should not leave artefacts in someone's
  # working tree without being asked. Run `codegraph init` yourself to enable it.
  if [ "$USE_CODEGRAPH" = 1 ] && CG="$(support_exec scripts/codegraph.sh)" && [ -d "$REPO_ROOT/.codegraph" ]; then
    if [ "$STAGED" = 1 ]; then
      STAGED=1 PROJECT="$REPO_ROOT" bash "$CG" 2>/dev/null || true
    else
      BASE_SHA="$MERGE_BASE" HEAD_SHA="HEAD" PROJECT="$REPO_ROOT" bash "$CG" 2>/dev/null || true
    fi
  fi
  echo
  if [ "$REVIEW_MODE" = "summary" ]; then
    echo "Reply with the markdown described above, or exactly \"No findings.\""
  else
    echo "Reply with the single JSON object described above and nothing else — no prose, no code fence."
  fi
} > "$2"
}
build_prompt 1 "$TMP_PROMPT"
ok "$(wc -c < "$TMP_PROMPT" | tr -d ' ') bytes (diff ${DIFF_BYTES}B, truncated=$TRUNCATED)"

ARGS=()
[ -n "$SKILL" ] || SKILL="$SKILL_DEFAULT"
# --skill takes a comma-separated list; they are concatenated.
TMP_SKILL="$(mktemp)"; : > "$TMP_SKILL"; skill_names=""
IFS=',' read -ra _skills <<< "$SKILL"
for sk in "${_skills[@]}"; do
  sk="$(printf '%s' "$sk" | tr -d '[:space:]')"
  [ -n "$sk" ] || continue
  if resolved="$(support "$sk")"; then
    cat "$resolved" >> "$TMP_SKILL"; printf '\n\n' >> "$TMP_SKILL"
    skill_names="$skill_names $sk"
  fi
done
# Keep only the sections that apply to what changed. Rule count is the thing
# that predicts whether injected knowledge is used at all, so this matters more
# than how the rules are worded.
if SEL="$(support_exec scripts/select-skills.mjs)" && command -v node >/dev/null 2>&1 && [ -s "$TMP_SKILL" ]; then
  if [ "$STAGED" = 1 ]; then _cf="$(git diff --cached --name-only --diff-filter=d)"
  else _cf="$(git diff --name-only --diff-filter=d "$MERGE_BASE" HEAD)"; fi
  TMP_SEL="$(mktemp)"
  if CHANGED_FILES="$_cf" SKILL_FILES="$TMP_SKILL" node "$SEL" > "$TMP_SEL" 2>>"$TMP_SKILL.log" && [ -s "$TMP_SEL" ]; then
    mv "$TMP_SEL" "$TMP_SKILL"
    [ -f "$TMP_SKILL.log" ] && sed 's/^/ /' "$TMP_SKILL.log" >&2 && rm -f "$TMP_SKILL.log"
  else
    rm -f "$TMP_SEL"
  fi
fi

if [ -s "$TMP_SKILL" ]; then
  ARGS+=(--append-system-prompt="$TMP_SKILL"); ok "knowledge base:$skill_names"
else
  say "no skill file — running without injected knowledge"
fi
if [ -n "$THINKING" ]; then ARGS+=(--thinking="$THINKING"); fi
if [ -n "$MAX_TIME" ]; then ARGS+=(--max-time="$MAX_TIME"); fi
if [ ${#PASSTHRU[@]} -gt 0 ]; then ARGS+=("${PASSTHRU[@]}"); fi

step "Reviewing with $MODEL"
say "read-only tools: $TOOLS${THINKING:+ | thinking: $THINKING}${PASSES:+ | passes: $PASSES}"
TMP_OUT="$(mktemp)"

# One omp invocation. Same allowlist as CI, --tools emitted last so nothing
# passed after -- can be the winning value, and the prompt supplied as @file.
# A pass whose output cannot be parsed is wasted compute, and roughly one in
# three came back that way. omp cannot enforce a JSON schema — it has no
# structured-output mode — so the only lever is to check afterwards and retry.
# One retry, because a second failure usually means the prompt, not the dice.
run_pass_checked() { # run_pass_checked <prompt-file> <out-file>
  local attempt
  for attempt in 1 2; do
    if run_pass "$1" "$2" && [ -s "$2" ]; then
      # Only structured modes owe a findings object. summary mode answers in
      # markdown, and checking it against the JSON contract failed every time —
      # which retried, failed again, and killed the default local mode outright.
      if [ "$REVIEW_MODE" = "summary" ] || [ -z "${CHECKER:-}" ] \
         || node "$CHECKER" --check "$2" 2>/dev/null; then return 0; fi
      say "  output unparseable (attempt $attempt)"
    fi
  done
  return 1
}

run_pass() { # run_pass <prompt-file> <out-file>
  "${OMP[@]}" -p \
    --model="$MODEL" \
    --no-session \
    "${ARGS[@]+"${ARGS[@]}"}" \
    --tools="$TOOLS" \
    --approval-mode=always-ask \
    --cwd="$REPO_ROOT" \
    "@$1" \
    < /dev/null > "$2" 2>"$2.err"
}

CHECKER="$(support_exec scripts/merge-findings.mjs 2>/dev/null || true)"

if [ -n "$LENSES" ]; then
  # Lenses are ADDITIVE, not a partition. Replacing the general review with
  # narrow passes lost coverage — the security lens never saw the Caddy entry
  # that its own text calls an auth bypass. Run the general review first, then
  # each lens as a specialist on top, and merge.
  #
  # Measured: general alone 8/11, docs lens alone 5/11, the two merged 9/11 with
  # the docs pass contributing 8 findings the general pass did not make.
  PASS_OUTS=""; ok_passes=0; li=0

  GP="$(mktemp)"; GO="$(mktemp)"
  build_prompt 1 "$GP"
  if run_pass_checked "$GP" "$GO"; then
    PASS_OUTS="$PASS_OUTS $GO"; ok_passes=$((ok_passes + 1)); say "general pass ok"
  else
    say "general pass failed — continuing with lenses only"; rm -f "$GO" "$GO.err"
  fi
  rm -f "$GP"

  IFS=',' read -ra _lenses <<< "$LENSES"
  for lens in "${_lenses[@]}"; do
    lens="$(printf '%s' "$lens" | tr -d '[:space:]')"; [ -n "$lens" ] || continue
    li=$((li + 1))
    if ! lens_focus "$lens" >/dev/null 2>&1; then say "no such lens: $lens — skipping"; continue; fi

    # Swap the skill file set for this lens.
    LENS_SKILLS="$(lens_skills "$lens")"
    : > "$TMP_SKILL"
    for sk in $LENS_SKILLS; do
      if r="$(support "$sk")"; then cat "$r" >> "$TMP_SKILL"; printf '\n\n' >> "$TMP_SKILL"; fi
    done
    ARGS=()
    if [ -s "$TMP_SKILL" ]; then ARGS+=(--append-system-prompt="$TMP_SKILL"); fi
    if [ -n "$THINKING" ]; then ARGS+=(--thinking="$THINKING"); fi
    if [ -n "$MAX_TIME" ]; then ARGS+=(--max-time="$MAX_TIME"); fi
    if [ ${#PASSTHRU[@]} -gt 0 ]; then ARGS+=("${PASSTHRU[@]}"); fi

    P="$(mktemp)"; O="$(mktemp)"
    build_prompt "$li" "$P" "$lens"
    if run_pass_checked "$P" "$O"; then
      PASS_OUTS="$PASS_OUTS $O"; ok_passes=$((ok_passes + 1))
      say "lens $lens ok ($(grep -cE '^\s*[-*] ' "$TMP_SKILL" 2>/dev/null || echo 0) skill rules)"
    else
      say "lens $lens failed — continuing"; rm -f "$O" "$O.err"
    fi
    rm -f "$P"
  done
  [ "$ok_passes" -gt 0 ] || { rm -f "$TMP_PROMPT" "$TMP_OUT" "$TMP_SKILL"; die "every lens failed"; }
  merged=0
  if MERGE="$(support_exec scripts/merge-findings.mjs)" && command -v node >/dev/null 2>&1; then
    # shellcheck disable=SC2086
    if node "$MERGE" --min-votes "$MIN_VOTES" $PASS_OUTS > "$TMP_OUT"; then merged=1; fi
  fi
  if [ "$merged" = 0 ]; then cat "${PASS_OUTS%% *}" > "$TMP_OUT" 2>/dev/null || true; fi
  # shellcheck disable=SC2086
  rm -f $PASS_OUTS
elif [ "${PASSES:-1}" -le 1 ]; then
  # Checked here too. The retry originally covered only the multi-pass paths,
  # so a single pass could still return output the poster could not use — and
  # did: one benchmark run came back with zero findings and no error.
  if ! run_pass_checked "$TMP_PROMPT" "$TMP_OUT"; then
    printf '\n' >&2; sed 's/^/    /' "$TMP_OUT.err" | tail -20 >&2
    rm -f "$TMP_PROMPT" "$TMP_OUT" "$TMP_OUT.err" "$TMP_SKILL"
    die "review failed"
  fi
else
  # Repeated sampling. The same model over identical input agreed with itself
  # on only 5 of 9 findings across two runs, so a single pass systematically
  # under-reports; three passes took measured recall from 5/11 to 7/11.
  PASS_OUTS=""
  ok_passes=0
  for i in $(seq 1 "$PASSES"); do
    P="$(mktemp)"; O="$(mktemp)"
    build_prompt "$i" "$P"
    if run_pass_checked "$P" "$O"; then
      PASS_OUTS="$PASS_OUTS $O"; ok_passes=$((ok_passes + 1)); say "pass $i/$PASSES ok"
    else
      say "pass $i/$PASSES failed — continuing"
      rm -f "$O" "$O.err"
    fi
    rm -f "$P"
  done
  [ "$ok_passes" -gt 0 ] || { rm -f "$TMP_PROMPT" "$TMP_OUT" "$TMP_SKILL"; die "every pass failed"; }
  # `if` not `A && B || C`: with the && form a merge that fails would fall
  # through to C, and a merge that succeeds but exits non-zero would too.
  merged=0
  # summary passes are markdown, and the merger parses findings objects: it
  # would read every pass as unparseable and emit an empty result, silently
  # discarding the whole review. There is nothing to merge in that mode.
  if [ "$REVIEW_MODE" != "summary" ] \
     && MERGE="$(support_exec scripts/merge-findings.mjs)" && command -v node >/dev/null 2>&1; then
    # shellcheck disable=SC2086  # deliberate word splitting over the pass list
    if node "$MERGE" --min-votes "$MIN_VOTES" $PASS_OUTS > "$TMP_OUT"; then merged=1; fi
  fi
  if [ "$merged" = 0 ]; then
    say "merge unavailable — using the first successful pass"
    cat "${PASS_OUTS%% *}" > "$TMP_OUT" 2>/dev/null || true
  fi
  # shellcheck disable=SC2086  # deliberate word splitting over the pass list
  rm -f $PASS_OUTS
fi

# Remember what was said. Without this a local run has no memory: it re-reports
# everything every time and there is no way to say "seen it, it's fine". The
# pull-request side gets that from the threads; locally it has to be stored.
# Every mode records. The default local mode is `summary`, so gating this on
# non-summary meant the documented plain `review` never stored anything — the
# state feature was off by default in the only path most people use.
if ST="$(support_exec scripts/local-state.mjs)" && command -v node >/dev/null 2>&1 \
   && grep -q '"findings"' "$TMP_OUT" 2>/dev/null; then
  _head="$(git rev-parse HEAD 2>/dev/null || echo)"
  _base="${MERGE_BASE:-${BASE:-}}"
  if _delta="$(node "$ST" record "$TMP_OUT" "$_base" "$_head" 2>/dev/null)"; then
    say "state: $_delta"
  fi
fi

# Read the verdict BEFORE cleanup: $OUT is empty when printing to stdout and
# the temp file is gone by then, so a check placed afterwards can never fire.
# (`if` rather than `grep … && CLEAN=1` purely for clarity — a failing
# non-final command in a && list is exempt from set -e, so both are correct.)
CLEAN=0
if [ "$REVIEW_MODE" = "summary" ]; then
  if grep -qx "No findings." "$TMP_OUT"; then CLEAN=1; fi
elif grep -q '"findings"[[:space:]]*:[[:space:]]*\[[[:space:]]*\]' "$TMP_OUT"; then
  CLEAN=1
fi

printf '\n'
if [ -n "$OUT" ]; then
  # --out gets the raw agent output, so a JSON review stays machine-readable.
  cp "$TMP_OUT" "$OUT"; ok "written to $OUT"
elif [ "$AS_JSON" = 1 ]; then
  # Raw model output, so the findings stay machine-readable for a pipeline.
  # Progress goes to stderr throughout, so stdout is only ever the result.
  cat "$TMP_OUT"
elif [ "$REVIEW_MODE" = "summary" ]; then
  cat "$TMP_OUT"
else
  # Render the structured findings, including the fixes that would appear as
  # committable suggestions on a pull request. Shares post-review.mjs's parser
  # so the terminal and the PR cannot disagree about what the agent said.
  if command -v node >/dev/null 2>&1 && RENDERER="$(support_exec scripts/post-review.mjs)"; then
    FINDINGS_FILE="$TMP_OUT" RENDER=1 node "$RENDERER" || cat "$TMP_OUT"
  else
    cat "$TMP_OUT"
  fi
fi
rm -f "$TMP_PROMPT" "$TMP_OUT" "$TMP_OUT.err"

printf '\n' >&2
if [ "$CLEAN" = 1 ]; then
  ok "no findings"
elif [ "$FAIL_ON_FINDINGS" = 1 ]; then
  # Non-zero exit so this is usable as a pre-push hook or in a pipeline.
  _c "0;33"; printf '  ! findings above — review before pushing\n' >&2; _c "0"
  exit 1
else
  _c "0;33"; printf '  ! findings above (--no-fail set)\n' >&2; _c "0"
fi
