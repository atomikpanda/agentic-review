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

Local runs use the same bounded ensemble as hosted reviews and remember what
they have already said.

```bash
review                       # review vs the default branch
review --review-mode suggest # with the fixes it would offer on a PR
review --open                # findings still open from earlier runs
review --dismiss a1b2c3      # stop reporting one you have judged
review --history             # past runs
```

State lives in the repository's git common directory — per-repo, shared across
worktrees, never committable. Each run reports `N new, N recurring` rather than
re-listing everything. A finding is marked **gone** only when a complete review
omits it after a changed hunk overlaps its latest confirmed inclusive line span.
An inconclusive review, an unrelated change in the same file, an invalid old
span, or an indeterminate Git result keeps it open: a later sample failing to
mention it is not the same as it being fixed.

[`skills/review-loop/SKILL.md`](skills/review-loop/SKILL.md) describes the
bounded review/fix workflow, including its three-round stop.

[`scripts/watch-pr.sh`](scripts/watch-pr.sh) tails a pull request's review
comments as they arrive. Read-only — it never comments, resolves or edits.

## Suppressing writes

`suppress_writes: true` (workflow) produces the review and changes **nothing** on
the pull request: no comment, no resolved thread, no edited comment. The
artifact is still uploaded and `fail_on_findings` still applies. Use it to trial
a configuration against a live pull request without touching it.

`post_comment: false` is retained as a compatibility switch and also suppresses
review writes; `suppress_writes` is the explicit choice for trial runs.

## Run it locally (details)

No GitHub is involved. The default terminal output is a structured rendering of
the findings result and metadata; `--json` emits only the structured findings
document.

```bash
export OPENROUTER_API_KEY=sk-or-v1-yourkeyhere   # or see OPENROUTER_API_KEY_FILE
./scripts/run-review.sh                          # vs the default branch
./scripts/run-review.sh --staged                 # only what's staged
./scripts/run-review.sh --review-mode suggest    # with the fixes it would offer
./scripts/run-review.sh --json | jq '.findings[].file'
./scripts/run-review.sh --out review.json --metadata-out review-meta.json
./scripts/run-review.sh --no-state               # leave local history unchanged
```

`--out FILE` atomically writes the validated structured findings result.
Normally it is the union of every valid pass. If union fails, the runner
preserves the first valid structured pass and marks the separate schema-v1
metadata inconclusive rather than presenting the fallback as merged.
`--metadata-out FILE` writes that bounded-run metadata: immutable base and head
SHAs, the configuration fingerprint, diff and cap status, requested/completed
pass identifiers, per-pass status, and `analysis_state`. Both outputs reject a
symlink destination before model work, and the paths must resolve to different
destinations. `--no-state` still reads existing history for the
rendered state and exit status but never mutates it. Advanced local experiments
can change the ensemble with `--passes N`, `--lenses a,b,c`, and
`--min-votes N`; pass/lens changes appear in the metadata identifiers, and all
three change the configuration fingerprint. A vote threshold above one is
experimental and always inconclusive. If it would hide any valid finding, the
runner emits the complete union instead so state, history, and safety gating
retain that evidence.

**Works from any repository.** The prompt, output format and skill file are
resolved relative to the script itself (symlinks followed), then overridden by
the repo under review if it ships its own. So you can symlink it onto `PATH`
and run it anywhere:

```bash
ln -s "$PWD/scripts/run-review.sh" ~/.local/bin/review
cd ~/some/other/project && review --base main
```

Keeping the key out of shell history: set `OPENROUTER_API_KEY_FILE` to a file
containing it instead of passing the value inline.

```bash
printf '%s' 'sk-or-v1-...' > ~/.config/openrouter-key && chmod 600 ~/.config/openrouter-key
OPENROUTER_API_KEY_FILE=~/.config/openrouter-key ./scripts/run-review.sh
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
| `summary` | One standing issue comment rendered from the structured findings result and metadata — no line anchoring |

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

## Bounded ensemble and result states

The default local and hosted profile runs three sequential passes — **general**,
**correctness**, and **boundaries** — against one immutable base SHA, head SHA,
and configuration fingerprint. It performs approximately three times the model
work of one general pass. Each pass gets one retry if its output is malformed.
Every valid pass contributes to one union with `min_votes=1`, so a finding seen
by only one pass survives. One result is rendered or posted: the union, or an
explicitly inconclusive first-valid structured fallback if union fails.

The result separates four primary operator-visible values:

| Output | Values | Meaning |
|---|---|---|
| `analysis_state` | `complete`, `inconclusive` | Whether every requested pass returned valid structured output for the same immutable snapshot and configuration, the complete diff was included, no pass reached its findings cap, and the union succeeded |
| `merge_state` | `ready`, `blocked` | Whether any current or held finding has a severity in `block_severities` |
| `sample_state` | `clean`, `findings`, `unknown` | Whether actionable evidence remains; `clean` additionally requires complete analysis and known reconciliation |
| `bounded_converged` | `true`, `false` | `true` exactly when `analysis_state=complete` **and** `sample_state=clean` |

The additive final-result contract also exposes:

- `reviewed_head`, which is exactly `head_sha`;
- `scope_hash`, the SHA-256 of canonical JSON
  `{base_sha, configuration_fingerprint, diff, head_sha}`;
- `coverage`, which is `bounded` only when the configured execution completed
  against its immutable snapshot, and otherwise `unknown`;
- `remaining_analysis`, a JSON reason-code array; and
- `converged`, an exact alias of `bounded_converged`.

A successful configured execution has `remaining_analysis=[]`. Otherwise reason
codes appear once in this deterministic order:

| Reason code | Meaning |
|---|---|
| `diff_truncated` | The configured diff byte limit omitted part of the diff |
| `finding_cap_reached` | At least one pass reached its finding cap |
| `pass_failed` | A configured pass did not return valid structured output |
| `snapshot_mutable` | The reviewed snapshot was not immutable |
| `pass_scope_mismatch` | Passes did not share the same base, head, or configuration |
| `merge_failed` | Valid pass results could not be merged |
| `reconciliation_unknown` | Prior finding state could not be reconciled safely |
| `execution_failed` | Hosted execution or final-result construction failed |

In short, `complete` qualifies execution, `ready` applies the configured
severity policy, `clean` describes the reconciled bounded sample, and bounded
convergence requires both complete analysis and a clean sample.

These values are deliberately independent. `merge_state=ready` only says that
no unresolved finding crosses the configured merge gate; it may coexist with
Medium findings or with an incomplete analysis. It does not mean the sample is
clean. `sample_state=clean` means the complete bounded sample and prior
reconciled evidence contain no actionable finding; it does not claim exhaustive
repository coverage.

A mutable snapshot, failed pass after its retry, base/head/configuration
mismatch, truncated diff, findings cap, or failed union makes analysis
`inconclusive`. Known findings still produce `sample_state=findings`; no known
finding produces `sample_state=unknown`, never `clean`. None of those runs can
set `bounded_converged=true`.

`fail_on_findings: true` fails the hosted job only when
`merge_state=blocked`. Without it, job success means execution succeeded, not
that the sample was clean or converged.

Hard execution failures still run the hosted poster. Missing or invalid review
artifacts are never posted to the pull request; the poster emits a conservative
final result (`analysis_state=inconclusive`, `sample_state=unknown`,
`coverage=unknown`, both convergence fields `false`, and
`remaining_analysis` including `execution_failed`) and exits nonzero so an
earlier runner failure cannot be hidden.

The reusable workflow exposes these exact outputs:

| Output | Content |
|---|---|
| `analysis_state`, `merge_state`, `sample_state`, `bounded_converged` | The four primary result values above |
| `reviewed_head`, `scope_hash`, `coverage`, `remaining_analysis`, `converged` | Immutable reviewed head and scope plus bounded coverage, outstanding reason codes, and the convergence alias |
| `base_sha`, `head_sha`, `configuration_fingerprint` | The immutable review identity |
| `passes_requested`, `passes_completed` | Counts of configured and valid passes |
| `current_counts`, `unresolved_counts` | JSON severity maps for current and held findings |

The same values appear in the review body and GitHub job summary. The hosted
`agentic-review` artifact retains the final result (`review-result.json`),
structured findings (`review.md`), bounded-run metadata (`review-meta.json`),
and runner stdout and stderr for seven days. The poster writes the final result
at `/tmp/review-result.json` before artifact upload. Locally, `--out` and
`--metadata-out` write the findings and metadata artifacts directly.

### Standing summaries and finding history

Summary mode does not ask the model for Markdown. It deterministically renders
the same structured findings result and metadata used by inline and suggest
modes.

When findings exist, summary mode maintains one bot-authored standing issue
comment with an embedded state marker and edits it on later runs instead of
appending another. A no-findings run creates no empty comment, but updates an
existing standing comment when prior findings can be retired. Deleting that
comment explicitly resets summary-mode history.

Because the standing summary is an issue comment, it has no per-finding GitHub
resolved-thread signal; use `inline` or `suggest` when that signal is required.

A prior finding omitted by a later stochastic sample remains held while the run
is inconclusive or its original span is unchanged or indeterminate, and still
affects `merge_state`/`sample_state`. It is retired only when a complete run
confirms that span changed. Suppressed-write runs read and reconcile the standing
state for outputs and gating but do not edit it. If identity lookup or
reconciliation fails, the comment is left untouched and the result cannot be
clean or converged.

Only the currently authenticated **Bot** identity can own standing state. A
human user's manual PAT or an unrecognized viewer makes identity unknown; the
poster emits conservative outputs and gate state but suppresses every PR write.
It neither trusts nor edits a marker in a human or attacker-authored comment.

Inline and suggest modes use bot-authored fingerprinted threads. A recurring
finding stays silent while its thread is open and is not repeated in a new
review body. An omitted open finding stays held when the run is inconclusive or
its span is unchanged or indeterminate. After a complete run confirms a span
change, `resolve_stale` removes it from held state; a write-enabled run then
retires the thread when the token permits. `GITHUB_TOKEN` cannot resolve review
threads, so the fallback edits the bot's own comment to mark it no longer
reported. Human-resolved findings stay dismissed while their span is unchanged
and may be raised again only after an overlapping change. Thread-query or
change-state uncertainty is conservative: it cannot manufacture a clean result.

The event is always `COMMENT`, never `REQUEST_CHANGES`; use
`fail_on_findings` if the merge gate should fail the check.

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

## Reviewer model

Use a model from a **different family than whatever wrote the code**. Greptile
measured AI reviewers on 500 Claude-authored and 500 Codex-authored PRs, three
runs each, and found a consistent same-author penalty on high-severity bugs:

| Reviewer | Claude-authored code | GPT-authored code |
|---|---|---|
| Claude | 53.7% | **60.0%** |
| GPT | **62.0%** | 50.5% |

Roughly 8–10 points of recall, purely from not reviewing your own output. The
default here is an OpenAI model, which is the right side of that table for the
Claude-written code this project reviews — if you write with Codex, switch it.

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

Workflow inputs are defined by
`.github/workflows/agentic-review.yml`; matching local controls use the runner
flags shown below. The installer emits the supported workflow subset. A blank
cell means that surface does not expose the setting.

| Setting | Workflow default | Workflow `with:` | `install-review.sh` | `run-review.sh` |
|---|---|---|---|---|
| Model slug | `openrouter/openai/gpt-5.6-luna` | `model` | `--model` | `--model` |
| Reasoning effort | `high` | `thinking` | `--thinking` | `--thinking` |
| Tool allowlist | `read,grep,glob` | `tools` | `--tools` | `--tools` |
| Wall-clock cap | none | `max_time` | `--max-time` | `--max-time` |
| Review prompt | `review/prompt.md` | `prompt_path` | `--prompt` | `--prompt` |
| Injected knowledge | both skills | `skills_path` | `--skill` | `--skill` |
| Review style | `suggest` | `review_mode` | `--review-mode` | `--review-mode` |
| Findings cap | `20` (`0` = none) | `max_findings` | `--max-findings` | `--max-findings` |
| Post a PR comment | `true` | `post_comment` | `--no-comment` |  |
| Resolve stale threads | `true` | `resolve_stale` |  |  |
| Suppress every PR write | `false` | `suppress_writes` |  |  |
| Block the hosted job on a blocked gate | `false` | `fail_on_findings` | `--fail-on-findings` | `--no-fail` separately suppresses the local any-finding exit |
| Blocking severities | `Critical,High` | `block_severities` |  |  |
| Job timeout | `20` minutes | `timeout_minutes` |  |  |
| Diff size cap | `400000` bytes | `max_diff_bytes` |  | `$AGENTIC_REVIEW_MAX_DIFF_BYTES` |
| Symbol index | on | `codegraph` |  | auto when indexed; `--no-codegraph` disables |
| Pin codegraph | latest release | `codegraph_version` |  |  |
| Trusted support ref | `main` | `central_ref` | `--ref` (installer defaults to `v1`) |  |
| Pin bun | `latest` | `bun_version` | `--bun-version` |  |
| Pin omp | `latest` | `omp_version` | `--omp-version` | `--omp-version` |
| OMP display flags | none | `extra_omp_args` | `--extra-omp-args` | after `--` |

The shared runner owns these advanced local ensemble controls; hosted reviews
use their defaults:

| Setting | Default | Local option |
|---|---|---|
| General passes | `1` | `--passes N` |
| Additive lenses | `correctness,boundaries` | `--lenses a,b,c` |
| Experimental vote threshold (always inconclusive) | `1` | `--min-votes N` |

Those defaults produce the general/correctness/boundaries profile described
above. `thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`,
`max` or `auto`; `max_time` accepts values such as `600`, `10m`, or `1h`.

In a workflow:

```yaml
jobs:
  review:
    uses: atomikpanda/agentic-review/.github/workflows/agentic-review.yml@v1
    secrets:
      OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
    with:
      central_ref: v1
      model: openrouter/anthropic/claude-sonnet-5
      thinking: high
      max_time: 12m
      fail_on_findings: true
```

### Which ref to point at

`uses:` selects the workflow; `central_ref` selects the trusted prompt, skills,
runner, and poster it fetches. Supported configurations point both at the same
release line:

| Ref | Moves when | Use for |
|---|---|---|
| `@v1` / `central_ref: v1` | a release is cut | the default installed configuration; fixes arrive, the interface does not break |
| `@v1.0.0` / `central_ref: v1.0.0` | never | reproducible released runs |
| `@main` / `central_ref: main` | every commit | this repo's own PRs and active reviewer development |
| `@<40-hex SHA>` / `central_ref: <same SHA>` | never | immutable source pin, including installer `--ref <sha>` |

`central_ref` accepts literal `main`, a central major release tag of the form
`vN`, a full release tag of the form `vN.N.N` with an optional accepted
prerelease/build suffix, or an exact lowercase 40-hex commit SHA. Arbitrary
branches, pull refs, abbreviated or uppercase SHAs, URLs, and revision
expressions are rejected before checkout.

`@main` was the original default and is a poor one for consumers: the review
runs with a token that can write to the pull request, so every commit here
reached every repo the moment a PR opened, untested. Cutting `v1` is what makes
"track the central repo" and "do not execute unreviewed code" compatible.

At install time — the same values, written into the caller for you:

```bash
curl -fsSL .../install-review.sh | bash -s -- \
  --repo owner/name --yes \
  --model openrouter/anthropic/claude-sonnet-5 --thinking high --max-time 12m
```

Locally, configuration flags also read matching `AGENTIC_REVIEW_*` environment
defaults where shown by `./scripts/run-review.sh --help`:

```bash
export AGENTIC_REVIEW_MODEL=openrouter/anthropic/claude-sonnet-5
export AGENTIC_REVIEW_THINKING=high
./scripts/run-review.sh -- --hide-thinking
```

The runner is **not** an input. `runs-on` is resolved before any step executes,
so a caller-supplied value cannot be validated — the validation would already be
running on the runner it was meant to vet, and `self-hosted` would put
attacker-authored PR content on a persistent machine holding your model key.

Fork pull requests are **skipped**, not failed. The trusted
`pull_request_target` entry point could receive secrets for them, but this
project deliberately confines the write-capable token and model key to
same-repository reviews.

### What is not configurable

`tools` is validated against the read-only set below and the job fails on
anything outside it. `extra_omp_args`, installer `--extra-omp-args`, and tokens
after `--` locally accept only `--print-thoughts`, `--hide-thinking`, and
`--no-title`; every other token, including `--add-dir`, is rejected before
workflow installation or invocation.

`omp_version` / `--omp-version` accepts only a safe npm dist-tag or an exact
semantic version. Values that select another package, URLs, git specs, file
specs, version ranges, and arbitrary package expressions are rejected. Widening
the reviewer to write, execute, load code, or expand its scope is a fork, not a
flag.

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

Those three are the entire set `tools` will accept.

Excluded: `bash`, `edit`, `write`, `ast_edit`, `eval`, `debug`, `browser`,
`computer`, `github`, `task`, `hub`, `web_search`, `memory_edit`, `retain`,
`learn`, `manage_skill`, `checkpoint`, `rewind`, `ask`, `security_scan`, `lsp`.

Three of those read as harmless and are not:

- **`lsp`** — omp discovers language-server configuration from the *project*
  directory (`lsp.json`, `.lsp.json`, `.lsp.yaml`…), and the project directory
  here is the checked-out pull request. A PR can commit an `lsp.json` naming
  any command; `lsp` is read-tier, so the approval mode auto-approves it and
  omp spawns that command with the model key in its environment. Excluding it
  cost this project cross-file symbol resolution — the precomputed code graph
  and `grep` carry that load instead.
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

The direct and installer-generated entry points use `pull_request_target`, so
GitHub loads their workflow YAML from the trusted base branch. They check out the
reviewed head only as data. Runner, merger, stripper, prompt, skills, and poster
come from a separate central checkout at the validated `central_ref`, including
when this repository reviews its own pull requests; reviewed replacements never
execute with the model key or write-capable token.

## Knowledge injection

Two skills ship, and `skills_path` takes a comma-separated list so a repo gets
both — the infra catalogue contributes almost nothing to a Swift or TypeScript
project, and the security classes contribute little to a Caddyfile.

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

| Tier | Tool | Cost | Catches |
|---|---|---|---|
| Deterministic | shellcheck, actionlint, hadolint, tflint, trivy, gitleaks | $0 | Tool-specific rules, IaC misconfig, secrets |
| Semantic | PR-Agent + skills | ~$0.02/PR | Tool-behaviour knowledge, single-file logic |
| Agentic | this | historically ~$0.10–0.30/pass | Cross-file discovery |

PR-Agent makes single-shot model calls with no tool-use loop — [its own docs say
so](https://github.com/The-PR-Agent/pr-agent/blob/main/docs/docs/core-abilities/agent_skills.md)
— so it cannot read a file outside the diff. That is the gap this fills.

Keep exactly one reviewer commenting automatically, or every PR collects
overlapping sets of inline comments.

## Cost

The default ensemble performs approximately three times the model work of one
general pass. Historical runs on `gpt-5.6-luna` cost roughly $0.10–0.30 per
pass ($0.10/Mtok input), so do not read the old per-pass figure as the cost of a
three-pass result. Actual cost scales with how much each pass explores and is
less predictable than a single-shot reviewer.

`max_time` bounds each model invocation and `timeout_minutes` bounds the hosted
job; lowering `thinking` reduces reasoning tokens. These limits bound execution,
not semantic coverage, and do not make the sample exhaustive.

## Requirements

`omp` ships `#!/usr/bin/env bun`, imports `bun:` builtins, and declares
`engines.bun >= 1.3.14`. It does not run under node — attempting it fails with
`ERR_UNSUPPORTED_ESM_URL_SCHEME`, and an older bun fails with a minified
`SyntaxError`. CI installs bun via `oven-sh/setup-bun`; `run-review.sh` checks
the local version before it starts and says so if it is too old.

## Measuring changes

[`BENCHMARK.md`](BENCHMARK.md) describes a reference set — a real commit with 11
independently-produced findings — and how to run against it. It also records the
measured run-to-run variance, which is ±2 findings on an 11-item set: **a single
run cannot distinguish two configurations.** Several tuning decisions made
during development looked conclusive on one sample and were not.

## Licence

MIT.
