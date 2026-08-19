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

  assert.equal(run(repository, "export-open").status, 1);
  assert.equal(run(repository, "record", findingsFile, head, head).status, 1);
  assert.equal(readFileSync(stateFile, "utf8"), malformed);
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
