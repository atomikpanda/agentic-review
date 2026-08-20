import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { isValidFinding, sameFinding } from "./lib-findings.mjs";

export const REVIEW_RESULT_SCHEMA_VERSION = 1;
export const REVIEW_PUBLICATION_SCHEMA_VERSION = 2;
export const DEFAULT_PASS_DESCRIPTORS = [
  { id: "general", lens: null },
  { id: "correctness", lens: "review/lenses/correctness.md" },
  { id: "boundaries", lens: "review/lenses/boundaries.md" },
];

const ANALYSIS_STATES = new Set(["complete", "inconclusive"]);
const PASS_STATUSES = new Set(["valid", "failed"]);
const COVERAGE_STATES = new Set(["bounded", "unknown"]);
export const REMAINING_ANALYSIS_REASONS = [
  "diff_truncated",
  "finding_cap_reached",
  "pass_failed",
  "snapshot_mutable",
  "pass_scope_mismatch",
  "vote_threshold_applied",
  "merge_failed",
  "reconciliation_unknown",
  "execution_failed",
];
const REMAINING_ANALYSIS_REASON_SET = new Set(REMAINING_ANALYSIS_REASONS);
const SEVERITIES = ["Critical", "High", "Medium"];
const SEVERITY_SET = new Set(SEVERITIES);
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const CREDENTIAL_FIELD_NAMES = new Set([
  "authorization",
  "bearer",
  "credential",
  "credentials",
  "password",
  "secret",
  "token",
]);
const COMPACT_CREDENTIAL_SUFFIXES = [
  "githubtoken",
  "clientsecret",
  "accesstoken",
  "authtoken",
  "secretaccesskey",
];

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function isCredentialField(key) {
  const segments = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const last = segments.at(-1);
  const pair = segments.slice(-2).join("_");
  const triple = segments.slice(-3).join("_");
  const compact = segments.join("");
  return CREDENTIAL_FIELD_NAMES.has(last)
    || last === "apikey"
    || pair === "api_key"
    || pair === "private_key"
    || triple === "secret_access_key"
    || COMPACT_CREDENTIAL_SUFFIXES.some((suffix) => compact.endsWith(suffix));
}

function canonicalize(value, path = "configuration") {
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
      items.push(canonicalize(value[index], `${path}[${index}]`));
    }
    return `[${items.join(",")}]`;
  }
  if (!isPlainObject(value)) {
    throw new TypeError(`${path} must contain only plain JSON data`);
  }

  const entries = [];
  for (const key of Object.keys(value).sort()) {
    if (isCredentialField(key)) {
      throw new TypeError(`credential field ${path}.${key} is not allowed in a configuration fingerprint`);
    }
    entries.push(`${JSON.stringify(key)}:${canonicalize(value[key], `${path}.${key}`)}`);
  }
  return `{${entries.join(",")}}`;
}

export function configurationFingerprint(config) {
  if (!isPlainObject(config)) {
    throw new TypeError("configuration must contain only plain JSON data");
  }
  return createHash("sha256").update(canonicalize(config)).digest("hex");
}

function inspectCanonicalScope(scope) {
  requirePlainObject(scope, "scope");
  const expectedKeys = ["base_sha", "configuration_fingerprint", "diff_base64", "head_sha"];
  if (!arraysEqual(Object.keys(scope).sort(), expectedKeys)) {
    throw new TypeError(`scope must contain exactly ${expectedKeys.join(", ")}`);
  }
  requireSha(scope.base_sha, "scope.base_sha");
  requireFingerprint(scope.configuration_fingerprint, "scope.configuration_fingerprint");
  const diffBytes = decodeCanonicalBase64(scope.diff_base64, "scope.diff_base64");
  requireSha(scope.head_sha, "scope.head_sha");
  const hash = createHash("sha256").update(canonicalize({
    base_sha: scope.base_sha,
    configuration_fingerprint: scope.configuration_fingerprint,
    diff_base64: scope.diff_base64,
    head_sha: scope.head_sha,
  }, "scope")).digest("hex");
  return { diffBytes, hash };
}

export function scopeHash(scope) {
  return inspectCanonicalScope(scope).hash;
}

export function deriveTrustedScopeMetadata(trustedScope) {
  requirePlainObject(trustedScope, "trusted scope");
  const expectedKeys = [
    "base_sha",
    "bytes",
    "configuration_fingerprint",
    "diff_base64",
    "head_sha",
    "included_bytes",
  ];
  if (!arraysEqual(Object.keys(trustedScope).sort(), expectedKeys)) {
    throw new TypeError(`trusted scope must contain exactly ${expectedKeys.join(", ")}`);
  }

  const canonicalScope = {
    base_sha: trustedScope.base_sha,
    configuration_fingerprint: trustedScope.configuration_fingerprint,
    diff_base64: trustedScope.diff_base64,
    head_sha: trustedScope.head_sha,
  };
  const inspectedScope = inspectCanonicalScope(canonicalScope);
  requireInteger(trustedScope.bytes, "trusted scope bytes");
  requireInteger(trustedScope.included_bytes, "trusted scope included_bytes");
  if (trustedScope.bytes !== inspectedScope.diffBytes.length) {
    throw new TypeError("trusted scope bytes must match decoded diff_base64 length");
  }
  if (trustedScope.included_bytes > trustedScope.bytes) {
    throw new TypeError("trusted scope included_bytes must not exceed trusted scope bytes");
  }

  return {
    base_sha: trustedScope.base_sha,
    configuration_fingerprint: trustedScope.configuration_fingerprint,
    head_sha: trustedScope.head_sha,
    scope_hash: inspectedScope.hash,
    diff: {
      bytes: trustedScope.bytes,
      included_bytes: trustedScope.included_bytes,
      truncated: trustedScope.included_bytes < trustedScope.bytes,
    },
  };
}

function requirePlainObject(value, path) {
  if (!isPlainObject(value)) throw new TypeError(`${path} must be an object`);
}

function requireBoolean(value, path) {
  if (typeof value !== "boolean") throw new TypeError(`${path} must be a boolean`);
}

function requireInteger(value, path, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new TypeError(`${path} must be an integer greater than or equal to ${minimum}`);
  }
}

function requireString(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
}

function requireSha(value, path) {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    throw new TypeError(`${path} must be a 40-character lowercase hexadecimal SHA`);
  }
}

function requireFingerprint(value, path) {
  if (typeof value !== "string" || !FINGERPRINT_PATTERN.test(value)) {
    throw new TypeError(`${path} must be a 64-character lowercase hexadecimal SHA-256`);
  }
}

function decodeCanonicalBase64(value, path) {
  if (typeof value !== "string" || !BASE64_PATTERN.test(value)) {
    throw new TypeError(`${path} must be canonical RFC 4648 base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new TypeError(`${path} must be canonical RFC 4648 base64`);
  }
  return decoded;
}

function validateStringList(value, path) {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  const seen = new Set();
  for (const entry of value) {
    requireString(entry, `${path} entry`);
    if (seen.has(entry)) throw new TypeError(`${path} must not contain duplicate identifiers`);
    seen.add(entry);
  }
  return seen;
}

function validateDiff(diff) {
  requirePlainObject(diff, "diff");
  requireInteger(diff.bytes, "diff.bytes");
  requireInteger(diff.included_bytes, "diff.included_bytes");
  requireBoolean(diff.truncated, "diff.truncated");
  if (diff.included_bytes > diff.bytes) {
    throw new TypeError("diff.included_bytes must not exceed diff.bytes");
  }
}

function validatePassResult(result, index) {
  const prefix = `passes.results[${index}]`;
  requirePlainObject(result, prefix);
  requireString(result.id, `${prefix}.id`);
  if (!PASS_STATUSES.has(result.status)) {
    throw new TypeError(`${prefix}.status for ${result.id} must be valid or failed`);
  }
  if (!Number.isInteger(result.attempts) || result.attempts < 1 || result.attempts > 2) {
    throw new TypeError(`${prefix}.attempts for ${result.id} must be an integer from 1 through 2`);
  }
  requireInteger(result.finding_count, `${prefix}.finding_count for ${result.id}`);
  requireBoolean(result.capped, `${prefix}.capped for ${result.id}`);
  requireSha(result.base_sha, `${prefix}.base_sha for ${result.id}`);
  requireSha(result.head_sha, `${prefix}.head_sha for ${result.id}`);
  requireFingerprint(
    result.configuration_fingerprint,
    `${prefix}.configuration_fingerprint for ${result.id}`,
  );
}

function inspectRun(run) {
  requirePlainObject(run, "run");
  requireSha(run.base_sha, "base_sha");
  requireSha(run.head_sha, "head_sha");
  requireFingerprint(run.configuration_fingerprint, "configuration_fingerprint");
  requireBoolean(run.snapshot_immutable, "snapshot_immutable");
  validateDiff(run.diff);
  requireInteger(run.finding_cap, "finding_cap");
  if (run.min_votes !== undefined) requireInteger(run.min_votes, "min_votes", 1);
  if (run.merge_succeeded !== undefined) requireBoolean(run.merge_succeeded, "merge_succeeded");
  if (run.reconciliation_known !== undefined) {
    requireBoolean(run.reconciliation_known, "reconciliation_known");
  }
  if (run.execution_failed !== undefined) {
    requireBoolean(run.execution_failed, "execution_failed");
  }

  requirePlainObject(run.passes, "passes");
  const requested = validateStringList(run.passes.requested, "passes.requested");
  validateStringList(run.passes.completed, "passes.completed");
  if (!Array.isArray(run.passes.results)) throw new TypeError("passes.results must be an array");

  const resultIds = new Set();
  for (const [index, result] of run.passes.results.entries()) {
    validatePassResult(result, index);
    if (resultIds.has(result.id)) {
      throw new TypeError(`passes.results must not contain duplicate id ${result.id}`);
    }
    resultIds.add(result.id);
  }

  return { requested, resultIds };
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

export function deriveRemainingAnalysis(run, {
  reconciliationKnown = run?.reconciliation_known,
  executionFailed = run?.execution_failed,
} = {}) {
  inspectRun(run);
  if (reconciliationKnown !== undefined) {
    requireBoolean(reconciliationKnown, "reconciliationKnown");
  }
  if (executionFailed !== undefined) {
    requireBoolean(executionFailed, "executionFailed");
  }

  const results = run.passes.results;
  const validIds = results.filter(({ status }) => status === "valid").map(({ id }) => id);
  const passFailed = run.passes.requested.length === 0
    || results.some(({ status }) => status === "failed")
    || !arraysEqual(results.map(({ id }) => id), run.passes.requested)
    || !arraysEqual(run.passes.completed, validIds);
  const capReached = results.some((result) => (
    result.capped
    || (result.status === "valid" && run.finding_cap > 0 && result.finding_count >= run.finding_cap)
  ));
  const passScopeMismatch = results.some((result) => (
    result.base_sha !== run.base_sha
    || result.head_sha !== run.head_sha
    || result.configuration_fingerprint !== run.configuration_fingerprint
  ));
  const noSuccessfulPass = run.passes.requested.length === 0 || validIds.length === 0;
  const facts = new Set();
  if (run.diff.truncated || run.diff.included_bytes !== run.diff.bytes) facts.add("diff_truncated");
  if (capReached) facts.add("finding_cap_reached");
  if (passFailed) facts.add("pass_failed");
  if (!run.snapshot_immutable) facts.add("snapshot_mutable");
  if (passScopeMismatch) facts.add("pass_scope_mismatch");
  if (run.min_votes > 1) facts.add("vote_threshold_applied");
  if (run.merge_succeeded === false) facts.add("merge_failed");
  if (reconciliationKnown === false) facts.add("reconciliation_unknown");
  if (executionFailed === true || noSuccessfulPass) facts.add("execution_failed");
  return REMAINING_ANALYSIS_REASONS.filter((reason) => facts.has(reason));
}

export function deriveAnalysisState(run) {
  inspectRun(run);

  const requested = run.passes.requested;
  const results = run.passes.results;
  const validIds = results.filter((result) => result.status === "valid").map((result) => result.id);
  const resultIds = results.map((result) => result.id);
  const allResultsMatchRun = results.every((result) => (
    result.base_sha === run.base_sha
    && result.head_sha === run.head_sha
    && result.configuration_fingerprint === run.configuration_fingerprint
  ));
  const capReached = results.some((result) => (
    result.capped
    || (result.status === "valid" && run.finding_cap > 0 && result.finding_count >= run.finding_cap)
  ));

  const complete = requested.length > 0
    && run.snapshot_immutable === true
    && (run.min_votes === undefined || run.min_votes === 1)
    && run.merge_succeeded !== false
    && run.execution_failed !== true
    && run.diff.truncated === false
    && run.diff.included_bytes === run.diff.bytes
    && arraysEqual(resultIds, requested)
    && arraysEqual(validIds, requested)
    && arraysEqual(run.passes.completed, validIds)
    && allResultsMatchRun
    && !capReached;
  return complete ? "complete" : "inconclusive";
}

export function enrichRunMetadata(run, {
  scopeHash: computedScopeHash = run?.scope_hash,
  reconciliationKnown = run?.reconciliation_known,
  executionFailed = run?.execution_failed,
} = {}) {
  const analysisState = deriveAnalysisState(run);
  requireFingerprint(computedScopeHash, "scope_hash");
  const remainingAnalysis = deriveRemainingAnalysis(run, {
    reconciliationKnown,
    executionFailed,
  });
  const metadata = {
    ...run,
    analysis_state: analysisState,
    reviewed_head: run.head_sha,
    scope_hash: computedScopeHash,
    coverage: analysisState === "complete" && reconciliationKnown !== false && executionFailed !== true
      ? "bounded"
      : "unknown",
    remaining_analysis: remainingAnalysis,
  };
  if (reconciliationKnown !== undefined) metadata.reconciliation_known = reconciliationKnown;
  if (executionFailed !== undefined) metadata.execution_failed = executionFailed;
  return metadata;
}

function validateFinding(value, path) {
  requirePlainObject(value, path);
  requireString(value.file, `${path}.file`);
  requireString(value.title, `${path}.title`);
  requireString(value.body, `${path}.body`);
  if (!SEVERITY_SET.has(value.severity)) {
    throw new TypeError(`${path}.severity must be Critical, High, or Medium`);
  }
}

function sameStateFinding(left, right) {
  if (
    Object.hasOwn(left, "identity_tokens")
    && Object.hasOwn(right, "identity_tokens")
    && Array.isArray(left.identity_tokens)
    && Array.isArray(right.identity_tokens)
  ) {
    const leftTokens = [...new Set(left.identity_tokens)].sort();
    const rightTokens = [...new Set(right.identity_tokens)].sort();
    return left.file === right.file && arraysEqual(leftTokens, rightTokens);
  }
  return sameFinding(left, right);
}

function deduplicateFindings(findings, path, excluded = []) {
  if (!Array.isArray(findings)) throw new TypeError(`${path} must be an array`);
  const unique = [];
  for (const [index, finding] of findings.entries()) {
    validateFinding(finding, `${path}[${index}]`);
    if (
      !excluded.some((candidate) => sameStateFinding(candidate, finding))
      && !unique.some((candidate) => sameStateFinding(candidate, finding))
    ) {
      unique.push(finding);
    }
  }
  return unique;
}

function severityCounts(findings) {
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

export function deriveReviewState({
  analysisState,
  current,
  unresolved,
  reconciliationKnown,
  blockSeverities,
  evidenceReconciled = false,
}) {
  if (!ANALYSIS_STATES.has(analysisState)) {
    throw new TypeError("analysisState must be complete or inconclusive");
  }
  requireBoolean(reconciliationKnown, "reconciliationKnown");
  requireBoolean(evidenceReconciled, "evidenceReconciled");
  const blocking = validateStringList(blockSeverities, "blockSeverities");
  for (const severity of blocking) {
    if (!SEVERITY_SET.has(severity)) {
      throw new TypeError("blockSeverities entries must be Critical, High, or Medium");
    }
  }

  const uniqueCurrent = deduplicateFindings(current, "current");
  const uniqueUnresolved = deduplicateFindings(
    unresolved,
    "unresolved",
    evidenceReconciled ? [] : uniqueCurrent,
  );
  const knownFindings = [...uniqueCurrent, ...uniqueUnresolved];
  const mergeState = knownFindings.some((finding) => blocking.has(finding.severity))
    ? "blocked"
    : "ready";
  const sampleState = knownFindings.length > 0
    ? "findings"
    : analysisState === "complete" && reconciliationKnown
      ? "clean"
      : "unknown";

  const boundedConverged = analysisState === "complete" && sampleState === "clean";
  return {
    analysis_state: analysisState,
    merge_state: mergeState,
    sample_state: sampleState,
    bounded_converged: boundedConverged,
    converged: boundedConverged,
    current_counts: severityCounts(uniqueCurrent),
    unresolved_counts: severityCounts(uniqueUnresolved),
  };
}

export function derivePublicationFailureResult(publication, {
  expectedHeadSha,
  blockSeverities = ["Critical", "High"],
} = {}) {
  const { findings, metadata } = validateReviewPublication(publication);
  requireSha(expectedHeadSha, "expected head_sha");
  if (metadata.head_sha !== expectedHeadSha) {
    throw new TypeError("publication head_sha must match expected head_sha");
  }
  const state = deriveReviewState({
    analysisState: "inconclusive",
    current: findings,
    unresolved: [],
    reconciliationKnown: false,
    blockSeverities,
  });
  return {
    ...state,
    base_sha: metadata.base_sha,
    head_sha: metadata.head_sha,
    configuration_fingerprint: metadata.configuration_fingerprint,
    passes_requested: metadata.passes.requested.length,
    passes_completed: metadata.passes.completed.length,
    reviewed_head: metadata.head_sha,
    scope_hash: metadata.scope_hash,
    coverage: "unknown",
    remaining_analysis: REMAINING_ANALYSIS_REASONS.filter(
      (reason) => ["reconciliation_unknown", "execution_failed"].includes(reason)
        || metadata.remaining_analysis.includes(reason),
    ),
  };
}

export function validateRunMetadata(value, trustedScope) {
  canonicalize(value, "metadata");
  requirePlainObject(value, "metadata");
  if (value.schema_version !== REVIEW_RESULT_SCHEMA_VERSION) {
    throw new TypeError(`schema_version must be ${REVIEW_RESULT_SCHEMA_VERSION}`);
  }
  if (!ANALYSIS_STATES.has(value.analysis_state)) {
    throw new TypeError("analysis_state must be complete or inconclusive");
  }

  requireSha(value.reviewed_head, "reviewed_head");
  if (value.reviewed_head !== value.head_sha) {
    throw new TypeError("reviewed_head must match head_sha");
  }
  requireFingerprint(value.scope_hash, "scope_hash");
  if (!COVERAGE_STATES.has(value.coverage)) {
    throw new TypeError("coverage must be bounded or unknown");
  }
  const remainingReasons = validateStringList(value.remaining_analysis, "remaining_analysis");
  for (const reason of remainingReasons) {
    if (!REMAINING_ANALYSIS_REASON_SET.has(reason)) {
      throw new TypeError(`remaining_analysis contains unsupported reason ${reason}`);
    }
  }
  inspectRun(value);
  if (trustedScope === undefined) {
    throw new TypeError("trusted scope is required to validate run metadata");
  }
  const trustedMetadata = deriveTrustedScopeMetadata(trustedScope);
  for (const field of ["truncated", "bytes", "included_bytes"]) {
    if (trustedMetadata.diff[field] !== value.diff[field]) {
      throw new TypeError(`diff.${field} must match the trusted reviewed bytes`);
    }
  }
  for (const field of ["base_sha", "configuration_fingerprint", "head_sha"]) {
    if (trustedMetadata[field] !== value[field]) {
      throw new TypeError(`trusted scope ${field} must match metadata ${field}`);
    }
  }
  if (value.scope_hash !== trustedMetadata.scope_hash) {
    throw new TypeError("scope_hash must match the trusted canonical scope");
  }
  if (value.diff.truncated === false && value.diff.included_bytes !== value.diff.bytes) {
    throw new TypeError("diff.truncated must be true when included_bytes differs from bytes");
  }

  const requested = value.passes.requested;
  const results = value.passes.results;
  if (!arraysEqual(results.map((result) => result.id), requested)) {
    throw new TypeError("passes.results ids and order must match passes.requested");
  }
  const completed = results.filter((result) => result.status === "valid").map((result) => result.id);
  if (!arraysEqual(value.passes.completed, completed)) {
    throw new TypeError("passes.completed must exactly match valid pass results in requested order");
  }

  for (const result of results) {
    if (result.base_sha !== value.base_sha) {
      throw new TypeError(`base_sha for pass ${result.id} must match run base_sha`);
    }
    if (result.head_sha !== value.head_sha) {
      throw new TypeError(`head_sha for pass ${result.id} must match run head_sha`);
    }
    if (result.configuration_fingerprint !== value.configuration_fingerprint) {
      throw new TypeError(
        `configuration_fingerprint for pass ${result.id} must match run configuration_fingerprint`,
      );
    }
    const expectedCapped = result.status === "valid"
      && value.finding_cap > 0
      && result.finding_count >= value.finding_cap;
    if (result.capped !== expectedCapped) {
      throw new TypeError(`capped for pass ${result.id} is inconsistent with finding_cap and finding_count`);
    }
  }

  const expectedAnalysisState = deriveAnalysisState(value);
  if (value.analysis_state !== expectedAnalysisState) {
    throw new TypeError(`analysis_state must be ${expectedAnalysisState} for this run metadata`);
  }

  const expectedCoverage = expectedAnalysisState === "complete"
    && value.reconciliation_known !== false
    && value.execution_failed !== true
    ? "bounded"
    : "unknown";
  if (value.coverage !== expectedCoverage) {
    throw new TypeError(`coverage must be ${expectedCoverage} for this run metadata`);
  }
  const expectedRemainingAnalysis = deriveRemainingAnalysis(value);
  if (!arraysEqual(value.remaining_analysis, expectedRemainingAnalysis)) {
    throw new TypeError(
      `remaining_analysis must be ${JSON.stringify(expectedRemainingAnalysis)} for this run metadata`,
    );
  }
  return value;
}

export function validateReviewPublication(value) {
  canonicalize(value, "publication");
  requirePlainObject(value, "publication");
  const expectedKeys = ["findings", "metadata", "schema_version", "scope"];
  if (!arraysEqual(Object.keys(value).sort(), expectedKeys)) {
    throw new TypeError(`publication must contain exactly ${expectedKeys.join(", ")}`);
  }
  if (value.schema_version !== REVIEW_PUBLICATION_SCHEMA_VERSION) {
    throw new TypeError(`publication schema_version must be ${REVIEW_PUBLICATION_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(value.findings) || !value.findings.every(isValidFinding)) {
    throw new TypeError("publication findings must be an array of valid findings");
  }
  validateRunMetadata(value.metadata, value.scope);
  return value;
}

export function createReviewPublication(metadata, scope, findings) {
  const publication = {
    schema_version: REVIEW_PUBLICATION_SCHEMA_VERSION,
    findings,
    metadata,
    scope,
  };
  return validateReviewPublication(publication);
}

function readJson(source) {
  const text = source === undefined || source === "-"
    ? readFileSync(0, "utf8")
    : readFileSync(source, "utf8");
  return JSON.parse(text);
}

function runCli(argv) {
  const [command, source, ...extra] = argv;
  const commands = ["fingerprint", "scope", "analysis", "validate", "failure"];
  if (extra.length > 0 || !commands.includes(command)) {
    throw new TypeError(
      "usage: review-result.mjs <fingerprint|scope|analysis|validate|failure> [JSON_FILE|-]",
    );
  }
  const value = readJson(source);
  if (command === "fingerprint") return configurationFingerprint(value);
  if (command === "scope") {
    return Object.hasOwn(value, "included_bytes")
      ? deriveTrustedScopeMetadata(value).scope_hash
      : scopeHash(value);
  }
  if (command === "analysis") return deriveAnalysisState(value);
  if (command === "failure") {
    return JSON.stringify(derivePublicationFailureResult(value, {
      expectedHeadSha: process.env.HEAD_SHA,
      blockSeverities: (process.env.BLOCK_SEVERITIES ?? "Critical,High")
        .split(",")
        .map((severity) => severity.trim())
        .filter(Boolean),
    }));
  }
  return JSON.stringify(validateReviewPublication(value).metadata);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${runCli(process.argv.slice(2))}\n`);
  } catch (error) {
    process.stderr.write(`review-result: ${error.message}\n`);
    process.exitCode = 1;
  }
}
