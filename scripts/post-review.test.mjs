import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import test from "node:test";

import {
  GITHUB_COMMENT_MAX_BYTES,
  buildStandingSummaryBody,
  decodeSummaryMarker,
  emitWorkflowResult,
  encodeSummaryMarker,
  fetchOurThreads,
  fetchSummaryComments,
  fetchSummaryReviews,
  planHostedReviewCycle,
  fetchViewerLogin,
  findingFromThread,
  reconcileSummaryFindings,
  renderReviewBody,
  renderStateTable,
  runSummaryMode,
  selectSummaryHistory,
  shouldFailGate,
  postSummaryReview,
} from "./post-review.mjs";
import * as poster from "./post-review.mjs";
import { createReviewPublication, deriveReviewState, scopeHash } from "./review-result.mjs";

const BASE_SHA = "1".repeat(40);
const HEAD_SHA = "2".repeat(40);
const PRIOR_HEAD_SHA = "4".repeat(40);
const FINGERPRINT = "3".repeat(64);
const REVIEW_DIFF = [
  "diff --git a/src/cache.mjs b/src/cache.mjs",
  "index 1111111..2222222 100644",
  "--- a/src/cache.mjs",
  "+++ b/src/cache.mjs",
  "@@ -1 +1 @@",
  "-before",
  "+after",
  "",
].join("\n");
const SCOPE_HASH = scopeHash(reviewScope());
const EMPTY_COUNTS = { Critical: 0, High: 0, Medium: 0 };

function reviewScope(run = {}) {
  return {
    base_sha: run.base_sha ?? BASE_SHA,
    configuration_fingerprint: run.configuration_fingerprint ?? FINGERPRINT,
    diff_base64: Buffer.from(REVIEW_DIFF).toString("base64"),
    head_sha: run.head_sha ?? HEAD_SHA,
  };
}

function trustedReviewScope(run = {}) {
  return {
    ...reviewScope(run),
    bytes: Buffer.byteLength(REVIEW_DIFF),
    included_bytes: Buffer.byteLength(REVIEW_DIFF),
  };
}

function writeReviewPublication(publicationFile, runMetadata, findings = []) {
  writeFileSync(publicationFile, JSON.stringify(createReviewPublication(
    runMetadata,
    trustedReviewScope(runMetadata),
    findings,
  )));
}

function metadata(overrides = {}) {
  const baseSha = overrides.base_sha ?? BASE_SHA;
  const headSha = overrides.head_sha ?? HEAD_SHA;
  const configurationFingerprint = overrides.configuration_fingerprint ?? FINGERPRINT;
  const pass = (id) => ({
    id,
    status: "valid",
    attempts: 1,
    finding_count: 1,
    capped: false,
    base_sha: baseSha,
    head_sha: headSha,
    configuration_fingerprint: configurationFingerprint,
  });
  return {
    schema_version: 1,
    base_sha: baseSha,
    head_sha: headSha,
    configuration_fingerprint: configurationFingerprint,
    reviewed_head: headSha,
    scope_hash: scopeHash(reviewScope({
      base_sha: baseSha,
      configuration_fingerprint: configurationFingerprint,
      head_sha: headSha,
    })),
    coverage: "bounded",
    remaining_analysis: [],
    snapshot_immutable: true,
    analysis_state: "complete",
    diff: {
      bytes: Buffer.byteLength(REVIEW_DIFF),
      included_bytes: Buffer.byteLength(REVIEW_DIFF),
      truncated: false,
    },
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

function botReview(id, body, submittedAt = `2026-08-19T00:00:0${id}Z`) {
  return { id, body, submitted_at: submittedAt, user: { login: "github-actions[bot]", type: "Bot" } };
}

function incompressible(length) {
  let value = "";
  for (let index = 0; value.length < length; index += 1) {
    value += createHash("sha256").update(String(index)).digest("base64url");
  }
  return value.slice(0, length);
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Post Review Test",
      GIT_AUTHOR_EMAIL: "post-review@example.invalid",
      GIT_COMMITTER_NAME: "Post Review Test",
      GIT_COMMITTER_EMAIL: "post-review@example.invalid",
    },
  });
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function commitChangedFindingSpan(dir, prior) {
  runGit(dir, ["init", "--quiet"]);
  const path = join(dir, prior.file);
  mkdirSync(dirname(path), { recursive: true });
  const original = Array.from({ length: prior.end_line + 2 }, (_, index) => `original line ${index + 1}`);
  writeFileSync(path, `${original.join("\n")}\n`);
  runGit(dir, ["add", "--", prior.file]);
  runGit(dir, ["commit", "--quiet", "-m", "original"]);
  const originalSha = runGit(dir, ["rev-parse", "HEAD"]);

  const changed = [...original];
  for (let line = prior.start_line; line <= prior.end_line; line += 1) {
    changed[line - 1] = `changed line ${line}`;
  }
  writeFileSync(path, `${changed.join("\n")}\n`);
  runGit(dir, ["add", "--", prior.file]);
  runGit(dir, ["commit", "--quiet", "-m", "changed"]);
  return { originalSha, headSha: runGit(dir, ["rev-parse", "HEAD"]) };
}

function runPosterWithHistory({
  mode,
  summaryComments = [],
  summaryReviews = [],
  threads = [],
  currentFindings = [],
  failSummaryHistory = false,
  failReviewHistory = false,
  failThreadHistory = false,
  failSummaryPost = false,
  failRetirement = false,
  writesEnabled = false,
  suppressWrites = false,
  changedOpenFinding = null,
  coordinateLessChangedDismissedFinding = null,
  externalDiff = false,
  textconv = false,
  gitFinding = null,
  scriptArgs = [],
  extraEnv = {},
  reviewCyclePlan = null,
}) {
  const dir = mkdtempSync(join(tmpdir(), "post-review-history-"));
  let runtimeMetadata = metadata();
  let runtimeThreads = threads;
  const changedThreadFinding = changedOpenFinding ?? coordinateLessChangedDismissedFinding;
  const changedSpan = changedThreadFinding ?? gitFinding;
  if (changedSpan) {
    const { originalSha, headSha } = commitChangedFindingSpan(dir, changedSpan);
    runtimeMetadata = metadata({ base_sha: originalSha, head_sha: headSha });
  }
  if (changedThreadFinding) {
    const originalSha = runtimeMetadata.base_sha;
    const body = poster.buildReviewComments(
      [changedThreadFinding],
      new Map([[changedThreadFinding.file, [[changedThreadFinding.start_line, changedThreadFinding.end_line]]]]),
      { mode: "inline" },
    ).comments[0].body;
    runtimeThreads = [...threads, {
      id: "changed-open-thread",
      isResolved: Boolean(coordinateLessChangedDismissedFinding),
      isOutdated: false,
      path: changedThreadFinding.file,
      ...(changedOpenFinding
        ? {
            originalStartLine: changedThreadFinding.start_line,
            originalLine: changedThreadFinding.end_line,
          }
        : {}),
      comments: {
        nodes: [{
          databaseId: 901,
          body,
          author: { login: "github-actions[bot]" },
          originalCommit: { oid: originalSha },
        }],
      },
    }];
  }
  const externalDiffLog = join(dir, "external-diff.log");
  const externalDiffHelper = join(dir, "external-diff");
  if (externalDiff) {
    writeFileSync(externalDiffHelper, `#!/usr/bin/env bash
touch "\${EXTERNAL_DIFF_LOG}"
exit 0
`);
    chmodSync(externalDiffHelper, 0o755);
    runGit(dir, ["config", "diff.external", externalDiffHelper]);
    runGit(dir, ["config", "diff.trustExitCode", "true"]);
  }
  const textconvLog = join(dir, "textconv.log");
  const textconvHelper = join(dir, "empty-textconv");
  if (textconv) {
    writeFileSync(join(dir, ".gitattributes"), "* diff=empty\n");
    writeFileSync(textconvHelper, `#!/usr/bin/env bash
touch "\${TEXTCONV_LOG}"
exit 0
`);
    chmodSync(textconvHelper, 0o755);
    runGit(dir, ["config", "diff.empty.textconv", textconvHelper]);
  }
  const publicationFile = join(dir, "publication.json");
  const outputFile = join(dir, "output");
  const summaryFile = join(dir, "summary");
  const resultFile = join(dir, "review-result.json");
  const cyclePlanFile = join(dir, "review-cycle-plan.json");
  const knownFindingsFile = join(dir, "review-known-findings.json");
  if (reviewCyclePlan !== null) {
    writeFileSync(cyclePlanFile, `${JSON.stringify(reviewCyclePlan, null, 2)}\n`);
  }
  const preloadFile = join(dir, "mock-github.cjs");
  writeReviewPublication(publicationFile, runtimeMetadata, currentFindings);
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
    if (request.query.includes("resolveReviewThread")) {
      console.log("[test] hosted mutation resolve " + request.variables.id);
      console.log("[test] resolved thread " + request.variables.id);
      if (fixture.failRetirement) {
        return reply({ errors: [{ message: "retirement unavailable" }] });
      }
      return reply({ data: { resolveReviewThread: { thread: { id: request.variables.id } } } });
    }
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
  if (String(url).includes("/pulls/7/reviews?")) {
    if (fixture.failReviewHistory) return reply({ message: "review history unavailable" }, 500);
    return reply(fixture.summaryReviews);
  }
  if (String(url).includes("/issues/7/comments?")) {
    if (fixture.failSummaryHistory) return reply({ message: "summary history unavailable" }, 403);
    return reply(fixture.summaryComments);
  }
  if (options.method === "PATCH" && String(url).includes("/pulls/comments/")) {
    console.log("[test] hosted mutation collapse");
    return reply({});
  }
  if (options.method === "POST" && String(url).includes("/pulls/7/reviews")) {
    if (fixture.failSummaryPost) return reply({ message: "summary post unavailable" }, 500);
    console.log("[test] hosted mutation review");
    return reply({});
  }
  if (["POST", "PATCH"].includes(options.method) && String(url).includes("/issues/")) {
    if (fixture.failSummaryPost) return reply({ message: "summary post unavailable" }, 500);
    console.log("[test] hosted mutation summary");
    console.log("[test] wrote standing summary");
    return reply({});
  }
  throw new Error(\`unexpected GitHub request: \${url}\`);
};
`);
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./post-review.mjs", import.meta.url)), ...scriptArgs],
    {
      encoding: "utf8",
      cwd: changedSpan ? dir : undefined,
      env: {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${preloadFile}`.trim(),
        POST_REVIEW_TEST_HISTORY: JSON.stringify({
          summaryComments,
          summaryReviews,
          threads: runtimeThreads,
          failSummaryHistory,
          failReviewHistory,
          failThreadHistory,
          failSummaryPost,
          failRetirement,
        }),
        HEAD_SHA: runtimeMetadata.head_sha,
        REVIEW_PUBLICATION_FILE: publicationFile,
        GITHUB_OUTPUT: outputFile,
        GITHUB_STEP_SUMMARY: summaryFile,
        REVIEW_RESULT_FILE: resultFile,
        BASE_SHA: runtimeMetadata.base_sha,
        REVIEW_CYCLE_PLAN_FILE: cyclePlanFile,
        KNOWN_FINDINGS_FILE: knownFindingsFile,
        GITHUB_REPO: "o/r",
        PR_NUMBER: "7",
        GH_TOKEN: "token",
        REVIEW_MODE: mode,
        DRY_RUN: writesEnabled || failSummaryPost ? "0" : "1",
        SUPPRESS_WRITES: suppressWrites ? "true" : "false",
        POST_COMMENT: "true",
        RESOLVE_STALE: "true",
        FAIL_ON_FINDINGS: "true",
        ...(externalDiff
          ? {
              EXTERNAL_DIFF_LOG: externalDiffLog,
              GIT_EXTERNAL_DIFF: externalDiffHelper,
              GIT_EXTERNAL_DIFF_TRUST_EXIT_CODE: "true",
            }
          : {}),
        ...(textconv
          ? { TEXTCONV_LOG: textconvLog }
          : {}),
        ...extraEnv,
      },
    },
  );
  const workflowOutput = readFileSync(outputFile, "utf8");
  const jobSummary = existsSync(summaryFile) ? readFileSync(summaryFile, "utf8") : "";
  const finalResult = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf8")) : null;
  const cyclePlan = existsSync(cyclePlanFile) ? JSON.parse(readFileSync(cyclePlanFile, "utf8")) : null;
  const knownFindings = existsSync(knownFindingsFile)
    ? JSON.parse(readFileSync(knownFindingsFile, "utf8")).findings
    : null;
  const externalDiffExecuted = existsSync(externalDiffLog);
  const textconvExecuted = existsSync(textconvLog);
  rmSync(dir, { recursive: true, force: true });
  return {
    ...result,
    workflowOutput,
    jobSummary,
    finalResult,
    cyclePlan,
    knownFindings,
    externalDiffExecuted,
    textconvExecuted,
  };
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
      evidence_kind: "inferred",
    }],
  });
  assert.ok(!marker.includes("replacement"));
  assert.ok(!marker.includes("discard me"));
});

test("summary marker v2 round-trips hosted cycle state while v1 remains readable", () => {
  const cycle = {
    schema_version: 1,
    lineage_base_sha: BASE_SHA,
    discovery_round: 2,
    max_discovery_rounds: 2,
    state: "review_cycle_exhausted",
    last_phase: "discovery",
    next_phase: "verification",
    last_reviewed_head: HEAD_SHA,
    last_scope_hash: SCOPE_HASH,
    last_analysis_state: "complete",
    override: null,
  };
  const marker = encodeSummaryMarker({
    headSha: HEAD_SHA,
    findings: [finding()],
    cycle,
  });
  assert.match(marker, /^<!-- agentic-review-summary:v2:[A-Za-z0-9_-]+ -->$/);
  assert.deepEqual(decodeSummaryMarker(marker).cycle, cycle);

  const body = buildStandingSummaryBody({
    metadata: metadata(),
    state: deriveReviewState({
      analysisState: "complete",
      current: [finding()],
      unresolved: [],
      reconciliationKnown: true,
      blockSeverities: ["Critical", "High"],
    }),
    current: [finding()],
    unresolved: [],
    cycle,
  });
  assert.deepEqual(decodeSummaryMarker(body).cycle, cycle);
  const legacy = encodeSummaryMarker({ headSha: PRIOR_HEAD_SHA, findings: [] });
  assert.match(legacy, /^<!-- agentic-review-summary:v1:[A-Za-z0-9_-]+ -->$/);
  assert.deepEqual(decodeSummaryMarker(legacy), {
    head_sha: PRIOR_HEAD_SHA,
    findings: [],
  });
});

test("hosted cycle planning migrates v1 evidence into conservative discovery", () => {
  const priorFinding = finding();
  const plan = planHostedReviewCycle({
    reviews: [botComment(
      9,
      encodeSummaryMarker({ headSha: PRIOR_HEAD_SHA, findings: [priorFinding] }),
    )],
    comments: [],
    botLogin: "github-actions[bot]",
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    maxDiscoveryRounds: 2,
  });

  assert.equal(plan.phase, "discovery");
  assert.equal(plan.discovery_round, 2);
  assert.equal(plan.cycle.last_phase, "discovery");
  assert.equal(plan.cycle.last_analysis_state, "inconclusive");
  assert.deepEqual(plan.known_findings, []);
});


test("unrelated base retarget resets hosted cycle lineage", () => {
  const cycle = {
    schema_version: 1,
    lineage_base_sha: BASE_SHA,
    discovery_round: 1,
    max_discovery_rounds: 2,
    state: "active",
    last_phase: "discovery",
    next_phase: "verification",
    last_reviewed_head: PRIOR_HEAD_SHA,
    last_scope_hash: SCOPE_HASH,
    last_analysis_state: "complete",
    override: null,
  };
  const plan = planHostedReviewCycle({
    reviews: [botReview(1, encodeSummaryMarker({
      headSha: PRIOR_HEAD_SHA,
      findings: [finding()],
      cycle,
    }))],
    botLogin: "github-actions[bot]",
    baseSha: "7".repeat(40),
    headSha: HEAD_SHA,
    maxDiscoveryRounds: 2,
    isAncestor: (ancestor, descendant) =>
      ancestor === PRIOR_HEAD_SHA && descendant === HEAD_SHA,
  });

  assert.equal(plan.phase, "discovery");
  assert.equal(plan.discovery_round, 1);
  assert.equal(plan.cycle, null);
});
test("terminal cycle planning emits conservative evidence without another review run", () => {
  const priorFinding = finding();
  const cycle = {
    schema_version: 1,
    lineage_base_sha: BASE_SHA,
    discovery_round: 2,
    max_discovery_rounds: 2,
    state: "review_cycle_exhausted",
    last_phase: "verification",
    next_phase: null,
    last_reviewed_head: HEAD_SHA,
    last_scope_hash: SCOPE_HASH,
    last_analysis_state: "complete",
    override: null,
  };
  const result = runPosterWithHistory({
    mode: "summary",
    summaryReviews: [botComment(
      9,
      encodeSummaryMarker({ headSha: HEAD_SHA, findings: [priorFinding], cycle }),
    )],
    writesEnabled: true,
    scriptArgs: ["cycle-plan"],
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.cyclePlan.should_run, false);
  assert.equal(result.knownFindings[0].title, priorFinding.title);
  assert.equal(result.knownFindings[0].suggestion, null);
  assert.equal(result.finalResult.analysis_state, "inconclusive");
  assert.equal(result.finalResult.merge_state, "blocked");
  assert.equal(result.finalResult.sample_state, "findings");
  assert.equal(result.finalResult.coverage, "unknown");
  assert.deepEqual(result.finalResult.remaining_analysis, ["execution_failed"]);
  assert.equal(result.finalResult.bounded_converged, false);
  assert.equal(result.finalResult.converged, false);
  assert.deepEqual(result.finalResult.unresolved_counts, {
    Critical: 0,
    High: 1,
    Medium: 0,
  });
});


test("hosted cycle planning does not advance unpersisted state", () => {
  const cycle = {
    schema_version: 1,
    lineage_base_sha: BASE_SHA,
    discovery_round: 2,
    max_discovery_rounds: 2,
    state: "review_cycle_exhausted",
    last_phase: "verification",
    next_phase: null,
    last_reviewed_head: PRIOR_HEAD_SHA,
    last_scope_hash: SCOPE_HASH,
    last_analysis_state: "complete",
    override: null,
  };
  const result = runPosterWithHistory({
    mode: "summary",
    summaryReviews: [botComment(
      9,
      encodeSummaryMarker({ headSha: PRIOR_HEAD_SHA, findings: [finding()], cycle }),
    )],
    scriptArgs: ["cycle-plan"],
    extraEnv: { POST_COMMENT: "false" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.cyclePlan.persistence_enabled, false);
  assert.equal(result.cyclePlan.should_run, true);
  assert.equal(result.cyclePlan.phase, "discovery");
  assert.equal(result.cyclePlan.cycle, null);
  assert.equal(result.finalResult, null);
});


test("a pending cycle phase cannot publish a clean green result", () => {
  const priorCycle = {
    schema_version: 1,
    lineage_base_sha: BASE_SHA,
    discovery_round: 1,
    max_discovery_rounds: 2,
    state: "active",
    last_phase: "discovery",
    next_phase: "verification",
    last_reviewed_head: PRIOR_HEAD_SHA,
    last_scope_hash: SCOPE_HASH,
    last_analysis_state: "complete",
    override: null,
  };
  const result = runPosterWithHistory({
    mode: "summary",
    reviewCyclePlan: {
      should_run: true,
      phase: "verification",
      discovery_round: 1,
      lineage_base_sha: BASE_SHA,
      max_discovery_rounds: 2,
      cycle: priorCycle,
      known_findings: [],
      override: null,
    },
    extraEnv: { RENDER: "1" },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /review cycle requires discovery/);
  assert.equal(result.finalResult.sample_state, "unknown");
  assert.equal(result.finalResult.bounded_converged, false);
  assert.equal(result.finalResult.review_cycle.state, "active");
  assert.equal(result.finalResult.review_cycle.next_phase, "discovery");
});
test("cycle exhaustion fails the gate without rewriting successful execution evidence", () => {
  const priorCycle = {
    schema_version: 1,
    lineage_base_sha: BASE_SHA,
    discovery_round: 2,
    max_discovery_rounds: 2,
    state: "review_cycle_exhausted",
    last_phase: "discovery",
    next_phase: "verification",
    last_reviewed_head: PRIOR_HEAD_SHA,
    last_scope_hash: SCOPE_HASH,
    last_analysis_state: "complete",
    override: null,
  };
  const reviewCyclePlan = {
    should_run: true,
    phase: "verification",
    discovery_round: 2,
    lineage_base_sha: BASE_SHA,
    max_discovery_rounds: 2,
    cycle: priorCycle,
    known_findings: [],
    override: null,
  };
  const result = runPosterWithHistory({
    mode: "summary",
    reviewCyclePlan,
    extraEnv: { RENDER: "1" },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /review cycle exhausted/);
  assert.equal(result.finalResult.analysis_state, "complete");
  assert.equal(result.finalResult.sample_state, "unknown");
  assert.equal(result.finalResult.bounded_converged, false);
  assert.equal(result.finalResult.converged, false);
  assert.equal(result.finalResult.review_cycle.state, "review_cycle_exhausted");
  assert.equal(result.finalResult.review_cycle.next_phase, null);
  assert.equal(result.finalResult.coverage, "bounded");
  assert.deepEqual(result.finalResult.remaining_analysis, []);
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

test("newest trusted summary marker wins globally across reviews and legacy comments", () => {
  const older = encodeSummaryMarker({ headSha: PRIOR_HEAD_SHA, findings: [finding()] });
  const newer = encodeSummaryMarker({
    headSha: HEAD_SHA,
    findings: [finding({ title: "New state", body: "New state remains broken." })],
  });
  const forged = { id: 99, body: newer, submitted_at: "2026-08-19T00:01:00Z", user: { login: "dependabot[bot]", type: "Bot" } };
  const selected = selectSummaryHistory(
    [botComment(1, older), forged, botReview(2, newer)],
    { botLogin: "github-actions[bot]" },
  );
  assert.equal(selected.reconciliationKnown, true);
  assert.equal(selected.comment.id, 2);
  assert.equal(selected.findings[0].title, "New state");
  assert.equal(selected.headSha, HEAD_SHA);
});


test("higher workflow run identity wins cross-head state despite later stale publication", () => {
  const newerRun = encodeSummaryMarker({
    headSha: HEAD_SHA,
    findings: [finding({ title: "Newer run state" })],
    runId: "102",
  });
  const staleRun = encodeSummaryMarker({
    headSha: PRIOR_HEAD_SHA,
    findings: [finding({ title: "Stale run state" })],
    runId: "101",
  });
  const selected = selectSummaryHistory([
    botReview(1, newerRun),
    botReview(2, staleRun),
  ], { botLogin: "github-actions[bot]" });

  assert.equal(selected.comment.id, 1);
  assert.equal(selected.runId, "102");
  assert.equal(selected.findings[0].title, "Newer run state");
});
test("authenticated App bot identity owns and posts pull-request review history", async () => {
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
    submitted_at: "2026-08-19T00:00:00Z",
    user: { login, type: "Bot" },
  }], { botLogin: login });
  assert.equal(history.comment.id, 41);

  const calls = [];
  await postSummaryReview({
    repo: "o/r",
    pr: 7,
    token: "token",
    headSha: HEAD_SHA,
    hasHistory: true,
    body: `updated\n\n${marker}`,
    hasFindings: true,
    writesEnabled: true,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, text: async () => "{}" };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "POST");
  assert.match(calls[0].url, /pulls\/7\/reviews$/);
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

test("absence of marked reviews and legacy comments resets summary history", () => {
  assert.deepEqual(selectSummaryHistory([], { botLogin: "github-actions[bot]" }), {
    comment: null,
    findings: [],
    headSha: null,
    reconciliationKnown: true,
  });
});


test("legacy issue-comment permission failures do not suppress current hosted writes", () => {
  const current = finding({ severity: "Medium", suggestion: null });
  for (const mode of ["inline", "summary"]) {
    const result = runPosterWithHistory({
      mode,
      currentFindings: [current],
      failSummaryHistory: true,
      gitFinding: current,
      writesEnabled: true,
    });

    assert.equal(result.status, 0, `${mode}: ${result.stderr}`);
    assert.match(result.stdout, /legacy issue-comment summary history is unavailable/, mode);
    assert.match(result.stdout, /\[test\] hosted mutation review/, mode);
    assert.doesNotMatch(result.stdout, /review writes were suppressed/, mode);
    assert.match(result.workflowOutput, /current_counts=\{"Critical":0,"High":0,"Medium":1\}/, mode);
  }
});
test("unknown primary summary history cannot dismiss a current Critical finding", () => {
  const critical = finding({
    severity: "Critical",
    title: "Current critical blocker",
    suggestion: null,
  });
  const body = poster.buildReviewComments(
    [critical],
    new Map([[critical.file, [[critical.start_line, critical.end_line]]]]),
    { mode: "inline" },
  ).comments[0].body;
  const result = runPosterWithHistory({
    mode: "inline",
    currentFindings: [critical],
    failReviewHistory: true,
    threads: [{
      id: "dismissed-critical",
      isResolved: true,
      isOutdated: false,
      path: critical.file,
      originalStartLine: critical.start_line,
      originalLine: critical.end_line,
      comments: {
        nodes: [{
          databaseId: 902,
          body,
          author: { login: "github-actions[bot]" },
          originalCommit: { oid: BASE_SHA },
        }],
      },
    }],
    writesEnabled: true,
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.workflowOutput, /merge_state=blocked/);
  assert.match(result.workflowOutput, /current_counts=\{"Critical":1,"High":0,"Medium":0\}/);
  assert.match(result.workflowOutput, /remaining_analysis=\["reconciliation_unknown"\]/);
  assert.doesNotMatch(result.stdout, /previously resolved and unchanged/);
});
test("coordinate-less bot threads make reconciliation unknown and leave other omitted threads untouched", async () => {
  const blocker = finding({
    title: "Coordinate-less blocker",
    body: "The open bot-authored blocker has no trustworthy line span.",
    suggestion: null,
  });
  const threadBody = poster.buildReviewComments(
    [blocker],
    new Map([[blocker.file, [[blocker.start_line, blocker.end_line]]]]),
    { mode: "inline" },
  ).comments[0].body;
  const rawThread = {
    id: "coordinate-less-thread",
    isResolved: false,
    isOutdated: false,
    path: blocker.file,
    originalStartLine: null,
    originalLine: null,
    comments: {
      nodes: [{
        databaseId: 16,
        body: threadBody,
        author: { login: "github-actions[bot]" },
        originalCommit: { oid: PRIOR_HEAD_SHA },
      }],
    },
  };
  const threads = await fetchOurThreads({
    owner: "o",
    name: "r",
    pr: 7,
    botLogin: "github-actions[bot]",
    graphqlImpl: async () => ({
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [rawThread],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    }),
  });
  assert.equal(threads.length, 1);
  assert.deepEqual(
    {
      path: threads[0].path,
      startLine: threads[0].startLine,
      endLine: threads[0].endLine,
    },
    { path: blocker.file, startLine: null, endLine: null },
  );
  assert.equal(findingFromThread(threads[0]), null);

  for (const mode of ["summary", "inline"]) {
    const result = runPosterWithHistory({ mode, threads: [rawThread] });
    assert.equal(result.status, 0, `${mode}: ${result.stderr}\n${result.stdout}\n${result.workflowOutput}`);
    assert.match(result.workflowOutput, /sample_state=unknown/);
    assert.match(result.workflowOutput, /bounded_converged=false/);
    assert.match(result.workflowOutput, /coverage=unknown/);
    assert.match(result.workflowOutput, /remaining_analysis=\["reconciliation_unknown"\]/);
    assert.doesNotMatch(result.workflowOutput, /sample_state=clean/);
    assert.doesNotMatch(result.stdout, /Coordinate-less blocker/);
    if (mode === "summary") {
      assert.match(result.stdout, /summary review was not changed/);
      assert.deepEqual(decodeSummaryMarker(result.stdout).findings, []);
    } else {
      assert.match(result.stdout, /review writes were suppressed/);
      assert.doesNotMatch(result.stdout, /"comments":/);
    }
  }

  const omitted = finding({
    file: "src/omitted.mjs",
    start_line: 6,
    end_line: 8,
    title: "Other omitted blocker",
    body: "This valid standing thread must not be mutated after reconciliation becomes unknown.",
    suggestion: null,
  });
  for (const mode of ["summary", "inline"]) {
    const result = runPosterWithHistory({
      mode,
      threads: [rawThread],
      currentFindings: [blocker],
      changedOpenFinding: omitted,
      writesEnabled: true,
    });
    assert.equal(result.status, 1, `${mode}: ${result.stderr}\n${result.stdout}\n${result.workflowOutput}`);
    assert.doesNotMatch(result.stdout, /\[test\] hosted mutation/, `${mode}: ${result.stdout}`);
    assert.match(result.workflowOutput, /sample_state=findings/, mode);
    assert.match(result.workflowOutput, /current_counts=\{"Critical":0,"High":1,"Medium":0\}/, mode);
    assert.match(result.workflowOutput, /unresolved_counts=\{"Critical":0,"High":1,"Medium":0\}/, mode);
  }
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

test("summary mode keeps the strongest severity for a current finding matching an open inline thread", () => {
  const current = finding({ severity: "Medium", suggestion: null });
  const prior = finding({ severity: "High", suggestion: null });
  const inlineBody = poster.buildReviewComments(
    [prior],
    new Map([[prior.file, [[prior.start_line, prior.end_line]]]]),
    { mode: "inline" },
  ).comments[0].body;
  const result = runPosterWithHistory({
    mode: "summary",
    currentFindings: [current],
    threads: [{
      id: "stronger-open-thread",
      isResolved: false,
      isOutdated: false,
      path: prior.file,
      originalStartLine: prior.start_line,
      originalLine: prior.end_line,
      comments: {
        nodes: [{
          databaseId: 20,
          body: inlineBody,
          author: { login: "github-actions[bot]" },
          originalCommit: { oid: HEAD_SHA },
        }],
      },
    }],
  });

  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}\n${result.workflowOutput}`);
  assert.match(result.workflowOutput, /merge_state=blocked/);
  assert.match(result.workflowOutput, /current_counts=\{"Critical":0,"High":1,"Medium":0\}/);
  assert.match(result.workflowOutput, /unresolved_counts=\{"Critical":0,"High":0,"Medium":0\}/);
  assert.equal(result.stdout.match(/Cache entry survives invalidation/g)?.length, 1);
  assert.equal(decodeSummaryMarker(result.stdout).findings[0].severity, "High");
});

test("summary mode uses intrinsic diff spans to retire omitted changed evidence", () => {
  const prior = finding({ suggestion: null });
  const result = runPosterWithHistory({
    mode: "summary",
    changedOpenFinding: prior,
    textconv: true,
    writesEnabled: true,
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}\n${result.workflowOutput}`);
  assert.equal(result.textconvExecuted, false);
  assert.match(result.stdout, /\[test\] resolved thread changed-open-thread/);
  assert.match(result.stdout, /summary review skipped/);
  assert.doesNotMatch(result.stdout, /\[test\] hosted mutation review/);
  assert.match(result.workflowOutput, /merge_state=ready/);
  assert.match(result.workflowOutput, /sample_state=clean/);
  assert.match(result.workflowOutput, /bounded_converged=true/);
  assert.match(result.workflowOutput, /unresolved_counts=\{"Critical":0,"High":0,"Medium":0\}/);
  assert.match(result.workflowOutput, /converged=true/);
});

test("poster ignores external diff and textconv helpers for trusted evidence", () => {
  const prior = finding({ suggestion: null });
  const result = runPosterWithHistory({
    mode: "inline",
    currentFindings: [prior],
    coordinateLessChangedDismissedFinding: prior,
    externalDiff: true,
    textconv: true,
    writesEnabled: true,
  });

  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}\n${result.workflowOutput}`);
  assert.equal(result.externalDiffExecuted, false);
  assert.equal(result.textconvExecuted, false);
  assert.match(result.stdout, /1 finding\(s\): 1 anchored, 0 summary-only, 0 already open/);
  assert.match(result.stdout, /\[test\] hosted mutation review/);
});

test("summary mode holds changed inline evidence when writes are dry, suppressed, or history is unknown", () => {
  const prior = finding({ suggestion: null });
  const cases = [
    { label: "dry run", options: {} },
    { label: "suppressed writes", options: { writesEnabled: true, suppressWrites: true } },
    { label: "unknown summary history", options: { writesEnabled: true, failReviewHistory: true } },
  ];

  for (const { label, options } of cases) {
    const result = runPosterWithHistory({
      mode: "summary",
      changedOpenFinding: prior,
      ...options,
    });

    assert.equal(result.status, 1, `${label}: ${result.stderr}\n${result.stdout}\n${result.workflowOutput}`);
    assert.doesNotMatch(result.stdout, /\[test\] resolved thread/, label);
    assert.match(result.workflowOutput, /merge_state=blocked/, label);
    assert.match(result.workflowOutput, /bounded_converged=false/, label);
    assert.match(
      result.workflowOutput,
      /unresolved_counts=\{"Critical":0,"High":1,"Medium":0\}/,
      label,
    );
    assert.match(result.workflowOutput, /converged=false/, label);
  }
});

test("summary mode keeps changed inline evidence held when enabled retirement fails", () => {
  const prior = finding({ suggestion: null });
  const result = runPosterWithHistory({
    mode: "summary",
    changedOpenFinding: prior,
    writesEnabled: true,
    failRetirement: true,
  });

  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}\n${result.workflowOutput}`);
  assert.match(result.stdout, /\[test\] resolved thread changed-open-thread/);
  assert.match(result.stdout, /could not retire a thread/);
  assert.doesNotMatch(result.stdout, /\[test\] hosted mutation review/);
  assert.match(result.workflowOutput, /merge_state=blocked/);
  assert.match(result.workflowOutput, /sample_state=findings/);
  assert.match(result.workflowOutput, /bounded_converged=false/);
  assert.match(result.workflowOutput, /unresolved_counts=\{"Critical":0,"High":1,"Medium":0\}/);
  assert.match(result.workflowOutput, /remaining_analysis=\["reconciliation_unknown"\]/);
  assert.match(result.workflowOutput, /converged=false/);
});

test("inline fresh findings use the severity reconciled against summary history", async () => {
  const current = finding({ severity: "Medium", suggestion: null });
  const prior = finding({ severity: "High", suggestion: null });
  const reconciled = await poster.reconcileHostedFindings({
    metadata: metadata(),
    findings: [current],
    history: {
      summary: {
        comment: null,
        findings: [prior],
        headSha: HEAD_SHA,
        reconciliationKnown: true,
      },
      threads: [],
      threadsKnown: true,
    },
    writesEnabled: false,
  });

  assert.deepEqual(reconciled.current.map(({ severity }) => severity), ["High"]);
  assert.deepEqual(reconciled.fresh.map(({ severity }) => severity), ["High"]);
});

test("summary mode keeps an unchanged dismissed inline finding suppressed", () => {
  const dismissed = finding({ suggestion: null });
  const inlineBody = poster.buildReviewComments(
    [dismissed],
    new Map([[dismissed.file, [[dismissed.start_line, dismissed.end_line]]]]),
    { mode: "inline" },
  ).comments[0].body;
  const result = runPosterWithHistory({
    mode: "summary",
    currentFindings: [dismissed],
    threads: [{
      id: "dismissed-thread",
      isResolved: true,
      isOutdated: false,
      path: dismissed.file,
      originalStartLine: dismissed.start_line,
      originalLine: dismissed.end_line,
      comments: {
        nodes: [{
          databaseId: 21,
          body: inlineBody,
          author: { login: "github-actions[bot]" },
          originalCommit: { oid: HEAD_SHA },
        }],
      },
    }],
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}\n${result.workflowOutput}`);
  assert.match(result.workflowOutput, /merge_state=ready/);
  assert.match(result.workflowOutput, /sample_state=clean/);
  assert.match(result.workflowOutput, /current_counts=\{"Critical":0,"High":0,"Medium":0\}/);
  assert.match(result.workflowOutput, /unresolved_counts=\{"Critical":0,"High":0,"Medium":0\}/);
  assert.doesNotMatch(result.stdout, /Cache entry survives invalidation/);
  assert.deepEqual(decodeSummaryMarker(result.stdout).findings, []);
});

test("summary mode re-raises a High finding after its matching Medium thread was dismissed", () => {
  const dismissed = finding({ severity: "Medium", suggestion: null });
  const escalated = finding({ severity: "High", suggestion: null });
  const inlineBody = poster.buildReviewComments(
    [dismissed],
    new Map([[dismissed.file, [[dismissed.start_line, dismissed.end_line]]]]),
    { mode: "inline" },
  ).comments[0].body;
  const result = runPosterWithHistory({
    mode: "summary",
    currentFindings: [escalated],
    threads: [{
      id: "dismissed-medium-thread",
      isResolved: true,
      isOutdated: false,
      path: dismissed.file,
      originalStartLine: dismissed.start_line,
      originalLine: dismissed.end_line,
      comments: {
        nodes: [{
          databaseId: 24,
          body: inlineBody,
          author: { login: "github-actions[bot]" },
          originalCommit: { oid: HEAD_SHA },
        }],
      },
    }],
  });

  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}\n${result.workflowOutput}`);
  assert.match(result.workflowOutput, /merge_state=blocked/);
  assert.match(result.workflowOutput, /current_counts=\{"Critical":0,"High":1,"Medium":0\}/);
  assert.match(result.stdout, /Cache entry survives invalidation/);
  assert.equal(decodeSummaryMarker(result.stdout).findings[0].severity, "High");
});

test("inline mode re-raises a Critical finding after its matching Medium thread was dismissed", () => {
  const dismissed = finding({ severity: "Medium", suggestion: null });
  const escalated = finding({ severity: "Critical", suggestion: null });
  const inlineBody = poster.buildReviewComments(
    [dismissed],
    new Map([[dismissed.file, [[dismissed.start_line, dismissed.end_line]]]]),
    { mode: "inline" },
  ).comments[0].body;
  const result = runPosterWithHistory({
    mode: "inline",
    currentFindings: [escalated],
    gitFinding: escalated,
    threads: [{
      id: "dismissed-medium-inline-thread",
      isResolved: true,
      isOutdated: false,
      path: dismissed.file,
      originalStartLine: dismissed.start_line,
      originalLine: dismissed.end_line,
      comments: {
        nodes: [{
          databaseId: 25,
          body: inlineBody,
          author: { login: "github-actions[bot]" },
          originalCommit: { oid: HEAD_SHA },
        }],
      },
    }],
  });

  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}\n${result.workflowOutput}`);
  assert.match(result.workflowOutput, /merge_state=blocked/, `${result.stderr}\n${result.stdout}`);
  assert.match(result.workflowOutput, /current_counts=\{"Critical":1,"High":0,"Medium":0\}/);
  assert.match(result.workflowOutput, /unresolved_counts=\{"Critical":0,"High":0,"Medium":0\}/);
  assert.match(result.stdout, /Cache entry survives invalidation/);
});

test("summary mode suppresses a dismissed summary duplicate without consuming a distinct fuzzy neighbor", () => {
  const dismissed = finding({ suggestion: null });
  const unrelated = finding({
    start_line: 30,
    end_line: 31,
    title: "Secondary cache invalidation path remains stale",
    body: "A distinct stale cache entry also survives invalidation.",
    suggestion: null,
    identity_tokens: ["cache", "entry", "stale", "survives", "invalidation", "secondary"],
  });
  const inlineBody = poster.buildReviewComments(
    [dismissed],
    new Map([[dismissed.file, [[dismissed.start_line, dismissed.end_line]]]]),
    { mode: "inline" },
  ).comments[0].body;
  const result = runPosterWithHistory({
    mode: "summary",
    currentFindings: [dismissed],
    summaryComments: [
      botComment(1, encodeSummaryMarker({ headSha: HEAD_SHA, findings: [dismissed, unrelated] })),
    ],
    threads: [{
      id: "dismissed-summary-duplicate",
      isResolved: true,
      isOutdated: false,
      path: dismissed.file,
      originalStartLine: dismissed.start_line,
      originalLine: dismissed.end_line,
      comments: {
        nodes: [{
          databaseId: 22,
          body: inlineBody,
          author: { login: "github-actions[bot]" },
          originalCommit: { oid: HEAD_SHA },
        }],
      },
    }],
  });

  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}\n${result.workflowOutput}`);
  assert.match(result.workflowOutput, /merge_state=blocked/);
  assert.match(result.workflowOutput, /current_counts=\{"Critical":0,"High":0,"Medium":0\}/);
  assert.match(result.workflowOutput, /unresolved_counts=\{"Critical":0,"High":1,"Medium":0\}/);
  assert.doesNotMatch(result.stdout, /Cache entry survives invalidation/);
  assert.deepEqual(
    decodeSummaryMarker(result.stdout).findings.map(({ title }) => title),
    [unrelated.title],
  );
});

test("inline mode keeps downgraded held summary evidence dismissed without a negative already-open count", () => {
  const dismissed = finding({ severity: "High", suggestion: null });
  const held = finding({ severity: "Medium", suggestion: null });
  const inlineBody = poster.buildReviewComments(
    [dismissed],
    new Map([[dismissed.file, [[dismissed.start_line, dismissed.end_line]]]]),
    { mode: "inline" },
  ).comments[0].body;
  const result = runPosterWithHistory({
    mode: "inline",
    summaryComments: [
      botComment(1, encodeSummaryMarker({ headSha: HEAD_SHA, findings: [held] })),
    ],
    threads: [{
      id: "dismissed-summary-only",
      isResolved: true,
      isOutdated: false,
      path: dismissed.file,
      originalStartLine: dismissed.start_line,
      originalLine: dismissed.end_line,
      comments: {
        nodes: [{
          databaseId: 23,
          body: inlineBody,
          author: { login: "github-actions[bot]" },
          originalCommit: { oid: HEAD_SHA },
        }],
      },
    }],
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}\n${result.workflowOutput}`);
  assert.match(result.workflowOutput, /merge_state=ready/);
  assert.match(result.workflowOutput, /unresolved_counts=\{"Critical":0,"High":0,"Medium":0\}/);
  assert.match(result.stdout, /0 finding\(s\): 0 anchored, 0 summary-only, 0 already open/);
  assert.doesNotMatch(result.stdout, /-1 already open/);
});

test("failure to read either history store prevents a clean convergence claim", () => {
  for (const history of [
    { mode: "summary", failThreadHistory: true },
    { mode: "inline", failReviewHistory: true },
  ]) {
    const result = runPosterWithHistory(history);
    assert.equal(result.status, 0, `${history.mode}: ${result.stderr}`);
    assert.match(result.workflowOutput, /sample_state=unknown/);
    assert.match(result.workflowOutput, /bounded_converged=false/);
    assert.doesNotMatch(result.workflowOutput, /sample_state=clean/);
    if (history.mode === "summary") {
      assert.match(result.stdout, /\| Coverage \| `unknown` \|/);
      assert.match(result.stdout, /\| Remaining analysis \| `\["reconciliation_unknown"\]` \|/);
    }
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

test("summary history maximizes total similarity across ambiguous findings", async () => {
  const firstPrior = finding({
    severity: "Critical",
    title: "First prior",
    identity_tokens: ["a", "b", "x", "y"],
  });
  const secondPrior = finding({
    severity: "High",
    title: "Second prior",
    identity_tokens: ["c", "e", "u", "v"],
  });
  const ambiguousCurrent = finding({
    severity: "Medium",
    title: "Ambiguous current",
    identity_tokens: ["a", "b", "c", "e"],
  });
  const exactCurrent = finding({
    severity: "Medium",
    title: "Exact current",
    identity_tokens: ["a", "b", "x", "y"],
  });

  const reconciled = await reconcileSummaryFindings({
    analysisState: "complete",
    current: [ambiguousCurrent, exactCurrent],
    prior: [firstPrior, secondPrior],
    priorHeadSha: PRIOR_HEAD_SHA,
    headSha: HEAD_SHA,
    spanChanged: async () => assert.fail("re-reported priors must not be checked as stale"),
  });

  assert.deepEqual(reconciled.current.map(({ severity }) => severity), ["High", "Critical"]);
  assert.deepEqual(reconciled.held, []);
  assert.deepEqual(reconciled.retired, []);
  const reviewState = deriveReviewState({
    analysisState: "complete",
    current: reconciled.current,
    unresolved: reconciled.held,
    reconciliationKnown: reconciled.reconciliationKnown,
    blockSeverities: ["Critical", "High"],
  });
  assert.deepEqual(reviewState.unresolved_counts, EMPTY_COUNTS);
});

test("summary history keeps prior-order tie-breaking across equal global optima", async () => {
  const identityTokens = ["cache", "entry", "stale"];
  const current = [
    finding({ severity: "Medium", title: "First current", identity_tokens: identityTokens }),
    finding({ severity: "Medium", title: "Second current", identity_tokens: identityTokens }),
  ];
  const prior = [
    finding({ severity: "High", title: "First prior", identity_tokens: identityTokens }),
    finding({ severity: "Critical", title: "Second prior", identity_tokens: identityTokens }),
  ];

  const reconciled = await reconcileSummaryFindings({
    analysisState: "complete",
    current,
    prior,
    priorHeadSha: PRIOR_HEAD_SHA,
    headSha: HEAD_SHA,
    spanChanged: async () => assert.fail("matched priors must not be checked as stale"),
  });

  assert.deepEqual(reconciled.current.map(({ severity }) => severity), ["High", "Critical"]);
  assert.deepEqual(reconciled.held, []);
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

test("changed open inline findings remain held when retirement writes are suppressed", async () => {
  const prior = finding({ suggestion: null });
  const body = poster.buildReviewComments(
    [prior],
    new Map([[prior.file, [[prior.start_line, prior.end_line]]]]),
    { mode: "inline" },
  ).comments[0].body;
  let retireCalls = 0;
  const reconciled = await poster.reconcileInlineFindings({
    metadata: metadata(),
    findings: [],
    standing: [{
      id: "changed-open-thread",
      path: prior.file,
      body,
      startLine: prior.start_line,
      endLine: prior.end_line,
      isResolved: false,
      retired: false,
      tokens: new Set(),
    }],
    dismissed: [],
    resolveStale: true,
    writesEnabled: false,
    changedSince: () => true,
    retire: async () => { retireCalls += 1; },
  });

  assert.deepEqual(reconciled.current, []);
  assert.deepEqual(reconciled.unresolved.map(({ severity, title }) => ({ severity, title })), [{
    severity: "High",
    title: prior.title,
  }]);
  assert.equal(reconciled.reconciliationKnown, true);
  assert.equal(retireCalls, 0);
});

test("state table renders the exact explicit contract", () => {
  assert.equal(renderStateTable(metadata(), state()), [
    "| Result | Value |",
    "| --- | --- |",
    "| Analysis | `complete` |",
    "| Merge gate | `blocked` |",
    "| Sample | `findings` |",
    "| Bounded convergence | `no` |",
    `| Reviewed head | \`${HEAD_SHA}\` |`,
    `| Scope hash | \`${SCOPE_HASH}\` |`,
    "| Coverage | `bounded` |",
    "| Remaining analysis | `[]` |",
    "| Converged | `false` |",
    `| Base SHA | \`${BASE_SHA}\` |`,
    `| Head SHA | \`${HEAD_SHA}\` |`,
    `| Configuration fingerprint | \`${FINGERPRINT}\` |`,
    "| Passes | `3 requested / 3 completed` |",
    "| Current findings | `Critical: 0 · High: 1 · Medium: 0` |",
    "| Held/unresolved findings | `Critical: 0 · High: 0 · Medium: 1` |",
  ].join("\n"));
});

test("review body and job summary render the same reconciliation-adjusted final values", () => {
  const dir = mkdtempSync(join(tmpdir(), "post-review-visible-result-"));
  const summary = join(dir, "summary");
  const reviewState = state({
    sample_state: "unknown",
    bounded_converged: false,
  });
  const body = renderReviewBody({
    mode: "summary",
    metadata: metadata(),
    state: reviewState,
    current: [],
    unresolved: [],
    reconciliationKnown: false,
  });
  emitWorkflowResult({
    metadata: metadata(),
    state: reviewState,
    summaryFile: summary,
    reconciliationKnown: false,
  });

  const jobSummary = readFileSync(summary, "utf8");
  for (const row of [
    `| Reviewed head | \`${HEAD_SHA}\` |`,
    `| Scope hash | \`${SCOPE_HASH}\` |`,
    "| Coverage | `unknown` |",
    '| Remaining analysis | `["reconciliation_unknown"]` |',
    "| Converged | `false` |",
  ]) {
    assert.equal(body.includes(row), true, row);
    assert.equal(jobSummary.includes(row), true, row);
  }
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
    assert.match(body, new RegExp(`\\| Reviewed head \\| \`${HEAD_SHA}\` \\|`));
    assert.match(body, new RegExp(`\\| Scope hash \\| \`${SCOPE_HASH}\` \\|`));
    assert.match(body, /\| Coverage \| `bounded` \|/);
    assert.match(body, /\| Remaining analysis \| `\[\]` \|/);
    assert.match(body, /\| Converged \| `false` \|/);
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

test("summary lifecycle appends pull-request reviews including a later clean state", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, text: async () => "{}" };
  };
  const created = await postSummaryReview({
    repo: "o/r", pr: 7, token: "token", headSha: HEAD_SHA, hasHistory: false,
    body: "findings", hasFindings: true, writesEnabled: true, fetchImpl,
  });
  assert.equal(created, "posted");
  assert.equal(calls[0].options.method, "POST");
  assert.match(calls[0].url, /\/repos\/o\/r\/pulls\/7\/reviews$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    body: "findings",
    commit_id: HEAD_SHA,
    event: "COMMENT",
  });

  const updated = await postSummaryReview({
    repo: "o/r", pr: 7, token: "token", headSha: HEAD_SHA, hasHistory: true,
    body: "clean", hasFindings: false, writesEnabled: true, fetchImpl,
  });
  assert.equal(updated, "posted");
  assert.equal(calls[1].options.method, "POST");
  assert.match(calls[1].url, /\/repos\/o\/r\/pulls\/7\/reviews$/);
  const markerOnly = await postSummaryReview({
    repo: "o/r", pr: 7, token: "token", headSha: HEAD_SHA, hasHistory: false,
    body: "cycle marker", hasFindings: false, hasCycleState: true, writesEnabled: true, fetchImpl,
  });
  assert.equal(markerOnly, "posted");
  assert.equal(calls[2].options.method, "POST");
});


test("summary lifecycle creates no empty review and suppresses every write", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("unexpected write"); };
  assert.equal(await postSummaryReview({
    repo: "o/r", pr: 7, token: "token", headSha: HEAD_SHA, hasHistory: false,
    body: "clean", hasFindings: false, writesEnabled: true, fetchImpl,
  }), "skipped");
  assert.equal(await postSummaryReview({
    repo: "o/r", pr: 7, token: "token", headSha: HEAD_SHA, hasHistory: true,
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
    postSummaryReview({
      repo: "o/r",
      pr: 7,
      token: "token",
      headSha: HEAD_SHA,
      hasHistory: true,
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

test("summary history reads every pull-request review page with pull-request permission", async () => {
  const urls = [];
  const pageOne = Array.from({ length: 100 }, (_, id) => ({ id }));
  const reviews = await fetchSummaryReviews({
    repo: "o/r",
    pr: 7,
    token: "token",
    fetchImpl: async (url) => {
      urls.push(url);
      const body = url.endsWith("page=1") ? pageOne : [{ id: 101 }];
      return { ok: true, json: async () => body, text: async () => "" };
    },
  });
  assert.equal(reviews.length, 101);
  assert.deepEqual(urls.map((url) => new URL(url).searchParams.get("page")), ["1", "2"]);
});

test("legacy summary history reads every issue-comment page and fails loud on query uncertainty", async () => {
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
  const publicationFile = join(dir, "publication.json");
  const validPublication = createReviewPublication(
    metadata(),
    trustedReviewScope(),
    [],
  );
  for (const title of ["Visible title\nInjected continuation", "Visible title\rInjected continuation"]) {
    writeFileSync(publicationFile, JSON.stringify({
      ...validPublication,
      findings: [finding({ title })],
    }));
    const rejected = spawnSync(process.execPath, [fileURLToPath(new URL("./post-review.mjs", import.meta.url))], {
      encoding: "utf8",
      env: {
        ...process.env,
        HEAD_SHA,
        REVIEW_PUBLICATION_FILE: publicationFile,
        RENDER: "1",
        REVIEW_MODE: "inline",
      },
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /publication findings/);
  }
  writeReviewPublication(
    publicationFile,
    metadata(),
    [finding({ body: "First body line.\nSecond body line." })],
  );
  const accepted = spawnSync(process.execPath, [fileURLToPath(new URL("./post-review.mjs", import.meta.url))], {
    encoding: "utf8",
    env: {
      ...process.env,
      HEAD_SHA,
      REVIEW_PUBLICATION_FILE: publicationFile,
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
  assert.equal(readFileSync(summary, "utf8"), [
    "## Agentic review",
    "",
    renderStateTable(metadata(), cleanState),
    "",
  ].join("\n"));
});

test("gate failure is derived only from merge_state", () => {
  assert.equal(shouldFailGate({ merge_state: "blocked" }, true), true);
  assert.equal(shouldFailGate({ merge_state: "ready", sample_state: "findings" }, true), false);
  assert.equal(shouldFailGate({ merge_state: "blocked" }, false), false);
});

test("normal execution requires and validates REVIEW_PUBLICATION_FILE", () => {
  const dir = mkdtempSync(join(tmpdir(), "post-review-publication-"));
  const publicationFile = join(dir, "publication.json");
  writeFileSync(publicationFile, JSON.stringify({
    schema_version: 2,
    findings: [],
    metadata: { ...metadata(), snapshot_immutable: false },
    scope: trustedReviewScope(),
  }));
  const baseEnv = { ...process.env, HEAD_SHA, RENDER: "1", REVIEW_MODE: "summary" };

  const missing = spawnSync(process.execPath, [fileURLToPath(new URL("./post-review.mjs", import.meta.url))], {
    encoding: "utf8", env: baseEnv,
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /REVIEW_PUBLICATION_FILE is not set/);

  const invalid = spawnSync(process.execPath, [fileURLToPath(new URL("./post-review.mjs", import.meta.url))], {
    encoding: "utf8", env: {
      ...baseEnv,
      REVIEW_PUBLICATION_FILE: publicationFile,
    },
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /analysis_state must be inconclusive|snapshot_immutable/);

  writeReviewPublication(publicationFile, metadata(), []);
  const wrongHead = spawnSync(process.execPath, [fileURLToPath(new URL("./post-review.mjs", import.meta.url))], {
    encoding: "utf8", env: {
      ...baseEnv,
      HEAD_SHA: "4".repeat(40),
      REVIEW_PUBLICATION_FILE: publicationFile,
    },
  });
  assert.notEqual(wrongHead.status, 0);
  assert.match(wrongHead.stderr, /publication head_sha must match expected head_sha/);
});

test("summary render smoke uses the authoritative publication and emits no heuristic language", () => {
  const dir = mkdtempSync(join(tmpdir(), "post-review-render-"));
  const publicationFile = join(dir, "publication.json");
  writeReviewPublication(publicationFile, metadata(), [finding()]);
  const rendered = spawnSync(process.execPath, [fileURLToPath(new URL("./post-review.mjs", import.meta.url))], {
    encoding: "utf8",
    env: {
      ...process.env,
      HEAD_SHA,
      REVIEW_PUBLICATION_FILE: publicationFile,
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
  const unresolvedFile = join(dir, "unresolved.json");
  const publicationFile = join(dir, "publication.json");
  const current = finding();
  writeFileSync(unresolvedFile, JSON.stringify({ findings: [current] }));
  writeReviewPublication(publicationFile, metadata(), [current]);
  const rendered = spawnSync(process.execPath, [fileURLToPath(new URL("./post-review.mjs", import.meta.url))], {
    encoding: "utf8",
    env: {
      ...process.env,
      UNRESOLVED_FINDINGS_FILE: unresolvedFile,
      HEAD_SHA,
      REVIEW_PUBLICATION_FILE: publicationFile,
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
  const unresolvedFile = join(dir, "unresolved.json");
  const publicationFile = join(dir, "publication.json");
  const forgedTokens = ["trusted", "held", "marker"];
  const current = finding({
    severity: "Medium",
    title: "Advisory timeout notice",
    body: "A cosmetic message uses neutral wording.",
    suggestion: null,
    identity_tokens: forgedTokens,
  });
  writeFileSync(unresolvedFile, JSON.stringify({ findings: [finding({
    severity: "High",
    title: "Authorization bypass remains",
    body: "Privileged access proceeds without credential validation.",
    suggestion: null,
    identity_tokens: forgedTokens,
  })] }));
  writeReviewPublication(publicationFile, metadata(), [current]);
  const rendered = spawnSync(process.execPath, [fileURLToPath(new URL("./post-review.mjs", import.meta.url))], {
    encoding: "utf8",
    env: {
      ...process.env,
      UNRESOLVED_FINDINGS_FILE: unresolvedFile,
      HEAD_SHA,
      REVIEW_PUBLICATION_FILE: publicationFile,
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
  const publicationFile = join(dir, "publication.json");
  writeReviewPublication(publicationFile, metadata(), [finding({
    identity_tokens: ["forged", 42],
  })]);
  const rendered = spawnSync(process.execPath, [fileURLToPath(new URL("./post-review.mjs", import.meta.url))], {
    encoding: "utf8",
    env: {
      ...process.env,
      HEAD_SHA,
      REVIEW_PUBLICATION_FILE: publicationFile,
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
    const publicationFile = join(dir, "publication.json");
    const outputFile = join(dir, "output");
    const resultFile = join(dir, "review-result.json");
    if (scenario === "poster") {
      writeReviewPublication(publicationFile, metadata(), []);
    }

    const failed = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        REVIEW_PUBLICATION_FILE: publicationFile,
        REVIEW_RESULT_FILE: resultFile,
        GITHUB_OUTPUT: outputFile,
        HEAD_SHA,
        BASE_SHA,
        RENDER: "1",
        REVIEW_MODE: scenario === "poster" ? "invalid" : "summary",
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
    assert.equal(outputs.merge_state, "ready");
    assert.deepEqual(JSON.parse(outputs.current_counts), EMPTY_COUNTS);
    assert.deepEqual(JSON.parse(outputs.unresolved_counts), EMPTY_COUNTS);
    assert.equal(outputs.reviewed_head, HEAD_SHA);
    assert.equal(outputs.scope_hash, scenario === "poster" ? SCOPE_HASH : "");
    assert.equal(outputs.coverage, "unknown");
    assert.deepEqual(
      JSON.parse(outputs.remaining_analysis),
      scenario === "poster"
        ? ["reconciliation_unknown", "execution_failed"]
        : ["execution_failed"],
    );
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

test("pre-reconciliation failures preserve validated Critical and High publication evidence", (t) => {
  const script = fileURLToPath(new URL("./post-review.mjs", import.meta.url));
  const scenarios = [
    {
      name: "invalid REVIEW_MODE",
      env: { RENDER: "1", REVIEW_MODE: "invalid" },
      error: /REVIEW_MODE must be summary, inline, or suggest/,
      publishedFinding: finding({ severity: "Critical" }),
      expectedCounts: { Critical: 1, High: 0, Medium: 0 },
    },
    {
      name: "missing GitHub context",
      env: { RENDER: "", GITHUB_REPO: "", PR_NUMBER: "", GH_TOKEN: "", REVIEW_MODE: "summary" },
      error: /GITHUB_REPO is not set/,
      publishedFinding: finding({ severity: "High" }),
      expectedCounts: { Critical: 0, High: 1, Medium: 0 },
    },
  ];

  for (const scenario of scenarios) {
    const dir = mkdtempSync(join(tmpdir(), "post-review-pre-reconciliation-failure-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const publicationFile = join(dir, "publication.json");
    const outputFile = join(dir, "output");
    const resultFile = join(dir, "review-result.json");
    writeReviewPublication(publicationFile, metadata(), [scenario.publishedFinding]);

    const failed = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        REVIEW_PUBLICATION_FILE: publicationFile,
        REVIEW_RESULT_FILE: resultFile,
        GITHUB_OUTPUT: outputFile,
        HEAD_SHA,
        ...scenario.env,
      },
    });

    assert.notEqual(failed.status, 0, scenario.name);
    assert.match(failed.stderr, scenario.error, scenario.name);
    const outputs = outputValues(outputFile);
    assert.equal(outputs.analysis_state, "inconclusive", scenario.name);
    assert.equal(outputs.merge_state, "blocked", scenario.name);
    assert.equal(outputs.sample_state, "findings", scenario.name);
    assert.equal(outputs.bounded_converged, "false", scenario.name);
    assert.deepEqual(JSON.parse(outputs.current_counts), scenario.expectedCounts, scenario.name);
    assert.deepEqual(JSON.parse(outputs.unresolved_counts), EMPTY_COUNTS, scenario.name);
    assert.equal(outputs.reviewed_head, HEAD_SHA, scenario.name);
    assert.equal(outputs.scope_hash, SCOPE_HASH, scenario.name);
    assert.equal(outputs.coverage, "unknown", scenario.name);
    assert.deepEqual(
      JSON.parse(outputs.remaining_analysis),
      ["reconciliation_unknown", "execution_failed"],
      scenario.name,
    );
    assert.equal(outputs.converged, "false", scenario.name);

    const result = JSON.parse(readFileSync(resultFile, "utf8"));
    assert.equal(result.analysis_state, "inconclusive", scenario.name);
    assert.equal(result.merge_state, "blocked", scenario.name);
    assert.equal(result.sample_state, "findings", scenario.name);
    assert.equal(result.bounded_converged, false, scenario.name);
    assert.deepEqual(result.current_counts, scenario.expectedCounts, scenario.name);
    assert.deepEqual(result.unresolved_counts, EMPTY_COUNTS, scenario.name);
    assert.equal(result.reviewed_head, HEAD_SHA, scenario.name);
    assert.equal(result.scope_hash, SCOPE_HASH, scenario.name);
    assert.equal(result.coverage, "unknown", scenario.name);
    assert.deepEqual(
      result.remaining_analysis,
      ["reconciliation_unknown", "execution_failed"],
      scenario.name,
    );
    assert.equal(result.converged, false, scenario.name);
  }
});

test("poster failure preserves reconciled blockers in the conservative final result", () => {
  const current = finding({
    severity: "Critical",
    title: "Current critical blocker",
  });
  const unresolved = finding({
    file: "src/auth.mjs",
    start_line: 8,
    end_line: 9,
    severity: "High",
    title: "Held high blocker",
    body: "The prior authorization defect remains unresolved.",
    suggestion: null,
  });
  const result = runPosterWithHistory({
    mode: "summary",
    currentFindings: [current],
    summaryComments: [botComment(
      41,
      encodeSummaryMarker({ headSha: HEAD_SHA, findings: [unresolved] }),
    )],
    failSummaryPost: true,
  });

  assert.notEqual(result.status, 0, result.stderr);
  const outputs = Object.fromEntries(result.workflowOutput.trim().split("\n").map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  assert.equal(outputs.analysis_state, "inconclusive");
  assert.equal(outputs.merge_state, "blocked");
  assert.equal(outputs.sample_state, "findings");
  assert.equal(outputs.bounded_converged, "false");
  assert.deepEqual(JSON.parse(outputs.current_counts), { Critical: 1, High: 0, Medium: 0 });
  assert.deepEqual(JSON.parse(outputs.unresolved_counts), { Critical: 0, High: 1, Medium: 0 });
  assert.equal(outputs.coverage, "unknown");
  assert.deepEqual(JSON.parse(outputs.remaining_analysis), ["execution_failed"]);
  assert.equal(outputs.converged, "false");

  assert.equal(result.finalResult.analysis_state, outputs.analysis_state);
  assert.equal(result.finalResult.merge_state, outputs.merge_state);
  assert.equal(result.finalResult.sample_state, outputs.sample_state);
  assert.equal(result.finalResult.bounded_converged, false);
  assert.deepEqual(result.finalResult.current_counts, JSON.parse(outputs.current_counts));
  assert.deepEqual(result.finalResult.unresolved_counts, JSON.parse(outputs.unresolved_counts));
  assert.equal(result.finalResult.coverage, outputs.coverage);
  assert.deepEqual(result.finalResult.remaining_analysis, JSON.parse(outputs.remaining_analysis));
  assert.equal(result.finalResult.converged, false);

  const reconciledSummary = result.jobSummary.indexOf("| Analysis | `complete` |");
  const finalSummary = result.jobSummary.slice(result.jobSummary.lastIndexOf("## Agentic review"));
  assert.notEqual(reconciledSummary, -1);
  for (const row of [
    "| Analysis | `inconclusive` |",
    "| Merge gate | `blocked` |",
    "| Sample | `findings` |",
    "| Bounded convergence | `no` |",
    "| Coverage | `unknown` |",
    '| Remaining analysis | `["execution_failed"]` |',
    "| Converged | `false` |",
    "| Current findings | `Critical: 1 · High: 0 · Medium: 0` |",
    "| Held/unresolved findings | `Critical: 0 · High: 1 · Medium: 0` |",
  ]) {
    assert.ok(finalSummary.includes(row), row);
  }
});

test("poster failure downgrades a reconciled clean sample to unknown", () => {
  const result = runPosterWithHistory({
    mode: "summary",
    summaryComments: [botComment(
      42,
      encodeSummaryMarker({ headSha: HEAD_SHA, findings: [] }),
    )],
    failSummaryPost: true,
  });

  assert.notEqual(result.status, 0, result.stderr);
  const outputs = Object.fromEntries(result.workflowOutput.trim().split("\n").map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  assert.equal(outputs.analysis_state, "inconclusive");
  assert.equal(outputs.merge_state, "ready");
  assert.equal(outputs.sample_state, "unknown");
  assert.equal(outputs.bounded_converged, "false");
  assert.deepEqual(JSON.parse(outputs.current_counts), { Critical: 0, High: 0, Medium: 0 });
  assert.deepEqual(JSON.parse(outputs.unresolved_counts), { Critical: 0, High: 0, Medium: 0 });
  assert.equal(result.finalResult.sample_state, "unknown");
});

test("inferred findings carry an unverified note in inline and summary rendering", () => {
  const ranges = new Map([["src/cache.mjs", [[20, 22]]]]);
  for (const mode of ["inline", "suggest"]) {
    const inferred = poster.buildReviewComments(
      [finding({ evidence_kind: "inferred" })],
      ranges,
      { mode },
    );
    assert.equal(inferred.comments.length, 1);
    assert.match(
      inferred.comments[0].body,
      /_Unverified: inferred from reading code, not confirmed against a running system\._/,
    );
  }

  const observed = poster.buildReviewComments(
    [finding({ evidence_kind: "observed" })],
    ranges,
    { mode: "inline" },
  );
  assert.doesNotMatch(observed.comments[0].body, /Unverified/);

  // Omission of evidence_kind means inferred (the format says so), so an
  // untagged finding is rendered unverified exactly like a tagged one.
  const untagged = poster.buildReviewComments([finding()], ranges, { mode: "inline" });
  assert.match(untagged.comments[0].body, /Unverified/);

  const summary = renderReviewBody({
    mode: "summary",
    metadata: metadata(),
    state: state(),
    current: [finding({ evidence_kind: "inferred", suggestion: null })],
    unresolved: [],
  });
  assert.match(summary, /Unverified: inferred from reading code/);
});

test("a static-proof finding renders without the unverified note in summary", () => {
  const summary = renderReviewBody({
    mode: "summary",
    metadata: metadata(),
    state: state(),
    current: [finding({ evidence_kind: "static-proof", suggestion: null })],
    unresolved: [],
  });
  assert.doesNotMatch(summary, /Unverified/);
});
test("a pre-evidence_kind v2 marker decodes held findings as inferred", () => {
  // Take an authentic v2 marker, then strip the seventh tuple element to
  // simulate one written before evidence_kind existed. Held findings with no
  // stated basis are unverified by definition: they must decode as inferred
  // rather than crash or pass silently.
  const cycle = {
    schema_version: 1,
    lineage_base_sha: BASE_SHA,
    discovery_round: 1,
    max_discovery_rounds: 2,
    state: "active",
    last_phase: "discovery",
    next_phase: "verification",
    last_reviewed_head: HEAD_SHA,
    last_scope_hash: SCOPE_HASH,
    last_analysis_state: "complete",
    override: null,
  };
  const modern = poster.encodeSummaryMarker({
    headSha: HEAD_SHA,
    findings: [finding({ suggestion: null })],
    cycle,
  });
  const [, payload] = modern.match(/^<!-- agentic-review-summary:v2:([A-Za-z0-9_-]+) -->$/);
  const state = JSON.parse(inflateRawSync(Buffer.from(payload, "base64url")).toString("utf8"));
  state.f = state.f.map(([file, start, end, severity, title, tokens]) => [
    file, start, end, severity, title, tokens,
  ]);
  const legacy = "<!-- agentic-review-summary:v2:"
    + deflateRawSync(Buffer.from(JSON.stringify(state))).toString("base64url")
    + " -->";

  const decoded = decodeSummaryMarker(legacy);
  assert.equal(decoded.findings.length, 1);
  assert.equal(decoded.findings[0].evidence_kind, "inferred");
});


test("the structured publication preserves evidence_kind through validation", () => {
  const publication = createReviewPublication(
    { ...metadata(), analysis_state: "complete" },
    trustedReviewScope(),
    [finding({ evidence_kind: "static-proof", suggestion: null })],
  );
  const parsed = JSON.parse(JSON.stringify(publication));
  assert.equal(parsed.findings[0].evidence_kind, "static-proof");
});

test("thread reconstruction preserves a strong evidence basis from the stamp", () => {
  const observed = finding({ evidence_kind: "observed", suggestion: null });
  const body = poster.buildReviewComments([observed], new Map([
    [observed.file, [[observed.start_line, observed.end_line]]],
  ]), { mode: "inline" }).comments[0].body;
  assert.match(body, /:ek=observed -->/);

  const thread = {
    path: observed.file,
    startLine: observed.start_line,
    endLine: observed.end_line,
    body,
    evidenceKind: "observed",
  };
  assert.equal(poster.findingFromThread(thread).evidence_kind, "observed");

  // A legacy thread without stamp data stays inferred.
  const plain = poster.findingFromThread({
    path: observed.file,
    startLine: observed.start_line,
    endLine: observed.end_line,
    body,
  });
  assert.equal(plain.evidence_kind, undefined);
});

test("an oversized inferred comment keeps its unverified note under truncation", () => {
  const oversized = finding({
    evidence_kind: "inferred",
    suggestion: null,
    body: incompressible(GITHUB_COMMENT_MAX_BYTES + 8_000),
  });
  const built = poster.buildReviewComments([oversized], new Map([
    ["src/cache.mjs", [[20, 22]]],
  ]), { mode: "inline" });
  assert.equal(built.comments.length, 1);
  assert.match(built.comments[0].body, /^_Unverified: inferred from reading code/);
});
