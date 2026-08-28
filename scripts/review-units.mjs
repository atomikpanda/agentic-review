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
