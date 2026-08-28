import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workflow = fileURLToPath(new URL("./agentic-review.yml", import.meta.url));
const sha = "a".repeat(40);

function emergencyFallbackSource(source) {
  const functionStart = source.indexOf("          emergency_fallback() {");
  assert.notEqual(functionStart, -1, "workflow must define a helper-independent emergency fallback");
  const heredocStart = source.indexOf("<<'NODE'\n", functionStart);
  assert.notEqual(heredocStart, -1, "emergency fallback must contain a Node program");
  const bodyStart = heredocStart + "<<'NODE'\n".length;
  const bodyEnd = source.indexOf("          NODE\n", bodyStart);
  assert.notEqual(bodyEnd, -1, "emergency fallback Node program must terminate");
  return source.slice(bodyStart, bodyEnd);
}

function fallbackFunctionsSource(source) {
  const start = source.indexOf("          fallback() {");
  const end = source.indexOf("          if ! node \"$CAPTURE_HELPER\" capture", start);
  assert.notEqual(start, -1, "workflow must define a shadow fallback");
  assert.notEqual(end, -1, "shadow fallback must precede helper execution");
  return source.slice(start, end).replace(/^ {10}/gm, "");
}

test("automatic final discovery preserves the initial partition profile when shadow is not regenerated", () => {
  const source = readFileSync(workflow, "utf8");
  const phaseStart = source.indexOf("        run: &run-review-phase |");
  const automaticStart = source.indexOf("      - name: run automatic final discovery");
  assert.notEqual(phaseStart, -1);
  assert.notEqual(automaticStart, -1);
  assert.match(source.slice(phaseStart, automaticStart), /if \[ "\$\{PARTITION_SHADOW:-false\}" = "true" \]; then\n            rm -f "\$REVIEW_PARTITION_SHADOW_PROFILE"/);
  const automaticStep = source.slice(automaticStart, source.indexOf("      - name: post automatic final discovery", automaticStart));
  assert.doesNotMatch(automaticStep, /PARTITION_SHADOW:/);
});

test("helper-independent shadow fallback writes a bounded redacted diagnostic", () => {
  const source = readFileSync(workflow, "utf8");
  const emergency = emergencyFallbackSource(source);
  assert.doesNotMatch(emergency, /(?:captureHelper|unitsHelper|await import\()/);

  const directory = mkdtempSync(join(tmpdir(), "agentic-review-shadow-"));
  try {
    const config = join(directory, "config.json");
    const output = join(directory, "shadow.json");
    writeFileSync(config, JSON.stringify({ max_shadow_artifact_bytes: 4096 }));
    execFileSync("bash", ["-c", `${fallbackFunctionsSource(source)}\nfallback capture_failed capture_helper_failed`], {
      env: {
        ...process.env,
        CAPTURE_HELPER: join(directory, "missing-capture-helper.mjs"),
        UNITS_HELPER: join(directory, "missing-units-helper.mjs"),
        CONFIG_FILE: config,
        CAPTURE_FILE: join(directory, "capture.json"),
        PARTITION_SHADOW_OUTPUT: output,
        BASE_SHA: sha,
        HEAD_SHA: sha,
      },
      stdio: "pipe",
    });

    const text = readFileSync(output, "utf8");
    const diagnostic = JSON.parse(text);
    assert.ok(text.length > 0);
    assert.ok(Buffer.byteLength(text) <= 4096);
    assert.deepEqual(Object.keys(diagnostic).sort(), [
      "base_sha", "benchmark_revision", "capture_hash", "counts", "diagnostic", "head_sha",
      "manifest_hash", "mode", "observed_lower_bounds", "reason_codes", "schema_version", "sizes", "status",
    ].sort());
    assert.equal(diagnostic.status, "capture_failed");
    assert.equal(diagnostic.mode, "partition_shadow");
    assert.equal(diagnostic.capture_hash, null);
    assert.equal(diagnostic.manifest_hash, null);
    assert.equal(diagnostic.sizes.encoded_output_bytes, Buffer.byteLength(text));
    assert.doesNotMatch(diagnostic.diagnostic, /helper|support|module|load/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
