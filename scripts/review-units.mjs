import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { pathToFileURL } from "node:url";
import { canonicalJson, canonicalSha256 } from "./lib-canonical-json.mjs";
import { validateCapturedReviewInput } from "./review-capture.mjs";

export const RAW_STATUS_PATH_COUNT = Object.freeze({
  A: 1,
  D: 1,
  M: 1,
  T: 1,
  U: 1,
  X: 1,
  B: 1,
  R: 2,
  C: 2,
});

const FULL_OBJECT_ID = /^[0-9a-f]+$/;
const ZERO_OBJECT_ID = /^0+$/;
const STATUS_KINDS = Object.freeze({ A: "add", D: "delete", M: "modify", R: "rename", C: "copy", T: "typechange", U: "unmerged" });
const CONTENT_KIND_ORDER = Object.freeze(["text", "binary", "mode", "symlink", "submodule", "empty", "other"]);
const ATOM_TARGET_BYTES = 16_000;

/**
 * @typedef {{
 *   oldMode:string, newMode:string, oldObjectId:string, newObjectId:string,
 *   status:string, similarity:number|null, oldPath:Buffer|null, newPath:Buffer|null
 * }} RawRecord
 */

/**
 * @param {Buffer} bytes
 * @param {"sha1"|"sha256"} objectFormat
 * @returns {RawRecord[]}
 */
export function parseRawDiffZ(bytes, objectFormat) {
  const objectHexLength = objectFormat === "sha256" ? 64 : objectFormat === "sha1" ? 40 : 0;
  if (objectHexLength === 0) throw new TypeError("unknown repository object format");
  if (!Buffer.isBuffer(bytes)) throw new TypeError("raw diff must be a Buffer");

  const fields = bytes.subarray(0).toString("binary").split("\0");
  if (fields.at(-1) !== "") throw new TypeError("raw diff must end with a NUL record terminator");
  fields.pop();
  const records = [];
  for (let index = 0; index < fields.length;) {
    const metadata = fields[index];
    if (!metadata.startsWith(":")) throw new TypeError("raw diff record must begin with colon metadata");
    const parts = metadata.slice(1).split(" ");
    if (parts.length !== 5) throw new TypeError("raw diff metadata has an invalid field count");
    const [oldMode, newMode, oldObjectId, newObjectId, rawStatus] = parts;
    if (!/^[0-7]{6}$/.test(oldMode) || !/^[0-7]{6}$/.test(newMode)) {
      throw new TypeError("raw diff metadata has an invalid mode");
    }
    for (const objectId of [oldObjectId, newObjectId]) {
      if (objectId.length !== objectHexLength || !FULL_OBJECT_ID.test(objectId)) {
        throw new TypeError(`raw diff object IDs must be full ${objectHexLength}-hex object ID values`);
      }
    }
    const match = /^([A-Z])(?:(\d{1,3}))?$/.exec(rawStatus);
    if (!match) throw new TypeError("raw diff metadata has an invalid status");
    const [, status, similarityText] = match;
    const knownStatus = Object.hasOwn(RAW_STATUS_PATH_COUNT, status);
    if (knownStatus && (status === "R" || status === "C") !== (similarityText !== undefined)) {
      throw new TypeError("raw diff rename/copy status must include similarity");
    }
    if (similarityText !== undefined && Number(similarityText) > 100) {
      throw new TypeError("raw diff similarity must not exceed 100");
    }
    const pathCount = RAW_STATUS_PATH_COUNT[status] ?? 1;
    if (fields.length - index - 1 < pathCount) throw new TypeError("raw diff record has missing path fields");
    const paths = fields.slice(index + 1, index + 1 + pathCount).map((path) => Buffer.from(path, "binary"));
    index += pathCount + 1;

    const onePath = paths[0];
    records.push({
      oldMode,
      newMode,
      oldObjectId,
      newObjectId,
      status,
      similarity: similarityText === undefined ? null : Number(similarityText),
      oldPath: status === "A" ? null : pathCount === 2 ? paths[0] : onePath,
      newPath: status === "D" ? null : pathCount === 2 ? paths[1] : onePath,
    });
  }
  return records;
}

function canonicalBase64(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be base64 text`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new TypeError(`${label} must be canonical base64 text`);
  return bytes;
}


function decodeGitPath(value) {
  if (value.equals(Buffer.from("/dev/null"))) return null;
  if (value[0] !== 0x22) return value;
  if (value.at(-1) !== 0x22) throw new TypeError("unterminated quoted Git path");
  const bytes = [];
  for (let index = 1; index < value.length - 1; index += 1) {
    const byte = value[index];
    if (byte !== 0x5c) {
      bytes.push(byte);
      continue;
    }
    const escaped = value[++index];
    const escapes = { 0x61: 0x07, 0x62: 0x08, 0x66: 0x0c, 0x6e: 0x0a, 0x72: 0x0d, 0x74: 0x09, 0x76: 0x0b, 0x5c: 0x5c, 0x22: 0x22 };
    if (Object.hasOwn(escapes, escaped)) bytes.push(escapes[escaped]);
    else if (escaped >= 0x30 && escaped <= 0x37) {
      const octal = value.subarray(index, index + 3).toString("ascii");
      if (!/^[0-7]{3}$/.test(octal)) throw new TypeError("invalid quoted Git path escape");
      bytes.push(Number.parseInt(octal, 8));
      index += 2;
    } else throw new TypeError("invalid quoted Git path escape");
  }
  return Buffer.from(bytes);
}

function removeDiffPrefix(path, prefix) {
  if (path === null || !path.subarray(0, 2).equals(Buffer.from(`${prefix}/`))) return path;
  return path.subarray(2);
}

function gitTokens(bytes) {
  const unquotedBoundary = bytes[0] === 0x22 ? -1 : bytes.indexOf(Buffer.from(" b/"));
  if (unquotedBoundary !== -1) {
    return [
      decodeGitPath(bytes.subarray(0, unquotedBoundary)),
      decodeGitPath(bytes.subarray(unquotedBoundary + 1)),
    ];
  }
  const tokens = [];
  for (let index = 0; index < bytes.length && tokens.length < 2;) {
    while (bytes[index] === 0x20) index += 1;
    const start = index;
    if (bytes[index] === 0x22) {
      index += 1;
      while (index < bytes.length) {
        if (bytes[index] === 0x5c) index += 2;
        else if (bytes[index++] === 0x22) break;
      }
    } else while (index < bytes.length && bytes[index] !== 0x20) index += 1;
    tokens.push(decodeGitPath(bytes.subarray(start, index)));
  }
  if (tokens.length !== 2) throw new TypeError("invalid diff header paths");
  return tokens;
}

function parseHunkHeader(line) {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line.toString("ascii"));
  if (!match) throw new TypeError("invalid patch hunk header");
  return { oldStart: Number(match[1]), oldCount: Number(match[2] ?? 1), newStart: Number(match[3]), newCount: Number(match[4] ?? 1) };
}

function parsePatch(bytes) {
  const sections = [];
  let section;
  let hunk;
  let lastChanged;
  let previousSides;
  let offset = 0;
  const finishHunk = () => {
    if (hunk && (hunk.oldRecords !== hunk.oldCount || hunk.newRecords !== hunk.newCount)) throw new TypeError("patch hunk record counts do not match header");
    hunk = undefined;
    lastChanged = undefined;
    previousSides = undefined;
  };
  const startSection = (line) => {
    finishHunk();
    const [oldHeader, newHeader] = gitTokens(line.subarray(Buffer.byteLength("diff --git ")));
    section = { oldPath: removeDiffPrefix(oldHeader, "a"), newPath: removeDiffPrefix(newHeader, "b"), headerOldPath: removeDiffPrefix(oldHeader, "a"), headerNewPath: removeDiffPrefix(newHeader, "b"), hunks: [], binary: false, oldFinalNewline: true, newFinalNewline: true };
    sections.push(section);
  };
  while (offset < bytes.length) {
    const newline = bytes.indexOf(0x0a, offset);
    const hasLf = newline !== -1;
    const line = bytes.subarray(offset, hasLf ? newline : bytes.length);
    offset = hasLf ? newline + 1 : bytes.length;
    if (line.subarray(0, 11).equals(Buffer.from("diff --git "))) { startSection(line); continue; }
    if (!section) continue;
    if (!hunk && line.subarray(0, 4).equals(Buffer.from("--- "))) { section.oldPath = removeDiffPrefix(decodeGitPath(line.subarray(4)), "a"); continue; }
    if (!hunk && line.subarray(0, 4).equals(Buffer.from("+++ "))) { section.newPath = removeDiffPrefix(decodeGitPath(line.subarray(4)), "b"); continue; }
    if (line.subarray(0, 3).equals(Buffer.from("@@ "))) {
      finishHunk();
      const range = parseHunkHeader(line);
      hunk = { ...range, events: [], blocks: [], currentBlock: undefined, oldCursor: range.oldStart, newCursor: range.newStart, oldLineIndex: 0, newLineIndex: 0, oldRecords: 0, newRecords: 0, index: section.hunks.length };
      section.hunks.push(hunk);
      lastChanged = undefined;
      previousSides = undefined;
      continue;
    }
    if (line.equals(Buffer.from("\\ No newline at end of file"))) {
      for (const side of previousSides ?? []) section[side === "old" ? "oldFinalNewline" : "newFinalNewline"] = false;
      if (lastChanged) lastChanged.line.terminator = "none";
      continue;
    }
    if (line.subarray(0, Buffer.byteLength("Binary files ")).equals(Buffer.from("Binary files ")) || line.equals(Buffer.from("GIT binary patch"))) section.binary = true;
    if (!hunk) continue;
    const marker = line[0];
    if (marker === 0x20) {
      hunk.oldRecords += 1;
      hunk.newRecords += 1;
      hunk.oldCursor += 1;
      hunk.newCursor += 1;
      hunk.currentBlock = undefined;
      previousSides = ["old", "new"];
      lastChanged = undefined;
    } else if (marker === 0x2d || marker === 0x2b) {
      const side = marker === 0x2d ? "old" : "new";
      hunk[side === "old" ? "oldRecords" : "newRecords"] += 1;
      const lineValue = { bytes_base64: line.subarray(1).toString("base64"), terminator: "lf" };
      const event = { side, line: lineValue, oldBefore: hunk.oldCursor, newBefore: hunk.newCursor, lineIndex: side === "old" ? hunk.oldLineIndex++ : hunk.newLineIndex++ };
      hunk.events.push(event);
      if (!hunk.currentBlock) {
        hunk.currentBlock = [];
        hunk.blocks.push(hunk.currentBlock);
      }
      hunk.currentBlock.push(event);
      if (side === "old") hunk.oldCursor += 1;
      else hunk.newCursor += 1;
      lastChanged = event;
      previousSides = [side];
    }
    if (hunk.oldRecords > hunk.oldCount || hunk.newRecords > hunk.newCount) throw new TypeError("patch hunk record counts do not match header");
  }
  finishHunk();
  return sections;
}

function pathKey(path) {
  return path === null ? "-" : path.toString("base64");
}

function recordSectionKey(record) {
  if (record.oldPath === null) return `new:${pathKey(record.newPath)}`;
  if (record.newPath === null) return `old:${pathKey(record.oldPath)}`;
  return `pair:${pathKey(record.oldPath)}:${pathKey(record.newPath)}`;
}

function sectionKeys(section) {
  const keys = new Set();
  for (const [oldPath, newPath] of [[section.oldPath, section.newPath], [section.headerOldPath, section.headerNewPath]]) {
    keys.add(`pair:${pathKey(oldPath)}:${pathKey(newPath)}`);
    if (oldPath !== null) keys.add(`old:${pathKey(oldPath)}`);
    if (newPath !== null) keys.add(`new:${pathKey(newPath)}`);
  }
  return keys;
}

function correlate(records, sections) {
  const sectionForRecord = new Array(records.length).fill(-1);
  const recordForSection = new Array(sections.length).fill(-1);
  const indexedSections = new Map();
  sections.forEach((section, sectionIndex) => {
    for (const key of sectionKeys(section)) {
      const queue = indexedSections.get(key) ?? [];
      queue.push(sectionIndex);
      indexedSections.set(key, queue);
    }
  });
  const queueOffsets = new Map();
  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    const key = recordSectionKey(records[recordIndex]);
    const queue = indexedSections.get(key) ?? [];
    let offset = queueOffsets.get(key) ?? 0;
    while (offset < queue.length && recordForSection[queue[offset]] !== -1) offset += 1;
    queueOffsets.set(key, offset);
    if (offset < queue.length) {
      const sectionIndex = queue[offset];
      sectionForRecord[recordIndex] = sectionIndex;
      recordForSection[sectionIndex] = recordIndex;
      queueOffsets.set(key, offset + 1);
    }
  }
  return { sectionForRecord, recordForSection };
}
function objectRows(capture) {
  const rows = new Map();
  if (!Array.isArray(capture.object_table)) return rows;
  for (const row of capture.object_table) rows.set(row.object_id, row);
  return rows;
}

function blobHash(rows, objectId, mode) {
  if (ZERO_OBJECT_ID.test(objectId) || mode === "160000") return null;
  return rows.get(objectId)?.content_sha256 ?? null;
}

function contentKinds(record, section, rows) {
  const kinds = new Set();
  if (section?.hunks.length) kinds.add("text");
  if (section?.binary && !section.hunks.length) kinds.add("binary");
  if (record.oldMode !== record.newMode) kinds.add("mode");
  if (record.oldMode === "120000" || record.newMode === "120000") kinds.add("symlink");
  if (record.oldMode === "160000" || record.newMode === "160000") kinds.add("submodule");
  for (const [objectId, mode] of [[record.oldObjectId, record.oldMode], [record.newObjectId, record.newMode]]) {
    if (!ZERO_OBJECT_ID.test(objectId) && mode !== "160000" && rows.get(objectId)?.size === 0) kinds.add("empty");
  }
  if (kinds.size === 0) kinds.add("other");
  return CONTENT_KIND_ORDER.filter((kind) => kinds.has(kind));
}

function pathPayload(record, section, rows) {
  const statusKind = STATUS_KINDS[record.status] ?? "unknown";
  const kinds = contentKinds(record, section, rows);
  return {
    kind: "path_event", raw_status: `${record.status}${record.similarity === null ? "" : String(record.similarity).padStart(3, "0")}`, status_kind: statusKind, content_kinds: kinds,
    owner_path_base64: (record.newPath ?? record.oldPath).toString("base64"), old_path_base64: record.oldPath?.toString("base64") ?? null, new_path_base64: record.newPath?.toString("base64") ?? null,
    old_mode: record.oldMode, new_mode: record.newMode, old_object_id: record.oldObjectId, new_object_id: record.newObjectId, similarity: record.similarity,
    old_blob_sha256: blobHash(rows, record.oldObjectId, record.oldMode), new_blob_sha256: blobHash(rows, record.newObjectId, record.newMode),
  };
}

function textPayload(record, oldStart, newStart, oldLines, newLines, oldFinalNewline, newFinalNewline) {
  return {
    kind: "text", owner_path_base64: (record.newPath ?? record.oldPath).toString("base64"), old_path_base64: record.oldPath?.toString("base64") ?? null, new_path_base64: record.newPath?.toString("base64") ?? null,
    old_start: oldStart, old_count: oldLines.length, new_start: newStart, new_count: newLines.length,
    old_lines: oldLines, new_lines: newLines,
    old_final_newline: oldFinalNewline, new_final_newline: newFinalNewline,
  };
}

function textLineage(payload) {
  return `t:${canonicalSha256({ kind: "text", old_path_base64: payload.old_path_base64, new_path_base64: payload.new_path_base64, old_start: payload.old_start, old_count: payload.old_count, new_start: payload.new_start, new_count: payload.new_count })}`;
}

function projectTextAtoms(record, section, sectionIndex, atomTargetBytes) {
  const atoms = [];
  for (const hunk of section.hunks) {
    for (const block of hunk.blocks) {
      let oldCursor = block[0].oldBefore;
      let newCursor = block[0].newBefore;
      let candidate;
      const start = () => {
        const oldStart = oldCursor;
        const newStart = newCursor;
        return {
          oldStart,
          newStart,
          oldLines: [],
          newLines: [],
          owners: [],
          oldLineEntryBytes: 0,
          newLineEntryBytes: 0,
          emptyPayloadBytes: Buffer.byteLength(canonicalJson(
            textPayload(record, oldStart, newStart, [], [], section.oldFinalNewline, section.newFinalNewline),
          )),
        };
      };
      const prospectivePayloadBytes = (value, side, lineEntryBytes) => {
        const oldCount = value.oldLines.length + (side === "old" ? 1 : 0);
        const newCount = value.newLines.length + (side === "new" ? 1 : 0);
        const oldEntries = value.oldLineEntryBytes + (side === "old" ? lineEntryBytes : 0);
        const newEntries = value.newLineEntryBytes + (side === "new" ? lineEntryBytes : 0);
        return value.emptyPayloadBytes
          + oldEntries + Math.max(0, oldCount - 1)
          + newEntries + Math.max(0, newCount - 1)
          + String(oldCount).length - 1
          + String(newCount).length - 1;
      };
      const append = (value, event, lineEntryBytes, payloadBytes) => {
        const lineKey = `${sectionIndex}:${hunk.index}:${event.side}:${event.lineIndex}`;
        value[event.side === "old" ? "oldLines" : "newLines"].push(event.line);
        value[event.side === "old" ? "oldLineEntryBytes" : "newLineEntryBytes"] += lineEntryBytes;
        value.owners.push(lineKey);
        value.payloadBytes = payloadBytes;
      };
      const finish = () => {
        if (!candidate || candidate.owners.length === 0) return;
        const payload = textPayload(record, candidate.oldStart, candidate.newStart, candidate.oldLines, candidate.newLines, section.oldFinalNewline, section.newFinalNewline);
        atoms.push({ payload, oversized: candidate.oversized === true, lineage_candidate: textLineage(payload), sort: [payload.old_start, payload.old_count, payload.new_start, payload.new_count], owners: candidate.owners });
        candidate = undefined;
      };
      for (const event of block) {
        if (!candidate) candidate = start();
        const lineEntryBytes = Buffer.byteLength(canonicalJson(event.line));
        let payloadBytes = prospectivePayloadBytes(candidate, event.side, lineEntryBytes);
        if (candidate.owners.length > 0 && payloadBytes > atomTargetBytes) {
          finish();
          candidate = start();
          payloadBytes = prospectivePayloadBytes(candidate, event.side, lineEntryBytes);
        }
        append(candidate, event, lineEntryBytes, payloadBytes);
        if (candidate.owners.length === 1) candidate.oversized = payloadBytes > atomTargetBytes;
        if (event.side === "old") oldCursor += 1;
        else newCursor += 1;
      }
      finish();
    }
  }
  return atoms;
}

function assignIdentities(bases) {
  const groups = new Map();
  for (const base of bases) {
    base.content_hash = canonicalSha256(base.payload);
    base.canonical_payload_bytes = canonicalJson(base.payload);
    const values = groups.get(base.lineage_candidate) ?? [];
    values.push(base);
    groups.set(base.lineage_candidate, values);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => {
      for (let index = 0; index < left.sort.length; index += 1) if (left.sort[index] !== right.sort[index]) return left.sort[index] - right.sort[index];
      if (left.content_hash !== right.content_hash) return left.content_hash.localeCompare(right.content_hash);
      return Buffer.compare(Buffer.from(left.canonical_payload_bytes), Buffer.from(right.canonical_payload_bytes));
    });
    group.forEach((base, segmentOrdinal) => {
      base.segment_ordinal = segmentOrdinal;
      base.atom_id = `a:${canonicalSha256({ atom_schema_version: 1, lineage_candidate: base.lineage_candidate, segment_ordinal: segmentOrdinal, content_hash: base.content_hash })}`;
    });
  }
  return bases.map(({ payload, oversized, lineage_candidate, segment_ordinal, content_hash, atom_id }) => ({ ...payload, ...(oversized === undefined ? {} : { oversized }), lineage_candidate, segment_ordinal, content_hash, atom_id }));
}

function expectedChangedLineKeys(sections) {
  return sections.flatMap((section, sectionIndex) => section.hunks.flatMap((hunk) => hunk.events.map((event) => `${sectionIndex}:${hunk.index}:${event.side}:${event.lineIndex}`)));
}

function counts(records, atoms, changedLineCount, changedLineOwners) {
  return { raw_records: records.length, path_atoms: atoms.filter((atom) => atom.kind === "path_event").length, changed_lines: changedLineCount, changed_line_owners: changedLineOwners.length };
}

function mismatch(reasons, countsValue) {
  return { status: "atom_coverage_mismatch", reasons, counts: countsValue };
}

function inputState(capture) {
  if (capture?.status !== "complete") return { diagnostic: true, records: [], sections: [] };
  try {
    return {
      diagnostic: false,
      records: parseRawDiffZ(canonicalBase64(capture.raw_z_base64, "raw_z_base64"), capture.repository_object_format),
      sections: parsePatch(canonicalBase64(capture.patch_base64, "patch_base64")),
    };
  } catch {
    return { diagnostic: false, malformed: true, records: [], sections: [] };
  }
}

function modeObjectBlobDisagreement(records, rows) {
  for (const record of records) {
    for (const [objectId, mode] of [[record.oldObjectId, record.oldMode], [record.newObjectId, record.newMode]]) {
      if (ZERO_OBJECT_ID.test(objectId) || mode === "160000") continue;
      const row = rows.get(objectId);
      if (!row || row.object_type !== "blob" || !Array.isArray(row.modes) || !row.modes.includes(mode)) return true;
      const content = canonicalBase64(row.content_base64, "object table content_base64");
      if (row.size !== content.length || row.content_sha256 !== createHash("sha256").update(content).digest("hex")) return true;
    }
  }
  return false;
}

/** Atomizes only an immutable, complete capture. */
export function atomizeCapturedReviewInput(capture, atomTargetBytes = ATOM_TARGET_BYTES) {
  if (!Number.isSafeInteger(atomTargetBytes) || atomTargetBytes <= 0) throw new TypeError("atom target bytes must be a positive safe integer");
  const state = inputState(capture);
  if (state.diagnostic) return mismatch(["partial_diagnostic_capture"], counts([], [], 0, []));
  if (state.malformed) return mismatch(["raw_patch_path_disagreement"], counts([], [], 0, []));
  const { records, sections } = state;
  const rows = objectRows(capture);
  const { sectionForRecord, recordForSection } = correlate(records, sections);
  const bases = [];
  for (let index = 0; index < records.length; index += 1) {
    const section = sections[sectionForRecord[index]];
    const payload = pathPayload(records[index], section, rows);
    bases.push({ payload, lineage_candidate: `p:${canonicalSha256({ kind: "path_event", raw_status: payload.raw_status, status_kind: payload.status_kind, content_kinds: payload.content_kinds, old_path_base64: payload.old_path_base64, new_path_base64: payload.new_path_base64 })}`, sort: [0, 0, 0, 0], rawRecordIndex: index, owners: [] });
    if (section) bases.push(...projectTextAtoms(records[index], section, sectionForRecord[index], atomTargetBytes));
  }
  const atoms = assignIdentities(bases);
  const rawRecordOwners = bases.filter((base) => base.rawRecordIndex !== undefined).map((base) => ({ raw_record_index: base.rawRecordIndex, atom_id: base.atom_id }));
  const changedLineOwners = bases.flatMap((base) => base.owners.map((line_key) => ({ line_key, atom_id: base.atom_id })));
  const result = { status: "complete", atoms, coverage: { raw_record_owners: rawRecordOwners, changed_line_owners: changedLineOwners } };
  return validateAtomization(result, capture, { records, sections, sectionForRecord, recordForSection, rows });
}

/** Verifies raw-record and changed-line ownership after atomization. */
export function validateAtomization(result, capture, suppliedState = undefined) {
  const state = suppliedState ?? inputState(capture);
  if (state.diagnostic) return mismatch(["partial_diagnostic_capture"], counts([], [], 0, []));
  if (state.malformed || result?.status !== "complete") return mismatch(["raw_patch_path_disagreement"], counts([], [], 0, []));
  const { records, sections } = state;
  const rows = state.rows ?? objectRows(capture);
  const { sectionForRecord, recordForSection } = state.sectionForRecord ? { sectionForRecord: state.sectionForRecord, recordForSection: state.recordForSection } : correlate(records, sections);
  const expectedLines = expectedChangedLineKeys(sections);
  const expectedLineSet = new Set(expectedLines);
  const rawOwners = Array.isArray(result.coverage?.raw_record_owners) ? result.coverage.raw_record_owners : [];
  const lineOwners = Array.isArray(result.coverage?.changed_line_owners) ? result.coverage.changed_line_owners : [];
  const atomsById = new Map(Array.isArray(result.atoms) ? result.atoms.map((atom) => [atom.atom_id, atom]) : []);
  const reasons = [];
  const rawCounts = new Map(rawOwners.map((owner) => [owner.raw_record_index, 0]));
  for (const owner of rawOwners) {
    const atom = atomsById.get(owner.atom_id);
    if (atom?.kind === "path_event") rawCounts.set(owner.raw_record_index, (rawCounts.get(owner.raw_record_index) ?? 0) + 1);
  }
  if (records.some((_, index) => (rawCounts.get(index) ?? 0) === 0) || rawOwners.some((owner) => atomsById.get(owner.atom_id)?.kind !== "path_event")) reasons.push("missing_path_owner");
  if ([...rawCounts.values()].some((value) => value > 1) || [...rawCounts.keys()].some((index) => !Number.isInteger(index) || index < 0 || index >= records.length)) reasons.push("duplicate_path_owner");
  const lineCounts = new Map(lineOwners.map((owner) => [owner.line_key, 0]));
  for (const owner of lineOwners) {
    const atom = atomsById.get(owner.atom_id);
    if (atom?.kind === "text") lineCounts.set(owner.line_key, (lineCounts.get(owner.line_key) ?? 0) + 1);
  }
  if (expectedLines.some((key) => (lineCounts.get(key) ?? 0) === 0) || lineOwners.some((owner) => atomsById.get(owner.atom_id)?.kind !== "text")) reasons.push("missing_changed_line_owner");
  if ([...lineCounts.values()].some((value) => value > 1) || [...lineCounts.keys()].some((key) => !expectedLineSet.has(key))) reasons.push("duplicate_changed_line_owner");
  if (records.some((_, index) => sectionForRecord ? sectionForRecord[index] === -1 : false) || recordForSection.some((index) => index === -1)) reasons.push("raw_patch_path_disagreement");
  try {
    if (modeObjectBlobDisagreement(records, rows)) reasons.push("mode_object_blob_disagreement");
  } catch { reasons.push("mode_object_blob_disagreement"); }
  if (records.some((record) => !Object.hasOwn(STATUS_KINDS, record.status))) reasons.push("unsupported_raw_status");
  const countValue = counts(records, result.atoms, expectedLines.length, lineOwners);
  return reasons.length === 0 ? result : mismatch(reasons, countValue);
}

const SHADOW_CONFIG_KEYS = Object.freeze([
  "schema_version", "benchmark_revision", "atom_target_bytes", "unit_target_bytes",
  "max_frontier_units", "max_shadow_artifact_bytes",
]);
const EXECUTION_PROFILE_KEYS = Object.freeze([
  "schema_version", "descriptors", "descriptor_content_hashes", "max_output_attempts",
]);
const MANIFEST_KEYS = Object.freeze([
  "schema_version", "status", "mode", "capture_hash", "benchmark_revision", "configuration",
  "execution_projection", "atoms", "units", "counts", "sizes", "manifest_hash",
]);
const MANIFEST_COUNT_KEYS = Object.freeze([
  "atoms", "path_events", "text_atoms", "oversized_atoms", "coalesced_units",
  "by_raw_status", "by_content_kind",
]);
const MANIFEST_SIZE_KEYS = Object.freeze(["atom_payload_bytes", "unit_payload_bytes"]);
const LOCAL_OUTPUT_KEYS = Object.freeze(["schema_version", "status", "mode", "capture", "manifest"]);
const COMPLETE_OUTPUT_KEYS = Object.freeze([
  "schema_version", "status", "capture_hash", "mode", "manifest_hash", "benchmark_revision",
  "configuration", "execution_projection", "objects", "atoms", "units", "counts", "sizes",
]);
const COMPACT_OUTPUT_KEYS = Object.freeze([
  "schema_version", "status", "mode", "capture_hash", "manifest_hash", "benchmark_revision",
  "counts", "sizes", "omitted",
]);

const FALLBACK_SHADOW_DIAGNOSTIC_MAX_BYTES = 4 * 1024 * 1024;
const DIAGNOSTIC_KEYS = Object.freeze([
  "schema_version", "status", "mode", "base_sha", "head_sha", "benchmark_revision",
  "capture_hash", "manifest_hash", "reason_codes", "diagnostic", "observed_lower_bounds",
  "counts", "sizes",
]);
const DIAGNOSTIC_STATUSES = new Set([
  "capture_capacity_exceeded", "capture_failed", "planner_failed", "atom_coverage_mismatch",
]);
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TRUNCATION_SUFFIX = "...[truncated]";

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new TypeError(`${label} keys are invalid`);
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer`);
  return value;
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a nonnegative safe integer`);
  return value;
}

function boundedString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) throw new TypeError(`${label} must be a nonempty bounded string`);
  return value;
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sortedObject(entries) {
  return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

function atomPayload(atom) {
  const {
    lineage_candidate, segment_ordinal, content_hash, atom_id, payload_bytes, oversized,
    ...payload
  } = atom;
  return payload;
}

function ownerPath(atom) {
  if (typeof atom?.owner_path_base64 !== "string") throw new TypeError("atom owner path must be base64");
  const bytes = Buffer.from(atom.owner_path_base64, "base64");
  if (bytes.toString("base64") !== atom.owner_path_base64) throw new TypeError("atom owner path must be canonical base64");
  return bytes;
}

function atomComparator(left, right) {
  const path = Buffer.compare(ownerPath(left), ownerPath(right));
  if (path !== 0) return path;
  const leftKind = left.kind === "path_event" ? 0 : 1;
  const rightKind = right.kind === "path_event" ? 0 : 1;
  if (leftKind !== rightKind) return leftKind - rightKind;
  if (leftKind === 1) {
    for (const key of ["old_start", "old_count", "new_start", "new_count", "segment_ordinal"]) {
      if (left[key] !== right[key]) return left[key] - right[key];
    }
  }
  return left.atom_id.localeCompare(right.atom_id);
}

function unitId(unitLineage, orderedAtomIds, coalescedFrom) {
  return canonicalSha256({
    unit_schema_version: 1,
    unit_lineage: unitLineage,
    ordered_atom_ids: orderedAtomIds,
    coalesced_from: coalescedFrom,
  });
}

function configuration(config) {
  exactKeys(config, SHADOW_CONFIG_KEYS, "shadow configuration");
  if (config.schema_version !== 1) throw new TypeError("shadow configuration schema_version must be 1");
  if (typeof config.benchmark_revision !== "string" || config.benchmark_revision.length > 256) throw new TypeError("benchmark_revision must be a bounded string");
  const atomTarget = positiveInteger(config.atom_target_bytes, "atom_target_bytes");
  const unitTarget = positiveInteger(config.unit_target_bytes, "unit_target_bytes");
  if (unitTarget < atomTarget) throw new TypeError("unit_target_bytes must not be less than atom_target_bytes");
  return {
    benchmark_revision: config.benchmark_revision,
    atom_target_bytes: atomTarget,
    unit_target_bytes: unitTarget,
    max_frontier_units: positiveInteger(config.max_frontier_units, "max_frontier_units"),
    max_shadow_artifact_bytes: positiveInteger(config.max_shadow_artifact_bytes, "max_shadow_artifact_bytes"),
  };
}

function executionProjection(profile, unitCount) {
  exactKeys(profile, EXECUTION_PROFILE_KEYS, "execution profile");
  if (profile.schema_version !== 1) throw new TypeError("execution profile schema_version must be 1");
  if (!Array.isArray(profile.descriptors) || profile.descriptors.length === 0 || profile.descriptors.some((value) => typeof value !== "string" || value.length === 0 || value.length > 256)) throw new TypeError("execution descriptors are invalid");
  if (!Array.isArray(profile.descriptor_content_hashes) || profile.descriptor_content_hashes.length !== profile.descriptors.length || profile.descriptor_content_hashes.some((value) => !SHA256.test(value))) throw new TypeError("execution descriptor hashes are invalid");
  const maxOutputAttempts = positiveInteger(profile.max_output_attempts, "max_output_attempts");
  return {
    descriptors: [...profile.descriptors],
    descriptor_content_hashes: [...profile.descriptor_content_hashes],
    max_output_attempts: maxOutputAttempts,
    projected_batches: unitCount,
    projected_model_calls: unitCount * profile.descriptors.length * maxOutputAttempts,
  };
}

function makeUnit({ lineage, atoms, coalescedFrom = [], oversized = atoms.some((atom) => atom.oversized) }) {
  const atomPayloadBytes = atoms.map((atom) => atom.payload_bytes);
  return {
    unit_id: unitId(lineage, atoms.map((atom) => atom.atom_id), coalescedFrom),
    unit_lineage: lineage,
    ordered_atom_ids: atoms.map((atom) => atom.atom_id),
    coalesced_from: coalescedFrom,
    atom_payload_bytes: atomPayloadBytes,
    oversized_atom_ids: atoms.filter((atom) => atom.oversized).map((atom) => atom.atom_id),
    unit_payload_bytes: atomPayloadBytes.reduce((total, value) => total + value, 0),
    atomic: atoms.length === 1,
    oversized,
  };
}

function packUnits(atoms, config) {
  const packed = [];
  let index = 0;
  while (index < atoms.length) {
    const path = ownerPath(atoms[index]);
    const pathHash = sha256Bytes(path);
    let ordinal = 0;
    let candidate = [];
    let candidateBytes = 0;
    while (index < atoms.length && Buffer.compare(path, ownerPath(atoms[index])) === 0) {
      const atom = atoms[index];
      if (candidate.length > 0 && candidateBytes + atom.payload_bytes > config.unit_target_bytes) {
        packed.push(makeUnit({ lineage: `root:path:${pathHash}:${ordinal}`, atoms: candidate }));
        ordinal += 1;
        candidate = [];
        candidateBytes = 0;
      }
      candidate.push(atom);
      candidateBytes += atom.payload_bytes;
      index += 1;
      if (candidate.length === 1 && (atom.oversized || candidateBytes > config.unit_target_bytes)) {
        packed.push(makeUnit({ lineage: `root:path:${pathHash}:${ordinal}`, atoms: candidate, oversized: atom.oversized || candidateBytes > config.unit_target_bytes }));
        ordinal += 1;
        candidate = [];
        candidateBytes = 0;
      }
    }
    if (candidate.length > 0) packed.push(makeUnit({ lineage: `root:path:${pathHash}:${ordinal}`, atoms: candidate }));
  }
  return packed;
}

function coalesceUnits(units, maxFrontierUnits) {
  const frontier = [...units];
  while (frontier.length > maxFrontierUnits) {
    let selected = -1;
    for (let index = 0; index < frontier.length - 1; index += 1) {
      if (frontier[index].oversized_atom_ids.length > 0 || frontier[index + 1].oversized_atom_ids.length > 0) continue;
      if (selected === -1 || frontier[index].unit_payload_bytes + frontier[index + 1].unit_payload_bytes < frontier[selected].unit_payload_bytes + frontier[selected + 1].unit_payload_bytes) selected = index;
    }
    if (selected === -1) throw new RangeError("frontier_capacity_limit");
    const left = frontier[selected];
    const right = frontier[selected + 1];
    const atomPayloadBytes = [...left.atom_payload_bytes, ...right.atom_payload_bytes];
    const lineage = `root:coalesced:${canonicalSha256([left.unit_lineage, right.unit_lineage])}`;
    const merged = {
      unit_id: unitId(lineage, [...left.ordered_atom_ids, ...right.ordered_atom_ids], [left.unit_lineage, right.unit_lineage]),
      unit_lineage: lineage,
      ordered_atom_ids: [...left.ordered_atom_ids, ...right.ordered_atom_ids],
      coalesced_from: [left.unit_lineage, right.unit_lineage],
      atom_payload_bytes: atomPayloadBytes,
      oversized_atom_ids: [...left.oversized_atom_ids, ...right.oversized_atom_ids],
      unit_payload_bytes: left.unit_payload_bytes + right.unit_payload_bytes,
      atomic: false,
      oversized: left.oversized || right.oversized,
    };
    frontier.splice(selected, 2, merged);
  }
  return frontier;
}

function validateExecutionProjection(projection, unitCount) {
  exactKeys(projection, ["descriptors", "descriptor_content_hashes", "max_output_attempts", "projected_batches", "projected_model_calls"], "manifest execution projection");
  if (!Array.isArray(projection.descriptors) || projection.descriptors.length === 0 || projection.descriptors.some((value) => typeof value !== "string" || value.length === 0 || value.length > 256)) throw new TypeError("manifest execution projection descriptors are invalid");
  if (!Array.isArray(projection.descriptor_content_hashes) || projection.descriptor_content_hashes.length !== projection.descriptors.length || projection.descriptor_content_hashes.some((value) => !SHA256.test(value))) throw new TypeError("manifest execution projection descriptor hashes are invalid");
  const attempts = positiveInteger(projection.max_output_attempts, "manifest max_output_attempts");
  if (!Number.isSafeInteger(unitCount) || unitCount < 0 || projection.projected_batches !== unitCount) throw new TypeError("manifest execution projection batches are invalid");
  const modelCalls = unitCount * projection.descriptors.length * attempts;
  if (!Number.isSafeInteger(modelCalls) || projection.projected_model_calls !== modelCalls) throw new TypeError("manifest execution projection model calls are invalid");
}

function validateUnit(unit) {
  exactKeys(unit, ["unit_id", "unit_lineage", "ordered_atom_ids", "coalesced_from", "atom_payload_bytes", "oversized_atom_ids", "unit_payload_bytes", "atomic", "oversized"], "manifest unit");
  if (!SHA256.test(unit.unit_id) || typeof unit.unit_lineage !== "string" || !Array.isArray(unit.ordered_atom_ids) || unit.ordered_atom_ids.length === 0 || !Array.isArray(unit.coalesced_from) || !Array.isArray(unit.atom_payload_bytes) || unit.atom_payload_bytes.length !== unit.ordered_atom_ids.length || unit.atom_payload_bytes.some((value) => !Number.isSafeInteger(value) || value < 0) || !Array.isArray(unit.oversized_atom_ids) || unit.oversized_atom_ids.some((id, index) => !unit.ordered_atom_ids.includes(id) || unit.oversized_atom_ids.indexOf(id) !== index) || !Number.isSafeInteger(unit.unit_payload_bytes) || unit.unit_payload_bytes < 0 || unit.atom_payload_bytes.reduce((total, value) => total + value, 0) !== unit.unit_payload_bytes || typeof unit.atomic !== "boolean" || typeof unit.oversized !== "boolean") throw new TypeError("manifest unit is invalid");
}

function validateManifest(manifest) {
  exactKeys(manifest, MANIFEST_KEYS, "manifest");
  if (manifest.schema_version !== 1 || manifest.status !== "complete" || manifest.mode !== "partition_shadow" || !SHA256.test(manifest.capture_hash) || !SHA256.test(manifest.manifest_hash)) throw new TypeError("manifest header is invalid");
  exactKeys(manifest.configuration, ["atom_target_bytes", "unit_target_bytes", "max_frontier_units", "max_shadow_artifact_bytes"], "manifest configuration");
  validateExecutionProjection(manifest.execution_projection, Array.isArray(manifest.units) ? manifest.units.length : -1);
  if (!Array.isArray(manifest.atoms) || !Array.isArray(manifest.units)) throw new TypeError("manifest arrays are invalid");
  exactKeys(manifest.counts, MANIFEST_COUNT_KEYS, "manifest counts");
  exactKeys(manifest.sizes, MANIFEST_SIZE_KEYS, "manifest sizes");
  for (const key of ["atoms", "path_events", "text_atoms", "oversized_atoms", "coalesced_units"]) nonnegativeInteger(manifest.counts[key], `manifest counts ${key}`);
  for (const key of ["by_raw_status", "by_content_kind"]) {
    if (manifest.counts[key] === null || typeof manifest.counts[key] !== "object" || Array.isArray(manifest.counts[key])) throw new TypeError(`manifest counts ${key} is invalid`);
    for (const value of Object.values(manifest.counts[key])) nonnegativeInteger(value, `manifest counts ${key}`);
  }
  for (const key of MANIFEST_SIZE_KEYS) nonnegativeInteger(manifest.sizes[key], `manifest sizes ${key}`);
  if (manifest.counts.atoms !== manifest.atoms.length
    || manifest.counts.path_events !== manifest.atoms.filter((atom) => atom.kind === "path_event").length
    || manifest.counts.text_atoms !== manifest.atoms.filter((atom) => atom.kind === "text").length
    || manifest.counts.oversized_atoms !== manifest.atoms.filter((atom) => atom.oversized).length
    || manifest.counts.coalesced_units !== manifest.units.filter((unit) => unit.coalesced_from.length > 0).length
    || manifest.sizes.atom_payload_bytes !== manifest.atoms.reduce((total, atom) => total + atom.payload_bytes, 0)
    || manifest.sizes.unit_payload_bytes !== manifest.units.reduce((total, unit) => total + unit.unit_payload_bytes, 0)) throw new TypeError("manifest metrics are invalid");
  for (const unit of manifest.units) validateUnit(unit);
  const core = { ...manifest };
  delete core.manifest_hash;
  if (manifest.manifest_hash !== canonicalSha256(core)) throw new TypeError("manifest hash is invalid");
  return manifest;
}

/** Builds the deterministic Stage 1 path-fallback shadow manifest. */
export function buildPathFallbackManifest({ capture, atomization, config, executionProfile }) {
  if (capture?.status !== "complete" || !SHA256.test(capture.capture_hash)) throw new TypeError("complete capture with capture_hash is required");
  if (atomization?.status !== "complete" || !Array.isArray(atomization.atoms)) throw new TypeError("complete atomization is required");
  const configValue = configuration(config);
  const atoms = atomization.atoms.map((atom) => {
    const payload = atomPayload(atom);
    if (!SHA256.test(atom.content_hash) || !/^a:[0-9a-f]{64}$/.test(atom.atom_id) || canonicalSha256(payload) !== atom.content_hash) throw new TypeError("atom identity is invalid");
    return { ...atom, oversized: atom.oversized === true, payload_bytes: Buffer.byteLength(canonicalJson(payload)) };
  }).sort(atomComparator);
  const units = coalesceUnits(packUnits(atoms, configValue), configValue.max_frontier_units);
  const countsValue = {
    atoms: atoms.length,
    path_events: atoms.filter((atom) => atom.kind === "path_event").length,
    text_atoms: atoms.filter((atom) => atom.kind === "text").length,
    oversized_atoms: atoms.filter((atom) => atom.oversized).length,
    coalesced_units: units.filter((unit) => unit.coalesced_from.length > 0).length,
    by_raw_status: sortedObject(atoms.filter((atom) => atom.kind === "path_event").map((atom) => [atom.raw_status, 1]).reduce((entries, [key, value]) => entries.set(key, (entries.get(key) ?? 0) + value), new Map())),
    by_content_kind: sortedObject(atoms.filter((atom) => atom.kind === "path_event").flatMap((atom) => atom.content_kinds).map((kind) => [kind, 1]).reduce((entries, [key, value]) => entries.set(key, (entries.get(key) ?? 0) + value), new Map())),
  };
  const manifestCore = {
    schema_version: 1,
    status: "complete",
    mode: "partition_shadow",
    capture_hash: capture.capture_hash,
    benchmark_revision: configValue.benchmark_revision,
    configuration: {
      atom_target_bytes: configValue.atom_target_bytes,
      unit_target_bytes: configValue.unit_target_bytes,
      max_frontier_units: configValue.max_frontier_units,
      max_shadow_artifact_bytes: configValue.max_shadow_artifact_bytes,
    },
    execution_projection: executionProjection(executionProfile, units.length),
    atoms,
    units,
    counts: countsValue,
    sizes: {
      atom_payload_bytes: atoms.reduce((total, atom) => total + atom.payload_bytes, 0),
      unit_payload_bytes: units.reduce((total, unit) => total + unit.unit_payload_bytes, 0),
    },
  };
  return validateManifest({ ...manifestCore, manifest_hash: canonicalSha256(manifestCore) });
}

function withEncodedOutputSize(output) {
  const sized = { ...output, sizes: { ...output.sizes, encoded_output_bytes: 0 } };
  for (;;) {
    const encodedLength = Buffer.byteLength(`${canonicalJson(sized)}\n`);
    if (sized.sizes.encoded_output_bytes === encodedLength) return sized;
    sized.sizes.encoded_output_bytes = encodedLength;
  }
}

function requireOutputWithinCap(output, maxBytes) {
  if (output.sizes.encoded_output_bytes > maxBytes) throw new RangeError("shadow output exceeds maxBytes");
  return output;
}

function redactedObjects(capture) {
  return [...(capture.object_table ?? [])]
    .map(({ object_id, object_type, modes, size, content_sha256 }) => ({ object_id, object_type, modes: [...modes], size, content_sha256 }))
    .sort((left, right) => left.object_id.localeCompare(right.object_id));
}

function redactedAtoms(atoms) {
  return atoms.map((atom) => ({
    atom_id: atom.atom_id,
    kind: atom.kind,
    lineage_candidate: atom.lineage_candidate,
    segment_ordinal: atom.segment_ordinal,
    content_hash: atom.content_hash,
    owner_path_base64: atom.owner_path_base64,
    payload_bytes: atom.payload_bytes,
    oversized: atom.oversized,
    status_kind: atom.kind === "path_event" ? atom.status_kind : null,
    content_kinds: atom.kind === "path_event" ? [...atom.content_kinds] : [],
  }));
}

/** Returns the local-only complete capture and manifest envelope. */
export function buildLocalShadowOutput(capture, manifest) {
  validateManifest(manifest);
  if (capture?.status !== "complete" || capture.capture_hash !== manifest.capture_hash) throw new TypeError("local output capture does not match manifest");
  return { schema_version: 1, status: "complete", mode: "partition_shadow", capture, manifest };
}

/** Returns a source-redacted hosted complete or compacted shadow artifact. */
export function buildHostedShadowOutput(capture, manifest, maxBytes) {
  validateManifest(manifest);
  positiveInteger(maxBytes, "maxBytes");
  if (capture?.status !== "complete" || capture.capture_hash !== manifest.capture_hash) throw new TypeError("hosted output capture does not match manifest");
  const complete = withEncodedOutputSize({
    schema_version: 1,
    status: "complete",
    capture_hash: manifest.capture_hash,
    mode: "partition_shadow",
    manifest_hash: manifest.manifest_hash,
    benchmark_revision: manifest.benchmark_revision,
    configuration: manifest.configuration,
    execution_projection: manifest.execution_projection,
    objects: redactedObjects(capture),
    atoms: redactedAtoms(manifest.atoms),
    units: manifest.units.map((unit) => ({ ...unit })),
    counts: manifest.counts,
    sizes: { atom_payload_bytes: manifest.sizes.atom_payload_bytes, unit_payload_bytes: manifest.sizes.unit_payload_bytes },
  });
  exactKeys(complete, COMPLETE_OUTPUT_KEYS, "hosted complete output");
  if (complete.sizes.encoded_output_bytes <= maxBytes) return complete;
  const compacted = withEncodedOutputSize({
    schema_version: 1,
    status: "artifact_compacted",
    mode: "partition_shadow",
    capture_hash: manifest.capture_hash,
    manifest_hash: manifest.manifest_hash,
    benchmark_revision: manifest.benchmark_revision,
    counts: manifest.counts,
    sizes: {},
    omitted: ["atoms", "units"],
  });
  exactKeys(compacted, COMPACT_OUTPUT_KEYS, "hosted compact output");
  return requireOutputWithinCap(compacted, maxBytes);
}

function truncateDiagnostic(value) {
  const bytes = Buffer.from(String(value), "utf8");
  if (bytes.length <= 512) return bytes.toString("utf8");
  const maximum = 512 - Buffer.byteLength(TRUNCATION_SUFFIX);
  let prefix = bytes.subarray(0, maximum).toString("utf8");
  while (Buffer.byteLength(prefix) > maximum) prefix = prefix.slice(0, -1);
  return `${prefix}${TRUNCATION_SUFFIX}`;
}

/** Builds a source-redacted, bounded diagnostic envelope. */
export function buildShadowDiagnostic(details, maxBytes) {
  positiveInteger(maxBytes, "maxBytes");
  if (details === null || typeof details !== "object" || !DIAGNOSTIC_STATUSES.has(details.status)) throw new TypeError("shadow diagnostic status is invalid");
  const captureHash = details.capture_hash ?? details.capture?.capture_hash ?? null;
  const manifestHash = details.manifest_hash ?? details.manifest?.manifest_hash ?? null;
  if (captureHash !== null && !SHA256.test(captureHash)) throw new TypeError("diagnostic capture hash is invalid");
  if (manifestHash !== null && !SHA256.test(manifestHash)) throw new TypeError("diagnostic manifest hash is invalid");
  if ((details.status === "capture_capacity_exceeded" || details.status === "capture_failed") && (captureHash !== null || manifestHash !== null)) throw new TypeError("capture diagnostics cannot have hashes");
  if ((details.status === "atom_coverage_mismatch" || details.status === "planner_failed") && captureHash === null) throw new TypeError("complete-capture diagnostics require capture hash");
  if (details.status === "atom_coverage_mismatch" && manifestHash !== null) throw new TypeError("atom diagnostics have invalid hashes");
  const observed = details.observed_lower_bounds ?? {};
  exactKeys(observed, ["patch_bytes", "raw_z_bytes", "blob_bytes", "blob_count", "elapsed_milliseconds"], "observed lower bounds");
  for (const [key, value] of Object.entries(observed)) nonnegativeInteger(value, key);
  const diagnostic = withEncodedOutputSize({
    schema_version: 1,
    status: details.status,
    mode: "partition_shadow",
    base_sha: details.base_sha ?? details.capture?.base_sha ?? "",
    head_sha: details.head_sha ?? details.capture?.head_sha ?? "",
    benchmark_revision: details.benchmark_revision ?? details.manifest?.benchmark_revision ?? "",
    capture_hash: captureHash,
    manifest_hash: manifestHash,
    reason_codes: [...new Set(details.reason_codes ?? [])].sort(),
    diagnostic: truncateDiagnostic(details.diagnostic ?? ""),
    observed_lower_bounds: observed,
    counts: details.counts ?? {},
    sizes: {},
  });
  exactKeys(diagnostic, DIAGNOSTIC_KEYS, "shadow diagnostic");
  if (!GIT_ID.test(diagnostic.base_sha) || !GIT_ID.test(diagnostic.head_sha) || typeof diagnostic.benchmark_revision !== "string" || diagnostic.benchmark_revision.length > 256 || diagnostic.reason_codes.some((reason) => typeof reason !== "string" || reason.length === 0)) throw new TypeError("shadow diagnostic fields are invalid");
  return requireOutputWithinCap(diagnostic, maxBytes);
}

function validateManifestConfiguration(value) {
  exactKeys(value, ["atom_target_bytes", "unit_target_bytes", "max_frontier_units", "max_shadow_artifact_bytes"], "manifest configuration");
  const atomTarget = positiveInteger(value.atom_target_bytes, "manifest atom_target_bytes");
  if (positiveInteger(value.unit_target_bytes, "manifest unit_target_bytes") < atomTarget) throw new TypeError("manifest unit target is invalid");
  positiveInteger(value.max_frontier_units, "manifest max_frontier_units");
  positiveInteger(value.max_shadow_artifact_bytes, "manifest max_shadow_artifact_bytes");
}

function validateOutputEncodedSize(value, maxBytes, sizeKeys = ["encoded_output_bytes"]) {
  positiveInteger(maxBytes, "maxBytes");
  exactKeys(value.sizes, sizeKeys, "output sizes");
  const encodedBytes = Buffer.byteLength(`${canonicalJson(value)}\n`);
  if (value.sizes.encoded_output_bytes !== encodedBytes) throw new TypeError("output encoded byte size is invalid");
  requireOutputWithinCap(value, maxBytes);
}

function validateDiagnosticOutput(value, maxBytes) {
  exactKeys(value, DIAGNOSTIC_KEYS, "shadow diagnostic");
  if (value.schema_version !== 1 || !DIAGNOSTIC_STATUSES.has(value.status) || value.mode !== "partition_shadow") throw new TypeError("shadow diagnostic header is invalid");
  if (!GIT_ID.test(value.base_sha) || !GIT_ID.test(value.head_sha) || typeof value.benchmark_revision !== "string" || value.benchmark_revision.length > 256) throw new TypeError("shadow diagnostic fields are invalid");
  if (value.capture_hash !== null && !SHA256.test(value.capture_hash)) throw new TypeError("diagnostic capture hash is invalid");
  if (value.manifest_hash !== null && !SHA256.test(value.manifest_hash)) throw new TypeError("diagnostic manifest hash is invalid");
  if ((value.status === "capture_capacity_exceeded" || value.status === "capture_failed") && (value.capture_hash !== null || value.manifest_hash !== null)) throw new TypeError("capture diagnostics cannot have hashes");
  if ((value.status === "atom_coverage_mismatch" || value.status === "planner_failed") && value.capture_hash === null) throw new TypeError("complete-capture diagnostics require capture hash");
  if (value.status === "atom_coverage_mismatch" && value.manifest_hash !== null) throw new TypeError("atom diagnostics have invalid hashes");
  if (!Array.isArray(value.reason_codes) || value.reason_codes.some((reason, index) => typeof reason !== "string" || reason.length === 0 || reason.length > 256 || (index > 0 && value.reason_codes[index - 1] >= reason))) throw new TypeError("diagnostic reason codes are invalid");
  if (typeof value.diagnostic !== "string" || Buffer.byteLength(value.diagnostic) > 512 || value.counts === null || typeof value.counts !== "object" || Array.isArray(value.counts)) throw new TypeError("shadow diagnostic payload is invalid");
  exactKeys(value.observed_lower_bounds, ["patch_bytes", "raw_z_bytes", "blob_bytes", "blob_count", "elapsed_milliseconds"], "observed lower bounds");
  for (const [key, metric] of Object.entries(value.observed_lower_bounds)) nonnegativeInteger(metric, key);
  validateOutputEncodedSize(value, maxBytes);
}

function validateHostedCompleteOutput(value, maxBytes) {
  exactKeys(value, COMPLETE_OUTPUT_KEYS, "hosted complete output");
  if (value.schema_version !== 1 || value.status !== "complete" || value.mode !== "partition_shadow" || !SHA256.test(value.capture_hash) || !SHA256.test(value.manifest_hash) || typeof value.benchmark_revision !== "string" || value.benchmark_revision.length > 256) throw new TypeError("hosted complete output header is invalid");
  validateManifestConfiguration(value.configuration);
  if (!Array.isArray(value.objects) || !Array.isArray(value.atoms) || !Array.isArray(value.units)) throw new TypeError("hosted complete output arrays are invalid");
  validateExecutionProjection(value.execution_projection, value.units.length);
  for (const object of value.objects) {
    exactKeys(object, ["object_id", "object_type", "modes", "size", "content_sha256"], "hosted object");
    if (!GIT_ID.test(object.object_id) || typeof object.object_type !== "string" || !Array.isArray(object.modes) || object.modes.some((mode) => typeof mode !== "string") || !Number.isSafeInteger(object.size) || object.size < 0 || !SHA256.test(object.content_sha256)) throw new TypeError("hosted object is invalid");
  }
  for (const atom of value.atoms) {
    exactKeys(atom, ["atom_id", "kind", "lineage_candidate", "segment_ordinal", "content_hash", "owner_path_base64", "payload_bytes", "oversized", "status_kind", "content_kinds"], "hosted atom");
    if (!/^a:[0-9a-f]{64}$/.test(atom.atom_id) || !["path_event", "text"].includes(atom.kind) || typeof atom.lineage_candidate !== "string" || !Number.isSafeInteger(atom.segment_ordinal) || atom.segment_ordinal < 0 || !SHA256.test(atom.content_hash) || !Number.isSafeInteger(atom.payload_bytes) || atom.payload_bytes < 0 || typeof atom.oversized !== "boolean" || !Array.isArray(atom.content_kinds)) throw new TypeError("hosted atom is invalid");
  }
  for (const unit of value.units) validateUnit(unit);
  exactKeys(value.counts, MANIFEST_COUNT_KEYS, "manifest counts");
  exactKeys(value.sizes, [...MANIFEST_SIZE_KEYS, "encoded_output_bytes"], "output sizes");
  if (value.counts.atoms !== value.atoms.length || value.sizes.atom_payload_bytes !== value.atoms.reduce((total, atom) => total + atom.payload_bytes, 0) || value.sizes.unit_payload_bytes !== value.units.reduce((total, unit) => total + unit.unit_payload_bytes, 0)) throw new TypeError("hosted complete output metrics are invalid");
  validateOutputEncodedSize(value, maxBytes, [...MANIFEST_SIZE_KEYS, "encoded_output_bytes"]);
}

/** Validates canonical local, hosted, compacted, and diagnostic shadow output. */
export function validateShadowOutput(value, maxBytes, trustedInputs = undefined) {
  positiveInteger(maxBytes, "maxBytes");
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("shadow output must be an object");
  if (value.status === "complete" && Object.hasOwn(value, "capture")) {
    exactKeys(value, LOCAL_OUTPUT_KEYS, "local shadow output");
    if (value.schema_version !== 1 || value.mode !== "partition_shadow") throw new TypeError("local shadow output header is invalid");
    validateCapturedReviewInput(value.capture);
    validateManifest(value.manifest);
    if (value.capture.status !== "complete" || value.capture.capture_hash !== value.manifest.capture_hash) throw new TypeError("local output capture does not match manifest");
    const trustedConfig = trustedInputs?.config ?? {
      schema_version: 1,
      benchmark_revision: value.manifest.benchmark_revision,
      ...value.manifest.configuration,
    };
    const trustedProfile = trustedInputs?.profile ?? {
      schema_version: 1,
      descriptors: value.manifest.execution_projection.descriptors,
      descriptor_content_hashes: value.manifest.execution_projection.descriptor_content_hashes,
      max_output_attempts: value.manifest.execution_projection.max_output_attempts,
    };
    const trustedConfiguration = configuration(trustedConfig);
    const trustedProjection = executionProjection(trustedProfile, value.manifest.units.length);
    if (trustedInputs !== undefined && (
      value.manifest.benchmark_revision !== trustedConfiguration.benchmark_revision
      || canonicalJson(value.manifest.configuration) !== canonicalJson({
        atom_target_bytes: trustedConfiguration.atom_target_bytes,
        unit_target_bytes: trustedConfiguration.unit_target_bytes,
        max_frontier_units: trustedConfiguration.max_frontier_units,
        max_shadow_artifact_bytes: trustedConfiguration.max_shadow_artifact_bytes,
      })
      || canonicalJson(value.manifest.execution_projection) !== canonicalJson(trustedProjection)
    )) throw new TypeError("local output manifest does not match trusted inputs");
    const atomization = atomizeCapturedReviewInput(value.capture, trustedConfiguration.atom_target_bytes);
    if (atomization.status !== "complete") throw new TypeError("local output manifest does not match capture");
    const reconstructed = buildPathFallbackManifest({
      capture: value.capture,
      atomization,
      config: trustedConfig,
      executionProfile: trustedProfile,
    });
    if (canonicalJson(reconstructed) !== canonicalJson(value.manifest)) throw new TypeError("local output manifest does not match capture");
    if (Buffer.byteLength(`${canonicalJson(value)}\n`) > maxBytes) throw new RangeError("shadow output exceeds maxBytes");
    return value;
  }
  if (value.status === "complete") {
    validateHostedCompleteOutput(value, maxBytes);
    return value;
  }
  if (value.status === "artifact_compacted") {
    exactKeys(value, COMPACT_OUTPUT_KEYS, "hosted compact output");
    if (value.schema_version !== 1 || value.mode !== "partition_shadow" || !SHA256.test(value.capture_hash) || !SHA256.test(value.manifest_hash) || typeof value.benchmark_revision !== "string" || value.benchmark_revision.length > 256 || !Array.isArray(value.omitted) || canonicalJson(value.omitted) !== canonicalJson(["atoms", "units"])) throw new TypeError("hosted compact output is invalid");
    exactKeys(value.counts, MANIFEST_COUNT_KEYS, "manifest counts");
    validateOutputEncodedSize(value, maxBytes);
    return value;
  }
  if (DIAGNOSTIC_STATUSES.has(value.status)) {
    validateDiagnosticOutput(value, maxBytes);
    return value;
  }
  throw new TypeError("shadow output status is invalid");
}
/** Splits a non-atomic unit at its byte-balanced deterministic boundary. */
export function splitUnit(unit) {
  if (unit?.atomic || !Array.isArray(unit?.ordered_atom_ids) || unit.ordered_atom_ids.length < 2) throw new TypeError("atomic unit cannot be split");
  const payloadBytes = unit.atom_payload_bytes;
  if (!Array.isArray(payloadBytes) || payloadBytes.length !== unit.ordered_atom_ids.length || payloadBytes.some((value) => !Number.isSafeInteger(value) || value < 0) || payloadBytes.reduce((total, value) => total + value, 0) !== unit.unit_payload_bytes) throw new TypeError("unit atom payload bytes are required for splitting");
  let best = 1;
  let prefix = payloadBytes[0];
  let difference = Math.abs(prefix - (unit.unit_payload_bytes - prefix));
  for (let index = 1; index < payloadBytes.length - 1; index += 1) {
    prefix += payloadBytes[index];
    const candidate = Math.abs(prefix - (unit.unit_payload_bytes - prefix));
    if (candidate < difference) {
      best = index + 1;
      difference = candidate;
    }
  }
  const child = (suffix, ids, bytes) => {
    const oversizedAtomIds = (unit.oversized_atom_ids ?? []).filter((atomId) => ids.includes(atomId));
    return {
      unit_id: unitId(`${unit.unit_lineage}/${suffix}`, ids, []),
      unit_lineage: `${unit.unit_lineage}/${suffix}`,
      ordered_atom_ids: ids,
      coalesced_from: [],
      atom_payload_bytes: bytes,
      oversized_atom_ids: oversizedAtomIds,
      unit_payload_bytes: bytes.reduce((total, value) => total + value, 0),
      atomic: ids.length === 1,
      oversized: oversizedAtomIds.length > 0,
    };
  };
  return [
    child(0, unit.ordered_atom_ids.slice(0, best), payloadBytes.slice(0, best)),
    child(1, unit.ordered_atom_ids.slice(best), payloadBytes.slice(best)),
  ];
}

/** Validates the versioned literal evaluator fixture. */
export function validatePartitionShadowEvaluatorFixture(value) {
  exactKeys(value, ["schema_version", "benchmark_revision", "repository_fixture", "capture_hash", "expected"], "evaluator fixture");
  if (value.schema_version !== 1 || !SHA256.test(value.capture_hash)) throw new TypeError("evaluator fixture header is invalid");
  boundedString(value.benchmark_revision, "benchmark_revision");
  boundedString(value.repository_fixture, "repository_fixture");
  exactKeys(value.expected, ["atom_counts", "unit_count", "oversized_atoms", "coalesced_units", "projected_batches", "projected_model_calls"], "evaluator expected");
  exactKeys(value.expected.atom_counts, ["path_events", "text_atoms"], "evaluator atom counts");
  for (const [key, metric] of Object.entries(value.expected.atom_counts)) nonnegativeInteger(metric, key);
  for (const [key, metric] of Object.entries(value.expected)) if (key !== "atom_counts") nonnegativeInteger(metric, key);
  if (value.expected.unit_count === 0 || value.expected.projected_batches === 0 || value.expected.projected_model_calls === 0) throw new TypeError("evaluator expected positive metrics are invalid");
  return value;
}

export function writeShadowOutput(path, value, random = randomUUID) {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new TypeError("output path must not be a symlink");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = join(dirname(path), `.review-units-${random()}.tmp`);
  try {
    writeFileSync(temporary, `${canonicalJson(value)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

function shadowUsage() {
  return "usage: node scripts/review-units.mjs shadow --capture CAPTURE_JSON --profile PROFILE_JSON --config CONFIG_JSON [--local-out LOCAL_JSON] [--diagnostics-out DIAGNOSTIC_JSON]\n";
}

function parseShadowArgs(argv) {
  if (argv[0] !== "shadow") throw new TypeError(shadowUsage());
  const options = {};
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!["--capture", "--profile", "--config", "--local-out", "--diagnostics-out"].includes(key) || !value || Object.hasOwn(options, key)) throw new TypeError(shadowUsage());
    options[key] = value;
  }
  if (!options["--capture"] || !options["--profile"] || !options["--config"]) throw new TypeError(shadowUsage());
  return options;
}

function shadowDiagnosticFromCapture(capture, benchmarkRevision, maxBytes) {
  return buildShadowDiagnostic({
    status: capture.status,
    base_sha: capture.base_sha,
    head_sha: capture.head_sha,
    benchmark_revision: benchmarkRevision,
    reason_codes: [capture.capacity_reason ?? "process_error"],
    diagnostic: "Shadow capture did not complete.",
    observed_lower_bounds: capture.observed_lower_bounds,
    counts: {},
  }, maxBytes);
}

function invalidCaptureDiagnostic(capture, benchmarkRevision, maxBytes, error) {
  const safeId = (value) => typeof value === "string" && GIT_ID.test(value) ? value : "0".repeat(40);
  return buildShadowDiagnostic({
    status: "capture_failed",
    base_sha: safeId(capture?.base_sha),
    head_sha: safeId(capture?.head_sha),
    benchmark_revision: typeof benchmarkRevision === "string" && benchmarkRevision.length <= 256 ? benchmarkRevision : "",
    capture_hash: null,
    manifest_hash: null,
    reason_codes: ["capture_validation_failed"],
    diagnostic: error instanceof Error ? error.message : "Capture validation failed.",
    observed_lower_bounds: { patch_bytes: 0, raw_z_bytes: 0, blob_bytes: 0, blob_count: 0, elapsed_milliseconds: 0 },
    counts: {},
  }, maxBytes);
}

function plannerFailureDiagnostic(capture, benchmarkRevision, maxBytes, error) {
  return buildShadowDiagnostic({
    status: "planner_failed",
    capture,
    benchmark_revision: benchmarkRevision,
    reason_codes: [error.message === "frontier_capacity_limit" ? "frontier_capacity_limit" : "planner_error"],
    diagnostic: error.message,
    observed_lower_bounds: { patch_bytes: 0, raw_z_bytes: 0, blob_bytes: 0, blob_count: 0, elapsed_milliseconds: 0 },
    counts: {},
  }, maxBytes);
}

function writeDiagnosticOutputs(options, diagnostic) {
  if (options["--local-out"]) writeShadowOutput(options["--local-out"], diagnostic);
  if (options["--diagnostics-out"]) writeShadowOutput(options["--diagnostics-out"], diagnostic);
}

function validateOutputUsage() {
  return "usage: node scripts/review-units.mjs validate-output --input OUTPUT_JSON --max-bytes MAX_BYTES [--profile PROFILE_JSON --config CONFIG_JSON]\n";
}

function validateOutputMain(argv) {
  if (argv[0] !== "validate-output") {
    process.stderr.write(validateOutputUsage());
    return 2;
  }
  const options = {};
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const entry = argv[index + 1];
    if (!["--input", "--max-bytes", "--profile", "--config"].includes(key) || !entry || Object.hasOwn(options, key)) {
      process.stderr.write(validateOutputUsage());
      return 2;
    }
    options[key] = entry;
  }
  if (!options["--input"] || !options["--max-bytes"]) {
    process.stderr.write(validateOutputUsage());
    return 2;
  }
  try {
    const maxBytes = Number(options["--max-bytes"]);
    if (!/^[1-9]\d*$/.test(options["--max-bytes"]) || !Number.isSafeInteger(maxBytes)) throw new TypeError("maxBytes must be a positive safe integer");
    const bytes = readFileSync(options["--input"]);
    const value = JSON.parse(bytes.toString("utf8"));
    const localOutput = value?.status === "complete" && Object.hasOwn(value, "capture");
    if (localOutput && (!options["--profile"] || !options["--config"])) throw new TypeError("local shadow output requires trusted profile and config");
    const trustedInputs = localOutput ? {
      config: JSON.parse(readFileSync(options["--config"], "utf8")),
      profile: JSON.parse(readFileSync(options["--profile"], "utf8")),
    } : undefined;
    validateShadowOutput(value, maxBytes, trustedInputs);
    if (!bytes.equals(Buffer.from(`${canonicalJson(value)}\n`))) throw new TypeError("shadow output is not canonically encoded");
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

function main(argv) {
  if (argv[0] === "validate-output") return validateOutputMain(argv);
  let options;
  try {
    options = parseShadowArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  try {
    let capture;
    try {
      capture = JSON.parse(readFileSync(options["--capture"], "utf8"));
    } catch (error) {
      writeDiagnosticOutputs(options, invalidCaptureDiagnostic(undefined, "", FALLBACK_SHADOW_DIAGNOSTIC_MAX_BYTES, error));
      return 0;
    }
    let config;
    let configValue;
    try {
      config = JSON.parse(readFileSync(options["--config"], "utf8"));
      configValue = configuration(config);
    } catch (error) {
      try {
        validateCapturedReviewInput(capture);
      } catch (captureError) {
        writeDiagnosticOutputs(options, invalidCaptureDiagnostic(capture, "", FALLBACK_SHADOW_DIAGNOSTIC_MAX_BYTES, captureError));
        return 0;
      }
      if (capture.status !== "complete") {
        writeDiagnosticOutputs(options, shadowDiagnosticFromCapture(capture, "", FALLBACK_SHADOW_DIAGNOSTIC_MAX_BYTES));
        return 0;
      }
      writeDiagnosticOutputs(options, plannerFailureDiagnostic(capture, "", FALLBACK_SHADOW_DIAGNOSTIC_MAX_BYTES, error));
      return 0;
    }
    try {
      validateCapturedReviewInput(capture);
    } catch (error) {
      writeDiagnosticOutputs(options, invalidCaptureDiagnostic(capture, configValue.benchmark_revision, configValue.max_shadow_artifact_bytes, error));
      return 0;
    }
    if (capture.status !== "complete") {
      writeDiagnosticOutputs(options, shadowDiagnosticFromCapture(capture, configValue.benchmark_revision, configValue.max_shadow_artifact_bytes));
      return 0;
    }
    const diagnostic = (() => {
      try {
        const profile = JSON.parse(readFileSync(options["--profile"], "utf8"));
        const atomization = atomizeCapturedReviewInput(capture, configValue.atom_target_bytes);
        if (atomization.status !== "complete") return buildShadowDiagnostic({
          status: "atom_coverage_mismatch", capture, benchmark_revision: configValue.benchmark_revision,
          reason_codes: atomization.reasons, diagnostic: "Shadow atom coverage did not match capture.",
          observed_lower_bounds: { patch_bytes: 0, raw_z_bytes: 0, blob_bytes: 0, blob_count: 0, elapsed_milliseconds: 0 },
          counts: atomization.counts,
        }, configValue.max_shadow_artifact_bytes);
        const manifest = buildPathFallbackManifest({ capture, atomization, config, executionProfile: profile });
        if (options["--local-out"]) writeShadowOutput(options["--local-out"], buildLocalShadowOutput(capture, manifest));
        if (options["--diagnostics-out"]) writeShadowOutput(options["--diagnostics-out"], buildHostedShadowOutput(capture, manifest, configValue.max_shadow_artifact_bytes));
        return null;
      } catch (error) {
        return plannerFailureDiagnostic(capture, configValue.benchmark_revision, configValue.max_shadow_artifact_bytes, error);
      }
    })();
    if (diagnostic !== null) writeDiagnosticOutputs(options, diagnostic);
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
