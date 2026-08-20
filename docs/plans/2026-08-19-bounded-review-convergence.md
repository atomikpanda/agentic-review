# Bounded Review Convergence Implementation Plan

**Spec:** `docs/specs/2026-08-19-bounded-review-convergence-design.md` at `721e466`

**Goal:** Replace the hosted single sample and local ad hoc repeated samples with one trusted, three-pass review owner that unions findings, reports conservative run state, and gives the fixer a bounded convergence contract.

**Architecture:** `scripts/run-review.sh` remains the sole pass invoker. The hosted workflow resolves credentials and trusted data, then calls that runner instead of maintaining a second prompt/invocation loop. A small pure Node module owns fingerprints and state derivation; `post-review.mjs` owns GitHub reconciliation and presentation. Every pass emits the existing findings JSON regardless of presentation mode.

**Default profile:** general + correctness + boundaries, sequential, one structured-output retry per pass, `min_votes=1`. One merged review is posted. `bounded_converged` means exactly `analysis_state=complete && sample_state=clean`; it never means exhaustive repository coverage.

**Security invariants:** The target resolves before model execution. The workflow retains checkout, token, credential, and agent-config boundaries. Executable support always comes from the installed/central runner tree. Hosted prompt, format, skill, and lens data are resolved from base/central sources and passed through a trusted data root; the reviewed head tree cannot override them.

**Result metadata schema:**

```json
{
  "schema_version": 1,
  "base_sha": "<40 hex>",
  "head_sha": "<40 hex>",
  "configuration_fingerprint": "<64 hex sha256>",
  "analysis_state": "complete",
  "diff": { "bytes": 123, "included_bytes": 123, "truncated": false },
  "finding_cap": 20,
  "passes": {
    "requested": ["general", "correctness", "boundaries"],
    "completed": ["general", "correctness", "boundaries"],
    "results": [
      { "id": "general", "status": "valid", "attempts": 1, "finding_count": 2, "capped": false }
    ]
  }
}
```

A pass is conservatively `capped=true` when its valid raw finding count reaches a configured nonzero cap. `analysis_state=complete` requires every requested pass to be valid for the same target/fingerprint, no diff truncation, and no capped pass. All-pass failure remains a hard execution failure. Partial-pass or merge failure preserves available artifacts but reports `inconclusive`, never clean.

---

## Task 1: Add the pure review result contract

**Files:**
- Create: `scripts/review-result.mjs`
- Create: `scripts/review-result.test.mjs`
- Modify: `.github/workflows/test.yml`

### Step 1: Write failing state-table tests

Cover these observable cases with `node:test`:

```js
assert.deepEqual(deriveReviewState({
  analysisState: "complete",
  current: [],
  unresolved: [],
  reconciliationKnown: true,
  blockSeverities: ["Critical", "High"],
}), {
  analysis_state: "complete",
  merge_state: "ready",
  sample_state: "clean",
  bounded_converged: true,
  // severity counts omitted here for brevity; assert them in the test
});
```

Add table rows proving:

- incomplete + no known finding => `ready/unknown/false`;
- complete + Medium => `ready/findings/false`;
- complete + High => `blocked/findings/false`;
- an unresolved prior High blocks even when the current sample is empty;
- unknown reconciliation prevents `clean`;
- existing unresolved and current duplicate identities count once;
- `bounded_converged` is derived, never independently supplied.

Add `deriveAnalysisState` cases for successful three-pass input, failed pass, truncated diff, capped pass, target mismatch, and merge failure. Add `configurationFingerprint` cases proving key-order independence, content sensitivity, and credential exclusion.

Run: `node --test scripts/review-result.test.mjs`

Expected: fail because `review-result.mjs` does not exist.

### Step 2: Implement only the state owner

Export:

```js
export const REVIEW_RESULT_SCHEMA_VERSION = 1;
export const DEFAULT_PASS_DESCRIPTORS = [
  { id: "general", lens: null },
  { id: "correctness", lens: "review/lenses/correctness.md" },
  { id: "boundaries", lens: "review/lenses/boundaries.md" },
];

export function configurationFingerprint(config) { /* canonical SHA-256 */ }
export function deriveAnalysisState(run) { /* complete | inconclusive */ }
export function deriveReviewState(input) { /* states + deduplicated counts */ }
export function validateRunMetadata(value) { /* fail loud at file boundary */ }
```

Use the identity functions already owned by `lib-findings.mjs`; do not create a second fuzzy matcher. Canonicalize only plain JSON data, reject unsupported values, and hash the model, reasoning, tool list, prompt/format/lens/skill contents, diff/finding caps, pass descriptors, and result-affecting extra OMP arguments. Never accept or hash credentials.

`deriveReviewState` accepts normalized current and unresolved findings. It deduplicates with the existing finding identity, computes current/unresolved severity counts, and applies configured blocking severities. Unknown analysis does not block by itself.

### Step 3: Add the test to CI and verify

Add `node --test scripts/review-result.test.mjs` to the existing `thread-change` test job rather than creating a new runner image.

Run:

```bash
node --test scripts/review-result.test.mjs
node --check scripts/review-result.mjs
```

Expected: all result-contract tests pass.

### Step 4: Commit

```bash
git add scripts/review-result.mjs scripts/review-result.test.mjs .github/workflows/test.yml
git commit -m "feat: define bounded review result states"
```

---

## Task 2: Make finding union importable and explicitly tested

**Files:**
- Modify: `scripts/merge-findings.mjs`
- Create: `scripts/merge-findings.test.mjs`
- Modify: `.github/workflows/test.yml`

### Step 1: Write failing merger tests

Use temporary JSON files and the real CLI. Prove:

- findings unique to any one of three passes survive with `--min-votes 1`;
- repeated findings merge using `lib-findings.mjs` identity and expose the correct vote count;
- a stricter explicit `--min-votes` still works but is not the ensemble default;
- malformed inputs are skipped with a diagnostic, not treated as empty valid passes;
- `--check` rejects prose or zero-byte output;
- output ordering remains severity-first and deterministic.

Run: `node --test scripts/merge-findings.test.mjs`

Expected: at least the import/diagnostic assertions fail against the CLI-only implementation.

### Step 2: Separate merge logic from CLI wiring

Export `mergeFindingDocuments(documents, { minVotes })` and guard CLI execution with the standard `import.meta.url` entry-point check. Keep `merge-findings.mjs` as the owner; do not move merge logic into the new state module. Preserve the current output shape consumed by `post-review.mjs` and add no majority-vote default.

Return pass parse status to callers rather than allowing a malformed document to masquerade as a valid empty set. The runner will record pass validity; the merger only unions valid documents.

### Step 3: Verify and add to CI

Run:

```bash
node --test scripts/merge-findings.test.mjs scripts/review-result.test.mjs
node --check scripts/merge-findings.mjs
```

Expected: both suites pass.

Add the merger suite to `.github/workflows/test.yml`.

### Step 4: Commit

```bash
git add scripts/merge-findings.mjs scripts/merge-findings.test.mjs .github/workflows/test.yml
git commit -m "test: lock review finding union semantics"
```

---

## Task 3: Turn the local runner into the shared three-pass owner

**Files:**
- Create: `review/lenses/boundaries.md`
- Modify: `scripts/run-review.sh`
- Create: `scripts/run-review.test.mjs`
- Modify: `.github/workflows/test.yml`

### Step 1: Build a fake-OMP integration harness

In `run-review.test.mjs`, create a temporary Git repository with a base and head commit, put a fake `omp` executable first on `PATH`, and invoke the real `scripts/run-review.sh` from that repository. The fake executable must log each `@prompt` file and return deterministic JSON based on the lens marker in that prompt.

First failing scenario:

- general returns finding A;
- correctness returns A + B;
- boundaries returns C;
- invoke the runner with default profile, `--json`, `--out <findings>`, `--metadata-out <metadata>`, and `--no-state`;
- assert exactly three invocations and pass ids;
- assert A/B/C survive, A has two votes, and only one merged findings document is produced;
- assert metadata has all requested/completed ids, identical base/head/fingerprint, `analysis_state=complete`, and `capped=false`.

Run: `node --test scripts/run-review.test.mjs`

Expected: fail because the runner has no metadata option and defaults do not request the boundary pass.

### Step 2: Add failure-accounting tests before implementation

Add cases for:

- invalid JSON followed by valid JSON => exactly one retry and `attempts=2`;
- permanently invalid correctness pass => union general/boundary findings and `inconclusive`;
- all passes invalid => nonzero exit and no clean result;
- output count equal to nonzero `max_findings` => capped/inconclusive;
- truncated diff => inconclusive;
- deterministic per-pass file-order rotation;
- all presentation modes still send the JSON format contract to OMP;
- a malicious target-tree `review/lenses/boundaries.md` is ignored when a trusted data root is supplied.

Each test must inspect behavior or emitted metadata, not grep `run-review.sh` source.

### Step 3: Add the boundary lens

Create a concise lens that directs the pass toward:

- caller/callee and schema contracts;
- authentication, authorization, secret, and repository trust boundaries;
- fallback and degraded-mode behavior;
- docs/configuration versus runtime behavior;
- cross-component ownership and integration seams.

It changes prioritization only. It must not narrow repository tools, changed files, or the complete diff.

### Step 4: Implement the fixed default profile

Keep `run-review.sh` as the invocation owner and reuse its existing `ordered_diff`, `run_pass`, structured-output check, `merge-findings.mjs`, and throwaway-worktree security envelope.

Required changes:

- default to one general pass plus `correctness,boundaries` lenses;
- assign stable pass ids and create one pass record per requested pass;
- give every pass the structured JSON format, including `review_mode=summary`;
- retain one retry, recording attempts and terminal status;
- record raw finding count and cap state before union;
- never fall back to the first successful pass while claiming complete analysis;
- fail if all configured passes fail;
- compute one configuration fingerprint before invoking any pass;
- emit metadata atomically via new `--metadata-out PATH` / `AGENTIC_REVIEW_METADATA_OUT`;
- add `--no-state` for hosted/ephemeral execution while preserving local state by default;
- add `AGENTIC_REVIEW_TRUSTED_DATA_ROOT`: when set, relative prompt/format/skill/lens data resolve only below that root; explicitly supplied absolute files remain allowed; executable helpers continue to resolve only below `SELF_ROOT`;
- keep `--passes` and `--lenses` as advanced overrides, but derive requested ids and completeness from the actual bounded profile;
- make `--out` remain the structured merged findings artifact; rendering affects stdout only.

Write metadata to a temporary sibling and rename it only after validation. Remove temporary pass files only after the merged findings and metadata are durable. Preserve stderr-only progress.

### Step 5: Verify runner behavior

Run:

```bash
node --test scripts/run-review.test.mjs scripts/merge-findings.test.mjs scripts/review-result.test.mjs
bash -n scripts/run-review.sh
```

Expected: all fake-model scenarios pass; shell syntax passes.

Add `run-review.test.mjs` to `.github/workflows/test.yml`.

### Step 6: Commit

```bash
git add review/lenses/boundaries.md scripts/run-review.sh scripts/run-review.test.mjs .github/workflows/test.yml
git commit -m "feat: run bounded three-pass review ensembles"
```

---

## Task 4: Make the poster consume metadata and own all presentation modes

**Files:**
- Modify: `scripts/review-result.mjs`
- Modify: `scripts/review-result.test.mjs`
- Modify: `scripts/post-review.mjs`
- Create: `scripts/post-review.test.mjs`
- Modify: `.github/workflows/test.yml`

### Step 1: Write failing presentation/state tests

Test pure state and summary-history helpers before changing GitHub calls:

- encode/decode a versioned, compressed summary marker round-trips normalized findings and prior head SHA;
- malformed or untrusted markers are ignored and make reconciliation unknown only when they came from the selected bot comment;
- a currently omitted prior finding with unchanged or indeterminate span is held;
- a currently omitted prior finding with a changed span retires;
- a current finding replaces its prior copy rather than duplicating it;
- deleting the prior standing comment gives an empty prior state;
- summary Markdown labels `Analysis`, `Merge gate`, `Sample`, `Bounded convergence`, base/head/fingerprint, pass counts, current counts, and held counts without exhaustive claims;
- inline/suggest review bodies display those same values;
- `summary`, `inline`, and `suggest` consume the same merged current artifact
  before mode-specific prior history is reconciled.

The marker should contain only the compact normalized fields needed to carry a finding and compare its path/range. Compress with Node built-ins so hidden state does not duplicate the full visible comment at Base64 size.

Run: `node --test scripts/post-review.test.mjs scripts/review-result.test.mjs`

Expected: fail because summary state and new labels do not exist.

### Step 2: Replace heuristic confidence with explicit state

Require `REVIEW_METADATA_FILE` for normal execution and validate it with `validateRunMetadata`. `RENDER=1` tests may pass an explicit fixture metadata file; remove implicit `PASSES_TRIED/PASSES_OK/DIFF_TRUNCATED` defaults after every caller/test is migrated.

After querying prior bot threads/comments:

1. reconcile current findings with existing inline threads or the standing summary marker;
2. classify unchanged/indeterminate omitted findings as held;
3. call `deriveReviewState` with current + unresolved/held findings;
4. render body/job summary/output values from that single returned object;
5. enforce the gate from `merge_state`, not from prose or raw current count.

Any thread/comment query or reconciliation failure must prevent `sample_state=clean` and `bounded_converged=true`. It does not invent a blocking finding.

Delete `reviewConfidence` and wording such as `whole diff reviewed`, `Production ready`, or claims that a clean sample proves safety. Use `Bounded convergence: yes/no` only as the exact derived state.

### Step 3: Implement the standing summary comment

Use a dedicated marker distinct from inline finding fingerprints. Fetch paginated issue comments, accept only a bot-authored comment with that marker, and select the newest valid one.

For `review_mode=summary`:

- render current and held findings into one non-inline body;
- create the standing comment only when findings exist;
- on later runs, PATCH that comment instead of appending;
- if all prior findings retire, update the existing comment to the clean state rather than creating another;
- if the user deleted it, start with no summary history;
- under `suppress_writes=true` or `post_comment=false`, read/reconcile for outputs and gating but do not POST/PATCH;
- do not pretend a top-level comment has GitHub's human resolved-thread signal.

Keep inline/suggest anchoring, suggestions, and thread retirement behavior unchanged except that state derivation now counts held/unresolved findings explicitly.

### Step 4: Emit workflow outputs and job summary

When `GITHUB_OUTPUT` is set, append:

- `analysis_state`;
- `merge_state`;
- `sample_state`;
- `bounded_converged` (`true|false`);
- `base_sha`, `head_sha`, `configuration_fingerprint`;
- `passes_requested`, `passes_completed`;
- JSON severity maps for current and unresolved counts.

When `GITHUB_STEP_SUMMARY` is set, append the same state table plus concise counts. Do this even when no PR comment is created. Keep output values machine-readable and prose-free.

### Step 5: Verify poster behavior

Run:

```bash
node --test scripts/post-review.test.mjs scripts/review-result.test.mjs scripts/thread-change.test.mjs
node --check scripts/post-review.mjs scripts/review-result.mjs
FINDINGS_FILE=<fixture-findings> REVIEW_METADATA_FILE=<fixture-metadata> REVIEW_SCOPE_FILE=<fixture-scope> RENDER=1 REVIEW_MODE=summary node scripts/post-review.mjs
```

Expected: suites pass; the smoke output contains one summary with explicit states and no exhaustive claim.

Add `post-review.test.mjs` to `.github/workflows/test.yml`.

### Step 6: Commit

```bash
git add scripts/review-result.mjs scripts/review-result.test.mjs scripts/post-review.mjs scripts/post-review.test.mjs .github/workflows/test.yml
git commit -m "feat: report conservative review convergence"
```

---

## Task 5: Replace hosted single-pass execution with the shared owner

**Files:**
- Modify: `.github/workflows/agentic-review.yml`
- Modify: `.github/workflows/test.yml`
- Modify: `scripts/run-review.test.mjs`

### Step 1: Extend the fake-OMP smoke test to the hosted contract

Add a scenario invoking `run-review.sh` with the exact hosted inputs: absolute resolved prompt/skill files, trusted central data root, no local state, configured caps, and extra OMP arguments. Then run `post-review.mjs` in dry-run/suppressed mode with the generated findings and metadata.

Assert:

- three fake model calls, one merged poster call;
- target-tree prompt/format/lens replacements are not read;
- review and metadata artifacts exist;
- the gate/output state matches the merged findings;
- no GitHub write is attempted in suppressed mode.

Run: `node --test scripts/run-review.test.mjs scripts/post-review.test.mjs`

Expected: fail until workflow-facing runner/poster arguments are complete.

### Step 2: Declare reusable workflow outputs

Under `on.workflow_call.outputs`, map each public output to the `review` job output. Under `jobs.review.outputs`, map to the posting step's outputs. Export the fields listed in Task 4, including `bounded_converged`.

### Step 3: Narrow prompt preparation to trusted data resolution

Keep target resolution, checkout, central checkout, input validation, credential assertions, config stripping, and base/central prompt/skill resolution in the workflow.

Remove duplicated diff assembly, prompt concatenation, direct OMP invocation, retry assumptions, and pass-count defaults. The workflow should prepare trusted prompt/skill data, then invoke the shared runner. Preserve codegraph installation; let the runner own whether and how the generated context enters every pass.

Invoke only the central `scripts/run-review.sh` for enrolled repositories. Pass:

- resolved base/head and validated model/reasoning/tools/time/cap configuration;
- resolved absolute prompt and skill files;
- `AGENTIC_REVIEW_TRUSTED_DATA_ROOT=.central-skills` so format and lens data cannot come from the reviewed head;
- structured findings output `/tmp/review.md`;
- metadata output `/tmp/review-meta.json`;
- `--no-state --no-fail`;
- validated extra OMP arguments after `--`.

For this repository's own pull-request test path, select
`scripts/run-review.sh` and the branch's data root explicitly so the pull request
can exercise its new runner and boundary lens before they exist on `main`. This
is not a new trust grant: that same-repository branch already supplies the
workflow shell executing with the model key. Keep the central runner and central
data root mandatory for every external repository. Executable support must never
fall back to an unrelated reviewed repository.

### Step 4: Route every mode through the poster

Delete the workflow's separate summary `gh pr comment` branch. Call `post-review.mjs` once for `summary`, `inline`, and `suggest`, always passing `FINDINGS_FILE` and `REVIEW_METADATA_FILE`. Give the step a stable `id` for outputs.

The poster, not shell branches, owns:

- summary rendering/updating;
- inline/suggestion posting;
- thread/comment reconciliation;
- job summary;
- merge gate and `fail_on_findings`.

Keep the write token scoped to this step. Upload `/tmp/review-meta.json` and any retained per-pass diagnostics with the review artifact.

### Step 5: Verify workflow and shared smoke behavior

Run:

```bash
node --test scripts/run-review.test.mjs scripts/post-review.test.mjs
python3 -c 'import pathlib,yaml; yaml.compose(pathlib.Path(".github/workflows/agentic-review.yml").read_text()); yaml.compose(pathlib.Path(".github/workflows/test.yml").read_text()); print("workflow YAML: pass")'
bash -n scripts/run-review.sh
```

Expected: integration suites and YAML parsing pass.

### Step 6: Commit

```bash
git add .github/workflows/agentic-review.yml .github/workflows/test.yml scripts/run-review.test.mjs
git commit -m "feat: use bounded ensembles in hosted reviews"
```

---

## Task 6: Bound the fixer contract and document operator-visible behavior

**Files:**
- Modify: `skills/review-loop/SKILL.md`
- Modify: `README.md`

### Step 1: Write the contract changes before prose

In `skills/review-loop/SKILL.md`, make the loop consume one merged review batch and require:

1. validate every item against current code;
2. group by shared invariant/callsites;
3. add behavior regressions where needed;
4. make one consolidated push;
5. re-review the new immutable head;
6. stop after three non-clean review/fix rounds for one objective and report unresolved items, rather than starting another broad pass.

Preserve the existing rule that valid earlier findings remain actionable even if a later stochastic sample omits them.

### Step 2: Update README contracts

Document:

- the default general/correctness/boundaries profile and approximately 3x model work;
- union semantics and one retry per pass;
- `analysis_state`, `merge_state`, `sample_state`, and derived `bounded_converged` outputs;
- why ready is not the same as clean or converged;
- summary as a renderer over structured findings and its standing-comment behavior;
- local `--metadata-out`, `--no-state`, advanced pass/lens overrides, and structured `--out` artifact;
- incomplete/truncated/capped runs never report clean convergence;
- bounded sampling is not exhaustive repository coverage.

Remove or correct current statements that summary mode is unstructured, that a single clean sample implies a complete review, or that hosted execution is one pass.

### Step 3: Verify documentation against interfaces

Run targeted searches for stale terms and compare every documented option/output to the runner help and workflow input/output blocks. Then run:

```bash
git diff --check
```

Expected: no stale single-pass/Markdown-summary claims and no whitespace errors.

### Step 4: Commit

```bash
git add skills/review-loop/SKILL.md README.md
git commit -m "docs: define bounded review and fixer loops"
```

---

## Task 7: Run complete behavioral verification

**Files:**
- Modify only if a verification failure exposes a defect in the implementation above.

### Step 1: Run the complete focused suite

```bash
node --test \
  scripts/thread-change.test.mjs \
  scripts/merge-findings.test.mjs \
  scripts/review-result.test.mjs \
  scripts/run-review.test.mjs \
  scripts/post-review.test.mjs
```

Expected: all tests pass with zero skipped/failing cases.

### Step 2: Run syntax, workflow, and security-contract checks

```bash
node --check scripts/merge-findings.mjs
node --check scripts/review-result.mjs
node --check scripts/post-review.mjs
bash -n scripts/run-review.sh
./scripts/test-omp-tool-contract.sh
python3 -c 'import pathlib,yaml; [yaml.compose(pathlib.Path(p).read_text()) for p in (".github/workflows/agentic-review.yml", ".github/workflows/test.yml")]; print("workflow YAML: pass")'
git diff --check
```

Expected: every command exits zero; the OMP contract confirms only read-only tools and no agent-config execution.

### Step 3: Run two end-to-end smoke scenarios

With the fake OMP harness, run:

1. a complete three-pass empty ensemble and observe `complete/ready/clean/true`;
2. a partial-pass ensemble with a High finding and observe `inconclusive/blocked/findings/false`.

Exercise both `summary` and `suggest` rendering from the same merged artifact. Confirm one standing summary comment plan and one review payload plan in dry-run output.

### Step 4: Run the reviewer on its own branch

Use the actual local runner against `origin/main` with the default three-pass profile and structured output. Validate every reported finding before changing code. If fixes are warranted, add a failing regression, make one consolidated fix commit, and rerun the focused suite once.

This is a bounded review of the implementation, not evidence of exhaustive safety.

### Step 5: Record final evidence

Capture:

- test counts;
- syntax/YAML/security check results;
- default pass ids and completed count from metadata;
- final four state values from the end-to-end run;
- any intentionally held or unresolved findings.

Do not claim completion from stale or partial output.
