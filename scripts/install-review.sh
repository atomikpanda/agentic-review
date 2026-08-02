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

set -euo pipefail

CENTRAL_REPO="${CENTRAL_REPO:-atomikpanda/agentic-review}"
CENTRAL_REF="${CENTRAL_REF:-main}"
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

REPO=""; OR_KEY=""; ASSUME_YES=0; WITH_PR_AGENT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo)            REPO="${2:-}"; shift 2 ;;
    --openrouter-key)  OR_KEY="${2:-}"; shift 2 ;;
    --with-pr-agent)   WITH_PR_AGENT=1; shift ;;
    --no-pr-agent)     WITH_PR_AGENT=0; shift ;;
    -y|--yes)          ASSUME_YES=1; shift ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

_c() { [ -t 1 ] && printf '\033[%sm' "$1" || true; }
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
  pull_request:
    types: [opened, reopened, ready_for_review, synchronize]

jobs:
  review:
    uses: ${CENTRAL_REPO}/.github/workflows/agentic-review.yml@${CENTRAL_REF}
    secrets:
      OPENROUTER_API_KEY: \${{ secrets.OPENROUTER_API_KEY }}
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
    ok ".pr_agent.toml committed"
  fi
fi

# --- done ------------------------------------------------------------------
printf '\n'
ok "review enabled on $REPO"
printf '\n'
say "Open a PR — the agentic reviewer runs on open and on every push."
say "Drafts are skipped; superseded runs are cancelled."
printf '\n'
say "Cost is roughly \$0.10–0.30 per review on gpt-5.6-luna."
if [ "$WITH_PR_AGENT" = 1 ]; then
  printf '\n'
  warn "PR-Agent also needs its GitHub App installed on $REPO."
  warn "The .pr_agent.toml alone does nothing until it is."
fi
printf '\n'
