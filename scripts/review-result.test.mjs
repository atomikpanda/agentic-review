import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_PASS_DESCRIPTORS,
  REVIEW_RESULT_SCHEMA_VERSION,
  configurationFingerprint,
  deriveAnalysisState,
  deriveReviewState,
  validateRunMetadata,
} from "./review-result.mjs";

const BASE_SHA = "1".repeat(40);
const HEAD_SHA = "2".repeat(40);
const FINGERPRINT = "3".repeat(64);
const PASS_IDS = ["general", "correctness", "boundaries"];
const DIFF = [
  "diff --git a/a.txt b/a.txt",
  "index 1111111..2222222 100644",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");
const SCOPE_HASH = "0012d7453c71630d2e70e36517ba3482fb1e190611543c94b1955dd9a8083ebb";
const EMPTY_COUNTS = { Critical: 0, High: 0, Medium: 0 };

function passResult(id, overrides = {}) {
  return {
    id,
    status: "valid",
    attempts: 1,
    finding_count: 0,
    capped: false,
    base_sha: BASE_SHA,
    head_sha: HEAD_SHA,
    configuration_fingerprint: FINGERPRINT,
    ...overrides,
  };
}

function completeRun(overrides = {}) {
  const run = {
    base_sha: BASE_SHA,
    head_sha: HEAD_SHA,
    configuration_fingerprint: FINGERPRINT,
    snapshot_immutable: true,
    reviewed_head: HEAD_SHA,
    scope_hash: SCOPE_HASH,
    coverage: "bounded",
    remaining_analysis: [],
    diff: { bytes: 100, included_bytes: 100, truncated: false },
    finding_cap: 20,
    min_votes: 1,
    merge_succeeded: true,
    passes: {
      requested: [...PASS_IDS],
      completed: [...PASS_IDS],
      results: PASS_IDS.map((id) => passResult(id)),
    },
  };
  return { ...run, ...overrides };
}

function finding(severity, title = `${severity} cache lifecycle failure`, body = "Cached lifecycle state remains stale after the update") {
  return {
    file: "src/cache.mjs",
    start_line: 10,
    end_line: 12,
    severity,
    title,
    body,
    suggestion: null,
  };
}

function expectedState(analysisState, mergeState, sampleState, boundedConverged, currentCounts = EMPTY_COUNTS, unresolvedCounts = EMPTY_COUNTS) {
  return {
    analysis_state: analysisState,
    merge_state: mergeState,
    sample_state: sampleState,
    bounded_converged: boundedConverged,
    converged: boundedConverged,
    current_counts: currentCounts,
    unresolved_counts: unresolvedCounts,
  };
}

const reviewStateCases = [
  {
    name: "a complete empty review is clean bounded convergence",
    input: { analysisState: "complete", current: [], unresolved: [], reconciliationKnown: true },
    expected: expectedState("complete", "ready", "clean", true),
  },
  {
    name: "an incomplete review with no known finding stays unknown without blocking merge",
    input: { analysisState: "inconclusive", current: [], unresolved: [], reconciliationKnown: true },
    expected: expectedState("inconclusive", "ready", "unknown", false),
  },
  {
    name: "a complete review with a Medium finding is merge-ready but not clean",
    input: { analysisState: "complete", current: [finding("Medium")], unresolved: [], reconciliationKnown: true },
    expected: expectedState("complete", "ready", "findings", false, { Critical: 0, High: 0, Medium: 1 }),
  },
  {
    name: "a current High finding blocks merge",
    input: { analysisState: "complete", current: [finding("High")], unresolved: [], reconciliationKnown: true },
    expected: expectedState("complete", "blocked", "findings", false, { Critical: 0, High: 1, Medium: 0 }),
  },
  {
    name: "an unresolved prior High finding blocks when the current sample is empty",
    input: { analysisState: "complete", current: [], unresolved: [finding("High")], reconciliationKnown: true },
    expected: expectedState("complete", "blocked", "findings", false, EMPTY_COUNTS, { Critical: 0, High: 1, Medium: 0 }),
  },
  {
    name: "unknown reconciliation prevents a complete empty sample from becoming clean",
    input: { analysisState: "complete", current: [], unresolved: [], reconciliationKnown: false },
    expected: expectedState("complete", "ready", "unknown", false),
  },
];

for (const row of reviewStateCases) {
  test(row.name, () => {
    assert.deepEqual(deriveReviewState({
      ...row.input,
      blockSeverities: ["Critical", "High"],
    }), row.expected);
  });
}

test("current and prior fuzzy duplicates count once and the current severity wins", () => {
  const current = finding(
    "Medium",
    "Configured cache lifecycle remains stale",
    "Updating the record leaves cached lifecycle state stale for later readers",
  );
  const prior = finding(
    "High",
    "Cache lifecycle state is stale after updates",
    "Later readers receive stale cached lifecycle state when the record is updated",
  );

  assert.deepEqual(deriveReviewState({
    analysisState: "complete",
    current: [current, { ...current }],
    unresolved: [prior, { ...prior }],
    reconciliationKnown: true,
    blockSeverities: ["Critical", "High"],
  }), expectedState(
    "complete",
    "ready",
    "findings",
    false,
    { Critical: 0, High: 0, Medium: 1 },
  ));
});

test("bounded convergence is derived exactly from complete plus clean", () => {
  assert.equal(deriveReviewState({
    analysisState: "complete",
    current: [],
    unresolved: [],
    reconciliationKnown: true,
    blockSeverities: ["Critical", "High"],
    boundedConverged: false,
  }).bounded_converged, true);
  assert.equal(deriveReviewState({
    analysisState: "complete",
    current: [],
    unresolved: [],
    reconciliationKnown: true,
    blockSeverities: ["Critical", "High"],
  }).converged, true);

  assert.equal(deriveReviewState({
    analysisState: "inconclusive",
    current: [],
    unresolved: [],
    reconciliationKnown: true,
    blockSeverities: ["Critical", "High"],
    boundedConverged: true,
  }).bounded_converged, false);
  assert.equal(deriveReviewState({
    analysisState: "inconclusive",
    current: [],
    unresolved: [],
    reconciliationKnown: true,
    blockSeverities: ["Critical", "High"],
  }).converged, false);
});

test("analysis is complete only for successful uncapped passes on one target and fingerprint", () => {
  assert.equal(deriveAnalysisState(completeRun()), "complete");
  assert.equal(deriveAnalysisState(completeRun({ snapshot_immutable: false })), "inconclusive");

  const failed = completeRun();
  failed.passes.completed = PASS_IDS.filter((id) => id !== "correctness");
  failed.passes.results[1] = passResult("correctness", { status: "failed", attempts: 2 });
  assert.equal(deriveAnalysisState(failed), "inconclusive");

  assert.equal(deriveAnalysisState(completeRun({
    diff: { bytes: 101, included_bytes: 100, truncated: true },
  })), "inconclusive");

  const capped = completeRun();
  capped.passes.results[2] = passResult("boundaries", { finding_count: 20, capped: true });
  assert.equal(deriveAnalysisState(capped), "inconclusive");

  const wrongTarget = completeRun();
  wrongTarget.passes.results[0] = passResult("general", { head_sha: "4".repeat(40) });
  assert.equal(deriveAnalysisState(wrongTarget), "inconclusive");

  assert.equal(deriveAnalysisState(completeRun({ merge_succeeded: false })), "inconclusive");
});

test("vote thresholds stay inconclusive without classifying a successful merge as failed", () => {
  const successful = {
    schema_version: REVIEW_RESULT_SCHEMA_VERSION,
    ...completeRun({
      min_votes: 2,
      coverage: "unknown",
      remaining_analysis: ["vote_threshold_applied"],
    }),
    analysis_state: "inconclusive",
  };
  assert.equal(validateRunMetadata(successful), successful);

  const failed = {
    ...structuredClone(successful),
    merge_succeeded: false,
    remaining_analysis: ["vote_threshold_applied", "merge_failed"],
  };
  assert.equal(validateRunMetadata(failed), failed);
});

test("configuration fingerprints are canonical and content-sensitive", () => {
  const config = {
    model: "openrouter/example",
    reasoning_effort: "high",
    tools: ["read", "grep"],
    prompt: "Review the change",
    format: "{ findings: [] }",
    lenses: { correctness: "lifecycle rules", boundaries: "trust boundaries" },
    skills: { security: "check authorization", review: "check behavior" },
    diff_cap: 100_000,
    finding_cap: 20,
    pass_descriptors: DEFAULT_PASS_DESCRIPTORS,
    extra_omp_args: ["--temperature", "0"],
  };
  const reordered = {
    extra_omp_args: ["--temperature", "0"],
    pass_descriptors: DEFAULT_PASS_DESCRIPTORS.map(({ lens, id }) => ({ lens, id })),
    finding_cap: 20,
    diff_cap: 100_000,
    skills: { review: "check behavior", security: "check authorization" },
    lenses: { boundaries: "trust boundaries", correctness: "lifecycle rules" },
    format: "{ findings: [] }",
    prompt: "Review the change",
    tools: ["read", "grep"],
    reasoning_effort: "high",
    model: "openrouter/example",
  };

  assert.equal(configurationFingerprint(config), configurationFingerprint(reordered));
  assert.notEqual(configurationFingerprint(config), configurationFingerprint({ ...config, prompt: "Review every changed contract" }));
  assert.match(configurationFingerprint(config), /^[a-f0-9]{64}$/);
});

test("configuration fingerprints reject credentials and unsupported JSON values", () => {
  assert.throws(
    () => configurationFingerprint({ model: "example", api_key: "do-not-hash" }),
    /credential field.*api_key/i,
  );
  assert.throws(
    () => configurationFingerprint({ model: "example", provider: { token: "do-not-hash" } }),
    /credential field.*token/i,
  );

  for (const key of [
    "gh_token",
    "bearer_token",
    "client_password",
    "service_secret",
    "oauth_credentials",
    "app_private_key",
    "provider_api_key",
    "githubtoken",
    "clientsecret",
    "accesstoken",
    "authtoken",
    "secretaccesskey",
  ]) {
    assert.throws(
      () => configurationFingerprint({ model: "example", [key]: "do-not-hash" }),
      new RegExp(`credential field.*${key}`, "i"),
    );
  }
  for (const key of [
    "tokenizer",
    "passwordless_mode",
    "secretary",
    "credentialing",
    "private_key_format",
    "api_key_header",
  ]) {
    assert.match(configurationFingerprint({ model: "example", [key]: "setting" }), /^[a-f0-9]{64}$/);
  }
  assert.throws(() => configurationFingerprint({ model: "example", optional: undefined }), /plain JSON/i);
  assert.throws(() => configurationFingerprint({ model: "example", temperature: Number.NaN }), /plain JSON/i);
  assert.throws(() => configurationFingerprint(new Date()), /plain JSON/i);
});

test("run metadata validation accepts an internally consistent exact result", () => {
  const metadata = {
    schema_version: REVIEW_RESULT_SCHEMA_VERSION,
    ...completeRun(),
    analysis_state: "complete",
  };

  assert.equal(validateRunMetadata(metadata), metadata);
});

test("run metadata validation rejects target, fingerprint, pass, and derived-state inconsistencies", () => {
  const metadata = {
    schema_version: REVIEW_RESULT_SCHEMA_VERSION,
    ...completeRun(),
    analysis_state: "complete",
  };

  const wrongTarget = structuredClone(metadata);
  wrongTarget.passes.results[0].base_sha = "4".repeat(40);
  assert.throws(() => validateRunMetadata(wrongTarget), /base_sha.*general/i);

  const wrongFingerprint = structuredClone(metadata);
  wrongFingerprint.passes.results[1].configuration_fingerprint = "5".repeat(64);
  assert.throws(() => validateRunMetadata(wrongFingerprint), /configuration_fingerprint.*correctness/i);

  const wrongCompleted = structuredClone(metadata);
  wrongCompleted.passes.completed = ["general", "boundaries"];
  assert.throws(() => validateRunMetadata(wrongCompleted), /passes\.completed/i);

  const wrongAnalysis = structuredClone(metadata);
  wrongAnalysis.analysis_state = "inconclusive";
  assert.throws(() => validateRunMetadata(wrongAnalysis), /analysis_state/i);

  const mutableSnapshot = structuredClone(metadata);
  mutableSnapshot.snapshot_immutable = false;
  mutableSnapshot.analysis_state = "complete";
  assert.throws(() => validateRunMetadata(mutableSnapshot), /analysis_state/i);

  const missingSnapshotState = structuredClone(metadata);
  delete missingSnapshotState.snapshot_immutable;
  assert.throws(() => validateRunMetadata(missingSnapshotState), /snapshot_immutable/i);

  const duplicatePass = structuredClone(metadata);
  duplicatePass.passes.requested = ["general", "general", "boundaries"];
  assert.throws(() => validateRunMetadata(duplicatePass), /passes\.requested/i);
});

test("run metadata validation preserves the additive contract and stable reason vocabulary", () => {
  const metadata = {
    schema_version: REVIEW_RESULT_SCHEMA_VERSION,
    ...completeRun(),
    analysis_state: "complete",
  };
  assert.equal(validateRunMetadata(metadata), metadata);

  for (const [mutate, message] of [
    [(value) => { value.reviewed_head = BASE_SHA; }, /reviewed_head/],
    [(value) => { value.scope_hash = "not-a-hash"; }, /scope_hash/],
    [(value) => { value.coverage = "complete"; }, /coverage/],
    [(value) => { value.remaining_analysis = ["not_a_reason"]; }, /remaining_analysis/],
    [(value) => {
      value.coverage = "unknown";
      value.remaining_analysis = ["pass_failed", "diff_truncated"];
      value.analysis_state = "inconclusive";
      value.diff = { bytes: 101, included_bytes: 100, truncated: true };
      value.passes.completed = [];
      value.passes.results = value.passes.results.map((pass) => ({
        ...pass,
        status: "failed",
        attempts: 2,
      }));
    }, /remaining_analysis/],
  ]) {
    const malformed = structuredClone(metadata);
    mutate(malformed);
    assert.throws(() => validateRunMetadata(malformed), message);
  }
});

test("run metadata validation rejects malformed values instead of coercing them", () => {
  const metadata = {
    schema_version: REVIEW_RESULT_SCHEMA_VERSION,
    ...completeRun(),
    analysis_state: "complete",
  };

  for (const [mutate, message] of [
    [(value) => { value.schema_version = "1"; }, /schema_version/],
    [(value) => { value.base_sha = "not-a-sha"; }, /base_sha/],
    [(value) => { value.diff.truncated = "false"; }, /diff\.truncated/],
    [(value) => { value.snapshot_immutable = "true"; }, /snapshot_immutable/],
    [(value) => { value.finding_cap = -1; }, /finding_cap/],
    [(value) => { value.min_votes = 0; }, /min_votes/],
    [(value) => { value.passes.results[0].attempts = "1"; }, /attempts.*general/i],
    [(value) => { value.passes.results[0].attempts = 3; }, /attempts.*general/i],
    [(value) => { value.passes.results[0].finding_count = 20; }, /capped.*general/i],
  ]) {
    const malformed = structuredClone(metadata);
    mutate(malformed);
    assert.throws(() => validateRunMetadata(malformed), message);
  }
});

test("scope hashes are exact, canonical, and sensitive to the full diff and configuration", () => {
  const script = new URL("./review-result.mjs", import.meta.url);
  const scope = {
    base_sha: BASE_SHA,
    head_sha: HEAD_SHA,
    diff: DIFF,
    configuration_fingerprint: FINGERPRINT,
  };
  const hash = (value) => {
    const result = spawnSync(process.execPath, [script.pathname, "scope", "-"], {
      input: JSON.stringify(value),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };

  assert.equal(hash(scope), SCOPE_HASH);
  assert.equal(hash({
    configuration_fingerprint: FINGERPRINT,
    diff: DIFF,
    head_sha: HEAD_SHA,
    base_sha: BASE_SHA,
  }), SCOPE_HASH);
  assert.notEqual(hash({ ...scope, diff: `${DIFF}+another line\n` }), SCOPE_HASH);
  assert.notEqual(hash({ ...scope, configuration_fingerprint: "4".repeat(64) }), SCOPE_HASH);
});

test("the guarded CLI uses the importable fingerprint, analysis, and validation implementations", () => {
  const directory = mkdtempSync(join(tmpdir(), "review-result-"));
  const script = new URL("./review-result.mjs", import.meta.url);
  const config = { model: "example", prompt: "review", tools: ["read"] };
  const metadata = {
    schema_version: REVIEW_RESULT_SCHEMA_VERSION,
    ...completeRun(),
    analysis_state: "complete",
  };

  try {
    const runFile = join(directory, "run.json");
    const metadataFile = join(directory, "metadata.json");
    writeFileSync(runFile, JSON.stringify(completeRun()));
    writeFileSync(metadataFile, JSON.stringify(metadata));

    const fingerprint = spawnSync(process.execPath, [script.pathname, "fingerprint", "-"], {
      input: JSON.stringify(config),
      encoding: "utf8",
    });
    assert.equal(fingerprint.status, 0, fingerprint.stderr);
    assert.equal(fingerprint.stdout.trim(), configurationFingerprint(config));

    assert.equal(
      execFileSync(process.execPath, [script.pathname, "analysis", runFile], { encoding: "utf8" }).trim(),
      deriveAnalysisState(completeRun()),
    );
    assert.deepEqual(
      JSON.parse(execFileSync(process.execPath, [script.pathname, "validate", metadataFile], { encoding: "utf8" })),
      validateRunMetadata(metadata),
    );

    const malformed = spawnSync(process.execPath, [script.pathname, "validate", "-"], {
      input: "{}",
      encoding: "utf8",
    });
    assert.notEqual(malformed.status, 0);
    assert.match(malformed.stderr, /schema_version/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
