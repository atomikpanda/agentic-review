#!/usr/bin/env bash
# Watch a pull request for new review comments and show them as they arrive.
#
#   ./scripts/watch-pr.sh 42                 # this repo, PR 42
#   ./scripts/watch-pr.sh 42 --repo o/n
#   ./scripts/watch-pr.sh 42 --interval 60
#   ./scripts/watch-pr.sh 42 --once
#
# Read-only: it polls and prints. It never comments, resolves or edits, so it is
# safe to leave running against someone else's pull request.
#
# Needs: gh, authenticated.

set -euo pipefail

PR=""; REPO=""; INTERVAL=30; ONCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo)     REPO="${2:-}"; shift 2 ;;
    --interval) INTERVAL="${2:-30}"; shift 2 ;;
    --once)     ONCE=1; shift ;;
    -h|--help)  awk 'NR>1 && !/^#/{exit} NR>1{sub(/^# ?/,""); print}' "$0"; exit 0 ;;
    *)          PR="$1"; shift ;;
  esac
done

_c() { if [ -t 1 ]; then printf '\033[%sm' "$1"; fi; }
die() { _c "0;31"; printf '  ✗ %s\n' "$*" >&2; _c "0"; exit 1; }

command -v gh >/dev/null 2>&1 || die "gh not found"
# BSD base64 on macOS spells the decode flag -D and rejects GNU's --decode, so
# every comment body would have arrived empty on the platform this is developed
# on. Pick whichever the local binary accepts.
if printf '' | base64 --decode >/dev/null 2>&1; then B64D="base64 --decode"; else B64D="base64 -D"; fi
[ -n "$PR" ] || die "which pull request? usage: watch-pr.sh <number> [--repo owner/name]"
[ -n "$REPO" ] || REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)" \
  || die "not in a GitHub repo — pass --repo owner/name"

# Track what has already been shown, so a restart does not replay the thread.
SEEN="$(git rev-parse --git-common-dir 2>/dev/null || echo .)/agentic-review/watch-$PR.seen"
mkdir -p "$(dirname "$SEEN")"; : >> "$SEEN"

_c "1;37"; printf '▸ watching %s#%s (every %ss, ctrl-c to stop)\n' "$REPO" "$PR" "$INTERVAL"; _c "0"

while :; do
  gh api "repos/$REPO/pulls/$PR/comments?per_page=100" --paginate \
    --jq '.[] | [.id, .user.login, .path, (.line // .original_line // 0), (.body|@base64)] | @tsv' 2>/dev/null \
  | while IFS=$'\t' read -r id who path line body; do
      grep -qx "$id" "$SEEN" && continue
      printf '%s\n' "$id" >> "$SEEN"
      _c "0;36"; printf '\n● %s  %s:%s\n' "$who" "$path" "$line"; _c "0"
      printf '%s' "$body" | $B64D 2>/dev/null | head -12 | sed 's/^/    /'
    done
  [ "$ONCE" = 1 ] && break
  sleep "$INTERVAL"
done
