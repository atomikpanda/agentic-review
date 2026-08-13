#!/usr/bin/env bash
# Verify every executable default names tools accepted by the OMP version CI installs.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OMP_VERSION="${OMP_VERSION:-latest}"
MISSING_MODEL="definitely-not-a-provider/agentic-review-contract-test"

workflow_tools="$(sed -n '/^      tools:$/,/^      [a-z_][a-z_]*:$/s/^        default: //p' "$ROOT/.github/workflows/agentic-review.yml")"
runner_tools="$(sed -n 's/^TOOLS="${AGENTIC_REVIEW_TOOLS:-\([^}]*\)}"$/\1/p' "$ROOT/scripts/run-review.sh")"

[ -n "$workflow_tools" ] || { echo "could not resolve workflow tool default" >&2; exit 1; }
[ -n "$runner_tools" ] || { echo "could not resolve local runner tool default" >&2; exit 1; }

check_tools() {
  local surface="$1" tools="$2" output
  output="$(bunx --bun "@oh-my-pi/pi-coding-agent@$OMP_VERSION" \
    -p --no-extensions --no-skills \
    --tools="$tools" --model="$MISSING_MODEL" x 2>&1 || true)"

  if [[ "$output" == *"Unknown tool in --tools"* ]]; then
    printf '%s default is incompatible with omp@%s: %s\n' "$surface" "$OMP_VERSION" "$tools" >&2
    printf '%s\n' "$output" >&2
    return 1
  fi
  if [[ "$output" != *"Model \"$MISSING_MODEL\" not found"* ]]; then
    printf '%s tool probe failed before the expected model boundary:\n%s\n' "$surface" "$output" >&2
    return 1
  fi
}

check_tools workflow "$workflow_tools"
check_tools local-runner "$runner_tools"
printf 'OMP tool contract accepted for workflow and local runner: %s\n' "$workflow_tools"
