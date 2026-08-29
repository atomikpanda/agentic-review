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
