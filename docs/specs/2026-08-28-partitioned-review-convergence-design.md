# Partitioned Review Convergence Program

## Status and implementation boundary

This is the umbrella design for a multi-PR program. It approves the product
semantics, trust boundaries, finite-execution model, and staged architecture.
It does **not** authorize implementing every stage in one branch.

The implementation plan produced immediately after this spec covers only:

1. shared canonical capture/hash ownership;
2. byte-complete shadow atomization;
3. deterministic path-fallback shadow manifests;
4. shadow metrics and a versioned evaluator fixture contract.

Shadow mode invokes the existing full-scope reviewer unchanged and cannot affect
prompts, model calls, publication, persistence, or gating. Partitioned model
execution, durable cross-run state, dispositions, delta reuse, specifications,
suppression, and integration each require the later child specs named below.

This boundary is deliberate. Parallel architecture review found that secure
durable reservation needs a central App state service, and safe delta reuse needs
an enforceable model-read boundary. Neither may be invented inside an
implementation plan for shadow partitioning.

## Context

The hosted controller bounds broad discovery to `max_discovery_rounds`, but it
does not bound every automatic model execution. An inconclusive phase can repeat
on the same head and ordinal, and verification can continue across remediation
heads without consuming discovery budget. A fixed PR-wide three-round cap is
also wrong for a large change: it stops because the diff is large, not because
its meaningful subproblems are terminal.

Repeated full-diff review creates an attention problem. It can discover fresh
findings in old parts of the change while still providing no evidence that every
changed region received focused review. More whole-PR rounds increase cost and
churn without providing a termination argument.

The current boundary policy is incomplete. Documentation describes follow-up
and rejected findings, but finding state has no causal-scope or durable
disposition schema. Severity is used as a proxy at the discovery limit. A valid
follow-up can leave the cycle `ready` while `sample_state=findings` and
`bounded_converged=false`, with no durable issue or machine action telling a
fixer to stop working on this PR.

## Goals

- Partition one immutable review scope into deterministic bounded units whose
  changed-atom union exactly covers the raw Git change.
- Scale review work with actual units and an absolute model-call budget rather
  than a fixed number of whole-PR rounds.
- Split a stalled non-atomic unit before spending more calls on the same large
  context.
- Make every possible model invocation, including retries, consume a durably
  reserved finite budget before workers start.
- Preserve one bounded integration phase across unit boundaries.
- Separate model evidence about relation to the change from deterministic or
  authenticated disposition policy.
- Let the PR become action-ready when every finding has a complete durable
  disposition, without relabeling a non-empty sample as clean.
- Eventually reuse only coverage whose exact unit context is enforceably known
  unchanged.
- Preserve current read-only model execution, immutable-scope binding, trusted
  support, conservative failure, and least-privilege credentials.
- Keep partitioned execution opt-in until a versioned evaluator and live trial
  meet numeric release gates.

## Non-goals

- Prove no undiscovered defect exists.
- Use model confidence, majority vote, or a discovery estimator as a merge gate.
- Automatically accept an unresolved defect introduced or worsened by the PR.
- Trust a model-supplied finding ID, scope binding, causal disposition, or actor.
- Treat generic `github-actions[bot]` authorship or an unkeyed hash as
  authenticated partitioned state.
- Implement partitioned durable state in direct reusable-workflow mode.
- Require CodeGraph; unsupported languages and partial indexing must remain
  complete and conservative.
- Claim delta reuse while the model can read unrecorded head-tree context.
- Grant PR or issue write credentials to the model process.
- Implement the full program in one pull request.

## Program invariants

1. Every canonical raw Git path record has exactly one path-event atom.
2. Every changed text line has exactly one text atom.
3. Semantic grouping may duplicate context but cannot duplicate or omit atom
   ownership.
4. Frontier units partition the complete atom set exactly.
5. Child units partition the parent atom set exactly and each has fewer atoms.
6. Every finding is validated against the exact reserved manifest, batch, unit
   lineages, and scope hashes; trusted code computes its finding ID.
7. Every possible model start is included in a durable worst-case reservation.
8. Active-cycle model-call budget never resets on remediation pushes.
9. Automatic model work cannot continue after budget or terminal unit state.
10. A finding leaves current-PR work only through durable policy/authenticated
    status; follow-up needs a durable issue/PR or allowed explicit deferral.
11. Model causal evidence cannot directly choose merge policy.
12. Suppression is presentation-only after occurrence and status persistence.
13. Partitioned completeness requires complete atoms, unit results, reservation
    reconciliation, and integration; missing work is inconclusive.
14. The integration phase runs once per cycle and cannot create another broad
    integration or discovery loop.
15. Direct/no-write modes cannot execute partitioned model work because they
    cannot reserve it durably.

## Existing owners and clean cutovers

- `scripts/run-review.sh` remains the only owner of immutable checkout,
  diff capture, prompt construction, model invocation, process isolation,
  descriptor execution, retry, deterministic merge order, and atomic
  publication.
- `scripts/review-result.mjs` remains the final result/publication schema and
  completeness owner.
- `scripts/lib-findings.mjs` becomes the single finding schema, bounded identity
  tokens, canonical path-byte identity, similarity, and one-to-one matching
  owner. Private identity helpers in `post-review.mjs` and greedy matching in
  `merge-findings.mjs` migrate to it; no second tokenizer or matcher is added.
- `scripts/merge-findings.mjs` remains descriptor-union and verification-filter
  owner, constrained by trusted unit bindings before fuzzy matching.
- New `scripts/review-units.mjs` owns captured-input validation,
  atomization, partitioning, manifest schemas, splitting, invalidation, and pure
  unit aggregation.
- Extract canonical plain-JSON serialization and hashing from
  `review-result.mjs` into one importable owner used by result and unit modules.
  Credential-field rejection remains configuration validation, not a generic
  JSON restriction.
- Current `scripts/codegraph.sh` Markdown remains prompt presentation only. A
  later structured dependency producer is a separate child spec.

## Staged architecture

### Stage 1 — canonical shadow capture and path fallback

Capture a byte-complete immutable input, atomize it, build deterministic
path-based units, and report metrics while the current full reviewer runs
unchanged. No new GitHub state or model call occurs.

### Stage 2 — versioned evaluator and benchmark expansion

Create the labeled multi-repository dataset, pairing/adjudication rules,
repeated-run evaluator, and live opt-in telemetry schema required for release
decisions.

### Stage 3 — secure central state and finite scheduler

Add a dedicated central GitHub App state service with conditional writes,
durable command inbox, call reservations, continuation wake-ups, unit state,
and one bounded worker wave per invocation. Direct reusable mode remains full or
shadow only.

### Stage 4 — opt-in partitioned execution

Run bounded unit batches through the existing runner, reconcile statuses, split
stalled units, and execute one integration phase.

### Stage 5 — dispositions and specification grouping

Add trusted causal evidence, follow-up/rejection workflows, explicit contract
lane, named evidence results, and `pr_ready`/`next_action`.

### Stage 6 — enforceable context and delta reuse

Only after a trusted read trace, path/blob allowlist, or complete dependency
source binds everything the model may use, add prior-frontier replay and
unit-local reuse across active-cycle heads.

### Stage 7 — learned suppression

Enable presentation suppression only after sufficient independent trusted
status history. Suppression never changes evidence or readiness.

## CapturedReviewInput

Stage 1 adds shadow capture beside the unchanged full-mode scope. One trusted
capture runs against fixed base/head commits and produces:

```json
{
  "schema_version": 1,
  "status": "complete",
  "repository_object_format": "sha1 | sha256",
  "base_sha": "<full-object-id>",
  "head_sha": "<full-object-id>",
  "capture_configuration": {
    "diff_algorithm": "myers",
    "context_lines": 3,
    "rename_threshold": 50,
    "copy_threshold": 50,
    "find_copies_harder": true,
    "full_object_ids": true,
    "external_diff": false,
    "textconv": false,
    "max_patch_bytes": 8388608,
    "max_raw_z_bytes": 8388608,
    "max_single_blob_bytes": 16777216,
    "max_total_blob_bytes": 67108864,
    "max_capture_seconds": 30
  },
  "git_environment": {
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_EXTERNAL_DIFF": "",
    "GIT_DIFF_OPTS": ""
  },
  "git_config_overrides": [
    "diff.external=",
    "diff.algorithm=myers",
    "diff.renames=copies",
    "core.quotePath=false"
  ],
  "patch_argv": ["git", "diff", "..."],
  "raw_argv": ["git", "diff", "..."],
  "patch_base64": "<exact bytes>",
  "raw_z_base64": "<exact git diff --raw -z bytes>",
  "object_table": [
    {
      "object_id": "<full-blob-object-id>",
      "object_type": "blob",
      "modes": ["100644"],
      "size": 123,
      "content_sha256": "<sha256>",
      "content_base64": "<exact blob bytes>"
    }
  ],
  "capture_hash": "<sha256>"
}
```

Capacity/failure is a separate diagnostic envelope, never a partial capture:

```json
{
  "schema_version": 1,
  "status": "capture_capacity_exceeded | capture_failed",
  "base_sha": "<full-object-id>",
  "head_sha": "<full-object-id>",
  "capture_configuration": {},
  "git_environment": {},
  "git_config_overrides": [],
  "patch_argv": [],
  "raw_argv": [],
  "capacity_reason": "patch_bytes | raw_z_bytes | blob_bytes | deadline | process_error",
  "observed_lower_bounds": {
    "patch_bytes": 0,
    "raw_z_bytes": 0,
    "blob_bytes": 0,
    "blob_count": 0,
    "elapsed_milliseconds": 0
  }
}
```

The diagnostic envelope omits `patch_base64`, `raw_z_base64`, `object_table`,
and `capture_hash`. It cannot be passed to atomization or interpreted as an
immutable reviewed scope.
```

The exact patch command is
`git <config-overrides> diff --patch --no-abbrev --full-index
--diff-algorithm=myers --unified=3 --find-renames=50% --find-copies=50%
--find-copies-harder --no-ext-diff --no-textconv --no-color BASE HEAD --`.
The exact raw command is identical except it replaces
`--patch --unified=3` with `--raw -z`. Literal argv,
`git_environment`, and ordered `git_config_overrides` are persisted and
fingerprinted. Tests set non-default abbreviation/config and still require full
IDs and identical capture.

Shadow capture streams both diff subprocesses into bounded private files while
counting bytes. Exceeding either stream limit or the wall-clock deadline kills
the complete shadow capture process tree, deletes partial streams/object bytes,
sets `capture_capacity_exceeded` with reason
`patch_bytes | raw_z_bytes | blob_bytes | deadline`, and performs no
atomization. `--find-copies-harder` is therefore bounded by the same deadline.
All limits are fingerprinted. Capacity handling executes independently of the
already captured full-review diff, so the current review continues unchanged.

The object table contains only readable Git **blob** objects referenced by raw
records, uniquely sorted by object ID bytes then mode. Symlink objects are blobs.
Mode `160000` gitlink IDs are commit IDs: path events bind their full IDs and
modes but never fetch them as blobs. Canonical zero objects are absent.

Blob bytes are streamed while hashing and admitted only when one object and the
cumulative table remain within configured limits. Capacity overflow retains
only bounded lower-bound counts in the diagnostic envelope, emits no truncated
content or capture hash, and stops shadow atomization. Full review continues
unchanged.

`capture_hash` covers canonical JSON over all fields except itself. Hosted
shadow artifacts never include `content_base64`; they include manifest hashes,
object sizes/hashes, and metrics. The private temporary capture and explicit
local shadow output may contain complete bytes within limits.

Full-mode publication and `scope_hash` remain byte-for-byte compatible. Any
shadow capture failure is caught and cannot affect full-mode exit, analysis,
prompts, model calls, outputs, or gates.

## Authoritative path representation

Git paths are arbitrary bytes. Every schema uses:

- `old_path_base64` and `new_path_base64` for path events;
- `path_base64` for text atoms and text anchors;
- optional validated UTF-8 `display_path` only for rendering.

Grouping, identity, dependency edges, comparisons, and pathspec generation use
decoded canonical bytes, never `display_path` or normalized Unicode.

## Complete atomization

Atomization independently owns raw-record metadata and changed text lines.

### Path-event atoms

Every `--raw -z` record creates exactly one path-event atom, including records
that also have text hunks:

```json
{
  "kind": "path_event",
  "raw_status": "R087",
  "status_kind": "add | delete | modify | rename | copy | typechange | unmerged | unknown",
  "content_kinds": ["text", "mode"],
  "owner_path_base64": "...",
  "old_path_base64": "...",
  "new_path_base64": "...",
  "old_mode": "100644",
  "new_mode": "100755",
  "old_object_id": "...",
  "new_object_id": "...",
  "similarity": 87,
  "old_blob_sha256": "...",
  "new_blob_sha256": "..."
}
```

Raw status mapping is literal: `A/D/M/R/C/T/U` map to the named status; any
other status is `unknown` and makes atomization diagnostic-failed until schema
support is added. `content_kinds` uses fixed order
`text, binary, mode, symlink, submodule, empty, other` and includes:

- `text` when the correlated patch record has at least one text hunk;
- `binary` for a blob change reported binary with no text hunk;
- `mode` when old/new modes differ;
- `symlink` when either mode is `120000`;
- `submodule` when either mode is `160000`;
- `empty` when an admitted old/new blob has size zero;
- `other` only when no preceding kind describes a supported raw record.

One-path normalization:

- add: old path `null`, new path set, owner is new;
- delete: old path set, new path `null`, owner is old;
- modify/type/mode: old and new both equal the one raw path, owner is new.

Rename/copy uses the two NUL-delimited paths, owner new. Text atoms use both
old/new paths and the anchor side selects one. Gitlinks bind IDs/modes without
blob hashes. Blob hashes are SHA-256 of exact table bytes; null/zero/missing due
capacity is represented explicitly and prevents complete atomization.

### Text atoms

Parse every patch hunk byte-preservingly. A change block is the maximal sequence
of `-`/`+` records between context records. Walk each block in patch order. Add
one changed line at a time to a candidate segment and canonical-encode the
candidate text payload; if adding the line would exceed 16,000 bytes and the
segment is nonempty, finalize it and start the next at the current old/new
cursors. A single line over target becomes one `oversized=true` segment and is
never truncated. Segment old/new starts are the side cursors before its first
line and counts are the lines owned on each side.

Each old/new line is:

```json
{"bytes_base64": "<bytes excluding LF>", "terminator": "lf | none"}
```

For CRLF, CR remains in line bytes and LF is the terminator. Atom payload stores
old/new path base64, old/new ranges, ordered old/new line records, and final
newline state. Every changed old/new line is owned once.

### Coverage postcondition

- Every raw record has one path-event owner.
- Every changed line has one text owner.
- Raw status/path count, patch records, object types, modes, and blob table agree.

Mismatch yields `atom_coverage_mismatch`; shadow output records it and full
review continues. Partitioned mode later runs no model.

Fixture matrix includes text add/modify/delete, CRLF, no final newline, huge
line, binary add/modify/delete, empty files, rename/copy with and without edits,
chmod, regular-to-symlink, symlink target, submodule, combined changes, invalid
UTF-8 paths, newline/tab/metachar paths, unsupported extensions, and non-default
Git abbreviation/config.

## Atom identity

Stage 1 uses path/range lineage exclusively; trusted symbol FQNs are deferred to
a structured-symbol child spec.

Each atom has:

```json
{
  "lineage_candidate": "<content-independent path/event/range candidate>",
  "segment_ordinal": 0,
  "content_hash": "<sha256>",
  "atom_id": "a:<sha256>"
}
```

`lineage_candidate` is a bounded string. Path-event candidate is
`p:<sha256(canonicalJson({kind:"path_event",raw_status,status_kind,content_kinds,old_path_base64,new_path_base64}))>`.
Text candidate is
`t:<sha256(canonicalJson({kind:"text",old_path_base64,new_path_base64,old_start,old_count,new_start,new_count}))>`.
The hashes bind canonical JSON bytes; candidate prefixes distinguish domains.

Within one repeated lineage candidate, compute `segment_ordinal` by sorting the
pre-ID tuple `(old_start,old_count,new_start,new_count,content_hash,canonical_payload_bytes)`.
Only then compute `atom_id` from atom schema version, lineage candidate, ordinal,
and content hash. Atom ID is never used to order the inputs that create it.

Stage 1 claims determinism only within one immutable capture and records mapping
metrics without reusing coverage across heads.

## Path-fallback shadow partition

Stage 1 groups only by canonical owner path bytes. Semantic grouping is deferred.

For each atom, `atom_payload_bytes` is the UTF-8 byte length of its canonical
plain-JSON payload including base64 data and excluding derived IDs/hashes. Unit
payload is the sum of owned atom payload bytes.

Deterministic packing:

1. Sort owner paths by raw bytes.
2. Sort path-event first, then text atoms by the pre-ID tuple and atom ID.
3. Append toward `max_unit_payload_bytes=64000`.
4. A single over-target atom is one oversized atomic unit.
5. Root lineage is `root:path:<sha256(owner-path-bytes)>:<ordinal>`.
6. `unit_id` is SHA-256 of canonical
   `{unit_schema_version,unit_lineage,ordered_atom_ids,coalesced_from}`.
7. A normal unit has `coalesced_from=[]`.
8. If count exceeds `max_frontier_units=128`, repeatedly merge the adjacent pair
   with minimum tuple `(combined_payload_bytes,left_index,right_index)`. The new
   lineage is `root:coalesced:<sha256(ordered_child_lineages)>`, and
   `coalesced_from` preserves those ordered child lineages.

Path-event atoms for rename/copy group under new owner path; deletions use old
owner path. Text atoms use the same owner rule.

All constants are shadow configuration/metrics. No prompt uses units.

Later recursive splitting orders parent atoms and chooses the boundary minimizing
absolute child byte difference; ties choose lower index. Children are
`<parent-lineage>/0` and `/1`, each nonempty and smaller. Before reservation, an
over-batch non-atomic unit splits. An oversized atomic unit may run only below a
fingerprinted hard model-input ceiling; otherwise it terminates inconclusive.
Frontier-cap split failure terminates parent `frontier_capacity_limit`; completed
children are never collapsed.

## Manifest and fingerprints

Shadow manifest binds capture hash, exact atom/unit schemas, ordered atoms,
ordered path units, configuration, and projected sizes. Unit rows include
`unit_id`, `unit_lineage`, `ordered_atom_ids`, `coalesced_from`,
`unit_payload_bytes`, `atomic`, and `oversized`. Stage 1 IDs are deterministic
within the immutable capture.

Later execution separates:

1. coverage configuration fingerprint;
2. phase-specific execution fingerprint;
3. exact rendered batch/prompt scope hash.

Future cross-head reuse needs unit-local context hash and is disabled in Stage 1.

## Shared execution profile

Before partitioned execution, create one trusted profile owner consumed by
planner, runner, and validator:

```json
{
  "descriptors": ["general", "correctness", "boundaries"],
  "descriptor_content_hashes": ["..."],
  "max_output_attempts": 2
}
```

Every model process start counts, including invalid JSON, schema failure, empty
output, timeout retry, and process retry. No descriptor or retry maximum remains
hard-coded independently in runner and result validation.

## Discriminated finding anchors and binding

`lib-findings.mjs` remains the single schema owner. Findings use one of:

```json
{
  "anchor": {
    "kind": "text_span",
    "path_base64": "...",
    "side": "old | new",
    "start_line": 10,
    "end_line": 12,
    "atom_ids": ["a:..."]
  }
}
```

or:

```json
{
  "anchor": {
    "kind": "path_event",
    "path_event_atom_id": "a:...",
    "event_kinds": ["rename", "mode"]
  }
}
```

Optional `file`, `start_line`, and `end_line` remain rendering compatibility
fields only when a new-side text anchor exists. Deletion and path-event findings
render in summary when GitHub cannot anchor inline.

The model echoes manifest hash, ordered unit lineages, and execution scope
hashes. Trusted code verifies those against reservation and computes finding ID
after merge. Model-supplied IDs are rejected/stripped.

Identity ownership moves to `lib-findings`: bounded path-byte tokens, similarity,
and maximum one-to-one assignment. Matching order is exact verification ID,
exact persisted ID, one-to-one fuzzy matching restricted by overlapping unit
lineage and path bytes, then deterministic new ID with collision suffix in
canonical finding order.

## Unit scheduler — child spec requirements

Stage 4 child spec must include a literal transition table covering:

- initial discovery;
- blocker remediation and verification;
- triage/disposition updates;
- final unit discovery;
- malformed and partial results;
- inconclusive retry and atomic/non-atomic exhaustion;
- integration findings and integration verification;
- insufficient call budget;
- new-head invalidation.

Required split semantics:

- Verification-time split appends an exact parent-finding-to-child binding map.
- Children inherit the parent's active phase with attempt zero.
- Every unresolved parent finding maps to the ordered child set containing its
  causal atoms. Ambiguous mapping terminates children inconclusive.
- A complete final discovery that produces new blockers on a non-atomic unit may
  split immediately: children with mapped blockers await remediation; children
  without blockers become locally complete. This is the reachable repeated-
  discovery split path.

Unit states distinguish local completion from post-integration terminal state.
Disposition-pending units cannot enter integration. After the one integration
phase, changed units may run persisted integration verification and ordinary
invalidated-unit work, but never another broad integration.

## Finite model-call budget — child spec requirements

The bounded resource is model process starts, not workflow runs. Each batch
reserves:

```text
batch_descriptor_count × max_output_attempts
```

before workers start. Integration uses fingerprinted
`integration_descriptors=[correctness,boundaries]` and
`integration_max_output_attempts=2`; it reserves
`integration_batch_count × 2 × 2` before any integration worker. Insufficient
remaining capacity terminates integration without a call.

Cycle state includes `max_model_calls`, `model_calls_reserved`, reservation IDs,
and one integration-scheduled flag. Active-cycle budget survives every
remediation head. A ready cycle plus non-empty user scope starts a new cycle; an
exhausted cycle needs authenticated finite override.

Every cancellation or crash leaves worst-case reservation charged. Retry or
replay cannot refund it. Split depth is finite because children have fewer
atoms; total calls are finite because no worker starts without reservation.

## Central App state prerequisite

Partitioned execution is supported only in central GitHub App mode. Direct
reusable workflows and no-write modes support full review and shadow planning
only.

A dedicated central state/continuation service is the sole authoritative writer.
It provides:

- canonical target key `(numeric_repository_id,numeric_pr_number)`;
- conditional-write version/CAS per PR cycle;
- durable command inbox;
- idempotent reservation and result events;
- durable continuation queue;
- numeric App/actor identity and repository authorization;
- HMAC-SHA-256 event signatures using a central secret unavailable to target
  workflows;
- bounded checkpoint and event retrieval.

PR markers are signed audit projections, not the concurrency authority. Generic
`github-actions[bot]` markers are never authoritative partitioned state. The
central App service validates repository ID, PR number, base/head, cycle, event
version, actor numeric ID, and status authorization before append.

The service schedules one reserved worker wave per invocation. A wake-up carries
no sole command; it only asks the service to process the durable inbox/chain, so
GitHub's one-pending-run replacement is safe. Every surviving run derives work
from CAS state and re-resolves current head. Continuation stops on no runnable
unit, budget exhaustion, blocker/triage waiting state, checkpoint failure,
integration terminal state, or cycle terminal state.

A child persistence spec must define service API, storage/CAS technology,
retention, disaster recovery, signatures, checkpoint transactions, and App
permissions before Stage 3 planning.

## Finding relation and durable status

The model may propose `introduced`, `worsened`, `pre_existing`, `unrelated`, or
`uncertain` with structured evidence, but cannot choose status.

Trusted automatic pre-existing/unrelated classification requires either:

- base and head trusted reproduction of the same normalized failure; or
- complete static causal path whose base/head blobs are identical and whose
  trusted complete dependency graph has no changed incoming path.

Otherwise relation is uncertain.

Status event contains:

```json
{
  "finding_id": "f:...",
  "status": "block_current_pr | fixed | follow_up | rejected | needs_triage",
  "basis": "introduced | worsened | verified_fix | trusted_pre_existing | trusted_unrelated | false_positive | accepted_risk | issue_created | explicit_deferral",
  "relation_evidence_event_id": "e:...",
  "actor_id": 123,
  "actor_login": "name",
  "reason": "non-empty",
  "follow_up_url": null,
  "supersedes_event_id": null
}
```

Trusted code rejects follow-up for introduced/worsened findings. Accepted risk
uses authenticated `rejected` plus basis `accepted_risk`; it remains in strict
sample evidence. False-positive rejection can be excluded from current sample
but remains audit history. A verified fix becomes `fixed`, never deletion.

Follow-up completes only with basis `issue_created` and URL, or repository-policy
allowed authenticated `explicit_deferral`. Issue creation uses a separate
central workflow/service capability with only contents read, issues write, and
minimum state-append permission—no checkout, model key, or model execution.
Issue draft is persisted durably in central state before request. Creation is
idempotent by finding ID; actor and permission are derived from GitHub, not
payload fields.

Local `review --dismiss` remains local rendering state and cannot affect hosted
`pr_ready`. Legacy local dismissals migrate only as local records or hosted
`needs_triage` provenance; durable rejection requires central authenticated
status acknowledgement.

## Global aggregation and fixer control

Global finding counts deduplicate by stable finding ID. A multi-unit finding
counts once globally and attaches to every named unit. Each unit outcome is the
highest-precedence latest condition among attached finding IDs:

```text
inconclusive > block_current_pr > needs_triage > follow_up > resolved > clean
```

Partitioned `analysis_state=complete` only when:

- atom/path coverage postcondition passed;
- every required unit batch has a valid complete result;
- every reservation is reconciled;
- no unit is inconclusive, missing, capacity-limited, or awaiting work;
- integration scope and all required integration batches completed.

Otherwise analysis is inconclusive with canonical ordered reasons.
`bounded_converged` uses this derived analysis and the globally deduplicated
strict sample table, never a legacy per-batch field.

Partitioned result adds:

```json
{
  "pr_ready": false,
  "disposition_state": "pending | complete",
  "automatic_work_permitted": true,
  "next_action": "continue_automatic_review | remediate_current_pr | await_authenticated_disposition | ready | stop_automatic_work",
  "next_action_reasons": ["open_current_pr_blocker"]
}
```

Ordering:

1. terminal budget/capacity/integration/evidence failure → `stop_automatic_work`;
2. blocker awaiting code change → `remediate_current_pr`;
3. triage/incomplete follow-up → `await_authenticated_disposition`;
4. runnable/reservable units → `continue_automatic_review`;
5. complete integration and dispositions → `ready`.

No state says “escalate after three.” `stop_automatic_work` reports exact finite
reason without auto-green or forced human-routing policy.

## Specification grouping — child spec requirements

Contract schema must persist stable contract ID, statement, ordered named
evidence paths, and evidence expectations. Findings add
`review_lane=explicit_contract|heuristic` and nullable `contract_id`. Explicit
lane requires contract ID and ordered evidence outcomes:

```json
{
  "path_base64": "...",
  "status": "passed | failed | missing | not_run",
  "evidence_kind": "observed | static-proof | inferred",
  "detail": "..."
}
```

An inferred observation cannot be published as a contract violation. Contract,
lane, and evidence outcomes are fingerprinted and preserved through merge,
status, artifacts, and rendering.

## Suppression — child spec requirements

Suppression is presentation-only. Every matched occurrence is first persisted
with unit binding, relation evidence, finding ID, and trusted status. Global and
unit results include `suppressed_observation_counts`.

Introduced/worsened occurrences remain blockers; uncertain occurrences remain
triage. A learned class cannot hide them. Suppression may hide repeated rendered
prose only for already disposition-complete false-positive/accepted policy
classes with the configured distinct trusted-actor support. It never changes
coverage, sample evidence, or `pr_ready` inputs.

## Delta reuse — disabled until enforceable context exists

The model currently reads the whole pinned head tree. Atom hashes and optional
CodeGraph Markdown do not bind everything it may use. Therefore Stage 1–5
invalidate all unit coverage on any head-tree change except finding-scoped
verification explicitly bound to persisted evidence.

Stage 6 requires one enforceable mechanism:

- trusted complete read trace whose exact blobs are hashed;
- a path/blob allowlist enforced by the model tool boundary; or
- complete structured dependency context plus full owned/dependency blob hashes.

Missing, capped, unsupported, deleted, or partial dependency data means “unknown,”
never an empty proven graph; safe fallback is full-frontier invalidation.

The Stage 6 child spec must take prior active frontier and split/coalesced lineage
as input, map old atoms first, replay surviving boundaries, place unmatched atoms
without repacking unaffected units, bind exact review-context hashes, and define
integration-coverage reuse. If proof is unavailable and a second integration is
forbidden, result is inconclusive—not ready.

## Secure persistence child-spec requirements

The central-state child spec must cover:

- dedicated App identity and numeric actor/repository/PR binding;
- HMAC envelope and key rotation;
- conditional-write reservation arithmetic derived by reducer, not caller;
- `budget_override` event and exactly-once invocation;
- checkpoint transaction begin/chunk/complete/abort and prefix resume;
- ambiguous response reconciliation and identical physical duplicate handling;
- one-time conservative legacy migration with `pr_ready=false`, integration
  incomplete, legacy findings blocker/triage, and v3 budget initialized explicitly;
- exact encoded PR-audit marker size preflight;
- finite events per cycle, status events per finding, checkpoint bytes/chunks,
  and reconstruction work;
- durable issue drafts and idempotent follow-up creation;
- no partitioned execution when persistence or writes are suppressed.

## Continuation and liveness

Large stable heads require multiple worker waves without pushes. The central
service emits coalescible wake-ups while CAS state has runnable work. It starts
one reserved wave per workflow invocation, reconciles result, then requests the
next wake-up. Lost/replaced wake-ups carry no unique command; the durable state
still contains runnable work and periodic/service reconciliation re-enqueues it.

No fixed `workflow_run` depth is used. The current 20-minute job limit bounds one
wave, not the full cycle. The absolute call/event budgets bound total work.

## Shadow activation, output, and metrics

Stage 1 is explicitly opt-in through local CLI `--partition-shadow` and hosted
input `partition_shadow: false` by default.

Local shadow capture/planning runs only after all model workers have stopped and
the existing findings/publication/result work has completed. It may add
explicitly requested local latency but cannot change model-visible context.
`--partition-shadow-out FILE` writes the complete bounded capture and manifest.

Hosted shadow runs in a separate `partition-shadow` job after the authoritative
review job. The job has its own five-minute timeout, `continue-on-error: true`,
contents-read permission only, no model key, no PR write token, and no reusable
workflow outputs. The credentialed target-resolution step performs the detached
immutable Git checkout itself and destroys the minted App token before later
steps; masked tokens never transit step/job outputs. Trusted support is checked
out separately. The job invokes capture/planning directly and uploads optional
`agentic-review-partition-shadow`. Its success, failure, timeout, or cancellation
cannot change the review job, publication, outputs, comment, summary, or gate.

Hosted output contains no blob/line content, only schemas, hashes, status,
counts, sizes, and metrics. `max_shadow_artifact_bytes=4194304` is fingerprinted.
Every capture/planner exception is represented as a bounded diagnostic; it
cannot affect authoritative review behavior.

Metrics:

- capture/manifest versions and hashes;
- atom counts by raw status/content kind;
- coverage/capacity failures;
- unit count and payload distribution;
- oversized/coalesced count;
- projected batches and calls;
- exact encoded artifact size;
- mode and benchmark revision.

Projected calls consume the runner's actual ordered pass-descriptor array and
actual max-output-attempt value supplied as data. `review-units.mjs` must not
import a separate default descriptor list or hard-code `3 × 2`.

## Implementation PR sequence

1. **Shared canonical capture and shadow atomization**
   - extract shared canonical JSON/hash owner;
   - capture patch/raw-z/blob input from immutable scope;
   - implement byte-safe path/path-event/text atoms and coverage fixtures;
   - emit shadow artifact only.
2. **Deterministic path-fallback shadow manifest**
   - path grouping, packing, coalescing, split fixtures, oversized metrics;
   - no model/prompt/gate change.
3. **Benchmark manifest and evaluator**
   - versioned labels, adjudication, repeated-run metrics and shadow telemetry.
4. **Central state service child spec and implementation**
   - dedicated App/CAS/queue/signatures/migration/capacity.
5. **Shared execution profile, binding, finite scheduler**
   - discriminated anchors, trusted IDs, reservations, transitions, split
     finding rebind, one wave per run.
6. **Opt-in integration and fixer-control outputs**
   - one bounded integration phase, `pr_ready`, `next_action`.
7. **Durable dispositions and specification grouping**
8. **Enforceable-context delta reuse**
9. **Learned suppression**

Each PR must preserve full-mode behavior and pass the complete existing suite
plus its new contract tests. Stages 4–9 require their child spec approval before
implementation planning.

## Stage 1 acceptance criteria

- [ ] Full-mode diff bytes, scope hash, prompts, model calls, publications,
  workflow outputs, and gates remain unchanged.
- [ ] One trusted capture from fixed base/head binds exact patch, raw-z, object
  format, flags, and complete referenced blob table.
- [ ] Every raw record has one path-event atom and every changed line has one text
  atom; coverage mismatch is reported in shadow output.
- [ ] Paths remain canonical bytes through base64; UTF-8 display is optional.
- [ ] The complete Git change fixture matrix passes, including combined events
  and invalid path bytes.
- [ ] Canonical atom payloads, ordering, IDs, and hashes have literal expected
  fixtures.
- [ ] Path-fallback unit packing/coalescing is deterministic and scope-complete.
- [ ] Shadow artifact records projected sizes/calls and cannot affect analysis or
  readiness.
- [ ] No new GitHub mutation, permission, model credential, or model invocation
  is introduced.

## Program acceptance criteria

- [ ] Every model attempt is durably reserved through authoritative central CAS
  before a credential-free worker starts.
- [ ] Active-cycle budget cannot reset through push, retry, cancellation, or
  replay.
- [ ] Unit transitions and split finding rebinding are complete and finite.
- [ ] Every finding has trusted manifest/unit/scope binding and discriminated
  text/path-event anchor.
- [ ] Causal evidence, lifecycle basis, actor, and status aggregate
  deterministically across multi-unit findings.
- [ ] Suppressed observations remain persisted evidence.
- [ ] Local dismissal cannot affect hosted readiness.
- [ ] Partitioned analysis completeness is derived from exact atom, unit,
  reservation, and integration state.
- [ ] `bounded_converged` keeps strict meaning; `pr_ready` and `next_action`
  control fixer behavior without an arbitrary three-round stop.
- [ ] Exactly one bounded integration phase runs per cycle.
- [ ] Delta reuse is impossible until exact model-read context is bound.
- [ ] Direct/no-write mode cannot execute unreserved partitioned work.
- [ ] Dedicated App state, continuation, follow-up, and migration paths remain
  separate from the read-only model worker.
- [ ] Partitioned execution remains opt-in until every numeric release gate
  passes.

## Risks and tradeoffs

- The safe central state service is new infrastructure; generic GitHub review
  markers alone cannot provide authenticated CAS or a durable command queue.
- Partitioned batches can increase model calls. Absolute reservations make cost
  finite and visible.
- Initial path-only grouping is less semantically coherent but complete and
  testable; semantic grouping is added only after structured completeness.
- Partitioning can miss cross-unit defects; one bounded integration phase
  mitigates but cannot eliminate the risk.
- Disabling delta reuse initially costs repeated work but avoids laundering
  untracked model context into stale coverage.
- Follow-up policy can become an escape hatch; trusted base/head evidence and
  machine-readable disposition basis prevent silent deferral.
- Statistical novelty can guide offline scheduling later, but correlated model
  errors and small live samples remain unsuitable for merge gating.
