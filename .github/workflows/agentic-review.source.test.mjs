import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../../scripts/lib-canonical-json.mjs";

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

function hostedOutputFlowSource(source) {
  const start = source.indexOf("          shadow_output_status() {");
  const end = source.indexOf("      - name: upload optional partition shadow diagnostics", start);
  assert.notEqual(start, -1, "workflow must guard hosted shadow output status");
  assert.notEqual(end, -1, "hosted shadow status guard must precede upload");
  return source.slice(start, end).replace(/^ {10}/gm, "");
}

test("automatic final discovery preserves the initial partition profile when shadow is not regenerated", () => {
  const source = readFileSync(workflow, "utf8");
  const phaseStart = source.indexOf("        run: &run-review-phase |");
  const automaticStart = source.indexOf("      - name: run automatic final discovery");
  assert.notEqual(phaseStart, -1);
  assert.notEqual(automaticStart, -1);
  assert.match(source.slice(phaseStart, automaticStart), /if \[ "\$\{AGENTIC_REVIEW_PARTITION_SHADOW:-false\}" = "true" \]; then\n            rm -f "\$REVIEW_PARTITION_SHADOW_PROFILE"/);
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
    assert.equal(text, `${canonicalJson(diagnostic)}\n`);
    assert.doesNotMatch(diagnostic.diagnostic, /helper|support|module|load/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("partition shadow profile upload cannot fail the authoritative review", () => {
  const source = readFileSync(workflow, "utf8");
  const uploadStart = source.indexOf("      - name: upload partition shadow execution profile");
  const uploadEnd = source.indexOf("      - name: upload optional review diagnostics", uploadStart);
  assert.notEqual(uploadStart, -1);
  assert.notEqual(uploadEnd, -1);
  assert.match(source.slice(uploadStart, uploadEnd), /continue-on-error: true/);
});

test("authoritative review uses the partition shadow boundary environment", () => {
  const source = readFileSync(workflow, "utf8");
  const stepStart = source.indexOf("      - name: run agentic review (read-only)");
  const stepEnd = source.indexOf("      - name: post review", stepStart);
  assert.notEqual(stepStart, -1);
  assert.notEqual(stepEnd, -1);
  const step = source.slice(stepStart, stepEnd);
  assert.match(step, /AGENTIC_REVIEW_PARTITION_SHADOW: \$\{\{ inputs\.partition_shadow \}\}/);
  assert.doesNotMatch(step, /^\s+PARTITION_SHADOW:/m);
  assert.match(step, /if \[ "\$\{AGENTIC_REVIEW_PARTITION_SHADOW:-false\}" = "true" \]; then/);
});

test("hosted shadow replaces malformed output with a bounded fallback", () => {
  const source = readFileSync(workflow, "utf8");
  const directory = mkdtempSync(join(tmpdir(), "agentic-review-shadow-malformed-"));
  try {
    const config = join(directory, "config.json");
    const output = join(directory, "shadow.json");
    writeFileSync(config, JSON.stringify({ max_shadow_artifact_bytes: 4096 }));
    writeFileSync(output, "{");
    execFileSync("bash", ["-c", `set -euo pipefail\n${fallbackFunctionsSource(source)}\n${hostedOutputFlowSource(source)}`], {
      env: {
        ...process.env,
        CAPTURE_HELPER: join(directory, "missing-capture-helper.mjs"),
        UNITS_HELPER: join(directory, "missing-units-helper.mjs"),
        CONFIG_FILE: config,
        CAPTURE_FILE: join(directory, "capture.json"),
        PARTITION_SHADOW_OUTPUT: output,
        PROFILE_FILE: join(directory, "profile.json"),
        BASE_SHA: sha,
        HEAD_SHA: sha,
      },
      stdio: "pipe",
    });
    const diagnostic = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(diagnostic.status, "capture_failed");
    assert.deepEqual(diagnostic.reason_codes, ["output_status_unreadable"]);
    assert.ok(Buffer.byteLength(readFileSync(output)) <= 4096);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("hosted shadow validates compacted output with its capture, profile, and config", () => {
  const source = readFileSync(workflow, "utf8");
  const directory = mkdtempSync(join(tmpdir(), "agentic-review-shadow-compacted-"));
  try {
    const output = join(directory, "shadow.json");
    const capture = join(directory, "capture.json");
    const profile = join(directory, "profile.json");
    const config = join(directory, "config.json");
    const helper = join(directory, "units.mjs");
    const receipt = join(directory, "receipt.json");
    writeFileSync(output, JSON.stringify({ status: "artifact_compacted" }));
    writeFileSync(capture, "{}");
    writeFileSync(profile, "{}");
    writeFileSync(config, "{}");
    writeFileSync(helper, [
      'import { writeFileSync } from "node:fs";',
      "const args = process.argv.slice(2);",
      'if (args[0] !== "validate-output") process.exit(1);',
      'writeFileSync(process.env.RECEIPT, JSON.stringify(args));',
    ].join("\n"));
    execFileSync("bash", ["-c", `set -euo pipefail\n${hostedOutputFlowSource(source)}`], {
      env: {
        ...process.env,
        UNITS_HELPER: helper,
        PARTITION_SHADOW_OUTPUT: output,
        CAPTURE_FILE: capture,
        PROFILE_FILE: profile,
        CONFIG_FILE: config,
        RECEIPT: receipt,
      },
      stdio: "pipe",
    });
    assert.deepEqual(JSON.parse(readFileSync(receipt, "utf8")), [
      "validate-output", "--input", output, "--capture", capture, "--profile", profile, "--config", config, "--max-bytes", "4194304",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
