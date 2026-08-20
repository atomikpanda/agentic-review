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
//   FINDINGS_FILE         merged structured findings          (required)
//   REVIEW_METADATA_FILE validated schema-v1 run metadata     (required)
//   GITHUB_REPO           owner/name                           (required except RENDER)
//   PR_NUMBER             pull request number                  (required except RENDER)
//   GH_TOKEN              token with pull-requests: write      (required except RENDER)
//   REVIEW_MODE           "summary" | "inline" | "suggest"     (default suggest)
//   DRY_RUN               "1" reads and reconciles but does not write
//   SUPPRESS_WRITES       "true" reads and reconciles but does not write
//   POST_COMMENT          "false" reads and reconciles but does not write
//   UNRESOLVED_FINDINGS_FILE prior local findings for RENDER only
//   RECONCILIATION_KNOWN    "false" prevents a clean RENDER result

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { deflateRawSync, inflateRawSync } from "node:zlib";

import {
  identityTokens,
  isValidFinding,
  projectPublicFinding,
  sameFinding,
  similarity,
  SIMILARITY_DEFAULT,
  tokenSet,
} from "./lib-findings.mjs";
import { deriveReviewState, enrichRunMetadata, validateRunMetadata } from "./review-result.mjs";
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
const stamp = (fp) => `\n\n<!-- ${MARKER}:${fp} -->`;

const SUMMARY_MARKER = "agentic-review-summary";
const SUMMARY_MARKER_VERSION = 1;
const SUMMARY_STATE_MAX_BYTES = 1024 * 1024;
const SUMMARY_MARKER_RE = /<!-- agentic-review-summary:v1:([A-Za-z0-9_-]+) -->\s*$/;
const SUMMARY_MARKER_PRESENT_RE = /<!-- agentic-review-summary:v\d+:[^>]*-->\s*$/;
const SUMMARY_SEVERITIES = ["Critical", "High", "Medium"];
const SUMMARY_SEVERITY_SET = new Set(SUMMARY_SEVERITIES);
const SUMMARY_TITLE_MAX_CHARS = 240;
const SUMMARY_IDENTITY_MAX_TOKENS = 32;
const SUMMARY_IDENTITY_TOKEN_MAX_CHARS = 64;
const HELD_FINDING_BODY = "Previously reported finding remains held from an earlier review sample.";
const SHA_RE = /^[0-9a-f]{40}$/;

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
  return {
    file,
    start_line: startLine,
    end_line: endLine,
    severity: value.severity,
    title: value.title.slice(0, SUMMARY_TITLE_MAX_CHARS),
    body: HELD_FINDING_BODY,
    identity_tokens: summaryIdentityTokens(value),
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
  ];
}

function decodeSummaryFinding(value, index) {
  if (!Array.isArray(value) || value.length !== 6 || !Array.isArray(value[5])) {
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
  }, index);
}

export function encodeSummaryMarker({ headSha, findings }) {
  if (!SHA_RE.test(headSha)) throw new TypeError("summary headSha must be a lowercase 40-character SHA");
  if (!Array.isArray(findings)) throw new TypeError("summary findings must be an array");
  const state = {
    h: headSha,
    f: findings.map(encodeSummaryFinding),
  };
  const encoded = deflateRawSync(Buffer.from(JSON.stringify(state))).toString("base64url");
  return `<!-- ${SUMMARY_MARKER}:v${SUMMARY_MARKER_VERSION}:${encoded} -->`;
}

export function decodeSummaryMarker(body) {
  const encoded = String(body ?? "").match(SUMMARY_MARKER_RE)?.[1];
  if (!encoded) return null;
  try {
    const text = inflateRawSync(Buffer.from(encoded, "base64url"), {
      maxOutputLength: SUMMARY_STATE_MAX_BYTES,
    }).toString("utf8");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !SHA_RE.test(parsed.h)) {
      return null;
    }
    if (!Array.isArray(parsed.f)) return null;
    return {
      head_sha: parsed.h,
      findings: parsed.f.map(decodeSummaryFinding),
    };
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
      const byTime = String(right.created_at ?? "").localeCompare(String(left.created_at ?? ""));
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
    reconciliationKnown: true,
  };
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

export async function reconcileSummaryFindings({
  analysisState,
  current,
  prior,
  priorHeadSha,
  headSha,
  spanChanged,
}) {
  const matchedPrior = new Set();
  const reconciledCurrent = [];
  for (const candidate of current) {
    let bestIndex = null;
    let bestScore = -1;
    for (const [index, previous] of prior.entries()) {
      if (matchedPrior.has(index)) continue;
      const score = summaryFindingSimilarity(candidate, previous);
      if (score >= SIMILARITY && (bestIndex === null || score > bestScore)) {
        bestIndex = index;
        bestScore = score;
      }
    }
    if (bestIndex === null) {
      reconciledCurrent.push(candidate);
    } else {
      matchedPrior.add(bestIndex);
      reconciledCurrent.push(withStrongestSeverity(candidate, prior[bestIndex]));
    }
  }

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
  const m = String(body ?? "").match(new RegExp(`<!-- ${MARKER}:([0-9a-f]{16}) -->`));
  return m ? m[1] : null;
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
    ["diff", "--unified=3", "--no-color", `${baseSha}`, `${headSha}`],
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
  if (withSuggestion && typeof f.suggestion === "string" && f.suggestion.length > 0) {
    // Trailing newline is stripped: the block's lines replace the target lines
    // exactly, and an extra blank line at the end inserts one into the file.
    const body = f.suggestion.replace(/\n+$/, "");
    const fence = fenceFor(body);
    parts.push("", `${fence}suggestion`, body, fence);
  }
  return parts.join("\n") + stamp(fingerprint(f));
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

function formatCounts(counts) {
  return `Critical: ${counts.Critical} · High: ${counts.High} · Medium: ${counts.Medium}`;
}

function buildFinalResult(metadata, state, {
  reconciliationKnown = true,
  executionFailed = false,
  resultMetadata,
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
    + stamp(fingerprint(finding));
  const visible = `${badge(finding.severity)} — **${finding.title}**\n\n${finding.body}`;
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
  return `- ${label} ${badge(finding.severity)} — **${title}** (\`${path}${span}\`)`;
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
  current,
  unresolved,
  reconciliationKnown = true,
}) {
  const marker = encodeSummaryMarker({
    headSha: metadata.head_sha,
    findings: [...current, ...unresolved],
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
}) {
  const result = buildFinalResult(metadata, state, {
    reconciliationKnown,
    executionFailed,
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

export async function upsertSummaryComment({
  repo,
  pr,
  token,
  existingComment,
  body,
  hasFindings,
  writesEnabled,
  fetchImpl = fetch,
}) {
  if (!existingComment && !hasFindings) return "skipped";
  if (!writesEnabled) return "suppressed";
  if (Buffer.byteLength(body) > GITHUB_COMMENT_MAX_BYTES) {
    throw new RangeError("summary comment exceeds GitHub comment limit");
  }
  const updating = Boolean(existingComment);
  const url = updating
    ? `https://api.github.com/repos/${repo}/issues/comments/${existingComment.id}`
    : `https://api.github.com/repos/${repo}/issues/${pr}/comments`;
  const res = await fetchImpl(url, {
    method: updating ? "PATCH" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    throw new Error(`${updating ? "PATCH" : "POST"} summary comment ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return updating ? "updated" : "created";
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
      const fp = comment?.author?.login === botLogin ? readStamp(comment?.body) : null;
      if (fp) {
        out.push({
          id: thread.id,
          fp,
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
            ["diff", "--unified=0", "--no-ext-diff", t.origOid, head, "--", literalPathspec(t.path)],
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
    execFileSync("git", ["diff", "--quiet", t.origOid, head, "--", literalPathspec(t.path)], { stdio: "ignore" });
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
  if (!thread.path || !match) return null;
  return {
    file: thread.path,
    start_line: thread.startLine,
    end_line: thread.endLine,
    severity: match[1],
    title: match[2],
    body: thread.body,
    suggestion: null,
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

  const fp = readStamp(thread.body) ?? (/^[0-9a-f]{16}$/.test(thread.fp ?? "") ? thread.fp : null);
  if (!fp) throw new RangeError("oversized stale comment has no authoritative identity marker");
  const firstLine = String(thread.body ?? "").split("\n", 1)[0];
  const original = fitUtf8Bytes(firstLine, COLLAPSED_ORIGINAL_LINE_MAX_BYTES, "…");
  const details =
    `<details><summary>Original finding</summary>\n\n${original}\n\n` +
    `_Original finding prose omitted to satisfy GitHub's PATCH byte limit._\n\n</details>` +
    stamp(fp);
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

function emitState(metadata, state, { reconciliationKnown = true, executionFailed = false } = {}) {
  emitWorkflowResult({
    metadata,
    state,
    outputFile: env("GITHUB_OUTPUT", ""),
    summaryFile: env("GITHUB_STEP_SUMMARY", ""),
    resultFile: env("REVIEW_RESULT_FILE", ""),
    reconciliationKnown,
    executionFailed,
  });
}

function enforceGate(state) {
  if (shouldFailGate(state, env("FAIL_ON_FINDINGS", "false") === "true")) {
    const blocking = Object.entries(state.current_counts)
      .concat(Object.entries(state.unresolved_counts))
      .filter(([severity]) => blockSeverities().includes(severity))
      .reduce((total, [, count]) => total + count, 0);
    console.error(`::error::${blocking} blocking finding(s): ${blockSeverities().join(",")}`);
    process.exitCode = 1;
  }
}

function findStandingMatch(finding, threads) {
  const fp = fingerprint(finding);
  const exact = threads.find((thread) => thread.fp === fp);
  if (exact) return exact;
  const tokens = tokenSet(`${finding.title} ${finding.body}`);
  const file = String(finding.file).replace(/^\.\//, "");
  let best = null;
  let bestScore = 0;
  for (const thread of threads) {
    if (thread.path !== file) continue;
    const score = similarity(tokens, thread.tokens);
    if (score > bestScore) {
      best = thread;
      bestScore = score;
    }
  }
  return bestScore >= SIMILARITY ? best : null;
}

function matchesUnchangedResolvedThread(finding, threads, headSha) {
  const tokens = tokenSet(`${finding.title} ${finding.body}`);
  const file = String(finding.file).replace(/^\.\//, "");
  return threads.some((thread) => (
    thread.path === file
    && similarity(tokens, thread.tokens) >= SIMILARITY
    && fileChangedSince(thread, headSha) === false
  ));
}
async function loadReconciliationHistory({ repo, pr, token, botLogin, identityKnown }) {
  const summary = { comment: null, findings: [], headSha: null, reconciliationKnown: identityKnown };
  if (!identityKnown) return { summary, threads: [], threadsKnown: false };

  const [summaryResult, threadsResult] = await Promise.allSettled([
    fetchSummaryComments({ repo, pr, token }),
    (() => {
      const [owner, name] = repo.split("/");
      return fetchOurThreads({ owner, name, pr, botLogin });
    })(),
  ]);

  let selectedSummary = summary;
  if (summaryResult.status === "fulfilled") {
    selectedSummary = selectSummaryHistory(summaryResult.value, { botLogin });
  } else {
    selectedSummary = { comment: null, findings: [], headSha: null, reconciliationKnown: false };
    console.log(
      `::warning::could not read standing summary comment (${summaryResult.reason?.message ?? summaryResult.reason})`,
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

function preferredHistoricalFinding(left, right) {
  const severityDifference = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
  if (severityDifference !== 0) return severityDifference < 0 ? left : right;
  return historicalFindingKey(left) <= historicalFindingKey(right) ? left : right;
}

function withStrongestSeverity(current, historical) {
  if (SEVERITY_ORDER[historical.severity] < SEVERITY_ORDER[current.severity]) {
    return { ...current, severity: historical.severity };
  }
  return current;
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

export function reconcileFreshFindings(inlineReconciled, reconciledCurrent) {
  if (inlineReconciled.current.length !== reconciledCurrent.length) {
    throw new TypeError("reconciled current findings must preserve inline ordering");
  }
  return inlineReconciled.fresh.map((finding) => {
    const index = inlineReconciled.current.indexOf(finding);
    if (index < 0) throw new TypeError("fresh findings must belong to inline current findings");
    return reconciledCurrent[index];
  });
}

export async function reconcileHostedFindings({ metadata, findings, history, writesEnabled }) {
  const standing = history.threads.filter((thread) => !thread.isResolved && !thread.retired);
  const dismissed = history.threads.filter((thread) => thread.isResolved);
  const inlineReconciled = await reconcileInlineFindings({
    metadata,
    findings,
    standing,
    dismissed,
    resolveStale: env("RESOLVE_STALE", "true") === "true",
    writesEnabled,
  });
  const summaryReconciled = history.summary.reconciliationKnown
    ? await reconcileSummaryFindings({
      analysisState: metadata.analysis_state,
      current: inlineReconciled.current,
      prior: history.summary.findings,
      priorHeadSha: history.summary.headSha,
      headSha: metadata.head_sha,
      spanChanged: summarySpanChanged,
    })
    : { current: inlineReconciled.current, held: [], retired: [], reconciliationKnown: false };
  return {
    current: summaryReconciled.current,
    fresh: reconcileFreshFindings(inlineReconciled, summaryReconciled.current),
    unresolved: mergeFindingSets(
      summaryReconciled.held,
      inlineReconciled.unresolved,
      preferredHistoricalFinding,
    ),
    suppressed: inlineReconciled.suppressed,
    reconciliationKnown: history.summary.reconciliationKnown
      && history.threadsKnown
      && summaryReconciled.reconciliationKnown
      && inlineReconciled.reconciliationKnown,
  };
}


export async function runSummaryMode({ metadata, findings, repo, pr, token, botLogin, identityKnown }) {
  const history = await loadReconciliationHistory({ repo, pr, token, botLogin, identityKnown });
  const { current, unresolved, suppressed, reconciliationKnown } = await reconcileHostedFindings({
    metadata,
    findings,
    history,
    writesEnabled: false,
  });
  if (suppressed) {
    console.log(`  ${suppressed} finding(s) previously resolved and unchanged — not re-raised`);
  }
  const state = deriveState(metadata, current, unresolved, reconciliationKnown, true);
  const body = buildStandingSummaryBody({
    metadata,
    state,
    current,
    unresolved,
    reconciliationKnown,
  });

  emitState(metadata, state, { reconciliationKnown });
  if (reconciliationKnown) {
    const action = await upsertSummaryComment({
      repo,
      pr,
      token,
      existingComment: history.summary.comment,
      body,
      hasFindings: current.length + unresolved.length > 0,
      writesEnabled: WRITES_ENABLED,
    });
    console.log(`  summary comment ${action}`);
  } else {
    console.log("::warning::reconciliation is unknown; standing summary comment was not changed");
  }
  if (DRY_RUN && env("SUPPRESS_WRITES", "") !== "true" && env("POST_COMMENT", "true") !== "false") {
    process.stdout.write(`${body}\n`);
  }
  enforceGate(state);
}

export async function reconcileInlineFindings({
  metadata,
  findings,
  standing,
  dismissed,
  resolveStale,
  writesEnabled,
  changedSince = fileChangedSince,
  retire = retireThread,
}) {
  const current = [];
  const fresh = [];
  const stillLive = new Set();
  let suppressed = 0;
  let reconciliationKnown = true;

  for (const finding of findings) {
    const match = findStandingMatch(finding, standing);
    if (match) {
      stillLive.add(match.id);
      const historical = findingFromThread(match);
      if (historical) current.push(withStrongestSeverity(finding, historical));
      else {
        current.push(finding);
        reconciliationKnown = false;
      }
      continue;
    }
    if (matchesUnchangedResolvedThread(finding, dismissed, metadata.head_sha)) {
      suppressed += 1;
      continue;
    }
    current.push(finding);
    fresh.push(finding);
  }

  const unresolved = [];
  for (const thread of standing) {
    if (stillLive.has(thread.id)) continue;
    const changed = changedSince(thread, metadata.head_sha);
    if (metadata.analysis_state === "complete" && changeIsConfirmed(changed) && resolveStale) {
      if (writesEnabled) {
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
    const carried = findingFromThread(thread);
    if (carried) unresolved.push(carried);
    else reconciliationKnown = false;
  }

  return { current, fresh, unresolved, suppressed, reconciliationKnown };
}

export function buildInlineReviewPayload({ metadata, state, fresh, unresolved, comments }) {
  return {
    commit_id: metadata.head_sha,
    event: "COMMENT",
    body: buildReviewTopBody({
      mode: REVIEW_MODE,
      metadata,
      state,
      current: fresh,
      unresolved,
    }),
    comments,
  };
}

async function runInlineMode({ metadata, findings, repo, pr, token, botLogin, identityKnown }) {
  const history = await loadReconciliationHistory({ repo, pr, token, botLogin, identityKnown });
  const { current, fresh, unresolved, suppressed, reconciliationKnown } = await reconcileHostedFindings({
    metadata,
    findings,
    history,
    writesEnabled: WRITES_ENABLED && history.summary.reconciliationKnown && history.threadsKnown,
  });
  if (suppressed) {
    console.log(`  ${suppressed} finding(s) previously resolved and unchanged — not re-raised`);
  }

  const ranges = fresh.length > 0 && reconciliationKnown
    ? commentableRanges(metadata.base_sha, metadata.head_sha)
    : new Map();
  const { comments, unanchored } = buildReviewComments(fresh, ranges, { mode: REVIEW_MODE });
  const state = deriveState(metadata, current, unresolved, reconciliationKnown, true);
  const payload = buildInlineReviewPayload({ metadata, state, fresh, unresolved, comments });

  emitState(metadata, state, { reconciliationKnown });
  console.log(
    `  ${findings.length} finding(s): ${comments.length} anchored, `
      + `${unanchored.length} summary-only, ${findings.length - fresh.length - suppressed} already open`,
  );

  if (!reconciliationKnown) {
    console.log("::warning::reconciliation is unknown; review writes were suppressed");
    enforceGate(state);
    return;
  }
  if (DRY_RUN) {
    if (env("SUPPRESS_WRITES", "") !== "true" && env("POST_COMMENT", "true") !== "false") {
      console.log(JSON.stringify(payload, null, 2));
    }
    console.log(`  [suppressed] ${comments.length} inline comment(s) withheld`);
    enforceGate(state);
    return;
  }
  if (comments.length === 0 && unanchored.length === 0) {
    console.log("  nothing new to say");
    enforceGate(state);
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
  enforceGate(state);
}

let activeMetadata = null;

function emitHardFailureResult() {
  const metadata = activeMetadata ?? {
    base_sha: env("BASE_SHA", ""),
    head_sha: env("HEAD_SHA", ""),
    configuration_fingerprint: "",
    passes: { requested: [], completed: [] },
  };
  const state = {
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
    resultFile: env("REVIEW_RESULT_FILE", ""),
    executionFailed: true,
    resultMetadata,
  });
}

async function main() {
  const findingsPath = required("FINDINGS_FILE");
  const metadataPath = required("REVIEW_METADATA_FILE");
  const metadata = validateRunMetadata(JSON.parse(readFileSync(metadataPath, "utf8")));
  activeMetadata = metadata;
  const parsed = extractJson(readFileSync(findingsPath, "utf8"));
  if (!parsed) throw new TypeError("findings artifact is not the requested structured JSON");
  const findings = parsed.findings;
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
    const state = deriveState(metadata, findings, unresolved, reconciliationKnown, true);
    emitState(metadata, state, { reconciliationKnown });
    const body = mode === "summary"
      ? buildStandingSummaryBody({
        metadata,
        state,
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
    enforceGate(state);
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
    await runSummaryMode({ metadata, findings, repo, pr, token, botLogin, identityKnown });
    return;
  }
  await runInlineMode({ metadata, findings, repo, pr, token, botLogin, identityKnown });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`::error::${error?.message ?? error}`);
    try {
      emitHardFailureResult();
    } catch (resultError) {
      console.error(`::error::could not persist conservative review result (${resultError?.message ?? resultError})`);
    }
    process.exitCode = 1;
  });
}
