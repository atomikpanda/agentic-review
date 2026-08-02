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
import { createHash } from "node:crypto";

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
const readStamp = (body) => {
  const m = String(body ?? "").match(new RegExp(`<!-- ${MARKER}:([0-9a-f]{16}) -->`));
  return m ? m[1] : null;
};
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
  const parts = [`**${f.severity} — ${f.title}**`, "", f.body];
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
             nodes{ id isResolved isOutdated
                    comments(first:1){ nodes{ databaseId body author{login} } } } } } } }`,
    { owner, name, pr: Number(required("PR_NUMBER")) },
  );
  const nodes = data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  const out = [];
  for (const t of nodes) {
    const c = t.comments?.nodes?.[0];
    const fp = readStamp(c?.body);
    if (fp) out.push({ id: t.id, fp, isResolved: t.isResolved, commentId: c?.databaseId, body: c?.body ?? "" });
  }
  return out;
}

const RESOLVED_MARK = "✅ **No longer reported**";

async function resolveThread(id) {
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
async function collapseComment(t) {
  if (!t.commentId) return false;
  if (t.body.startsWith(RESOLVED_MARK)) return false; // already done
  const repo = required("GITHUB_REPO");
  const body =
    `${RESOLVED_MARK} — the reviewer no longer raises this.\n\n` +
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
async function retireThread(t) {
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
  return (await collapseComment(t)) ? "marked" : "skipped";
}

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
    // The model answered, just not in the requested shape — most likely prose.
    // Discarding it loses a review that has already been paid for, so post it
    // verbatim as a summary and warn. Still not silent: the annotation says the
    // contract was broken, and there are no inline comments to imply otherwise.
    console.log("::warning::agent output was not the requested JSON; posting it as a summary comment");
    if (env("DRY_RUN", "") === "1" || env("RENDER", "") === "1") {
      process.stdout.write(raw);
      return;
    }
    const res = await postReview({
      commit_id: required("HEAD_SHA"),
      event: "COMMENT",
      body: `### 🔎 Agentic review\n\n_Returned prose rather than structured findings, so there are no inline suggestions on this run._\n\n${raw}`,
    });
    if (!res.ok) {
      console.error(`::error::could not post the review (${res.status})`);
      console.error(res.text.slice(0, 1000));
      process.exit(1);
    }
    console.log("  posted as a summary comment");
    return;
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
    // Everything previously reported is now absent, so close it all out. This
    // is the "you fixed them" path and it still has to run.
    if (env("RESOLVE_STALE", "true") === "true" && !DRY_RUN) {
      try {
        let n = 0;
        for (const t of await ourThreads()) {
          if (t.isResolved) continue;
          if ((await retireThread(t)) !== "skipped") n++;
        }
        console.log(`  no findings — retired ${n} open thread(s)`);
      } catch (e) {
        console.log(`::warning::could not resolve threads (${e.message})`);
      }
    } else {
      console.log("  no findings — not posting a review");
    }
    return;
  }

  const ranges = commentableRanges(required("BASE_SHA"), required("HEAD_SHA"));

  // What this reviewer already said on this pull request.
  let prior = [];
  if (env("RESOLVE_STALE", "true") === "true" && !DRY_RUN) {
    try {
      prior = await ourThreads();
    } catch (e) {
      // Never let comment housekeeping cost us the review itself.
      console.log(`::warning::could not read existing review threads (${e.message}); posting without dedupe`);
    }
  }
  const liveFps = new Set(findings.map(fingerprint));
  const openFps = new Set(prior.filter((t) => !t.isResolved).map((t) => t.fp));

  // A finding already sitting in an open thread is not repeated. Re-posting it
  // on every push is how a bot reviewer becomes noise people mute.
  const fresh = findings.filter((f) => !openFps.has(fingerprint(f)));
  const repeats = findings.length - fresh.length;

  const { comments, unanchored } = build(fresh, ranges);

  const payload = {
    commit_id: required("HEAD_SHA"),
    event: "COMMENT", // never REQUEST_CHANGES — that blocks the PR on a bot's opinion
    body: summaryBody(fresh.length, comments, unanchored),
    comments,
  };

  console.log(
    `  ${findings.length} finding(s): ${comments.length} anchored, ` +
      `${unanchored.length} summary-only, ${repeats} already open`,
  );

  if (DRY_RUN) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  // Resolve what this reviewer no longer reports — but NOT when the findings
  // cap truncated the run. At the cap, a finding can be missing because it was
  // squeezed out rather than fixed, and resolving it would quietly retract a
  // live defect.
  const cap = Number(env("MAX_FINDINGS", "0"));
  const truncated = cap > 0 && findings.length >= cap;
  if (env("RESOLVE_STALE", "true") === "true" && prior.length > 0) {
    if (truncated) {
      console.log(`::warning::${findings.length} findings hit the max_findings cap, so nothing is being resolved — a missing finding may have been dropped rather than fixed`);
    } else {
      const tally = { resolved: 0, marked: 0, skipped: 0 };
      for (const t of prior) {
        if (t.isResolved || liveFps.has(t.fp)) continue;
        try {
          tally[await retireThread(t)]++;
        } catch (e) {
          console.log(`::warning::could not retire a thread (${e.message})`);
        }
      }
      if (tally.resolved || tally.marked) {
        console.log(`  retired ${tally.resolved + tally.marked} stale finding(s) (${tally.resolved} resolved, ${tally.marked} marked)`);
      }
    }
  }

  if (comments.length === 0 && unanchored.length === 0) {
    console.log("  nothing new to say");
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
