import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import * as poster from "./post-review.mjs";
import { deriveReviewState } from "./review-result.mjs";

const BASE_SHA = "1".repeat(40);
const HEAD_SHA = "2".repeat(40);
const PRIOR_HEAD_SHA = "4".repeat(40);
const FINGERPRINT = "3".repeat(64);
const SCOPE_HASH = "5".repeat(64);
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
    reviewed_head: HEAD_SHA,
    scope_hash: SCOPE_HASH,
    coverage: "bounded",
    remaining_analysis: [],
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

function outputValues(path) {
  return Object.fromEntries(readFileSync(path, "utf8").trim().split("\n").map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
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

function runPosterWithHistory({
  mode,
  summaryComments = [],
  threads = [],
  currentFindings = [],
  failSummaryHistory = false,
  failThreadHistory = false,
}) {
  const dir = mkdtempSync(join(tmpdir(), "post-review-history-"));
  const findingsFile = join(dir, "findings.json");
  const metadataFile = join(dir, "metadata.json");
  const outputFile = join(dir, "output");
  const preloadFile = join(dir, "mock-github.cjs");
  writeFileSync(findingsFile, JSON.stringify({ findings: currentFindings }));
  writeFileSync(metadataFile, JSON.stringify(metadata()));
  writeFileSync(preloadFile, `
const fixture = JSON.parse(process.env.POST_REVIEW_TEST_HISTORY);
const reply = (value, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => value,
  text: async () => JSON.stringify(value),
});
globalThis.fetch = async (url, options = {}) => {
  if (url === "https://api.github.com/graphql") {
    const request = JSON.parse(options.body);
    if (request.query.includes("viewer")) {
      return reply({ data: { viewer: { login: "github-actions[bot]" } } });
    }
    if (request.query.includes("reviewThreads")) {
      if (fixture.failThreadHistory) return reply({ errors: [{ message: "thread history unavailable" }] }, 500);
      return reply({ data: { repository: { pullRequest: { reviewThreads: {
        nodes: fixture.threads,
        pageInfo: { hasNextPage: false, endCursor: null },
      } } } } });
    }
  }
  if (String(url).includes("/issues/7/comments?")) {
    if (fixture.failSummaryHistory) return reply({ message: "summary history unavailable" }, 500);
    return reply(fixture.summaryComments);
  }
  throw new Error(\`unexpected GitHub request: \${url}\`);
};
`);
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./post-review.mjs", import.meta.url))],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${preloadFile}`.trim(),
        POST_REVIEW_TEST_HISTORY: JSON.stringify({
          summaryComments,
          threads,
          failSummaryHistory,
          failThreadHistory,
        }),
        FINDINGS_FILE: findingsFile,
        REVIEW_METADATA_FILE: metadataFile,
        GITHUB_OUTPUT: outputFile,
        GITHUB_REPO: "o/r",
        PR_NUMBER: "7",
        GH_TOKEN: "token",
        REVIEW_MODE: mode,
        DRY_RUN: "1",
        FAIL_ON_FINDINGS: "true",
      },
    },
  );
  const workflowOutput = readFileSync(outputFile, "utf8");
  rmSync(dir, { recursive: true, force: true });
  return { ...result, workflowOutput };
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

test("distinct held marker identities survive shared placeholder prose and keep the gate blocked", () => {
  const held = [
    finding({
      severity: "Medium",
      title: "Previously reported issue",
      body: "Previously reported finding remains held from an earlier review sample.",
      identity_tokens: ["cache", "eviction", "stale"],
    }),
    finding({
      severity: "High",
      title: "Previously reported issue",
      body: "Previously reported finding remains held from an earlier review sample.",
      identity_tokens: ["queue", "retry", "dropped"],
    }),
  ];
  const reviewState = deriveReviewState({
    analysisState: "complete",
    current: [],
    unresolved: held,
    reconciliationKnown: true,
    blockSeverities: ["Critical", "High"],
  });

  assert.deepEqual(reviewState.unresolved_counts, { Critical: 0, High: 1, Medium: 1 });
  assert.equal(reviewState.merge_state, "blocked");
  assert.equal(reviewState.sample_state, "findings");
  const body = renderReviewBody({
    mode: "summary",
    metadata: metadata(),
    state: reviewState,
    current: [],
    unresolved: held,
  });
  assert.equal(body.match(/Previously reported issue/g)?.length, 2);
});

test("malformed explicit marker identity tokens are rejected rather than weakened", () => {
  assert.throws(
    () => encodeSummaryMarker({
      headSha: PRIOR_HEAD_SHA,
      findings: [finding({ identity_tokens: ["valid", 42] })],
    }),
    /identity_tokens/,
  );
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
  assert.match(readFileSync(output, "utf8"), /coverage=unknown/);
  assert.match(readFileSync(output, "utf8"), /remaining_analysis=\["reconciliation_unknown"\]/);
  assert.match(readFileSync(output, "utf8"), /converged=false/);
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

test("switching presentation modes reconciles blocking evidence from both history stores", () => {
  const priorInline = finding({
    title: "Inline blocker survives mode switch",
    body: "The standing inline review still records a blocking cache defect.",
    suggestion: null,
  });
  const inlineBody = poster.buildReviewComments(
    [priorInline],
    new Map([[priorInline.file, [[priorInline.start_line, priorInline.end_line]]]]),
    { mode: "inline" },
  ).comments[0].body;
  const inlineThread = {
    id: "thread-1",
    isResolved: false,
    isOutdated: false,
    path: priorInline.file,
    originalStartLine: priorInline.start_line,
    originalLine: priorInline.end_line,
    comments: {
      nodes: [{
        databaseId: 17,
        body: inlineBody,
        author: { login: "github-actions[bot]" },
        originalCommit: { oid: PRIOR_HEAD_SHA },
      }],
    },
  };
  const priorSummary = finding({
    file: "src/auth.mjs",
    start_line: 8,
    end_line: 9,
    title: "Summary blocker survives mode switch",
    body: "The standing summary still records a blocking authorization defect.",
    suggestion: null,
  });
  const summaryMarker = encodeSummaryMarker({ headSha: PRIOR_HEAD_SHA, findings: [priorSummary] });
  const cases = [
    {
      mode: "summary",
      summaryComments: [],
      threads: [inlineThread],
      expectedTitle: priorInline.title,
    },
    {
      mode: "inline",
      summaryComments: [botComment(1, summaryMarker)],
      threads: [],
      expectedTitle: priorSummary.title,
    },
    {
      mode: "suggest",
      summaryComments: [botComment(1, summaryMarker)],
      threads: [],
      expectedTitle: priorSummary.title,
    },
  ];

  for (const history of cases) {
    const result = runPosterWithHistory(history);
    assert.equal(result.status, 1, `${history.mode}: ${result.stderr}`);
    assert.match(result.workflowOutput, /merge_state=blocked/);
    assert.match(result.workflowOutput, /sample_state=findings/);
    assert.match(result.workflowOutput, /bounded_converged=false/);
    assert.match(result.workflowOutput, /current_counts=\{"Critical":0,"High":0,"Medium":0\}/);
    assert.match(result.workflowOutput, /unresolved_counts=\{"Critical":0,"High":1,"Medium":0\}/);
    assert.match(result.stdout, new RegExp(history.expectedTitle));
    if (history.mode === "summary") {
      const persisted = decodeSummaryMarker(result.stdout);
      assert.deepEqual(persisted.findings.map(({ title }) => title), [priorInline.title]);
    }
  }
});

test("summary mode deduplicates one unchanged blocker across both history stores on repeated runs", () => {
  const blocker = finding({ suggestion: null });
  const inlineBody = poster.buildReviewComments(
    [blocker],
    new Map([[blocker.file, [[blocker.start_line, blocker.end_line]]]]),
    { mode: "inline" },
  ).comments[0].body;
  const inlineThread = {
    id: "duplicate-thread",
    isResolved: false,
    isOutdated: false,
    path: blocker.file,
    originalStartLine: blocker.start_line,
    originalLine: blocker.end_line,
    comments: {
      nodes: [{
        databaseId: 18,
        body: inlineBody,
        author: { login: "github-actions[bot]" },
        originalCommit: { oid: HEAD_SHA },
      }],
    },
  };
  let summaryBody = encodeSummaryMarker({ headSha: HEAD_SHA, findings: [blocker] });

  for (let run = 1; run <= 2; run += 1) {
    const result = runPosterWithHistory({
      mode: "summary",
      summaryComments: [botComment(run, summaryBody)],
      threads: [inlineThread],
    });

    assert.equal(result.status, 1, `run ${run}: ${result.stderr}`);
    assert.match(result.workflowOutput, /merge_state=blocked/);
    assert.match(result.workflowOutput, /unresolved_counts=\{"Critical":0,"High":1,"Medium":0\}/);
    assert.equal(result.stdout.match(/Cache entry survives invalidation/g)?.length, 1);
    const marker = decodeSummaryMarker(result.stdout);
    assert.equal(marker.findings.length, 1);
    assert.equal(marker.findings[0].title, blocker.title);
    summaryBody = result.stdout;
  }
});

test("summary mode preserves an unmatched prior blocker after one fuzzy current match", () => {
  const matched = finding({
    severity: "Medium",
    title: "Primary stale cache path",
    body: "The primary stale cache entry survives invalidation.",
    identity_tokens: ["cache", "entry", "stale", "survives", "invalidation"],
  });
  const unmatched = finding({
    severity: "High",
    title: "Secondary stale cache path",
    body: "A distinct stale cache path also survives invalidation.",
    identity_tokens: ["cache", "entry", "stale", "survives", "invalidation", "secondary"],
  });
  const current = finding({
    severity: "Medium",
    title: "Stale cache entry survives invalidation",
    body: "The stale cache entry survives invalidation.",
    identity_tokens: ["cache", "entry", "stale", "survives", "invalidation"],
  });
  const result = runPosterWithHistory({
    mode: "summary",
    currentFindings: [current],
    summaryComments: [
      botComment(1, encodeSummaryMarker({ headSha: HEAD_SHA, findings: [matched, unmatched] })),
    ],
  });

  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}\n${result.workflowOutput}`);
  assert.match(result.workflowOutput, /merge_state=blocked/);
  assert.match(result.workflowOutput, /current_counts=\{"Critical":0,"High":0,"Medium":1\}/);
  assert.match(result.workflowOutput, /unresolved_counts=\{"Critical":0,"High":1,"Medium":0\}/);
  assert.deepEqual(
    decodeSummaryMarker(result.stdout).findings.map(({ title }) => title),
    [current.title, unmatched.title],
  );
});

test("cross-store severity conflicts retain the blocker in every presentation mode", () => {
  const medium = finding({ severity: "Medium", suggestion: null });
  const high = finding({ severity: "High", suggestion: null });
  const inlineBody = poster.buildReviewComments(
    [high],
    new Map([[high.file, [[high.start_line, high.end_line]]]]),
    { mode: "inline" },
  ).comments[0].body;
  const inlineThread = {
    id: "higher-severity-thread",
    isResolved: false,
    isOutdated: false,
    path: high.file,
    originalStartLine: high.start_line,
    originalLine: high.end_line,
    comments: {
      nodes: [{
        databaseId: 19,
        body: inlineBody,
        author: { login: "github-actions[bot]" },
        originalCommit: { oid: HEAD_SHA },
      }],
    },
  };
  const summaryComments = [
    botComment(1, encodeSummaryMarker({ headSha: HEAD_SHA, findings: [medium] })),
  ];

  for (const mode of ["summary", "inline"]) {
    const result = runPosterWithHistory({
      mode,
      summaryComments,
      threads: [inlineThread],
    });
    assert.equal(result.status, 1, `${mode}: ${result.stderr}`);
    assert.match(result.workflowOutput, /merge_state=blocked/);
    assert.match(result.workflowOutput, /unresolved_counts=\{"Critical":0,"High":1,"Medium":0\}/);
  }
});

test("failure to read either history store prevents a clean convergence claim", () => {
  for (const history of [
    { mode: "summary", failThreadHistory: true },
    { mode: "inline", failSummaryHistory: true },
  ]) {
    const result = runPosterWithHistory(history);
    assert.equal(result.status, 0, `${history.mode}: ${result.stderr}`);
    assert.match(result.workflowOutput, /sample_state=unknown/);
    assert.match(result.workflowOutput, /bounded_converged=false/);
    assert.doesNotMatch(result.workflowOutput, /sample_state=clean/);
  }
});

test("current summary finding replaces a fuzzy prior duplicate", async () => {
  const prior = finding({ severity: "Medium" });
  const current = finding({ severity: "Critical", title: "Cache entry persists after invalidation" });
  const result = await reconcileSummaryFindings({
    analysisState: "complete",
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

test("one current fuzzy match consumes only one prior summary finding", async () => {
  const matched = finding({
    severity: "Medium",
    title: "Primary stale cache path",
    body: "The primary stale cache entry survives invalidation.",
    identity_tokens: ["cache", "entry", "stale", "survives", "invalidation"],
  });
  const unmatched = finding({
    severity: "High",
    title: "Secondary stale cache path",
    body: "A distinct stale cache path also survives invalidation.",
    identity_tokens: ["cache", "entry", "stale", "survives", "invalidation", "secondary"],
  });
  const current = finding({
    severity: "Medium",
    title: "Stale cache entry survives invalidation",
    body: "The stale cache entry survives invalidation.",
    identity_tokens: ["cache", "entry", "stale", "survives", "invalidation"],
  });
  const reconciled = await reconcileSummaryFindings({
    analysisState: "complete",
    current: [current],
    prior: [matched, unmatched],
    priorHeadSha: PRIOR_HEAD_SHA,
    headSha: HEAD_SHA,
    spanChanged: async () => false,
  });

  assert.deepEqual(reconciled.held, [unmatched]);
  const reviewState = deriveReviewState({
    analysisState: "complete",
    current: reconciled.current,
    unresolved: reconciled.held,
    reconciliationKnown: reconciled.reconciliationKnown,
    blockSeverities: ["Critical", "High"],
  });
  assert.equal(reviewState.merge_state, "blocked");
  assert.equal(reviewState.sample_state, "findings");
  assert.equal(reviewState.bounded_converged, false);
  assert.equal(shouldFailGate(reviewState, true), true);

  const body = buildStandingSummaryBody({
    metadata: metadata(),
    state: reviewState,
    current: reconciled.current,
    unresolved: reconciled.held,
  });
  assert.deepEqual(
    decodeSummaryMarker(body).findings.map(({ title }) => title),
    [current.title, unmatched.title],
  );
});

for (const [label, changed] of [["unchanged", false], ["indeterminate", null]]) {
  test(`omitted ${label} summary finding is held`, async () => {
    const prior = finding({ severity: "Medium" });
    const result = await reconcileSummaryFindings({
      analysisState: "complete",
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
    analysisState: "complete",
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

test("inconclusive summary reconciliation holds omitted findings despite confirmed overlap", async () => {
  const prior = finding({ severity: "High" });
  const result = await reconcileSummaryFindings({
    analysisState: "inconclusive",
    current: [],
    prior: [prior],
    priorHeadSha: PRIOR_HEAD_SHA,
    headSha: HEAD_SHA,
    spanChanged: async () => true,
  });
  assert.deepEqual(result.held, [prior]);
  assert.deepEqual(result.retired, []);
  const heldState = deriveReviewState({
    analysisState: "inconclusive",
    current: [],
    unresolved: result.held,
    reconciliationKnown: true,
    blockSeverities: ["Critical", "High"],
  });
  assert.equal(heldState.merge_state, "blocked");
});

test("inconclusive inline reconciliation holds omitted blockers and payload renders only fresh findings", async () => {
  const recurring = finding();
  const fresh = finding({
    file: "src/queue.mjs",
    start_line: 7,
    end_line: 7,
    severity: "Medium",
    title: "Queue retry is dropped",
    body: "The queued retry is discarded before it can run.",
    suggestion: "retainRetry();\n",
  });
  const priorBody = poster.buildReviewComments(
    [recurring],
    new Map([[recurring.file, [[20, 22]]]]),
    { mode: "suggest" },
  ).comments[0].body;
  const recurringThread = {
    id: "recurring",
    fp: priorBody.match(/agentic-review-fp:([0-9a-f]{16})/)?.[1],
    path: recurring.file,
    body: priorBody,
    tokens: new Set(),
    isResolved: false,
    retired: false,
  };
  const omittedThread = {
    id: "omitted",
    fp: "f".repeat(16),
    path: "src/standing.mjs",
    body: "`P1` High — **Standing blocker**\n\nThe earlier blocker remains unresolved.",
    tokens: new Set(["standing", "blocker", "earlier", "unresolved"]),
    startLine: 4,
    endLine: 4,
    isResolved: false,
    retired: false,
  };
  let retireCalls = 0;
  const reconciled = await poster.reconcileInlineFindings({
    metadata: metadata({ analysis_state: "inconclusive" }),
    findings: [recurring, fresh],
    standing: [recurringThread, omittedThread],
    dismissed: [],
    resolveStale: true,
    writesEnabled: true,
    changedSince: () => true,
    retire: async () => { retireCalls += 1; },
  });
  assert.deepEqual(reconciled.current, [recurring, fresh]);
  assert.deepEqual(reconciled.fresh, [fresh]);
  assert.deepEqual(reconciled.unresolved.map(({ title }) => title), ["Standing blocker"]);
  assert.equal(retireCalls, 0);

  const payload = poster.buildInlineReviewPayload({
    metadata: metadata({ analysis_state: "inconclusive" }),
    state: state({
      analysis_state: "inconclusive",
      current_counts: { Critical: 0, High: 1, Medium: 1 },
      unresolved_counts: { Critical: 0, High: 1, Medium: 0 },
    }),
    fresh: reconciled.fresh,
    unresolved: reconciled.unresolved,
    comments: [{ path: fresh.file, line: fresh.start_line, body: "fresh inline" }],
  });
  assert.doesNotMatch(payload.body, /Cache entry survives invalidation/);
  assert.match(payload.body, /Queue retry is dropped/);
  assert.doesNotMatch(JSON.stringify(payload), /replacement\(\)/);
  assert.match(payload.body, /Standing blocker/);
  assert.match(payload.body, /\| Current findings \| `Critical: 0 · High: 1 · Medium: 1` \|/);
  assert.match(payload.body, /\| Held\/unresolved findings \| `Critical: 0 · High: 1 · Medium: 0` \|/);
  assert.equal(payload.comments.length, 1);
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

test("inline review top bodies budget oversized current and held prose with artifact references", () => {
  const oversizedCurrent = finding({
    title: "Oversized current detail",
    body: incompressible(GITHUB_COMMENT_MAX_BYTES + 8_000),
    suggestion: null,
  });
  const oversizedHeld = finding({
    title: "Oversized held detail",
    body: incompressible(GITHUB_COMMENT_MAX_BYTES + 9_000),
    suggestion: null,
  });
  for (const [current, unresolved, expectedTitle] of [
    [[oversizedCurrent], [], oversizedCurrent.title],
    [[], [oversizedHeld], oversizedHeld.title],
  ]) {
    const body = poster.buildReviewTopBody({
      mode: "inline",
      metadata: metadata(),
      state: state(),
      current,
      unresolved,
    });
    assert.ok(Buffer.byteLength(body) <= GITHUB_COMMENT_MAX_BYTES);
    assert.match(body, /\| Merge gate \| `blocked` \|/);
    assert.match(body, new RegExp(expectedTitle));
    assert.match(body, /structured review artifact/i);
  }
});

test("oversized inline prose is UTF-8 bounded while its identity stamp remains intact", () => {
  const oversized = finding({
    title: "Bounded inline comment",
    body: `é${incompressible(GITHUB_COMMENT_MAX_BYTES + 8_000)}`,
    suggestion: null,
  });
  const built = poster.buildReviewComments(
    [oversized],
    new Map([["src/cache.mjs", [[20, 22]]]]),
    { mode: "inline" },
  );
  assert.equal(built.comments.length, 1);
  assert.equal(built.unanchored.length, 0);
  assert.ok(Buffer.byteLength(built.comments[0].body) <= GITHUB_COMMENT_MAX_BYTES);
  assert.match(built.comments[0].body, /complete finding.*structured artifact/i);
  assert.match(built.comments[0].body, /<!-- agentic-review-fp:[0-9a-f]{16} -->$/);
});

test("an oversized committable suggestion is omitted atomically and retained as a compact artifact note", () => {
  const replacement = `replace_start();\n${incompressible(GITHUB_COMMENT_MAX_BYTES + 8_000)}\nreplace_end();`;
  const oversized = finding({
    title: "Atomic oversized suggestion",
    body: "The complete replacement is too large for one GitHub review comment.",
    suggestion: replacement,
  });
  const built = poster.buildReviewComments(
    [oversized],
    new Map([["src/cache.mjs", [[20, 22]]]]),
    { mode: "suggest" },
  );
  assert.equal(built.comments.length, 0);
  assert.equal(built.unanchored.length, 1);
  assert.match(built.unanchored[0].reason, /suggestion.*limit/i);

  const body = poster.buildReviewTopBody({
    mode: "suggest",
    metadata: metadata(),
    state: state(),
    current: [oversized],
    unresolved: [],
  });
  assert.ok(Buffer.byteLength(body) <= GITHUB_COMMENT_MAX_BYTES);
  assert.match(body, /Atomic oversized suggestion/);
  assert.match(body, /structured review artifact/i);
  assert.doesNotMatch(body, /replace_start|replace_end/);
});

test("review fallback keeps the already bounded body and cannot resend an oversized payload", () => {
  const body = poster.buildReviewTopBody({
    mode: "inline",
    metadata: metadata(),
    state: state(),
    current: [finding({ body: incompressible(GITHUB_COMMENT_MAX_BYTES + 8_000), suggestion: null })],
    unresolved: [],
  });
  const primary = {
    commit_id: HEAD_SHA,
    event: "COMMENT",
    body,
    comments: [{ path: "src/cache.mjs", side: "RIGHT", line: 22, body: "bounded" }],
  };
  const fallback = poster.reviewFallbackPayload(primary);
  assert.deepEqual(fallback, { commit_id: HEAD_SHA, event: "COMMENT", body });
  assert.ok(Buffer.byteLength(fallback.body) <= GITHUB_COMMENT_MAX_BYTES);
  assert.throws(
    () => poster.assertReviewPayloadBudget({ ...fallback, body: "x".repeat(GITHUB_COMMENT_MAX_BYTES + 1) }),
    /body.*limit/i,
  );
});

test("stale-thread PATCH compacts an exact-limit UTF-8 body and preserves its marker", async () => {
  const fingerprint = "a".repeat(16);
  const marker = `<!-- agentic-review-fp:${fingerprint} -->`;
  const firstLine = "`P1` High — **Prior blocker**\n\n";
  const remaining = GITHUB_COMMENT_MAX_BYTES - Buffer.byteLength(firstLine) - Buffer.byteLength(marker);
  const originalBody = firstLine + "é".repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2) + marker;
  assert.equal(Buffer.byteLength(originalBody), GITHUB_COMMENT_MAX_BYTES);
  const requests = [];
  const originalRepo = process.env.GITHUB_REPO;
  const originalToken = process.env.GH_TOKEN;
  process.env.GITHUB_REPO = "o/r";
  process.env.GH_TOKEN = "token";
  try {
    const result = await poster.collapseComment({
      commentId: 91,
      body: originalBody,
      fp: fingerprint,
      path: "src/cache.mjs",
      origOid: null,
      startLine: 20,
      endLine: 22,
    }, HEAD_SHA, {
      writesEnabled: true,
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return { ok: true, status: 200, text: async () => "{}" };
      },
    });
    assert.equal(result, true);
  } finally {
    if (originalRepo === undefined) delete process.env.GITHUB_REPO;
    else process.env.GITHUB_REPO = originalRepo;
    if (originalToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalToken;
  }

  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, "PATCH");
  const payload = JSON.parse(requests[0].options.body);
  assert.ok(Buffer.byteLength(payload.body) <= GITHUB_COMMENT_MAX_BYTES);
  assert.match(payload.body, /No longer reported/);
  assert.match(payload.body, new RegExp(`<!-- agentic-review-fp:${fingerprint} -->`));
  assert.doesNotMatch(payload.body, /é{1000}/);
  assert.doesNotThrow(() => poster.assertReviewPayloadBudget(payload));
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
test("poster rejects a finding title containing CR or LF while preserving multiline bodies", () => {
  const dir = mkdtempSync(join(tmpdir(), "post-review-title-boundary-"));
  const findingsFile = join(dir, "findings.json");
  const metadataFile = join(dir, "metadata.json");
  writeFileSync(metadataFile, JSON.stringify(metadata()));
  for (const title of ["Visible title\nInjected continuation", "Visible title\rInjected continuation"]) {
    writeFileSync(findingsFile, JSON.stringify({ findings: [finding({ title })] }));
    const rejected = spawnSync(process.execPath, [fileURLToPath(new URL("./post-review.mjs", import.meta.url))], {
      encoding: "utf8",
      env: {
        ...process.env,
        FINDINGS_FILE: findingsFile,
        REVIEW_METADATA_FILE: metadataFile,
        RENDER: "1",
        REVIEW_MODE: "inline",
      },
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /findings artifact is not the requested structured JSON/);
  }
  writeFileSync(findingsFile, JSON.stringify({
    findings: [finding({ body: "First body line.\nSecond body line." })],
  }));
  const accepted = spawnSync(process.execPath, [fileURLToPath(new URL("./post-review.mjs", import.meta.url))], {
    encoding: "utf8",
    env: {
      ...process.env,
      FINDINGS_FILE: findingsFile,
      REVIEW_METADATA_FILE: metadataFile,
      RENDER: "1",
      REVIEW_MODE: "inline",
    },
  });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /First body line\.\nSecond body line\./);
});

test("successful reconciliation writes matching workflow outputs and final result artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "post-review-output-"));
  const output = join(dir, "output");
  const summary = join(dir, "summary");
  const resultFile = join(dir, "review-result.json");
  const cleanState = state({
    merge_state: "ready",
    sample_state: "clean",
    bounded_converged: true,
    current_counts: EMPTY_COUNTS,
    unresolved_counts: EMPTY_COUNTS,
  });
  emitWorkflowResult({
    metadata: metadata(),
    state: cleanState,
    outputFile: output,
    summaryFile: summary,
    resultFile,
  });

  const outputs = outputValues(output);
  assert.deepEqual(outputs, {
    analysis_state: "complete",
    merge_state: "ready",
    sample_state: "clean",
    bounded_converged: "true",
    base_sha: BASE_SHA,
    head_sha: HEAD_SHA,
    configuration_fingerprint: FINGERPRINT,
    passes_requested: "3",
    passes_completed: "3",
    current_counts: '{"Critical":0,"High":0,"Medium":0}',
    unresolved_counts: '{"Critical":0,"High":0,"Medium":0}',
    reviewed_head: HEAD_SHA,
    scope_hash: SCOPE_HASH,
    coverage: "bounded",
    remaining_analysis: "[]",
    converged: "true",
  });
  assert.deepEqual(JSON.parse(readFileSync(resultFile, "utf8")), {
    analysis_state: outputs.analysis_state,
    merge_state: outputs.merge_state,
    sample_state: outputs.sample_state,
    bounded_converged: true,
    base_sha: outputs.base_sha,
    head_sha: outputs.head_sha,
    configuration_fingerprint: outputs.configuration_fingerprint,
    passes_requested: 3,
    passes_completed: 3,
    current_counts: JSON.parse(outputs.current_counts),
    unresolved_counts: JSON.parse(outputs.unresolved_counts),
    reviewed_head: outputs.reviewed_head,
    scope_hash: outputs.scope_hash,
    coverage: outputs.coverage,
    remaining_analysis: JSON.parse(outputs.remaining_analysis),
    converged: true,
  });
  assert.equal(readFileSync(summary, "utf8"), `## Agentic review\n\n${renderStateTable(metadata(), cleanState)}\n`);
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

test("local render removes current findings from unresolved display and counts", () => {
  const dir = mkdtempSync(join(tmpdir(), "post-review-render-dedup-"));
  const findingsFile = join(dir, "findings.json");
  const unresolvedFile = join(dir, "unresolved.json");
  const metadataFile = join(dir, "metadata.json");
  const current = finding();
  writeFileSync(findingsFile, JSON.stringify({ findings: [current] }));
  writeFileSync(unresolvedFile, JSON.stringify({ findings: [current] }));
  writeFileSync(metadataFile, JSON.stringify(metadata()));
  const rendered = spawnSync(process.execPath, [fileURLToPath(new URL("./post-review.mjs", import.meta.url))], {
    encoding: "utf8",
    env: {
      ...process.env,
      FINDINGS_FILE: findingsFile,
      UNRESOLVED_FINDINGS_FILE: unresolvedFile,
      REVIEW_METADATA_FILE: metadataFile,
      RENDER: "1",
      REVIEW_MODE: "inline",
    },
  });

  assert.equal(rendered.status, 0, rendered.stderr);
  assert.equal(rendered.stdout.match(/Cache entry survives invalidation/g)?.length, 1);
  assert.match(rendered.stdout, /\| Held\/unresolved findings \| `Critical: 0 · High: 0 · Medium: 0` \|/);
  assert.doesNotMatch(rendered.stdout, /#### Held findings/);
});

test("forged current identity tokens cannot erase a distinct held High finding", () => {
  const dir = mkdtempSync(join(tmpdir(), "post-review-forged-identity-"));
  const findingsFile = join(dir, "findings.json");
  const unresolvedFile = join(dir, "unresolved.json");
  const metadataFile = join(dir, "metadata.json");
  const forgedTokens = ["trusted", "held", "marker"];
  writeFileSync(findingsFile, JSON.stringify({ findings: [finding({
    severity: "Medium",
    title: "Advisory timeout notice",
    body: "A cosmetic message uses neutral wording.",
    suggestion: null,
    identity_tokens: forgedTokens,
  })] }));
  writeFileSync(unresolvedFile, JSON.stringify({ findings: [finding({
    severity: "High",
    title: "Authorization bypass remains",
    body: "Privileged access proceeds without credential validation.",
    suggestion: null,
    identity_tokens: forgedTokens,
  })] }));
  writeFileSync(metadataFile, JSON.stringify(metadata()));
  const rendered = spawnSync(process.execPath, [fileURLToPath(new URL("./post-review.mjs", import.meta.url))], {
    encoding: "utf8",
    env: {
      ...process.env,
      FINDINGS_FILE: findingsFile,
      UNRESOLVED_FINDINGS_FILE: unresolvedFile,
      REVIEW_METADATA_FILE: metadataFile,
      RENDER: "1",
      REVIEW_MODE: "inline",
    },
  });
  rmSync(dir, { recursive: true, force: true });

  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /\| Merge gate \| `blocked` \|/);
  assert.match(rendered.stdout, /\| Current findings \| `Critical: 0 · High: 0 · Medium: 1` \|/);
  assert.match(rendered.stdout, /\| Held\/unresolved findings \| `Critical: 0 · High: 1 · Medium: 0` \|/);
  assert.match(rendered.stdout, /Authorization bypass remains/);
});

test("malformed injected identity tokens are stripped before summary rendering", () => {
  const dir = mkdtempSync(join(tmpdir(), "post-review-malformed-identity-"));
  const findingsFile = join(dir, "findings.json");
  const metadataFile = join(dir, "metadata.json");
  writeFileSync(findingsFile, JSON.stringify({ findings: [finding({
    identity_tokens: ["forged", 42],
  })] }));
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
  rmSync(dir, { recursive: true, force: true });

  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /Cache entry survives invalidation/);
  assert.match(rendered.stdout, /<!-- agentic-review-summary:v1:/);
});

test("runner and poster hard failures still write conservative outputs and a final result", (t) => {
  const script = fileURLToPath(new URL("./post-review.mjs", import.meta.url));
  for (const scenario of ["runner", "poster"]) {
    const dir = mkdtempSync(join(tmpdir(), `post-review-${scenario}-failure-`));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const findingsFile = join(dir, "findings.json");
    const metadataFile = join(dir, "metadata.json");
    const outputFile = join(dir, "output");
    const resultFile = join(dir, "review-result.json");
    if (scenario === "poster") {
      writeFileSync(findingsFile, "{not-json");
      writeFileSync(metadataFile, JSON.stringify(metadata()));
    }

    const failed = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        FINDINGS_FILE: findingsFile,
        REVIEW_METADATA_FILE: metadataFile,
        REVIEW_RESULT_FILE: resultFile,
        GITHUB_OUTPUT: outputFile,
        HEAD_SHA,
        BASE_SHA,
        RENDER: "1",
        REVIEW_MODE: "summary",
      },
    });
    assert.notEqual(failed.status, 0, scenario);
    assert.equal(existsSync(outputFile), true, `${scenario} failure must emit workflow outputs`);
    assert.equal(existsSync(resultFile), true, `${scenario} failure must retain review-result.json`);

    const outputs = outputValues(outputFile);
    for (const field of [
      "merge_state",
      "base_sha",
      "head_sha",
      "configuration_fingerprint",
      "passes_requested",
      "passes_completed",
      "current_counts",
      "unresolved_counts",
    ]) {
      assert.equal(Object.hasOwn(outputs, field), true, `${scenario} failure omitted ${field}`);
    }
    assert.equal(outputs.analysis_state, "inconclusive");
    assert.equal(outputs.sample_state, "unknown");
    assert.equal(outputs.bounded_converged, "false");
    assert.equal(outputs.reviewed_head, HEAD_SHA);
    assert.equal(outputs.scope_hash, scenario === "poster" ? SCOPE_HASH : "");
    assert.equal(outputs.coverage, "unknown");
    assert.deepEqual(JSON.parse(outputs.remaining_analysis), ["execution_failed"]);
    assert.equal(outputs.converged, "false");

    const result = JSON.parse(readFileSync(resultFile, "utf8"));
    for (const field of [
      "merge_state",
      "base_sha",
      "head_sha",
      "configuration_fingerprint",
      "passes_requested",
      "passes_completed",
      "current_counts",
      "unresolved_counts",
    ]) {
      assert.equal(Object.hasOwn(result, field), true, `${scenario} result omitted ${field}`);
    }
    assert.equal(result.analysis_state, outputs.analysis_state);
    assert.equal(result.sample_state, outputs.sample_state);
    assert.equal(result.bounded_converged, false);
    assert.equal(result.reviewed_head, outputs.reviewed_head);
    assert.equal(result.scope_hash, outputs.scope_hash);
    assert.equal(result.coverage, outputs.coverage);
    assert.deepEqual(result.remaining_analysis, JSON.parse(outputs.remaining_analysis));
    assert.equal(result.converged, false);
  }
});
