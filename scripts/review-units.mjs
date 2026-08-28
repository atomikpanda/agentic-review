import { createHash } from "node:crypto";

import { canonicalJson, canonicalSha256 } from "./lib-canonical-json.mjs";

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
    if (!match || !Object.hasOwn(RAW_STATUS_PATH_COUNT, match[1])) {
      throw new TypeError("raw diff metadata has an unknown status");
    }
    const [, status, similarityText] = match;
    if ((status === "R" || status === "C") !== (similarityText !== undefined)) {
      throw new TypeError("raw diff rename/copy status must include similarity");
    }
    if (similarityText !== undefined && Number(similarityText) > 100) {
      throw new TypeError("raw diff similarity must not exceed 100");
    }
    const pathCount = RAW_STATUS_PATH_COUNT[status];
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

function samePath(left, right) {
  return left === null || right === null ? left === right : Buffer.compare(left, right) === 0;
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
  let offset = 0;
  const finishHunk = () => { hunk = undefined; lastChanged = undefined; };
  const startSection = (line) => {
    finishHunk();
    const [oldHeader, newHeader] = gitTokens(line.subarray(Buffer.byteLength("diff --git ")));
    section = { oldPath: removeDiffPrefix(oldHeader, "a"), newPath: removeDiffPrefix(newHeader, "b"), headerOldPath: removeDiffPrefix(oldHeader, "a"), headerNewPath: removeDiffPrefix(newHeader, "b"), hunks: [], binary: false };
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
      const range = parseHunkHeader(line);
      hunk = { ...range, events: [], blocks: [], currentBlock: undefined, oldCursor: range.oldStart, newCursor: range.newStart, oldLineIndex: 0, newLineIndex: 0, index: section.hunks.length };
      section.hunks.push(hunk);
      lastChanged = undefined;
      continue;
    }
    if (line.equals(Buffer.from("\\ No newline at end of file"))) {
      if (lastChanged) lastChanged.line.terminator = "none";
      continue;
    }
    if (line.subarray(0, Buffer.byteLength("Binary files ")).equals(Buffer.from("Binary files ")) || line.equals(Buffer.from("GIT binary patch"))) section.binary = true;
    if (!hunk) continue;
    const marker = line[0];
    if (marker === 0x20) {
      hunk.oldCursor += 1;
      hunk.newCursor += 1;
      hunk.currentBlock = undefined;
      lastChanged = undefined;
    } else if (marker === 0x2d || marker === 0x2b) {
      const side = marker === 0x2d ? "old" : "new";
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
    }
  }
  return sections;
}

function patchMatchesRecord(section, record) {
  if (record.oldPath === null) return samePath(section.newPath, record.newPath) || samePath(section.headerNewPath, record.newPath);
  if (record.newPath === null) return samePath(section.oldPath, record.oldPath) || samePath(section.headerOldPath, record.oldPath);
  return (samePath(section.oldPath, record.oldPath) && samePath(section.newPath, record.newPath))
    || (samePath(section.headerOldPath, record.oldPath) && samePath(section.headerNewPath, record.newPath));
}

function correlate(records, sections) {
  const sectionForRecord = new Array(records.length).fill(-1);
  const recordForSection = new Array(sections.length).fill(-1);
  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    const sectionIndex = sections.findIndex((section, index) => recordForSection[index] === -1 && patchMatchesRecord(section, records[recordIndex]));
    if (sectionIndex !== -1) {
      sectionForRecord[recordIndex] = sectionIndex;
      recordForSection[sectionIndex] = recordIndex;
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

function textPayload(record, oldStart, newStart, oldLines, newLines, oversized) {
  return {
    kind: "text", owner_path_base64: (record.newPath ?? record.oldPath).toString("base64"), old_path_base64: record.oldPath?.toString("base64") ?? null, new_path_base64: record.newPath?.toString("base64") ?? null,
    old_start: oldStart, old_count: oldLines.length, new_start: newStart, new_count: newLines.length,
    old_lines: oldLines, new_lines: newLines,
    old_final_newline: oldLines.every((line) => line.terminator === "lf"), new_final_newline: newLines.every((line) => line.terminator === "lf"), oversized,
  };
}

function textLineage(payload) {
  return `t:${canonicalSha256({ kind: "text", old_path_base64: payload.old_path_base64, new_path_base64: payload.new_path_base64, old_start: payload.old_start, old_count: payload.old_count, new_start: payload.new_start, new_count: payload.new_count })}`;
}

function projectTextAtoms(record, section, sectionIndex) {
  const atoms = [];
  for (const hunk of section.hunks) {
    for (const block of hunk.blocks) {
      let oldCursor = block[0].oldBefore;
      let newCursor = block[0].newBefore;
      let candidate;
      const start = () => ({ oldStart: oldCursor, newStart: newCursor, oldLines: [], newLines: [], owners: [] });
      const finish = () => {
        if (!candidate || candidate.owners.length === 0) return;
        const payload = textPayload(record, candidate.oldStart, candidate.newStart, candidate.oldLines, candidate.newLines, candidate.oversized ?? false);
        atoms.push({ payload, lineage_candidate: textLineage(payload), sort: [payload.old_start, payload.old_count, payload.new_start, payload.new_count], owners: candidate.owners });
        candidate = undefined;
      };
      for (const event of block) {
        if (!candidate) candidate = start();
        const prospective = { ...candidate, oldLines: [...candidate.oldLines], newLines: [...candidate.newLines] };
        prospective[event.side === "old" ? "oldLines" : "newLines"].push(event.line);
        prospective.owners = [...candidate.owners, `${sectionIndex}:${hunk.index}:${event.side}:${event.lineIndex}`];
        const prospectivePayload = textPayload(record, prospective.oldStart, prospective.newStart, prospective.oldLines, prospective.newLines, false);
        if (candidate.owners.length > 0 && Buffer.byteLength(canonicalJson(prospectivePayload)) > ATOM_TARGET_BYTES) {
          finish();
          candidate = start();
        }
        candidate[event.side === "old" ? "oldLines" : "newLines"].push(event.line);
        candidate.owners.push(`${sectionIndex}:${hunk.index}:${event.side}:${event.lineIndex}`);
        if (candidate.owners.length === 1) {
          const oneLine = textPayload(record, candidate.oldStart, candidate.newStart, candidate.oldLines, candidate.newLines, false);
          candidate.oversized = Buffer.byteLength(canonicalJson(oneLine)) > ATOM_TARGET_BYTES;
        }
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
  return bases.map(({ payload, lineage_candidate, segment_ordinal, content_hash, atom_id }) => ({ ...payload, lineage_candidate, segment_ordinal, content_hash, atom_id }));
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
export function atomizeCapturedReviewInput(capture) {
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
    if (section) bases.push(...projectTextAtoms(records[index], section, sectionForRecord[index]));
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
  if ([...lineCounts.values()].some((value) => value > 1) || [...lineCounts.keys()].some((key) => !expectedLines.includes(key))) reasons.push("duplicate_changed_line_owner");
  if (records.some((_, index) => sectionForRecord ? sectionForRecord[index] === -1 : false) || recordForSection.some((index) => index === -1)) reasons.push("raw_patch_path_disagreement");
  try {
    if (modeObjectBlobDisagreement(records, rows)) reasons.push("mode_object_blob_disagreement");
  } catch { reasons.push("mode_object_blob_disagreement"); }
  if (records.some((record) => !Object.hasOwn(STATUS_KINDS, record.status))) reasons.push("unsupported_raw_status");
  const countValue = counts(records, result.atoms, expectedLines.length, lineOwners);
  return reasons.length === 0 ? result : mismatch(reasons, countValue);
}
