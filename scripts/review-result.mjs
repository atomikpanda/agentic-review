import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { sameFinding } from "./lib-findings.mjs";

export const REVIEW_RESULT_SCHEMA_VERSION = 1;
export const DEFAULT_PASS_DESCRIPTORS = [
  { id: "general", lens: null },
  { id: "correctness", lens: "review/lenses/correctness.md" },
  { id: "boundaries", lens: "review/lenses/boundaries.md" },
];

const ANALYSIS_STATES = new Set(["complete", "inconclusive"]);
const PASS_STATUSES = new Set(["valid", "failed"]);
const SEVERITIES = ["Critical", "High", "Medium"];
const SEVERITY_SET = new Set(SEVERITIES);
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const CREDENTIAL_FIELD_NAMES = new Set([
  "authorization",
  "bearer",
  "credential",
  "credentials",
  "password",
  "secret",
  "token",
]);

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
  return CREDENTIAL_FIELD_NAMES.has(last)
    || last === "apikey"
    || pair === "api_key"
    || pair === "private_key"
    || triple === "secret_access_key";
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
  validateDiff(run.diff);
  requireInteger(run.finding_cap, "finding_cap");
  if (run.merge_succeeded !== undefined) requireBoolean(run.merge_succeeded, "merge_succeeded");

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
    && run.merge_succeeded !== false
    && run.diff.truncated === false
    && run.diff.included_bytes === run.diff.bytes
    && arraysEqual(resultIds, requested)
    && arraysEqual(validIds, requested)
    && arraysEqual(run.passes.completed, validIds)
    && allResultsMatchRun
    && !capReached;
  return complete ? "complete" : "inconclusive";
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

function deduplicateFindings(findings, path, excluded = []) {
  if (!Array.isArray(findings)) throw new TypeError(`${path} must be an array`);
  const unique = [];
  for (const [index, finding] of findings.entries()) {
    validateFinding(finding, `${path}[${index}]`);
    if (
      !excluded.some((candidate) => sameFinding(candidate, finding))
      && !unique.some((candidate) => sameFinding(candidate, finding))
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
}) {
  if (!ANALYSIS_STATES.has(analysisState)) {
    throw new TypeError("analysisState must be complete or inconclusive");
  }
  requireBoolean(reconciliationKnown, "reconciliationKnown");
  const blocking = validateStringList(blockSeverities, "blockSeverities");
  for (const severity of blocking) {
    if (!SEVERITY_SET.has(severity)) {
      throw new TypeError("blockSeverities entries must be Critical, High, or Medium");
    }
  }

  const uniqueCurrent = deduplicateFindings(current, "current");
  const uniqueUnresolved = deduplicateFindings(unresolved, "unresolved", uniqueCurrent);
  const knownFindings = [...uniqueCurrent, ...uniqueUnresolved];
  const mergeState = knownFindings.some((finding) => blocking.has(finding.severity))
    ? "blocked"
    : "ready";
  const sampleState = knownFindings.length > 0
    ? "findings"
    : analysisState === "complete" && reconciliationKnown
      ? "clean"
      : "unknown";

  return {
    analysis_state: analysisState,
    merge_state: mergeState,
    sample_state: sampleState,
    bounded_converged: analysisState === "complete" && sampleState === "clean",
    current_counts: severityCounts(uniqueCurrent),
    unresolved_counts: severityCounts(uniqueUnresolved),
  };
}

export function validateRunMetadata(value) {
  canonicalize(value, "metadata");
  requirePlainObject(value, "metadata");
  if (value.schema_version !== REVIEW_RESULT_SCHEMA_VERSION) {
    throw new TypeError(`schema_version must be ${REVIEW_RESULT_SCHEMA_VERSION}`);
  }
  if (!ANALYSIS_STATES.has(value.analysis_state)) {
    throw new TypeError("analysis_state must be complete or inconclusive");
  }

  inspectRun(value);
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
  return value;
}

function readJson(source) {
  const text = source === undefined || source === "-"
    ? readFileSync(0, "utf8")
    : readFileSync(source, "utf8");
  return JSON.parse(text);
}

function runCli(argv) {
  const [command, source, ...extra] = argv;
  if (extra.length > 0 || !["fingerprint", "analysis", "validate"].includes(command)) {
    throw new TypeError("usage: review-result.mjs <fingerprint|analysis|validate> [JSON_FILE|-]");
  }
  const value = readJson(source);
  if (command === "fingerprint") return configurationFingerprint(value);
  if (command === "analysis") return deriveAnalysisState(value);
  return JSON.stringify(validateRunMetadata(value));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${runCli(process.argv.slice(2))}\n`);
  } catch (error) {
    process.stderr.write(`review-result: ${error.message}\n`);
    process.exitCode = 1;
  }
}
