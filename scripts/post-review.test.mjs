import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  GITHUB_COMMENT_MAX_BYTES,
  buildStandingSummaryBody,
  decodeSummaryMarker,
  emitWorkflowResult,
  encodeSummaryMarker,
  fetchOurThreads,
  fetchSummaryComments,
  fetchViewerLogin,
  findingFromThread,
  reconcileSummaryFindings,
  renderReviewBody,
  renderStateTable,
  runSummaryMode,
  selectSummaryHistory,
  shouldFailGate,
  upsertSummaryComment,
} from "./post-review.mjs";
import { deriveReviewState } from "./review-result.mjs";

const BASE_SHA = "1".repeat(40);
const HEAD_SHA = "2".repeat(40);
const PRIOR_HEAD_SHA = "4".repeat(40);
const FINGERPRINT = "3".repeat(64);
const EMPTY_COUNTS = { Critical: 0, High: 0, Medium: 0 };

function metadata(overrides = {}) {
  const pass = (id) => ({
    id,
    status: "valid",
    attempts: 1,
    finding_count: 1,
    capped: false,
    base_sha: BASE_SHA,
    head_sha: HEAD_SHA,
    configuration_fingerprint: FINGERPRINT,
  });
  return {
    schema_version: 1,
    base_sha: BASE_SHA,
    head_sha: HEAD_SHA,
    configuration_fingerprint: FINGERPRINT,
    snapshot_immutable: true,
    analysis_state: "complete",
    diff: { bytes: 120, included_bytes: 120, truncated: false },
    finding_cap: 20,
    merge_succeeded: true,
    passes: {
      requested: ["general", "correctness", "boundaries"],
      completed: ["general", "correctness", "boundaries"],
      results: [pass("general"), pass("correctness"), pass("boundaries")],
    },
    ...overrides,
  };
}

function finding(overrides = {}) {
  return {
    file: "src/cache.mjs",
    start_line: 20,
    end_line: 22,
    severity: "High",
    title: "Cache entry survives invalidation",
    body: "The stale entry is returned after invalidation.",
    suggestion: "replacement();\n",
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    analysis_state: "complete",
    merge_state: "blocked",
    sample_state: "findings",
    bounded_converged: false,
    current_counts: { Critical: 0, High: 1, Medium: 0 },
    unresolved_counts: { Critical: 0, High: 0, Medium: 1 },
    ...overrides,
  };
}

function botComment(id, body, createdAt = `2026-08-19T00:00:0${id}Z`) {
  return { id, body, created_at: createdAt, user: { login: "github-actions[bot]", type: "Bot" } };
}

function incompressible(length) {
  let value = "";
  for (let index = 0; value.length < length; index += 1) {
    value += createHash("sha256").update(String(index)).digest("base64url");
  }
  return value.slice(0, length);
}

test("summary marker round-trips only normalized carry-forward fields", () => {
  const original = finding({ file: "./src/cache.mjs", extra: "discard me" });
  const marker = encodeSummaryMarker({ headSha: PRIOR_HEAD_SHA, findings: [original] });
  assert.match(marker, /^<!-- agentic-review-summary:v1:[A-Za-z0-9_-]+ -->$/);
  assert.deepEqual(decodeSummaryMarker(marker), {
    head_sha: PRIOR_HEAD_SHA,
    findings: [{
      file: "src/cache.mjs",
      start_line: 20,
      end_line: 22,
      severity: "High",
      title: "Cache entry survives invalidation",
      body: "Previously reported finding remains held from an earlier review sample.",
      identity_tokens: ["cache", "entry", "survives", "invalidation", "stale", "returned"],
    }],
  });
  assert.ok(!marker.includes("replacement"));
  assert.ok(!marker.includes("discard me"));
});

test("decoder uses only the valid trailing standing marker", () => {
  const earlier = encodeSummaryMarker({ headSha: PRIOR_HEAD_SHA, findings: [finding()] });
  const trailing = encodeSummaryMarker({
    headSha: HEAD_SHA,
    findings: [finding({ title: "Trailing state", body: "Trailing state remains broken." })],
  });
  const decoded = decodeSummaryMarker(`${earlier}\n\nFinding prose may quote marker-like text.\n\n${trailing}\n`);
  assert.equal(decoded.head_sha, HEAD_SHA);
  assert.equal(decoded.findings[0].title, "Trailing state");
});

test("newest trusted summary marker wins while untrusted markers are ignored", () => {
  const older = encodeSummaryMarker({ headSha: PRIOR_HEAD_SHA, findings: [finding()] });
  const newer = encodeSummaryMarker({
    headSha: HEAD_SHA,
    findings: [finding({ title: "New state", body: "New state remains broken." })],
  });
  const forged = { id: 99, body: newer, created_at: "2026-08-19T00:01:00Z", user: { login: "dependabot[bot]", type: "Bot" } };
  const selected = selectSummaryHistory(
    [botComment(1, older), forged, botComment(2, newer)],
    { botLogin: "github-actions[bot]" },
  );
  assert.equal(selected.reconciliationKnown, true);
  assert.equal(selected.comment.id, 2);
  assert.equal(selected.findings[0].title, "New state");
  assert.equal(selected.headSha, HEAD_SHA);
});

test("authenticated App bot identity owns and updates its standing history", async () => {
  const login = await fetchViewerLogin({
    token: "token",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { viewer: { login: "review-app[bot]" } } }),
      text: async () => "",
    }),
  });
  const marker = encodeSummaryMarker({ headSha: PRIOR_HEAD_SHA, findings: [finding()] });
  const history = selectSummaryHistory([{
    id: 41,
    body: marker,
    created_at: "2026-08-19T00:00:00Z",
    user: { login, type: "Bot" },
  }], { botLogin: login });
  assert.equal(history.comment.id, 41);

  const calls = [];
  await upsertSummaryComment({
    repo: "o/r",
    pr: 7,
    token: "token",
    existingComment: history.comment,
    body: `updated\n\n${marker}`,
    hasFindings: true,
    writesEnabled: true,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, text: async () => "{}" };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "PATCH");
  assert.match(calls[0].url, /issues\/comments\/41$/);
});

test("unknown authenticated identity prevents a clean state and every standing write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "post-review-identity-"));
  const output = join(dir, "output");
  const originalOutput = process.env.GITHUB_OUTPUT;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  process.env.GITHUB_OUTPUT = output;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("unexpected API call");
  };
  try {
    await runSummaryMode({
      metadata: metadata(),
      findings: [],
      repo: "o/r",
      pr: 7,
      token: "token",
      botLogin: null,
      identityKnown: false,
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalOutput === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = originalOutput;
  }
  assert.equal(calls, 0);
  assert.match(readFileSync(output, "utf8"), /sample_state=unknown/);
  assert.match(readFileSync(output, "utf8"), /bounded_converged=false/);
});

test("malformed selected bot marker makes reconciliation unknown without trusting older state", () => {
  const older = encodeSummaryMarker({ headSha: PRIOR_HEAD_SHA, findings: [finding()] });
  const malformed = "<!-- agentic-review-summary:v1:not-valid-compressed-state -->";
  const selected = selectSummaryHistory(
    [botComment(1, older), botComment(2, malformed)],
    { botLogin: "github-actions[bot]" },
  );
  assert.equal(selected.reconciliationKnown, false);
  assert.equal(selected.comment.id, 2);
  assert.deepEqual(selected.findings, []);
});

test("deleting the standing summary comment resets summary history only", () => {
  assert.deepEqual(selectSummaryHistory([], { botLogin: "github-actions[bot]" }), {
    comment: null,
    findings: [],
    headSha: null,
    reconciliationKnown: true,
  });
});

test("current summary finding replaces a fuzzy prior duplicate", async () => {
  const prior = finding({ severity: "Medium" });
  const current = finding({ severity: "Critical", title: "Cache entry persists after invalidation" });
  const result = await reconcileSummaryFindings({
    current: [current],
    prior: [prior],
    priorHeadSha: PRIOR_HEAD_SHA,
    headSha: HEAD_SHA,
    spanChanged: async () => false,
  });
  assert.deepEqual(result.current, [current]);
  assert.deepEqual(result.held, []);
  assert.deepEqual(result.retired, []);
});

for (const [label, changed] of [["unchanged", false], ["indeterminate", null]]) {
  test(`omitted ${label} summary finding is held`, async () => {
    const prior = finding({ severity: "Medium" });
    const result = await reconcileSummaryFindings({
      current: [], prior: [prior], priorHeadSha: PRIOR_HEAD_SHA, headSha: HEAD_SHA,
      spanChanged: async () => changed,
    });
    assert.deepEqual(result.held, [prior]);
    assert.deepEqual(result.retired, []);
  });
}

test("omitted summary finding retires only after its original span changes", async () => {
  const prior = finding({ severity: "Medium" });
  const result = await reconcileSummaryFindings({
    current: [], prior: [prior], priorHeadSha: PRIOR_HEAD_SHA, headSha: HEAD_SHA,
    spanChanged: async (candidate, from, to) => {
      assert.equal(candidate, prior);
      assert.equal(from, PRIOR_HEAD_SHA);
      assert.equal(to, HEAD_SHA);
      return true;
    },
  });
  assert.deepEqual(result.held, []);
  assert.deepEqual(result.retired, [prior]);
});

test("state table renders the exact explicit contract", () => {
  assert.equal(renderStateTable(metadata(), state()), [
    "| Result | Value |",
    "| --- | --- |",
    "| Analysis | `complete` |",
    "| Merge gate | `blocked` |",
    "| Sample | `findings` |",
    "| Bounded convergence | `no` |",
    `| Base SHA | \`${BASE_SHA}\` |`,
    `| Head SHA | \`${HEAD_SHA}\` |`,
    `| Configuration fingerprint | \`${FINGERPRINT}\` |`,
    "| Passes | `3 requested / 3 completed` |",
    "| Current findings | `Critical: 0 · High: 1 · Medium: 0` |",
    "| Held/unresolved findings | `Critical: 0 · High: 0 · Medium: 1` |",
  ].join("\n"));
});

test("all modes render one current artifact before mode-specific history", () => {
  const current = [finding(), finding({ file: "src/queue.mjs", title: "Queue drops retry", body: "A retry is discarded.", severity: "Medium" })];
  const held = [finding({ title: "Prior cache leak", body: "A prior entry is retained.", severity: "Medium" })];
  for (const mode of ["summary", "inline", "suggest"]) {
    const body = renderReviewBody({ mode, metadata: metadata(), state: state(), current, unresolved: held });
    assert.match(body, /Cache entry survives invalidation/);
    assert.match(body, /Queue drops retry/);
    assert.match(body, /Prior cache leak/);
    assert.match(body, /\| Analysis \| `complete` \|/);
  }
});

test("local suggest rendering keeps the complete replacement and fences", () => {
  const current = [finding({ suggestion: "first();\nsecond();\n" })];
  const bodies = Object.fromEntries(["summary", "inline", "suggest"].map((mode) => [
    mode,
    renderReviewBody({ mode, metadata: metadata(), state: state(), current, unresolved: [] }),
  ]));
  assert.doesNotMatch(bodies.summary, /```suggestion|first\(\);/);
  assert.doesNotMatch(bodies.inline, /```suggestion|first\(\);/);
  assert.match(bodies.suggest, /```suggestion\nfirst\(\);\nsecond\(\);\n```/);
});

test("rendered bodies remove confidence heuristics and exhaustive or safety wording", () => {
  const body = renderReviewBody({
    mode: "summary", metadata: metadata(), state: state(), current: [finding()], unresolved: [],
  });
  for (const forbidden of ["Review confidence", "whole diff reviewed", "Production ready", "safe to merge", "evidence of safety"]) {
    assert.equal(body.includes(forbidden), false, forbidden);
  }
});

test("summary lifecycle creates once then updates the standing comment including clean", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, text: async () => "{}" };
  };
  const created = await upsertSummaryComment({
    repo: "o/r", pr: 7, token: "token", existingComment: null,
    body: "findings", hasFindings: true, writesEnabled: true, fetchImpl,
  });
  assert.equal(created, "created");
  assert.equal(calls[0].options.method, "POST");
  assert.match(calls[0].url, /\/repos\/o\/r\/issues\/7\/comments$/);

  const updated = await upsertSummaryComment({
    repo: "o/r", pr: 7, token: "token", existingComment: { id: 41 },
    body: "clean", hasFindings: false, writesEnabled: true, fetchImpl,
  });
  assert.equal(updated, "updated");
  assert.equal(calls[1].options.method, "PATCH");
  assert.match(calls[1].url, /\/repos\/o\/r\/issues\/comments\/41$/);
});

test("summary lifecycle creates no clean comment and suppresses every write", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("unexpected write"); };
  assert.equal(await upsertSummaryComment({
    repo: "o/r", pr: 7, token: "token", existingComment: null,
    body: "clean", hasFindings: false, writesEnabled: true, fetchImpl,
  }), "skipped");
  assert.equal(await upsertSummaryComment({
    repo: "o/r", pr: 7, token: "token", existingComment: { id: 41 },
    body: "findings", hasFindings: true, writesEnabled: false, fetchImpl,
  }), "suppressed");
  assert.equal(calls, 0);
});

test("standing summary budgets visible prose without dropping safety state", () => {
  const current = [finding({ body: incompressible(GITHUB_COMMENT_MAX_BYTES + 8_000) })];
  const body = buildStandingSummaryBody({
    metadata: metadata(),
    state: state({ unresolved_counts: EMPTY_COUNTS }),
    current,
    unresolved: [],
  });
  assert.ok(Buffer.byteLength(body) <= GITHUB_COMMENT_MAX_BYTES);
  assert.match(body, /\| Merge gate \| `blocked` \|/);
  assert.match(body, /<!-- agentic-review-summary:v1:/);
  assert.match(body, /display details truncated/i);
  assert.equal(decodeSummaryMarker(body).findings[0].severity, "High");
});

test("oversize safety markers and API bodies fail before POST or PATCH", async () => {
  const random = incompressible(500 * 300);
  const tooMany = Array.from({ length: 500 }, (_, index) => finding({
    file: `src/${index}-${random.slice(index * 20, index * 20 + 20)}.mjs`,
    title: random.slice(index * 240, index * 240 + 240),
    body: random.slice(index * 40, index * 40 + 40),
  }));
  assert.throws(
    () => buildStandingSummaryBody({
      metadata: metadata(),
      state: state(),
      current: tooMany,
      unresolved: [],
    }),
    /safety marker exceeds GitHub comment limit/,
  );

  let writes = 0;
  await assert.rejects(
    upsertSummaryComment({
      repo: "o/r",
      pr: 7,
      token: "token",
      existingComment: { id: 41 },
      body: "x".repeat(GITHUB_COMMENT_MAX_BYTES + 1),
      hasFindings: true,
      writesEnabled: true,
      fetchImpl: async () => {
        writes += 1;
        return { ok: true, status: 200, text: async () => "{}" };
      },
    }),
    /exceeds GitHub comment limit/,
  );
  assert.equal(writes, 0);
});

test("summary history reads every issue-comment page and fails loud on query uncertainty", async () => {
  const urls = [];
  const pageOne = Array.from({ length: 100 }, (_, id) => ({ id }));
  const comments = await fetchSummaryComments({
    repo: "o/r",
    pr: 7,
    token: "token",
    fetchImpl: async (url) => {
      urls.push(url);
      const body = url.endsWith("page=1") ? pageOne : [{ id: 101 }];
      return { ok: true, json: async () => body, text: async () => "" };
    },
  });
  assert.equal(comments.length, 101);
  assert.deepEqual(urls.map((url) => new URL(url).searchParams.get("page")), ["1", "2"]);

  await assert.rejects(
    fetchSummaryComments({
      repo: "o/r",
      pr: 7,
      token: "token",
      fetchImpl: async () => ({ ok: false, status: 503, text: async () => "unavailable" }),
    }),
    /GET issue comments 503/,
  );
});

test("paginated inline history carries a page-two blocker and fails on any page error", async () => {
  const pageTwoNode = {
    id: "thread-101",
    isResolved: false,
    isOutdated: false,
    path: "src/cache.mjs",
    originalStartLine: 20,
    originalLine: 22,
    comments: {
      nodes: [{
        databaseId: 91,
        body: "`P1` High — **Prior blocker**\n\nThe blocker remains.\n\n<!-- agentic-review-fp:aaaaaaaaaaaaaaaa -->",
        author: { login: "review-app[bot]" },
        originalCommit: { oid: PRIOR_HEAD_SHA },
      }],
    },
  };
  const page = (nodes, hasNextPage, endCursor) => ({
    repository: {
      pullRequest: {
        reviewThreads: { nodes, pageInfo: { hasNextPage, endCursor } },
      },
    },
  });
  const threads = await fetchOurThreads({
    owner: "o",
    name: "r",
    pr: 7,
    botLogin: "review-app[bot]",
    graphqlImpl: async (_query, variables) => (
      variables.cursor === null ? page([], true, "cursor-1") : page([pageTwoNode], false, null)
    ),
  });
  const unresolved = threads.map(findingFromThread);
  const reviewState = deriveReviewState({
    analysisState: "complete",
    current: [],
    unresolved,
    reconciliationKnown: true,
    blockSeverities: ["Critical", "High"],
  });
  assert.equal(reviewState.merge_state, "blocked");
  assert.deepEqual(reviewState.unresolved_counts, { Critical: 0, High: 1, Medium: 0 });

  await assert.rejects(
    fetchOurThreads({
      owner: "o",
      name: "r",
      pr: 7,
      botLogin: "review-app[bot]",
      graphqlImpl: async (_query, variables) => {
        if (variables.cursor === null) return page([], true, "cursor-1");
        throw new Error("page two unavailable");
      },
    }),
    /page two unavailable/,
  );
});

test("machine outputs and matching job summary are emitted without a comment", () => {
  const dir = mkdtempSync(join(tmpdir(), "post-review-output-"));
  const output = join(dir, "output");
  const summary = join(dir, "summary");
  emitWorkflowResult({ metadata: metadata(), state: state(), outputFile: output, summaryFile: summary });
  assert.equal(readFileSync(output, "utf8"), [
    "analysis_state=complete",
    "merge_state=blocked",
    "sample_state=findings",
    "bounded_converged=false",
    `base_sha=${BASE_SHA}`,
    `head_sha=${HEAD_SHA}`,
    `configuration_fingerprint=${FINGERPRINT}`,
    "passes_requested=3",
    "passes_completed=3",
    'current_counts={"Critical":0,"High":1,"Medium":0}',
    'unresolved_counts={"Critical":0,"High":0,"Medium":1}',
    "",
  ].join("\n"));
  assert.equal(readFileSync(summary, "utf8"), `## Agentic review\n\n${renderStateTable(metadata(), state())}\n`);
});

test("gate failure is derived only from merge_state", () => {
  assert.equal(shouldFailGate({ merge_state: "blocked" }, true), true);
  assert.equal(shouldFailGate({ merge_state: "ready", sample_state: "findings" }, true), false);
  assert.equal(shouldFailGate({ merge_state: "blocked" }, false), false);
});

test("normal execution requires and validates REVIEW_METADATA_FILE", () => {
  const dir = mkdtempSync(join(tmpdir(), "post-review-metadata-"));
  const findingsFile = join(dir, "findings.json");
  const metadataFile = join(dir, "metadata.json");
  writeFileSync(findingsFile, '{"findings":[]}');
  writeFileSync(metadataFile, JSON.stringify({ ...metadata(), snapshot_immutable: false }));
  const baseEnv = { ...process.env, FINDINGS_FILE: findingsFile, RENDER: "1", REVIEW_MODE: "summary" };

  const missing = spawnSync(process.execPath, [fileURLToPath(new URL("./post-review.mjs", import.meta.url))], {
    encoding: "utf8", env: baseEnv,
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /REVIEW_METADATA_FILE is not set/);

  const invalid = spawnSync(process.execPath, [fileURLToPath(new URL("./post-review.mjs", import.meta.url))], {
    encoding: "utf8", env: { ...baseEnv, REVIEW_METADATA_FILE: metadataFile },
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /analysis_state must be inconclusive|snapshot_immutable/);
});

test("summary render smoke uses explicit findings and metadata and emits no heuristic language", () => {
  const dir = mkdtempSync(join(tmpdir(), "post-review-render-"));
  const findingsFile = join(dir, "findings.json");
  const metadataFile = join(dir, "metadata.json");
  writeFileSync(findingsFile, JSON.stringify({ findings: [finding()] }));
  writeFileSync(metadataFile, JSON.stringify(metadata()));
  const rendered = spawnSync(process.execPath, [fileURLToPath(new URL("./post-review.mjs", import.meta.url))], {
    encoding: "utf8",
    env: {
      ...process.env,
      FINDINGS_FILE: findingsFile,
      REVIEW_METADATA_FILE: metadataFile,
      RENDER: "1",
      REVIEW_MODE: "summary",
    },
  });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /\| Analysis \| `complete` \|/);
  assert.match(rendered.stdout, /Cache entry survives invalidation/);
  assert.equal(/whole diff reviewed|Production ready|Review confidence/.test(rendered.stdout), false);
});
