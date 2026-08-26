#!/usr/bin/env bash
# Enable AI code review on a GitHub repository.
#
#   curl -fsSL https://raw.githubusercontent.com/atomikpanda/agentic-review/main/scripts/install-review.sh | bash
#
# Non-interactive:
#   ... | bash -s -- --repo owner/name --openrouter-key sk-or-... --yes
#
# Adds a reusable-workflow caller for the read-only agentic reviewer, sets the
# model key as a repo secret, and optionally writes a .pr_agent.toml for the
# self-hosted PR-Agent App. Idempotent: re-running only fills in what's missing.
#
# Setup options:
#   --repo OWNER/NAME        target repository
#   --openrouter-key KEY     stored as the OPENROUTER_API_KEY repo secret
#   --ref REF                central-repo ref to pin the workflow to (default v1;
#                            pass main to track development, or a tag/SHA to pin harder)
#   --with-pr-agent          also write .pr_agent.toml
#   --no-pr-agent            skip it
#   -y, --yes                assume yes
#
# Reviewer options — each writes one line into the generated workflow's `with:`
# block. Anything you leave unset is omitted, so it keeps tracking the central
# repo's default rather than being pinned at install time:
#   --model SLUG             provider-prefixed model slug
#   --thinking LEVEL         off|minimal|low|medium|high|xhigh|max|auto
#   --tools LIST             comma-separated read-only omp tools
#   --max-time DUR           hard cap per model pass, e.g. 600, 10m, 1h
#   --prompt FILE            review instructions path
#   --skill FILE             file appended to the system prompt
#   --review-mode M          suggest|inline|summary (default suggest)
#   --max-findings N         0 disables the cap
#   --max-discovery-rounds N  broad review rounds before human override is required
#   --max-parallel N         concurrent model pass limit
#   --fail-on-findings       make the review a blocking check
#   --no-comment             don't post a PR comment (artifact only)
#   --omp-version V          pin @oh-my-pi/pi-coding-agent
#   --bun-version V          pin bun
#   --extra-omp-args ARGS    display flags only: --print-thoughts, --hide-thinking, --no-title
#   --pr-agent-model SLUG    model for PR-Agent on this repo

set -euo pipefail

CENTRAL_REPO="${CENTRAL_REPO:-atomikpanda/agentic-review}"
# A release tag, not a branch. `@main` meant every consumer executed whatever
# was on main at the moment their pull request opened — with a token that can
# write to that pull request — so an untested commit here reached every repo
# immediately. `v1` moves only when a release is cut. Pass --ref main to track
# development, or --ref <sha> to pin harder than a moving major tag.
CENTRAL_REF="${CENTRAL_REF:-v1}"
WORKFLOW=".github/workflows/agentic-review.yml"

# --- input plumbing --------------------------------------------------------
# When piped from curl, stdin IS this script — reading from it would consume
# the script's own remaining bytes. Prompt on the terminal instead, and if
# there is no terminal (CI, container) require flags rather than hanging or
# silently reading garbage.
TTY=""
if [ -t 0 ]; then TTY="/dev/stdin"
elif [ -e /dev/tty ] && (exec 3<>/dev/tty) 2>/dev/null; then TTY="/dev/tty"
fi

REPO=""; OR_KEY=""; ASSUME_YES=0; WITH_PR_AGENT=""; PR_AGENT_MODEL=""
# Reviewer knobs. Empty means "not specified" — omitted from `with:` entirely.
I_MODEL=""; I_THINKING=""; I_TOOLS=""; I_MAX_TIME=""; I_PROMPT=""; I_SKILL=""
I_MAX_FINDINGS=""; I_MAX_DISCOVERY_ROUNDS=""; I_MAX_PARALLEL=""; I_FAIL=""; I_COMMENT=""
I_OMP_VERSION=""; I_BUN_VERSION=""; I_REVIEW_MODE=""
I_EXTRA_ARGS=""

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)             REPO="${2:-}"; shift 2 ;;
    --openrouter-key)   OR_KEY="${2:-}"; shift 2 ;;
    --ref)              CENTRAL_REF="${2:-}"; shift 2 ;;
    --with-pr-agent)    WITH_PR_AGENT=1; shift ;;
    --no-pr-agent)      WITH_PR_AGENT=0; shift ;;
    --pr-agent-model)   PR_AGENT_MODEL="${2:-}"; WITH_PR_AGENT=1; shift 2 ;;
    --model)            I_MODEL="${2:-}"; shift 2 ;;
    --thinking)         I_THINKING="${2:-}"; shift 2 ;;
    --tools)            I_TOOLS="${2:-}"; shift 2 ;;
    --max-time)         I_MAX_TIME="${2:-}"; shift 2 ;;
    --prompt)           I_PROMPT="${2:-}"; shift 2 ;;
    --skill)            I_SKILL="${2:-}"; shift 2 ;;
    --max-findings)     I_MAX_FINDINGS="${2:-}"; shift 2 ;;
    --max-discovery-rounds) I_MAX_DISCOVERY_ROUNDS="${2:-}"; shift 2 ;;
    --max-parallel)      I_MAX_PARALLEL="${2:-}"; shift 2 ;;
    --review-mode)      I_REVIEW_MODE="${2:-}"; shift 2 ;;
    --fail-on-findings) I_FAIL="true"; shift ;;
    --no-comment)       I_COMMENT="false"; shift ;;
    --omp-version)      I_OMP_VERSION="${2:-}"; shift 2 ;;
    --bun-version)      I_BUN_VERSION="${2:-}"; shift 2 ;;
    --extra-omp-args)   I_EXTRA_ARGS="${2:-}"; shift 2 ;;
    -y|--yes)           ASSUME_YES=1; shift ;;
    # Print the header comment, stopping at the first line that isn't one.
    # A line range would silently start leaking code every time the header grows.
    -h|--help)
      awk 'NR>1 && !/^#/{exit} NR>1{sub(/^# ?/,""); print}' "$0"; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

if [ -n "$I_EXTRA_ARGS" ]; then
  if [ "$I_EXTRA_ARGS" != "${I_EXTRA_ARGS//[$'\n\r']/}" ]; then
    printf '%s\n' "--extra-omp-args must not contain a newline" >&2
    exit 2
  fi
  set -f
  # shellcheck disable=SC2206  # deliberate validated word splitting
  _installer_extra=($I_EXTRA_ARGS)
  set +f
  for arg in "${_installer_extra[@]}"; do
    case "$arg" in
      --print-thoughts|--hide-thinking|--no-title) ;;
      *)
        printf 'extra-omp-args token is not permitted: %s\n' "$arg" >&2
        printf '%s\n' "permitted: --print-thoughts --hide-thinking --no-title" >&2
        exit 2 ;;
    esac
  done
fi
if [ -n "$I_MAX_DISCOVERY_ROUNDS" ]; then
  case "$I_MAX_DISCOVERY_ROUNDS" in
    *[!0-9]*|'') printf '%s\n' "--max-discovery-rounds must be a positive integer" >&2; exit 2 ;;
  esac
  [ "$I_MAX_DISCOVERY_ROUNDS" -ge 1 ] \
    || { printf '%s\n' "--max-discovery-rounds must be a positive integer" >&2; exit 2; }
fi
if [ -n "$I_MAX_PARALLEL" ]; then
  case "$I_MAX_PARALLEL" in
    *[!0-9]*|'') printf '%s\n' "--max-parallel must be a positive integer" >&2; exit 2 ;;
  esac
  [ "$I_MAX_PARALLEL" -ge 1 ] \
    || { printf '%s\n' "--max-parallel must be a positive integer" >&2; exit 2; }
fi

_c() { if [ -t 1 ]; then printf '\033[%sm' "$1"; fi; }
say()  { _c "0;36"; printf '  %s\n' "$*"; _c "0"; }
ok()   { _c "0;32"; printf '  ✓ %s\n' "$*"; _c "0"; }
warn() { _c "0;33"; printf '  ! %s\n' "$*"; _c "0"; }
die()  { _c "0;31"; printf '  ✗ %s\n' "$*" >&2; _c "0"; exit 1; }
step() { printf '\n'; _c "1;37"; printf '▸ %s\n' "$*"; _c "0"; }

prompt() { # prompt <var-description> [--secret]
  local q="$1" secret="${2:-}" val=""
  [ -n "$TTY" ] || die "no terminal available — pass --repo / --openrouter-key instead"
  if [ "$secret" = "--secret" ]; then
    printf '    %s: ' "$q" > /dev/tty; read -rs val < "$TTY"; printf '\n' > /dev/tty
  else
    printf '    %s: ' "$q" > /dev/tty; read -r val < "$TTY"
  fi
  printf '%s' "$val"
}

confirm() { # confirm <question>  -> 0 yes / 1 no
  [ "$ASSUME_YES" = 1 ] && return 0
  [ -n "$TTY" ] || return 1
  local a=""
  printf '    %s [y/N]: ' "$1" > /dev/tty; read -r a < "$TTY"
  case "$a" in [yY]*) return 0 ;; *) return 1 ;; esac
}

printf '\n'
_c "1;37"; printf '  AI code review setup\n'; _c "0"
say "adds a read-only agentic reviewer to a GitHub repo"

# --- prerequisites ---------------------------------------------------------
step "Checking prerequisites"
command -v gh  >/dev/null 2>&1 || die "gh not found — https://cli.github.com"
command -v git >/dev/null 2>&1 || die "git not found"
gh auth status >/dev/null 2>&1 || die "not logged in — run: gh auth login"
ok "gh authenticated"

# Writing under .github/workflows/ needs the `workflow` scope. Without it the
# API call fails late, after the secret has already been set, with a message
# that does not name the missing scope.
if ! gh auth status 2>&1 | grep -q "'workflow'"; then
  warn "your gh token may lack the 'workflow' scope — if the commit below is"
  warn "rejected, run: gh auth refresh -h github.com -s workflow"
fi

# --- target repo -----------------------------------------------------------
step "Target repository"
if [ -z "$REPO" ]; then
  # Prefer the repo we're standing in.
  if git rev-parse --git-dir >/dev/null 2>&1; then
    REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
  fi
  if [ -n "$REPO" ]; then
    confirm "Use $REPO?" || REPO=""
  fi
  [ -n "$REPO" ] || REPO="$(prompt 'Repository (owner/name)')"
fi
gh repo view "$REPO" >/dev/null 2>&1 || die "cannot access $REPO — check the name and your gh permissions"
ok "$REPO"

# --- model key -------------------------------------------------------------
step "Model credentials"
if gh secret list --repo "$REPO" 2>/dev/null | grep -q '^OPENROUTER_API_KEY'; then
  ok "OPENROUTER_API_KEY already set — leaving it alone"
else
  [ -n "$OR_KEY" ] || OR_KEY="$(prompt 'OpenRouter API key (https://openrouter.ai/settings/keys)' --secret)"
  [ -n "$OR_KEY" ] || die "an OpenRouter key is required"
  printf '%s' "$OR_KEY" | gh secret set OPENROUTER_API_KEY --repo "$REPO" --body-file - >/dev/null
  ok "OPENROUTER_API_KEY set"
fi

# --- workflow --------------------------------------------------------------
step "Review workflow"
# Written through the API rather than requiring a local clone, so this works
# against any repo from anywhere.
existing_sha="$(gh api "repos/${REPO}/contents/${WORKFLOW}" -q .sha 2>/dev/null || true)"
if [ -n "$existing_sha" ]; then
  if confirm "$WORKFLOW exists — overwrite?"; then :; else
    warn "keeping the existing workflow"
    existing_sha="SKIP"
  fi
fi

if [ "$existing_sha" != "SKIP" ]; then
  tmp="$(mktemp)"
  cat > "$tmp" <<YAML
# Managed by: ${CENTRAL_REPO}/scripts/install-review.sh
# Re-run that script to update. The review logic lives in the central repo, so
# improvements land here without editing this file.
name: agentic-review

on:
  pull_request_target:
    types: [opened, reopened, ready_for_review, synchronize]
  workflow_dispatch:
    inputs:
      pr_number:
        description: Pull request number to re-review after cycle exhaustion.
        required: true
        type: string
      review_cycle_override_reason:
        description: Security-critical or release-blocking reason for one additional discovery round.
        required: true
        type: string

# A called workflow cannot grant itself more than the caller has. Without
# pull-request write access a read-only default token could review successfully
# and then fail at the moment it tried to post the result.
permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    uses: ${CENTRAL_REPO}/.github/workflows/agentic-review.yml@${CENTRAL_REF}
    secrets:
      OPENROUTER_API_KEY: \${{ secrets.OPENROUTER_API_KEY }}
    with:
      target_repo: \${{ github.event_name == 'workflow_dispatch' && github.repository || '' }}
      target_pr: \${{ inputs.pr_number || '' }}
      review_cycle_override_reason: \${{ inputs.review_cycle_override_reason || '' }}
YAML

  # Only the knobs that were explicitly asked for. Everything else is left out
  # so it keeps following the central repo's default instead of being frozen at
  # whatever it happened to be on install day.
  emit() { if [ -n "$2" ]; then printf '      %s: %s\n' "$1" "$2" >> "$tmp"; fi; }
  emit model            "$I_MODEL"
  emit thinking         "$I_THINKING"
  emit tools            "$I_TOOLS"
  emit max_time         "$I_MAX_TIME"
  emit prompt_path      "$I_PROMPT"
  emit skills_path      "$I_SKILL"
  emit review_mode      "$I_REVIEW_MODE"
  # A pinned install must pin the support files too, or pinned workflow logic
  # runs against whatever main happens to hold. The comparison is against
  # `main` because that is the central workflow's own default for this input —
  # anything else has to be stated. Since CENTRAL_REF now defaults to v1, the
  # normal install emits `central_ref: v1` and both halves stay in step.
  if [ "$CENTRAL_REF" != "main" ]; then emit central_ref "$CENTRAL_REF"; fi
  emit max_findings     "$I_MAX_FINDINGS"
  emit max_discovery_rounds "$I_MAX_DISCOVERY_ROUNDS"
  emit max_parallel     "$I_MAX_PARALLEL"
  emit fail_on_findings "$I_FAIL"
  emit post_comment     "$I_COMMENT"
  emit omp_version      "$I_OMP_VERSION"
  emit bun_version      "$I_BUN_VERSION"
  emit extra_omp_args   "$I_EXTRA_ARGS"

  cat >> "$tmp" <<'YAML'

# Everything the reviewer accepts, with its default. To override one, add it
# under a `with:` block indented beneath `review:` above (create the block if
# it isn't there). Keys you leave out keep tracking the central repo, so they
# improve as it does rather than being frozen at install time.
#
#   model:            openrouter/openai/gpt-5.6-luna
#   thinking:         ''            # off|minimal|low|medium|high|xhigh|max|auto
#   tools:            read,grep,glob
#                                   # lsp is NOT available: omp loads language
#                                   # server config from the reviewed repo and
#                                   # would spawn commands it names
#   max_time:         ''            # e.g. 600, 10m, 1h
#   prompt_path:      review/prompt.md
#   skills_path:      skills/infra-review/SKILL.md,skills/security-review/SKILL.md
#   review_mode:      suggest       # suggest | inline | summary
#   central_ref:      main          # pin support files to the same ref
#   max_findings:     20            # 0 disables the cap
#   max_discovery_rounds: 2           # broad rounds; verification retries do not count
#   max_parallel:     1             # concurrent model pass limit
#   post_comment:     true
#   fail_on_findings: false         # true makes this a blocking check
#   timeout_minutes:  20
#   max_diff_bytes:   400000        # 0 sends the whole diff
#   bun_version:      latest        # omp needs >= 1.3.14 and is bun-only
#   omp_version:      latest        # pin for reproducible reviews
#   extra_omp_args:   ''            # display only: --print-thoughts, --hide-thinking, --no-title
YAML

  args=(-f "message=chore: enable agentic code review"
        -f "content=$(base64 < "$tmp" | tr -d '\n')")
  [ -n "$existing_sha" ] && args+=(-f "sha=$existing_sha")
  gh api -X PUT "repos/${REPO}/contents/${WORKFLOW}" "${args[@]}" >/dev/null
  rm -f "$tmp"
  ok "$WORKFLOW committed"
fi

# --- optional: PR-Agent repo config ---------------------------------------
step "PR-Agent (optional)"
say "PR-Agent is a separate self-hosted GitHub App. It needs no workflow file,"
say "but a .pr_agent.toml lets this repo tune what it does."
if [ -z "$WITH_PR_AGENT" ]; then
  if confirm "Add a .pr_agent.toml?"; then WITH_PR_AGENT=1; else WITH_PR_AGENT=0; fi
fi

if [ "$WITH_PR_AGENT" = 1 ]; then
  if gh api "repos/${REPO}/contents/.pr_agent.toml" >/dev/null 2>&1; then
    ok ".pr_agent.toml already present — leaving it alone"
  else
    tmp="$(mktemp)"
    cat > "$tmp" <<'TOML'
# PR-Agent config for this repo. Read from the default branch by the
# self-hosted App — no redeploy needed to change it.

[config]
# Dependency bots open frequent, tiny PRs. Reviewing them costs three model
# calls to read a version bump.
ignore_pr_authors = ["renovate[bot]", "dependabot[bot]"]
ignore_pr_labels = ["dependencies"]
TOML
    if [ -n "$PR_AGENT_MODEL" ]; then
      # The App's own .secrets.toml sets the default; this overrides it for
      # this repo only. custom_model_max_tokens has to travel with it —
      # PR-Agent's token table has no "openrouter/..." entries, so a model set
      # without a declared window fails every run.
      cat >> "$tmp" <<TOML
model = "${PR_AGENT_MODEL}"
# Required whenever model is set here: PR-Agent's built-in token table is keyed
# on exact model names and has no openrouter/* entries. Adjust to the window
# the model above actually advertises.
custom_model_max_tokens = 1050000
max_model_tokens = 200000
TOML
    fi
    cat >> "$tmp" <<'TOML'

[github_app]
pr_commands = [
    "/describe --pr_description.final_update_message=false",
    "/review",
]

[pr_reviewer]
enable_help_text = false
TOML
    gh api -X PUT "repos/${REPO}/contents/.pr_agent.toml" \
      -f "message=chore: add pr-agent config" \
      -f "content=$(base64 < "$tmp" | tr -d '\n')" >/dev/null
    rm -f "$tmp"
    ok ".pr_agent.toml committed${PR_AGENT_MODEL:+ (model: $PR_AGENT_MODEL)}"
  fi
fi

# --- done ------------------------------------------------------------------
printf '\n'
ok "review enabled on $REPO"
printf '\n'
say "Open a PR — the agentic reviewer runs on open and on every push."
say "Drafts are skipped; superseded runs are cancelled."
say "Every knob is listed at the bottom of $WORKFLOW."
printf '\n'
say "Cost is roughly \$0.10–0.30 per review on gpt-5.6-luna."
if [ "$WITH_PR_AGENT" = 1 ]; then
  printf '\n'
  warn "PR-Agent also needs its GitHub App installed on $REPO."
  warn "The .pr_agent.toml alone does nothing until it is."
fi
printf '\n'
