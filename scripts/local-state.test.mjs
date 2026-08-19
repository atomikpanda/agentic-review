import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const localState = fileURLToPath(new URL("./local-state.mjs", import.meta.url));

function git(directory, ...args) {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
}

function run(directory, ...args) {
  return spawnSync(process.execPath, [localState, ...args], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, RUN_EPOCH: "1755600000000" },
  });
}

function createRepository(t, prefix) {
  const repository = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.email", "state-test@example.com");
  git(repository, "config", "user.name", "State Test");
  return repository;
}

test("open export uses the latest confirmed inclusive span for conservative retirement", (t) => {
  const repository = createRepository(t, "local-state-");
  const lines = Array.from({ length: 24 }, (_, index) => `line ${index + 1}`);
  writeFileSync(join(repository, "alpha.txt"), `${lines.join("\n")}\n`);
  git(repository, "add", "alpha.txt");
  git(repository, "commit", "-m", "base");
  const base = git(repository, "rev-parse", "HEAD");
  git(repository, "checkout", "-b", "feature");
  lines[0] = "reported head";
  writeFileSync(join(repository, "alpha.txt"), `${lines.join("\n")}\n`);
  git(repository, "commit", "-am", "reported head");
  const reportedHead = git(repository, "rev-parse", "HEAD");

  const findingsFile = join(repository, "findings.json");
  const finding = {
    file: "alpha.txt",
    title: "Persistent local defect",
    body: "The defect remains observable.",
    severity: "High",
    start_line: 8,
    end_line: 10,
    suggestion: null,
  };
  writeFileSync(findingsFile, JSON.stringify({ findings: [finding] }));
  assert.equal(run(repository, "record", findingsFile, base, reportedHead).status, 0);

  lines[8] = "changed but confirmed again";
  writeFileSync(join(repository, "alpha.txt"), `${lines.join("\n")}\n`);
  git(repository, "commit", "-am", "change then confirm finding");
  const confirmedHead = git(repository, "rev-parse", "HEAD");
  assert.equal(run(repository, "record", findingsFile, base, confirmedHead).status, 0);
  writeFileSync(findingsFile, JSON.stringify({ findings: [] }));
  assert.equal(run(repository, "record", findingsFile, base, confirmedHead).status, 0);
  const confirmed = run(repository, "export-open");
  assert.equal(confirmed.status, 0, confirmed.stderr);
  assert.deepEqual(JSON.parse(confirmed.stdout), { findings: [finding] });

  lines[19] = "unrelated hunk";
  writeFileSync(join(repository, "alpha.txt"), `${lines.join("\n")}\n`);
  git(repository, "commit", "-am", "change unrelated hunk");
  const unrelatedHead = git(repository, "rev-parse", "HEAD");
  assert.equal(run(repository, "record", findingsFile, base, unrelatedHead).status, 0);
  const unrelated = run(repository, "export-open");
  assert.equal(unrelated.status, 0, unrelated.stderr);
  assert.deepEqual(JSON.parse(unrelated.stdout), { findings: [finding] });

  lines[8] = "overlapping hunk";
  writeFileSync(join(repository, "alpha.txt"), `${lines.join("\n")}\n`);
  git(repository, "commit", "-am", "change reported span");
  const overlappingHead = git(repository, "rev-parse", "HEAD");
  assert.equal(run(repository, "record", findingsFile, base, overlappingHead).status, 0);
  const overlapping = run(repository, "export-open");
  assert.equal(overlapping.status, 0, overlapping.stderr);
  assert.deepEqual(JSON.parse(overlapping.stdout), { findings: [] });
});

test("malformed readable state fails without overwriting its bytes", (t) => {
  const repository = createRepository(t, "local-state-malformed-");
  writeFileSync(join(repository, "alpha.txt"), "base\n");
  git(repository, "add", "alpha.txt");
  git(repository, "commit", "-m", "base");
  const head = git(repository, "rev-parse", "HEAD");
  const stateDirectory = join(repository, ".git", "agentic-review");
  const stateFile = join(stateDirectory, "state.json");
  const malformed = "{\"findings\":";
  mkdirSync(stateDirectory, { recursive: true });
  writeFileSync(stateFile, malformed);
  const findingsFile = join(repository, "findings.json");
  writeFileSync(findingsFile, JSON.stringify({ findings: [] }));

  for (const args of [
    ["export-open"],
    ["list", "open"],
    ["record", findingsFile, head, head],
    ["dismiss", "stored"],
    ["reopen", "stored"],
  ]) {
    assert.equal(run(repository, ...args).status, 1, args.join(" "));
  }
  assert.equal(readFileSync(stateFile, "utf8"), malformed);
});

test("structurally invalid stored findings fail every reader and preserve bytes", (t) => {
  const repository = createRepository(t, "local-state-invalid-entry-");
  writeFileSync(join(repository, "alpha.txt"), "base\n");
  git(repository, "add", "alpha.txt");
  git(repository, "commit", "-m", "base");
  const head = git(repository, "rev-parse", "HEAD");
  const stateDirectory = join(repository, ".git", "agentic-review");
  const stateFile = join(stateDirectory, "state.json");
  const valid = {
    id: "stored",
    file: "alpha.txt",
    title: "Stored finding",
    body: "Stored body.",
    severity: "High",
    line: 1,
    endLine: 1,
    status: "open",
    firstSeen: "2026-08-19T00:00:00.000Z",
    lastSeen: "2026-08-19T00:00:00.000Z",
    firstCommit: head,
    lastCommit: head,
    count: 1,
  };
  const validTimestamp = "2026-08-19T00:00:00.000Z";
  const validCommit = "a".repeat(40);
  const invalidStates = [
    JSON.stringify({ findings: [{}] }),
    JSON.stringify({ findings: [{ ...valid, status: "waiting" }] }),
    JSON.stringify({ findings: [{ ...valid, endLine: 0 }] }),
    JSON.stringify({ findings: [{ ...valid, firstCommit: "not-a-commit", lastCommit: undefined }] }),
    JSON.stringify({ findings: [{ ...valid, firstCommit: [validCommit] }] }),
    JSON.stringify({ findings: [{ ...valid, firstCommit: { toString: validCommit } }] }),
    JSON.stringify({ findings: [{ ...valid, firstCommit: Number("1".repeat(40)) }] }),
    JSON.stringify({ findings: [{ ...valid, firstCommit: validCommit.toUpperCase() }] }),
    JSON.stringify({ findings: [{ ...valid, firstSeen: "not-a-timestamp" }] }),
    JSON.stringify({ findings: [{ ...valid, lastSeen: "not-a-timestamp" }] }),
    JSON.stringify({ findings: [{ ...valid, status: "gone" }] }),
    JSON.stringify({ findings: [{ ...valid, status: "gone", goneAt: 1 }] }),
    JSON.stringify({ findings: [{ ...valid, status: "gone", goneAt: "not-a-timestamp" }] }),
    JSON.stringify({ findings: [{ ...valid, status: "open", goneAt: validTimestamp }] }),
    JSON.stringify({ findings: [{ ...valid, status: "dismissed", goneAt: validTimestamp }] }),
  ];
  for (const field of ["firstCommit", "lastCommit"]) {
    for (const terminator of ["\n", "\r", "\u2028", "\u2029"]) {
      invalidStates.push(JSON.stringify({
        findings: [{ ...valid, [field]: `${validCommit}${terminator}` }],
      }));
    }
  }
  mkdirSync(stateDirectory, { recursive: true });
  const findingsFile = join(repository, "findings.json");
  writeFileSync(findingsFile, JSON.stringify({ findings: [] }));

  for (const invalid of invalidStates) {
    for (const args of [
      ["export-open"],
      ["list", "open"],
      ["record", findingsFile, head, head],
      ["dismiss", "stored"],
      ["reopen", "stored"],
    ]) {
      writeFileSync(stateFile, invalid);
      assert.equal(run(repository, ...args).status, 1, args.join(" "));
      assert.equal(readFileSync(stateFile, "utf8"), invalid);
    }
  }
});

test("changing a gone finding to a non-gone status removes goneAt", (t) => {
  const repository = createRepository(t, "local-state-reopen-");
  writeFileSync(join(repository, "alpha.txt"), "base\n");
  git(repository, "add", "alpha.txt");
  git(repository, "commit", "-m", "base");
  const head = git(repository, "rev-parse", "HEAD");
  const stateDirectory = join(repository, ".git", "agentic-review");
  const stateFile = join(stateDirectory, "state.json");
  const gone = {
    id: "stored",
    file: "alpha.txt",
    title: "Stored finding",
    body: "Stored body.",
    severity: "High",
    line: 1,
    endLine: 1,
    status: "gone",
    firstSeen: "2026-08-19T00:00:00.000Z",
    lastSeen: "2026-08-19T00:00:00.000Z",
    firstCommit: head,
    lastCommit: head,
    count: 1,
    goneAt: "2026-08-19T00:00:00.000Z",
  };
  mkdirSync(stateDirectory, { recursive: true });

  const { goneAt, ...nonGone } = gone;
  for (const command of ["dismiss", "reopen"]) {
    writeFileSync(stateFile, JSON.stringify({ findings: [gone] }));
    const result = run(repository, command, gone.id);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), {
      findings: [{ ...nonGone, status: command === "dismiss" ? "dismissed" : "open" }],
    });
  }
});

test("legacy state defaults the end span and latest commit without mutating on export", (t) => {
  const repository = createRepository(t, "local-state-legacy-");
  writeFileSync(join(repository, "alpha.txt"), "base\n");
  git(repository, "add", "alpha.txt");
  git(repository, "commit", "-m", "base");
  const head = git(repository, "rev-parse", "HEAD");
  const stateDirectory = join(repository, ".git", "agentic-review");
  const stateFile = join(stateDirectory, "state.json");
  mkdirSync(stateDirectory, { recursive: true });
  const legacy = JSON.stringify({
    findings: [{
      id: "legacy",
      file: "alpha.txt",
      title: "Legacy finding",
      body: "Legacy body.",
      severity: "Medium",
      line: 1,
      status: "open",
      firstCommit: head,
      firstSeen: "2026-08-19T00:00:00.000Z",
      lastSeen: "2026-08-19T00:00:00.000Z",
      count: 1,
    }],
  });
  writeFileSync(stateFile, legacy);

  const exported = run(repository, "export-open");
  assert.equal(exported.status, 0, exported.stderr);
  assert.deepEqual(JSON.parse(exported.stdout), { findings: [{
    file: "alpha.txt",
    title: "Legacy finding",
    body: "Legacy body.",
    severity: "Medium",
    start_line: 1,
    end_line: 1,
    suggestion: null,
  }] });
  assert.equal(readFileSync(stateFile, "utf8"), legacy);
});
