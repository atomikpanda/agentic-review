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

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { deflateRawSync, inflateRawSync } from "node:zlib";

import { sameFinding, tokenSet, similarity, SIMILARITY_DEFAULT } from "./lib-findings.mjs";
import { deriveReviewState, validateRunMetadata } from "./review-result.mjs";
import {
  GIT_DIFF_MAX_BUFFER_BYTES,
  changeIsConfirmed,
  diffTouchesSpan,
  literalPathspec,
} from "./thread-change.mjs";
const env = (k, d) => process.env[k] ?? d;
const required = (k) => {
  const v = process.env[k];
  if (!v) {
    console.error(`::error::${k} is not set`);
    process.exit(1);
  }
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
const SUMMARY_MARKER_RE = /<!-- agentic-review-summary:v1:([A-Za-z0-9_-]+) -->/;
const SUMMARY_MARKER_PRESENT_RE = /<!-- agentic-review-summary:v\d+:[^>]*-->/;
const SUMMARY_SEVERITIES = new Set(["Critical", "High", "Medium"]);
const SHA_RE = /^[0-9a-f]{40}$/;

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
  if (!SUMMARY_SEVERITIES.has(value.severity)) {
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
    title: value.title,
    body: value.body,
  };
}

export function encodeSummaryMarker({ headSha, findings }) {
  if (!SHA_RE.test(headSha)) throw new TypeError("summary headSha must be a lowercase 40-character SHA");
  if (!Array.isArray(findings)) throw new TypeError("summary findings must be an array");
  const state = {
    head_sha: headSha,
    findings: findings.map(normalizeSummaryFinding),
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
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !SHA_RE.test(parsed.head_sha)) {
      return null;
    }
    if (!Array.isArray(parsed.findings)) return null;
    return {
      head_sha: parsed.head_sha,
      findings: parsed.findings.map(normalizeSummaryFinding),
    };
  } catch {
    return null;
  }
}

function isBotComment(comment, botLogin) {
  const login = comment?.user?.login ?? "";
  return comment?.user?.type === "Bot"
    && (/^github-actions(?:\[bot\])?$/.test(login) || (botLogin && login === botLogin));
}

export function selectSummaryHistory(comments, { botLogin = "github-actions[bot]" } = {}) {
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

export async function reconcileSummaryFindings({
  current,
  prior,
  priorHeadSha,
  headSha,
  spanChanged,
}) {
  const held = [];
  const retired = [];
  let reconciliationKnown = true;
  for (const previous of prior) {
    if (current.some((candidate) => sameFinding(candidate, previous))) continue;
    let changed = null;
    try {
      changed = await spanChanged(previous, priorHeadSha, headSha);
    } catch {
      reconciliationKnown = false;
    }
    if (changeIsConfirmed(changed)) retired.push(previous);
    else held.push(previous);
  }
  return { current, held, retired, reconciliationKnown };
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
      if (parsed && Array.isArray(parsed.findings)) return parsed;
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

function build(findings, ranges) {
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

    const comment = {
      path: file,
      body: commentBody(f, REVIEW_MODE === "suggest"),
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

export function renderStateTable(metadata, state) {
  return [
    "| Result | Value |",
    "| --- | --- |",
    `| Analysis | \`${state.analysis_state}\` |`,
    `| Merge gate | \`${state.merge_state}\` |`,
    `| Sample | \`${state.sample_state}\` |`,
    `| Bounded convergence | \`${state.bounded_converged ? "yes" : "no"}\` |`,
    `| Base SHA | \`${metadata.base_sha}\` |`,
    `| Head SHA | \`${metadata.head_sha}\` |`,
    `| Configuration fingerprint | \`${metadata.configuration_fingerprint}\` |`,
    `| Passes | \`${metadata.passes.requested.length} requested / ${metadata.passes.completed.length} completed\` |`,
    `| Current findings | \`${formatCounts(state.current_counts)}\` |`,
    `| Held/unresolved findings | \`${formatCounts(state.unresolved_counts)}\` |`,
  ].join("\n");
}

function appendFindings(out, heading, findings) {
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
      "",
    );
  }
  if (out.at(-1) === "") out.pop();
}

export function renderReviewBody({ mode, metadata, state, current, unresolved }) {
  if (!["summary", "inline", "suggest"].includes(mode)) {
    throw new TypeError("review mode must be summary, inline, or suggest");
  }
  const out = ["### Agentic review", "", renderStateTable(metadata, state)];
  appendFindings(out, "Current findings", current);
  appendFindings(out, "Held findings", unresolved);
  return out.join("\n");
}

export function emitWorkflowResult({ metadata, state, outputFile, summaryFile }) {
  if (outputFile) {
    appendFileSync(outputFile, [
      `analysis_state=${state.analysis_state}`,
      `merge_state=${state.merge_state}`,
      `sample_state=${state.sample_state}`,
      `bounded_converged=${state.bounded_converged}`,
      `base_sha=${metadata.base_sha}`,
      `head_sha=${metadata.head_sha}`,
      `configuration_fingerprint=${metadata.configuration_fingerprint}`,
      `passes_requested=${metadata.passes.requested.length}`,
      `passes_completed=${metadata.passes.completed.length}`,
      `current_counts=${JSON.stringify(state.current_counts)}`,
      `unresolved_counts=${JSON.stringify(state.unresolved_counts)}`,
      "",
    ].join("\n"));
  }
  if (summaryFile) {
    appendFileSync(summaryFile, `## Agentic review\n\n${renderStateTable(metadata, state)}\n`);
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

// Only threads this reviewer started are ever touched. A human's thread has no
// marker, so it cannot match — resolving someone else's review comment would be
// a far worse failure than leaving a stale one.
async function ourThreads() {
  const [owner, name] = required("GITHUB_REPO").split("/");
  const data = await graphql(
    `query($owner:String!,$name:String!,$pr:Int!){
       repository(owner:$owner,name:$name){
         pullRequest(number:$pr){
           reviewThreads(first:100){
             nodes{ id isResolved isOutdated path originalStartLine originalLine
                    comments(first:1){ nodes{ databaseId body author{login}
                                              originalCommit{ oid } } } } } } } }`,
    { owner, name, pr: Number(required("PR_NUMBER")) },
  );
  const nodes = data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  const out = [];
  for (const t of nodes) {
    const c = t.comments?.nodes?.[0];
    const startLine = Number(t.originalStartLine ?? t.originalLine);
    const endLine = Number(t.originalLine);
    // Author check, not just the marker. Anyone can paste
    // `<!-- agentic-review-fp:... -->` into a comment; without this a pull
    // request could forge a thread that we then resolve or edit, or claim a
    // finding as "already reported" to suppress a real one.
    const login = c?.author?.login ?? "";
    const isOurs = /^github-actions(\[bot\])?$/.test(login) || login === env("BOT_LOGIN", "github-actions[bot]");
    const fp = isOurs ? readStamp(c?.body) : null;
    if (fp)
      out.push({
        id: t.id, fp, isResolved: t.isResolved,
        commentId: c?.databaseId, body: c?.body ?? "",
        path: t.path, origOid: c?.originalCommit?.oid ?? null,
        startLine: Number.isInteger(startLine) && startLine > 0 ? startLine : null,
        endLine: Number.isInteger(endLine) && endLine > 0 ? endLine : null,
        retired: RETIRED_RE.test(c?.body ?? ""),
        tokens: tokenSet(c?.body ?? ""),
      });
  }
  return out;
}

const RETIRED_RE = /^(?:✅|⚠️) \*\*No longer reported\*\*/;

// Did a changed hunk overlap the lines a thread was raised on? Thread spans are
// in original-commit coordinates, so compare them with the old side of a
// zero-context diff. Missing spans retain the conservative whole-file check.
const fileDiffCache = new Map();
function fileChangedSince(t, head) {
  if (!t.path || !t.origOid || !head) return null;
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

function threadAsFinding(thread) {
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
async function collapseComment(t, head) {
  if (!t.commentId) return false;
  if (DRY_RUN) { console.log(`  [suppressed] would mark comment ${t.commentId} as no longer reported`); return true; }
  if (RETIRED_RE.test(t.body)) return false; // already done
  const repo = required("GITHUB_REPO");
  const body =
    `${retirementNote(t, head)}\n\n` +
    `<details><summary>Original finding</summary>\n\n${t.body}\n\n</details>`;
  const res = await fetch(
    `https://api.github.com/repos/${repo}/pulls/comments/${t.commentId}`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${required("GH_TOKEN")}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ body }),
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

function deriveState(metadata, current, unresolved, reconciliationKnown) {
  return deriveReviewState({
    analysisState: metadata.analysis_state,
    current,
    unresolved,
    reconciliationKnown,
    blockSeverities: blockSeverities(),
  });
}

function emitState(metadata, state) {
  emitWorkflowResult({
    metadata,
    state,
    outputFile: env("GITHUB_OUTPUT", ""),
    summaryFile: env("GITHUB_STEP_SUMMARY", ""),
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

async function runSummaryMode({ metadata, findings, repo, pr, token }) {
  let history = { comment: null, findings: [], headSha: null, reconciliationKnown: true };
  try {
    const comments = await fetchSummaryComments({ repo, pr, token });
    history = selectSummaryHistory(comments, { botLogin: env("BOT_LOGIN", "github-actions[bot]") });
  } catch (error) {
    history = { comment: null, findings: [], headSha: null, reconciliationKnown: false };
    console.log(`::warning::could not read standing summary comment (${error.message})`);
  }

  const reconciled = history.reconciliationKnown
    ? await reconcileSummaryFindings({
      current: findings,
      prior: history.findings,
      priorHeadSha: history.headSha,
      headSha: metadata.head_sha,
      spanChanged: summarySpanChanged,
    })
    : { current: findings, held: [], retired: [], reconciliationKnown: false };
  const reconciliationKnown = history.reconciliationKnown && reconciled.reconciliationKnown;
  const state = deriveState(metadata, reconciled.current, reconciled.held, reconciliationKnown);
  const carried = [...reconciled.current, ...reconciled.held];
  const body = `${renderReviewBody({
    mode: "summary",
    metadata,
    state,
    current: reconciled.current,
    unresolved: reconciled.held,
  })}\n\n${encodeSummaryMarker({ headSha: metadata.head_sha, findings: carried })}`;

  emitState(metadata, state);
  if (reconciliationKnown) {
    const action = await upsertSummaryComment({
      repo,
      pr,
      token,
      existingComment: history.comment,
      body,
      hasFindings: carried.length > 0,
      writesEnabled: WRITES_ENABLED,
    });
    console.log(`  summary comment ${action}`);
  } else {
    console.log("::warning::summary reconciliation is unknown; standing comment was not changed");
  }
  if (DRY_RUN && env("SUPPRESS_WRITES", "") !== "true" && env("POST_COMMENT", "true") !== "false") {
    process.stdout.write(`${body}\n`);
  }
  enforceGate(state);
}

async function runInlineMode({ metadata, findings }) {
  let prior = [];
  let reconciliationKnown = true;
  try {
    prior = await ourThreads();
  } catch (error) {
    reconciliationKnown = false;
    console.log(`::warning::could not read existing review threads (${error.message}); posting without dedupe`);
  }

  const standing = prior.filter((thread) => !thread.isResolved && !thread.retired);
  const dismissed = prior.filter((thread) => thread.isResolved);
  const current = [];
  const fresh = [];
  const stillLive = new Set();
  let suppressed = 0;

  for (const finding of findings) {
    const match = findStandingMatch(finding, standing);
    if (match) {
      stillLive.add(match.id);
      current.push(finding);
      continue;
    }
    if (matchesUnchangedResolvedThread(finding, dismissed, metadata.head_sha)) {
      suppressed += 1;
      continue;
    }
    current.push(finding);
    fresh.push(finding);
  }
  if (suppressed) {
    console.log(`  ${suppressed} finding(s) previously resolved and unchanged — not re-raised`);
  }

  const unresolved = [];
  const resolveStale = env("RESOLVE_STALE", "true") === "true";
  for (const thread of standing) {
    if (stillLive.has(thread.id)) continue;
    const changed = fileChangedSince(thread, metadata.head_sha);
    if (changeIsConfirmed(changed) && resolveStale) {
      if (WRITES_ENABLED) {
        try {
          await retireThread(thread, metadata.head_sha);
          continue;
        } catch (error) {
          reconciliationKnown = false;
          console.log(`::warning::could not retire a thread (${error.message})`);
        }
      } else {
        console.log(`  [suppressed] would retire thread ${thread.id}`);
        continue;
      }
    }
    const carried = threadAsFinding(thread);
    if (carried) unresolved.push(carried);
    else reconciliationKnown = false;
  }

  const ranges = fresh.length > 0
    ? commentableRanges(metadata.base_sha, metadata.head_sha)
    : new Map();
  const { comments, unanchored } = build(fresh, ranges);
  const state = deriveState(metadata, current, unresolved, reconciliationKnown);
  const body = renderReviewBody({
    mode: REVIEW_MODE,
    metadata,
    state,
    current,
    unresolved,
  });
  const payload = {
    commit_id: metadata.head_sha,
    event: "COMMENT",
    body,
    comments,
  };

  emitState(metadata, state);
  console.log(
    `  ${findings.length} finding(s): ${comments.length} anchored, `
      + `${unanchored.length} summary-only, ${findings.length - fresh.length - suppressed} already open`,
  );

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
    response = await postReview({
      commit_id: payload.commit_id,
      event: "COMMENT",
      body,
    });
    if (!response.ok) {
      throw new Error(`could not post the review (${response.status}): ${response.text.slice(0, 1000)}`);
    }
  }
  console.log("  review posted");
  enforceGate(state);
}

async function main() {
  const findingsPath = required("FINDINGS_FILE");
  const metadataPath = required("REVIEW_METADATA_FILE");
  const metadata = validateRunMetadata(JSON.parse(readFileSync(metadataPath, "utf8")));
  const parsed = extractJson(readFileSync(findingsPath, "utf8"));
  if (!parsed) throw new TypeError("findings artifact is not the requested structured JSON");
  const findings = parsed.findings;
  const mode = env("REVIEW_MODE", "suggest");
  if (!["summary", "inline", "suggest"].includes(mode)) {
    throw new TypeError("REVIEW_MODE must be summary, inline, or suggest");
  }

  if (env("RENDER", "") === "1") {
    const state = deriveState(metadata, findings, [], true);
    emitState(metadata, state);
    process.stdout.write(`${renderReviewBody({
      mode,
      metadata,
      state,
      current: findings,
      unresolved: [],
    })}${mode === "summary"
      ? `\n\n${encodeSummaryMarker({ headSha: metadata.head_sha, findings })}`
      : ""}\n`);
    enforceGate(state);
    return;
  }

  if (mode === "summary") {
    await runSummaryMode({
      metadata,
      findings,
      repo: required("GITHUB_REPO"),
      pr: Number(required("PR_NUMBER")),
      token: required("GH_TOKEN"),
    });
    return;
  }
  await runInlineMode({ metadata, findings });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`::error::${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
