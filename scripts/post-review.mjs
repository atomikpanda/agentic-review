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
// The gate judges every finding, including ones suppressed as duplicates —
// a blocking defect does not stop blocking because it was reported last week.
let ALL_FINDINGS = [];
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
import { tokenSet, similarity, SIMILARITY_DEFAULT } from "./lib-findings.mjs";
import {
  GIT_DIFF_MAX_BUFFER_BYTES,
  changeIsConfirmed,
  diffTouchesSpan,
  literalPathspec,
} from "./thread-change.mjs";
const SIMILARITY = Number(env("SIMILARITY", String(SIMILARITY_DEFAULT)));
const readStamp = (body) => {
  const m = String(body ?? "").match(new RegExp(`<!-- ${MARKER}:([0-9a-f]{16}) -->`));
  return m ? m[1] : null;
};
const REVIEW_MODE = env("REVIEW_MODE", "suggest");
// One switch that blocks EVERY mutation of the pull request: no review posted,
// no thread resolved, no comment edited. The review is still produced, still
// uploaded as an artifact, and still decides the exit code — only the writes
// stop. post_comment: false was not this; it skipped the comment while leaving
// thread retirement and the gate in inconsistent states.
const DRY_RUN = env("DRY_RUN", "") === "1" || env("SUPPRESS_WRITES", "") === "true";

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

// A confidence score about the REVIEW, not about the code.
//
// The obvious feature is "safe to merge: 5/5". It is the wrong thing to ship.
// That is a claim about the code, and measured recall here is 8-9 findings out
// of 11 — so roughly a fifth of real defects go unreported, and the score would
// read highest exactly when the reviewer found nothing, which is also what a
// review that failed to look hard enough produces. Run-to-run variance makes it
// worse: identical configurations scored 5, 6, 7, 8 and 9 out of 11 on the same
// input, so the same pull request would score differently on a re-run.
//
// So this scores how much the READER should trust this particular run, from
// facts that were observed rather than judged: passes that completed, whether
// the diff was cut short, whether any injected knowledge matched the files.
// Absence of findings is never evidence of safety, and the wording says so.
function reviewConfidence() {
  // Number("") is 0 and passes isFinite, so an unset variable would read as
  // zero passes and score the run down for no reason. Absent must mean unknown.
  const num = (k) => {
    const raw = env(k, "");
    if (raw === "" || raw === undefined) return null;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  };
  const tried = num("PASSES_TRIED") ?? 1;
  const ok = num("PASSES_OK") ?? tried;
  const truncated = env("DIFF_TRUNCATED", "0") === "1";
  const skillSections = num("SKILL_SECTIONS");

  let score = 5;
  const why = [];
  if (ok < tried) { score -= 2; why.push(`${tried - ok} of ${tried} passes failed to return usable output`); }
  if (truncated) { score -= 2; why.push("the diff was truncated, so later files were never reviewed"); }
  if (skillSections === 0) { score -= 1; why.push("no injected knowledge matched these file types"); }
  if (ok === 1 && tried === 1) { score -= 1; why.push("a single pass — repeated sampling finds materially more"); }
  score = Math.max(1, Math.min(5, score));
  return { score, why };
}

// Severity vocabulary. P0/P1/P2 read better on a badge than the words do, and
// the priority framing states the action rather than the judgement.
const PRIORITY = { Critical: "P0", High: "P1", Medium: "P2" };
const badge = (sev) => `\`${PRIORITY[sev] ?? "P2"}\` ${sev}`;

// Readiness: 0-5, from the severity and quantity of what was found, mapped to
// what to do about it.
//
// One deviation from the obvious design. The score is CAPPED when the review
// could not do its job — a truncated diff or a failed pass yields few findings
// for the same reason a clean change does, and "production ready" inferred from
// a review that read half the diff is the single most dangerous output this
// tool could produce. Capping keeps the scale useful without letting it launder
// a weak run into a merge recommendation.
const READINESS = {
  5: ["Production ready", "Merge"],
  4: ["Minor polish needed", "Merge after small fixes"],
  3: ["Implementation issues", "Address feedback first"],
  2: ["Significant bugs", "Needs rework"],
  1: ["Critical problems", "Major rethink needed"],
  0: ["Critical problems", "Major rethink needed"],
};

function readiness(findings, gate) {
  const n = (sev) => findings.filter((f) => f.severity === sev).length;
  const p0 = n("Critical"), p1 = n("High"), p2 = n("Medium");

  let score;
  if (p0 >= 2) score = 0;
  else if (p0 === 1) score = 1;
  else if (p1 >= 3) score = 2;
  else if (p1 >= 1) score = 3;
  else if (p2 >= 1) score = 4;
  else score = 5;

  let capped = null;
  if (gate.verdict === "inconclusive" && score > 3) {
    capped = score;
    score = 3;
  }
  return { score, p0, p1, p2, capped, ...{ 0: {}, }[0] };
}

// A merge gate with THREE outcomes, because two would be dishonest.
//
// "Clear" and "blocked" alone force a review that could not do its job into
// "clear" — a truncated diff or a failed pass produces no findings for the same
// reason a genuinely clean change does, and the reader cannot tell them apart.
// The third state says so explicitly.
//
//   blocked       findings at or above the blocking severities
//   inconclusive  the review did not meet its own preconditions
//   clear         preconditions met AND nothing blocking found
function mergeGate(findings) {
  const blockingSeverities = env("BLOCK_SEVERITIES", "Critical,High")
    .split(",").map((x) => x.trim()).filter(Boolean);
  const blocking = findings.filter((f) => blockingSeverities.includes(f.severity));

  // Preconditions: things that make an absence of findings meaningless.
  const num = (k) => { const r = env(k, ""); if (r === "") return null; const v = Number(r); return Number.isFinite(v) ? v : null; };
  const unmet = [];
  const tried = num("PASSES_TRIED"), ok = num("PASSES_OK");
  if (tried !== null && ok !== null && ok < tried) unmet.push(`${tried - ok} of ${tried} passes returned nothing usable`);
  if (env("DIFF_TRUNCATED", "0") === "1") unmet.push("the diff was truncated, so later files were never read");
  const cap = num("MAX_FINDINGS");
  if (cap && findings.length >= cap) unmet.push(`the findings cap (${cap}) was reached, so more may exist`);

  if (blocking.length) {
    return { verdict: "blocked", blocking, unmet,
      line: `⛔ **Blocked** — ${blocking.length} ${blockingSeverities.join("/")} finding(s) to resolve.` };
  }
  if (unmet.length) {
    return { verdict: "inconclusive", blocking, unmet,
      line: "⚠️ **Inconclusive** — nothing blocking was found, but this review could not do its job, so that is not the same as clear." };
  }
  return { verdict: "clear", blocking, unmet,
    line: `✅ **Clear** — no ${blockingSeverities.join(" or ")} findings, whole diff reviewed, every pass completed.` };
}

function summaryBody(total, comments, unanchored) {
  const model = env("MODEL", "");
  const tools = env("TOOLS", "");
  const { score: conf, why } = reviewConfidence();
  const gate = mergeGate(ALL_FINDINGS);
  const r = readiness(ALL_FINDINGS, gate);
  const [meaning, action] = READINESS[r.score];

  const out = ["### 🔎 Agentic review", ""];
  out.push(`## ${r.score}/5 — ${meaning}`, "", `**${action}**`, "");
  const counts = [
    r.p0 ? `\`P0\` ${r.p0} critical` : null,
    r.p1 ? `\`P1\` ${r.p1} high` : null,
    r.p2 ? `\`P2\` ${r.p2} medium` : null,
  ].filter(Boolean);
  if (counts.length) out.push(counts.join(" · "), "");
  if (r.capped !== null) {
    out.push(
      `> Capped from ${r.capped}/5: this review could not do its job, and few findings from a review that did not finish is not the same as few defects.`,
      "",
    );
  }
  out.push(gate.line, "");
  if (gate.unmet.length) out.push(...gate.unmet.map((u) => `- ${u}`), "");
  out.push(
    `**Review confidence: ${"●".repeat(conf)}${"○".repeat(5 - conf)} ${conf}/5** — how much to trust *this run*, not whether the code is safe.`,
  );
  if (why.length) out.push("", ...why.map((w) => `- ${w}`));
  out.push(
    "",
    "_A clean review is not evidence of safety. Measured recall on a reference set is 8–9 of 11 known defects, so roughly one in five is missed._",
    "",
  );
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
function fileChangedSince(t) {
  if (!t.path || !t.origOid) return null;
  const head = required("HEAD_SHA");

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
function retirementNote(t) {
  const head = required("HEAD_SHA");
  const short = head.slice(0, 7);
  const repo = required("GITHUB_REPO");
  const link = `[\`${short}\`](https://github.com/${repo}/commit/${head})`;
  const span = t.startLine === t.endLine ? `${t.startLine}` : `${t.startLine}-${t.endLine}`;
  const location = `\`${t.path}${t.startLine && t.endLine ? `:${span}` : ""}\``;

  if (!t.path || !t.origOid) {
    return `✅ **No longer reported** as of ${link}.`;
  }
  const changed = fileChangedSince(t);
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
async function collapseComment(t) {
  if (!t.commentId) return false;
  if (DRY_RUN) { console.log(`  [suppressed] would mark comment ${t.commentId} as no longer reported`); return true; }
  if (RETIRED_RE.test(t.body)) return false; // already done
  const repo = required("GITHUB_REPO");
  const body =
    `${retirementNote(t)}\n\n` +
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

function enforceGate() {
  const gate = mergeGate(ALL_FINDINGS);
  if (env("FAIL_ON_FINDINGS", "false") === "true" && gate.verdict === "blocked") {
    console.error(`::error::${gate.blocking.length} blocking finding(s): ${env("BLOCK_SEVERITIES", "Critical,High")}`);
    process.exit(1);
  }
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
      body:
        "### 🔎 Agentic review\n\n" +
        "⚠️ **Inconclusive** — the agent answered in prose rather than the requested " +
        "structure, so severities could not be read and the merge gate could not run. " +
        "Treat the text below as unverified, and re-run before relying on it.\n\n" +
        raw,
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
  ALL_FINDINGS = findings;

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
        // Same evidence test as a normal run. This path used to retire every
        // open thread outright, so one empty review — a model hiccup, a failed
        // pass — silently closed everything, including findings whose code had
        // not been touched.
        let n = 0, held = 0;
        for (const t of await ourThreads()) {
          if (t.isResolved || t.retired) continue;
          if (!changeIsConfirmed(fileChangedSince(t))) { held++; continue; }
          if ((await retireThread(t)) !== "skipped") n++;
        }
        console.log(`  no findings — retired ${n} thread(s)` + (held ? `, held ${held} whose spans are unchanged` : ""));
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
  // Threads still standing: not resolved, and not already retired. A retired
  // thread is deliberately excluded so a finding that comes BACK is raised
  // again rather than silently suppressed by its own tombstone.
  const standing = prior.filter((t) => !t.isResolved && !t.retired);

  const matchOf = (f) => {
    const fp = fingerprint(f);
    const exact = standing.find((t) => t.fp === fp);
    if (exact) return exact;
    const tk = tokenSet(`${f.title} ${f.body}`);
    const file = String(f.file).replace(/^\.\//, "");
    let best = null;
    let bestScore = 0;
    for (const t of standing) {
      if (t.path !== file) continue;
      const sc = similarity(tk, t.tokens);
      if (sc > bestScore) { bestScore = sc; best = t; }
    }
    return bestScore >= SIMILARITY ? best : null;
  };

  // A finding already sitting in an open thread is not repeated. Re-posting it
  // on every push is how a bot reviewer becomes noise people mute.
  // A thread someone RESOLVED is a decision: fixed, intentional, or won't
  // fix. Re-raising it every push is how a reviewer gets muted. So a finding
  // that matches a resolved thread is dropped while the code in and immediately
  // around its original line span is untouched. If an overlapping hunk changes,
  // the defect may genuinely be back, and silence would be the worse error.
  //
  // Note what this deliberately does NOT do: read the comment text. Adversarial
  // comments flip 91-100% of LLM vulnerability verdicts (arXiv 2607.24964), and
  // prompt-level "ignore untrusted content" defences barely dent it — only
  // keeping the text out works. Pull-request comments are easier to inject than
  // code comments, since posting one needs no merge. So this reads our own
  // marker, a boolean, and a git diff. No attacker-authored text reaches the
  // model.
  const dismissed = prior.filter((t) => t.isResolved);
  const dismissedMatch = (f) => {
    const tk = tokenSet(`${f.title} ${f.body}`);
    const file = String(f.file).replace(/^\.\//, "");
    for (const t of dismissed) {
      if (t.path !== file) continue;
      if (similarity(tk, t.tokens) < SIMILARITY) continue;
      if (fileChangedSince(t) === false) return t;   // untouched since dismissal
    }
    return null;
  };

  const stillLive = new Set();
  const fresh = [];
  let suppressed = 0;
  for (const f of findings) {
    const m = matchOf(f);
    if (m) { stillLive.add(m.id); continue; }
    if (dismissedMatch(f)) { suppressed++; continue; }
    fresh.push(f);
  }
  const repeats = findings.length - fresh.length - suppressed;
  if (suppressed) console.log(`  ${suppressed} finding(s) previously resolved and unchanged — not re-raised`);

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
    if (env("SUPPRESS_WRITES", "") !== "true") console.log(JSON.stringify(payload, null, 2));
    console.log(`  [suppressed] ${comments.length} inline comment(s) withheld`);
    // Suppression stops writes, not judgement. The README promises
    // fail_on_findings still applies, and this early return was breaking that.
    enforceGate();
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
      for (const t of standing) {
        if (stillLive.has(t.id)) continue;
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
    // Still gate. A Critical does not stop blocking because it was already
    // reported on an earlier push — the early return skipped the check entirely.
    enforceGate();
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

  // Blocking is decided here because this is the only place that knows the
  // severities. fail_on_findings now means "fail when the gate says blocked",
  // not "fail on any finding" — failing a build over a Medium was never the
  // intent, and an inconclusive review is reported, not failed, because the
  // fault is ours rather than the contributor's.
  enforceGate();
}

// When falling back, the anchored findings still have to appear somewhere.
function findingsOf(comments, findings) {
  // Match the badge format actually emitted: `P1` High — **Title**. The earlier
  // version stripped leading/trailing ** from the whole first line, which never
  // matched once the badge was added, so the fallback silently dropped every
  // anchored finding — the opposite of what a fallback is for.
  const anchoredTitles = new Set(
    comments
      .map((c) => c.body.match(/^`P[012]` \w+ — \*\*(.*?)\*\*/)?.[1])
      .filter(Boolean),
  );
  return findings
    .filter((f) => anchoredTitles.has(f.title))
    .map((f) => ({ ...f, reason: "inline anchoring was rejected" }));
}

main().catch((e) => {
  console.error(`::error::${e?.message ?? e}`);
  process.exit(1);
});
