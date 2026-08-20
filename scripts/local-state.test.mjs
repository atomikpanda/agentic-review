import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const localState = fileURLToPath(new URL("./local-state.mjs", import.meta.url));

function git(directory, ...args) {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
}

function runAtEpoch(directory, epoch, ...args) {
  return spawnSync(process.execPath, [localState, ...args], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, RUN_EPOCH: String(epoch) },
  });
}

function run(directory, ...args) {
  return runAtEpoch(directory, 1755600000000, ...args);
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
  assert.equal(run(repository, "record", findingsFile, base, reportedHead, "complete").status, 0);

  lines[8] = "changed but confirmed again";
  writeFileSync(join(repository, "alpha.txt"), `${lines.join("\n")}\n`);
  git(repository, "commit", "-am", "change then confirm finding");
  const confirmedHead = git(repository, "rev-parse", "HEAD");
  assert.equal(run(repository, "record", findingsFile, base, confirmedHead, "complete").status, 0);
  writeFileSync(findingsFile, JSON.stringify({ findings: [] }));
  assert.equal(run(repository, "record", findingsFile, base, confirmedHead, "complete").status, 0);
  const confirmed = run(repository, "export-open");
  assert.equal(confirmed.status, 0, confirmed.stderr);
  assert.deepEqual(JSON.parse(confirmed.stdout), { findings: [finding] });

  lines[19] = "unrelated hunk";
  writeFileSync(join(repository, "alpha.txt"), `${lines.join("\n")}\n`);
  git(repository, "commit", "-am", "change unrelated hunk");
  const unrelatedHead = git(repository, "rev-parse", "HEAD");
  assert.equal(run(repository, "record", findingsFile, base, unrelatedHead, "complete").status, 0);
  const unrelated = run(repository, "export-open");
  assert.equal(unrelated.status, 0, unrelated.stderr);
  assert.deepEqual(JSON.parse(unrelated.stdout), { findings: [finding] });

  lines[8] = "overlapping hunk";
  writeFileSync(join(repository, "alpha.txt"), `${lines.join("\n")}\n`);
  git(repository, "commit", "-am", "change reported span");
  const overlappingHead = git(repository, "rev-parse", "HEAD");
  assert.equal(run(repository, "record", findingsFile, base, overlappingHead, "complete").status, 0);
  const overlapping = run(repository, "export-open");
  assert.equal(overlapping.status, 0, overlapping.stderr);
  assert.deepEqual(JSON.parse(overlapping.stdout), { findings: [] });
});

test("inconclusive records retain omitted evidence until a complete overlapping review retires it", (t) => {
  const repository = createRepository(t, "local-state-completeness-");
  writeFileSync(join(repository, "alpha.txt"), "one\ntwo\nthree\n");
  git(repository, "add", "alpha.txt");
  git(repository, "commit", "-m", "base");
  const base = git(repository, "rev-parse", "HEAD");
  git(repository, "checkout", "-b", "feature");
  writeFileSync(join(repository, "alpha.txt"), "one\nreported\nthree\n");
  git(repository, "commit", "-am", "reported head");
  const reportedHead = git(repository, "rev-parse", "HEAD");
  const findingsFile = join(repository, "findings.json");
  const finding = {
    file: "alpha.txt",
    title: "Standing incomplete evidence",
    body: "The reported behavior remains blocking.",
    severity: "High",
    start_line: 2,
    end_line: 2,
    suggestion: null,
  };
  writeFileSync(findingsFile, JSON.stringify({ findings: [finding] }));
  assert.equal(run(repository, "record", findingsFile, base, reportedHead, "complete").status, 0);

  writeFileSync(join(repository, "alpha.txt"), "one\nchanged during partial review\nthree\n");
  git(repository, "commit", "-am", "overlap standing span");
  const changedHead = git(repository, "rev-parse", "HEAD");
  writeFileSync(findingsFile, JSON.stringify({ findings: [] }));
  const partial = run(repository, "record", findingsFile, base, changedHead, "inconclusive");
  assert.equal(partial.status, 0, partial.stderr);
  const held = run(repository, "export-open");
  assert.equal(held.status, 0, held.stderr);
  assert.deepEqual(JSON.parse(held.stdout), { findings: [finding] });

  const complete = run(repository, "record", findingsFile, base, changedHead, "complete");
  assert.equal(complete.status, 0, complete.stderr);
  assert.deepEqual(JSON.parse(run(repository, "export-open").stdout), { findings: [] });
});

test("malformed current findings fail before local state bytes change", (t) => {
  const repository = createRepository(t, "local-state-current-validation-");
  writeFileSync(join(repository, "alpha.txt"), "base\n");
  git(repository, "add", "alpha.txt");
  git(repository, "commit", "-m", "base");
  const head = git(repository, "rev-parse", "HEAD");
  const findingsFile = join(repository, "findings.json");
  const valid = {
    file: "alpha.txt",
    title: "Valid current finding",
    body: "This finding has a valid public shape.",
    severity: "High",
    start_line: 1,
    end_line: 1,
    suggestion: null,
  };
  writeFileSync(findingsFile, JSON.stringify({ findings: [valid] }));
  assert.equal(run(repository, "record", findingsFile, head, head, "complete").status, 0);
  const stateFile = join(repository, ".git", "agentic-review", "state.json");
  const original = readFileSync(stateFile, "utf8");

  for (const document of [
    { findings: [{}] },
    { findings: [{ ...valid, file: " \t" }] },
    { findings: [{ ...valid, title: "Visible title\nInjected identity" }] },
  ]) {
    writeFileSync(stateFile, original);
    writeFileSync(findingsFile, JSON.stringify(document));
    const result = run(repository, "record", findingsFile, head, head, "complete");
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(stateFile, "utf8"), original);
  }
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
    ["record", findingsFile, head, head, "complete"],
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
      ["record", findingsFile, head, head, "complete"],
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

test("an abandoned stale-lock reaper does not permanently block mutations", (t) => {
  const repository = createRepository(t, "local-state-abandoned-reaper-");
  const stateDirectory = join(repository, ".git", "agentic-review");
  const lockDirectory = join(stateDirectory, "state.lock");
  mkdirSync(lockDirectory, { recursive: true });
  writeFileSync(join(stateDirectory, "state.json"), JSON.stringify({ findings: [] }));
  writeFileSync(join(lockDirectory, "owner.json"), JSON.stringify({
    pid: 2_147_483_647,
    token: "abandoned-lock",
    processIdentity: "linux:abandoned-lock",
  }));
  const abandonedReaper = join(lockDirectory, "reaper");
  writeFileSync(abandonedReaper, "abandoned-reaper");
  utimesSync(abandonedReaper, new Date(0), new Date(0));

  const mutation = spawnSync(process.execPath, [localState, "dismiss", "missing"], {
    cwd: repository,
    encoding: "utf8",
    timeout: 1_000,
  });
  assert.equal(mutation.status, 0, mutation.error?.message ?? mutation.stderr);
  assert.equal(existsSync(lockDirectory), false);
});

test("an aged empty legacy reaper marker does not permanently block mutations", (t) => {
  const repository = createRepository(t, "local-state-empty-reaper-");
  const stateDirectory = join(repository, ".git", "agentic-review");
  const lockDirectory = join(stateDirectory, "state.lock");
  mkdirSync(lockDirectory, { recursive: true });
  writeFileSync(join(stateDirectory, "state.json"), JSON.stringify({ findings: [] }));
  writeFileSync(join(lockDirectory, "owner.json"), JSON.stringify({
    pid: 2_147_483_647,
    token: "abandoned-lock",
    processIdentity: "linux:abandoned-lock",
  }));
  const emptyReaper = join(lockDirectory, "reaper");
  writeFileSync(emptyReaper, "");
  utimesSync(emptyReaper, new Date(0), new Date(0));

  const mutation = spawnSync(process.execPath, [localState, "dismiss", "missing"], {
    cwd: repository,
    encoding: "utf8",
    timeout: 1_000,
  });
  assert.equal(mutation.status, 0, mutation.error?.message ?? mutation.stderr);
  assert.equal(existsSync(lockDirectory), false);
});

test("a live stale-lock reaper is not displaced by another mutation", (t) => {
  const repository = createRepository(t, "local-state-live-reaper-");
  const stateDirectory = join(repository, ".git", "agentic-review");
  const lockDirectory = join(stateDirectory, "state.lock");
  mkdirSync(lockDirectory, { recursive: true });
  writeFileSync(join(stateDirectory, "state.json"), JSON.stringify({ findings: [] }));
  writeFileSync(join(lockDirectory, "owner.json"), JSON.stringify({
    pid: 2_147_483_647,
    token: "abandoned-lock",
    processIdentity: "linux:abandoned-lock",
  }));
  const liveReaper = JSON.stringify({ pid: process.pid, token: "live-reaper" });
  writeFileSync(join(lockDirectory, "reaper"), liveReaper);

  const mutation = spawnSync(process.execPath, [localState, "dismiss", "missing"], {
    cwd: repository,
    encoding: "utf8",
    timeout: 500,
  });
  assert.equal(mutation.status, null);
  assert.equal(mutation.error?.code, "ETIMEDOUT");
  assert.equal(readFileSync(join(lockDirectory, "reaper"), "utf8"), liveReaper);
});

test("a young empty legacy reaper marker is not displaced", (t) => {
  const repository = createRepository(t, "local-state-young-empty-reaper-");
  const stateDirectory = join(repository, ".git", "agentic-review");
  const lockDirectory = join(stateDirectory, "state.lock");
  mkdirSync(lockDirectory, { recursive: true });
  writeFileSync(join(stateDirectory, "state.json"), JSON.stringify({ findings: [] }));
  writeFileSync(join(lockDirectory, "owner.json"), JSON.stringify({
    pid: 2_147_483_647,
    token: "abandoned-lock",
    processIdentity: "linux:abandoned-lock",
  }));
  const emptyReaper = join(lockDirectory, "reaper");
  writeFileSync(emptyReaper, "");

  const mutation = spawnSync(process.execPath, [localState, "dismiss", "missing"], {
    cwd: repository,
    encoding: "utf8",
    timeout: 500,
  });
  assert.equal(mutation.status, null);
  assert.equal(mutation.error?.code, "ETIMEDOUT");
  assert.equal(readFileSync(emptyReaper, "utf8"), "");
});

test("runs with equal timestamps retain immutable history and list newest first", (t) => {
  const repository = createRepository(t, "local-state-run-history-");
  writeFileSync(join(repository, "alpha.txt"), "first\n");
  git(repository, "add", "alpha.txt");
  git(repository, "commit", "-m", "first");
  const firstHead = git(repository, "rev-parse", "HEAD");
  const findingsFile = join(repository, "findings.json");
  writeFileSync(findingsFile, JSON.stringify({ findings: [] }));

  const sharedEpoch = 1755600000000;
  const recordedFirst = runAtEpoch(
    repository,
    sharedEpoch,
    "record",
    findingsFile,
    firstHead,
    firstHead,
    "complete",
  );
  assert.equal(recordedFirst.status, 0, recordedFirst.stderr);

  writeFileSync(join(repository, "alpha.txt"), "second\n");
  git(repository, "commit", "-am", "second");
  const secondHead = git(repository, "rev-parse", "HEAD");
  const recordedSecond = runAtEpoch(
    repository,
    sharedEpoch,
    "record",
    findingsFile,
    firstHead,
    secondHead,
    "complete",
  );
  assert.equal(recordedSecond.status, 0, recordedSecond.stderr);

  writeFileSync(join(repository, "alpha.txt"), "third\n");
  git(repository, "commit", "-am", "third");
  const latestHead = git(repository, "rev-parse", "HEAD");
  const recordedLater = runAtEpoch(
    repository,
    sharedEpoch + 1,
    "record",
    findingsFile,
    firstHead,
    latestHead,
    "complete",
  );
  assert.equal(recordedLater.status, 0, recordedLater.stderr);

  const runsDirectory = join(repository, ".git", "agentic-review", "runs");
  const historyFiles = readdirSync(runsDirectory);
  assert.equal(historyFiles.length, 3);
  assert.ok(historyFiles.every((file) => file.endsWith(".json")));
  const history = historyFiles.map((file) =>
    JSON.parse(readFileSync(join(runsDirectory, file), "utf8")));
  assert.deepEqual(
    history.map((record) => record.at).sort(),
    [
      new Date(sharedEpoch).toISOString(),
      new Date(sharedEpoch).toISOString(),
      new Date(sharedEpoch + 1).toISOString(),
    ],
  );
  assert.deepEqual(
    history
      .filter((record) => record.at === new Date(sharedEpoch).toISOString())
      .map((record) => record.head)
      .sort(),
    [firstHead, secondHead].sort(),
  );

  const listed = run(repository, "runs");
  assert.equal(listed.status, 0, listed.stderr);
  const lines = listed.stdout.trim().split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], new RegExp(`${new Date(sharedEpoch + 1).toISOString()}.*${latestHead.slice(0, 8)}$`));
  assert.match(lines[1], new RegExp(`${new Date(sharedEpoch).toISOString()}.*${secondHead.slice(0, 8)}$`));
  assert.match(lines[2], new RegExp(`${new Date(sharedEpoch).toISOString()}.*${firstHead.slice(0, 8)}$`));
  assert.equal(run(repository, "runs").stdout, listed.stdout);
});
