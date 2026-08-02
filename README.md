# agentic-review

Read-only agentic code review for GitHub pull requests, assembled from existing
tools rather than built from scratch. One command to enable on a repo.

The agent gets the diff **and** the checked-out tree, so it reviews what a diff
alone cannot show — whether a referenced config value actually exists, whether a
dependency is gitignored and therefore absent in CI, whether something is
installed but never configured.

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

No GitHub involved — it reviews a local diff and writes the result to stdout.

```bash
export OPENROUTER_API_KEY=sk-or-...
./scripts/run-review.sh                        # vs the default branch
./scripts/run-review.sh --staged               # only what's staged
./scripts/run-review.sh --review-mode suggest  # with the fixes it would offer
./scripts/run-review.sh --json | jq '.findings[].file'
```

**Works from any repository.** The prompt, output format and skill file are
resolved relative to the script itself (symlinks followed), then overridden by
the repo under review if it ships its own. So you can symlink it onto `PATH`
and run it anywhere:

```bash
ln -s "$PWD/scripts/run-review.sh" ~/.local/bin/review
cd ~/some/other/project && review --base main
```

All progress goes to stderr and only the review goes to stdout, so it pipes
cleanly. Exits non-zero when there are findings, so it also works as a pre-push
hook.

## Suggested fixes

By default the reviewer posts **inline review comments with committable
`suggestion` blocks** — the same "Commit suggestion" button you get from a
human reviewer, not a wall of prose at the bottom of the PR.

| `review_mode` | What you get |
|---|---|
| `suggest` (default) | Inline comments anchored to the offending lines, each with a ready-to-commit fix where the agent could produce a complete one |
| `inline` | The same inline comments, explanation only, no fixes |
| `summary` | One issue comment containing everything — no line anchoring |

This is a different mechanism, not a different format. A suggestion has to be
an inline review comment attached to a line range **inside the pull request's
diff**, so the agent emits structured findings (`file`, `start_line`,
`end_line`, `suggestion`) rather than markdown, and
[`scripts/post-review.mjs`](scripts/post-review.mjs) turns them into one
`POST /pulls/{n}/reviews` call.

Three things that mechanism forces, all handled:

- **Anchoring is validated against the real diff.** GitHub rejects the *entire*
  review if any single comment names a line outside the diff, so every finding
  is checked against the actual hunk ranges first. Findings that cannot anchor
  are moved into the summary instead of being dropped — a real defect in
  untouched code is still worth saying.
- **A wrong suggestion is worse than none.** The fix has to be the complete
  replacement for the lines it spans, with original indentation, because
  someone will click the button. The prompt tells the agent to emit `null`
  whenever it cannot produce that, and a comment with no suggestion is a
  perfectly good outcome.
- **The review is never lost.** If the inline post is rejected anyway, it falls
  back to posting everything as a summary rather than failing silently.

The event is always `COMMENT`, never `REQUEST_CHANGES` — use
`fail_on_findings` if you want the check itself to block.

Locally, `--review-mode suggest` prints each finding with the fix it would
offer, using the same parser as CI:

```
High — Two lines are wrong
  edge/Caddyfile:2-3
  They break the thing.
  suggested fix:
    | FIXED2
    | FIXED3
```

## Symbol index

The prompt carries a symbol and dependency index of the changed files, built
with [codegraph](https://github.com/colbymchenry/codegraph): per file, every
symbol it defines with a line number, and which other files depend on it. That
is the blast radius a diff cannot show.

It uses tree-sitter and **never runs the project's build system**, which is the
property that rules out every SCIP-class indexer here — this parses
attacker-authored pull requests. Indexing 35 Swift files takes under a second.
It soft-fails: a missing index makes a review worse, never wrong.

Two things the pull request is not allowed to influence: `codegraph.json` is
restored from the base commit before indexing, so a PR cannot `exclude` the
files it changes and hide them from its own review, and telemetry is disabled
in CI (it is on by default).

Locally it is used only if the repo is **already indexed** — `run-review.sh`
will not run `codegraph init` for you, because a review tool should not leave a
`.codegraph/` directory in your working tree uninvited:

```bash
codegraph init .        # once per project
./scripts/run-review.sh
```

## Configuration

Every knob is settable on all three surfaces, under the same name. Defaults are
defined once, in the reusable workflow — an enrolled repo that overrides nothing
keeps tracking them.

| Setting | Default | Workflow `with:` | `install-review.sh` | `run-review.sh` |
|---|---|---|---|---|
| Model slug | `openrouter/openai/gpt-5.6-luna` | `model` | `--model` | `--model` |
| Reasoning effort | model default | `thinking` | `--thinking` | `--thinking` |
| Tool allowlist | `read,grep,glob,ast_grep` | `tools` | `--tools` | `--tools` |
| Wall-clock cap | none | `max_time` | `--max-time` | `--max-time` |
| Review prompt | `review/prompt.md` | `prompt_path` | `--prompt` | `--prompt` |
| Injected knowledge | `skills/infra-review/SKILL.md` | `skills_path` | `--skill` | `--skill` |
| Review style | `suggest` | `review_mode` | `--review-mode` | `--review-mode` |
| Findings cap | `20` (`0` = none) | `max_findings` | `--max-findings` | `--max-findings` |
| Post a PR comment | `true` | `post_comment` | `--no-comment` | n/a |
| Block the PR on findings | `false` | `fail_on_findings` | `--fail-on-findings` | `--no-fail` inverts |
| Job timeout | `20` | `timeout_minutes` | n/a | n/a |
| Diff size cap | `400000` bytes | `max_diff_bytes` | n/a | `$AGENTIC_REVIEW_MAX_DIFF_BYTES` |
| Symbol index | on | `codegraph` | n/a | auto when indexed |
| Pin codegraph | latest | `codegraph_version` | n/a | n/a |
| Central repo | this repo | `central_repo` | `CENTRAL_REPO=` env | n/a |
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

The runner is **not** an input. `runs-on` is resolved before any step executes,
so a caller-supplied value cannot be validated — the validation would already be
running on the runner it was meant to vet, and `self-hosted` would put
attacker-authored PR content on a persistent machine holding your model key.

Fork pull requests are **skipped**, not failed. GitHub never passes secrets to
them, so the run cannot succeed; failing would put a red X on every outside
contribution that the contributor has no way to fix. Reviewing forks would
require `pull_request_target`, which is the trade this project refuses.

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
| `ast_grep` | Structural queries over 50+ tree-sitter grammars |

`inspect_image` and `todo` are also permitted but off by default — those six
are the entire set `tools` will accept.

Excluded: `bash`, `edit`, `write`, `ast_edit`, `eval`, `debug`, `browser`,
`computer`, `github`, `task`, `hub`, `web_search`, `memory_edit`, `retain`,
`learn`, `manage_skill`, `checkpoint`, `rewind`, `ask`, `security_scan`, `lsp`.

Three of those read as harmless and are not:

- **`lsp`** — omp discovers language-server configuration from the *project*
  directory (`lsp.json`, `.lsp.json`, `.lsp.yaml`…), and the project directory
  here is the checked-out pull request. A PR can commit an `lsp.json` naming
  any command; `lsp` is read-tier, so the approval mode auto-approves it and
  omp spawns that command with the model key in its environment. Excluding it
  cost this project cross-file symbol resolution — `ast_grep` and `grep` carry
  that load instead.
- **`security_scan`** — classified `exec` by omp, and reaches an external cloud
  service.
- **`web_search`** — network egress. `ask` also blocks forever under `-p`.

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
