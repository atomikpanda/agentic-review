# agentic-review

Read-only agentic code review for GitHub pull requests, assembled from existing
tools rather than built from scratch. One command to enable on a repo.

It reviews what a diff cannot show — whether a referenced config value actually
exists, whether a dependency is gitignored and therefore absent in CI, whether
something is installed but never configured.

## Enable on a repo

```bash
curl -fsSL https://raw.githubusercontent.com/atomikpanda/agentic-review/main/scripts/install-review.sh | bash
```

Sets `OPENROUTER_API_KEY` as a repo secret and commits a five-line caller
workflow. The review logic stays here, so improvements reach every enrolled
repo without touching them again.

Non-interactive:

```bash
curl -fsSL .../install-review.sh | bash -s -- --repo owner/name --openrouter-key sk-or-... --yes
```

## Run it locally

```bash
export OPENROUTER_API_KEY=sk-or-...
./scripts/run-review.sh            # vs the default branch
./scripts/run-review.sh --staged   # only what's staged
```

Exits non-zero when there are findings, so it works as a pre-push hook.

## How it works

[oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) runs headless with a
read-only tool allowlist:

| Enabled | Why |
|---|---|
| `read`, `grep`, `glob` | Read files the diff depends on but doesn't touch |
| `lsp` | Cross-file symbol resolution |
| `ast_grep` | Structural queries over 50+ tree-sitter grammars |

Excluded: `bash`, `edit`, `write`, `ast_edit`, `eval`, `debug`, `python`,
`browser`, `computer`, `github`, `task`, `web_search`, `memory_edit`.

A PR diff is attacker-controlled text and this agent reads it, so it must not
be able to execute anything, modify the checkout, reach the network, or write
back to GitHub. `omp` validates the allowlist, so a typo fails loudly rather
than silently enabling everything.

It runs on GitHub's ephemeral runners, not your own infrastructure, so
untrusted PR content is processed in a throwaway VM. That is a deliberate
choice over a self-hosted GitHub App, which would trade one command per repo
for running attacker-controlled input next to your production secrets.

The workflow uses `pull_request`, never `pull_request_target` — the latter runs
a writable token against untrusted head code.

## Knowledge injection

[`skills/infra-review/SKILL.md`](skills/infra-review/SKILL.md) is a catalogue of
tool-default behaviours that look correct in a diff and fail silently in
production — the leftmost `X-Forwarded-For` entry, `runcmd` without `set -e`,
`BucketAlreadyExists` meaning someone else owns the name.

It follows the [agent-skills](https://github.com/The-PR-Agent/pr-agent/issues/2384)
`SKILL.md` format, so the same file also works with PR-Agent's Agent Skills.

Enrolled repos inherit it automatically. A repo can override by adding its own
`skills/infra-review/SKILL.md`.

## Why layered

No single tool covers everything. Categorised from a real 19-finding review:

| Tier | Tool | Cost/PR | Catches |
|---|---|---|---|
| Deterministic | shellcheck, actionlint, hadolint, tflint, trivy, gitleaks | $0 | Tool-specific rules, IaC misconfig, secrets |
| Semantic | PR-Agent + skills | ~$0.02 | Tool-behaviour knowledge, single-file logic |
| Agentic | this | ~$0.10–0.30 | Cross-file discovery |

PR-Agent makes single-shot model calls with no tool-use loop — [its own docs say
so](https://github.com/The-PR-Agent/pr-agent/blob/main/docs/docs/core-abilities/agent_skills.md)
— so it cannot read a file outside the diff. That is the gap this fills.

Keep exactly one reviewer commenting automatically, or every PR collects
overlapping sets of inline comments.

## Cost

Roughly $0.10–0.30 per review on `gpt-5.6-luna` ($0.10/Mtok in). Agentic cost
scales with how much the agent explores, so it is less predictable than a
single-shot reviewer — bound it with the workflow's `timeout-minutes`.

## Licence

MIT.
