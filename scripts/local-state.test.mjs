import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("export-open keeps omitted unchanged findings and removes them after their file changes", (t) => {
  const repository = mkdtempSync(join(tmpdir(), "local-state-"));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.email", "state-test@example.com");
  git(repository, "config", "user.name", "State Test");
  writeFileSync(join(repository, "alpha.txt"), "base\n");
  git(repository, "add", "alpha.txt");
  git(repository, "commit", "-m", "base");
  const base = git(repository, "rev-parse", "HEAD");
  git(repository, "checkout", "-b", "feature");
  writeFileSync(join(repository, "alpha.txt"), "reported\n");
  git(repository, "commit", "-am", "reported head");
  const reportedHead = git(repository, "rev-parse", "HEAD");

  const findingsFile = join(repository, "findings.json");
  writeFileSync(findingsFile, JSON.stringify({ findings: [{
    file: "alpha.txt",
    title: "Persistent local defect",
    body: "The defect remains observable.",
    severity: "High",
    start_line: 1,
    end_line: 1,
    suggestion: null,
  }] }));
  assert.equal(run(repository, "record", findingsFile, base, reportedHead).status, 0);

  writeFileSync(findingsFile, JSON.stringify({ findings: [] }));
  assert.equal(run(repository, "record", findingsFile, base, reportedHead).status, 0);
  const unchanged = run(repository, "export-open");
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.deepEqual(JSON.parse(unchanged.stdout), { findings: [{
    file: "alpha.txt",
    title: "Persistent local defect",
    body: "The defect remains observable.",
    severity: "High",
    start_line: 1,
    end_line: 1,
    suggestion: null,
  }] });

  writeFileSync(join(repository, "alpha.txt"), "changed\n");
  git(repository, "commit", "-am", "change reported file");
  const changedHead = git(repository, "rev-parse", "HEAD");
  assert.equal(run(repository, "record", findingsFile, base, changedHead).status, 0);
  const changed = run(repository, "export-open");
  assert.equal(changed.status, 0, changed.stderr);
  assert.deepEqual(JSON.parse(changed.stdout), { findings: [] });
});
