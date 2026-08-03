#!/usr/bin/env bash
# The one list of agent configuration that must not survive into a review, and
# the two things we do with it.
#
# WHY THIS EXISTS AT ALL. omp loads MCP server definitions from these locations
# and spawns the commands they name at startup — before --tools and before
# --approval-mode apply. A read-only tool allowlist is therefore not the
# boundary it looks like: a pull request that commits .omp/mcp.json executes
# arbitrary commands with the review's environment. That was found live in this
# project's own CI, and the first fix was incomplete — it removed the agent
# DIRECTORIES and left ./mcp.json and ./.mcp.json loadable, which the reviewer
# then caught on its own pull request.
#
# WHY IT IS A SEPARATE FILE. The list was written out twice, once in the
# workflow and once in scripts/run-review.sh, and it drifted twice. First
# `.cline` was in one and not the other. Then CI grew four nested paths
# (.github/ and .vscode/) that the local copy never learned about, so a local
# run — on your own machine, with your own SSH keys and cloud credentials —
# checked strictly fewer places than the ephemeral runner did. One file, read
# by both.
#
# Usage:
#   strip-agent-config.sh --strip <dir>   delete them; THROWAWAY CHECKOUTS ONLY
#   strip-agent-config.sh --check <dir>   print what is present; exit 1 if any
#
# --strip is destructive by design and must never be pointed at a working tree
# somebody edits. CI runs it on a runner checkout; run-review.sh runs it on a
# git worktree it created and removes.

set -euo pipefail

# Directories: removed whole. More than mcp.json inside them is executable —
# hooks, settings, language-server definitions — so removing just the one file
# would leave the class open.
AGENT_DIRS=(.omp .claude .codex .gemini .opencode .cursor .windsurf .cline)

# Files: root-level and editor/CI locations that name a command directly.
AGENT_FILES=(
  mcp.json
  .mcp.json
  .github/mcp.json
  .github/ssh.json
  .vscode/mcp.json
  .vscode/ssh.json
)

mode="${1:-}"
target="${2:-.}"

case "$mode" in
  --strip|--check) ;;
  *) echo "usage: strip-agent-config.sh --strip|--check <dir>" >&2; exit 2 ;;
esac

[ -d "$target" ] || { echo "not a directory: $target" >&2; exit 2; }
cd "$target"

found=""

for d in "${AGENT_DIRS[@]}"; do
  [ -e "$d" ] || continue
  found="$found $d/"
  if [ "$mode" = "--strip" ]; then rm -rf -- "$d"; fi
done

for f in "${AGENT_FILES[@]}"; do
  [ -e "$f" ] || continue
  found="$found $f"
  if [ "$mode" = "--strip" ]; then rm -f -- "$f"; fi
done

if [ -z "$found" ]; then
  exit 0
fi

if [ "$mode" = "--strip" ]; then
  printf 'removed agent configuration:%s\n' "$found"
  exit 0
fi

printf '%s\n' "$found"
exit 1
