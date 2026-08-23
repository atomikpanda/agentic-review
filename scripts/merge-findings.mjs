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

function compareVariants(a, b) {
  return compareText(String(a.file ?? "").replace(/^\.\//, ""), String(b.file ?? "").replace(/^\.\//, ""))
    || compareText(a.title, b.title)
    || compareText(a.body, b.body)
    || (Number(a.start_line) || 0) - (Number(b.start_line) || 0)
    || (Number(a.end_line) || 0) - (Number(b.end_line) || 0);
}

function mergeVariant(target, candidate) {
  const votes = target.votes;
  const severity = (SEVERITY_RANK[candidate.severity] ?? 9) < (SEVERITY_RANK[target.severity] ?? 9)
    ? candidate.severity
    : target.severity;
  const fixSource = [target, candidate]
    .filter((finding) => finding.suggestion)
    .sort((left, right) =>
      compareText(left.suggestion, right.suggestion)
      || (Number(left.start_line) || 0) - (Number(right.start_line) || 0)
      || (Number(left.end_line) || 0) - (Number(right.end_line) || 0))[0];
  const fix = fixSource ? { ...fixSource } : null;
  const representative = compareVariants(candidate, target) < 0 ? candidate : target;
  // Strongest evidence basis wins. Passes describe the same defect with
  // different confidence in what they actually saw; where one pass claims to
  // have observed or traced it, the surviving finding should not inherit a
  // weaker variant's guess — including via `representative` below.
  const evidenceKind = [target.evidence_kind, candidate.evidence_kind]
    .find((kind) => kind === "observed" || kind === "static-proof");
  Object.assign(target, representative);
  if (votes !== undefined) target.votes = votes;
  target.severity = severity;
  if (evidenceKind) target.evidence_kind = evidenceKind;
  if (fix) {
    target.suggestion = fix.suggestion;
    target.start_line = fix.start_line;
    target.end_line = fix.end_line;
  }
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
    const uniqueFindings = [];
    for (const rawFinding of parsed.findings) {
      const finding = projectPublicFinding(rawFinding);
      if (!finding) continue;
      const duplicate = uniqueFindings.find((candidate) =>
        sameFinding(candidate, finding, SIMILARITY_DEFAULT));
      if (duplicate) {
        mergeVariant(duplicate, finding);
      } else {
        uniqueFindings.push(finding);
      }
    }
    for (const finding of uniqueFindings) {
      const hit = merged.find((candidate) =>
        sameFinding(candidate, finding, SIMILARITY_DEFAULT));
      if (hit) {
        hit.votes++;
        mergeVariant(hit, finding);
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

export function filterKnownFindings(knownDocument, currentDocument) {
  if (!isValidDocument(knownDocument) || !isValidDocument(currentDocument)) {
    throw new TypeError("known and current findings must be valid structured documents");
  }
  return currentDocument.findings
    .filter((candidate) => (
      knownDocument.findings.some((known) =>
        sameFinding(candidate, known, SIMILARITY_DEFAULT))
      || (
        candidate.verification_classification === "linked_regression"
        && knownDocument.findings.some((known) =>
          known.verification_id === candidate.verification_of)
      )
    ))
    .map(projectPublicFinding);
}

function main(args) {
  let minVotes = 1;
  let checkOnly = false;
  let knownOnly = false;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--min-votes") { minVotes = Number(args[++i]) || 1; continue; }
    if (args[i] === "--check") { checkOnly = true; continue; }
    if (args[i] === "--known-only") { knownOnly = true; continue; }
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
  if (knownOnly) {
    if (files.length !== 2) return 2;
    let known = null;
    let current = null;
    try {
      known = extractJson(readFileSync(files[0], "utf8"), { strict: true });
      current = extractJson(readFileSync(files[1], "utf8"), { strict: true });
    } catch {
      return 1;
    }
    if (!known || !current) return 1;
    const findings = filterKnownFindings(known, current);
    const withheld = current.findings.length - findings.length;
    process.stdout.write(JSON.stringify({ findings }, null, 2));
    if (withheld > 0) {
      process.stderr.write(`  withheld ${withheld} unrelated verification finding(s)\n`);
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
