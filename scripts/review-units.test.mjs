import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { atomizeCapturedReviewInput, validateAtomization } from "./review-units.mjs";

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
  const { lineage_candidate: textLineage, segment_ordinal: textOrdinal, content_hash: textHash, atom_id: textId, ...textPayload } = textAtom;
  assert.deepEqual(textPayload, {
    kind: "text", owner_path_base64: "bmV3LnR4dA==", old_path_base64: "b2xkLnR4dA==", new_path_base64: "bmV3LnR4dA==",
    old_start: 10, old_count: 1, new_start: 10, new_count: 1,
    old_lines: [{ bytes_base64: "b2xkDQ==", terminator: "lf" }], new_lines: [{ bytes_base64: "bmV3DQ==", terminator: "lf" }],
    old_final_newline: true, new_final_newline: true, oversized: false,
  });
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
