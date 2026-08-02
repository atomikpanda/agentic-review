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

## Configuration

Every knob is settable on all three surfaces, under the same name. Defaults are
defined once, in the reusable workflow — an enrolled repo that overrides nothing
keeps tracking them.

| Setting | Default | Workflow `with:` | `install-review.sh` | `run-review.sh` |
|---|---|---|---|---|
| Model slug | `openrouter/openai/gpt-5.6-luna` | `model` | `--model` | `--model` |
| Reasoning effort | model default | `thinking` | `--thinking` | `--thinking` |
| Tool allowlist | `read,grep,glob,lsp,ast_grep` | `tools` | `--tools` | `--tools` |
| Wall-clock cap | none | `max_time` | `--max-time` | `--max-time` |
| Review prompt | `review/prompt.md` | `prompt_path` | `--prompt` | `--prompt` |
| Injected knowledge | `skills/infra-review/SKILL.md` | `skills_path` | `--skill` | `--skill` |
| Findings cap | `20` (`0` = none) | `max_findings` | `--max-findings` | `--max-findings` |
| Post a PR comment | `true` | `post_comment` | `--no-comment` | n/a |
| Block the PR on findings | `false` | `fail_on_findings` | `--fail-on-findings` | `--no-fail` inverts |
| Runner label | `ubuntu-latest` | `runs_on` | n/a | n/a |
| Job timeout | `20` | `timeout_minutes` | n/a | n/a |
| Pin bun | `latest` | `bun_version` | `--bun-version` | n/a |
| Pin omp | `latest` | `omp_version` | `--omp-version` | `--omp-version` |
| Any other omp flag | none | `extra_omp_args` | `--extra-omp-args` | after `--` |

`thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` or
`auto`. `max_time` accepts `600`, `10m`, `1h`.

In a workflow:

```yaml
jobs:
  review:
    uses: atomikpanda/agentic-review/.github/workflows/agentic-review.yml@main
    secrets:
      OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
    with:
      model: openrouter/anthropic/claude-sonnet-5
      thinking: high
      max_time: 12m
      fail_on_findings: true
```

At install time — the same values, written into the caller for you:

```bash
curl -fsSL .../install-review.sh | bash -s -- \
  --repo owner/name --yes \
  --model openrouter/anthropic/claude-sonnet-5 --thinking high --max-time 12m
```

Locally, every flag also reads an `AGENTIC_REVIEW_*` environment default, so you
can set them once in your shell profile:

```bash
export AGENTIC_REVIEW_MODEL=openrouter/anthropic/claude-sonnet-5
export AGENTIC_REVIEW_THINKING=high
./scripts/run-review.sh -- --add-dir ../shared-config
```

### What is not configurable

`tools` is validated against the read-only set below and the job fails on
anything outside it. `extra_omp_args` (and anything after `--` locally) rejects
`--tools`, `--no-tools`, `--system-prompt`, `--api-key`, `--approval-mode`,
`--auto-approve` and `--yolo`, and the validated `--tools` is emitted last on the
command line so it wins regardless. Widening the reviewer to write or execute is
a fork, not a flag — see below for why.

## PR-Agent

PR-Agent is configured separately, in each repo's `.pr_agent.toml`, which the
self-hosted App reads from the default branch. `install-review.sh --pr-agent-model`
writes one. Setting a model there also writes `custom_model_max_tokens`, which is
mandatory: PR-Agent's token table is keyed on exact model names and has no
`openrouter/*` entries, so a model set without a declared context window fails
every run.

## How it works

[oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) runs headless with a
read-only tool allowlist:

| Enabled | Why |
|---|---|
| `read`, `grep`, `glob` | Read files the diff depends on but doesn't touch |
| `lsp` | Cross-file symbol resolution |
| `ast_grep` | Structural queries over 50+ tree-sitter grammars |

`inspect_image` and `todo` are also permitted but off by default — those seven
are the entire set `tools` will accept.

Excluded: `bash`, `edit`, `write`, `ast_edit`, `eval`, `debug`, `browser`,
`computer`, `github`, `task`, `hub`, `web_search`, `memory_edit`, `retain`,
`learn`, `manage_skill`, `checkpoint`, `rewind`, `ask`, `security_scan`.

Two of those read as harmless and are not: `security_scan` is classified
`exec` by omp and reaches an external cloud service, and `web_search` egresses
to the network. `ask` blocks forever under `-p`.

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
single-shot reviewer. Three knobs bound it: `max_time` (a hard cap omp enforces
itself), `timeout_minutes` (the job ceiling), and `thinking` — dropping to `low`
or `off` cuts reasoning tokens, which dominate on a large diff.

## Requirements

`omp` ships `#!/usr/bin/env bun`, imports `bun:` builtins, and declares
`engines.bun >= 1.3.14`. It does not run under node — attempting it fails with
`ERR_UNSUPPORTED_ESM_URL_SCHEME`, and an older bun fails with a minified
`SyntaxError`. CI installs bun via `oven-sh/setup-bun`; `run-review.sh` checks
the local version before it starts and says so if it is too old.

## Licence

MIT.
