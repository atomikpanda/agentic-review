#!/usr/bin/env node
// Turn the agent's JSON findings into a GitHub pull-request review with inline
// suggested changes.
//
// A "suggested fix" is not a formatting choice — it is a specific API shape.
// It has to be an inline review comment anchored to a line range that is part
// of this pull request's diff, whose body contains a ```suggestion block. The
// block replaces exactly the lines the comment spans, which is why anchoring
// has to be exact: a comment one line off produces a button that, when
// clicked, silently corrupts the file.
//
// The API rejects the ENTIRE review if any single comment is unanchorable, so
// every comment is validated against the real diff before sending, and there
// is a fallback that posts the findings as a plain summary rather than losing
// them.
//
// Plain node, no dependencies — it runs on any GitHub runner without a setup
// step, and does not depend on bun being present.
//
// Env:
//   REVIEW_PUBLICATION_FILE atomic findings, run metadata, and reviewed scope (required)
//   GITHUB_REPO           owner/name                           (required except RENDER)
//   PR_NUMBER             pull request number                  (required except RENDER)
//   GH_TOKEN              token with pull-requests: write (required except RENDER)
//   REVIEW_MODE           "summary" | "inline" | "suggest"     (default suggest)
//   DRY_RUN               "1" reads and reconciles but does not write
//   SUPPRESS_WRITES       "true" reads and reconciles but does not write
//   POST_COMMENT          "false" reads and reconciles but does not write
//   UNRESOLVED_FINDINGS_FILE prior local findings for RENDER only
//   RECONCILIATION_KNOWN    "false" prevents a clean RENDER result

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { deflateRawSync, inflateRawSync } from "node:zlib";

import {
  EVIDENCE_KINDS,
  identityTokens,
  isValidFinding,
  projectPublicFinding,
  sameFinding,
  similarity,
  SIMILARITY_DEFAULT,
  tokenSet,
} from "./lib-findings.mjs";
import {
  advanceReviewCycle,
  derivePublicationFailureResult,
  planReviewCycle,
  deriveReviewState,
  enrichRunMetadata,
  validateReviewCycle,
} from "./review-result.mjs";
import {
  GIT_DIFF_MAX_BUFFER_BYTES,
  changeIsConfirmed,
  diffTouchesSpan,
  literalPathspec,
} from "./thread-change.mjs";
const env = (k, d) => process.env[k] ?? d;
const required = (k) => {
  const v = process.env[k];
  if (!v) throw new TypeError(`${k} is not set`);
  return v;
};

// Findings are re-derived from scratch on every push, so without identity the
// same defect is posted again on each run. A stable fingerprint over file+title
// is embedded in each comment so a later run can recognise its own earlier
// remarks: repeat them silently, and resolve the ones it no longer makes.
const MARKER = "agentic-review-fp";
const fingerprint = (f) =>
  createHash("sha256")
    .update(`${String(f.file).trim()}::${String(f.title).trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 16);
// Strong kinds are recorded in the stamp so a finding reconstructed from an
// inline thread keeps its evidence basis; anything else decodes as inferred,
// which is what absence means. Old comments without the suffix stay readable.
const stamp = (fp, evidenceKind) =>
  "\n\n<!-- " + MARKER + ":" + fp
  + (evidenceKind === "observed" || evidenceKind === "static-proof" ? `:ek=${evidenceKind}` : "")
  + " -->";

const SUMMARY_MARKER = "agentic-review-summary";
const SUMMARY_MARKER_VERSION = 2;
const SUMMARY_STATE_MAX_BYTES = 1024 * 1024;
const SUMMARY_MARKER_RE = /<!-- agentic-review-summary:v(1|2):([A-Za-z0-9_-]+) -->\s*$/;
const SUMMARY_MARKER_PRESENT_RE = /<!-- agentic-review-summary:v\d+:[^>]*-->\s*$/;
const SUMMARY_SEVERITIES = ["Critical", "High", "Medium"];
const SUMMARY_SEVERITY_SET = new Set(SUMMARY_SEVERITIES);
const SUMMARY_TITLE_MAX_CHARS = 240;
const SUMMARY_IDENTITY_MAX_TOKENS = 32;
const SUMMARY_IDENTITY_TOKEN_MAX_CHARS = 64;
const HELD_FINDING_BODY = "Previously reported finding remains held from an earlier review sample.";
const SHA_RE = /^[0-9a-f]{40}$/;
const RUN_ID_RE = /^[1-9][0-9]*$/;

function summaryIdentityTokens(value) {
  const explicit = value && typeof value === "object" && Object.hasOwn(value, "identity_tokens");
  const tokens = identityTokens(value);
  if (
    !tokens
    || tokens.length === 0
    || (explicit && tokens.length > SUMMARY_IDENTITY_MAX_TOKENS)
    || (explicit && tokens.some((token) => token.length > SUMMARY_IDENTITY_TOKEN_MAX_CHARS))
  ) {
    throw new TypeError("summary finding identity_tokens must be non-empty bounded strings");
  }
  return tokens
    .slice(0, SUMMARY_IDENTITY_MAX_TOKENS)
    .map((token) => token.slice(0, SUMMARY_IDENTITY_TOKEN_MAX_CHARS));
}

function normalizeSummaryFinding(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`summary findings[${index}] must be an object`);
  }
  const file = String(value.file ?? "").replace(/^\.\//, "");
  const startLine = Number(value.start_line);
  const endLine = Number(value.end_line ?? value.start_line);
  if (!file || !Number.isInteger(startLine) || startLine < 1 || !Number.isInteger(endLine) || endLine < startLine) {
    throw new TypeError(`summary findings[${index}] must have a path and valid inclusive line span`);
  }
  if (!SUMMARY_SEVERITY_SET.has(value.severity)) {
    throw new TypeError(`summary findings[${index}].severity is invalid`);
  }
  if (typeof value.title !== "string" || !value.title || typeof value.body !== "string" || !value.body) {
    throw new TypeError(`summary findings[${index}] must have a title and body`);
  }
  if (value.evidence_kind !== undefined && !EVIDENCE_KINDS.has(value.evidence_kind)) {
    throw new TypeError(`summary findings[${index}].evidence_kind is invalid`);
  }
  return {
    file,
    start_line: startLine,
    end_line: endLine,
    severity: value.severity,
    title: value.title.slice(0, SUMMARY_TITLE_MAX_CHARS),
    body: HELD_FINDING_BODY,
    identity_tokens: summaryIdentityTokens(value),

    // Normalised to a definite kind so held findings keep their basis across
    // runs; absence (older prompts, legacy markers) means inferred.
    evidence_kind: value.evidence_kind === "observed" || value.evidence_kind === "static-proof"
      ? value.evidence_kind
      : "inferred",
  };
}

function encodeSummaryFinding(value, index) {
  const finding = normalizeSummaryFinding(value, index);
  return [
    finding.file,
    finding.start_line,
    finding.end_line,
    SUMMARY_SEVERITIES.indexOf(finding.severity),
    finding.title,
    finding.identity_tokens,
    finding.evidence_kind,
  ];
}

function decodeSummaryFinding(value, index) {
  // Length 6 is a pre-evidence_kind v2 marker; its findings decode as inferred,
  // which is what they are — carried forward without a stated basis.
  if (!Array.isArray(value) || !(value.length === 6 || value.length === 7) || !Array.isArray(value[5])) {
    throw new TypeError(`summary findings[${index}] has an invalid compact shape`);
  }
  const severity = SUMMARY_SEVERITIES[value[3]];
  return normalizeSummaryFinding({
    file: value[0],
    start_line: value[1],
    end_line: value[2],
    severity,
    title: value[4],
    body: HELD_FINDING_BODY,
    identity_tokens: value[5],
    evidence_kind: value.length === 7 ? value[6] : "inferred",
  }, index);
}


export function encodeSummaryMarker({ headSha, findings, cycle = null, runId = "" }) {
  if (!SHA_RE.test(headSha)) throw new TypeError("summary headSha must be a lowercase 40-character SHA");
  if (!Array.isArray(findings)) throw new TypeError("summary findings must be an array");
  if (runId !== "" && !RUN_ID_RE.test(runId)) {
    throw new TypeError("summary runId must be a positive decimal integer");
  }
  const version = cycle === null ? 1 : SUMMARY_MARKER_VERSION;
  const state = {
    h: headSha,
    f: findings.map(encodeSummaryFinding),
  };
  if (cycle !== null) state.c = validateReviewCycle(cycle);
  if (runId !== "") state.r = runId;
  const encoded = deflateRawSync(Buffer.from(JSON.stringify(state))).toString("base64url");
  return `<!-- ${SUMMARY_MARKER}:v${version}:${encoded} -->`;
}

export function decodeSummaryMarker(body) {
  const match = String(body ?? "").match(SUMMARY_MARKER_RE);
  if (!match) return null;
  try {
    const version = Number(match[1]);
    const text = inflateRawSync(Buffer.from(match[2], "base64url"), {
      maxOutputLength: SUMMARY_STATE_MAX_BYTES,
    }).toString("utf8");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !SHA_RE.test(parsed.h)) {
      return null;
    }
    if (!Array.isArray(parsed.f)) return null;
    const decoded = {
      head_sha: parsed.h,
      findings: parsed.f.map(decodeSummaryFinding),
    };
    if (version === 2) decoded.cycle = validateReviewCycle(parsed.c);
    if (parsed.r !== undefined) {
      if (typeof parsed.r !== "string" || !RUN_ID_RE.test(parsed.r)) return null;
      decoded.run_id = parsed.r;
    }
    return decoded;
  } catch {
    return null;
  }
}

function isBotComment(comment, botLogin) {
  return comment?.user?.type === "Bot"
    && typeof botLogin === "string"
    && comment?.user?.login === botLogin;
}

export function selectSummaryHistory(comments, { botLogin } = {}) {
  const candidates = (Array.isArray(comments) ? comments : [])
    .filter((comment) => isBotComment(comment, botLogin) && SUMMARY_MARKER_PRESENT_RE.test(String(comment.body ?? "")))
    .sort((left, right) => {
      const leftMarker = decodeSummaryMarker(left.body);
      const rightMarker = decodeSummaryMarker(right.body);
      if (leftMarker?.run_id && rightMarker?.run_id) {
        const byRun = BigInt(rightMarker.run_id) - BigInt(leftMarker.run_id);
        if (byRun !== 0n) return byRun > 0n ? 1 : -1;
      } else if (leftMarker?.run_id || rightMarker?.run_id) {
        return rightMarker?.run_id ? 1 : -1;
      }
      const leftTime = String(left.submitted_at ?? left.created_at ?? "");
      const rightTime = String(right.submitted_at ?? right.created_at ?? "");
      const byTime = rightTime.localeCompare(leftTime);
      return byTime || Number(right.id ?? 0) - Number(left.id ?? 0);
    });
  if (candidates.length === 0) {
    return { comment: null, findings: [], headSha: null, reconciliationKnown: true };
  }
  const comment = candidates[0];
  const decoded = decodeSummaryMarker(comment.body);
  if (!decoded) {
    return { comment, findings: [], headSha: null, reconciliationKnown: false };
  }
  return {
    comment,
    findings: decoded.findings,
    headSha: decoded.head_sha,
    ...(decoded.cycle ? { cycle: decoded.cycle } : {}),
    ...(decoded.run_id ? { runId: decoded.run_id } : {}),
    reconciliationKnown: true,
  };
}

export function planHostedReviewCycle({
  reviews = [],
  comments = [],
  botLogin,
  baseSha,
  headSha,
  maxDiscoveryRounds = 2,
  override = null,
  isAncestor = () => true,
}) {
  const selected = selectSummaryHistory([...reviews, ...comments], { botLogin });
  if (!selected.reconciliationKnown) {
    throw new TypeError("trusted hosted review-cycle state is malformed");
  }
  const headLineageValid = selected.headSha === null
    || selected.headSha === headSha
    || isAncestor(selected.headSha, headSha);
  const baseLineageValid = selected.cycle === undefined
    || selected.cycle.lineage_base_sha === baseSha
    || isAncestor(selected.cycle.lineage_base_sha, baseSha);
  const lineageValid = headLineageValid && baseLineageValid;
  return planReviewCycle({
    priorCycle: selected.cycle ?? null,
    priorHeadSha: selected.headSha,
    priorFindings: selected.findings,
    baseSha,
    headSha,
    maxDiscoveryRounds,
    override,
    lineageValid,
  });
}

function summaryFindingSimilarity(left, right) {
  const leftFile = String(left.file ?? "").replace(/^\.\//, "");
  const rightFile = String(right.file ?? "").replace(/^\.\//, "");
  if (leftFile !== rightFile) return -1;
  return similarity(
    new Set(summaryIdentityTokens(left)),
    new Set(summaryIdentityTokens(right)),
  );
}

function maximumSummaryFindingMatching(current, prior) {
  const rowCount = current.length;
  const columnCount = prior.length + rowCount;
  const costs = current.map((candidate) => [
    ...prior.map((previous) => {
      const score = summaryFindingSimilarity(candidate, previous);
      return score >= SIMILARITY ? -score : Number.POSITIVE_INFINITY;
    }),
    ...Array(rowCount).fill(0),
  ]);
  const rowPotential = Array(rowCount + 1).fill(0);
  const columnPotential = Array(columnCount + 1).fill(0);
  const assignedRow = Array(columnCount + 1).fill(0);
  const previousColumn = Array(columnCount + 1).fill(0);

  // Hungarian assignment is global rather than candidate-greedy. Strict
  // comparisons retain current order, then prior order, across equal optima.
  for (let row = 1; row <= rowCount; row += 1) {
    assignedRow[0] = row;
    const minimum = Array(columnCount + 1).fill(Number.POSITIVE_INFINITY);
    const visited = Array(columnCount + 1).fill(false);
    let column = 0;
    do {
      visited[column] = true;
      const assigned = assignedRow[column];
      let delta = Number.POSITIVE_INFINITY;
      let nextColumn = 0;
      for (let candidateColumn = 1; candidateColumn <= columnCount; candidateColumn += 1) {
        if (visited[candidateColumn]) continue;
        const reducedCost = costs[assigned - 1][candidateColumn - 1]
          - rowPotential[assigned] - columnPotential[candidateColumn];
        if (reducedCost < minimum[candidateColumn]) {
          minimum[candidateColumn] = reducedCost;
          previousColumn[candidateColumn] = column;
        }
        if (minimum[candidateColumn] < delta) {
          delta = minimum[candidateColumn];
          nextColumn = candidateColumn;
        }
      }
      for (let candidateColumn = 0; candidateColumn <= columnCount; candidateColumn += 1) {
        if (visited[candidateColumn]) {
          rowPotential[assignedRow[candidateColumn]] += delta;
          columnPotential[candidateColumn] -= delta;
        } else {
          minimum[candidateColumn] -= delta;
        }
      }
      column = nextColumn;
    } while (assignedRow[column] !== 0);

    do {
      const preceding = previousColumn[column];
      assignedRow[column] = assignedRow[preceding];
      column = preceding;
    } while (column !== 0);
  }

  const matchedPrior = Array(rowCount).fill(null);
  for (let column = 1; column <= prior.length; column += 1) {
    const row = assignedRow[column];
    if (row !== 0 && Number.isFinite(costs[row - 1][column - 1])) {
      matchedPrior[row - 1] = column - 1;
    }
  }
  return matchedPrior;
}

export async function reconcileSummaryFindings({
  analysisState,
  current,
  prior,
  priorHeadSha,
  headSha,
  spanChanged,
}) {
  const matchedPriorByCurrent = maximumSummaryFindingMatching(current, prior);
  const matchedPrior = new Set(
    matchedPriorByCurrent.filter((index) => index !== null),
  );
  const reconciledCurrent = current.map((candidate, index) => {
    const priorIndex = matchedPriorByCurrent[index];
    return priorIndex === null
      ? candidate
      : withStrongestSeverity(candidate, prior[priorIndex]);
  });

  const held = [];
  const retired = [];
  let reconciliationKnown = true;
  for (const [index, previous] of prior.entries()) {
    if (matchedPrior.has(index)) continue;
    let changed = null;
    try {
      changed = await spanChanged(previous, priorHeadSha, headSha);
    } catch {
      reconciliationKnown = false;
    }
    if (analysisState === "complete" && changeIsConfirmed(changed)) retired.push(previous);
    else held.push(previous);
  }
  return { current: reconciledCurrent, held, retired, reconciliationKnown };
}

// A hash over file+title only matches when the model phrases a finding exactly
// as before, and it does not: the same defect came back on this pull request as
// "bun_version input is not passed to setup-bun", "Configured Bun version is
// ignored" and "Configured Bun version is not passed to setup-bun". Each new
// wording produced a fresh thread AND left the old one un-retired.
//
// Identity here is inherently fuzzy, so it is compared fuzzily: Jaccard overlap
// of significant words, within the same file. Measured on this PR's real
// duplicates, pairs that are the same issue score 0.37-0.49 and pairs that are
// different issues score 0.03-0.16, so the threshold sits between them.

const SIMILARITY = Number(env("SIMILARITY", String(SIMILARITY_DEFAULT)));
const readStamp = (body) => {
  const m = String(body ?? "")
    .match(new RegExp(`<!-- ${MARKER}:([0-9a-f]{16})(?::ek=(observed|static-proof|inferred))? -->`));
  return m ? { fingerprint: m[1], ...(m[2] ? { evidenceKind: m[2] } : {}) } : null;
};
const REVIEW_MODE = env("REVIEW_MODE", "suggest");
// One switch blocks every pull-request mutation while preserving reads, state
// reconciliation, outputs, and gate enforcement.
const WRITES_ENABLED = env("DRY_RUN", "") !== "1"
  && env("SUPPRESS_WRITES", "") !== "true"
  && env("POST_COMMENT", "true") !== "false";
const DRY_RUN = !WRITES_ENABLED;

// ---------------------------------------------------------------------------
// 1. Extract the JSON object from the agent's output.
//
// The prompt asks for bare JSON, but models wrap it in a fence often enough
// that not handling it would mean discarding a whole review over punctuation.
// ---------------------------------------------------------------------------
function extractJson(text) {
  const trimmed = text.trim();
  const candidates = [];

  const fence = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fence) candidates.push(fence[1]);
  candidates.push(trimmed);

  // Last resort: the outermost braces.
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));

  // Trailing commas. JSON.parse rejects `{"a":1,}` outright, and models emit it
  // often enough that this reviewer lost a whole run to it — the findings were
  // complete and correct and went out as prose. Stripping them is safe here
  // because the only commas removed are ones immediately before } or ].
  for (const c of [...candidates]) candidates.push(c.replace(/,(\s*[}\]])/g, "$1"));

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && Array.isArray(parsed.findings) && parsed.findings.every(isValidFinding)) {
        return {
          ...parsed,
          findings: parsed.findings.map(projectPublicFinding),
        };
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2. Work out which (file, line) pairs GitHub will actually accept.
//
// A comment must land inside a diff hunk, and the line number is on the new
// side of the diff. Parsing the hunk headers is the only way to know this
// before sending; the alternative is discovering it from a 422 that takes the
// whole review down with it.
// ---------------------------------------------------------------------------
function commentableRanges(baseSha, headSha) {
  const diff = execFileSync(
    "git",
    ["diff", "--no-ext-diff", "--no-textconv", "--unified=3", "--no-color", `${baseSha}`, `${headSha}`],
    { encoding: "utf8", maxBuffer: GIT_DIFF_MAX_BUFFER_BYTES },
  );

  const byFile = new Map();
  let file = null;
  let inHeader = false;
  for (const line of diff.split("\n")) {
    // `diff --git` is the authoritative file delimiter. Keying on a bare
    // "+++ " prefix misreads CONTENT: an added line that itself begins with
    // "+++ " — reviewing a patch file, or documentation containing a diff
    // snippet, both of which this repository has — would be taken as a new
    // file header, and every later hunk would be attributed to the wrong path.
    if (line.startsWith("diff --git ")) {
      file = null;
      inHeader = true;
      continue;
    }
    if (inHeader && line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      // /dev/null means the file was deleted — nothing to comment on.
      file = p === "/dev/null" ? null : p.replace(/^b\//, "");
      if (file && !byFile.has(file)) byFile.set(file, []);
      inHeader = false;
      continue;
    }
    if (file && line.startsWith("@@")) {
      // @@ -old,count +new,count @@
      const m = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (!m) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (count > 0) byFile.get(file).push([start, start + count - 1]);
    }
  }
  return byFile;
}

const inRange = (ranges, start, end) =>
  ranges.some(([lo, hi]) => start >= lo && end <= hi);

// ---------------------------------------------------------------------------
// 3. Build the comment bodies.
// ---------------------------------------------------------------------------
// A suggestion containing a fence would terminate the block early and produce
// a broken button, so the fence grows to outrun anything inside it.
function fenceFor(text) {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

function commentBody(f, withSuggestion) {
  const parts = [`${badge(f.severity)} — **${f.title}**`, "", f.body];
  const note = evidenceNote(f);
  if (note) parts.push("", note);
  if (withSuggestion && typeof f.suggestion === "string" && f.suggestion.length > 0) {
    // Trailing newline is stripped: the block's lines replace the target lines
    // exactly, and an extra blank line at the end inserts one into the file.
    const body = f.suggestion.replace(/\n+$/, "");
    const fence = fenceFor(body);
    parts.push("", `${fence}suggestion`, body, fence);
  }
  return parts.join("\n") + stamp(fingerprint(f), f.evidence_kind);
}

// ---------------------------------------------------------------------------
// 4. Sort, validate, split into anchored comments and summary-only notes.
// ---------------------------------------------------------------------------
const SEVERITY_ORDER = { Critical: 0, High: 1, Medium: 2 };

export function buildReviewComments(findings, ranges, { mode = REVIEW_MODE } = {}) {
  const comments = [];
  const unanchored = [];

  const sorted = [...findings].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
  );

  for (const f of sorted) {
    if (!f || typeof f.file !== "string" || typeof f.body !== "string") {
      continue;
    }
    const file = f.file.replace(/^\.\//, "");
    const start = Number(f.start_line);
    const end = Number(f.end_line ?? f.start_line);

    const fileRanges = ranges.get(file);
    const anchorable =
      fileRanges &&
      Number.isInteger(start) &&
      Number.isInteger(end) &&
      start > 0 &&
      end >= start &&
      inRange(fileRanges, start, end);

    if (!anchorable) {
      // Not a failure. A real defect that happens to sit outside the diff
      // still needs reporting — it just cannot carry a button.
      unanchored.push({ ...f, file, reason: fileRanges ? "outside the diff" : "file not in the diff" });
      continue;
    }

    const body = boundedCommentBody(f, mode === "suggest");
    if (body === null) {
      unanchored.push({ ...f, file, reason: "suggestion exceeds GitHub comment limit" });
      continue;
    }
    const comment = {
      path: file,
      body,
      side: "RIGHT",
      line: end,
    };
    if (end > start) {
      comment.start_line = start;
      comment.start_side = "RIGHT";
    }
    comments.push(comment);
  }
  return { comments, unanchored };
}

// Severity vocabulary. P0/P1/P2 keeps existing inline comment presentation.
const PRIORITY = { Critical: "P0", High: "P1", Medium: "P2" };
const badge = (sev) => `\`${PRIORITY[sev] ?? "P2"}\` ${sev}`;

// Issue #4: a finding that asserts runtime behaviour it did not observe is a
// hypothesis however confident its prose — on this project's own PRs, every
// such claim failed a one-line check against the running system. Omission of
// the field means the same thing (the format says so), so anything short of an
// explicit observed/static-proof claim is marked unverified where a human
// acts on it, not buried in metadata.
const EVIDENCE_NOTE =
  "_Unverified: inferred from reading code, not confirmed against a running system._";
function evidenceNote(finding) {
  return finding.evidence_kind === "observed" || finding.evidence_kind === "static-proof"
    ? null
    : EVIDENCE_NOTE;
}

function formatCounts(counts) {
  return `Critical: ${counts.Critical} · High: ${counts.High} · Medium: ${counts.Medium}`;
}

function buildFinalResult(metadata, state, {
  reconciliationKnown = true,
  executionFailed = false,
  resultMetadata,
  cycle = null,
} = {}) {
  const enriched = resultMetadata ?? enrichRunMetadata(metadata, {
    scopeHash: metadata.scope_hash,
    reconciliationKnown,
    executionFailed,
  });
  const converged = executionFailed ? false : (state.converged ?? state.bounded_converged);
  return {
    analysis_state: state.analysis_state,
    merge_state: state.merge_state,
    sample_state: state.sample_state,
    bounded_converged: converged,
    base_sha: metadata.base_sha ?? "",
    head_sha: metadata.head_sha ?? "",
    configuration_fingerprint: metadata.configuration_fingerprint ?? "",
    passes_requested: metadata.passes?.requested?.length ?? 0,
    passes_completed: metadata.passes?.completed?.length ?? 0,
    current_counts: state.current_counts,
    unresolved_counts: state.unresolved_counts,
    reviewed_head: enriched.reviewed_head,
    scope_hash: enriched.scope_hash,
    coverage: enriched.coverage,
    remaining_analysis: enriched.remaining_analysis,
    converged,
    ...(cycle ? { review_cycle: cycle } : {}),
  };
}

function renderFinalResultTable(result) {
  return [
    "| Result | Value |",
    "| --- | --- |",
    `| Analysis | \`${result.analysis_state}\` |`,
    `| Merge gate | \`${result.merge_state}\` |`,
    `| Sample | \`${result.sample_state}\` |`,
    `| Bounded convergence | \`${result.bounded_converged ? "yes" : "no"}\` |`,
    `| Reviewed head | \`${result.reviewed_head}\` |`,
    `| Scope hash | \`${result.scope_hash}\` |`,
    `| Coverage | \`${result.coverage}\` |`,
    `| Remaining analysis | \`${JSON.stringify(result.remaining_analysis)}\` |`,
    ...(result.review_cycle
      ? [`| Review cycle | \`${result.review_cycle.state}\` · phase \`${result.review_cycle.last_phase}\` · discovery ${result.review_cycle.discovery_round}/${result.review_cycle.max_discovery_rounds} |`]
      : []),
    `| Converged | \`${result.converged}\` |`,
    `| Base SHA | \`${result.base_sha}\` |`,
    `| Head SHA | \`${result.head_sha}\` |`,
    `| Configuration fingerprint | \`${result.configuration_fingerprint}\` |`,
    `| Passes | \`${result.passes_requested} requested / ${result.passes_completed} completed\` |`,
    `| Current findings | \`${formatCounts(result.current_counts)}\` |`,
    `| Held/unresolved findings | \`${formatCounts(result.unresolved_counts)}\` |`,
  ].join("\n");
}

export function renderStateTable(metadata, state, resultOptions) {
  return renderFinalResultTable(buildFinalResult(metadata, state, resultOptions));
}

function appendFindings(out, heading, findings, mode) {
  if (findings.length === 0) return;
  out.push("", `#### ${heading}`, "");
  for (const finding of findings) {
    const start = finding.start_line;
    const end = finding.end_line ?? start;
    const span = start ? `:${start}${end !== start ? `-${end}` : ""}` : "";
    out.push(
      `${badge(finding.severity)} — **${finding.title}**`,
      "",
      `\`${String(finding.file).replace(/^\.\//, "")}${span}\``,
      "",
      finding.body,
    );
    const note = evidenceNote(finding);
    if (note) out.push("", note);
    if (mode === "suggest" && typeof finding.suggestion === "string" && finding.suggestion.length > 0) {
      const replacement = finding.suggestion.replace(/\n+$/, "");
      const fence = fenceFor(replacement);
      out.push("", `${fence}suggestion`, replacement, fence);
    }
    out.push("");
  }
  if (out.at(-1) === "") out.pop();
}

export function renderReviewBody({
  mode,
  metadata,
  state,
  current,
  unresolved,
  reconciliationKnown = true,
}) {
  if (!["summary", "inline", "suggest"].includes(mode)) {
    throw new TypeError("review mode must be summary, inline, or suggest");
  }
  const out = [
    "### Agentic review",
    "",
    renderStateTable(metadata, state, { reconciliationKnown }),
  ];
  appendFindings(out, "Current findings", current, mode);
  appendFindings(out, "Held findings", unresolved, mode);
  return out.join("\n");
}

export const GITHUB_COMMENT_MAX_BYTES = 65_536;
const COLLAPSED_ORIGINAL_LINE_MAX_BYTES = 2_048;

function fitUtf8Bytes(value, maxBytes, suffix = "") {
  const text = String(value ?? "");
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const suffixBytes = Buffer.byteLength(suffix);
  if (suffixBytes > maxBytes) throw new RangeError("UTF-8 suffix exceeds byte budget");
  const available = maxBytes - suffixBytes;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle)) <= available) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1])) low -= 1;
  return `${text.slice(0, low)}${suffix}`;
}

function boundedCommentBody(finding, withSuggestion) {
  const full = commentBody(finding, withSuggestion);
  if (Buffer.byteLength(full) <= GITHUB_COMMENT_MAX_BYTES) return full;
  if (withSuggestion && typeof finding.suggestion === "string" && finding.suggestion.length > 0) {
    return null;
  }
  const ending = "\n\n_Comment truncated; complete finding remains in the structured artifact._"
    + stamp(fingerprint(finding), finding.evidence_kind);
  // The note sits between the title line and the body: truncation cuts from
  // the end so the note survives, and the badge stays on the first line where
  // thread reconstruction parses it.
  const note = evidenceNote(finding);
  const visible = `${badge(finding.severity)} — **${finding.title}**\n\n`
    + (note ? `${note}\n\n` : "")
    + finding.body;
  return fitUtf8Bytes(visible, GITHUB_COMMENT_MAX_BYTES, ending);
}

function compactFindingLine(label, finding) {
  const start = Number(finding.start_line);
  const end = Number(finding.end_line ?? finding.start_line);
  const span = Number.isInteger(start)
    ? `:${start}${Number.isInteger(end) && end !== start ? `-${end}` : ""}`
    : "";
  const path = fitUtf8Bytes(String(finding.file ?? "").replace(/^\.\//, ""), 512, "…");
  const title = fitUtf8Bytes(String(finding.title ?? "").trim(), 512, "…");
  return `- ${label} ${badge(finding.severity)} — **${title}** (\`${path}${span}\`)`
    + (evidenceNote(finding) ? " · _unverified_" : "");
}

export function buildReviewTopBody({
  mode,
  metadata,
  state,
  current,
  unresolved,
  reconciliationKnown = true,
}) {
  const full = renderReviewBody({
    mode,
    metadata,
    state,
    current,
    unresolved,
    reconciliationKnown,
  });
  if (Buffer.byteLength(full) <= GITHUB_COMMENT_MAX_BYTES) return full;

  const out = [
    "### Agentic review",
    "",
    renderStateTable(metadata, state, { reconciliationKnown }),
    "",
  ];
  let omitted = 0;
  const footer = "_Finding prose was compacted for GitHub's request limit; complete findings and "
    + "suggestions remain in the structured review artifact._";
  for (const [label, findings] of [["Current:", current], ["Held:", unresolved]]) {
    for (const finding of findings) {
      const line = compactFindingLine(label, finding);
      const candidate = [...out, line, "", footer].join("\n");
      if (Buffer.byteLength(candidate) <= GITHUB_COMMENT_MAX_BYTES) out.push(line);
      else omitted += 1;
    }
  }
  if (omitted > 0) {
    const note = `- ${omitted} additional finding(s) omitted from this body.`;
    const candidate = [...out, note, "", footer].join("\n");
    if (Buffer.byteLength(candidate) <= GITHUB_COMMENT_MAX_BYTES) out.push(note);
  }
  out.push("", footer);
  const body = out.join("\n");
  if (Buffer.byteLength(body) > GITHUB_COMMENT_MAX_BYTES) {
    throw new RangeError("review body safety state exceeds GitHub comment limit");
  }
  return body;
}

export function assertReviewPayloadBudget(payload) {
  if (typeof payload?.body !== "string" || Buffer.byteLength(payload.body) > GITHUB_COMMENT_MAX_BYTES) {
    throw new RangeError("review body exceeds GitHub comment limit");
  }
  for (const [index, comment] of (payload.comments ?? []).entries()) {
    if (typeof comment?.body !== "string" || Buffer.byteLength(comment.body) > GITHUB_COMMENT_MAX_BYTES) {
      throw new RangeError(`review comment ${index} exceeds GitHub comment limit`);
    }
  }
  return payload;
}

export function reviewFallbackPayload(payload) {
  return assertReviewPayloadBudget({
    commit_id: payload.commit_id,
    event: payload.event,
    body: payload.body,
  });
}

export function buildStandingSummaryBody({
  metadata,
  state,
  cycle = null,
  current,
  unresolved,
  reconciliationKnown = true,
}) {
  const marker = encodeSummaryMarker({
    headSha: metadata.head_sha,
    findings: [...current, ...unresolved],
    cycle,
    runId: env("GITHUB_RUN_ID", ""),
  });
  const full = `${renderReviewBody({
    mode: "summary",
    metadata,
    state,
    current,
    unresolved,
    reconciliationKnown,
  })}\n\n${marker}`;
  if (Buffer.byteLength(full) <= GITHUB_COMMENT_MAX_BYTES) return full;

  const safetyOnly = `${renderReviewBody({
    mode: "summary",
    metadata,
    state,
    current: [],
    unresolved: [],
    reconciliationKnown,
  })}\n\n_Display details truncated to retain the complete standing review state._\n\n${marker}`;
  if (Buffer.byteLength(safetyOnly) > GITHUB_COMMENT_MAX_BYTES) {
    throw new RangeError("standing summary safety marker exceeds GitHub comment limit");
  }
  return safetyOnly;
}

export function emitWorkflowResult({
  metadata,
  state,
  outputFile,
  summaryFile,
  resultFile,
  reconciliationKnown = true,
  executionFailed = false,
  resultMetadata,
  cycle = null,
}) {
  const result = buildFinalResult(metadata, state, {
    reconciliationKnown,
    executionFailed,
    cycle,
    resultMetadata,
  });
  if (resultFile) writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
  if (outputFile) {
    appendFileSync(outputFile, [
      `analysis_state=${result.analysis_state}`,
      `merge_state=${result.merge_state}`,
      `sample_state=${result.sample_state}`,
      `bounded_converged=${result.bounded_converged}`,
      `base_sha=${result.base_sha}`,
      `head_sha=${result.head_sha}`,
      `configuration_fingerprint=${result.configuration_fingerprint}`,
      `passes_requested=${result.passes_requested}`,
      `passes_completed=${result.passes_completed}`,
      `current_counts=${JSON.stringify(result.current_counts)}`,
      `unresolved_counts=${JSON.stringify(result.unresolved_counts)}`,
      `reviewed_head=${result.reviewed_head}`,
      `scope_hash=${result.scope_hash}`,
      ...(result.review_cycle
        ? [
            `review_cycle_state=${result.review_cycle.state}`,
            `review_phase=${result.review_cycle.last_phase}`,
            `discovery_round=${result.review_cycle.discovery_round}`,
            `max_discovery_rounds=${result.review_cycle.max_discovery_rounds}`,
          ]
        : []),
      `coverage=${result.coverage}`,
      `remaining_analysis=${JSON.stringify(result.remaining_analysis)}`,
      `converged=${result.converged}`,
      "",
    ].join("\n"));
  }
  if (summaryFile) {
    appendFileSync(summaryFile, `## Agentic review\n\n${renderFinalResultTable(result)}\n`);
  }
}

export function shouldFailGate(state, failOnFindings) {
  return Boolean(failOnFindings) && state.merge_state === "blocked";
}

// ---------------------------------------------------------------------------
// 5. Post.
// ---------------------------------------------------------------------------
// --- GraphQL, because resolving a review thread has no REST equivalent -------
async function graphql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${required("GH_TOKEN")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.errors) {
    throw new Error(`graphql ${res.status}: ${JSON.stringify(json?.errors ?? {}).slice(0, 300)}`);
  }
  return json.data;
}

export async function fetchViewerLogin({ token, fetchImpl = fetch }) {
  const res = await fetchImpl("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query: "query { viewer { login } }" }),
  });
  const json = await res.json().catch(() => null);
  const login = json?.data?.viewer?.login;
  if (
    !res.ok
    || json?.errors
    || typeof login !== "string"
    || (!login.endsWith("[bot]") && login !== "github-actions")
  ) {
    throw new Error(`could not establish authenticated bot identity (${res.status})`);
  }
  return login;
}

export async function fetchSummaryComments({ repo, pr, token, fetchImpl = fetch }) {
  const comments = [];
  for (let page = 1; ; page += 1) {
    const res = await fetchImpl(
      `https://api.github.com/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (!res.ok) throw new Error(`GET issue comments ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const pageComments = await res.json();
    if (!Array.isArray(pageComments)) throw new Error("GET issue comments returned a non-array response");
    comments.push(...pageComments);
    if (pageComments.length < 100) return comments;
  }
}

export async function fetchSummaryReviews({ repo, pr, token, fetchImpl = fetch }) {
  const reviews = [];
  for (let page = 1; ; page += 1) {
    const res = await fetchImpl(
      `https://api.github.com/repos/${repo}/pulls/${pr}/reviews?per_page=100&page=${page}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (!res.ok) throw new Error(`GET pull request reviews ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const pageReviews = await res.json();
    if (!Array.isArray(pageReviews)) throw new Error("GET pull request reviews returned a non-array response");
    reviews.push(...pageReviews);
    if (pageReviews.length < 100) return reviews;
  }
}

export async function postSummaryReview({
  repo,
  pr,
  token,
  headSha,
  hasHistory,
  body,
  hasFindings,
  hasCycleState = false,
  writesEnabled,
  fetchImpl = fetch,
}) {
  if (!hasHistory && !hasFindings && !hasCycleState) return "skipped";
  if (!writesEnabled) return "suppressed";
  if (Buffer.byteLength(body) > GITHUB_COMMENT_MAX_BYTES) {
    throw new RangeError("summary review exceeds GitHub comment limit");
  }
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/pulls/${pr}/reviews`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ body, commit_id: headSha, event: "COMMENT" }),
  });
  if (!res.ok) {
    throw new Error(`POST summary review ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return "posted";
}

// Only threads authored by the authenticated token identity are ever touched.
export async function fetchOurThreads({
  owner,
  name,
  pr,
  botLogin,
  graphqlImpl = graphql,
}) {
  const out = [];
  let cursor = null;
  for (;;) {
    const data = await graphqlImpl(
      `query($owner:String!,$name:String!,$pr:Int!,$cursor:String){
         repository(owner:$owner,name:$name){
           pullRequest(number:$pr){
             reviewThreads(first:100,after:$cursor){
               nodes{ id isResolved isOutdated path originalStartLine originalLine
                      comments(first:1){ nodes{ databaseId body author{login}
                                                originalCommit{ oid } } } }
               pageInfo{ hasNextPage endCursor } } } } }`,
      { owner, name, pr: Number(pr), cursor },
    );
    const connection = data?.repository?.pullRequest?.reviewThreads;
    if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) {
      throw new Error("review thread query returned an invalid connection");
    }
    for (const thread of connection.nodes) {
      const comment = thread.comments?.nodes?.[0];
      const startLine = Number(thread.originalStartLine ?? thread.originalLine);
      const endLine = Number(thread.originalLine);
      const stampInfo = comment?.author?.login === botLogin ? readStamp(comment?.body) : null;
      if (stampInfo) {
        out.push({
          id: thread.id,
          fp: stampInfo.fingerprint,
          ...(stampInfo.evidenceKind ? { evidenceKind: stampInfo.evidenceKind } : {}),
          isResolved: thread.isResolved,
          commentId: comment?.databaseId,
          body: comment?.body ?? "",
          path: thread.path,
          origOid: comment?.originalCommit?.oid ?? null,
          startLine: Number.isInteger(startLine) && startLine > 0 ? startLine : null,
          endLine: Number.isInteger(endLine) && endLine > 0 ? endLine : null,
          retired: RETIRED_RE.test(comment?.body ?? ""),
          tokens: tokenSet(comment?.body ?? ""),
        });
      }
    }
    if (!connection.pageInfo.hasNextPage) return out;
    if (!connection.pageInfo.endCursor) throw new Error("review thread query omitted its next cursor");
    cursor = connection.pageInfo.endCursor;
  }
}

const RETIRED_RE = /^(?:✅|⚠️) \*\*No longer reported\*\*/;

// Did a changed hunk overlap the lines a thread was raised on? Thread spans are
// in original-commit coordinates, so compare them with the old side of a
// zero-context diff. Missing spans retain the conservative whole-file check.
const fileDiffCache = new Map();
function fileChangedSince(t, head) {
  if (!t.path || !t.origOid || !head) return null;
  if (t.origOid === head) return false;
  if (t.startLine && t.endLine) {
    const key = `${t.origOid}\0${head}\0${t.path}`;
    try {
      if (!fileDiffCache.has(key)) {
        fileDiffCache.set(
          key,
          execFileSync(
            "git",
            ["diff", "--unified=0", "--no-ext-diff", "--no-textconv", t.origOid, head, "--", literalPathspec(t.path)],
            {
              encoding: "utf8",
              maxBuffer: GIT_DIFF_MAX_BUFFER_BYTES,
              stdio: ["ignore", "pipe", "ignore"],
            },
          ),
        );
      }
      return diffTouchesSpan(fileDiffCache.get(key), t.startLine, t.endLine);
    } catch {
      return null;
    }
  }

  try {
    execFileSync("git", ["diff", "--no-ext-diff", "--no-textconv", "--quiet", t.origOid, head, "--", literalPathspec(t.path)], { stdio: "ignore" });
    return false;
  } catch (e) {
    return e.status === 1 ? true : null;
  }
}

function summarySpanChanged(finding, fromHead, toHead) {
  return fileChangedSince({
    path: String(finding.file).replace(/^\.\//, ""),
    origOid: fromHead,
    startLine: finding.start_line,
    endLine: finding.end_line ?? finding.start_line,
  }, toHead);
}

export function findingFromThread(thread) {
  const firstLine = String(thread.body ?? "").split("\n", 1)[0];
  const match = firstLine.match(/^`P[012]` (Critical|High|Medium) — \*\*(.+?)\*\*/);
  if (
    !thread.path
    || !match
    || !Number.isInteger(thread.startLine)
    || thread.startLine < 1
    || !Number.isInteger(thread.endLine)
    || thread.endLine < thread.startLine
  ) return null;
  return {
    file: thread.path,
    start_line: thread.startLine,
    end_line: thread.endLine,
    severity: match[1],
    title: match[2],
    body: thread.body,
    suggestion: null,

    // A strong kind survives in the comment's stamp; anything else was posted
    // without a stated basis and stays inferred.
    ...(thread.evidenceKind === "observed" || thread.evidenceKind === "static-proof"
      ? { evidence_kind: thread.evidenceKind }
      : {}),
  };
}

// "Fixed in <sha>" would be a nicer sentence and a false one. All that is known
// at this point is that THIS run did not raise the finding — not that anything
// fixed it, and not which commit would have. Models are documented to give
// inconsistent verdicts across runs of identical code, and this project has
// already seen the same defect come back under a reworded title.
//
// So the commit is reported as context, and one cheap check distinguishes the
// two cases: did a changed hunk overlap the original thread span? If it did not,
// the disappearance is unexplained and the note says so rather than implying a
// fix.
function retirementNote(t, head) {
  const short = head.slice(0, 7);
  const repo = required("GITHUB_REPO");
  const link = `[\`${short}\`](https://github.com/${repo}/commit/${head})`;
  const span = t.startLine === t.endLine ? `${t.startLine}` : `${t.startLine}-${t.endLine}`;
  const location = `\`${t.path}${t.startLine && t.endLine ? `:${span}` : ""}\``;

  if (!t.path || !t.origOid) {
    return `✅ **No longer reported** as of ${link}.`;
  }
  const changed = fileChangedSince(t, head);
  if (changed === true) {
    return `✅ **No longer reported** as of ${link} — ${location} has changed since this was raised.`;
  }
  if (changed === false) {
    return (
      `⚠️ **No longer reported** as of ${link} — but ${location} has **not changed** ` +
      `since this was raised, so nothing there was fixed. Treat it as unconfirmed: ` +
      `the reviewer may simply not have raised it on this run.`
    );
  }
  return `✅ **No longer reported** as of ${link}.`;
}

async function resolveThread(id) {
  if (DRY_RUN) { console.log(`  [suppressed] would resolve thread ${id}`); return; }
  await graphql(
    `mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ id } } }`,
    { id },
  );
}

// GITHUB_TOKEN cannot resolve review threads: resolveReviewThread answers
// FORBIDDEN / "Resource not accessible by integration" no matter what
// permissions the workflow declares. Only a PAT or a suitably-scoped App can.
//
// Editing our own review comment IS permitted, so a stale finding is marked and
// folded away instead. Less tidy than a resolved thread, same practical effect:
// the reader can see at a glance that the reviewer withdrew it.
function collapsedCommentBody(thread, head) {
  const note = retirementNote(thread, head);
  const full =
    `${note}\n\n` +
    `<details><summary>Original finding</summary>\n\n${thread.body}\n\n</details>`;
  if (Buffer.byteLength(full) <= GITHUB_COMMENT_MAX_BYTES) return full;

  // The replacement stamp must repeat the evidence kind, or a strong finding
  // decays to unverified the moment its comment is folded for size.
  const evidenceKind = thread.evidenceKind ?? readStamp(thread.body)?.evidenceKind;
  const collapseNote = evidenceNote({ evidence_kind: evidenceKind });
  const fp = readStamp(thread.body)?.fingerprint
    ?? (/^[0-9a-f]{16}$/.test(thread.fp ?? "") ? thread.fp : null);
  if (!fp) throw new RangeError("oversized stale comment has no authoritative identity marker");
  const firstLine = String(thread.body ?? "").split("\n", 1)[0];
  const original = fitUtf8Bytes(firstLine, COLLAPSED_ORIGINAL_LINE_MAX_BYTES, "…");
  const details =
    `<details><summary>Original finding</summary>\n\n${original}\n\n` +
    (collapseNote ? `${collapseNote}\n\n` : "") +
    `_Original finding prose omitted to satisfy GitHub's PATCH byte limit._\n\n</details>` +
    stamp(fp, evidenceKind);
  const noteBudget = GITHUB_COMMENT_MAX_BYTES - Buffer.byteLength(details) - 2;
  if (noteBudget < 1) throw new RangeError("stale comment identity history exceeds GitHub comment limit");
  return `${fitUtf8Bytes(note, noteBudget, "…")}\n\n${details}`;
}

export async function collapseComment(
  thread,
  head,
  { writesEnabled = !DRY_RUN, fetchImpl = fetch } = {},
) {
  if (!thread.commentId) return false;
  if (!writesEnabled) {
    console.log(`  [suppressed] would mark comment ${thread.commentId} as no longer reported`);
    return true;
  }
  if (RETIRED_RE.test(thread.body)) return false; // already done
  const repo = required("GITHUB_REPO");
  const payload = { body: collapsedCommentBody(thread, head) };
  assertReviewPayloadBudget(payload);
  const res = await fetchImpl(
    `https://api.github.com/repos/${repo}/pulls/comments/${thread.commentId}`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${required("GH_TOKEN")}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) throw new Error(`PATCH comment ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}

// Resolve if the token allows it; otherwise mark the comment. Falls back once
// and remembers, so a run with twenty stale threads makes one failed attempt
// rather than twenty.
let canResolveThreads = true;
async function retireThread(t, head) {
  if (canResolveThreads) {
    try {
      await resolveThread(t.id);
      return "resolved";
    } catch (e) {
      if (!/FORBIDDEN|not accessible/i.test(e.message)) throw e;
      canResolveThreads = false;
      console.log("::notice::this token cannot resolve review threads (GITHUB_TOKEN never can); marking stale findings instead");
    }
  }
  return (await collapseComment(t, head)) ? "marked" : "skipped";
}

async function postReview(payload) {
  assertReviewPayloadBudget(payload);
  if (DRY_RUN) {
    console.log("  [suppressed] would post a review with " + (payload.comments?.length ?? 0) + " inline comment(s)");
    return { ok: true, status: 0, text: "" };
  }
  const repo = required("GITHUB_REPO");
  const pr = required("PR_NUMBER");
  const res = await fetch(
    `https://api.github.com/repos/${repo}/pulls/${pr}/reviews`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${required("GH_TOKEN")}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify(payload),
    },
  );
  return { ok: res.ok, status: res.status, text: await res.text() };
}

function blockSeverities() {
  return env("BLOCK_SEVERITIES", "Critical,High")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function deriveState(metadata, current, unresolved, reconciliationKnown, evidenceReconciled = false) {
  return deriveReviewState({
    analysisState: metadata.analysis_state,
    current,
    unresolved,
    reconciliationKnown,
    blockSeverities: blockSeverities(),
    evidenceReconciled,
  });
}

function cycleAfterReview(plan, metadata, current, unresolved, reconciliationKnown) {
  if (plan === null) return null;
  return advanceReviewCycle({
    plan,
    analysisState: reconciliationKnown ? metadata.analysis_state : "inconclusive",
    headSha: metadata.head_sha,
    scopeHash: metadata.scope_hash,
    findings: [...current, ...unresolved],
    blockSeverities: blockSeverities(),
  });
}

function reviewStateForCycle(state, cycle) {
  if (cycle === null || cycle.state === "ready") return state;
  return {
    ...state,
    sample_state: state.sample_state === "clean" ? "unknown" : state.sample_state,
    bounded_converged: false,
    converged: false,
  };
}

function emitState(
  metadata,
  state,
  { reconciliationKnown = true, executionFailed = false, cycle = null } = {},
) {
  if (!executionFailed) {
    lastTrustworthyState = state;
    lastReconciliationKnown = reconciliationKnown;
    if (cycle !== null) lastReviewCycle = cycle;
  }
  emitWorkflowResult({
    metadata,
    state,
    outputFile: env("GITHUB_OUTPUT", ""),
    summaryFile: env("GITHUB_STEP_SUMMARY", ""),
    resultFile: env("REVIEW_RESULT_FILE", ""),
    reconciliationKnown,
    executionFailed,
    cycle,
  });
}

function enforceGate(state, cycle = null) {
  if (cycle?.state === "review_cycle_exhausted") {
    console.error(
      `::error::review cycle exhausted after ${cycle.discovery_round} discovery round(s); explicit human override required`,
    );
    process.exitCode = 1;
    return;
  }
  if (cycle?.state === "active") {
    console.error(`::error::review cycle requires ${cycle.next_phase} before it can become ready`);
    process.exitCode = 1;
    return;
  }
  if (shouldFailGate(state, env("FAIL_ON_FINDINGS", "false") === "true")) {
    const blocking = Object.entries(state.current_counts)
      .concat(Object.entries(state.unresolved_counts))
      .filter(([severity]) => blockSeverities().includes(severity))
      .reduce((total, [, count]) => total + count, 0);
    console.error(`::error::${blocking} blocking finding(s): ${blockSeverities().join(",")}`);
    process.exitCode = 1;
  }
}

function findStandingMatch(finding, threads, matched = null, unchangedAtHead = null) {
  const fp = fingerprint(finding);
  const exact = threads.find((thread) => (
    thread.fp === fp
    && !matched?.has(thread)
    && (unchangedAtHead === null || fileChangedSince(thread, unchangedAtHead) === false)
  ));
  if (exact) return exact;
  const tokens = new Set(identityTokens(finding));
  const file = String(finding.file).replace(/^\.\//, "");
  let best = null;
  let bestScore = 0;
  for (const thread of threads) {
    if (
      matched?.has(thread)
      || thread.path !== file
      || (unchangedAtHead !== null && fileChangedSince(thread, unchangedAtHead) !== false)
    ) {
      continue;
    }
    const score = similarity(tokens, thread.tokens);
    if (score > bestScore) {
      best = thread;
      bestScore = score;
    }
  }
  return bestScore >= SIMILARITY ? best : null;
}

async function loadReconciliationHistory({ repo, pr, token, botLogin, identityKnown }) {
  const summary = { comment: null, findings: [], headSha: null, reconciliationKnown: identityKnown };
  if (!identityKnown) return { summary, threads: [], threadsKnown: false };

  const [reviewsResult, legacyCommentsResult, threadsResult] = await Promise.allSettled([
    fetchSummaryReviews({ repo, pr, token }),
    fetchSummaryComments({ repo, pr, token }),
    (() => {
      const [owner, name] = repo.split("/");
      return fetchOurThreads({ owner, name, pr, botLogin });
    })(),
  ]);

  let selectedSummary = summary;
  if (reviewsResult.status === "fulfilled") {
    const records = [...reviewsResult.value];
    if (legacyCommentsResult.status === "fulfilled") {
      records.push(...legacyCommentsResult.value);
    } else {
      console.log(
        `::notice::legacy issue-comment summary history is unavailable (${legacyCommentsResult.reason?.message ?? legacyCommentsResult.reason})`,
      );
    }
    selectedSummary = selectSummaryHistory(records, { botLogin });
  } else {
    selectedSummary = { comment: null, findings: [], headSha: null, reconciliationKnown: false };
    console.log(
      `::warning::could not read pull-request review summary history (${reviewsResult.reason?.message ?? reviewsResult.reason})`,
    );
  }

  let threads = [];
  let threadsKnown = true;
  if (threadsResult.status === "fulfilled") {
    threads = threadsResult.value;
  } else {
    threadsKnown = false;
    console.log(
      `::warning::could not read existing review threads (${threadsResult.reason?.message ?? threadsResult.reason})`,
    );
  }
  return { summary: selectedSummary, threads, threadsKnown };
}

function historicalFindingKey(finding) {
  return JSON.stringify([
    finding.file,
    finding.start_line,
    finding.end_line,
    finding.title,
    finding.body,
    finding.suggestion ?? null,
    [...(finding.identity_tokens ?? [])].sort(),
  ]);
}

const EVIDENCE_RANK = { observed: 2, "static-proof": 1 };

function preferredHistoricalFinding(left, right) {
  const severityDifference = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
  if (severityDifference !== 0) {
    // Severity decides which record survives, but a losing record's stronger
    // basis must not be discarded along with it.
    const winner = severityDifference < 0 ? left : right;
    const loser = winner === left ? right : left;
    if ((EVIDENCE_RANK[winner.evidence_kind] ?? 0) < (EVIDENCE_RANK[loser.evidence_kind] ?? 0)) {
      return { ...winner, evidence_kind: loser.evidence_kind };
    }
    return winner;
  }
  // Equal severity: prefer the stronger basis before the lexical fallback.
  const evidenceDifference = (EVIDENCE_RANK[left.evidence_kind] ?? 0)
    - (EVIDENCE_RANK[right.evidence_kind] ?? 0);
  if (evidenceDifference !== 0) return evidenceDifference > 0 ? left : right;
  return historicalFindingKey(left) <= historicalFindingKey(right) ? left : right;
}

function withStrongestSeverity(current, historical) {
  // Severity carries over, and so does evidence basis: a finding whose
  // history claims observed or static-proof must not decay to unverified
  // just because this sample's wording was weaker.
  const merged = { ...current };
  if (SEVERITY_ORDER[historical.severity] < SEVERITY_ORDER[current.severity]) {
    merged.severity = historical.severity;
  }
  if (
    merged.evidence_kind !== "observed"
    && (historical.evidence_kind === "observed" || historical.evidence_kind === "static-proof")
  ) {
    merged.evidence_kind = historical.evidence_kind;
  }
  return merged;
}

function mergeFindingSets(primary, secondary, resolveMatch) {
  const merged = [...primary];
  const matched = new Set();
  for (const finding of secondary) {
    const match = primary.findIndex(
      (candidate, index) => !matched.has(index) && sameFinding(candidate, finding, SIMILARITY),
    );
    if (match < 0) {
      merged.push(finding);
    } else {
      matched.add(match);
      merged[match] = resolveMatch(primary[match], finding);
    }
  }
  return merged;
}

export async function reconcileHostedFindings({ metadata, findings, history, writesEnabled }) {
  const standing = history.threads.filter((thread) => !thread.isResolved && !thread.retired);
  const dismissed = history.threads.filter((thread) => thread.isResolved);
  const summaryReconciled = history.summary.reconciliationKnown
    ? await reconcileSummaryFindings({
      analysisState: metadata.analysis_state,
      current: findings,
      prior: history.summary.findings,
      priorHeadSha: history.summary.headSha,
      headSha: metadata.head_sha,
      spanChanged: summarySpanChanged,
    })
    : { current: findings, held: [], retired: [], reconciliationKnown: false };
  const matchedDismissed = new Set();
  const reconciliationKnownBeforeInline = history.summary.reconciliationKnown
    && history.threadsKnown
    && summaryReconciled.reconciliationKnown;
  const inlineReconciled = await reconcileInlineFindings({
    metadata,
    findings: summaryReconciled.current,
    standing,
    dismissed: history.summary.reconciliationKnown ? dismissed : [],
    matchedDismissed,
    resolveStale: env("RESOLVE_STALE", "true") === "true",
    writesEnabled: writesEnabled && reconciliationKnownBeforeInline,
  });
  const summaryHeld = [];
  let suppressed = inlineReconciled.suppressed;
  for (const finding of summaryReconciled.held) {
    const match = findStandingMatch(finding, dismissed, matchedDismissed, metadata.head_sha);
    const historical = match ? findingFromThread(match) : null;
    if (match) matchedDismissed.add(match);
    if (
      historical
      && SEVERITY_ORDER[historical.severity] <= SEVERITY_ORDER[finding.severity]
    ) {
      suppressed += 1;
    } else {
      summaryHeld.push(finding);
    }
  }
  return {
    current: inlineReconciled.current,
    fresh: inlineReconciled.fresh,
    unresolved: mergeFindingSets(
      summaryHeld,
      inlineReconciled.unresolved,
      preferredHistoricalFinding,
    ),
    suppressed,
    reconciliationKnown: reconciliationKnownBeforeInline
      && inlineReconciled.reconciliationKnown,
  };
}

export async function runSummaryMode({
  metadata,
  findings,
  repo,
  pr,
  token,
  botLogin,
  identityKnown,
  cyclePlan = null,
}) {
  const history = await loadReconciliationHistory({ repo, pr, token, botLogin, identityKnown });
  const { current, unresolved, suppressed, reconciliationKnown } = await reconcileHostedFindings({
    metadata,
    findings,
    history,
    writesEnabled: WRITES_ENABLED,
  });
  if (suppressed) {
    console.log(`  ${suppressed} finding(s) previously resolved and unchanged — not re-raised`);
  }
  const cycle = cycleAfterReview(cyclePlan, metadata, current, unresolved, reconciliationKnown);
  const state = reviewStateForCycle(
    deriveState(metadata, current, unresolved, reconciliationKnown, true),
    cycle,
  );
  const body = buildStandingSummaryBody({
    metadata,
    state,
    cycle,
    current,
    unresolved,
    reconciliationKnown,
  });

  emitState(metadata, state, { reconciliationKnown, cycle });
  if (reconciliationKnown) {
    const action = await postSummaryReview({
      repo,
      pr,
      token,
      headSha: metadata.head_sha,
      hasHistory: Boolean(history.summary.comment),
      body,
      hasFindings: current.length + unresolved.length > 0,
      hasCycleState: cycle !== null,
      writesEnabled: WRITES_ENABLED,
    });
    console.log(`  summary review ${action}`);
  } else {
    console.log("::warning::reconciliation is unknown; summary review was not changed");
  }
  if (DRY_RUN && env("SUPPRESS_WRITES", "") !== "true" && env("POST_COMMENT", "true") !== "false") {
    process.stdout.write(`${body}\n`);
  }
  enforceGate(state, cycle);
}

export async function reconcileInlineFindings({
  metadata,
  findings,
  standing,
  dismissed,
  matchedDismissed = new Set(),
  resolveStale,
  writesEnabled,
  changedSince = fileChangedSince,
  retire = retireThread,
}) {
  const standingFindings = new Map();
  let reconciliationKnown = true;
  for (const thread of standing) {
    const historical = findingFromThread(thread);
    standingFindings.set(thread, historical);
    if (!historical) reconciliationKnown = false;
  }
  const current = [];
  const fresh = [];
  const matchedStanding = new Set();
  let suppressed = 0;

  for (const finding of findings) {
    const match = findStandingMatch(finding, standing, matchedStanding);
    if (match) {
      matchedStanding.add(match);
      const historical = standingFindings.get(match);
      if (historical) current.push(withStrongestSeverity(finding, historical));
      else {
        current.push(finding);
        reconciliationKnown = false;
      }
      continue;
    }
    const dismissedMatch = findStandingMatch(
      finding,
      dismissed,
      matchedDismissed,
      metadata.head_sha,
    );
    if (dismissedMatch) {
      matchedDismissed.add(dismissedMatch);
      const historical = findingFromThread(dismissedMatch);
      if (
        historical
        && SEVERITY_ORDER[historical.severity] <= SEVERITY_ORDER[finding.severity]
      ) {
        suppressed += 1;
        continue;
      }
    }
    current.push(finding);
    fresh.push(finding);
  }

  const unresolved = [];
  for (const thread of standing) {
    if (matchedStanding.has(thread)) continue;
    const changed = changedSince(thread, metadata.head_sha);
    if (metadata.analysis_state === "complete" && changeIsConfirmed(changed) && resolveStale) {
      if (writesEnabled && reconciliationKnown) {
        try {
          await retire(thread, metadata.head_sha);
          continue;
        } catch (error) {
          reconciliationKnown = false;
          console.log(`::warning::could not retire a thread (${error.message})`);
        }
      } else {
        console.log(`  [suppressed] would retire thread ${thread.id}`);
      }
    }
    const carried = standingFindings.get(thread);
    if (carried) unresolved.push(carried);
    else reconciliationKnown = false;
  }

  return { current, fresh, unresolved, suppressed, reconciliationKnown };
}

export function buildInlineReviewPayload({
  metadata,
  state,
  current = [],
  fresh,
  unresolved,
  comments,
  cycle = null,
}) {
  const topBody = buildReviewTopBody({
    mode: REVIEW_MODE,
    metadata,
    state,
    current: fresh,
    unresolved,
  });
  const body = cycle === null
    ? topBody
    : `${topBody}\n\n${encodeSummaryMarker({
        headSha: metadata.head_sha,
        findings: [...current, ...unresolved],
        cycle,
        runId: env("GITHUB_RUN_ID", ""),
      })}`;
  return {
    commit_id: metadata.head_sha,
    event: "COMMENT",
    body,
    comments,
  };
}

async function runInlineMode({
  metadata,
  findings,
  repo,
  pr,
  token,
  botLogin,
  identityKnown,
  cyclePlan = null,
}) {
  const history = await loadReconciliationHistory({ repo, pr, token, botLogin, identityKnown });
  const { current, fresh, unresolved, suppressed, reconciliationKnown } = await reconcileHostedFindings({
    metadata,
    findings,
    history,
    writesEnabled: WRITES_ENABLED,
  });
  if (suppressed) {
    console.log(`  ${suppressed} finding(s) previously resolved and unchanged — not re-raised`);
  }

  const ranges = fresh.length > 0 && reconciliationKnown
    ? commentableRanges(metadata.base_sha, metadata.head_sha)
    : new Map();
  const { comments, unanchored } = buildReviewComments(fresh, ranges, { mode: REVIEW_MODE });
  const cycle = cycleAfterReview(cyclePlan, metadata, current, unresolved, reconciliationKnown);
  const state = reviewStateForCycle(
    deriveState(metadata, current, unresolved, reconciliationKnown, true),
    cycle,
  );
  const payload = buildInlineReviewPayload({
    metadata,
    state,
    current,
    fresh,
    unresolved,
    comments,
    cycle,
  });

  emitState(metadata, state, { reconciliationKnown, cycle });
  console.log(
    `  ${findings.length} finding(s): ${comments.length} anchored, `
      + `${unanchored.length} summary-only, ${current.length - fresh.length} already open`,
  );

  if (!reconciliationKnown) {
    console.log("::warning::reconciliation is unknown; review writes were suppressed");
    enforceGate(state, cycle);
    return;
  }
  if (DRY_RUN) {
    if (env("SUPPRESS_WRITES", "") !== "true" && env("POST_COMMENT", "true") !== "false") {

      console.log(JSON.stringify(payload, null, 2));
    }
    console.log(`  [suppressed] ${comments.length} inline comment(s) withheld`);
    enforceGate(state, cycle);
    return;
  }
  if (cycle === null && comments.length === 0 && unanchored.length === 0) {
    console.log("  nothing new to say");
    enforceGate(state, cycle);
    return;
  }

  let response = await postReview(payload);
  if (!response.ok) {
    console.log(`::warning::inline review rejected (${response.status}) — falling back to a non-inline review`);
    console.log(response.text.slice(0, 1000));
    response = await postReview(reviewFallbackPayload(payload));
    if (!response.ok) {
      throw new Error(`could not post the review (${response.status}): ${response.text.slice(0, 1000)}`);
    }
  }
  console.log("  review posted");
  enforceGate(state, cycle);
}
async function runCyclePlanMode() {
  const repo = required("GITHUB_REPO");
  const pr = Number(required("PR_NUMBER"));
  const token = required("GH_TOKEN");
  const baseSha = required("BASE_SHA");
  const headSha = required("HEAD_SHA");
  const planFile = required("REVIEW_CYCLE_PLAN_FILE");
  const knownFindingsFile = required("KNOWN_FINDINGS_FILE");
  const maxDiscoveryRounds = Number(env("MAX_DISCOVERY_ROUNDS", "2"));
  if (!Number.isInteger(maxDiscoveryRounds) || maxDiscoveryRounds < 1) {
    throw new TypeError("MAX_DISCOVERY_ROUNDS must be a positive integer");
  }
  const overrideActor = env("REVIEW_CYCLE_OVERRIDE_ACTOR", "").trim();
  const overrideReason = env("REVIEW_CYCLE_OVERRIDE_REASON", "").trim();
  const overrideInvocation = env("REVIEW_CYCLE_OVERRIDE_INVOCATION", "").trim();
  if (
    Boolean(overrideActor) !== Boolean(overrideReason)
    || Boolean(overrideActor) !== Boolean(overrideInvocation)
  ) {
    throw new TypeError("review-cycle override requires actor, reason, and invocation");
  }
  const override = overrideActor
    ? { actor: overrideActor, reason: overrideReason, invocation: overrideInvocation }
    : null;
  let plan;
  if (!WRITES_ENABLED) {
    if (override !== null) {
      throw new TypeError("review-cycle override requires hosted state persistence");
    }
    plan = {
      persistence_enabled: false,
      should_run: true,
      phase: "discovery",
      discovery_round: 1,
      lineage_base_sha: baseSha,
      max_discovery_rounds: maxDiscoveryRounds,
      cycle: null,
      known_findings: [],
      override: null,
    };
  } else {
    const botLogin = await fetchViewerLogin({ token });
    const [reviews, comments] = await Promise.all([
      fetchSummaryReviews({ repo, pr, token }),
      fetchSummaryComments({ repo, pr, token }),
    ]);
    plan = planHostedReviewCycle({
      reviews,
      comments,
      botLogin,
      baseSha,
      headSha,
      maxDiscoveryRounds,
      override,
      isAncestor: (priorHead, currentHead) => {
        try {
          execFileSync("git", ["merge-base", "--is-ancestor", priorHead, currentHead], {
            stdio: "ignore",
          });
          return true;
        } catch {
          return false;
        }
      },
    });
  }
  writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
  const verificationFindings = plan.known_findings.map((finding, index) => ({
    ...finding,
    suggestion: finding.suggestion ?? null,
    verification_id: `K${index + 1}`,
  }));
  writeFileSync(knownFindingsFile, `${JSON.stringify({ findings: verificationFindings }, null, 2)}\n`);
  const cycle = plan.cycle;
  const cycleState = plan.persistence_enabled === false ? "" : cycle?.state ?? "active";
  const phase = plan.phase ?? cycle?.last_phase ?? "";
  const configuredMaximum = cycle?.max_discovery_rounds
    ?? plan.max_discovery_rounds
    ?? maxDiscoveryRounds;
  let terminalResult = null;
  if (!plan.should_run) {
    const state = deriveReviewState({
      analysisState: "inconclusive",
      current: [],
      unresolved: plan.known_findings,
      reconciliationKnown: true,
      blockSeverities: blockSeverities(),
      evidenceReconciled: true,
    });
    const converged = false;
    terminalResult = {
      analysis_state: state.analysis_state,
      merge_state: state.merge_state,
      sample_state: state.sample_state,
      bounded_converged: converged,
      base_sha: cycle?.lineage_base_sha ?? baseSha,
      head_sha: cycle?.last_reviewed_head ?? headSha,
      configuration_fingerprint: "0".repeat(64),
      passes_requested: 0,
      passes_completed: 0,
      current_counts: state.current_counts,
      unresolved_counts: state.unresolved_counts,
      reviewed_head: cycle?.last_reviewed_head ?? headSha,
      scope_hash: cycle?.last_scope_hash ?? "0".repeat(64),
      coverage: "unknown",
      remaining_analysis: ["execution_failed"],
      converged,
      ...(cycle === null ? {} : { review_cycle: cycle }),
    };
    const resultFile = env("REVIEW_RESULT_FILE", "");
    if (resultFile) writeFileSync(resultFile, `${JSON.stringify(terminalResult, null, 2)}\n`);
  }
  const outputFile = env("GITHUB_OUTPUT", "");
  if (outputFile) {
    appendFileSync(outputFile, [
      `should_run=${plan.should_run}`,
      `phase=${phase}`,
      `discovery_round=${plan.discovery_round}`,
      `max_discovery_rounds=${configuredMaximum}`,
      `cycle_state=${cycleState}`,
      ...(terminalResult
        ? [
            `analysis_state=${terminalResult.analysis_state}`,
            `merge_state=${terminalResult.merge_state}`,
            `sample_state=${terminalResult.sample_state}`,
            `bounded_converged=${terminalResult.bounded_converged}`,
            `reviewed_head=${terminalResult.reviewed_head}`,
            `scope_hash=${terminalResult.scope_hash}`,
            `coverage=${terminalResult.coverage}`,
            `remaining_analysis=${JSON.stringify(terminalResult.remaining_analysis)}`,
            `converged=${terminalResult.converged}`,
            `base_sha=${terminalResult.base_sha}`,
            `head_sha=${terminalResult.head_sha}`,
            `configuration_fingerprint=${terminalResult.configuration_fingerprint}`,
            `passes_requested=${terminalResult.passes_requested}`,
            `passes_completed=${terminalResult.passes_completed}`,
            `current_counts=${JSON.stringify(terminalResult.current_counts)}`,
            `unresolved_counts=${JSON.stringify(terminalResult.unresolved_counts)}`,
          ]
        : []),
      "",
    ].join("\n"));
  }
}

let runningCyclePlan = false;

async function dispatchMain() {
  if (process.argv[2] === "cycle-plan") {
    runningCyclePlan = true;
    await runCyclePlanMode();
    return;
  }
  await main();
}

let activeMetadata = null;
let lastTrustworthyState = null;
let lastReconciliationKnown = true;
let lastReviewCycle = null;

function emitHardFailureResult() {
  const metadata = activeMetadata ?? {
    base_sha: env("BASE_SHA", ""),
    head_sha: env("HEAD_SHA", ""),
    configuration_fingerprint: "",
    passes: { requested: [], completed: [] },
  };
  const state = lastTrustworthyState
    ? {
      ...lastTrustworthyState,
      analysis_state: "inconclusive",
      sample_state: SUMMARY_SEVERITIES.some(
        (severity) => lastTrustworthyState.current_counts[severity]
          + lastTrustworthyState.unresolved_counts[severity] > 0,
      ) ? "findings" : "unknown",
      bounded_converged: false,
      converged: false,
    }
    : {
      analysis_state: "inconclusive",
      merge_state: "ready",
      sample_state: "unknown",
      bounded_converged: false,
      current_counts: { Critical: 0, High: 0, Medium: 0 },
      unresolved_counts: { Critical: 0, High: 0, Medium: 0 },
    };
  const resultMetadata = activeMetadata ? undefined : {
    reviewed_head: env("HEAD_SHA", metadata.head_sha ?? ""),
    scope_hash: "",
    coverage: "unknown",
    remaining_analysis: ["execution_failed"],
  };
  emitWorkflowResult({
    metadata,
    state,
    outputFile: env("GITHUB_OUTPUT", ""),
    summaryFile: env("GITHUB_STEP_SUMMARY", ""),
    resultFile: env("REVIEW_RESULT_FILE", ""),
    reconciliationKnown: lastTrustworthyState ? lastReconciliationKnown : true,
    executionFailed: true,
    resultMetadata,
    cycle: lastReviewCycle,
  });
}

function loadReviewCyclePlan() {
  const planPath = env("REVIEW_CYCLE_PLAN_FILE", "");
  if (!planPath || !existsSync(planPath)) return null;
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new TypeError("review cycle plan must be an object");
  }
  if (plan.persistence_enabled === false) return null;
  return plan;
}

async function main() {
  const publicationPath = required("REVIEW_PUBLICATION_FILE");
  const publication = JSON.parse(readFileSync(publicationPath, "utf8"));
  const expectedHeadSha = env("HEAD_SHA", "") || publication?.metadata?.head_sha;
  const failureResult = derivePublicationFailureResult(publication, {
    expectedHeadSha,
    blockSeverities: blockSeverities(),
  });
  const { findings: publishedFindings, metadata } = publication;
  activeMetadata = metadata;
  const findings = publishedFindings.map(projectPublicFinding);
  const cyclePlan = loadReviewCyclePlan();
  lastTrustworthyState = {
    analysis_state: failureResult.analysis_state,
    merge_state: failureResult.merge_state,
    sample_state: failureResult.sample_state,
    bounded_converged: failureResult.bounded_converged,
    converged: failureResult.converged,
    current_counts: failureResult.current_counts,
    unresolved_counts: failureResult.unresolved_counts,
  };
  lastReconciliationKnown = false;
  const mode = env("REVIEW_MODE", "suggest");
  if (!["summary", "inline", "suggest"].includes(mode)) {
    throw new TypeError("REVIEW_MODE must be summary, inline, or suggest");
  }

  if (env("RENDER", "") === "1") {
    let unresolved = [];
    let reconciliationKnown = env("RECONCILIATION_KNOWN", "true") === "true";
    const unresolvedPath = env("UNRESOLVED_FINDINGS_FILE", "");
    if (unresolvedPath) {
      try {
        const prior = extractJson(readFileSync(unresolvedPath, "utf8"));
        if (!prior) throw new TypeError("unresolved findings are not structured JSON");
        unresolved = mergeFindingSets(findings, prior.findings, (current) => current)
          .slice(findings.length);
      } catch {
        reconciliationKnown = false;
      }
    }
    const cycle = cycleAfterReview(cyclePlan, metadata, findings, unresolved, reconciliationKnown);
    const state = reviewStateForCycle(
      deriveState(metadata, findings, unresolved, reconciliationKnown, true),
      cycle,
    );
    emitState(metadata, state, { reconciliationKnown, cycle });
    const body = mode === "summary"
      ? buildStandingSummaryBody({
        metadata,
        state,
        cycle,
        current: findings,
        unresolved,
        reconciliationKnown,
      })
      : renderReviewBody({
        mode,
        metadata,
        state,
        current: findings,
        unresolved,
        reconciliationKnown,
      });
    process.stdout.write(`${body}\n`);
    enforceGate(state, cycle);
    return;
  }

  const repo = required("GITHUB_REPO");
  const pr = Number(required("PR_NUMBER"));
  const token = required("GH_TOKEN");
  let botLogin = null;
  let identityKnown = true;
  try {
    botLogin = await fetchViewerLogin({ token });
  } catch (error) {
    identityKnown = false;
    console.log(`::warning::${error.message}; reconciliation and review writes are suppressed`);
  }

  if (mode === "summary") {
    await runSummaryMode({
      metadata,
      findings,
      repo,
      pr,
      token,
      botLogin,
      identityKnown,
      cyclePlan,
    });
    return;
  }
  await runInlineMode({
    metadata,
    findings,
    repo,
    pr,
    token,
    botLogin,
    identityKnown,
    cyclePlan,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  dispatchMain().catch((error) => {
    console.error(`::error::${error?.message ?? error}`);
    if (!runningCyclePlan) {
      try {
        emitHardFailureResult();
      } catch (resultError) {
        console.error(`::error::could not persist conservative review result (${resultError?.message ?? resultError})`);
      }
    }
    process.exitCode = 1;
  });
}
