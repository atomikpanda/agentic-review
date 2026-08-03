#!/usr/bin/env node
// Merge the findings from repeated review passes into one set, recording how
// many passes saw each one.
//
// WHY REPEAT AT ALL. The same model, same input, disagrees with itself: two
// luna runs over an identical diff overlapped on only 5 of 9 findings — about
// the same as its overlap with an entirely different model. Non-determinism at
// that scale means one pass systematically under-reports, and measurement bears
// it out: one pass reproduced 5 of 11 known findings, three passes reproduced 7.
//
// WHY UNION AND NOT MAJORITY VOTE, by default. Cursor's Bugbot discards
// findings seen in only one of eight passes, and with eight that is sound. At
// three it is not: on this project's benchmark the two findings recovered by
// repeat sampling — `BucketAlreadyExists` and the lib.sh quoting bug — each
// appeared in exactly ONE pass and are both real. A majority rule would have
// thrown away precisely what the extra passes bought. So the default keeps
// everything and reports the vote count; raise --min-votes once a validator
// stage exists to catch what the union drags in.
//
// Usage: merge-findings.mjs [--min-votes N] file1.json file2.json ...
//        reads the agent's raw output (bare JSON, fenced, or prose-wrapped)

import { readFileSync } from "node:fs";
import { sameFinding, SIMILARITY_DEFAULT } from "./lib-findings.mjs";

const args = process.argv.slice(2);
let minVotes = 1;
let checkOnly = false;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--min-votes") { minVotes = Number(args[++i]) || 1; continue; }
  if (args[i] === "--check") { checkOnly = true; continue; }
  files.push(args[i]);
}

function extractJson(text) {
  const t = String(text).trim();
  const cands = [];
  const fence = t.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fence) cands.push(fence[1]);
  cands.push(t);
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a !== -1 && b > a) cands.push(t.slice(a, b + 1));
  for (const c of cands) {
    try {
      const p = JSON.parse(c);
      if (p && Array.isArray(p.findings)) return p;
    } catch { /* next */ }
  }
  return null;
}

// --check: exit 0 if the file holds parseable findings. omp offers no
// structured-output mode — grepping the bundle finds no json_schema and
// response_format only in image generation — so the contract cannot be enforced
// at the API and has to be verified after the fact.
if (checkOnly) {
  for (const f of files) {
    let ok = false;
    try { ok = !!extractJson(readFileSync(f, "utf8")); } catch { ok = false; }
    if (!ok) process.exit(1);
  }
  process.exit(0);
}

const merged = [];
let passes = 0;

for (const f of files) {
  let parsed;
  try { parsed = extractJson(readFileSync(f, "utf8")); } catch { parsed = null; }
  if (!parsed) { process.stderr.write(`  pass ${f}: unparseable, skipped\n`); continue; }
  passes++;
  for (const finding of parsed.findings) {
    if (!finding || typeof finding.file !== "string") continue;
    const hit = merged.find((m) => sameFinding(m, finding, SIMILARITY_DEFAULT));
    if (hit) {
      hit.votes++;
      // Keep the variant that carries a concrete fix, and the more severe
      // reading — a defect seen as Critical once and Medium twice is worth
      // showing at Critical.
      const rank = { Critical: 0, High: 1, Medium: 2 };
      if ((rank[finding.severity] ?? 9) < (rank[hit.severity] ?? 9)) hit.severity = finding.severity;
      if (!hit.suggestion && finding.suggestion) {
        hit.suggestion = finding.suggestion;
        hit.start_line = finding.start_line;
        hit.end_line = finding.end_line;
      }
    } else {
      merged.push({ ...finding, votes: 1 });
    }
  }
}

const kept = merged.filter((m) => m.votes >= minVotes);
const rank = { Critical: 0, High: 1, Medium: 2 };
kept.sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) || b.votes - a.votes);

process.stdout.write(JSON.stringify({ findings: kept, passes }, null, 2));
process.stderr.write(
  `  merged ${passes} pass(es): ${merged.length} distinct, ${kept.length} kept` +
    (minVotes > 1 ? ` (min-votes ${minVotes})` : "") +
    `; seen-once ${merged.filter((m) => m.votes === 1).length}\n`,
);
