import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, canonicalSha256, isPlainJsonObject } from "./lib-canonical-json.mjs";

test("canonical JSON sorts object keys and preserves array order", () => {
  assert.equal(canonicalJson({ z: [3, 2, 1], a: { y: true, x: null } }),
    '{"a":{"x":null,"y":true},"z":[3,2,1]}');
});

test("canonical JSON permits ordinary secret-shaped data outside configuration policy", () => {
  assert.equal(canonicalJson({ token: "ordinary-domain-value" }),
    '{"token":"ordinary-domain-value"}');
});

test("canonical JSON rejects non-plain and lossy values", () => {
  assert.throws(() => canonicalJson({ missing: undefined }), /plain JSON data/);
  assert.throws(() => canonicalJson({ number: Number.NaN }), /plain JSON data/);
  assert.throws(() => canonicalJson(new Date()), /plain JSON data/);
  const sparse = [];
  sparse[1] = "x";
  assert.throws(() => canonicalJson(sparse), /plain JSON data/);
});

test("canonical SHA-256 is key-order independent", () => {
  assert.equal(canonicalSha256({ b: 2, a: 1 }), canonicalSha256({ a: 1, b: 2 }));
  assert.match(canonicalSha256({ a: 1 }), /^[0-9a-f]{64}$/);
});

test("plain-object detection excludes arrays and custom prototypes", () => {
  assert.equal(isPlainJsonObject({}), true);
  assert.equal(isPlainJsonObject([]), false);
  assert.equal(isPlainJsonObject(Object.create(null)), false);
});
