# Partitioned Review Convergence Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in, diagnostic-only canonical Git capture, complete atomization, deterministic path-fallback manifests, and shadow metrics without changing any existing review behavior.

## Assumptions checked

- repo topology — covered: one JavaScript/shell repository; work executes in the existing `feat/partitioned-review-convergence` linked worktree and changes only this repository.
- credential locus — covered: Stage 1 performs no GitHub mutation and adds no credential; the existing model key remains confined to the unchanged runner step.
- execution locus — covered: trusted support executes capture/planning locally and in the hosted runner against already-resolved immutable base/head commits.
- state durability — covered: shadow output is a local file or optional seven-day diagnostics artifact only; it is explicitly non-authoritative.
- review surface — covered: current prompt, model calls, findings, publication, comments, job summary, outputs, and gate remain byte-for-byte/semantically unchanged.
- agent stream — covered: Stage 1 does not modify OMP prompt content, tools, session stream, or invocation count.
- dispatched model — covered: the configured model and actual runner descriptor/attempt data are read only for projected metrics; no shadow model is dispatched.

**Architecture:** Extract one credential-neutral canonical JSON/hash primitive, then add `review-capture.mjs` for bounded immutable Git capture and `review-units.mjs` for pure validation, atomization, partitioning, and shadow metrics. `run-review.sh` invokes the shadow pipeline only when explicitly enabled, catches every shadow failure, and publishes a separate atomic diagnostic file without feeding it into existing result construction.

**Tech Stack:** Node.js ESM, built-in `node:crypto`, `node:fs`, `node:child_process`, Bash, Git plumbing/porcelain commands, Node's built-in test runner.

**Spec:** Approved program spec at `docs/specs/2026-08-28-partitioned-review-convergence-design.md`, commit `ea5f5c3` plus the approved parallel-review refinements on this branch. This plan implements only the spec's Stage 1 boundary.

## Global Constraints

- Stage 1 is opt-in: CLI `--partition-shadow`, hosted input `partition_shadow: false`, environment `AGENTIC_REVIEW_PARTITION_SHADOW=false`.
- Full-mode diff bytes, scope hash, prompts, model calls, publications, outputs, comments, summaries, and gates must not change.
- Capture limits: patch 8,388,608 bytes; raw-z 8,388,608 bytes; one blob 16,777,216 bytes; cumulative blobs 67,108,864 bytes; wall time 30 seconds.
- Atom target: 16,000 canonical payload bytes; unit target: 64,000 bytes; maximum frontier units: 128.
- Hosted shadow artifact limit: 4,194,304 bytes; overflow emits a compact diagnostic envelope, never truncates authoritative capture because shadow state is non-authoritative.
- Git capture uses full object IDs, `myers`, three context lines, 50% rename/copy detection, copy-harder mode, no external diff, no textconv, and no color.
- Git paths remain canonical bytes encoded as base64; optional display paths never participate in identity or grouping.
- Mode `160000` gitlink IDs are not fetched as blobs.
- Any shadow failure or capacity result leaves the existing review running and successful/failing exactly as it would with shadow disabled.
- No new runtime dependency or GitHub permission.

## File structure

- Create `scripts/lib-canonical-json.mjs` — credential-neutral canonical plain-JSON serialization and SHA-256.
- Create `scripts/lib-canonical-json.test.mjs` — literal canonicalization/hash contract.
- Create `scripts/review-capture.mjs` — bounded Git subprocess capture, raw-record parsing needed for blob collection, complete/diagnostic capture schema, atomic local output.
- Create `scripts/review-capture.test.mjs` — temporary-Git capture, full-ID, copy, gitlink, capacity, deadline, and invalid-path fixtures.
- Create `scripts/review-units.mjs` — captured-input validation, path/text atomization, coverage postcondition, deterministic path partition, compact shadow projection.
- Create `scripts/review-units.test.mjs` — literal atoms, IDs, byte accounting, partition/coalescing, and failure fixtures.
- Create `scripts/fixtures/partition-shadow-evaluator-v1.json` — versioned evaluator fixture contract with literal expected metrics.
- Modify `scripts/review-result.mjs` — consume shared canonical JSON/hash; retain credential rejection around configuration fingerprints.
- Modify `scripts/review-result.test.mjs` — prove generic canonical JSON permits ordinary keys while configuration fingerprints still reject credential-shaped keys.
- Modify `scripts/run-review.sh` — flags/env, actual descriptor/attempt projection, best-effort shadow invocation, atomic shadow output.
- Modify `scripts/run-review.test.mjs` — disabled equivalence, enabled artifact, failure isolation, output bounds, and unusual Git changes.
- Modify `.github/workflows/agentic-review.yml` — opt-in input/env and optional diagnostic artifact path only.
- Modify `scripts/install-review.sh` — optional installer flag forwarding `partition_shadow: true`.
- Modify `README.md` — document diagnostic-only shadow mode and explicit non-gating semantics.
- Modify `.github/workflows/test.yml` — add new focused test files to the existing explicit test command.

---

<!-- mship:task id=1 -->
### Task 1: Extract canonical JSON and hashing ownership

**Files:**
- Create: `scripts/lib-canonical-json.mjs`
- Create: `scripts/lib-canonical-json.test.mjs`
- Modify: `scripts/review-result.mjs:55-135`
- Modify: `scripts/review-result.test.mjs:330-405`
- Modify: `.github/workflows/test.yml:31-37`

**Interfaces:**
- Consumes: plain JSON values only.
- Produces:
  - `isPlainJsonObject(value: unknown): boolean`
  - `canonicalJson(value: unknown, path?: string): string`
  - `canonicalSha256(value: unknown, path?: string): string`
- `review-result.mjs` retains private `assertNoCredentialFields(value, path)` and exports unchanged `configurationFingerprint`, `scopeHash`, and publication APIs.

- [ ] **Step 1: Add the canonical library tests**

Create `scripts/lib-canonical-json.test.mjs` with literal expectations:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, canonicalSha256, isPlainJsonObject } from "./lib-canonical-json.mjs";

test("canonical JSON sorts object keys and preserves array order", () => {
  assert.equal(canonicalJson({ z: [3, 2, 1], a: { y: true, x: null } }),
    '{"a":{"x":null,"y":true},"z":[3,2,1]}');
});

test("canonical JSON permits ordinary secret-shaped data outside configuration policy", () => {
  assert.equal(canonicalJson({ token: "ordinary-domain-value" }),
    '{"token":"ordinary-domain-value"}');
});

test("canonical JSON rejects non-plain and lossy values", () => {
  assert.throws(() => canonicalJson({ missing: undefined }), /plain JSON data/);
  assert.throws(() => canonicalJson({ number: Number.NaN }), /plain JSON data/);
  assert.throws(() => canonicalJson(new Date()), /plain JSON data/);
  const sparse = [];
  sparse[1] = "x";
  assert.throws(() => canonicalJson(sparse), /plain JSON data/);
});

test("canonical SHA-256 is key-order independent", () => {
  assert.equal(canonicalSha256({ b: 2, a: 1 }), canonicalSha256({ a: 1, b: 2 }));
  assert.match(canonicalSha256({ a: 1 }), /^[0-9a-f]{64}$/);
});

test("plain-object detection excludes arrays and custom prototypes", () => {
  assert.equal(isPlainJsonObject({}), true);
  assert.equal(isPlainJsonObject([]), false);
  assert.equal(isPlainJsonObject(Object.create(null)), false);
});
```

- [ ] **Step 2: Run the new test to verify RED**

Run:

```bash
node --test scripts/lib-canonical-json.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib-canonical-json.mjs`.

- [ ] **Step 3: Implement the credential-neutral owner**

Create `scripts/lib-canonical-json.mjs`:

```js
import { createHash } from "node:crypto";

export function isPlainJsonObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

export function canonicalJson(value, path = "value") {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    const items = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError(`${path} must contain only plain JSON data`);
      }
      items.push(canonicalJson(value[index], `${path}[${index}]`));
    }
    return `[${items.join(",")}]`;
  }
  if (!isPlainJsonObject(value)) {
    throw new TypeError(`${path} must contain only plain JSON data`);
  }
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key], `${path}.${key}`)}`
  )).join(",")}}`;
}

export function canonicalSha256(value, path = "value") {
  return createHash("sha256").update(canonicalJson(value, path)).digest("hex");
}
```

- [ ] **Step 4: Run the canonical tests to verify GREEN**

Run:

```bash
node --test scripts/lib-canonical-json.test.mjs
```

Expected: 5 tests pass.

- [ ] **Step 5: Migrate `review-result.mjs` without weakening credential rejection**

Import the shared functions. Replace the private `canonicalize` implementation with a recursive `assertNoCredentialFields` that uses the existing `isCredentialField` logic, then compute:

```js
export function configurationFingerprint(config) {
  if (!isPlainJsonObject(config)) {
    throw new TypeError("configuration must contain only plain JSON data");
  }
  assertNoCredentialFields(config, "configuration");
  return canonicalSha256(config, "configuration");
}
```

Use `canonicalSha256(scope, "scope")` inside `inspectCanonicalScope`. Remove the duplicate private plain-object/canonical serializer only after every caller migrates.

- [ ] **Step 6: Prove configuration policy is unchanged**

Add to `scripts/review-result.test.mjs`:

```js
test("generic canonical JSON and configuration credential policy remain separate", () => {
  assert.throws(
    () => configurationFingerprint({ model: "example", api_key: "forbidden" }),
    /credential field configuration\.api_key/,
  );
});
```

Run:

```bash
node --test scripts/lib-canonical-json.test.mjs scripts/review-result.test.mjs
```

Expected: all tests pass, including existing fingerprint/scope fixtures unchanged.

- [ ] **Step 7: Add the new test file to CI**

Append `scripts/lib-canonical-json.test.mjs` to the explicit Node test command in `.github/workflows/test.yml`.

- [ ] **Step 8: Commit Task 1**

```bash
git add scripts/lib-canonical-json.mjs scripts/lib-canonical-json.test.mjs scripts/review-result.mjs scripts/review-result.test.mjs .github/workflows/test.yml
git commit -m "refactor: share canonical JSON hashing"
```
<!-- /mship:task -->

<!-- mship:task id=2 -->
### Task 2: Capture immutable Git inputs with bounded failure envelopes

**Files:**
- Create: `scripts/review-capture.mjs`
- Create: `scripts/review-capture.test.mjs`
- Create: `scripts/review-units.mjs` (captured-input/raw-record schemas only in this task)
- Modify: `.github/workflows/test.yml`

**Interfaces:**
- Consumes:
  - repository root and full immutable base/head object IDs;
  - explicit `CaptureLimits`.
- Produces:
  - `captureReviewInput(options): Promise<CaptureComplete | CaptureDiagnostic>`
  - `validateCapturedReviewInput(value): CaptureComplete | CaptureDiagnostic`
  - `parseRawDiffZ(bytes, objectFormat): RawRecord[]`
  - `writeJsonAtomic(path, value): void`
- `CaptureComplete.status === "complete"`; diagnostics never contain patch/raw/blob content or `capture_hash`.
- CLI: `node scripts/review-capture.mjs capture --repo ROOT --base SHA --head SHA --limits LIMITS_JSON --out CAPTURE_JSON` writes one complete or diagnostic JSON document and exits 0; usage/output-write failure exits 2/1 respectively.

Use these JSDoc contracts in `review-capture.mjs`:

```js
/** @typedef {{
 * maxPatchBytes:number, maxRawZBytes:number,
 * maxSingleBlobBytes:number, maxTotalBlobBytes:number,
 * maxCaptureMilliseconds:number
 * }} CaptureLimits */

/** @typedef {{
 * repoRoot:string, baseSha:string, headSha:string,
 * limits:CaptureLimits, outputPath?:string
 * }} CaptureOptions */
```
The CLI limits file uses exact snake-case schema:

```json
{
  "schema_version": 1,
  "max_patch_bytes": 8388608,
  "max_raw_z_bytes": 8388608,
  "max_single_blob_bytes": 16777216,
  "max_total_blob_bytes": 67108864,
  "max_capture_seconds": 30
}
```

`parseCaptureLimits` validates exact keys and maps seconds to
`maxCaptureMilliseconds` with safe integer multiplication by 1000.

- [ ] **Step 1: Write failing raw-record and complete-capture tests**

Create a temporary Git repository in `review-capture.test.mjs`. Configure `core.abbrev=5`, commit a base file, then create a rename/copy/mode/text change. Assert:

```js
const result = await captureReviewInput({
  repoRoot,
  baseSha,
  headSha,
  limits: TEST_LIMITS,
});
assert.equal(result.status, "complete");
assert.equal(result.base_sha.length, 40);
assert.equal(result.head_sha.length, 40);
assert.ok(result.patch_argv.includes("--no-abbrev"));
assert.ok(result.raw_argv.includes("--find-copies-harder"));
assert.ok(result.raw_z_base64.length > 0);
assert.ok(result.object_table.every((row) => row.object_type === "blob"));
assert.match(result.capture_hash, /^[0-9a-f]{64}$/);
```

Include a literal `parseRawDiffZ` test for a one-path `M`, one-path `A`, one-path `D`, two-path `R087`, and two-path `C100`, asserting null/old/new normalization and full object IDs.

Extend the temporary-Git matrix with binary add/modify/delete, rename and copy
with/without edits, regular-to-symlink and symlink-target changes, newline/tab
and invalid-byte paths, unsupported extensions, and non-default `diff.algorithm`,
`diff.renames`, external-diff, textconv, quoting, and abbreviation config.

- [ ] **Step 2: Run the capture test to verify RED**

```bash
node --test scripts/review-capture.test.mjs
```

Expected: FAIL with missing `review-capture.mjs`/`review-units.mjs` exports.

- [ ] **Step 3: Implement raw-z parsing and discriminated schema validation**

In `review-units.mjs`, export constants for raw status mapping and implement:

```js
export function parseRawDiffZ(bytes, objectFormat) {
  const objectHexLength = objectFormat === "sha256" ? 64 : 40;
  // Parse colon-prefixed metadata through NUL records without UTF-8 path decoding.
  // Return oldPath/newPath as Buffer or null and preserve raw status/similarity.
}
```

Reject abbreviated IDs, malformed record field counts, missing second paths for `R/C`, unexpected second paths for one-path statuses, and unknown object format. Keep paths as `Buffer` until schema projection to canonical base64.

Implement `validateCapturedReviewInput` as an exact-key discriminated validator:

- complete requires patch/raw base64, blob table, and matching capture hash;
- capacity/failure requires configuration/argv/reason/lower bounds and forbids complete fields;
- gitlink IDs are valid raw references but absent from the blob table;
- table rows are unique and canonically ordered.

- [ ] **Step 4: Implement bounded capture**

In `review-capture.mjs`, define literal patch/raw argv builders sharing:

```js
const gitEnvironment = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_EXTERNAL_DIFF: "",
  GIT_DIFF_OPTS: "",
};
const gitConfigOverrides = [
  "diff.external=",
  "diff.algorithm=myers",
  "diff.renames=copies",
  "core.quotePath=false",
];
const gitPrefix = [
  "git",
  ...gitConfigOverrides.flatMap((value) => ["-c", value]),
  "diff",
];
const commonDiffFlags = [
  "--find-renames=50%", "--find-copies=50%", "--find-copies-harder",
  "--no-ext-diff", "--no-textconv", "--no-color",
];
const patchArgv = [
  ...gitPrefix, "--patch", "--no-raw", "--no-abbrev", "--full-index",
  "--diff-algorithm=myers", "--unified=3",
  ...commonDiffFlags, baseSha, headSha, "--",
];
const rawArgv = [
  ...gitPrefix, "--raw", "-z", "--no-patch", "--no-abbrev", "--full-index",
  "--diff-algorithm=myers",
  ...commonDiffFlags, baseSha, headSha, "--",
];
```

Spawn Git with exact persisted `gitEnvironment` and ordered
`gitConfigOverrides` shown above, passing each override as `-c <value>` before
`diff`. Stream stdout to private temporary files, count bytes before each write,
and kill the complete child process group on byte/deadline limit. Parse raw
records, query `git cat-file --batch-check`, skip zero and mode-160000 commit
IDs, and stream admitted blobs through SHA-256 under individual/cumulative
limits. Persist the environment and overrides in complete and diagnostic
envelopes.

A limit result returns `capture_capacity_exceeded`; a Git/process/parser failure
returns `capture_failed` with `capacity_reason: "process_error"`. Both remove
temporary content and return only the bounded diagnostic envelope:

```js
{
  schema_version: 1,
  status: "capture_capacity_exceeded",
  base_sha: baseSha,
  head_sha: headSha,
  capture_configuration: configuration,
  patch_argv: patchArgv,
  raw_argv: rawArgv,
  git_environment: gitEnvironment,
  git_config_overrides: gitConfigOverrides,
  capacity_reason: "raw_z_bytes",
  observed_lower_bounds: {
    patch_bytes: 0, raw_z_bytes: limits.maxRawZBytes + 1,
    blob_bytes: 0, blob_count: 0, elapsed_milliseconds: elapsed,
  },
}
```

Complete capture computes `capture_hash` with `canonicalSha256` and optionally writes through `writeJsonAtomic` using same-directory stage plus `renameSync` after symlink-destination rejection consistent with existing output paths.

- [ ] **Step 5: Add gitlink and capacity/deadline regressions**

Create a local submodule repository and a superproject gitlink update. Assert the gitlink full ID appears in the raw path event but no object-table row attempts to read it as a blob.

Add injected tiny limits and a slow fake Git executable to assert:

- patch/raw/blob/deadline reasons;
- no complete fields or capture hash;
- no partial output file;
- full process tree terminates.
- process-error status/reason with no source/stderr field in capture JSON; CLI
  stderr is separate, and Task 5 alone converts bounded failure text into the
  redacted `ShadowDiagnostic.diagnostic`;
- capture equality under every neutralized non-default Git configuration.

- [ ] **Step 6: Verify capture tests**

```bash
node --test scripts/lib-canonical-json.test.mjs scripts/review-capture.test.mjs
```

Expected: all capture/raw/blob/capacity tests pass.

- [ ] **Step 7: Register tests and commit Task 2**

Add `scripts/review-capture.test.mjs` to `.github/workflows/test.yml`.

```bash
git add scripts/review-capture.mjs scripts/review-capture.test.mjs scripts/review-units.mjs .github/workflows/test.yml
git commit -m "feat: capture shadow review inputs"
```
<!-- /mship:task -->

<!-- mship:task id=3 -->
### Task 3: Atomize every raw record and changed line

**Files:**
- Modify: `scripts/review-units.mjs`
- Create: `scripts/review-units.test.mjs`
- Modify: `.github/workflows/test.yml`

**Interfaces:**
- Consumes: validated `CaptureComplete` only.
- Produces:
  - `atomizeCapturedReviewInput(capture): AtomizationResult`
  - `validateAtomization(result, capture): AtomizationResult`
  - `AtomizationResult = {status:"complete", atoms, coverage} | {status:"atom_coverage_mismatch", reasons, counts}`
- Path atoms own raw records; text atoms own old/new changed lines independently.

- [ ] **Step 1: Write literal path-event classification tests**

Use hand-authored complete captures with exact raw-z/patch/blob bytes. Assert a combined rename+mode+text record yields one path atom:

```js
const {
  lineage_candidate,
  segment_ordinal,
  content_hash,
  atom_id,
  ...pathPayload
} = pathAtom;
assert.deepEqual(pathPayload, {
  kind: "path_event",
  raw_status: "R087",
  status_kind: "rename",
  content_kinds: ["text", "mode"],
  owner_path_base64: Buffer.from("new.txt").toString("base64"),
  old_path_base64: Buffer.from("old.txt").toString("base64"),
  new_path_base64: Buffer.from("new.txt").toString("base64"),
  old_mode: "100644",
  new_mode: "100755",
  old_object_id: OLD_ID,
  new_object_id: NEW_ID,
  similarity: 87,
  old_blob_sha256: OLD_SHA256,
  new_blob_sha256: NEW_SHA256,
});
assert.equal(segment_ordinal, 0);
assert.match(lineage_candidate, /^p:[0-9a-f]{64}$/);
assert.match(content_hash, /^[0-9a-f]{64}$/);
assert.match(atom_id, /^a:[0-9a-f]{64}$/);
```

Table-drive A/D/M/R/C/T, binary, empty, symlink, gitlink, and unknown status. Unknown status must return diagnostic failure rather than guess.

The `content_kinds` classifier uses fixed order
`text,binary,mode,symlink,submodule,empty,other` and the literal decision table
from the spec. Add a table-driven test for each condition and combined
rename+mode+text.

- [ ] **Step 2: Write literal byte-preserving text atom tests**

Fixtures must assert:

- CR remains in line bytes and LF is terminator;
- no-final-newline uses `terminator:"none"`;
- invalid UTF-8 line/path bytes survive base64;
- old-side deletions own old lines and new-side additions own new lines;
- one line over 16,000 payload bytes becomes one oversized atom;
- segment ordinal is derived from the pre-ID tuple before atom ID.

The text payload contract is exactly:

```js
{
  kind: "text",
  owner_path_base64: "bmV3LnR4dA==",
  old_path_base64: "b2xkLnR4dA==",
  new_path_base64: "bmV3LnR4dA==",
  old_start: 10,
  old_count: 1,
  new_start: 10,
  new_count: 1,
  old_lines: [{ bytes_base64: "b2xkDQ==", terminator: "lf" }],
  new_lines: [{ bytes_base64: "bmV3DQ==", terminator: "lf" }],
  old_final_newline: true,
  new_final_newline: true,
  oversized: false
}
```

`content_hash` independently hashes `canonicalJson(payload)`.
`lineage_candidate` is the exact string
`t:<sha256(canonicalJson({kind:"text",old_path_base64,new_path_base64,old_start,old_count,new_start,new_count}))>`.
Path-event candidate uses prefix `p:` and canonical
`{kind:"path_event",raw_status,status_kind,content_kinds,old_path_base64,new_path_base64}`.
`atom_id` hashes
`{atom_schema_version:1,lineage_candidate,segment_ordinal,content_hash}`. Tests
derive expected hashes with `node:crypto` over literal canonical strings, not
the production hashing helper.

Segmentation test/implementation walks each maximal changed block in patch
record order. It appends one `-`/`+` line to the candidate, canonical-encodes the
prospective payload, and finalizes the nonempty candidate before a line that
would exceed 16,000 bytes. Old/new cursors advance only for their side. A single
over-limit line is one oversized segment.

- [ ] **Step 3: Run atom tests to verify RED**

```bash
node --test scripts/review-units.test.mjs
```

Expected: FAIL because atomization exports are absent.

- [ ] **Step 4: Implement byte-preserving patch parsing and atom projection**

In `review-units.mjs`:

- decode canonical base64 to `Buffer`;
- parse diff headers/hunks without converting arbitrary path/line bytes to Unicode;
- correlate raw records to patch path records using canonical old/new path bytes;
- frame lines as `{bytes_base64, terminator}`;
- calculate canonical payload byte length with `canonicalJson`;
- split changed runs only at line boundaries;
- create path and text lineage candidates;
- sort the pre-ID tuple, assign ordinal, then hash atom ID.

Do not import or call CodeGraph in Stage 1.

- [ ] **Step 5: Implement and test the coverage postcondition**

Track raw-record index ownership and old/new changed-line ownership. `validateAtomization` must reject:

- missing path owner;
- duplicate path owner;
- missing changed line;
- duplicate changed line;
- raw/patch path disagreement;
- mode/object/blob disagreement;
- partial diagnostic capture passed as complete.

Use literal expected ordered reason codes.

- [ ] **Step 6: Run focused tests and register CI**

```bash
node --test scripts/review-capture.test.mjs scripts/review-units.test.mjs
```

Expected: all tests pass. Add `scripts/review-units.test.mjs` to `.github/workflows/test.yml`.

- [ ] **Step 7: Commit Task 3**

```bash
git add scripts/review-units.mjs scripts/review-units.test.mjs .github/workflows/test.yml
git commit -m "feat: atomize complete review scope"
```
<!-- /mship:task -->

<!-- mship:task id=4 -->
### Task 4: Build deterministic manifests and evaluator fixtures

**Files:**
- Modify: `scripts/review-units.mjs`
- Modify: `scripts/review-units.test.mjs`
- Create: `scripts/fixtures/partition-shadow-evaluator-v1.json`

**Interfaces:**
- Consumes complete atomization, exact shadow configuration, actual execution
  profile, and benchmark revision string.
- Produces:
  - `buildPathFallbackManifest({capture, atomization, config, executionProfile}): ShadowManifest`
  - `buildLocalShadowOutput(capture, manifest): ShadowLocalOutput`
  - `buildHostedShadowOutput(capture, manifest, maxBytes): ShadowDiagnostics`
  - `buildShadowDiagnostic(details, maxBytes): ShadowDiagnostic`
  - `splitUnit(unit): [leftChild, rightChild]`
  - `validatePartitionShadowEvaluatorFixture(value): EvaluatorFixture`
- CLI:
  `node scripts/review-units.mjs shadow --capture CAPTURE_JSON --profile PROFILE_JSON --config CONFIG_JSON --local-out LOCAL_JSON --diagnostics-out DIAGNOSTIC_JSON`.
  Either output flag may be omitted. Usage exits 2; unsafe/output-write failure
  exits 1; complete or bounded diagnostic planning exits 0.

`ShadowManifest` exact top-level schema:

```js
{
  schema_version: 1,
  status: "complete",
  mode: "partition_shadow",
  capture_hash: "64-hex",
  benchmark_revision: "",
  configuration: {
    atom_target_bytes: 16000,
    unit_target_bytes: 64000,
    max_frontier_units: 128,
    max_shadow_artifact_bytes: 4194304,
  },
  execution_projection: {
    descriptors: ["general", "correctness", "boundaries"],
    descriptor_content_hashes: ["64-hex", "64-hex", "64-hex"],
    max_output_attempts: 2,
    projected_batches: 3,
    projected_model_calls: 18,
  },
  atoms: [],
  units: [],
  counts: {
    atoms: 0,
    path_events: 0,
    text_atoms: 0,
    oversized_atoms: 0,
    coalesced_units: 0,
    by_raw_status: {},
    by_content_kind: {},
  },
  sizes: {
    atom_payload_bytes: 0,
    unit_payload_bytes: 0,
  },
  manifest_hash: "64-hex",
}
```

`projected_batches` is exactly `units.length` in Stage 1: one-unit-per-batch is
the conservative projection, not execution behavior. `projected_model_calls`
uses `executionProfile.descriptors.length` and `max_output_attempts`;
`descriptors` and aligned `descriptor_content_hashes` are copied unchanged into
metrics.

`manifest_hash` is `canonicalSha256(manifestCore)` where `manifestCore` contains
every field above except `manifest_hash`. Output byte size is measured only at
write/projection time as `Buffer.byteLength(`${canonicalJson(output)}\\n`)`, so
it cannot make manifest hash circular.

- [ ] **Step 1: Write failing literal partition and schema fixtures**

Create six atoms across raw-byte owner paths `a`, `b`, and `0xff`, with tiny
limits. Assert path-byte order, path-event-first order, unit break, oversized
singleton, root lineage ordinal, exact independent unit hash, payload bytes,
coalesced lineage, and adjacent-pair tie break.

Use independent `node:crypto` hashes over literal canonical strings for expected
IDs. Assert shuffled input creates identical canonical manifest.

- [ ] **Step 2: Define the versioned evaluator fixture contract**

Create `scripts/fixtures/partition-shadow-evaluator-v1.json`:

```json
{
  "schema_version": 1,
  "benchmark_revision": "partition-shadow-fixture-v1",
  "repository_fixture": "review-units-literal-v1",
  "capture_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "expected": {
    "atom_counts": {
      "path_events": 3,
      "text_atoms": 3
    },
    "unit_count": 3,
    "oversized_atoms": 1,
    "coalesced_units": 0,
    "projected_batches": 3,
    "projected_model_calls": 18
  }
}
```

The validator requires exact keys, positive/nonnegative integer fields, 64-hex
capture hash, and non-empty bounded revision/fixture strings. A test applies the
fixture to the literal manifest and compares every expected metric.

- [ ] **Step 3: Run manifest tests to verify RED**

```bash
node --test --test-name-pattern='manifest|partition|coalesc|evaluator' scripts/review-units.test.mjs
```

Expected: FAIL with missing manifest/evaluator exports.

- [ ] **Step 4: Implement exact packing, coalescing, schema, and metrics**

Implement the approved algorithm. Unit ID input is:

```js
{
  unit_schema_version: 1,
  unit_lineage: lineage,
  ordered_atom_ids: atoms.map(({ atom_id }) => atom_id),
  coalesced_from: childLineages,
}
```

Count raw status and content kinds in sorted-key plain objects. Sum atom/unit
payload bytes from canonical payload lengths. Validate the complete manifest
before returning.

- [ ] **Step 5: Implement complete, compact, and diagnostic outputs**

`buildLocalShadowOutput` returns:

```js
{
  schema_version: 1,
  status: "complete",
  mode: "partition_shadow",
  capture,
  manifest
}
```

It may contain bounded blob/line bytes and is written only to an explicit local
path. `buildHostedShadowOutput` strips blob/line content and returns this exact
complete schema:

```js
{
  schema_version: 1,
  status: "complete",
  capture_hash: "64-hex",
  mode: "partition_shadow",
  manifest_hash: "64-hex",
  benchmark_revision: "",
  configuration: {
    atom_target_bytes: 16000,
    unit_target_bytes: 64000,
    max_frontier_units: 128,
    max_shadow_artifact_bytes: 4194304,
  },
  execution_projection: {
    descriptors: ["general"],
    descriptor_content_hashes: ["64-hex"],
    max_output_attempts: 2,
    projected_batches: 1,
    projected_model_calls: 2,
  },
  objects: [{
    object_id: "40-or-64-hex",
    object_type: "blob",
    modes: ["100644"],
    size: 100,
    content_sha256: "64-hex",
  }],
  atoms: [{
    atom_id: "a:64-hex",
    kind: "path_event | text",
    lineage_candidate: "bounded string",
    segment_ordinal: 0,
    content_hash: "64-hex",
    owner_path_base64: "YQ==",
    payload_bytes: 100,
    oversized: false,
    status_kind: "modify | null",
    content_kinds: ["text"],
  }],
  units: [{
    unit_id: "64-hex",
    unit_lineage: "root:path:hash:0",
    ordered_atom_ids: ["a:64-hex"],
    coalesced_from: [],
    unit_payload_bytes: 100,
    atomic: true,
    oversized: false,
  }],
  counts: {
    atoms: 1,
    path_events: 1,
    text_atoms: 0,
    oversized_atoms: 0,
    coalesced_units: 0,
    by_raw_status: { M: 1 },
    by_content_kind: { text: 1 },
  },
  sizes: {
    atom_payload_bytes: 100,
    unit_payload_bytes: 100,
    encoded_output_bytes: 0,
  },
}
```

Every atom row has all keys; irrelevant `status_kind` is null and
`content_kinds` is empty for text atoms. No line arrays, blob content, old/new
line bytes, or complete capture table appears.
If hosted complete output exceeds limit, return:

```js
{
  schema_version: 1,
  status: "artifact_compacted",
  mode: "partition_shadow",
  capture_hash: manifest.capture_hash,
  manifest_hash: manifest.manifest_hash,
  benchmark_revision: manifest.benchmark_revision,
  counts: manifest.counts,
  sizes: { encoded_output_bytes: 0 },
  omitted: ["atoms", "units"]
}
```

All capture/planner/atom diagnostics use:

```js
{
  schema_version: 1,
  status: "capture_capacity_exceeded | capture_failed | planner_failed | atom_coverage_mismatch",
  mode: "partition_shadow",
  base_sha: "40-or-64-hex",
  head_sha: "40-or-64-hex",
  benchmark_revision: "",
  capture_hash: null,
  manifest_hash: null,
  reason_codes: ["raw_z_bytes"],
  diagnostic: "bounded UTF-8 text",
  observed_lower_bounds: {
    patch_bytes: 0,
    raw_z_bytes: 0,
    blob_bytes: 0,
    blob_count: 0,
    elapsed_milliseconds: 0
  },
  counts: {},
  sizes: { encoded_output_bytes: 0 }
}
```

`capture_hash` is non-null for atom/planner diagnostics derived from a complete
capture; `manifest_hash` is non-null only after manifest construction.
`diagnostic` is truncated to 512 UTF-8 bytes with a fixed suffix. Reason codes
are unique canonical order. Local and hosted diagnostics share this redacted
schema and never contain source bytes.

`withEncodedOutputSize` canonical-encodes the object plus newline, updates
`sizes.encoded_output_bytes`, and repeats until the decimal value and encoded
length stabilize; validation recomputes exact equality. If a complete output is
over limit, compact first, then size. Never slice JSON.

- [ ] **Step 6: Add determinism, split, union, evaluator, diagnostic, and size tests**

For generated 1–256 atom lists, shuffle repeatedly and assert identical output.
Assert atom union across units exactly once and evaluator expected metrics.

Test `splitUnit` byte-balanced boundary, lower-index tie break, `/0`/`/1`
lineage, exact child union, each child smaller/nonempty, and atomic-unit
rejection.

Assert local output retains content; hosted output contains no blob/line bytes;
every diagnostic status has exact keys/reasons/hash nullability and <=512-byte
text; encoded-size field equals bytes written; compact output remains within
limit.

- [ ] **Step 7: Run and commit Task 4**

```bash
node --test scripts/review-units.test.mjs
git add scripts/review-units.mjs scripts/review-units.test.mjs scripts/fixtures/partition-shadow-evaluator-v1.json
git commit -m "feat: plan shadow review units"
```
<!-- /mship:task -->
<!-- mship:task id=5 -->
### Task 5: Integrate local shadow planning after authoritative review work

**Files:**
- Modify: `scripts/run-review.sh:1-170,721-760,747-955,1485-1567`
- Modify: `scripts/run-review.test.mjs`

**Interfaces:**
- Consumes CLI `--partition-shadow` and `--partition-shadow-out FILE`.
- Uses actual ordered pass descriptors and one runner-owned
  `PASS_MAX_ATTEMPTS=2` for projection.
- Produces optional complete local shadow JSON after all model workers and
  existing review output/publication/result work complete.
- Adds no hosted environment interface; Task 6 invokes helpers in a separate job.

- [ ] **Step 1: Write disabled and enabled equivalence tests**

Disabled/default run must have identical stdout, stderr, findings, publication,
result, fake OMP argv/prompt/skill bytes, environment, call count, and exit.

Enabled local run must preserve stdout/findings/publication/result/model calls
and exit. Stderr may add exactly one bounded line after review output:
`  partition shadow: <status>`. Fake OMP records all environment keys and proves
no shadow-specific key is present.

- [ ] **Step 2: Write post-review timing and failure tests**

Instrument fake OMP termination and shadow-helper start. Assert capture starts
only after every OMP worker stopped and current publication/result files exist.
Inject capture timeout/capacity/process failure, malformed raw, atom mismatch,
unsafe output, and compaction; normal review behavior remains unchanged.

Assert explicit local output is complete `{schema_version,status,mode,capture,manifest}`
and may contain bounded source bytes. Assert no output is created if the normal
runner exits before the post-review shadow hook.

- [ ] **Step 3: Run tests to verify RED**

```bash
node --test --test-name-pattern='partition shadow' scripts/run-review.test.mjs
```

Expected: FAIL because flags and post-review hook are absent.

- [ ] **Step 4: Add runner flags and one actual attempt value**

```bash
PARTITION_SHADOW=0
PARTITION_SHADOW_OUT=""
PASS_MAX_ATTEMPTS=2
```

Parse `--partition-shadow` to set 1 and require
`--partition-shadow-out FILE` when enabled. Replace the literal two-attempt loop
with `PASS_MAX_ATTEMPTS` without changing behavior. Do not export shadow
variables.

- [ ] **Step 5: Build exact profile/config files from current runner state**

After `CONFIG_FILE` and pass arrays exist, write:

```json
{
  "schema_version": 1,
  "descriptors": ["general"],
  "descriptor_content_hashes": [
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  ],
  "max_output_attempts": 2
}
```

Hash canonical `{lens,lens_content,skill_content}` from actual ordered
`config.pass_descriptors`; preserve one-to-one order and never use
`DEFAULT_PASS_DESCRIPTORS`.

Write the exact Task 2 limits schema and exact Task 4 config schema with empty or
fixture-supplied benchmark revision under `RUN_TMP`.

- [ ] **Step 6: Run shadow helpers only after authoritative output**

After the existing renderer/JSON output completes and all OMP children have
stopped, invoke with Bash argv arrays:

```bash
node "$CAPTURE_HELPER" capture \
  --repo "$WORKTREE" --base "$BASE_SHA" --head "$HEAD_SHA" \
  --limits "$RUN_TMP/shadow-limits.json" \
  --out "$RUN_TMP/shadow-capture.json"

node "$UNITS_HELPER" shadow \
  --capture "$RUN_TMP/shadow-capture.json" \
  --profile "$RUN_TMP/shadow-profile.json" \
  --config "$RUN_TMP/shadow-config.json" \
  --local-out "$RUN_TMP/shadow-local.staged.json"
```

Resolve helpers through trusted `support_exec`. Catch every helper status and
preserve the already determined review exit. Validate the final destination
before model work but do not create it. After helpers complete, atomically copy
the staged local file to the validated destination. Existing cleanup removes
private capture/staged files.

- [ ] **Step 7: Verify and commit Task 5**

```bash
node --test --test-name-pattern='partition shadow|pass retries|publication' scripts/run-review.test.mjs
git add scripts/run-review.sh scripts/run-review.test.mjs
git commit -m "feat: add local partition shadow planning"
```
<!-- /mship:task -->

<!-- mship:task id=6 -->
### Task 6: Run hosted shadow diagnostics in an independent non-gating job

**Files:**
- Modify: `.github/workflows/agentic-review.yml`
- Modify: `scripts/install-review.sh`
- Modify: `scripts/run-review.test.mjs`
- Modify: `README.md`
- Modify: `.github/workflows/test.yml`

**Interfaces:**
- Consumes reusable input `partition_shadow` and installer
  `--partition-shadow`.
- Produces optional artifact `agentic-review-partition-shadow` containing only
  redacted/compacted `review-partition-shadow.json`.
- Adds no reusable workflow result, no model call, and no gate.

- [ ] **Step 1: Write failing independent-job source tests**

Assert workflow contains:

```yaml
partition-shadow:
  needs: review
  if: ${{ always() && inputs.partition_shadow }}
  continue-on-error: true
  timeout-minutes: 5
  permissions:
    contents: read
```

Assert the job contains no `OPENROUTER_API_KEY`, no pull-request/issues write
permission, no invocation of `run-review.sh`, and no model command. Assert it
uses trusted `review-capture.mjs`/`review-units.mjs`, fixed diagnostics output,
and uploads artifact `agentic-review-partition-shadow`.

Assert reusable outputs still reference only `jobs.review.outputs.*` and the
required `agentic-review` artifact does not include shadow data.

- [ ] **Step 2: Write target-resolution and isolation behavior tests**

Execute the new job's shell bodies with controlled same-repository and central
App-dispatch fixtures. Assert:

- canonical base/head/repository are re-resolved independently;
- checkout uses contents-read token, detached immutable head, and
  `persist-credentials:false`;
- central trusted support supplies helpers;
- target agent configuration is stripped before any tool reads;
- capture/planner timeout/failure cannot alter mocked review-job result;
- uploaded JSON is redacted and bounded.

- [ ] **Step 3: Run tests to verify RED**

```bash
node --test --test-name-pattern='partition shadow|optional diagnostics' scripts/run-review.test.mjs
```

Expected: FAIL because input/job/installer option are absent.

- [ ] **Step 4: Add opt-in input and independent job**

Add:

```yaml
partition_shadow:
  description: Compute diagnostic-only partition manifests after review.
  type: boolean
  default: false
```

The job runs after `review`, has `continue-on-error:true`, its own five-minute
timeout, and contents-read only. It repeats trusted target resolution/read-only
checkout without sharing credentials between jobs, runs capture/unit CLIs
directly, and uploads only the redacted diagnostics file. It does not influence
the review job or reusable outputs.

In `install-review.sh`, add validated `--partition-shadow`, set
`I_PARTITION_SHADOW=true`, and emit `partition_shadow: true` only when requested.

- [ ] **Step 5: Document exact Stage 1 semantics**

README must state local shadow runs after review completion; hosted shadow is a
separate best-effort job; both add no model call/gate; capture limits are exact;
failure cannot change review state; hosted output is redacted, optional, and
retained separately for seven days; shadow is not convergence, durable state,
delta reuse, or partitioned execution.

- [ ] **Step 6: Run full verification**

```bash
node --test scripts/lib-canonical-json.test.mjs scripts/review-capture.test.mjs scripts/review-units.test.mjs
node --test --test-name-pattern='partition shadow|optional diagnostics' scripts/run-review.test.mjs
node --test --test-reporter=dot scripts/*.test.mjs
python3 -c 'import sys,yaml; yaml.safe_load(open(sys.argv[1]))' .github/workflows/agentic-review.yml
bash -n scripts/run-review.sh scripts/install-review.sh
git diff --check
```

Expected: every command exits 0 and the complete suite has no failures.

- [ ] **Step 7: Commit Task 6**

```bash
git add .github/workflows/agentic-review.yml scripts/install-review.sh scripts/run-review.test.mjs README.md .github/workflows/test.yml
git commit -m "feat: add hosted partition shadow diagnostics"
```
<!-- /mship:task -->
## Plan self-check targets

Before execution begins, confirm:

- Tasks 1–4 are pure/importable and independently testable.
- Task 5 is the only task that invokes shadow planning from the runner.
- Task 6 is the only hosted/installer/docs mutation.
- No task adds model calls, new prompt bytes, state persistence, unit gating, `pr_ready`, dispositions, integration, suppression, or delta reuse.
- Later program stages remain blocked behind their named child specs.
