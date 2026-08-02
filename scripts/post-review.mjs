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
//   FINDINGS_FILE  path to the agent's output           (required)
//   GITHUB_REPO    owner/name                           (required)
//   PR_NUMBER      pull request number                  (required)
//   HEAD_SHA       commit the review is anchored to     (required)
//   BASE_SHA       base of the diff                     (required)
//   GH_TOKEN       token with pull-requests: write      (required)
//   REVIEW_MODE    "suggest" | "inline"                 (default suggest)
//   MODEL          shown in the review header           (optional)
//   TOOLS          shown in the review header           (optional)
//   DRY_RUN        "1" prints the payload, posts nothing

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const env = (k, d) => process.env[k] ?? d;
const required = (k) => {
  const v = process.env[k];
  if (!v) {
    console.error(`::error::${k} is not set`);
    process.exit(1);
  }
  return v;
};

const FINDINGS_FILE = required("FINDINGS_FILE");
const REVIEW_MODE = env("REVIEW_MODE", "suggest");
const DRY_RUN = env("DRY_RUN", "") === "1";

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
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );

  const byFile = new Map();
  let file = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      // /dev/null means the file was deleted — nothing to comment on.
      file = p === "/dev/null" ? null : p.replace(/^b\//, "");
      if (file && !byFile.has(file)) byFile.set(file, []);
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
  const parts = [`**${f.severity} — ${f.title}**`, "", f.body];
  if (withSuggestion && typeof f.suggestion === "string" && f.suggestion.length > 0) {
    // Trailing newline is stripped: the block's lines replace the target lines
    // exactly, and an extra blank line at the end inserts one into the file.
    const body = f.suggestion.replace(/\n+$/, "");
    const fence = fenceFor(body);
    parts.push("", `${fence}suggestion`, body, fence);
  }
  return parts.join("\n");
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

function summaryBody(total, comments, unanchored) {
  const model = env("MODEL", "");
  const tools = env("TOOLS", "");
  const out = ["### 🔎 Agentic review", ""];
  if (model || tools) {
    out.push(
      `_Read-only agent${tools ? ` (\`${tools}\`)` : ""}${model ? ` on \`${model}\`` : ""} — checks things the diff alone cannot show._`,
      "",
    );
  }

  const withFix = comments.filter((c) => c.body.includes("suggestion\n")).length;
  out.push(
    `${total} finding${total === 1 ? "" : "s"} — ${comments.length} inline${
      withFix ? `, ${withFix} with a suggested fix` : ""
    }${unanchored.length ? `, ${unanchored.length} below` : ""}.`,
  );

  if (unanchored.length) {
    out.push(
      "",
      "These could not be anchored to a line in this diff, so they appear here instead:",
      "",
    );
    for (const f of unanchored) {
      out.push(`#### ${f.severity ?? "Medium"} — ${f.title ?? "(untitled)"}`);
      out.push("");
      out.push(`\`${f.file}${f.start_line ? `:${f.start_line}` : ""}\` — _${f.reason}_`);
      out.push("");
      out.push(f.body ?? "");
      out.push("");
    }
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// 5. Post.
// ---------------------------------------------------------------------------
async function postReview(payload) {
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

async function main() {
  const raw = readFileSync(FINDINGS_FILE, "utf8");
  const parsed = extractJson(raw);

  if (!parsed) {
    // Do not silently succeed on unparseable output — that is the same failure
    // class as an empty review passing for a clean one.
    console.error("::error::could not parse JSON findings from the agent output");
    console.error(raw.slice(0, 2000));
    process.exit(1);
  }

  const findings = parsed.findings;

  // RENDER=1 is the local path: there is no pull request to anchor to, so
  // print the findings and their proposed fixes for a human instead. Shares
  // this file's parser so the local and CI views cannot disagree about what
  // the agent actually said.
  if (env("RENDER", "") === "1") {
    if (findings.length === 0) {
      console.log("No findings.");
      return;
    }
    const order = (f) => SEVERITY_ORDER[f.severity] ?? 9;
    for (const f of [...findings].sort((a, b) => order(a) - order(b))) {
      const span =
        f.end_line && f.end_line !== f.start_line
          ? `${f.start_line}-${f.end_line}`
          : `${f.start_line}`;
      console.log(`\n${f.severity} — ${f.title}`);
      console.log(`  ${f.file}:${span}`);
      console.log(`  ${String(f.body ?? "").replace(/\n/g, "\n  ")}`);
      if (typeof f.suggestion === "string" && f.suggestion.length > 0) {
        console.log("  suggested fix:");
        console.log(
          f.suggestion.replace(/\n+$/, "").split("\n").map((l) => `    | ${l}`).join("\n"),
        );
      }
    }
    console.log(`\n${findings.length} finding(s).`);
    return;
  }

  if (findings.length === 0) {
    console.log("  no findings — not posting a review");
    return;
  }

  const ranges = commentableRanges(required("BASE_SHA"), required("HEAD_SHA"));
  const { comments, unanchored } = build(findings, ranges);

  const payload = {
    commit_id: required("HEAD_SHA"),
    event: "COMMENT", // never REQUEST_CHANGES — that blocks the PR on a bot's opinion
    body: summaryBody(findings.length, comments, unanchored),
    comments,
  };

  console.log(
    `  ${findings.length} finding(s): ${comments.length} anchored, ${unanchored.length} summary-only`,
  );

  if (DRY_RUN) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  let res = await postReview(payload);

  if (!res.ok) {
    // 422 means at least one comment would not anchor. Rather than lose the
    // whole review, drop the inline comments and post everything as prose.
    console.log(`::warning::inline review rejected (${res.status}) — falling back to a summary comment`);
    console.log(res.text.slice(0, 1000));
    const flat = {
      commit_id: payload.commit_id,
      event: "COMMENT",
      body: summaryBody(findings.length, [], [...unanchored, ...findingsOf(comments, findings)]),
    };
    res = await postReview(flat);
    if (!res.ok) {
      console.error(`::error::could not post the review (${res.status})`);
      console.error(res.text.slice(0, 1000));
      process.exit(1);
    }
  }
  console.log("  review posted");
}

// When falling back, the anchored findings still have to appear somewhere.
function findingsOf(comments, findings) {
  const anchoredTitles = new Set(
    comments.map((c) => c.body.split("\n")[0].replace(/^\*\*|\*\*$/g, "")),
  );
  return findings
    .filter((f) => anchoredTitles.has(`${f.severity} — ${f.title}`))
    .map((f) => ({ ...f, reason: "inline anchoring was rejected" }));
}

main().catch((e) => {
  console.error(`::error::${e?.message ?? e}`);
  process.exit(1);
});
