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
//   local-state.mjs record <findings.json> <base> <head>   merge a run into state
//   local-state.mjs list [open|all|dismissed]              print tracked findings
//   local-state.mjs export-open                           print open findings JSON
//   local-state.mjs dismiss <id>...                        stop reporting these
//   local-state.mjs reopen <id>...
//   local-state.mjs runs                                   past runs, newest first

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { sameFinding } from "./lib-findings.mjs";

const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const STATE_DIR = join(git(["rev-parse", "--git-common-dir"]), "agentic-review");
const RUNS_DIR = join(STATE_DIR, "runs");
const STATE_FILE = join(STATE_DIR, "state.json");

const load = () => {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return { findings: [] }; }
};
const save = (s) => {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
};

// Short, stable, human-typeable — these are meant to be passed to `dismiss`.
const idFor = (f) =>
  createHash("sha256")
    .update(`${f.file}::${String(f.title).toLowerCase().trim()}`)
    .digest("hex")
    .slice(0, 6);

function fileChangedSince(path, sinceCommit, head) {
  if (!path || !sinceCommit) return null;
  try {
    execFileSync("git", ["diff", "--quiet", sinceCommit, head, "--", path], { stdio: "ignore" });
    return false;
  } catch (e) {
    return e.status === 1 ? true : null;
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
  const [file, base, head] = process.argv.slice(3);
  const parsed = extractJson(readFileSync(file, "utf8"));
  if (!parsed) { console.error("unparseable findings"); process.exit(1); }

  const state = load();
  // new Date(undefined) is Invalid Date, not "now" — the || undefined idiom
  // that works for numbers does not work for this constructor.
  const epoch = Number(process.env.RUN_EPOCH);
  const now = (Number.isFinite(epoch) && epoch > 0 ? new Date(epoch) : new Date()).toISOString();
  const seen = new Set();
  let fresh = 0, again = 0, muted = 0;

  for (const f of parsed.findings) {
    const known = state.findings.find((k) => sameFinding(k, f));
    if (known) {
      seen.add(known.id);
      known.lastSeen = now;
      known.count = (known.count ?? 1) + 1;
      known.severity = f.severity ?? known.severity;
      known.line = f.start_line ?? known.line;
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
        line: f.start_line, status: "open", firstSeen: now, lastSeen: now,
        firstCommit: head, count: 1,
      });
      fresh++;
    }
  }

  // Anything previously open and not reported now: retired, but only when the
  // file it pointed at has changed. If nothing changed under it, the reviewer
  // just failed to mention it this time, which is not the same as fixed.
  let retired = 0, unexplained = 0;
  for (const k of state.findings) {
    if (k.status !== "open" || seen.has(k.id)) continue;
    const changed = fileChangedSince(k.file, k.firstCommit, head);
    if (changed === true) { k.status = "gone"; k.goneAt = now; retired++; }
    else unexplained++;
  }

  mkdirSync(RUNS_DIR, { recursive: true });
  const stamp = now.replace(/[:.]/g, "-");
  writeFileSync(join(RUNS_DIR, `${stamp}.json`), JSON.stringify(
    { at: now, base, head, branch: git(["rev-parse", "--abbrev-ref", "HEAD"]), findings: parsed.findings }, null, 2));
  save(state);

  const bits = [`${fresh} new`, `${again} recurring`];
  if (muted) bits.push(`${muted} dismissed`);
  if (retired) bits.push(`${retired} gone`);
  if (unexplained) bits.push(`${unexplained} unreported but unchanged`);
  console.log(bits.join(", "));
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
      end_line: finding.line,
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
  const state = load();
  let n = 0;
  for (const f of state.findings) {
    if (!ids.includes(f.id)) continue;
    f.status = cmd === "dismiss" ? "dismissed" : "open";
    n++;
  }
  save(state);
  console.log(`${cmd === "dismiss" ? "dismissed" : "reopened"} ${n}`);
  process.exit(0);
}

if (cmd === "runs") {
  if (!existsSync(RUNS_DIR)) { console.log("no runs recorded"); process.exit(0); }
  const files = readdirSync(RUNS_DIR).sort().reverse().slice(0, 20);
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
