import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomizeCapturedReviewInput, buildHostedShadowOutput, buildLocalShadowOutput, buildPathFallbackManifest, buildShadowDiagnostic, parseRawDiffZ, splitUnit, validateAtomization, validatePartitionShadowEvaluatorFixture, validateShadowOutput, writeShadowOutput } from "./review-units.mjs";
import { captureReviewInput } from "./review-capture.mjs";

const OLD_ID = "1".repeat(40);
const NEW_ID = "2".repeat(40);
const OLD_SHA256 = createHash("sha256").update("old\r\n").digest("hex");
const NEW_SHA256 = createHash("sha256").update("new\r\n").digest("hex");

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function rawRecord({ oldMode = "100644", newMode = "100644", oldId = OLD_ID, newId = NEW_ID, status = "M", paths = ["old.txt"] }) {
  return Buffer.concat([
    Buffer.from(`:${oldMode} ${newMode} ${oldId} ${newId} ${status}\0`),
    ...paths.map((path) => Buffer.isBuffer(path) ? Buffer.concat([path, Buffer.from([0])]) : Buffer.from(`${path}\0`)),
  ]);
}

function row(objectId, bytes, modes = ["100644"]) {
  return { object_id: objectId, object_type: "blob", modes, size: bytes.length, content_sha256: createHash("sha256").update(bytes).digest("hex"), content_base64: bytes.toString("base64") };
}

function capture({ raw, patch, rows = [row(OLD_ID, Buffer.from("old\r\n")), row(NEW_ID, Buffer.from("new\r\n"))], status = "complete" }) {
  return {
    status,
    repository_object_format: "sha1",
    raw_z_base64: raw.toString("base64"),
    patch_base64: Buffer.from(patch).toString("base64"),
    object_table: rows,
  };
}
function git(repoRoot, args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

async function completeCaptureFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "review-units-shadow-"));
  const repoRoot = join(root, "repo");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("mkdir", ["-p", repoRoot]);
  git(repoRoot, ["init", "-q"]);
  git(repoRoot, ["config", "user.email", "units@example.test"]);
  git(repoRoot, ["config", "user.name", "Units Test"]);
  writeFileSync(join(repoRoot, "file.txt"), "old\n");
  git(repoRoot, ["add", "file.txt"]);
  git(repoRoot, ["commit", "-qm", "base"]);
  const baseSha = git(repoRoot, ["rev-parse", "HEAD"]);
  writeFileSync(join(repoRoot, "file.txt"), "new\n");
  git(repoRoot, ["add", "file.txt"]);
  git(repoRoot, ["commit", "-qm", "head"]);
  const headSha = git(repoRoot, ["rev-parse", "HEAD"]);
  const complete = await captureReviewInput({
    repoRoot, baseSha, headSha,
    limits: { maxPatchBytes: 1_000_000, maxRawZBytes: 1_000_000, maxSingleBlobBytes: 1_000_000, maxTotalBlobBytes: 1_000_000, maxCaptureMilliseconds: 5_000 },
  });
  return { root, complete };
}

const CLI_SHADOW_CONFIG = Object.freeze({
  schema_version: 1, benchmark_revision: "unit-test", atom_target_bytes: 16_000,
  unit_target_bytes: 64_000, max_frontier_units: 128, max_shadow_artifact_bytes: 1_000_000,
});
const CLI_SHADOW_PROFILE = Object.freeze({
  schema_version: 1, descriptors: ["general"], descriptor_content_hashes: ["a".repeat(64)], max_output_attempts: 1,
});

const RENAME_MODE_TEXT_PATCH = [
  "diff --git a/old.txt b/new.txt",
  "similarity index 87%",
  "rename from old.txt",
  "rename to new.txt",
  "old mode 100644",
  "new mode 100755",
  `index ${OLD_ID}..${NEW_ID} 100755`,
  "--- a/old.txt",
  "+++ b/new.txt",
  "@@ -10 +10 @@",
  "-old\r",
  "+new\r",
  "",
].join("\n");

test("atomizes a rename mode text record with independent literal identities", () => {
  const result = atomizeCapturedReviewInput(capture({
    raw: rawRecord({ newMode: "100755", status: "R087", paths: ["old.txt", "new.txt"] }),
    patch: RENAME_MODE_TEXT_PATCH,
    rows: [row(OLD_ID, Buffer.from("old\r\n"), ["100644"]), row(NEW_ID, Buffer.from("new\r\n"), ["100755"])],
  }));
  assert.equal(result.status, "complete");
  assert.equal(result.atoms.length, 2);
  const pathAtom = result.atoms.find((atom) => atom.kind === "path_event");
  const { lineage_candidate, segment_ordinal, content_hash, atom_id, ...pathPayload } = pathAtom;
  assert.deepEqual(pathPayload, {
    kind: "path_event", raw_status: "R087", status_kind: "rename", content_kinds: ["text", "mode"],
    owner_path_base64: Buffer.from("new.txt").toString("base64"), old_path_base64: Buffer.from("old.txt").toString("base64"), new_path_base64: Buffer.from("new.txt").toString("base64"),
    old_mode: "100644", new_mode: "100755", old_object_id: OLD_ID, new_object_id: NEW_ID, similarity: 87,
    old_blob_sha256: OLD_SHA256, new_blob_sha256: NEW_SHA256,
  });
  assert.equal(segment_ordinal, 0);
  assert.equal(lineage_candidate, `p:${sha256({ kind: "path_event", raw_status: "R087", status_kind: "rename", content_kinds: ["text", "mode"], old_path_base64: "b2xkLnR4dA==", new_path_base64: "bmV3LnR4dA==" })}`);
  assert.equal(content_hash, sha256(pathPayload));
  assert.equal(atom_id, `a:${sha256({ atom_schema_version: 1, lineage_candidate, segment_ordinal, content_hash })}`);

  const textAtom = result.atoms.find((atom) => atom.kind === "text");
  const { lineage_candidate: textLineage, segment_ordinal: textOrdinal, content_hash: textHash, atom_id: textId, oversized, ...textPayload } = textAtom;
  assert.deepEqual(textPayload, {
    kind: "text", owner_path_base64: "bmV3LnR4dA==", old_path_base64: "b2xkLnR4dA==", new_path_base64: "bmV3LnR4dA==",
    old_start: 10, old_count: 1, new_start: 10, new_count: 1,
    old_lines: [{ bytes_base64: "b2xkDQ==", terminator: "lf" }], new_lines: [{ bytes_base64: "bmV3DQ==", terminator: "lf" }],
    old_final_newline: true, new_final_newline: true,
  });
  assert.equal(oversized, false);
  assert.equal(textLineage, `t:${sha256({ kind: "text", old_path_base64: "b2xkLnR4dA==", new_path_base64: "bmV3LnR4dA==", old_start: 10, old_count: 1, new_start: 10, new_count: 1 })}`);
  assert.equal(textOrdinal, 0);
  assert.equal(textHash, sha256(textPayload));
  assert.equal(textId, `a:${sha256({ atom_schema_version: 1, lineage_candidate: textLineage, segment_ordinal: textOrdinal, content_hash: textHash })}`);
});

test("classifies every raw status and content decision without guessing unsupported status", () => {
  const cases = [
    ["A", "add", ["text", "mode"]], ["D", "delete", ["text", "mode"]], ["M", "modify", ["text"]], ["R087", "rename", ["text"]], ["C100", "copy", ["text"]], ["T", "typechange", ["text"]],
    ["M", "modify", ["binary"]], ["M", "modify", ["mode"]], ["M", "modify", ["mode", "symlink"]], ["M", "modify", ["mode", "submodule"]], ["M", "modify", ["empty"]], ["M", "modify", ["other"]], ["X", "unknown", ["other"]],
  ];
  for (const [status, statusKind, kinds] of cases) {
    let oldMode = "100644";
    let newMode = "100644";
    let oldId = OLD_ID;
    let newId = NEW_ID;
    let patch = "diff --git a/old.txt b/old.txt\n";
    let rows = [row(OLD_ID, Buffer.from("old\n")), row(NEW_ID, Buffer.from("new\n"))];
    let paths = ["old.txt"];
    if (status === "A") { oldMode = "000000"; oldId = "0".repeat(40); paths = ["new.txt"]; patch = "diff --git a/new.txt b/new.txt\n@@ -0,0 +1 @@\n+new\n"; rows = [row(NEW_ID, Buffer.from("new\n"))]; }
    if (status === "D") { newMode = "000000"; newId = "0".repeat(40); paths = ["old.txt"]; patch = "diff --git a/old.txt b/old.txt\n@@ -1 +0,0 @@\n-old\n"; rows = [row(OLD_ID, Buffer.from("old\n"))]; }
    if (status.startsWith("R") || status.startsWith("C")) { paths = ["old.txt", "new.txt"]; patch = "diff --git a/old.txt b/new.txt\n"; }
    if (kinds.includes("text") && !["A", "D"].includes(status)) patch += "@@ -1 +1 @@\n-old\n+new\n";
    if (kinds.includes("mode") && status === "M") newMode = "100755";
    if (kinds.includes("mode") && status === "M") rows = [row(OLD_ID, Buffer.from("old\n"), ["100644"]), row(NEW_ID, Buffer.from("new\n"), ["100755"])];
    if (kinds.includes("binary")) patch += "Binary files a/old.txt and b/new.txt differ\n";
    if (kinds.includes("symlink")) { newMode = "120000"; rows = [row(OLD_ID, Buffer.from("old\n")), row(NEW_ID, Buffer.from("target\n"), ["120000"])]; }
    if (kinds.includes("submodule")) { newMode = "160000"; rows = [row(OLD_ID, Buffer.from("old\n"))]; }
    if (kinds.includes("empty")) rows = [row(OLD_ID, Buffer.alloc(0)), row(NEW_ID, Buffer.from("new\n"))];
    const result = atomizeCapturedReviewInput(capture({ raw: rawRecord({ oldMode, newMode, oldId, newId, status, paths }), patch, rows }));
    assert.equal(result.status, statusKind === "unknown" ? "atom_coverage_mismatch" : "complete", status);
    const atom = result.atoms?.find((candidate) => candidate.kind === "path_event");
    if (atom) assert.deepEqual([atom.status_kind, atom.content_kinds], [statusKind, kinds], status);
    else assert.ok(result.reasons.includes("unsupported_raw_status"), status);
  }
});

test("preserves invalid bytes, no-final-newline lines, side ownership, and oversized boundaries", () => {
  const path = Buffer.from([111, 108, 100, 45, 255]);
  const oversized = "x".repeat(16_001);
  const raw = rawRecord({ paths: [path] });
  const normal = atomizeCapturedReviewInput(capture({
    raw,
    patch: Buffer.concat([
      Buffer.from('diff --git "a/old-\\377" "b/old-\\377"\n--- "a/old-\\377"\n+++ "b/old-\\377"\n@@ -1 +1 @@\n-'), Buffer.from([0xff]), Buffer.from("\n\\ No newline at end of file\n+"), Buffer.from([0xfe]), Buffer.from("\n\\ No newline at end of file\n"),
    ]),
    rows: [row(OLD_ID, Buffer.from([0xff])), row(NEW_ID, Buffer.from([0xfe]))],
  }));
  assert.equal(normal.status, "complete");
  const text = normal.atoms.find((atom) => atom.kind === "text");
  assert.deepEqual(text.old_lines, [{ bytes_base64: "/w==", terminator: "none" }]);
  assert.deepEqual(text.new_lines, [{ bytes_base64: "/g==", terminator: "none" }]);
  assert.equal(text.old_final_newline, false);
  assert.equal(text.new_final_newline, false);
  assert.equal(text.owner_path_base64, path.toString("base64"));

  const oversizedResult = atomizeCapturedReviewInput(capture({
    raw,
    patch: Buffer.concat([
      Buffer.from('diff --git "a/old-\\377" "b/old-\\377"\n--- "a/old-\\377"\n+++ "b/old-\\377"\n@@ -10,0 +11 @@\n+'), Buffer.from(oversized), Buffer.from("\n"),
    ]),
    rows: [row(OLD_ID, Buffer.from("old\n")), row(NEW_ID, Buffer.from(oversized))],
  }));
  assert.equal(oversizedResult.status, "complete");
  const oversizedText = oversizedResult.atoms.find((atom) => atom.kind === "text");
  assert.equal(oversizedText.oversized, true);
  assert.equal(oversizedText.new_lines[0].bytes_base64, Buffer.from(oversized).toString("base64"));
});

test("separates changed blocks at context lines", () => {
  const result = atomizeCapturedReviewInput(capture({
    raw: rawRecord({}),
    patch: "diff --git a/old.txt b/old.txt\n@@ -1,3 +1,3 @@\n-old-one\n+new-one\n same\n-old-two\n+new-two\n",
  }));
  assert.equal(result.status, "complete");
  const texts = result.atoms.filter((atom) => atom.kind === "text");
  assert.equal(texts.length, 2);
  assert.deepEqual(texts.map(({ old_start, new_start, old_count, new_count }) => ({ old_start, new_start, old_count, new_count })), [
    { old_start: 1, new_start: 1, old_count: 1, new_count: 1 },
    { old_start: 3, new_start: 3, old_count: 1, new_count: 1 },
  ]);
});

test("derives repeated text segment ordinals before their atom IDs", () => {
  const result = atomizeCapturedReviewInput(capture({
    raw: rawRecord({}),
    patch: "diff --git a/old.txt b/old.txt\n@@ -1 +1 @@\n-old\n+new\n@@ -1 +1 @@\n-old\n+new\n",
  }));
  assert.equal(result.status, "complete");
  const texts = result.atoms.filter((atom) => atom.kind === "text");
  assert.deepEqual(texts.map((atom) => atom.segment_ordinal), [0, 1]);
  assert.equal(texts[0].lineage_candidate, texts[1].lineage_candidate);
  assert.notEqual(texts[0].atom_id, texts[1].atom_id);
  for (const atom of texts) {
    assert.equal(atom.atom_id, `a:${sha256({ atom_schema_version: 1, lineage_candidate: atom.lineage_candidate, segment_ordinal: atom.segment_ordinal, content_hash: atom.content_hash })}`);
  }
});

test("reports ordered coverage failures for ownership and incomplete captures", () => {
  const complete = atomizeCapturedReviewInput(capture({ raw: rawRecord({}), patch: "diff --git a/old.txt b/old.txt\n@@ -1 +1 @@\n-old\n+new\n" }));
  assert.equal(complete.status, "complete");
  const malformed = structuredClone(complete);
  malformed.coverage.raw_record_owners.push({ raw_record_index: 0, atom_id: complete.atoms[0].atom_id });
  malformed.coverage.changed_line_owners.shift();
  const checked = validateAtomization(malformed, capture({ raw: rawRecord({}), patch: "diff --git a/other.txt b/other.txt\n@@ -1 +1 @@\n-old\n+new\n" }));
  assert.deepEqual(checked.reasons, ["duplicate_path_owner", "missing_changed_line_owner", "raw_patch_path_disagreement"]);
  assert.deepEqual(validateAtomization(complete, { status: "capture_failed" }).reasons, ["partial_diagnostic_capture"]);
  const blobMismatchCapture = capture({ raw: rawRecord({}), patch: "diff --git a/old.txt b/old.txt\n@@ -1 +1 @@\n-old\n+new\n" });
  blobMismatchCapture.object_table[0].object_type = "tree";
  assert.deepEqual(validateAtomization(complete, blobMismatchCapture).reasons, ["mode_object_blob_disagreement"]);
});
test("keeps header-shaped changed lines inside active hunks", () => {
  const result = atomizeCapturedReviewInput(capture({
    raw: rawRecord({}),
    patch: "diff --git a/old.txt b/old.txt\n@@ -1 +1 @@\n--- removed\n+++ added\n",
  }));
  assert.equal(result.status, "complete");
  const text = result.atoms.find((atom) => atom.kind === "text");
  assert.deepEqual(text.old_lines, [{ bytes_base64: Buffer.from("-- removed").toString("base64"), terminator: "lf" }]);
  assert.deepEqual(text.new_lines, [{ bytes_base64: Buffer.from("++ added").toString("base64"), terminator: "lf" }]);
});

test("rejects coverage ownership IDs that are absent or have the wrong atom kind", () => {
  const source = capture({ raw: rawRecord({}), patch: "diff --git a/old.txt b/old.txt\n@@ -1 +1 @@\n-old\n+new\n" });
  const complete = atomizeCapturedReviewInput(source);
  const path = complete.atoms.find((atom) => atom.kind === "path_event");
  const text = complete.atoms.find((atom) => atom.kind === "text");

  const absentPath = structuredClone(complete);
  absentPath.coverage.raw_record_owners[0].atom_id = `a:${"0".repeat(64)}`;
  assert.deepEqual(validateAtomization(absentPath, source).reasons, ["missing_path_owner"]);

  const textAsPath = structuredClone(complete);
  textAsPath.coverage.raw_record_owners[0].atom_id = text.atom_id;
  assert.deepEqual(validateAtomization(textAsPath, source).reasons, ["missing_path_owner"]);

  const absentLine = structuredClone(complete);
  absentLine.coverage.changed_line_owners[0].atom_id = `a:${"f".repeat(64)}`;
  assert.deepEqual(validateAtomization(absentLine, source).reasons, ["missing_changed_line_owner"]);

  const pathAsLine = structuredClone(complete);
  pathAsLine.coverage.changed_line_owners[0].atom_id = path.atom_id;
  assert.deepEqual(validateAtomization(pathAsLine, source).reasons, ["missing_changed_line_owner"]);
});

test("indexes many changed lines without rescanning prior hunk events", () => {
  const lineCount = 256;
  const patch = `diff --git a/old.txt b/old.txt\n@@ -1,${lineCount} +1,${lineCount} @@\n${Array.from({ length: lineCount }, (_, index) => `-old-${index}\n+new-${index}\n`).join("")}`;
  const originalFilter = Array.prototype.filter;
  let filterCalls = 0;
  Array.prototype.filter = function (...args) {
    filterCalls += 1;
    return originalFilter.apply(this, args);
  };
  try {
    const result = atomizeCapturedReviewInput(capture({ raw: rawRecord({}), patch }));
    assert.equal(result.status, "complete", JSON.stringify(result));
    assert.ok(filterCalls < 10, `atomization made ${filterCalls} Array#filter calls`);
  } finally {
    Array.prototype.filter = originalFilter;
  }
});

test("atomizes many short changed lines with linearly bounded array iteration", () => {
  const changedLines = 2_000;
  const raw = rawRecord({});
  const patch = [
    "diff --git a/old.txt b/old.txt",
    `@@ -1,${changedLines} +1,${changedLines} @@`,
    ...Array.from({ length: changedLines }, () => "-old\n+new").join("\n").split("\n"),
    "",
  ].join("\n");
  const originalIterator = Array.prototype[Symbol.iterator];
  let iteratedValues = 0;
  Array.prototype[Symbol.iterator] = function* trackedArrayIteration() {
    for (const value of originalIterator.call(this)) {
      iteratedValues += 1;
      yield value;
    }
  };
  try {
    const result = atomizeCapturedReviewInput(capture({ raw, patch }));
    assert.equal(result.status, "complete");
  } finally {
    Array.prototype[Symbol.iterator] = originalIterator;
  }
  assert.ok(iteratedValues <= changedLines * 30,
    `atomization iterated ${iteratedValues} values for ${changedLines} changed lines`);
});

test("applies the configured atom target during atomization", () => {
  const changedLine = "x".repeat(1_000);
  const result = atomizeCapturedReviewInput(capture({
    raw: rawRecord({}),
    patch: `diff --git a/old.txt b/old.txt\n@@ -1,0 +1 @@\n+${changedLine}\n`,
    rows: [row(OLD_ID, Buffer.alloc(0)), row(NEW_ID, Buffer.from(changedLine))],
  }), 500);
  assert.equal(result.status, "complete");
  assert.equal(result.atoms.find((atom) => atom.kind === "text").oversized, true);
});

const CAPTURE_HASH = "a".repeat(64);
const BENCHMARK_REVISION = "partition-shadow-fixture-v1";
const SHADOW_CONFIG = {
  schema_version: 1,
  benchmark_revision: BENCHMARK_REVISION,
  atom_target_bytes: 16_000,
  unit_target_bytes: 64_000,
  max_frontier_units: 128,
  max_shadow_artifact_bytes: 4_194_304,
};
const EXECUTION_PROFILE = {
  schema_version: 1,
  descriptors: ["general", "correctness", "boundaries"],
  descriptor_content_hashes: ["1".repeat(64), "2".repeat(64), "3".repeat(64)],
  max_output_attempts: 2,
};

function shadowCapture() {
  return {
    ...capture({ raw: rawRecord({}), patch: "diff --git a/a b/a\n" }),
    capture_hash: CAPTURE_HASH,
    base_sha: OLD_ID,
    head_sha: NEW_ID,
  };
}

function shadowAtom({ kind, path, ordinal = 0, rawStatus = "M", payload = "", oversized = false }) {
  const base = kind === "path_event"
    ? {
      kind, raw_status: rawStatus, status_kind: "modify", content_kinds: ["text"],
      owner_path_base64: Buffer.from(path).toString("base64"), old_path_base64: Buffer.from(path).toString("base64"), new_path_base64: Buffer.from(path).toString("base64"),
      old_mode: "100644", new_mode: "100644", old_object_id: OLD_ID, new_object_id: NEW_ID, similarity: null,
      old_blob_sha256: "4".repeat(64), new_blob_sha256: "5".repeat(64),
    }
    : {
      kind, owner_path_base64: Buffer.from(path).toString("base64"), old_path_base64: Buffer.from(path).toString("base64"), new_path_base64: Buffer.from(path).toString("base64"),
      old_start: ordinal + 1, old_count: 0, new_start: ordinal + 1, new_count: 1,
      old_lines: [], new_lines: [{ bytes_base64: Buffer.from(payload).toString("base64"), terminator: "lf" }],
      old_final_newline: true, new_final_newline: true,
    };
  const content_hash = sha256(base);
  const lineage_candidate = `${kind === "path_event" ? "p" : "t"}:${sha256({ kind, path: Buffer.from(path).toString("base64"), ordinal })}`;
  const atom_id = `a:${sha256({ atom_schema_version: 1, lineage_candidate, segment_ordinal: ordinal, content_hash })}`;
  return { ...base, oversized, lineage_candidate, segment_ordinal: ordinal, content_hash, atom_id };
}

function shadowAtomization(atoms) {
  return { status: "complete", atoms, coverage: { raw_record_owners: [], changed_line_owners: [] } };
}

test("builds a deterministic path-packed manifest with independent unit IDs", () => {
  const atoms = [
    shadowAtom({ kind: "text", path: "b", ordinal: 1, payload: "b".repeat(90) }),
    shadowAtom({ kind: "path_event", path: "a" }),
    shadowAtom({ kind: "text", path: "a", ordinal: 0, payload: "a".repeat(90) }),
    shadowAtom({ kind: "path_event", path: Buffer.from([0xff]) }),
    shadowAtom({ kind: "text", path: Buffer.from([0xff]), ordinal: 0, payload: "z".repeat(500), oversized: true }),
    shadowAtom({ kind: "path_event", path: "b" }),
  ];
  const manifest = buildPathFallbackManifest({
    capture: shadowCapture(),
    atomization: shadowAtomization(atoms),
    config: SHADOW_CONFIG,
    executionProfile: EXECUTION_PROFILE,
  });
  assert.deepEqual(manifest.atoms.map((atom) => atom.owner_path_base64), [
    Buffer.from("a").toString("base64"), Buffer.from("a").toString("base64"),
    Buffer.from("b").toString("base64"), Buffer.from("b").toString("base64"),
    Buffer.from([0xff]).toString("base64"), Buffer.from([0xff]).toString("base64"),
  ]);
  assert.deepEqual(manifest.units.map((unit) => unit.unit_lineage), [
    `root:path:${createHash("sha256").update(Buffer.from("a")).digest("hex")}:0`,
    `root:path:${createHash("sha256").update(Buffer.from("b")).digest("hex")}:0`,
    `root:path:${createHash("sha256").update(Buffer.from([0xff])).digest("hex")}:0`,
  ]);
  assert.equal(manifest.units[2].oversized, true);
  assert.equal(manifest.execution_projection.projected_batches, manifest.units.length);
  assert.equal(manifest.execution_projection.projected_model_calls, 18);
  assert.equal(manifest.manifest_hash, sha256(Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== "manifest_hash"))));
  const firstUnit = manifest.units[0];
  assert.equal(firstUnit.unit_id, sha256({
    unit_schema_version: 1,
    unit_lineage: firstUnit.unit_lineage,
    ordered_atom_ids: firstUnit.ordered_atom_ids,
    coalesced_from: firstUnit.coalesced_from,
  }));
  const shuffled = buildPathFallbackManifest({
    capture: shadowCapture(),
    atomization: shadowAtomization([...atoms].reverse()),
    config: SHADOW_CONFIG,
    executionProfile: EXECUTION_PROFILE,
  });
  assert.equal(canonicalJson(shuffled), canonicalJson(manifest));
  assert.deepEqual(new Set(manifest.units.flatMap((unit) => unit.ordered_atom_ids)), new Set(atoms.map((atom) => atom.atom_id)));
});

test("coalesces the minimum adjacent pair and splits non-atomic units deterministically", () => {
  const atoms = ["a", "b", "c", "d"].map((path) => shadowAtom({ kind: "path_event", path }));
  const manifest = buildPathFallbackManifest({
    capture: shadowCapture(),
    atomization: shadowAtomization(atoms),
    config: { ...SHADOW_CONFIG, atom_target_bytes: 1, unit_target_bytes: 1, max_frontier_units: 3 },
    executionProfile: EXECUTION_PROFILE,
  });
  assert.equal(manifest.counts.coalesced_units, 1);
  assert.deepEqual(manifest.units[0].coalesced_from, [
    `root:path:${createHash("sha256").update(Buffer.from("a")).digest("hex")}:0`,
    `root:path:${createHash("sha256").update(Buffer.from("b")).digest("hex")}:0`,
  ]);
  const [left, right] = splitUnit(manifest.units[0]);
  assert.equal(left.unit_lineage, `${manifest.units[0].unit_lineage}/0`);
  assert.equal(right.unit_lineage, `${manifest.units[0].unit_lineage}/1`);
  assert.deepEqual([...left.ordered_atom_ids, ...right.ordered_atom_ids], manifest.units[0].ordered_atom_ids);
  assert.throws(() => splitUnit(manifest.units[1]), /atomic/);
});

test("validates evaluator metrics and produces redacted fixed-point hosted outputs", () => {
  const atoms = [
    shadowAtom({ kind: "path_event", path: "a" }),
    shadowAtom({ kind: "text", path: "a", payload: "source bytes stay local" }),
    shadowAtom({ kind: "path_event", path: "b" }),
    shadowAtom({ kind: "text", path: "b", payload: "more source bytes" }),
    shadowAtom({ kind: "path_event", path: Buffer.from([0xff]) }),
    shadowAtom({ kind: "text", path: Buffer.from([0xff]), payload: "oversized".repeat(80) }),
  ];
  const manifest = buildPathFallbackManifest({
    capture: shadowCapture(),
    atomization: shadowAtomization(atoms),
    config: SHADOW_CONFIG,
    executionProfile: EXECUTION_PROFILE,
  });
  const fixture = validatePartitionShadowEvaluatorFixture(JSON.parse(readFileSync(new URL("./fixtures/partition-shadow-evaluator-v1.json", import.meta.url))));
  assert.equal(fixture.expected.unit_count, manifest.units.length);
  assert.equal(fixture.expected.projected_model_calls, manifest.execution_projection.projected_model_calls);
  const local = buildLocalShadowOutput(shadowCapture(), manifest);
  assert.equal(local.capture.object_table[0].content_base64, shadowCapture().object_table[0].content_base64);
  const hosted = buildHostedShadowOutput(shadowCapture(), manifest, 100_000);
  assert.equal(hosted.status, "complete");
  assert.equal(hosted.sizes.encoded_output_bytes, Buffer.byteLength(`${canonicalJson(hosted)}\n`));
  assert.ok(hosted.sizes.encoded_output_bytes <= 100_000);
  assert.equal(JSON.stringify(hosted).includes("source bytes stay local"), false);
  assert.equal(Object.hasOwn(hosted.atoms.find((atom) => atom.kind === "text"), "old_lines"), false);
  const compacted = buildHostedShadowOutput(shadowCapture(), manifest, hosted.sizes.encoded_output_bytes - 1);
  assert.equal(compacted.status, "artifact_compacted");
  assert.equal(compacted.sizes.encoded_output_bytes, Buffer.byteLength(`${canonicalJson(compacted)}\n`));
  assert.ok(compacted.sizes.encoded_output_bytes <= hosted.sizes.encoded_output_bytes - 1);
  const diagnostic = buildShadowDiagnostic({
    status: "atom_coverage_mismatch",
    capture: shadowCapture(),
    benchmark_revision: BENCHMARK_REVISION,
    reason_codes: ["z", "a", "z"],
    diagnostic: "x".repeat(1_000),
    observed_lower_bounds: { patch_bytes: 0, raw_z_bytes: 0, blob_bytes: 0, blob_count: 0, elapsed_milliseconds: 0 },
    counts: {},
  }, 10_000);
  assert.deepEqual(diagnostic.reason_codes, ["a", "z"]);
  assert.equal(diagnostic.capture_hash, CAPTURE_HASH);
  assert.equal(diagnostic.manifest_hash, null);
  assert.ok(Buffer.byteLength(diagnostic.diagnostic) <= 512);
  assert.equal(diagnostic.sizes.encoded_output_bytes, Buffer.byteLength(`${canonicalJson(diagnostic)}\n`));
  assert.ok(diagnostic.sizes.encoded_output_bytes <= 10_000);
});

test("validates canonical local, hosted, and diagnostic output envelopes", async (t) => {
  const { root, complete } = await completeCaptureFixture(t);
  const atomization = atomizeCapturedReviewInput(complete, CLI_SHADOW_CONFIG.atom_target_bytes);
  const manifest = buildPathFallbackManifest({
    capture: complete,
    atomization,
    config: CLI_SHADOW_CONFIG,
    executionProfile: CLI_SHADOW_PROFILE,
  });
  const local = buildLocalShadowOutput(complete, manifest);
  const hosted = buildHostedShadowOutput(complete, manifest, CLI_SHADOW_CONFIG.max_shadow_artifact_bytes);
  const diagnostic = buildShadowDiagnostic({
    status: "planner_failed",
    capture: complete,
    benchmark_revision: CLI_SHADOW_CONFIG.benchmark_revision,
    reason_codes: ["planner_error"],
    diagnostic: "Planner failed.",
    observed_lower_bounds: { patch_bytes: 0, raw_z_bytes: 0, blob_bytes: 0, blob_count: 0, elapsed_milliseconds: 0 },
    counts: {},
  }, CLI_SHADOW_CONFIG.max_shadow_artifact_bytes);
  for (const output of [local, hosted, diagnostic]) {
    assert.equal(validateShadowOutput(output, CLI_SHADOW_CONFIG.max_shadow_artifact_bytes), output);
  }

  const outputPath = join(root, "local.json");
  const configPath = join(root, "config.json");
  const profilePath = join(root, "profile.json");
  writeFileSync(configPath, `${canonicalJson(CLI_SHADOW_CONFIG)}\n`);
  writeFileSync(profilePath, `${canonicalJson(CLI_SHADOW_PROFILE)}\n`);
  writeFileSync(outputPath, `${canonicalJson(local)}\n`);
  const validCli = spawnSync(process.execPath, [
    "scripts/review-units.mjs", "validate-output", "--input", outputPath,
    "--profile", profilePath, "--config", configPath,
    "--max-bytes", String(CLI_SHADOW_CONFIG.max_shadow_artifact_bytes),
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(validCli.status, 0, validCli.stderr);

  const forged = structuredClone(local);
  forged.manifest.manifest_hash = "0".repeat(64);
  assert.throws(() => validateShadowOutput(forged, CLI_SHADOW_CONFIG.max_shadow_artifact_bytes), /manifest hash/);
  const selfHashedFabrication = structuredClone(local);
  selfHashedFabrication.manifest.atoms[0].owner_path_base64 = Buffer.from("forged.txt").toString("base64");
  selfHashedFabrication.manifest.manifest_hash = sha256(Object.fromEntries(
    Object.entries(selfHashedFabrication.manifest).filter(([key]) => key !== "manifest_hash"),
  ));
  assert.throws(
    () => validateShadowOutput(selfHashedFabrication, CLI_SHADOW_CONFIG.max_shadow_artifact_bytes),
    /local output manifest does not match capture/,
  );
  for (const [config, profile] of [
    [{ ...CLI_SHADOW_CONFIG, atom_target_bytes: 1 }, CLI_SHADOW_PROFILE],
    [CLI_SHADOW_CONFIG, { ...CLI_SHADOW_PROFILE, descriptors: ["forged"], descriptor_content_hashes: ["f".repeat(64)], max_output_attempts: 2 }],
  ]) {
    const forgedAtomization = atomizeCapturedReviewInput(complete, config.atom_target_bytes);
    const forgedManifest = buildPathFallbackManifest({ capture: complete, atomization: forgedAtomization, config, executionProfile: profile });
    writeFileSync(outputPath, `${canonicalJson(buildLocalShadowOutput(complete, forgedManifest))}\n`);
    const trustedCli = spawnSync(process.execPath, [
      "scripts/review-units.mjs", "validate-output", "--input", outputPath,
      "--profile", profilePath, "--config", configPath,
      "--max-bytes", String(CLI_SHADOW_CONFIG.max_shadow_artifact_bytes),
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(trustedCli.status, 1);
  }
  writeFileSync(outputPath, `${JSON.stringify(local)}\n`);
  const noncanonicalCli = spawnSync(process.execPath, [
    "scripts/review-units.mjs", "validate-output", "--input", outputPath,
    "--max-bytes", String(CLI_SHADOW_CONFIG.max_shadow_artifact_bytes),
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(noncanonicalCli.status, 1);
});

test("rejects self-hashed manifests with missing or extraneous metric keys", () => {
  const manifest = buildPathFallbackManifest({
    capture: shadowCapture(),
    atomization: shadowAtomization([shadowAtom({ kind: "path_event", path: "a" })]),
    config: SHADOW_CONFIG,
    executionProfile: EXECUTION_PROFILE,
  });
  for (const mutate of [
    (value) => { delete value.counts.text_atoms; },
    (value) => { value.counts.untrusted_metric = 1; },
    (value) => { delete value.sizes.unit_payload_bytes; },
    (value) => { value.sizes.untrusted_metric = 1; },
  ]) {
    const forged = structuredClone(manifest);
    mutate(forged);
    forged.manifest_hash = sha256(Object.fromEntries(Object.entries(forged)
      .filter(([key]) => key !== "manifest_hash")));
    assert.throws(() => buildLocalShadowOutput(shadowCapture(), forged), /manifest (counts|sizes) keys/);
  }
});

test("keeps generated atom unions deterministic across canonical input shuffles", () => {
  for (let count = 1; count <= 256; count += 1) {
    const atoms = Array.from({ length: count }, (_, index) => shadowAtom({ kind: "path_event", path: `p-${String(index).padStart(3, "0")}` }));
    const options = {
      capture: shadowCapture(),
      atomization: shadowAtomization(atoms),
      config: { ...SHADOW_CONFIG, atom_target_bytes: 1, unit_target_bytes: 1, max_frontier_units: 128 },
      executionProfile: EXECUTION_PROFILE,
    };
    const baseline = buildPathFallbackManifest(options);
    for (let rotation = 1; rotation <= 3; rotation += 1) {
      const shuffled = [...atoms.slice(rotation), ...atoms.slice(0, rotation)].reverse();
      const actual = buildPathFallbackManifest({ ...options, atomization: shadowAtomization(shuffled) });
      assert.equal(canonicalJson(actual), canonicalJson(baseline), `atom count ${count}, rotation ${rotation}`);
    }
    assert.deepEqual(
      [...new Set(baseline.units.flatMap((unit) => unit.ordered_atom_ids))].sort(),
      atoms.map((atom) => atom.atom_id).sort(),
      `atom union ${count}`,
    );
  }
});

test("enforces literal evaluator metrics and complete diagnostic schemas", () => {
  const atoms = [
    shadowAtom({ kind: "path_event", path: "a" }),
    shadowAtom({ kind: "text", path: "a", payload: "one" }),
    shadowAtom({ kind: "path_event", path: "b" }),
    shadowAtom({ kind: "text", path: "b", payload: "two" }),
    shadowAtom({ kind: "path_event", path: Buffer.from([0xff]) }),
    shadowAtom({ kind: "text", path: Buffer.from([0xff]), payload: "three", oversized: true }),
  ];
  const manifest = buildPathFallbackManifest({
    capture: shadowCapture(), atomization: shadowAtomization(atoms), config: SHADOW_CONFIG, executionProfile: EXECUTION_PROFILE,
  });
  const fixture = validatePartitionShadowEvaluatorFixture(JSON.parse(readFileSync(new URL("./fixtures/partition-shadow-evaluator-v1.json", import.meta.url))));
  assert.deepEqual({
    atom_counts: { path_events: manifest.counts.path_events, text_atoms: manifest.counts.text_atoms },
    unit_count: manifest.units.length,
    oversized_atoms: manifest.counts.oversized_atoms,
    coalesced_units: manifest.counts.coalesced_units,
    projected_batches: manifest.execution_projection.projected_batches,
    projected_model_calls: manifest.execution_projection.projected_model_calls,
  }, fixture.expected);
  for (const [status, captureHash, manifestHash] of [
    ["capture_capacity_exceeded", null, null],
    ["capture_failed", null, null],
    ["atom_coverage_mismatch", CAPTURE_HASH, null],
    ["planner_failed", CAPTURE_HASH, manifest.manifest_hash],
  ]) {
    const diagnostic = buildShadowDiagnostic({
      status,
      capture_hash: captureHash,
      manifest_hash: manifestHash,
      base_sha: OLD_ID,
      head_sha: NEW_ID,
      benchmark_revision: BENCHMARK_REVISION,
      reason_codes: ["z", "a", "a"],
      diagnostic: "🙂".repeat(300),
      observed_lower_bounds: { patch_bytes: 0, raw_z_bytes: 0, blob_bytes: 0, blob_count: 0, elapsed_milliseconds: 0 },
      counts: {},
    }, 10_000);
    assert.deepEqual(Object.keys(diagnostic).sort(), [
      "base_sha", "benchmark_revision", "capture_hash", "counts", "diagnostic", "head_sha",
      "manifest_hash", "mode", "observed_lower_bounds", "reason_codes", "schema_version", "sizes", "status",
    ]);
    assert.deepEqual(diagnostic.reason_codes, ["a", "z"]);
    assert.equal(diagnostic.capture_hash, captureHash);
    assert.equal(diagnostic.manifest_hash, manifestHash);
    assert.ok(Buffer.byteLength(diagnostic.diagnostic) <= 512);
    assert.equal(diagnostic.sizes.encoded_output_bytes, Buffer.byteLength(`${canonicalJson(diagnostic)}\n`));
  }
});

test("splits byte-balanced unit boundaries with lower-index ties", () => {
  const unit = {
    unit_id: "f".repeat(64),
    unit_lineage: "root:path:fixture:0",
    ordered_atom_ids: ["a:1", "a:2", "a:3"],
    coalesced_from: [],
    unit_payload_bytes: 10,
    atomic: false,
    oversized: false,
    atom_payload_bytes: [2, 6, 2],
  };
  const [left, right] = splitUnit(unit);
  assert.deepEqual(left.ordered_atom_ids, ["a:1"]);
  assert.deepEqual(right.ordered_atom_ids, ["a:2", "a:3"]);
  assert.ok(left.unit_payload_bytes < unit.unit_payload_bytes);
  assert.ok(right.unit_payload_bytes < unit.unit_payload_bytes);
});

test("allows the specified empty benchmark revision", () => {
  const manifest = buildPathFallbackManifest({
    capture: shadowCapture(),
    atomization: shadowAtomization([shadowAtom({ kind: "path_event", path: "a" })]),
    config: { ...SHADOW_CONFIG, benchmark_revision: "" },
    executionProfile: EXECUTION_PROFILE,
  });
  assert.equal(manifest.benchmark_revision, "");
});

test("rejects too-small caps and forged self-hashed execution projections", () => {
  const manifest = buildPathFallbackManifest({
    capture: shadowCapture(),
    atomization: shadowAtomization([shadowAtom({ kind: "path_event", path: "a" })]),
    config: SHADOW_CONFIG,
    executionProfile: EXECUTION_PROFILE,
  });
  assert.throws(() => buildHostedShadowOutput(shadowCapture(), manifest, 100), RangeError);
  assert.throws(() => buildShadowDiagnostic({
    status: "capture_failed",
    base_sha: OLD_ID,
    head_sha: NEW_ID,
    benchmark_revision: "",
    reason_codes: ["process_error"],
    diagnostic: "",
    observed_lower_bounds: { patch_bytes: 0, raw_z_bytes: 0, blob_bytes: 0, blob_count: 0, elapsed_milliseconds: 0 },
    counts: {},
  }, 100), RangeError);
  const forged = structuredClone(manifest);
  forged.execution_projection.descriptors = [];
  forged.execution_projection.descriptor_content_hashes = [];
  forged.execution_projection.projected_model_calls = 0;
  forged.manifest_hash = sha256(Object.fromEntries(Object.entries(forged).filter(([key]) => key !== "manifest_hash")));
  assert.throws(() => buildLocalShadowOutput(shadowCapture(), forged), /execution projection/);
});

test("atomic shadow writes reject attacker-created temporary names", () => {
  const directory = mkdtempSync("/tmp/review-units-");
  const destination = `${directory}/output.json`;
  const protectedPath = `${directory}/protected.json`;
  const temporary = `${directory}/.review-units-attacker.tmp`;
  writeFileSync(protectedPath, "protected");
  symlinkSync(protectedPath, temporary);
  try {
    assert.throws(() => writeShadowOutput(destination, { value: "safe" }, () => "attacker"), /EEXIST/);
    assert.equal(readFileSync(protectedPath, "utf8"), "protected");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("propagates final unterminated context newline state into changed text atoms", () => {
  const result = atomizeCapturedReviewInput(capture({
    raw: rawRecord({}),
    patch: "diff --git a/old.txt b/old.txt\n@@ -1,2 +1,2 @@\n-old\n+new\n final context\n\\ No newline at end of file\n",
  }));
  assert.equal(result.status, "complete");
  const atom = result.atoms.find((candidate) => candidate.kind === "text");
  assert.equal(atom.old_final_newline, false);
  assert.equal(atom.new_final_newline, false);
  assert.equal(atom.content_hash, sha256({
    kind: "text", owner_path_base64: "b2xkLnR4dA==", old_path_base64: "b2xkLnR4dA==", new_path_base64: "b2xkLnR4dA==",
    old_start: 1, old_count: 1, new_start: 1, new_count: 1,
    old_lines: [{ bytes_base64: "b2xk", terminator: "lf" }], new_lines: [{ bytes_base64: "bmV3", terminator: "lf" }],
    old_final_newline: false, new_final_newline: false,
  }));
});

test("shadow CLI validates complete captures before atomization or manifest projection", async (t) => {
  const { root, complete } = await completeCaptureFixture(t);
  const configPath = join(root, "config.json");
  const profilePath = join(root, "profile.json");
  const capturePath = join(root, "capture.json");
  const localOutput = join(root, "local.json");
  writeFileSync(configPath, JSON.stringify(CLI_SHADOW_CONFIG));
  writeFileSync(profilePath, JSON.stringify(CLI_SHADOW_PROFILE));
  const mutations = [
    (value) => { delete value.base_sha; },
    (value) => { delete value.head_sha; },
    (value) => { delete value.object_table; },
    (value) => { delete value.capture_hash; },
    (value) => { value.capture_hash = "not-a-hash"; },
    (value) => { value.capture_hash = "0".repeat(64); },
    (value) => { value.object_table[0].content_base64 = Buffer.from("tampered").toString("base64"); },
  ];
  for (const mutate of mutations) {
    const malformed = structuredClone(complete);
    mutate(malformed);
    writeFileSync(capturePath, JSON.stringify(malformed));
    const child = spawnSync(process.execPath, ["scripts/review-units.mjs", "shadow", "--capture", capturePath, "--profile", profilePath, "--config", configPath, "--local-out", localOutput], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const output = JSON.parse(readFileSync(localOutput, "utf8"));
    assert.equal(output.status, "capture_failed");
    assert.equal(Object.hasOwn(output, "manifest"), false);
    assert.ok(output.reason_codes.includes("capture_validation_failed"));
  }
});

test("shadow CLI emits a non-complete capture diagnostic before reading the profile", async (t) => {
  const { root, complete } = await completeCaptureFixture(t);
  const limited = await captureReviewInput({
    repoRoot: join(root, "repo"),
    baseSha: complete.base_sha,
    headSha: complete.head_sha,
    limits: { maxPatchBytes: 1, maxRawZBytes: 1_000_000, maxSingleBlobBytes: 1_000_000, maxTotalBlobBytes: 1_000_000, maxCaptureMilliseconds: 5_000 },
  });
  assert.notEqual(limited.status, "complete");
  const configPath = join(root, "config.json");
  const capturePath = join(root, "capture.json");
  const localOutput = join(root, "local.json");
  writeFileSync(configPath, JSON.stringify(CLI_SHADOW_CONFIG));
  writeFileSync(capturePath, JSON.stringify(limited));
  const child = spawnSync(process.execPath, [
    "scripts/review-units.mjs", "shadow", "--capture", capturePath,
    "--profile", join(root, "missing-profile.json"), "--config", configPath,
    "--local-out", localOutput,
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(readFileSync(localOutput, "utf8")).status, limited.status);
});

test("runs shadow CLI from both relative and absolute script paths", async (t) => {
  const { root, complete } = await completeCaptureFixture(t);
  const configPath = join(root, "config.json");
  const profilePath = join(root, "profile.json");
  const capturePath = join(root, "capture.json");
  writeFileSync(configPath, JSON.stringify(CLI_SHADOW_CONFIG));
  writeFileSync(profilePath, JSON.stringify(CLI_SHADOW_PROFILE));
  writeFileSync(capturePath, JSON.stringify(complete));
  for (const [index, script] of ["scripts/review-units.mjs", join(process.cwd(), "scripts/review-units.mjs")].entries()) {
    const localOutput = join(root, `local-${index}.json`);
    const child = spawnSync(process.execPath, [script, "shadow", "--capture", capturePath, "--profile", profilePath, "--config", configPath, "--local-out", localOutput], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(readFileSync(localOutput, "utf8")).status, "complete");
  }
});

test("atomizes unknown uppercase raw statuses as bounded diagnostics", async (t) => {
  const raw = Buffer.from(`:100644 100644 ${OLD_ID} ${NEW_ID} Q\0path.txt\0`);
  assert.equal(parseRawDiffZ(raw, "sha1")[0].status, "Q");
  const atomization = atomizeCapturedReviewInput(capture({ raw, patch: "diff --git a/path.txt b/path.txt\n", rows: [row(OLD_ID, Buffer.from("old\n")), row(NEW_ID, Buffer.from("new\n"))] }));
  assert.deepEqual(atomization.reasons, ["unsupported_raw_status"]);

  const { root, complete } = await completeCaptureFixture(t);
  const rawBytes = Buffer.from(complete.raw_z_base64, "base64");
  rawBytes[rawBytes.indexOf(Buffer.from(" M\0")) + 1] = 0x51;
  const unknown = { ...complete, raw_z_base64: rawBytes.toString("base64") };
  unknown.capture_hash = sha256(Object.fromEntries(Object.entries(unknown).filter(([key]) => key !== "capture_hash")));
  const configPath = join(root, "config.json");
  const profilePath = join(root, "profile.json");
  const capturePath = join(root, "capture.json");
  const localOutput = join(root, "local.json");
  writeFileSync(configPath, JSON.stringify(CLI_SHADOW_CONFIG));
  writeFileSync(profilePath, JSON.stringify(CLI_SHADOW_PROFILE));
  writeFileSync(capturePath, JSON.stringify(unknown));
  const child = spawnSync(process.execPath, ["scripts/review-units.mjs", "shadow", "--capture", capturePath, "--profile", profilePath, "--config", configPath, "--local-out", localOutput], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const output = JSON.parse(readFileSync(localOutput, "utf8"));
  assert.equal(output.status, "atom_coverage_mismatch");
  assert.ok(output.reason_codes.includes("unsupported_raw_status"));
});

test("correlates many raw records without rescanning patch sections", () => {
  const count = 128;
  const raw = Buffer.concat(Array.from({ length: count }, (_, index) => rawRecord({ paths: [`p-${index}`] })));
  const patch = Array.from({ length: count }, (_, index) => `diff --git a/p-${index} b/p-${index}\n`).join("");
  const originalFindIndex = Array.prototype.findIndex;
  let findIndexCalls = 0;
  Array.prototype.findIndex = function (...args) {
    findIndexCalls += 1;
    return originalFindIndex.apply(this, args);
  };
  try {
    const result = atomizeCapturedReviewInput(capture({ raw, patch, rows: [row(OLD_ID, Buffer.from("old\n")), row(NEW_ID, Buffer.from("new\n"))] }));
    assert.equal(result.status, "complete");
    assert.equal(findIndexCalls, 0);
  } finally {
    Array.prototype.findIndex = originalFindIndex;
  }
});

test("preserves aligned unit atom payload bytes through JSON and split", () => {
  const manifest = buildPathFallbackManifest({ capture: shadowCapture(), atomization: shadowAtomization([shadowAtom({ kind: "path_event", path: "a" }), shadowAtom({ kind: "text", path: "a", payload: "payload" })]), config: SHADOW_CONFIG, executionProfile: EXECUTION_PROFILE });
  const parent = structuredClone(manifest.units.find((unit) => unit.ordered_atom_ids.length > 1));
  assert.equal(parent.atom_payload_bytes.reduce((total, value) => total + value, 0), parent.unit_payload_bytes);
  const [left, right] = splitUnit(parent);
  for (const child of [left, right]) {
    assert.equal(child.atom_payload_bytes.length, child.ordered_atom_ids.length);
    assert.equal(child.atom_payload_bytes.reduce((total, value) => total + value, 0), child.unit_payload_bytes);
  }
});
