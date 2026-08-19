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
import { pathToFileURL } from "node:url";
import {
  isValidFinding,
  projectPublicFinding,
  sameFinding,
  SIMILARITY_DEFAULT,
} from "./lib-findings.mjs";

const SEVERITY_RANK = { Critical: 0, High: 1, Medium: 2 };


function isValidDocument(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Array.isArray(value.findings)
    && value.findings.every(isValidFinding);
}

function extractJson(text, { strict = false } = {}) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;

  const candidates = [trimmed];
  if (!strict) {
    const fence = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (fence) candidates.unshift(fence[1]);
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (isValidDocument(parsed)) return parsed;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function compareText(a, b) {
  const left = String(a ?? "");
  const right = String(b ?? "");
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareFindings(a, b) {
  return (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9)
    || b.votes - a.votes
    || compareText(a.file, b.file)
    || (Number(a.start_line) || 0) - (Number(b.start_line) || 0)
    || (Number(a.end_line) || 0) - (Number(b.end_line) || 0)
    || compareText(a.title, b.title)
    || compareText(a.body, b.body);
}

export function mergeFindingDocuments(documents, { minVotes = 1 } = {}) {
  const merged = [];
  const statuses = [];
  let passes = 0;

  for (const document of documents) {
    const parsed = document && typeof document === "object"
      ? (isValidDocument(document) ? document : null)
      : extractJson(document);
    if (!parsed) {
      statuses.push({ status: "malformed", finding_count: 0 });
      continue;
    }

    passes++;
    statuses.push({ status: "valid", finding_count: parsed.findings.length });
    for (const rawFinding of parsed.findings) {
      const finding = projectPublicFinding(rawFinding);
      if (!finding) continue;
      const hit = merged.find((candidate) =>
        sameFinding(candidate, finding, SIMILARITY_DEFAULT));
      if (hit) {
        hit.votes++;
        // Keep the variant that carries a concrete fix, and the more severe
        // reading — a defect seen as Critical once and Medium twice is worth
        // showing at Critical.
        if ((SEVERITY_RANK[finding.severity] ?? 9) < (SEVERITY_RANK[hit.severity] ?? 9)) {
          hit.severity = finding.severity;
        }
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

  const kept = merged.filter((finding) => finding.votes >= minVotes);
  kept.sort(compareFindings);
  return {
    findings: kept,
    passes,
    statuses,
    summary: {
      distinct: merged.length,
      kept: kept.length,
      seen_once: merged.filter((finding) => finding.votes === 1).length,
    },
  };
}

function main(args) {
  let minVotes = 1;
  let checkOnly = false;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--min-votes") { minVotes = Number(args[++i]) || 1; continue; }
    if (args[i] === "--check") { checkOnly = true; continue; }
    files.push(args[i]);
  }

  // --check: exit 0 if every file holds a structured findings document. omp
  // offers no structured-output mode, so the contract is verified after the
  // fact. A JSON object embedded in prose is not a structured response.
  if (checkOnly) {
    for (const file of files) {
      let parsed = null;
      try { parsed = extractJson(readFileSync(file, "utf8"), { strict: true }); } catch { /* invalid */ }
      if (!parsed) return 1;
    }
    return 0;
  }

  const documents = files.map((file) => {
    try { return readFileSync(file, "utf8"); } catch { return null; }
  });
  const result = mergeFindingDocuments(documents, { minVotes });

  result.statuses.forEach((status, index) => {
    if (status.status === "malformed") {
      process.stderr.write(`  pass ${files[index]}: unparseable, skipped\n`);
    }
  });
  process.stdout.write(JSON.stringify({ findings: result.findings, passes: result.passes }, null, 2));
  process.stderr.write(
    `  merged ${result.passes} pass(es): ${result.summary.distinct} distinct, ` +
      `${result.summary.kept} kept` +
      (minVotes > 1 ? ` (min-votes ${minVotes})` : "") +
      `; seen-once ${result.summary.seen_once}\n`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
