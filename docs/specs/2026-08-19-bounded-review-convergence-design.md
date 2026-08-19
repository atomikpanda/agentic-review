# Bounded Review Convergence

## Context

Issue #7 reports an effectively unbounded review/fix cadence on
`atomikpanda/ground-control#68`. That pull request received 20 hosted reviews:
13 labelled Clear and 7 labelled Blocked. Every review used
`openrouter/openai/gpt-5.6-luna` and identified itself as a single pass.

The pathological cadence was observed when GPT-5.6 Sol acted as the fixer. The
same operational loop was not observed with Claude as the fixer. GitHub records
the reviewer model but not the fixer model, so the fixer comparison is operator
evidence rather than repository-derived evidence.

The reviewer and fixer form a coupled system. The reviewer currently makes one
stochastic exploration of the diff and repository per push. A fixer that patches
the reported batch and pushes immediately creates another independent reviewer
sample. A fixer that traces shared invariants and batches related repairs causes
fewer samples and fewer opportunities for incremental discovery.

Repository access does not make one model trajectory exhaustive. The existing
benchmark demonstrates this directly: identical inputs produced materially
different finding sets, and the union of repeated passes recovered findings no
single pass reported. The current hosted wording nevertheless says "whole diff
reviewed" when one invocation returned parseable output.

## Goals

- Discover substantially more related defects in one PR update.
- Run all sampling for a result against one immutable base, head, and review
  configuration.
- Distinguish execution completeness, merge policy, and absence of findings.
- Expose a machine-readable bounded-convergence result.
- Preserve read-only execution and the existing untrusted-repository boundary.
- Give fixers one merged batch and a finite stopping rule.
- Keep local and hosted review semantics aligned.

## Non-goals

- Claim exhaustive semantic coverage of the repository.
- Prove that no defect exists.
- Suppress valid findings to manufacture a clean result.
- Make Medium findings block merges by default.
- Add a dynamic planner/worker subsystem in the first implementation.
- Infer fixer model identity from GitHub state.
- Automatically modify contributor code.
- Infer thread-level human disposition from a summary comment; inline or suggest
  mode is required for GitHub's resolved-thread signal.

## Review ensemble

Each PR update runs three passes against one immutable
`(base SHA, head SHA, configuration fingerprint)`:

1. **General** uses the normal review prompt and applicable knowledge packs.
2. **Correctness** concentrates on state transitions, lifecycle, concurrency,
   retries, idempotency, persistence, and error paths.
3. **Boundaries** concentrates on caller/callee contracts, authentication and
   trust boundaries, fallback behavior, configuration and documentation versus
   runtime behavior, and cross-component ownership.

Every pass receives the complete available diff, the post-change checkout, and
the same read-only repository tools. The diff's file order rotates per pass to
reduce position-dependent attention bias. A lens changes review priority, not
repository access.

Every pass returns the same structured findings document. `review_mode` is a
presentation choice applied only after union: `summary` renders one non-inline
comment, `inline` renders anchored explanations, and `suggest` adds complete
committable suggestions where available. Summary mode does not ask the model for
Markdown and therefore participates in the same ensemble, gate, thread state,
and convergence contract as the other modes.

Passes run sequentially initially. This keeps rate-limit and failure accounting
simple. Parallel execution is deferred until measured latency justifies the
additional coordination and provider pressure.

Each pass may retry structured output once. It then produces either a valid
findings set or an explicit failed-pass record. Valid findings are merged using
the existing finding identity logic with `min_votes=1`. Vote count remains
metadata and never filters a finding in the default ensemble. The action posts
one merged review after all passes finish; it never posts per-pass reviews.

## Shared execution owner

The current local runner already owns rotated repeated passes and findings
merging, while the hosted workflow directly invokes OMP once. The implementation
must move pass descriptors, prompt assembly, invocation, validation, retry, and
metadata generation behind one trusted execution owner consumed by both paths.
The hosted workflow must not grow an independent copy of the local pass loop.

The shared owner accepts already-validated review configuration and writes:

- one merged findings document for `post-review.mjs`;
- one metadata document containing base/head SHAs, configuration fingerprint,
  requested and successful pass identifiers, per-pass status and finding count,
  truncation/cap state, and analysis state.

The configuration fingerprint covers the model, reasoning effort, tool list,
prompt, format, lens and skill contents, diff cap, and finding cap. It excludes
credentials. The base and head SHAs remain explicit fields rather than being
hidden inside the fingerprint.

The workflow retains ownership of target resolution, credential handling,
checkout, and removal of untrusted agent configuration. The shared runner must
execute only after those security boundaries have completed.

## Result contract

A review reports three independent states.

### Analysis state

`complete` means:

- all three configured passes returned valid structured output;
- every pass reviewed the same base, head, and configuration fingerprint;
- the diff was not truncated; and
- no pass reached its findings cap.

Any unmet condition yields `inconclusive`. Findings from successful passes are
still posted, but an inconclusive run cannot be clean or converged.

### Merge state

`ready` means no unresolved bot finding has a severity included in
`block_severities`. `blocked` means at least one such finding remains. This state
includes prior findings held open because their span is unchanged or its change
state is indeterminate, even if the current ensemble omitted them.

`fail_on_findings` continues to map `merge=blocked` to job failure. Job success
without that option means the workflow executed; it is not a convergence signal.

### Sample state

`clean` means analysis is complete and no unresolved actionable bot finding of
any severity remains. `findings` means at least one remains, even if analysis is
inconclusive. `unknown` means analysis is inconclusive and no finding is known;
it prevents a failed or partial review from being presented as clean. A review
containing only Medium findings is therefore `merge=ready` and
`sample=findings`.

Human-resolved findings remain decisions and do not count unless overlapping
code changes make the finding eligible to be raised again. Missing findings with
unchanged or indeterminate spans remain held and prevent the applicable state.

The UI may render `analysis=complete && sample=clean` as **bounded three-pass
convergence**, always qualified by head SHA and configuration fingerprint. It
must not say "whole diff reviewed", "Production ready", or imply exhaustive
repository coverage.

## Outputs and presentation

The reusable workflow exposes machine-readable outputs for:

- `analysis_state` (`complete` or `inconclusive`);
- `merge_state` (`ready` or `blocked`);
- `sample_state` (`clean`, `findings`, or `unknown`);
- base SHA, head SHA, and configuration fingerprint;
- passes requested and passes completed;
- `bounded_converged` (`true` exactly when analysis is complete and the sample is
  clean);
- current and unresolved finding counts by severity.

The review body and the GitHub job summary display the same values. A
no-findings run still writes outputs and a job summary. It does not create a new
PR comment, although an existing standing summary comment may be updated to show
that its prior findings were retired. Severity/readiness prose may summarize
findings, but it cannot override or blur the three states.

All presentation modes consume the same merged findings and result metadata.
When findings exist, summary mode produces one non-inline comment from that data;
it cannot substitute model-authored prose for the structured contract. Inline
and suggest modes retain their existing anchoring behavior.

Summary mode maintains one bot-authored standing comment with an embedded state
marker. Each run edits that comment rather than appending another. A prior
finding omitted by the current sample stays held while its original code span is
unchanged or indeterminate, and is retired only after that span changes. Deleting
the standing comment explicitly resets summary-mode history. Suppressed-write
runs read this state for gating but do not edit it.

## Fixer contract

The fixer receives one merged findings batch. It must:

1. validate each finding against current code;
2. group findings by invariant and affected callsites;
3. repair the shared owner rather than one reported symptom;
4. add observable regressions where the contract is otherwise uncovered;
5. verify the integrated change; and
6. make one consolidated push.

After three non-clean review/fix rounds, the fixer stops per-comment patching and
reports architectural instability. It does not keep pushing indefinitely in
pursuit of a probabilistic clean sheet. The reviewer continues to report valid
findings; the stopping rule constrains fixer behavior, not evidence.

The bundled review-loop guidance must state this batch-and-stop policy explicitly.
The reviewer cannot enforce it for arbitrary external fixers, so the workflow
states remain valid without assuming fixer compliance.

## Error handling

- A pass that remains malformed after one retry is failed, not empty.
- One or two successful passes may still contribute findings, but analysis is
  inconclusive.
- A truncated diff or a capped pass makes analysis inconclusive. A pass is
  conservatively treated as capped when its raw finding count reaches the
  configured nonzero limit.
- Cap state is recorded per pass before union; the merged union count alone is
  not used to infer that a pass was capped.
- If all passes fail, the review job fails and nothing is posted as a clean run.
- Thread-query or reconciliation failure prevents clean/converged output; it
  cannot silently discard prior evidence.
- Merge failure falls back only to a clearly inconclusive result. It must not use
  the first pass while presenting the ensemble as complete.

## Verification

Unit and integration coverage must prove:

- exactly one general, correctness, and boundary prompt is built;
- every pass uses the same base SHA, head SHA, and configuration fingerprint;
- file order differs deterministically between passes;
- malformed output receives one retry and then records a failed pass;
- findings seen by only one pass survive the union;
- repeated findings merge and retain their vote count;
- per-pass cap, diff truncation, and partial-pass failure are inconclusive;
- an incomplete run with no known findings produces sample-unknown, never clean;
- Medium-only findings produce merge-ready plus sample-findings;
- a current blocking finding produces merge-blocked;
- an omitted but unchanged or indeterminate prior thread prevents a clean state;
- an omitted summary finding remains in the standing comment until its span
  changes;
- repeated summary runs edit one marked comment instead of appending comments;
- `bounded_converged` is true exactly for complete plus clean;
- a fully successful empty ensemble produces bounded convergence;
- workflow outputs and displayed states agree;
- only one PR review is posted per ensemble;
- summary, inline, and suggest render the same merged finding set and states;
- summary mode posts one non-inline comment and remains fully gateable; and
- the hosted and local paths accept the same pass/result contract.

A fake OMP executable supplies deterministic pass outputs for workflow smoke
tests. Permanent tests must exercise behavior and state transitions rather than
matching workflow source text.

## Rollout

1. Land and validate the shared ensemble on `main` and this repository's own PRs.
2. Trial it on Ground Control with the same reviewer configuration that produced
   Issue #7.
3. Compare findings per push, total review/fix rounds, wall time, cost, malformed
   pass rate, and false-positive dispositions against the recorded single-pass
   run.
4. Cut a compatible `v1` release only after the trial. Document the approximately
   threefold model cost and the new output semantics in the release notes.

The first release runs the three-pass ensemble on every PR update, as selected.
A cost-saving discovery/finalization split is deferred rather than weakening the
initial convergence contract.

## Acceptance criteria

- One PR update produces one union review from the three approved pass roles.
- No result is called complete or clean when a pass fails, the diff is truncated,
  a pass reaches its cap, or prior actionable evidence remains unresolved.
- Merge-ready and sample-clean remain distinct and machine-readable.
- A successful job is never the only evidence offered for convergence.
- Consumers can tie every bounded-convergence result to an exact head and review
  configuration.
- Fixer guidance requires one integrated push and stops iterative patching after
  three non-clean rounds.
- Existing read-only and untrusted-repository execution protections remain intact.
