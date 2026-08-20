#!/usr/bin/env node
// Local review state: what this reviewer has already said about this repository,
// and what happened to it.
//
// On a pull request the threads themselves are the memory — we can ask GitHub
// what is open, what a human resolved, what we already reported. Locally there
// was nothing, so every run re-reported everything and there was no way to say
// "I've seen this, it's fine." That made the local runner a demo rather than a
// tool.
//
// State lives in the git common directory, so it is per-repository, shared
// across worktrees, and can never be committed by accident.
//
// Usage:
//   local-state.mjs record <findings.json> <base> <head> <complete|inconclusive>
//   local-state.mjs list [open|all|dismissed]              print tracked findings
//   local-state.mjs export-open                            print open findings JSON
//   local-state.mjs dismiss <id>...                        stop reporting these
//   local-state.mjs reopen <id>...
//   local-state.mjs runs                                   past runs, newest first

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  GIT_DIFF_MAX_BUFFER_BYTES,
  changeIsConfirmed,
  diffTouchesSpan,
  literalPathspec,
} from "./thread-change.mjs";
import { projectPublicFinding, sameFinding } from "./lib-findings.mjs";

const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const STATE_DIR = join(git(["rev-parse", "--git-common-dir"]), "agentic-review");
const RUNS_DIR = join(STATE_DIR, "runs");
const STATE_FILE = join(STATE_DIR, "state.json");
const STORED_STATUSES = new Set(["open", "dismissed", "gone"]);
const STORED_SEVERITIES = new Set(["Critical", "High", "Medium"]);
const NON_LOWERCASE_HEX = /[^0-9a-f]/;
const STAGED_TARGET_REF_PREFIX = "refs/agentic-review/staged-targets/";
// A fully populated directory is atomically published to serialize the state/ref
// transaction. The owner lets a later CLI reclaim a lock abandoned by a crash.
const STATE_LOCK_DIR = join(STATE_DIR, "state.lock");
const STATE_LOCK_OWNER = join(STATE_LOCK_DIR, "owner.json");
const STATE_LOCK_REAPER = join(STATE_LOCK_DIR, "reaper");
const LOCK_RETRY_MS = 25;
const OWNERLESS_LOCK_STALE_MS = 5_000;
const LOCK_WAIT_TIMEOUT_MS = 30_000;
const PROCESS_BOOT_ID_FILE = "/proc/sys/kernel/random/boot_id";
let processBootId;
try {
  processBootId = readFileSync(PROCESS_BOOT_ID_FILE, "utf8").trim() || undefined;
} catch (error) {
  if (error?.code !== "ENOENT" && error?.code !== "EACCES") throw error;
}


function readStateLockOwner() {
  try {
    const owner = JSON.parse(readFileSync(STATE_LOCK_OWNER, "utf8"));
    return Number.isInteger(owner?.pid) && owner.pid > 0 && typeof owner.token === "string"
      ? owner
      : null;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function readStateLockReaper() {
  try {
    return readFileSync(STATE_LOCK_REAPER, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function removeStateLockReaper(token) {
  if (readStateLockReaper() !== token) return false;
  try {
    unlinkSync(STATE_LOCK_REAPER);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}


function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function processIdentity(pid) {
  if (processBootId !== undefined) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      const fields = commandEnd === -1 ? [] : stat.slice(commandEnd + 2).trim().split(/\s+/);
      // Removing pid/comm makes Linux stat field 3 index 0; process start time is field 22.
      const startedAt = fields[19];
      if (startedAt) return `linux:${processBootId}:${startedAt}`;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (error?.code !== "EACCES") throw error;
    }
  }

  try {
    const startedAt = execFileSync(
      "ps",
      ["-o", "lstart=", "-p", String(pid)],
      { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } },
    ).trim();
    return startedAt ? `ps:${startedAt}` : null;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    if (Number.isInteger(error?.status)) return processIsRunning(pid) ? undefined : null;
    throw error;
  }
}

function processOwnsStateLock(owner) {
  if (typeof owner.processIdentity === "string") {
    const currentIdentity = processIdentity(owner.pid);
    if (currentIdentity !== undefined) return currentIdentity === owner.processIdentity;
  }
  return processIsRunning(owner.pid);
}


function reapStaleStateLock(token) {
  const observedOwner = readStateLockOwner();
  let ownerlessLockIsStale = false;
  if (observedOwner) {
    if (processOwnsStateLock(observedOwner)) return false;
  } else {
    try {
      ownerlessLockIsStale = Date.now() - statSync(STATE_LOCK_DIR).mtimeMs >= OWNERLESS_LOCK_STALE_MS;
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      throw error;
    }
    if (!ownerlessLockIsStale) return false;
  }

  try {
    writeFileSync(STATE_LOCK_REAPER, token, { flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST" || error?.code === "ENOENT") return false;
    throw error;
  }

  const currentOwner = readStateLockOwner();
  if (
    (currentOwner && processOwnsStateLock(currentOwner))
    || (observedOwner && currentOwner?.token !== observedOwner.token)
  ) {
    removeStateLockReaper(token);
    return false;
  }
  rmSync(STATE_LOCK_DIR, { recursive: true, force: true });
  return true;
}

function acquireStateLock() {
  mkdirSync(STATE_DIR, { recursive: true });
  const token = randomUUID();
  const pendingLockDir = `${STATE_LOCK_DIR}.pending-${token}`;
  const pendingOwner = join(pendingLockDir, "owner.json");
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  try {
    mkdirSync(pendingLockDir);
    const ownerIdentity = processIdentity(process.pid);
    writeFileSync(pendingOwner, JSON.stringify({
      pid: process.pid,
      token,
      acquiredAt: new Date().toISOString(),
      ...(typeof ownerIdentity === "string" ? { processIdentity: ownerIdentity } : {}),
    }), { flag: "wx" });

    while (true) {
      if (existsSync(STATE_LOCK_DIR)) {
        if (reapStaleStateLock(token)) continue;
      } else {
        try {
          renameSync(pendingLockDir, STATE_LOCK_DIR);
          return token;
        } catch (error) {
          if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for local review state lock at ${STATE_LOCK_DIR}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
    }
  } finally {
    rmSync(pendingLockDir, { recursive: true, force: true });
  }
}

function withStateMutation(action) {
  const token = acquireStateLock();
  try {
    return action();
  } finally {
    const owner = readStateLockOwner();
    if (owner?.token === token) rmSync(STATE_LOCK_DIR, { recursive: true, force: true });
  }
}

const findingOwnsStagedTarget = (finding) => finding.stagedTarget === true && finding.status !== "gone";

function retainStagedTarget(state, target) {
  if (!target) return;
  if (state.findings.some((finding) => findingOwnsStagedTarget(finding) && finding.lastCommit === target)) {
    git(["update-ref", `${STAGED_TARGET_REF_PREFIX}${target}`, target]);
  }
}

function pruneUnownedStagedTargets(state) {
  const owned = new Set(
    state.findings
      .filter(findingOwnsStagedTarget)
      .map((finding) => finding.lastCommit),
  );
  const refs = git(["for-each-ref", "--format=%(refname)", STAGED_TARGET_REF_PREFIX]);
  for (const ref of refs ? refs.split("\n") : []) {
    const target = ref.slice(STAGED_TARGET_REF_PREFIX.length);
    if (!owned.has(target)) git(["update-ref", "-d", ref]);
  }
}

function isTimestamp(value) {
  if (typeof value !== "string") return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function migrateAndValidateStoredFinding(finding, index) {
  const label = `local review state findings[${index}]`;
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
    throw new TypeError(`${label} must be an object`);
  }
  if (finding.endLine === undefined) finding.endLine = finding.line;
  if (finding.lastCommit === undefined) finding.lastCommit = finding.firstCommit;
  for (const field of ["id", "file", "title"]) {
    if (typeof finding[field] !== "string" || finding[field].length === 0) {
      throw new TypeError(`${label}.${field} must be a non-empty string`);
    }
  }
  for (const field of ["firstSeen", "lastSeen"]) {
    if (!isTimestamp(finding[field])) {
      throw new TypeError(`${label}.${field} must be an ISO timestamp`);
    }
  }
  if (typeof finding.body !== "string") {
    throw new TypeError(`${label}.body must be a string`);
  }
  if (!STORED_SEVERITIES.has(finding.severity)) {
    throw new TypeError(`${label}.severity is invalid`);
  }
  if (!STORED_STATUSES.has(finding.status)) {
    throw new TypeError(`${label}.status is invalid`);
  }
  if (finding.status === "gone") {
    if (!isTimestamp(finding.goneAt)) {
      throw new TypeError(`${label}.goneAt must be an ISO timestamp for gone findings`);
    }
  } else if (Object.hasOwn(finding, "goneAt")) {
    throw new TypeError(`${label}.goneAt is only valid for gone findings`);
  }
  if (Object.hasOwn(finding, "stagedTarget") && typeof finding.stagedTarget !== "boolean") {
    throw new TypeError(`${label}.stagedTarget must be a boolean`);
  }
  if (
    !Number.isInteger(finding.line)
    || finding.line < 1
    || !Number.isInteger(finding.endLine)
    || finding.endLine < finding.line
  ) {
    throw new TypeError(`${label} has an invalid inclusive line span`);
  }
  for (const field of ["firstCommit", "lastCommit"]) {
    const commit = finding[field];
    if (typeof commit !== "string" || commit.length !== 40 || NON_LOWERCASE_HEX.test(commit)) {
      throw new TypeError(`${label}.${field} must be a lowercase 40-hex commit SHA`);
    }
  }
  if (!Number.isInteger(finding.count) || finding.count < 1) {
    throw new TypeError(`${label}.count must be a positive integer`);
  }
}

function publishJson(path, value) {
  const pendingPath = `${path}.pending-${randomUUID()}`;
  try {
    writeFileSync(pendingPath, JSON.stringify(value, null, 2), { flag: "wx" });
    renameSync(pendingPath, path);
  } finally {
    rmSync(pendingPath, { force: true });
  }
}


const load = () => {
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (!state || typeof state !== "object" || !Array.isArray(state.findings)) {
      throw new TypeError("local review state must contain a findings array");
    }
    state.findings.forEach(migrateAndValidateStoredFinding);
    return state;
  } catch (error) {
    if (error?.code === "ENOENT") return { findings: [] };
    throw error;
  }
};
const save = (s) => {
  mkdirSync(STATE_DIR, { recursive: true });
  publishJson(STATE_FILE, s);
};

// Short, stable, human-typeable — these are meant to be passed to `dismiss`.
const idFor = (f) =>
  createHash("sha256")
    .update(`${f.file}::${String(f.title).toLowerCase().trim()}`)
    .digest("hex")
    .slice(0, 6);

function spanChangedSince(finding, head) {
  if (
    !finding.file
    || !finding.lastCommit
    || !head
    || !Number.isInteger(finding.line)
    || !Number.isInteger(finding.endLine)
  ) return null;
  try {
    const diff = execFileSync(
      "git",
      [
        "diff",
        "--unified=0",
        "--no-ext-diff",
        finding.lastCommit,
        head,
        "--",
        literalPathspec(finding.file),
      ],
      {
        encoding: "utf8",
        maxBuffer: GIT_DIFF_MAX_BUFFER_BYTES,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return diffTouchesSpan(diff, finding.line, finding.endLine);
  } catch {
    return null;
  }
}

function extractJson(text) {
  const t = String(text).trim();
  const cands = [];
  const fence = t.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fence) cands.push(fence[1]);
  cands.push(t);
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a !== -1 && b > a) cands.push(t.slice(a, b + 1));
  for (const c of [...cands]) cands.push(c.replace(/,(\s*[}\]])/g, "$1"));
  for (const c of cands) {
    try { const p = JSON.parse(c); if (p && Array.isArray(p.findings)) return p; } catch { /* next */ }
  }
  return null;
}

const cmd = process.argv[2];

if (cmd === "record") {
  const [file, base, head, analysisState, ...extra] = process.argv.slice(3);
  if (extra.length > 0 || !["complete", "inconclusive"].includes(analysisState)) {
    throw new TypeError("record requires an explicit complete or inconclusive analysis state");
  }
  const stagedTarget = process.env.AGENTIC_REVIEW_STAGED_TARGET ?? "";
  if (
    stagedTarget
    && (stagedTarget !== head || stagedTarget.length !== 40 || NON_LOWERCASE_HEX.test(stagedTarget))
  ) {
    throw new TypeError("AGENTIC_REVIEW_STAGED_TARGET must match the recorded head SHA");
  }
  const parsed = extractJson(readFileSync(file, "utf8"));
  if (!parsed) { console.error("unparseable findings"); process.exit(1); }
  const findings = parsed.findings.map((finding, index) => {
    const projected = projectPublicFinding(finding);
    if (!projected) throw new TypeError(`findings[${index}] is not a valid public finding`);
    return projected;
  });

  const summary = withStateMutation(() => {
    const state = load();
    // new Date(undefined) is Invalid Date, not "now" — the || undefined idiom
    // that works for numbers does not work for this constructor.
    const epoch = Number(process.env.RUN_EPOCH);
    const now = (Number.isFinite(epoch) && epoch > 0 ? new Date(epoch) : new Date()).toISOString();
    const seen = new Set();
    let fresh = 0, again = 0, muted = 0;

    for (const f of findings) {
      const known = state.findings.find((k) => sameFinding(k, f));
      if (known) {
        seen.add(known.id);
        known.lastSeen = now;
        known.count = (known.count ?? 1) + 1;
        known.severity = f.severity ?? known.severity;
        known.line = f.start_line ?? known.line;
        known.endLine = f.end_line ?? f.start_line ?? known.endLine;
        known.lastCommit = head;
        known.stagedTarget = Boolean(stagedTarget);
        if (known.status === "dismissed") { muted++; continue; }
        // Reported again after being marked gone: the defect returned, so the
        // record has to return with it rather than staying closed forever.
        if (known.status === "gone") { known.status = "open"; delete known.goneAt; }
        again++;
      } else {
        const id = idFor(f);
        seen.add(id);
        state.findings.push({
          id, file: f.file, title: f.title, body: f.body, severity: f.severity,
          line: f.start_line, endLine: f.end_line ?? f.start_line, status: "open",
          firstSeen: now, lastSeen: now, firstCommit: head, lastCommit: head,
          stagedTarget: Boolean(stagedTarget), count: 1,
        });
        fresh++;
      }
    }
    // Anything previously open and not reported now retires only after a changed
    // hunk overlaps its latest confirmed span. Unrelated changes, invalid spans,
    // and indeterminate Git results retain the finding.
    let retired = 0, unexplained = 0;
    for (const k of state.findings) {
      if (k.status !== "open" || seen.has(k.id)) continue;
      if (analysisState !== "complete") { unexplained++; continue; }
      const changed = spanChangedSince(k, head);
      if (changeIsConfirmed(changed)) { k.status = "gone"; k.goneAt = now; retired++; }
      else unexplained++;
    }

    mkdirSync(RUNS_DIR, { recursive: true });
    const stamp = now.replace(/[:.]/g, "-");
    publishJson(join(RUNS_DIR, `${stamp}.json`), {
      at: now,
      base,
      head,
      analysis_state: analysisState,
      branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
      findings,
    });
    // A staged worktree may be the target's only other reachability. Add its ref
    // before persisting ownership, then prune only after the new state is durable.
    retainStagedTarget(state, stagedTarget);
    save(state);
    pruneUnownedStagedTargets(state);

    const bits = [`${fresh} new`, `${again} recurring`];
    if (muted) bits.push(`${muted} dismissed`);
    if (retired) bits.push(`${retired} gone`);
    if (unexplained) bits.push(`${unexplained} unreported without confirmed overlap`);
    return bits.join(", ");
  });
  console.log(summary);
  process.exit(0);
}

if (cmd === "export-open") {
  const state = load();
  const findings = state.findings
    .filter((finding) => finding.status === "open")
    .map((finding) => ({
      file: finding.file,
      title: finding.title,
      body: finding.body,
      severity: finding.severity,
      start_line: finding.line,
      end_line: finding.endLine,
      suggestion: null,
    }));
  process.stdout.write(`${JSON.stringify({ findings })}\n`);
  process.exit(0);
}

if (cmd === "list") {
  const which = process.argv[3] ?? "open";
  const state = load();
  const rank = { Critical: 0, High: 1, Medium: 2 };
  const rows = state.findings
    .filter((f) => which === "all" || f.status === which)
    .sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
  if (!rows.length) { console.log(`no ${which} findings`); process.exit(0); }
  for (const f of rows) {
    const age = f.count > 1 ? ` ×${f.count}` : "";
    const flag = f.status === "dismissed" ? " [dismissed]" : f.status === "gone" ? " [gone]" : "";
    console.log(`  ${f.id}  ${String(f.severity ?? "?").padEnd(8)} ${String(f.file).slice(-38).padEnd(38)}:${String(f.line ?? "").padEnd(4)} ${f.title}${age}${flag}`);
  }
  process.exit(0);
}

if (cmd === "dismiss" || cmd === "reopen") {
  const ids = process.argv.slice(3);
  const n = withStateMutation(() => {
    const state = load();
    const stagedTargetsToRestore = new Set();
    if (cmd === "reopen") {
      for (const f of state.findings) {
        if (ids.includes(f.id) && f.status !== "open" && f.stagedTarget === true) {
          stagedTargetsToRestore.add(f.lastCommit);
        }
      }
      for (const target of stagedTargetsToRestore) {
        git(["cat-file", "-e", `${target}^{commit}`]);
      }
    }

    let updated = 0;
    for (const f of state.findings) {
      if (!ids.includes(f.id)) continue;
      f.status = cmd === "dismiss" ? "dismissed" : "open";
      delete f.goneAt;
      updated++;
    }
    for (const target of stagedTargetsToRestore) retainStagedTarget(state, target);
    save(state);
    pruneUnownedStagedTargets(state);
    return updated;
  });
  console.log(`${cmd === "dismiss" ? "dismissed" : "reopened"} ${n}`);
  process.exit(0);
}

if (cmd === "runs") {
  if (!existsSync(RUNS_DIR)) { console.log("no runs recorded"); process.exit(0); }
  const files = readdirSync(RUNS_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, 20);
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(join(RUNS_DIR, f), "utf8"));
      console.log(`  ${r.at}  ${String(r.branch).slice(0, 24).padEnd(24)} ${String(r.findings.length).padStart(3)} findings  ${String(r.head ?? "").slice(0, 8)}`);
    } catch { /* skip */ }
  }
  process.exit(0);
}

console.error("usage: local-state.mjs record|export-open|list|dismiss|reopen|runs");
process.exit(2);
