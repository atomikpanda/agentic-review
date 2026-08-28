import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { captureReviewInput, parseCaptureLimits, validateCapturedReviewInput } from "./review-capture.mjs";
import { parseRawDiffZ } from "./review-units.mjs";

const TEST_LIMITS = Object.freeze({
  maxPatchBytes: 1024 * 1024,
  maxRawZBytes: 1024 * 1024,
  maxSingleBlobBytes: 1024 * 1024,
  maxTotalBlobBytes: 4 * 1024 * 1024,
  maxCaptureMilliseconds: 5_000,
});

function runGit(repoRoot, args, options = {}) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "buffer", ...options });
}

function gitText(repoRoot, args) {
  return runGit(repoRoot, args).toString("utf8").trim();
}

function writeRepoFile(repoRoot, relativePath, value) {
  const path = join(repoRoot, relativePath);
  const parent = dirname(path);
  execFileSync("mkdir", ["-p", parent]);
  writeFileSync(path, value);
}

function commitAll(repoRoot, message) {
  runGit(repoRoot, ["add", "-A"]);
  runGit(repoRoot, ["commit", "-qm", message]);
  return gitText(repoRoot, ["rev-parse", "HEAD"]);
}

function createFixture(t) {
  const repoRoot = mkdtempSync(join(tmpdir(), "review-capture-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  runGit(repoRoot, ["init", "-q"]);
  runGit(repoRoot, ["config", "user.email", "capture@example.test"]);
  runGit(repoRoot, ["config", "user.name", "Capture Test"]);
  runGit(repoRoot, ["config", "core.abbrev", "5"]);
  writeRepoFile(repoRoot, "old-name.txt", "base text\n");
  writeRepoFile(repoRoot, "copy-source.txt", "copy source\n");
  writeRepoFile(repoRoot, "delete.bin", Buffer.from([0, 1, 2, 3]));
  writeRepoFile(repoRoot, "binary-remove.bin", Buffer.from([8, 9, 10, 11]));
  writeRepoFile(repoRoot, "pure-rename.txt", "rename without edits\n");
  writeRepoFile(repoRoot, "copy-edit-source.txt", `${"a".repeat(100)}\n`);
  writeRepoFile(repoRoot, "script.sh", "#!/bin/sh\necho base\n");
  writeRepoFile(repoRoot, "regular-to-symlink", "regular file\n");
  symlinkSync("base-target", join(repoRoot, "symlink-target"));
  runGit(repoRoot, ["add", "-A"]);
  runGit(repoRoot, ["update-index", "--chmod=+x", "script.sh"]);
  const baseSha = commitAll(repoRoot, "base");

  runGit(repoRoot, ["mv", "old-name.txt", "renamed.txt"]);
  runGit(repoRoot, ["mv", "pure-rename.txt", "pure-renamed.txt"]);
  writeRepoFile(repoRoot, "copy-edited.txt", `${"a".repeat(99)}b\n`);
  writeRepoFile(repoRoot, "renamed.txt", "changed text\n");
  writeRepoFile(repoRoot, "copy-target.txt", "copy source\n");
  writeRepoFile(repoRoot, "add.bin", Buffer.from([4, 5, 6, 7]));
  writeRepoFile(repoRoot, "delete.bin", Buffer.from([8, 9]));
  writeRepoFile(repoRoot, "script.sh", "#!/bin/sh\necho head\n");
  runGit(repoRoot, ["update-index", "--chmod=-x", "script.sh"]);
  unlinkSync(join(repoRoot, "regular-to-symlink"));
  unlinkSync(join(repoRoot, "binary-remove.bin"));
  symlinkSync("head-target", join(repoRoot, "regular-to-symlink"));
  unlinkSync(join(repoRoot, "symlink-target"));
  symlinkSync("head-target", join(repoRoot, "symlink-target"));
  writeRepoFile(repoRoot, "line\nbreak\tname.txt", "odd path\n");
  writeRepoFile(repoRoot, "unsupported.zzz", "not special\n");
  const invalidObject = gitText(repoRoot, ["hash-object", "-w", "--stdin"], { input: Buffer.from("invalid path\n") });
  runGit(repoRoot, ["update-index", "--add", "-z", "--index-info"], {
    input: Buffer.concat([Buffer.from(`100644 ${invalidObject}\tinvalid-`), Buffer.from([0xff, 0])]),
  });
  const headSha = commitAll(repoRoot, "head");
  return { repoRoot, baseSha, headSha };
}

function assertDiagnostic(value, reason) {
  assert.equal(value.status, "capture_capacity_exceeded");
  assert.equal(value.capacity_reason, reason);
  for (const field of ["patch_base64", "raw_z_base64", "object_table", "capture_hash"]) {
    assert.equal(Object.hasOwn(value, field), false, `${field} must not be present`);
  }
  assert.deepEqual(validateCapturedReviewInput(value), value);
}

test("parseRawDiffZ normalizes every raw path form without decoding path bytes", () => {
  const oldM = "1".repeat(40);
  const newM = "2".repeat(40);
  const oldD = "3".repeat(40);
  const newA = "4".repeat(40);
  const oldR = "5".repeat(40);
  const newR = "6".repeat(40);
  const bytes = Buffer.concat([
    Buffer.from(`:100644 100644 ${oldM} ${newM} M\0mod\0`),
    Buffer.from(`:000000 100644 ${"0".repeat(40)} ${newA} A\0add\0`),
    Buffer.from(`:100644 000000 ${oldD} ${"0".repeat(40)} D\0del\0`),
    Buffer.concat([Buffer.from(`:100644 100644 ${oldR} ${newR} R087\0old`), Buffer.from([0xff]), Buffer.from("\0new\tname\0")]),
    Buffer.from(`:100644 100644 ${oldR} ${newR} C100\0copy-old\0copy-new\0`),
  ]);
  const records = parseRawDiffZ(bytes, "sha1");
  assert.deepEqual(records.map((record) => ({
    status: record.status,
    similarity: record.similarity,
    oldPath: record.oldPath === null ? null : record.oldPath.toString("base64"),
    newPath: record.newPath === null ? null : record.newPath.toString("base64"),
    oldObjectId: record.oldObjectId,
    newObjectId: record.newObjectId,
  })), [
    { status: "M", similarity: null, oldPath: Buffer.from("mod").toString("base64"), newPath: Buffer.from("mod").toString("base64"), oldObjectId: oldM, newObjectId: newM },
    { status: "A", similarity: null, oldPath: null, newPath: Buffer.from("add").toString("base64"), oldObjectId: "0".repeat(40), newObjectId: newA },
    { status: "D", similarity: null, oldPath: Buffer.from("del").toString("base64"), newPath: null, oldObjectId: oldD, newObjectId: "0".repeat(40) },
    { status: "R", similarity: 87, oldPath: Buffer.from([111, 108, 100, 255]).toString("base64"), newPath: Buffer.from("new\tname").toString("base64"), oldObjectId: oldR, newObjectId: newR },
    { status: "C", similarity: 100, oldPath: Buffer.from("copy-old").toString("base64"), newPath: Buffer.from("copy-new").toString("base64"), oldObjectId: oldR, newObjectId: newR },
  ]);
  assert.throws(() => parseRawDiffZ(Buffer.from(`:100644 100644 ${oldM.slice(0, 5)} ${newM} M\0path\0`), "sha1"), /full 40-hex object ID/);
});

test("capture persists complete immutable inputs despite repository diff settings", async (t) => {
  const { repoRoot, baseSha, headSha } = createFixture(t);
  const initial = await captureReviewInput({ repoRoot, baseSha, headSha, limits: TEST_LIMITS });
  assert.equal(initial.status, "complete");
  assert.equal(initial.base_sha.length, 40);
  assert.equal(initial.head_sha.length, 40);
  assert.ok(initial.patch_argv.includes("--no-abbrev"));
  assert.ok(initial.raw_argv.includes("--find-copies-harder"));
  assert.ok(initial.raw_z_base64.length > 0);
  assert.ok(initial.object_table.some((row) => row.modes.includes("120000")));
  assert.ok(initial.object_table.every((row) => row.object_type === "blob"));
  assert.match(initial.capture_hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(validateCapturedReviewInput(initial), initial);

  runGit(repoRoot, ["config", "diff.algorithm", "histogram"]);
  runGit(repoRoot, ["config", "diff.renames", "false"]);
  runGit(repoRoot, ["config", "diff.external", "/bin/false"]);
  runGit(repoRoot, ["config", "diff.textconv", "true"]);
  runGit(repoRoot, ["config", "core.quotePath", "true"]);
  const configured = await captureReviewInput({ repoRoot, baseSha, headSha, limits: TEST_LIMITS });
  assert.deepEqual(configured, initial);
});

test("capture ignores inherited Git execution controls", async (t) => {
  const { repoRoot, baseSha, headSha } = createFixture(t);
  const hostileRoot = mkdtempSync(join(tmpdir(), "hostile-git-"));
  t.after(() => rmSync(hostileRoot, { recursive: true, force: true }));
  runGit(hostileRoot, ["init", "-q"]);
  const originalGitDir = process.env.GIT_DIR;
  const originalGitWorkTree = process.env.GIT_WORK_TREE;
  process.env.GIT_DIR = join(hostileRoot, ".git");
  process.env.GIT_WORK_TREE = hostileRoot;
  try {
    const result = await captureReviewInput({ repoRoot, baseSha, headSha, limits: TEST_LIMITS });
    assert.equal(result.status, "complete");
    assert.equal(result.base_sha, baseSha);
    assert.equal(result.head_sha, headSha);
  } finally {
    if (originalGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = originalGitDir;
    if (originalGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = originalGitWorkTree;
  }
});

test("capture failures are diagnostic-only capacity envelopes", async (t) => {
  const { repoRoot, baseSha, headSha } = createFixture(t);
  await assertDiagnostic(await captureReviewInput({
    repoRoot, baseSha, headSha, limits: { ...TEST_LIMITS, maxPatchBytes: 1 },
  }), "patch_bytes");
  await assertDiagnostic(await captureReviewInput({
    repoRoot, baseSha, headSha, limits: { ...TEST_LIMITS, maxRawZBytes: 1 },
  }), "raw_z_bytes");
  await assertDiagnostic(await captureReviewInput({
    repoRoot, baseSha, headSha, limits: { ...TEST_LIMITS, maxSingleBlobBytes: 1 },
  }), "blob_bytes");
});

test("deadline kills the git process tree without writing partial output", async (t) => {
  const { repoRoot, baseSha, headSha } = createFixture(t);
  const bin = mkdtempSync(join(tmpdir(), "fake-git-"));
  const pidPath = join(bin, "child.pid");
  const fakeGit = join(bin, "git");
  writeFileSync(fakeGit, `#!/bin/sh\n(sleep 60) &\necho $! > "$FAKE_GIT_CHILD_PID"\nsleep 60\n`);
  chmodSync(fakeGit, 0o755);
  const outputPath = join(repoRoot, "capture.json");
  const originalPath = process.env.PATH;
  const originalPidPath = process.env.FAKE_GIT_CHILD_PID;
  process.env.PATH = `${bin}:${originalPath}`;
  process.env.FAKE_GIT_CHILD_PID = pidPath;
  try {
    const result = await captureReviewInput({
      repoRoot, baseSha, headSha, outputPath,
      limits: { ...TEST_LIMITS, maxCaptureMilliseconds: 50 },
    });
    assertDiagnostic(result, "deadline");
    assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf8")), result);
    const childPid = Number(readFileSync(pidPath, "utf8"));
    assert.equal(spawnSync("kill", ["-0", String(childPid)]).status, 1);
  } finally {
    process.env.PATH = originalPath;
    if (originalPidPath === undefined) delete process.env.FAKE_GIT_CHILD_PID;
    else process.env.FAKE_GIT_CHILD_PID = originalPidPath;
    rmSync(bin, { recursive: true, force: true });
  }
});

test("deadline during finalization publishes only a diagnostic envelope", async (t) => {
  const { repoRoot, baseSha, headSha } = createFixture(t);
  const baseline = await captureReviewInput({ repoRoot, baseSha, headSha, limits: TEST_LIMITS });
  const bin = mkdtempSync(join(tmpdir(), "counting-git-"));
  const callsPath = join(bin, "calls");
  const fakeGit = join(bin, "git");
  writeFileSync(fakeGit, "#!/bin/sh\nprintf . >> \"$CAPTURE_GIT_CALLS\"\nexec /usr/bin/git \"$@\"\n");
  chmodSync(fakeGit, 0o755);
  const outputPath = join(repoRoot, "capture.json");
  const originalPath = process.env.PATH;
  const originalCallsPath = process.env.CAPTURE_GIT_CALLS;
  const originalNow = Date.now;
  const startedAt = originalNow();
  const finalGitCall = 4 + baseline.object_table.length;
  process.env.PATH = `${bin}:${originalPath}`;
  process.env.CAPTURE_GIT_CALLS = callsPath;
  Date.now = () => (
    existsSync(callsPath) && readFileSync(callsPath).length >= finalGitCall
      ? startedAt + TEST_LIMITS.maxCaptureMilliseconds + 1
      : startedAt
  );
  try {
    const result = await captureReviewInput({ repoRoot, baseSha, headSha, outputPath, limits: TEST_LIMITS });
    assertDiagnostic(result, "deadline");
    assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf8")), result);
  } finally {
    Date.now = originalNow;
    process.env.PATH = originalPath;
    if (originalCallsPath === undefined) delete process.env.CAPTURE_GIT_CALLS;
    else process.env.CAPTURE_GIT_CALLS = originalCallsPath;
    rmSync(bin, { recursive: true, force: true });
  }
});

test("temporary output setup fails before any Git process starts", (t) => {
  const { repoRoot, baseSha, headSha } = createFixture(t);
  const bin = mkdtempSync(join(tmpdir(), "open-failure-git-"));
  const markerPath = join(bin, "started");
  const childPidPath = join(bin, "child.pid");
  const fakeGit = join(bin, "git");
  const preloadPath = join(bin, "inject-open-failure.cjs");
  const limitsPath = join(repoRoot, "limits.json");
  const outputPath = join(repoRoot, "capture.json");
  writeFileSync(fakeGit, "#!/bin/sh\n(sleep 60) >/dev/null 2>&1 &\necho $! > \"$OPEN_FAILURE_CHILD_PID\"\ntouch \"$OPEN_FAILURE_STARTED\"\nexit 0\n");
  writeFileSync(preloadPath, "const fs = require('node:fs'); const { syncBuiltinESMExports } = require('node:module'); const openSync = fs.openSync; fs.openSync = (path, ...args) => { if (String(path).includes('/review-capture-')) throw new Error('injected temporary-open failure'); return openSync(path, ...args); }; syncBuiltinESMExports();\n");
  chmodSync(fakeGit, 0o755);
  writeFileSync(limitsPath, JSON.stringify({
    schema_version: 1,
    max_patch_bytes: TEST_LIMITS.maxPatchBytes,
    max_raw_z_bytes: TEST_LIMITS.maxRawZBytes,
    max_single_blob_bytes: TEST_LIMITS.maxSingleBlobBytes,
    max_total_blob_bytes: TEST_LIMITS.maxTotalBlobBytes,
    max_capture_seconds: 5,
  }));
  t.after(() => {
    if (existsSync(childPidPath)) spawnSync("kill", ["-KILL", readFileSync(childPidPath, "utf8").trim()]);
    rmSync(bin, { recursive: true, force: true });
  });
  const result = spawnSync(process.execPath, ["scripts/review-capture.mjs", "capture", "--repo", repoRoot, "--base", baseSha, "--head", headSha, "--limits", limitsPath, "--out", outputPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      NODE_OPTIONS: `--require=${preloadPath}`,
      OPEN_FAILURE_CHILD_PID: childPidPath,
      OPEN_FAILURE_STARTED: markerPath,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(markerPath), false);
  assert.equal(JSON.parse(readFileSync(outputPath, "utf8")).status, "capture_failed");
});

test("git process errors redact process output from capture envelopes", async (t) => {
  const { repoRoot, baseSha, headSha } = createFixture(t);
  const bin = mkdtempSync(join(tmpdir(), "failing-git-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const fakeGit = join(bin, "git");
  writeFileSync(fakeGit, "#!/bin/sh\necho secret-source-path >&2\nexit 7\n");
  chmodSync(fakeGit, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  try {
    const result = await captureReviewInput({ repoRoot, baseSha, headSha, limits: TEST_LIMITS });
    assert.equal(result.status, "capture_failed");
    assert.equal(result.capacity_reason, "process_error");
    for (const field of ["patch_base64", "raw_z_base64", "object_table", "capture_hash", "stderr", "source"]) {
      assert.equal(Object.hasOwn(result, field), false, `${field} must not be present`);
    }
    assert.deepEqual(validateCapturedReviewInput(result), result);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("capture does not fetch gitlink commit IDs as blobs", async (t) => {
  const submoduleRoot = mkdtempSync(join(tmpdir(), "capture-submodule-"));
  t.after(() => rmSync(submoduleRoot, { recursive: true, force: true }));
  runGit(submoduleRoot, ["init", "-q"]);
  runGit(submoduleRoot, ["config", "user.email", "capture@example.test"]);
  runGit(submoduleRoot, ["config", "user.name", "Capture Test"]);
  writeRepoFile(submoduleRoot, "sub.txt", "one\n");
  commitAll(submoduleRoot, "one");
  writeRepoFile(submoduleRoot, "sub.txt", "two\n");
  const subHead = commitAll(submoduleRoot, "two");

  const { repoRoot, baseSha } = createFixture(t);
  const subBase = gitText(submoduleRoot, ["rev-parse", "HEAD~1"]);
  runGit(repoRoot, ["fetch", "-q", submoduleRoot, subHead]);
  runGit(repoRoot, ["update-index", "--add", "--cacheinfo", `160000,${subBase},vendor/sub`]);
  runGit(repoRoot, ["commit", "-qm", "old gitlink"]);
  const withOldGitlink = gitText(repoRoot, ["rev-parse", "HEAD"]);
  runGit(repoRoot, ["update-index", "--cacheinfo", `160000,${subHead},vendor/sub`]);
  runGit(repoRoot, ["commit", "-qm", "new gitlink"]);
  const withNewGitlink = gitText(repoRoot, ["rev-parse", "HEAD"]);
  const result = await captureReviewInput({ repoRoot, baseSha: withOldGitlink, headSha: withNewGitlink, limits: TEST_LIMITS });
  assert.equal(result.status, "complete");
  assert.match(Buffer.from(result.raw_z_base64, "base64").toString("latin1"), new RegExp(subHead));
  assert.equal(result.object_table.some((row) => row.object_id === subHead), false);
});

test("CLI parses exact snake-case limits and writes one capture envelope", (t) => {
  const { repoRoot, baseSha, headSha } = createFixture(t);
  const limitsPath = join(repoRoot, "limits.json");
  const outputPath = join(repoRoot, "capture.json");
  writeFileSync(limitsPath, JSON.stringify({
    schema_version: 1,
    max_patch_bytes: TEST_LIMITS.maxPatchBytes,
    max_raw_z_bytes: TEST_LIMITS.maxRawZBytes,
    max_single_blob_bytes: TEST_LIMITS.maxSingleBlobBytes,
    max_total_blob_bytes: TEST_LIMITS.maxTotalBlobBytes,
    max_capture_seconds: 5,
  }));
  assert.deepEqual(parseCaptureLimits(JSON.parse(readFileSync(limitsPath, "utf8"))), TEST_LIMITS);
  const run = spawnSync(process.execPath, ["scripts/review-capture.mjs", "capture", "--repo", repoRoot, "--base", baseSha, "--head", headSha, "--limits", limitsPath, "--out", outputPath], {
    cwd: process.cwd(), encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(readFileSync(outputPath, "utf8")).status, "complete");
});


test("CLI returns documented usage and output-write exit codes", (t) => {
  const usage = spawnSync(process.execPath, ["scripts/review-capture.mjs"], {
    cwd: process.cwd(), encoding: "utf8",
  });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /^usage:/);

  const { repoRoot, baseSha, headSha } = createFixture(t);
  const limitsPath = join(repoRoot, "limits.json");
  const outputPath = join(repoRoot, "capture.json");
  const targetPath = join(repoRoot, "target.json");
  writeFileSync(limitsPath, JSON.stringify({
    schema_version: 1,
    max_patch_bytes: TEST_LIMITS.maxPatchBytes,
    max_raw_z_bytes: TEST_LIMITS.maxRawZBytes,
    max_single_blob_bytes: TEST_LIMITS.maxSingleBlobBytes,
    max_total_blob_bytes: TEST_LIMITS.maxTotalBlobBytes,
    max_capture_seconds: 5,
  }));
  writeFileSync(targetPath, "unchanged\n");
  symlinkSync(targetPath, outputPath);
  const outputFailure = spawnSync(process.execPath, ["scripts/review-capture.mjs", "capture", "--repo", repoRoot, "--base", baseSha, "--head", headSha, "--limits", limitsPath, "--out", outputPath], {
    cwd: process.cwd(), encoding: "utf8",
  });
  assert.equal(outputFailure.status, 1);
  assert.equal(readFileSync(targetPath, "utf8"), "unchanged\n");
});