import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, lstatSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalSha256, isPlainJsonObject } from "./lib-canonical-json.mjs";
import { parseRawDiffZ } from "./review-units.mjs";

const gitEnvironment = Object.freeze({
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_EXTERNAL_DIFF: "",
  GIT_DIFF_OPTS: "",
});
const gitConfigOverrides = Object.freeze([
  "diff.external=",
  "diff.algorithm=myers",
  "diff.renames=copies",
  "diff.mnemonicPrefix=false",
  "diff.noprefix=false",
  "diff.srcPrefix=a/",
  "diff.dstPrefix=b/",
  "core.quotePath=false",
]);
const gitPrefix = Object.freeze([
  "git",
  ...gitConfigOverrides.flatMap((value) => ["-c", value]),
  "diff",
]);
const commonDiffFlags = Object.freeze([
  "--find-renames=50%", "--find-copies=50%", "--find-copies-harder",
  "--no-ext-diff", "--no-textconv", "--no-color",
]);
const COMPLETE_FIELDS = Object.freeze([
  "schema_version", "status", "repository_object_format", "base_sha", "head_sha",
  "capture_configuration", "git_environment", "git_config_overrides", "patch_argv", "raw_argv",
  "patch_base64", "raw_z_base64", "object_table", "capture_hash",
]);
const DIAGNOSTIC_FIELDS = Object.freeze([
  "schema_version", "status", "base_sha", "head_sha", "capture_configuration", "patch_argv",
  "raw_argv", "git_environment", "git_config_overrides", "capacity_reason", "observed_lower_bounds",
]);
const CAPACITY_REASONS = new Set(["patch_bytes", "raw_z_bytes", "blob_bytes", "deadline"]);
const HEX = /^[0-9a-f]+$/;

/** @typedef {{
 * maxPatchBytes:number, maxRawZBytes:number,
 * maxSingleBlobBytes:number, maxTotalBlobBytes:number,
 * maxCaptureMilliseconds:number
 * }} CaptureLimits */

/** @typedef {{
 * repoRoot:string, baseSha:string, headSha:string,
 * limits:CaptureLimits, outputPath?:string
 * }} CaptureOptions */

function exactKeys(value, keys, label) {
  if (!isPlainJsonObject(value)) throw new TypeError(`${label} must be a plain object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has unexpected or missing fields`);
  }
}

function assertPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer`);
}

function validateLimits(limits) {
  exactKeys(limits, ["maxPatchBytes", "maxRawZBytes", "maxSingleBlobBytes", "maxTotalBlobBytes", "maxCaptureMilliseconds"], "limits");
  for (const [key, value] of Object.entries(limits)) assertPositiveSafeInteger(value, `limits.${key}`);
  return limits;
}

export function parseCaptureLimits(value) {
  exactKeys(value, [
    "schema_version", "max_patch_bytes", "max_raw_z_bytes", "max_single_blob_bytes",
    "max_total_blob_bytes", "max_capture_seconds",
  ], "capture limits");
  if (value.schema_version !== 1) throw new TypeError("capture limits schema_version must be 1");
  for (const key of ["max_patch_bytes", "max_raw_z_bytes", "max_single_blob_bytes", "max_total_blob_bytes", "max_capture_seconds"]) {
    assertPositiveSafeInteger(value[key], `capture limits.${key}`);
  }
  if (value.max_capture_seconds > Math.floor(Number.MAX_SAFE_INTEGER / 1000)) {
    throw new TypeError("capture limits.max_capture_seconds is too large");
  }
  return Object.freeze({
    maxPatchBytes: value.max_patch_bytes,
    maxRawZBytes: value.max_raw_z_bytes,
    maxSingleBlobBytes: value.max_single_blob_bytes,
    maxTotalBlobBytes: value.max_total_blob_bytes,
    maxCaptureMilliseconds: value.max_capture_seconds * 1000,
  });
}

function buildPatchArgv(baseSha, headSha) {
  return [...gitPrefix, "--patch", "--no-abbrev", "--full-index", "--diff-algorithm=myers", "--unified=3", ...commonDiffFlags, baseSha, headSha, "--"];
}

function buildRawArgv(baseSha, headSha) {
  return [...gitPrefix, "--raw", "-z", "--no-abbrev", "--full-index", "--diff-algorithm=myers", ...commonDiffFlags, baseSha, headSha, "--"];
}

function captureConfiguration(limits) {
  return {
    diff_algorithm: "myers",
    context_lines: 3,
    rename_threshold: 50,
    copy_threshold: 50,
    find_copies_harder: true,
    full_object_ids: true,
    external_diff: false,
    textconv: false,
    max_patch_bytes: limits.maxPatchBytes,
    max_raw_z_bytes: limits.maxRawZBytes,
    max_single_blob_bytes: limits.maxSingleBlobBytes,
    max_total_blob_bytes: limits.maxTotalBlobBytes,
    max_capture_seconds: limits.maxCaptureMilliseconds / 1000,
  };
}

function emptyObserved(startedAt) {
  return {
    patch_bytes: 0,
    raw_z_bytes: 0,
    blob_bytes: 0,
    blob_count: 0,
    elapsed_milliseconds: Date.now() - startedAt,
  };
}

function capacityError(reason) {
  return { kind: "capacity", reason };
}

function assertWithinDeadline(startedAt, limits) {
  if (Date.now() - startedAt >= limits.maxCaptureMilliseconds) throw capacityError("deadline");
}

function gitExecutionEnvironment() {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    ...gitEnvironment,
  };
}

function terminateProcessTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function runGitToFile({ repoRoot, args, input, filePath, startedAt, limits, onChunk }) {
  return new Promise((resolve, reject) => {
    try {
      assertWithinDeadline(startedAt, limits);
    } catch (error) {
      reject(error);
      return;
    }
    const remaining = limits.maxCaptureMilliseconds - (Date.now() - startedAt);
    if (remaining <= 0) {
      reject(capacityError("deadline"));
      return;
    }
    let child;
    let settled = false;
    let exceeded;
    let timer;
    let descriptor;
    const closeDescriptor = () => {
      if (descriptor !== undefined) {
        closeSync(descriptor);
        descriptor = undefined;
      }
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    try {
      descriptor = openSync(filePath, "wx", 0o600);
      child = spawn("git", args, {
        cwd: repoRoot,
        detached: process.platform !== "win32",
        env: gitExecutionEnvironment(),
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      closeDescriptor();
      reject({ kind: "process" });
      return;
    }
    timer = setTimeout(() => {
      exceeded = capacityError("deadline");
      terminateProcessTree(child);
    }, remaining);
    child.on("error", () => {
      terminateProcessTree(child);
      closeDescriptor();
      finish(reject, { kind: "process" });
    });
    child.stdout.on("data", (chunk) => {
      if (settled || exceeded) return;
      try {
        onChunk(chunk);
        writeSync(descriptor, chunk);
      } catch (error) {
        exceeded = error?.kind === "capacity" ? error : { kind: "process" };
        terminateProcessTree(child);
      }
    });
    child.on("close", (code) => {
      closeDescriptor();
      if (exceeded) finish(reject, exceeded);
      else if (code !== 0) finish(reject, { kind: "process" });
      else {
        try {
          assertWithinDeadline(startedAt, limits);
          finish(resolve);
        } catch (error) {
          finish(reject, error);
        }
      }
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function runGitBuffer(options) {
  await runGitToFile(options);
  const content = readFileSync(options.filePath);
  assertWithinDeadline(options.startedAt, options.limits);
  return content;
}

function assertObjectId(objectId, objectFormat, label) {
  const length = objectFormat === "sha256" ? 64 : 40;
  if (typeof objectId !== "string" || objectId.length !== length || !HEX.test(objectId)) {
    throw new TypeError(`${label} must be a full ${length}-hex object ID`);
  }
}

function isZeroObjectId(objectId) {
  return /^0+$/.test(objectId);
}

function expectedObjectModes(rawRecords) {
  const expected = new Map();
  for (const record of rawRecords) {
    for (const [objectId, mode] of [[record.oldObjectId, record.oldMode], [record.newObjectId, record.newMode]]) {
      if (isZeroObjectId(objectId) || mode === "160000") continue;
      const modes = expected.get(objectId) ?? new Set();
      modes.add(mode);
      expected.set(objectId, modes);
    }
  }
  return expected;
}

function base64Bytes(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be base64 text`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new TypeError(`${label} must be canonical base64 text`);
  return bytes;
}

function validateCommon(value, keys, diagnostic) {
  exactKeys(value, keys, "captured review input");
  if (value.schema_version !== 1) throw new TypeError("captured review input schema_version must be 1");
  if (diagnostic ? !["capture_capacity_exceeded", "capture_failed"].includes(value.status) : value.status !== "complete") {
    throw new TypeError("captured review input has an invalid status");
  }
  if (typeof value.base_sha !== "string" || typeof value.head_sha !== "string" || !HEX.test(value.base_sha) || !HEX.test(value.head_sha) || value.base_sha.length !== value.head_sha.length || ![40, 64].includes(value.base_sha.length)) {
    throw new TypeError("captured review input must contain full matching object IDs");
  }
  const configurationKeys = ["diff_algorithm", "context_lines", "rename_threshold", "copy_threshold", "find_copies_harder", "full_object_ids", "external_diff", "textconv", "max_patch_bytes", "max_raw_z_bytes", "max_single_blob_bytes", "max_total_blob_bytes", "max_capture_seconds"];
  exactKeys(value.capture_configuration, configurationKeys, "capture configuration");
  const configuration = value.capture_configuration;
  if (configuration.diff_algorithm !== "myers" || configuration.context_lines !== 3 || configuration.rename_threshold !== 50 || configuration.copy_threshold !== 50 || configuration.find_copies_harder !== true || configuration.full_object_ids !== true || configuration.external_diff !== false || configuration.textconv !== false) {
    throw new TypeError("capture configuration has invalid fixed values");
  }
  for (const key of ["max_patch_bytes", "max_raw_z_bytes", "max_single_blob_bytes", "max_total_blob_bytes"]) assertPositiveSafeInteger(configuration[key], `capture configuration.${key}`);
  if (typeof configuration.max_capture_seconds !== "number" || !Number.isFinite(configuration.max_capture_seconds) || configuration.max_capture_seconds <= 0) throw new TypeError("capture configuration.max_capture_seconds must be positive");
  exactKeys(value.git_environment, Object.keys(gitEnvironment), "git environment");
  if (canonicalSha256(value.git_environment) !== canonicalSha256(gitEnvironment)) throw new TypeError("git environment must be the exact capture environment");
  if (!Array.isArray(value.git_config_overrides) || value.git_config_overrides.length !== gitConfigOverrides.length || value.git_config_overrides.some((entry, index) => entry !== gitConfigOverrides[index])) throw new TypeError("git config overrides must be exact");
  const expectedPatch = buildPatchArgv(value.base_sha, value.head_sha);
  const expectedRaw = buildRawArgv(value.base_sha, value.head_sha);
  for (const [actual, expected, label] of [[value.patch_argv, expectedPatch, "patch argv"], [value.raw_argv, expectedRaw, "raw argv"]]) {
    if (!Array.isArray(actual) || actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) throw new TypeError(`${label} must be exact`);
  }
}

export function validateCapturedReviewInput(value) {
  if (!isPlainJsonObject(value)) throw new TypeError("captured review input must be a plain object");
  if (value.status === "complete") {
    validateCommon(value, COMPLETE_FIELDS, false);
    if (value.repository_object_format !== "sha1" && value.repository_object_format !== "sha256") throw new TypeError("repository object format is invalid");
    assertObjectId(value.base_sha, value.repository_object_format, "base_sha");
    assertObjectId(value.head_sha, value.repository_object_format, "head_sha");
    const rawZ = base64Bytes(value.raw_z_base64, "raw_z_base64");
    const patch = base64Bytes(value.patch_base64, "patch_base64");
    const rawRecords = parseRawDiffZ(rawZ, value.repository_object_format);
    const observed = {
      patch_bytes: patch.length,
      raw_z_bytes: rawZ.length,
      blob_bytes: 0,
      blob_count: 0,
      elapsed_milliseconds: 0,
    };
    let maxBlobBytes = 0;
    if (!Array.isArray(value.object_table)) throw new TypeError("object_table must be an array");
    const expected = expectedObjectModes(rawRecords);
    let previousObjectId = "";
    if (value.object_table.length !== expected.size) throw new TypeError("object_table must include each referenced blob once");
    for (const row of value.object_table) {
      exactKeys(row, ["object_id", "object_type", "modes", "size", "content_sha256", "content_base64"], "object table row");
      assertObjectId(row.object_id, value.repository_object_format, "object table object_id");
      if (row.object_id <= previousObjectId) throw new TypeError("object_table must be sorted by unique object ID");
      previousObjectId = row.object_id;
      if (row.object_type !== "blob") throw new TypeError("object_table rows must be blobs");
      const expectedModes = expected.get(row.object_id);
      if (!expectedModes) throw new TypeError("object_table contains an unreferenced object");
      if (!Array.isArray(row.modes) || row.modes.length === 0 || row.modes.some((mode, index) => !/^[0-7]{6}$/.test(mode) || (index > 0 && mode <= row.modes[index - 1]))) throw new TypeError("object table modes must be uniquely sorted modes");
      if (row.modes.join("\0") !== [...expectedModes].sort().join("\0")) throw new TypeError("object table modes do not match raw references");
      const content = base64Bytes(row.content_base64, "object table content_base64");
      if (!Number.isSafeInteger(row.size) || row.size < 0 || row.size !== content.length) throw new TypeError("object table size must match content");
      if (typeof row.content_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(row.content_sha256) || createHash("sha256").update(content).digest("hex") !== row.content_sha256) throw new TypeError("object table content hash does not match content");
      observed.blob_bytes += content.length;
      observed.blob_count += 1;
      if (content.length > maxBlobBytes) maxBlobBytes = content.length;
    }
    const unsigned = { ...value };
    delete unsigned.capture_hash;
    if (typeof value.capture_hash !== "string" || !/^[0-9a-f]{64}$/.test(value.capture_hash) || value.capture_hash !== canonicalSha256(unsigned)) throw new TypeError("capture hash does not match capture content");
    const configuration = value.capture_configuration;
    const reason = observed.patch_bytes > configuration.max_patch_bytes
      ? "patch_bytes"
      : observed.raw_z_bytes > configuration.max_raw_z_bytes
        ? "raw_z_bytes"
        : maxBlobBytes > configuration.max_single_blob_bytes || observed.blob_bytes > configuration.max_total_blob_bytes
          ? "blob_bytes"
          : undefined;
    if (reason !== undefined) {
      return diagnosticEnvelope("capture_capacity_exceeded", reason, value.base_sha, value.head_sha, configuration, value.patch_argv, value.raw_argv, observed);
    }
    return value;
  }
  validateCommon(value, DIAGNOSTIC_FIELDS, true);
  if (value.capacity_reason !== "process_error" && !CAPACITY_REASONS.has(value.capacity_reason)) throw new TypeError("capture diagnostic has an invalid capacity reason");
  exactKeys(value.observed_lower_bounds, ["patch_bytes", "raw_z_bytes", "blob_bytes", "blob_count", "elapsed_milliseconds"], "observed lower bounds");
  for (const [key, lowerBound] of Object.entries(value.observed_lower_bounds)) {
    if (!Number.isSafeInteger(lowerBound) || lowerBound < 0) throw new TypeError(`observed lower bound ${key} must be a non-negative safe integer`);
  }
  return value;
}

function diagnosticEnvelope(status, reason, baseSha, headSha, configuration, patchArgv, rawArgv, observed) {
  return {
    schema_version: 1,
    status,
    base_sha: baseSha,
    head_sha: headSha,
    capture_configuration: configuration,
    patch_argv: patchArgv,
    raw_argv: rawArgv,
    git_environment: { ...gitEnvironment },
    git_config_overrides: [...gitConfigOverrides],
    capacity_reason: reason,
    observed_lower_bounds: observed,
  };
}

function ensureCaptureOptions(options) {
  if (!isPlainJsonObject(options)) throw new TypeError("capture options must be a plain object");
  for (const field of ["repoRoot", "baseSha", "headSha"]) {
    if (typeof options[field] !== "string" || options[field].length === 0) throw new TypeError(`capture options.${field} must be a non-empty string`);
  }
  if (options.outputPath !== undefined && typeof options.outputPath !== "string") throw new TypeError("capture options.outputPath must be a string");
  return validateLimits(options.limits);
}

/** @param {CaptureOptions} options */
export async function captureReviewInput(options) {
  const limits = ensureCaptureOptions(options);
  const { repoRoot, baseSha, headSha, outputPath } = options;
  const patchArgv = buildPatchArgv(baseSha, headSha);
  const rawArgv = buildRawArgv(baseSha, headSha);
  const configuration = captureConfiguration(limits);
  const startedAt = Date.now();
  const observed = emptyObserved(startedAt);
  let workDir;
  try {
    assertWithinDeadline(startedAt, limits);
    workDir = mkdtempSync(join(tmpdir(), "review-capture-"));
    assertWithinDeadline(startedAt, limits);
    const paths = {
      format: join(workDir, "object-format"),
      patch: join(workDir, "patch"),
      raw: join(workDir, "raw"),
      batch: join(workDir, "batch"),
    };
    const unlimited = () => {};
    const objectFormat = (await runGitBuffer({ repoRoot, args: ["rev-parse", "--show-object-format"], filePath: paths.format, startedAt, limits, onChunk: unlimited })).toString("ascii").trim();
    assertWithinDeadline(startedAt, limits);
    if (objectFormat !== "sha1" && objectFormat !== "sha256") throw { kind: "process" };
    assertObjectId(baseSha, objectFormat, "baseSha");
    assertObjectId(headSha, objectFormat, "headSha");
    assertWithinDeadline(startedAt, limits);
    await runGitToFile({
      repoRoot, args: patchArgv.slice(1), filePath: paths.patch, startedAt, limits,
      onChunk: (chunk) => {
        observed.patch_bytes += chunk.length;
        if (observed.patch_bytes > limits.maxPatchBytes) throw capacityError("patch_bytes");
      },
    });
    assertWithinDeadline(startedAt, limits);
    await runGitToFile({
      repoRoot, args: rawArgv.slice(1), filePath: paths.raw, startedAt, limits,
      onChunk: (chunk) => {
        observed.raw_z_bytes += chunk.length;
        if (observed.raw_z_bytes > limits.maxRawZBytes) throw capacityError("raw_z_bytes");
      },
    });
    assertWithinDeadline(startedAt, limits);
    const rawBytes = readFileSync(paths.raw);
    const rawRecords = parseRawDiffZ(rawBytes, objectFormat);
    const objectModes = expectedObjectModes(rawRecords);
    const objectIds = [...objectModes.keys()].sort();
    assertWithinDeadline(startedAt, limits);
    if (objectIds.length > 0) {
      const batchInput = Buffer.from(`${objectIds.join("\n")}\n`, "ascii");
      const batch = await runGitBuffer({ repoRoot, args: ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], input: batchInput, filePath: paths.batch, startedAt, limits, onChunk: unlimited });
      const lines = batch.toString("ascii").trimEnd().split("\n");
      if (lines.length !== objectIds.length) throw { kind: "process" };
      for (let index = 0; index < lines.length; index += 1) {
        const [objectId, objectType, size] = lines[index].split(" ");
        if (objectId !== objectIds[index] || objectType !== "blob" || !/^\d+$/.test(size)) throw { kind: "process" };
      }
      assertWithinDeadline(startedAt, limits);
    }
    const objectTable = [];
    for (const objectId of objectIds) {
      const blobPath = join(workDir, `blob-${objectId}`);
      observed.blob_count += 1;
      let blobBytes = 0;
      await runGitToFile({
        repoRoot, args: ["cat-file", "blob", objectId], filePath: blobPath, startedAt, limits,
        onChunk: (chunk) => {
          blobBytes += chunk.length;
          observed.blob_bytes += chunk.length;
          if (blobBytes > limits.maxSingleBlobBytes || observed.blob_bytes > limits.maxTotalBlobBytes) throw capacityError("blob_bytes");
        },
      });
      const content = readFileSync(blobPath);
      objectTable.push({
        object_id: objectId,
        object_type: "blob",
        modes: [...objectModes.get(objectId)].sort(),
        size: content.length,
        content_sha256: createHash("sha256").update(content).digest("hex"),
        content_base64: content.toString("base64"),
      });
      assertWithinDeadline(startedAt, limits);
    }
    const complete = {
      schema_version: 1,
      status: "complete",
      repository_object_format: objectFormat,
      base_sha: baseSha,
      head_sha: headSha,
      capture_configuration: configuration,
      git_environment: { ...gitEnvironment },
      git_config_overrides: [...gitConfigOverrides],
      patch_argv: patchArgv,
      raw_argv: rawArgv,
      patch_base64: readFileSync(paths.patch).toString("base64"),
      raw_z_base64: rawBytes.toString("base64"),
      object_table: objectTable,
    };
    assertWithinDeadline(startedAt, limits);
    complete.capture_hash = canonicalSha256(complete);
    assertWithinDeadline(startedAt, limits);
    validateCapturedReviewInput(complete);
    assertWithinDeadline(startedAt, limits);
    if (outputPath !== undefined) writeJsonAtomic(outputPath, complete, () => assertWithinDeadline(startedAt, limits));
    assertWithinDeadline(startedAt, limits);
    return complete;
  } catch (error) {
    observed.elapsed_milliseconds = Date.now() - startedAt;
    const reason = error?.kind === "capacity" ? error.reason : "process_error";
    const status = error?.kind === "capacity" ? "capture_capacity_exceeded" : "capture_failed";
    const diagnostic = diagnosticEnvelope(status, reason, baseSha, headSha, configuration, patchArgv, rawArgv, observed);
    validateCapturedReviewInput(diagnostic);
    if (outputPath !== undefined) writeJsonAtomic(outputPath, diagnostic);
    return diagnostic;
  } finally {
    if (workDir !== undefined) rmSync(workDir, { recursive: true, force: true });
  }
}

export function writeJsonAtomic(path, value, onProgress = undefined) {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new TypeError("refusing to replace a symbolic-link output path");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  onProgress?.();
  const content = `${JSON.stringify(value)}\n`;
  onProgress?.();
  const pendingPath = join(dirname(path), `.${basename(path)}.pending-${randomUUID()}`);
  try {
    writeFileSync(pendingPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    onProgress?.();
    renameSync(pendingPath, path);
  } finally {
    rmSync(pendingPath, { force: true });
  }
}

function usage() {
  return "usage: node scripts/review-capture.mjs capture --repo ROOT --base SHA --head SHA --limits LIMITS_JSON --out CAPTURE_JSON\n";
}

async function main(argv) {
  if (argv.length !== 11 || argv[0] !== "capture") {
    process.stderr.write(usage());
    return 2;
  }
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!["--repo", "--base", "--head", "--limits", "--out"].includes(flag) || values.has(flag) || argv[index + 1] === undefined) {
      process.stderr.write(usage());
      return 2;
    }
    values.set(flag, argv[index + 1]);
  }
  if (values.size !== 5) {
    process.stderr.write(usage());
    return 2;
  }
  try {
    const limits = parseCaptureLimits(JSON.parse(readFileSync(values.get("--limits"), "utf8")));
    await captureReviewInput({ repoRoot: values.get("--repo"), baseSha: values.get("--base"), headSha: values.get("--head"), limits, outputPath: values.get("--out") });
    return 0;
  } catch (error) {
    process.stderr.write(`review capture failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
