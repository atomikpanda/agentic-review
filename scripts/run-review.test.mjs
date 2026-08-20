import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  createReviewPublication,
  deriveTrustedScopeMetadata,
  enrichRunMetadata,
  scopeHash,
} from "./review-result.mjs";

const runner = fileURLToPath(new URL("./run-review.sh", import.meta.url));
const resultCli = fileURLToPath(new URL("./review-result.mjs", import.meta.url));
const localState = fileURLToPath(new URL("./local-state.mjs", import.meta.url));
const poster = fileURLToPath(new URL("./post-review.mjs", import.meta.url));
const workflow = fileURLToPath(new URL("../.github/workflows/agentic-review.yml", import.meta.url));
const installer = fileURLToPath(new URL("./install-review.sh", import.meta.url));
const trustedRoot = dirname(dirname(runner));
const stagedTargetRefPrefix = "refs/agentic-review/staged-targets/";

function workflowRunStep(name) {
  const lines = readFileSync(workflow, "utf8").split("\n");
  const stepStart = lines.findIndex((line) => line === `      - name: ${name}`);
  if (stepStart === -1) throw new Error(`workflow step not found: ${name}`);
  const runStart = lines.findIndex((line, index) => index > stepStart && line === "        run: |");
  if (runStart === -1) throw new Error(`workflow run body not found: ${name}`);
  const body = [];
  for (let index = runStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length > 0 && !line.startsWith("          ")) break;
    body.push(line.startsWith("          ") ? line.slice(10) : "");
  }
  return `${body.join("\n")}\n`;
}

function envFileValues(path) {
  return Object.fromEntries(readFileSync(path, "utf8").trim().split("\n").map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

function assertFinalResultSummary(summary, result) {
  const counts = (value) => `Critical: ${value.Critical} · High: ${value.High} · Medium: ${value.Medium}`;
  for (const row of [
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
    `| Current findings | \`${counts(result.current_counts)}\` |`,
    `| Held/unresolved findings | \`${counts(result.unresolved_counts)}\` |`,
  ]) {
    assert.ok(summary.includes(row), row);
  }
}

function expectedExecutionFailureResult(baseSha, headSha, evidence = {}) {
  const remainingAnalysis = evidence.remainingAnalysis ?? [];
  return {
    analysis_state: "inconclusive",
    merge_state: evidence.mergeState ?? "ready",
    sample_state: evidence.sampleState ?? "unknown",
    bounded_converged: false,
    base_sha: baseSha,
    head_sha: headSha,
    configuration_fingerprint: evidence.configurationFingerprint ?? "",
    passes_requested: evidence.passesRequested ?? 0,
    passes_completed: evidence.passesCompleted ?? 0,
    current_counts: evidence.currentCounts ?? { Critical: 0, High: 0, Medium: 0 },
    unresolved_counts: { Critical: 0, High: 0, Medium: 0 },
    reviewed_head: headSha,
    scope_hash: evidence.scopeHash ?? "",
    coverage: "unknown",
    remaining_analysis: [
      ...remainingAnalysis,
      ...(evidence.scopeHash ? ["reconciliation_unknown"] : []),
      "execution_failed",
    ],
    converged: false,
  };
}

function writeTrustedPublication({
  analysisState = "complete",
  baseSha,
  configurationFingerprint,
  completedPasses,
  coverage = "bounded",
  findings = [],
  headSha,
  publicationFile,
  requestedPasses,
  remainingAnalysis = [],
}) {
  const diffTruncated = remainingAnalysis.includes("diff_truncated");
  const findingCapReached = remainingAnalysis.includes("finding_cap_reached");
  const scope = {
    base_sha: baseSha,
    bytes: diffTruncated ? 1 : 0,
    configuration_fingerprint: configurationFingerprint,
    diff_base64: diffTruncated ? Buffer.from("x").toString("base64") : "",
    head_sha: headSha,
    included_bytes: 0,
  };
  const trustedScopeHash = deriveTrustedScopeMetadata(scope).scope_hash;
  const completed = new Set(completedPasses);
  const run = {
    schema_version: 1,
    base_sha: baseSha,
    head_sha: headSha,
    configuration_fingerprint: configurationFingerprint,
    snapshot_immutable: !remainingAnalysis.includes("snapshot_mutable"),
    diff: {
      bytes: scope.bytes,
      included_bytes: scope.included_bytes,
      truncated: diffTruncated,
    },
    finding_cap: 20,
    min_votes: remainingAnalysis.includes("vote_threshold_applied") ? 2 : 1,
    merge_succeeded: !remainingAnalysis.includes("merge_failed"),
    passes: {
      requested: requestedPasses,
      completed: completedPasses,
      results: requestedPasses.map((id, index) => ({
        id,
        status: completed.has(id) ? "valid" : "failed",
        attempts: completed.has(id) ? 1 : 2,
        finding_count: findingCapReached && index === 0 ? 20 : findings.length,
        capped: findingCapReached && index === 0,
        base_sha: baseSha,
        head_sha: headSha,
        configuration_fingerprint: configurationFingerprint,
      })),
    },
  };
  const metadata = enrichRunMetadata(run, { scopeHash: trustedScopeHash });
  assert.equal(metadata.analysis_state, analysisState);
  assert.equal(metadata.coverage, coverage);
  assert.deepEqual(metadata.remaining_analysis, remainingAnalysis);
  writeFileSync(
    publicationFile,
    `${JSON.stringify(createReviewPublication(metadata, scope, findings))}\n`,
  );
  return trustedScopeHash;
}

function finding(title, overrides = {}) {
  return {
    title,
    body: `${title} breaks the reviewed contract in observable behavior.`,
    severity: "Medium",
    file: `src/${title.toLowerCase().replaceAll(" ", "-")}.js`,
    start_line: 1,
    end_line: 1,
    suggestion: null,
    ...overrides,
  };
}

const fakeOmp = `#!/usr/bin/env node
import { appendFileSync, lstatSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

if (process.argv.includes("--version")) {
  process.stdout.write("fake-omp 1.0.0\\n");
  process.exit(0);
}
const promptArgument = process.argv.slice(2).find((argument) => argument.startsWith("@"));
if (!promptArgument) process.exit(2);
const promptPath = promptArgument.slice(1);
const promptBytes = readFileSync(promptPath);
const prompt = promptBytes.toString("utf8");
const skillArgument = process.argv.slice(2).find((argument) => argument.startsWith("--append-system-prompt="));
const skill = skillArgument ? readFileSync(skillArgument.slice("--append-system-prompt=".length), "utf8") : "";
const instructions = prompt.split("## Changed files", 1)[0];
const id = instructions.includes("# This pass: correctness")
  ? "correctness"
  : instructions.includes("# This pass: boundaries")
    ? "boundaries"
    : instructions.includes("# This pass: security")
      ? "security"
      : instructions.includes("# This pass: documentation")
        ? "docs"
        : "general";
const attemptFile = join(process.env.FAKE_OMP_STATE, id);
let attempt = 1;
try { attempt = Number(readFileSync(attemptFile, "utf8")) + 1; } catch {}
writeFileSync(attemptFile, String(attempt));
const reviewCwd = process.argv.slice(2).find((argument) => argument.startsWith("--cwd="))?.slice(6)
  ?? process.cwd();
let reviewedAlpha = null;
try { reviewedAlpha = readFileSync(join(reviewCwd, "alpha.txt"), "utf8"); } catch {}
const codegraphPath = join(reviewCwd, "codegraph.json");
let reviewedCodegraph = { type: "absent" };
try {
  const status = lstatSync(codegraphPath);
  reviewedCodegraph = status.isSymbolicLink()
    ? { type: "symlink", target: readlinkSync(codegraphPath), contents: readFileSync(codegraphPath, "utf8") }
    : status.isFile()
      ? { type: "file", contents: readFileSync(codegraphPath, "utf8") }
      : { type: "other" };
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
appendFileSync(process.env.FAKE_OMP_LOG, JSON.stringify({
  id,
  attempt,
  promptPath,
  prompt,
  prompt_base64: promptBytes.toString("base64"),
  skill,
  cwd: reviewCwd,
  reviewedAlpha,
  reviewedCodegraph,
  argv: process.argv.slice(2),
}) + "\\n");
const plan = JSON.parse(readFileSync(process.env.FAKE_OMP_PLAN, "utf8"));
const choices = plan[id] ?? plan.default ?? [{ findings: [] }];
const choice = choices[Math.min(attempt - 1, choices.length - 1)];
if (choice && typeof choice === "object" && Object.hasOwn(choice, "__exit")) {
  if (choice.output) process.stdout.write(choice.output);
  process.exit(choice.__exit);
}
process.stdout.write(typeof choice === "string" ? choice : JSON.stringify(choice));
`;

const fakeCodegraph = `#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const operation = process.argv[2];
if (operation === "--version") {
  const version = process.env.FAKE_CODEGRAPH_VERSION ?? "fake-codegraph 1.0.0";
  appendFileSync(process.env.FAKE_CODEGRAPH_LOG, JSON.stringify({
    operation: "version", version,
  }) + "\\n");
  process.stdout.write(version + "\\n");
  process.exit(0);
}
if (operation === "init") {
  const project = process.cwd();
  const source = readFileSync(join(project, "alpha.txt"), "utf8").trim();
  let config = null;
  try { config = readFileSync(join(project, "codegraph.json"), "utf8").trim(); } catch {}
  appendFileSync(process.env.FAKE_CODEGRAPH_LOG, JSON.stringify({
    operation: "init", project, source, config,
  }) + "\\n");
  if (process.env.FAKE_CODEGRAPH_INIT_FAIL === "1") process.exit(9);
  mkdirSync(join(project, ".codegraph"), { recursive: true });
  writeFileSync(join(project, ".codegraph", "source-marker"), "INDEX:" + source + "\\n");
  process.exit(0);
}
const pathIndex = process.argv.indexOf("--path");
const project = pathIndex === -1 ? "" : process.argv[pathIndex + 1];
let marker = "missing";
try { marker = readFileSync(join(project, ".codegraph", "source-marker"), "utf8").trim(); } catch {}
const countFile = join(process.env.FAKE_OMP_STATE, "codegraph-query-count");
let query = 1;
try { query = Number(readFileSync(countFile, "utf8")) + 1; } catch {}
writeFileSync(countFile, String(query));
appendFileSync(process.env.FAKE_CODEGRAPH_LOG, JSON.stringify({
  operation: "query", project, marker, query,
}) + "\\n");
if (process.env.FAKE_CODEGRAPH_QUERY_MODE === "first-only" && query > 1) process.exit(8);
const context = process.env.FAKE_CODEGRAPH_CONTEXT ?? marker;
process.stdout.write("# Snapshot symbol index\\n\\n" + context + "\\n");
`;

function git(directory, ...args) {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
}

function createFixture(t, {
  targetFiles = {},
  baseFiles = {},
  deleteFiles = [],
  targetSymlinks = {},
  staged = false,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "run-review-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repository = join(directory, "repository");
  const bin = join(directory, "bin");
  const state = join(directory, "fake-state");
  mkdirSync(repository);
  mkdirSync(bin);
  mkdirSync(state);

  git(repository, "init", "-b", "main");
  git(repository, "config", "user.email", "review-test@example.com");
  git(repository, "config", "user.name", "Review Test");
  writeFileSync(join(repository, "alpha.txt"), "alpha base\n");
  writeFileSync(join(repository, "beta.txt"), "beta base\n");
  writeFileSync(join(repository, "gamma.txt"), "gamma base\n");
  for (const [path, contents] of Object.entries(baseFiles)) {
    const destination = join(repository, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
  }
  git(repository, "add", ".");
  for (const path of Object.keys(baseFiles)) git(repository, "add", "-f", "--", path);
  git(repository, "commit", "-m", "base");
  const baseSha = git(repository, "rev-parse", "HEAD");

  if (!staged) git(repository, "checkout", "-b", "feature");
  writeFileSync(join(repository, "alpha.txt"), "alpha head\n");
  writeFileSync(join(repository, "beta.txt"), "beta head\n");
  writeFileSync(join(repository, "gamma.txt"), "gamma head\n");
  for (const [path, contents] of Object.entries(targetFiles)) {
    const destination = join(repository, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
  }
  for (const [path, target] of Object.entries(targetSymlinks)) {
    const destination = join(repository, path);
    mkdirSync(dirname(destination), { recursive: true });
    rmSync(destination, { recursive: true, force: true });
    symlinkSync(target, destination);
  }
  for (const path of deleteFiles) rmSync(join(repository, path));
  git(repository, "add", ".");
  for (const path of Object.keys(targetFiles)) git(repository, "add", "-f", "--", path);
  for (const path of Object.keys(targetSymlinks)) git(repository, "add", "-f", "--", path);
  let headSha = null;
  if (!staged) {
    git(repository, "commit", "-m", "change three files");
    headSha = git(repository, "rev-parse", "HEAD");
  }

  const omp = join(bin, "omp");
  writeFileSync(omp, fakeOmp);
  chmodSync(omp, 0o755);

  return { directory, repository, bin, state, baseSha, headSha };
}

function runReview(t, plan, {
  args = ["--json"],
  env = {},
  targetFiles = {},
  baseFiles = {},
  deleteFiles = [],
  targetSymlinks = {},
  staged = false,
  includeOutputs = true,
  publicationViaEnv = false,
  noState = true,
  noFail = true,
  failMerge = false,
  failWorktree = false,
  fakeCodegraph: useFakeCodegraph = false,
  fakeBunx = false,
  untrackedCodegraph = false,
  mutateAfterWorktree = null,
  outputPaths = null,
  existingFixture = null,
} = {}) {
  const fixture = existingFixture ?? createFixture(t, {
    targetFiles,
    baseFiles,
    deleteFiles,
    staged,
    targetSymlinks,
  });
  if (untrackedCodegraph) {
    mkdirSync(join(fixture.repository, ".codegraph"), { recursive: true });
    writeFileSync(join(fixture.repository, ".codegraph", "source-marker"), "SOURCE_INDEX_BEFORE\\n");
  }
  const planFile = join(fixture.directory, "plan.json");
  const logFile = join(fixture.directory, "omp.log");
  const codegraphLogFile = join(fixture.directory, "codegraph.log");
  const bunxLogFile = join(fixture.directory, "bunx.log");
  let findingsFile = join(fixture.directory, "findings.json");
  let publicationFile = join(fixture.directory, "publication.json");
  if (outputPaths) {
    const outputFiles = outputPaths({
      ...fixture,
      findingsFile,
      publicationFile,
    });
    findingsFile = outputFiles.findingsFile;
    publicationFile = outputFiles.publicationFile;
  }
  writeFileSync(planFile, JSON.stringify(plan));
  const runnerArgs = [
    runner,
    ...(staged ? ["--staged"] : ["--base", "main"]),
    ...(useFakeCodegraph ? [] : ["--no-codegraph"]),
    ...(noFail ? ["--no-fail"] : []),
    ...(noState ? ["--no-state"] : []),
    ...(includeOutputs
      ? [
          "--out", findingsFile,
          ...(publicationViaEnv ? [] : ["--publication-out", publicationFile]),
        ]
      : []),
    ...args,
  ];
  if (failMerge) {
    const node = join(fixture.bin, "node");
    writeFileSync(node, `#!/usr/bin/env bash
if [ "\${1##*/}" = "merge-findings.mjs" ] && [ "\${2:-}" != "--check" ]; then
  exit 1
fi
exec "\${REAL_NODE}" "$@"
`);
    chmodSync(node, 0o755);
  }
  if (mutateAfterWorktree || failWorktree) {
    const gitWrapper = join(fixture.bin, "git");
    const mutationMarker = join(fixture.directory, "git-mutated");
    writeFileSync(gitWrapper, `#!/usr/bin/env bash
real_path="\${PATH#*:}"
if [ "\${FAKE_GIT_FAIL_WORKTREE:-0}" = 1 ] && [ "\${1:-}" = "worktree" ] && [ "\${2:-}" = "add" ]; then
  exit 1
fi
PATH="$real_path" git "$@"
status=$?
if [ "$status" = 0 ] && [ "\${1:-}" = "worktree" ] && [ "\${2:-}" = "add" ] && [ -n "\${FAKE_GIT_MUTATION_MODE:-}" ] && [ ! -e "\${FAKE_GIT_MUTATION_MARKER}" ]; then
  touch "\${FAKE_GIT_MUTATION_MARKER}"
  printf 'late head\\n' > alpha.txt
  if [ "\${FAKE_GIT_MUTATION_MODE}" = "branch-codegraph" ]; then
    printf 'LIVE_INDEX_MUTATION\\n' > .codegraph/source-marker
  fi
  PATH="$real_path" git add alpha.txt .codegraph/source-marker 2>/dev/null || PATH="$real_path" git add alpha.txt
  case "\${FAKE_GIT_MUTATION_MODE}" in
    branch|branch-codegraph) PATH="$real_path" git commit -m 'late concurrent head' >/dev/null ;;
  esac
fi
exit "$status"
`);
    chmodSync(gitWrapper, 0o755);
    env = {
      FAKE_GIT_FAIL_WORKTREE: failWorktree ? "1" : "0",
      FAKE_GIT_MUTATION_MARKER: mutationMarker,
      FAKE_GIT_MUTATION_MODE: mutateAfterWorktree ?? "",
      ...env,
    };
  }
  if (useFakeCodegraph) {
    const codegraph = join(fixture.bin, "codegraph");
    writeFileSync(codegraph, fakeCodegraph);
    chmodSync(codegraph, 0o755);
  }
  if (fakeBunx) {
    const bunx = join(fixture.bin, "bunx");
    writeFileSync(bunx, `#!/usr/bin/env bash
printf '%s\\n' "\${2:-}" >> "\${FAKE_BUNX_LOG}"
shift 2
exec "\$(dirname "$0")/omp" "$@"
`);
    chmodSync(bunx, 0o755);
    const bun = join(fixture.bin, "bun");
    writeFileSync(bun, `#!/usr/bin/env bash
printf '%s\\n' '1.3.14'
`);
    chmodSync(bun, 0o755);
  }
  const result = spawnSync("bash", runnerArgs, {
    cwd: fixture.repository,
    encoding: "utf8",
    env: {
      ...process.env,
      AGENTIC_REVIEW_BASE: "",
      AGENTIC_REVIEW_LENSES: "",
      AGENTIC_REVIEW_MAX_DIFF_BYTES: "",
      AGENTIC_REVIEW_MAX_FINDINGS: "",
      AGENTIC_REVIEW_PUBLICATION_OUT: "",
      AGENTIC_REVIEW_PASSES: "",
      AGENTIC_REVIEW_PROMPT: "",
      AGENTIC_REVIEW_SKILL: "",
      AGENTIC_REVIEW_TRUSTED_DATA_ROOT: "",
      PATH: `${fixture.bin}:${process.env.PATH}`,
      OPENROUTER_API_KEY: "sk-or-runner-test",
      FAKE_OMP_PLAN: planFile,
      FAKE_OMP_LOG: logFile,
      FAKE_OMP_STATE: fixture.state,
      FAKE_CODEGRAPH_LOG: codegraphLogFile,
      FAKE_BUNX_LOG: bunxLogFile,
      REAL_NODE: process.execPath,
      ...(publicationViaEnv ? { AGENTIC_REVIEW_PUBLICATION_OUT: publicationFile } : {}),
      ...env,
    },
  });
  const logs = existsSync(logFile)
    ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    : [];
  const codegraphLogs = existsSync(codegraphLogFile)
    ? readFileSync(codegraphLogFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    : [];
  const publication = existsSync(publicationFile)
    ? JSON.parse(readFileSync(publicationFile, "utf8"))
    : null;
  return {
    ...fixture,
    result,
    logs,
    codegraphLogs,
    findingsFile,
    publicationFile,
    bunxLogFile,
    findings: existsSync(findingsFile) ? JSON.parse(readFileSync(findingsFile, "utf8")) : null,
    publication,
    metadata: publication?.metadata ?? null,
    scope: publication?.scope ?? null,
  };
}

function validatePublication(publicationFile) {
  return spawnSync(
    process.execPath,
    [resultCli, "validate", publicationFile],
    { encoding: "utf8" },
  );
}

function runWorkflowConfig(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "hosted-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const outputFile = join(directory, "github.env");
  const inputs = {
    IN_MODEL: "",
    IN_THINKING: "",
    IN_TOOLS: "",
    IN_CENTRAL_REPO: "atomikpanda/agentic-review",
    IN_MAX_TIME: "",
    IN_PROMPT_PATH: "",
    IN_SKILLS_PATH: "",
    IN_MAX_FINDINGS: "",
    IN_MAX_DIFF_BYTES: "",
    IN_CODEGRAPH: "",
    IN_CODEGRAPH_VERSION: "",
    IN_REVIEW_MODE: "",
    IN_POST_COMMENT: "",
    IN_SUPPRESS_WRITES: "",
    IN_RESOLVE_STALE: "",
    IN_FAIL_ON_FINDINGS: "",
    IN_BLOCK_SEVERITIES: "",
    IN_BUN_VERSION: "",
    IN_OMP_VERSION: "",
    IN_EXTRA_ARGS: "",
    ...overrides,
  };
  const result = spawnSync("bash", ["-c", workflowRunStep("resolve config")], {
    encoding: "utf8",
    env: { ...process.env, ...inputs, GITHUB_ENV: outputFile },
  });
  return {
    result,
    values: existsSync(outputFile) ? envFileValues(outputFile) : null,
  };
}

test("hosted central refs resolve literal main, release tags, and exact immutable SHAs", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "central-ref-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [input, expected] of [
    ["main", "refs/heads/main"],
    ["v1", "refs/tags/v1"],
    ["v1.2.3", "refs/tags/v1.2.3"],
    ["v2.0.0-rc.1", "refs/tags/v2.0.0-rc.1"],
    ["a".repeat(40), "a".repeat(40)],
  ]) {
    const outputFile = join(directory, `valid-${input}`);
    const result = spawnSync("bash", ["-c", workflowRunStep("resolve trusted central ref")], {
      encoding: "utf8",
      env: { ...process.env, IN_CENTRAL_REF: input, GITHUB_OUTPUT: outputFile },
    });
    assert.equal(result.status, 0, `${input}: ${result.stderr}`);
    assert.equal(envFileValues(outputFile).ref, expected);
  }
  for (const input of [
    "refs/pull/17/head",
    "feature/review",
    "0123456789abcdef0123456789abcdef0123456",
    "A".repeat(40),
    "https://github.com/attacker/repo",
    "v1^{commit}",
    "v1~1",
    "1.2.3",
  ]) {
    const result = spawnSync("bash", ["-c", workflowRunStep("resolve trusted central ref")], {
      encoding: "utf8",
      env: { ...process.env, IN_CENTRAL_REF: input, GITHUB_OUTPUT: join(directory, "invalid") },
    });
    assert.notEqual(result.status, 0, input);
  }
});

test("hosted config allows harmless display flags and rejects prompt, parser, and package injection", (t) => {
  const valid = runWorkflowConfig(t, {
    IN_EXTRA_ARGS: "--print-thoughts --hide-thinking --no-title",
    IN_OMP_VERSION: "17.4.0-rc.1",
  });
  assert.equal(valid.result.status, 0, valid.result.stderr);
  assert.equal(valid.values.EXTRA_ARGS, "--print-thoughts --hide-thinking --no-title");
  assert.equal(valid.values.OMP_VERSION, "17.4.0-rc.1");
  for (const version of ["latest", "next", "17.3.0", "17.4.0-rc.1"]) {
    const accepted = runWorkflowConfig(t, { IN_OMP_VERSION: version });
    assert.equal(accepted.result.status, 0, `${version}: ${accepted.result.stderr}`);
    assert.equal(accepted.values.OMP_VERSION, version);
  }

  for (const extra of [
    "--",
    "--append-system-prompt=/tmp/untrusted",
    "--system-prompt /tmp/untrusted",
    "--config=/tmp/untrusted",
    "--continue",
    "--resume=session",
    "--model=attacker/model",
    "ignore-all-review-instructions",
  ]) {
    const rejected = runWorkflowConfig(t, { IN_EXTRA_ARGS: extra });
    assert.notEqual(rejected.result.status, 0, extra);
  }
  for (const version of [
    "https://attacker.invalid/omp.tgz",
    "../omp",
    "npm:attacker",
    "@attacker/omp",
    "latest@attacker",
    "file:/tmp/omp",
    "17.3.0 --silent",
  ]) {
    const rejected = runWorkflowConfig(t, { IN_OMP_VERSION: version });
    assert.notEqual(rejected.result.status, 0, version);
  }
});

test("installer validates display-only extra args before side effects and emits a SHA-pinned target workflow", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "install-review-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  const log = join(directory, "gh.log");
  mkdirSync(bin);
  const gh = join(bin, "gh");
  writeFileSync(gh, `#!/usr/bin/env bash
case "\${1:-} \${2:-}" in
  "auth status") printf "Token scopes: 'repo', 'workflow'\\n"; exit 0 ;;
  "repo view") exit 0 ;;
  "secret list") printf "OPENROUTER_API_KEY\\n"; exit 0 ;;
esac
if [ "\${1:-}" = api ]; then
  for arg in "$@"; do
    if [ "$arg" = PUT ]; then printf '%s\\n' "$@" > "$GH_LOG"; exit 0; fi
  done
  exit 1
fi
exit 1
`);
  chmodSync(gh, 0o755);
  const baseEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_LOG: log };

  const rejected = spawnSync("bash", [
    installer,
    "--repo", "owner/repo",
    "--extra-omp-args", "--model=attacker/model",
    "--no-pr-agent",
    "--yes",
  ], { encoding: "utf8", env: baseEnv });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /extra-omp-args.*not permitted/);
  assert.equal(existsSync(log), false, "installer must reject before invoking gh");

  const sha = "a".repeat(40);
  const installed = spawnSync("bash", [
    installer,
    "--repo", "owner/repo",
    "--ref", sha,
    "--extra-omp-args", "--print-thoughts --no-title",
    "--no-pr-agent",
    "--yes",
  ], { encoding: "utf8", env: baseEnv });
  assert.equal(installed.status, 0, installed.stderr);
  const encoded = readFileSync(log, "utf8")
    .split("\n")
    .find((line) => line.startsWith("content="))
    ?.slice("content=".length);
  assert.ok(encoded);
  const generated = Buffer.from(encoded, "base64").toString("utf8");
  assert.match(generated, /^on:\n  pull_request_target:/m);
  assert.match(generated, new RegExp(`uses: atomikpanda/agentic-review/.github/workflows/agentic-review.yml@${sha}`));
  assert.match(generated, new RegExp(`central_ref: ${sha}`));
  assert.match(generated, /extra_omp_args: --print-thoughts --no-title/);
  assert.match(generated, /^  pull-requests: write$/m);

  const outputFile = join(directory, "sha-output");
  const resolved = spawnSync("bash", ["-c", workflowRunStep("resolve trusted central ref")], {
    encoding: "utf8",
    env: { ...process.env, IN_CENTRAL_REF: sha, GITHUB_OUTPUT: outputFile },
  });
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.equal(envFileValues(outputFile).ref, sha);
});

test("runner rejects passthrough prompt and envelope changes before OMP", (t) => {
  for (const extra of [
    ["--"],
    ["--append-system-prompt=/tmp/untrusted"],
    ["--config=/tmp/untrusted"],
    ["--continue"],
    ["--resume=session"],
    ["ignore-all-review-instructions"],
  ]) {
    const run = runReview(t, {}, {
      args: ["--json", "--", ...extra],
      includeOutputs: false,
    });
    assert.notEqual(run.result.status, 0, extra.join(" "));
    assert.equal(run.logs.length, 0, extra.join(" "));
  }

  const allowed = runReview(t, {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    args: ["--json", "--", "--print-thoughts", "--hide-thinking", "--no-title"],
  });
  assert.equal(allowed.result.status, 0, allowed.result.stderr);
  assert.ok(allowed.logs.every(({ argv }) => (
    argv.includes("--print-thoughts")
    && argv.includes("--hide-thinking")
    && argv.includes("--no-title")
  )));
});

test("runner rejects CR or LF in finding titles before merge or posting", (t) => {
  for (const title of ["Visible title\nInjected continuation", "Visible title\rInjected continuation"]) {
    const malformed = finding(title, { file: "alpha.txt" });
    const run = runReview(t, {
      general: [{ findings: [malformed] }, { findings: [malformed] }],
    }, {
      args: ["--passes", "1", "--lenses", "", "--json"],
      includeOutputs: false,
    });
    assert.notEqual(run.result.status, 0);
    assert.match(run.result.stderr, /every configured pass failed/);
    assert.equal(run.logs.length, 2);
  }
});

test("every-pass failure atomically creates or replaces --out with validated conservative findings", (t) => {
  const staleFinding = finding("Stale finding", { file: "alpha.txt" });
  const malformedFinding = finding("Invalid\nfinding", { file: "alpha.txt" });
  for (const initialFindings of [null, [staleFinding]]) {
    const run = runReview(t, {
      general: [{ findings: [malformedFinding] }, { findings: [malformedFinding] }],
    }, {
      args: ["--passes", "1", "--lenses", "", "--json"],
      outputPaths: ({ directory, publicationFile }) => {
        const findingsFile = join(directory, "findings.json");
        if (initialFindings) {
          writeFileSync(findingsFile, JSON.stringify({ findings: initialFindings }));
        }
        return { findingsFile, publicationFile };
      },
    });

    assert.notEqual(run.result.status, 0);
    assert.match(run.result.stderr, /every configured pass failed/);
    assert.deepEqual(run.findings, { findings: [] });
    assert.equal(run.publication?.metadata.analysis_state, "inconclusive");
    assert.equal(run.publication?.metadata.remaining_analysis.includes("execution_failed"), true);
  }
});

test("runner validates OMP package versions before bunx or OMP", (t) => {
  for (const version of [
    "https://attacker.invalid/omp.tgz",
    "../omp",
    "npm:attacker",
    "@attacker/omp",
    "latest@attacker",
    "file:/tmp/omp",
    "17.3.0 --silent",
  ]) {
    const run = runReview(t, {}, {
      args: ["--omp-version", version, "--json"],
      includeOutputs: false,
      fakeBunx: true,
    });
    assert.notEqual(run.result.status, 0, version);
    assert.equal(run.logs.length, 0, version);
    assert.equal(existsSync(run.bunxLogFile), false, version);
  }

  for (const version of ["next", "17.4.0-rc.1"]) {
    const valid = runReview(t, {
      general: [{ findings: [] }],
      correctness: [{ findings: [] }],
      boundaries: [{ findings: [] }],
    }, {
      args: ["--omp-version", version, "--json"],
      fakeBunx: true,
    });
    assert.equal(valid.result.status, 0, `${version}: ${valid.result.stderr}`);
    assert.deepEqual(
      readFileSync(valid.bunxLogFile, "utf8").trim().split("\n"),
      Array(3).fill(`@oh-my-pi/pi-coding-agent@${version}`),
    );
  }
});

test("the default profile runs general, correctness, and boundaries into one validated result", (t) => {
  const repeated = finding("Shared lifecycle defect", { file: "src/shared.js" });
  const generalOnly = finding("General only");
  const correctnessOnly = finding("Correctness only");
  const boundariesOnly = finding("Boundaries only");
  const run = runReview(t, {
    general: [{ findings: [repeated, generalOnly] }],
    correctness: [{ findings: [repeated, correctnessOnly] }],
    boundaries: [{ findings: [boundariesOnly] }],
  });

  assert.equal(run.result.status, 0, run.result.stderr);
  assert.deepEqual(run.logs.map(({ id }) => id), ["general", "correctness", "boundaries"]);
  assert.deepEqual(
    run.findings.findings.map(({ title }) => title).sort(),
    ["Boundaries only", "Correctness only", "General only", "Shared lifecycle defect"],
  );
  assert.equal(run.findings.findings.find(({ title }) => title === repeated.title).votes, 2);
  assert.deepEqual(JSON.parse(run.result.stdout), run.findings);
  assert.deepEqual(run.publication.findings, run.findings.findings);
  assert.equal(existsSync(join(run.repository, ".git", "agentic-review")), false);

  assert.deepEqual(run.metadata.passes.requested, ["general", "correctness", "boundaries"]);
  assert.deepEqual(run.metadata.passes.completed, ["general", "correctness", "boundaries"]);
  assert.equal(run.metadata.base_sha, run.baseSha);
  assert.equal(run.metadata.head_sha, run.headSha);
  assert.equal(run.metadata.analysis_state, "complete");
  assert.equal(run.metadata.snapshot_immutable, true);
  assert.equal(run.metadata.reviewed_head, run.headSha);
  assert.match(run.metadata.scope_hash, /^[a-f0-9]{64}$/);
  assert.equal(run.metadata.coverage, "bounded");
  assert.deepEqual(run.metadata.remaining_analysis, []);
  assert.equal(new Set(run.metadata.passes.results.map((pass) => pass.configuration_fingerprint)).size, 1);
  const canonicalDiff = execFileSync(
    "git",
    ["diff", "--no-color", run.baseSha, run.headSha],
    { cwd: run.repository },
  );
  assert.deepEqual(Buffer.from(run.scope.diff_base64, "base64"), canonicalDiff);
  assert.equal(canonicalDiff.at(-1), 10);
  assert.equal(run.scope.bytes, canonicalDiff.length);
  assert.equal(run.scope.included_bytes, canonicalDiff.length);
  assert.deepEqual(run.metadata.diff, {
    bytes: Buffer.byteLength(canonicalDiff),
    included_bytes: Buffer.byteLength(canonicalDiff),
    truncated: false,
  });
  assert.deepEqual(
    {
      base_sha: run.scope.base_sha,
      configuration_fingerprint: run.scope.configuration_fingerprint,
      head_sha: run.scope.head_sha,
    },
    {
      base_sha: run.metadata.base_sha,
      configuration_fingerprint: run.metadata.configuration_fingerprint,
      head_sha: run.metadata.head_sha,
    },
  );
  assert.equal(deriveTrustedScopeMetadata(run.scope).scope_hash, run.metadata.scope_hash);
  for (const pass of run.metadata.passes.results) {
    assert.equal(pass.base_sha, run.baseSha);
    assert.equal(pass.head_sha, run.headSha);
    assert.equal(pass.configuration_fingerprint, run.metadata.configuration_fingerprint);
    assert.equal(pass.status, "valid");
    assert.equal(pass.attempts, 1);
    assert.equal(pass.capped, false);
  }
  const validation = validatePublication(run.publicationFile);
  assert.equal(validation.status, 0, validation.stderr);
  assert.deepEqual(JSON.parse(validation.stdout), run.metadata);
});

test("workflow exposes and always retains the additive final result contract", () => {
  const source = readFileSync(workflow, "utf8");
  for (const field of [
    "reviewed_head",
    "scope_hash",
    "coverage",
    "remaining_analysis",
    "converged",
  ]) {
    assert.match(source, new RegExp(`^      ${field}:`, "m"));
    assert.match(source, new RegExp(`^      ${field}: \\$\\{\\{ steps\\.poster\\.outputs\\.${field} \\}\\}`, "m"));
  }
  assert.match(source, /\/tmp\/review-result\.json/);
});

test("workflow skips the write-capable poster after cancellation but not ordinary failure", () => {
  const source = readFileSync(workflow, "utf8");
  const posterStep = source.match(
    /^      - name: post review\n[\s\S]*?(?=^      - (?:name:|uses:))/m,
  )?.[0];

  assert.ok(posterStep);
  assert.match(posterStep, /^\s+GH_TOKEN:/m);
  assert.match(posterStep, /^\s+if: \$\{\{ !cancelled\(\) \}\}$/m);
});

test("workflow independently retains the required result and optional diagnostics", () => {
  const source = readFileSync(workflow, "utf8");
  const resultStep = source.match(
    /^      - name: upload review result\n[\s\S]*?(?=^      - name:)/m,
  )?.[0];
  const diagnosticsStep = source.match(
    /^      - name: upload optional review diagnostics\n[\s\S]*$/m,
  )?.[0];

  assert.match(source, /^\s+REVIEW_PUBLICATION_FILE: \/tmp\/review-publication\.json$/m);
  assert.doesNotMatch(source, /AGENTIC_REVIEW_SCOPE_OUT|review-scope\.json/);
  assert.ok(resultStep);
  assert.match(
    resultStep,
    /^\s+if: \$\{\{ !cancelled\(\) && steps\.target\.outputs\.eligible != 'false' \}\}$/m,
  );
  assert.match(resultStep, /^\s+path: \/tmp\/review-result\.json$/m);
  assert.match(resultStep, /^\s+if-no-files-found: error$/m);
  assert.doesNotMatch(
    resultStep,
    /\/tmp\/review(?:\.md|-publication\.json|-runner\.(?:out|err))/,
  );

  assert.ok(diagnosticsStep);
  assert.match(
    diagnosticsStep,
    /^\s+if: \$\{\{ !cancelled\(\) && steps\.target\.outputs\.eligible == 'true' \}\}$/m,
  );
  for (const path of [
    "/tmp/review.md",
    "/tmp/review-publication.json",
    "/tmp/review-runner.out",
    "/tmp/review-runner.err",
  ]) {
    assert.match(diagnosticsStep, new RegExp(`^\\s+${path.replaceAll(".", "\\.")}$`, "m"));
  }
  assert.doesNotMatch(diagnosticsStep, /^\s+\/tmp\/review-result\.json$/m);
  assert.match(diagnosticsStep, /^\s+if-no-files-found: ignore$/m);
});

test("hosted workflows require only pull-request write permission", () => {
  const source = readFileSync(workflow, "utf8");
  assert.doesNotMatch(source, /^  issues: write$/m);
  assert.match(source, /^  pull-requests: write$/m);
  assert.match(
    source,
    /permissions: \{ contents: "read", pull_requests: "write" \}/,
  );
});

test("hosted poster crash fallback delegates publication validation and derivation to the trusted result owner", () => {
  const source = readFileSync(workflow, "utf8");
  assert.match(source, /node "\$REVIEW_RESULT_HELPER" validate "\$REVIEW_PUBLICATION_FILE"/);
  assert.match(source, /node "\$REVIEW_RESULT_HELPER" failure "\$REVIEW_PUBLICATION_FILE"/);
  assert.doesNotMatch(source, /node - "\$REVIEW_PUBLICATION_FILE"/);
});

test("early hosted setup failure without a publication uses target fallback defaults", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hosted-finalizer-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const outputFile = join(directory, "github-output");
  const resultFile = join(directory, "review-result.json");
  const summaryFile = join(directory, "step-summary");
  const untrustedPosterMarker = join(directory, "untrusted-poster-ran");
  mkdirSync(join(directory, "scripts"));
  writeFileSync(join(directory, "scripts", "post-review.mjs"), `
import { writeFileSync } from "node:fs";
writeFileSync(process.env.UNTRUSTED_POSTER_MARKER, "executed");
`);

  const env = {
    ...process.env,
    TARGET_ELIGIBLE: "true",
    PR_NUMBER: "7",
    GITHUB_REPO: "example/repository",
    HEAD_SHA: "2222222222222222222222222222222222222222",
    BASE_SHA: "1111111111111111111111111111111111111111",
    GITHUB_OUTPUT: outputFile,
    REVIEW_RESULT_FILE: resultFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    UNTRUSTED_POSTER_MARKER: untrustedPosterMarker,
  };
  for (const name of [
    "TRUSTED_DATA_ROOT",
    "REVIEW_RUNNER",
    "REVIEW_STRIPPER",
    "REVIEW_POSTER",
    "REVIEW_RESULT_HELPER",
    "REVIEW_MODE",
    "POST_COMMENT",
    "SUPPRESS_WRITES",
    "RESOLVE_STALE",
    "MAX_FINDINGS",
    "FAIL_ON_FINDINGS",
    "BLOCK_SEVERITIES",
  ]) {
    delete env[name];
  }

  const finalized = spawnSync("bash", ["-c", workflowRunStep("post review")], {
    cwd: directory,
    encoding: "utf8",
    env,
  });

  assert.equal(finalized.status, 1, finalized.stderr);
  assert.equal(existsSync(untrustedPosterMarker), false);
  const outputs = envFileValues(outputFile);
  const result = JSON.parse(readFileSync(resultFile, "utf8"));
  assert.deepEqual(result, expectedExecutionFailureResult(env.BASE_SHA, env.HEAD_SHA));
  assert.equal(outputs.analysis_state, "inconclusive");
  assert.equal(outputs.sample_state, "unknown");
  assert.equal(outputs.bounded_converged, "false");
  assert.equal(outputs.coverage, "unknown");
  assert.equal(outputs.converged, "false");
  assert.deepEqual(
    outputs,
    Object.fromEntries(Object.entries(result).map(([name, value]) => [
      name,
      typeof value === "object" ? JSON.stringify(value) : String(value),
    ])),
  );
  assertFinalResultSummary(readFileSync(summaryFile, "utf8"), result);

  const source = readFileSync(workflow, "utf8");
  for (const field of ["analysis_state", "sample_state", "bounded_converged", "coverage", "converged"]) {
    assert.match(source, new RegExp(`^        value: \\$\\{\\{ jobs\\.review\\.outputs\\.${field} \\}\\}`, "m"));
    assert.match(source, new RegExp(`^      ${field}: \\$\\{\\{ steps\\.poster\\.outputs\\.${field} \\}\\}`, "m"));
  }
});

test("behind-base poster no-result fallback pairs with the trusted merge-base publication", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hosted-poster-load-failure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const trustedPoster = join(directory, "scripts", "post-review.mjs");
  const publicationFile = join(directory, "review-publication.json");
  mkdirSync(dirname(trustedPoster), { recursive: true });
  writeFileSync(trustedPoster, 'import "./missing-trusted-dependency.mjs";\n');
  copyFileSync(resultCli, join(directory, "scripts", "review-result.mjs"));
  copyFileSync(join(dirname(resultCli), "lib-findings.mjs"), join(directory, "scripts", "lib-findings.mjs"));

  const baseSha = "1111111111111111111111111111111111111111";
  const targetBaseSha = "3333333333333333333333333333333333333333";
  const headSha = "2222222222222222222222222222222222222222";
  const env = {
    ...process.env,
    TARGET_ELIGIBLE: "true",
    PR_NUMBER: "7",
    GITHUB_REPO: "example/repository",
    HEAD_SHA: headSha,
    BASE_SHA: targetBaseSha,
    TRUSTED_DATA_ROOT: directory,
    REVIEW_POSTER: trustedPoster,
    REVIEW_PUBLICATION_FILE: publicationFile,
    REVIEW_RESULT_HELPER: join(directory, "scripts", "review-result.mjs"),
    REVIEW_MODE: "summary",
    POST_COMMENT: "false",
    SUPPRESS_WRITES: "true",
    RESOLVE_STALE: "false",
    MAX_FINDINGS: "20",
    FAIL_ON_FINDINGS: "false",
    BLOCK_SEVERITIES: "Critical,High",
  };
  const outputFile = join(directory, "failure-output");
  const resultFile = join(directory, "failure-result.json");
  const summaryFile = join(directory, "failure-summary");
  const failedLoad = spawnSync("bash", ["-c", workflowRunStep("post review")], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...env,
      GITHUB_OUTPUT: outputFile,
      REVIEW_RESULT_FILE: resultFile,
      GITHUB_STEP_SUMMARY: summaryFile,
    },
  });

  assert.notEqual(failedLoad.status, 0);
  assert.match(failedLoad.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module/);
  const expectedResult = expectedExecutionFailureResult(targetBaseSha, headSha);
  assert.deepEqual(JSON.parse(readFileSync(resultFile, "utf8")), expectedResult);
  assert.deepEqual(
    envFileValues(outputFile),
    Object.fromEntries(Object.entries(expectedResult).map(([name, value]) => [
      name,
      typeof value === "object" ? JSON.stringify(value) : String(value),
    ])),
  );
  assertFinalResultSummary(readFileSync(summaryFile, "utf8"), expectedResult);

  const crashFindings = [
    finding("Publication blocker", { severity: "Critical" }),
    finding("Publication warning"),
  ];
  const configurationFingerprint = "a".repeat(64);
  const trustedScopeHash = writeTrustedPublication({
    baseSha,
    configurationFingerprint,
    completedPasses: ["general", "correctness", "boundaries"],
    findings: crashFindings,
    headSha,
    publicationFile: publicationFile,
    requestedPasses: ["general", "correctness", "boundaries"],
  });
  writeFileSync(trustedPoster, "process.exit(47);\n");
  const killedOutput = join(directory, "killed-output");
  const killedResultFile = join(directory, "killed-result.json");
  const killedSummary = join(directory, "killed-summary");
  const killedBeforeResult = spawnSync("bash", ["-c", workflowRunStep("post review")], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...env,
      GITHUB_OUTPUT: killedOutput,
      REVIEW_RESULT_FILE: killedResultFile,
      GITHUB_STEP_SUMMARY: killedSummary,
    },
  });
  const expectedKilledResult = expectedExecutionFailureResult(baseSha, headSha, {
    configurationFingerprint,
    passesRequested: 3,
    passesCompleted: 3,
    scopeHash: trustedScopeHash,
    mergeState: "blocked",
    sampleState: "findings",
    currentCounts: { Critical: 1, High: 0, Medium: 1 },
  });

  assert.equal(killedBeforeResult.status, 47, killedBeforeResult.stderr);
  assert.doesNotMatch(
    killedBeforeResult.stderr,
    /trusted review publication is invalid/,
    killedBeforeResult.stderr,
  );
  assert.deepEqual(
    JSON.parse(readFileSync(killedResultFile, "utf8")),
    expectedKilledResult,
    killedBeforeResult.stderr,
  );
  assert.deepEqual(
    envFileValues(killedOutput),
    Object.fromEntries(Object.entries(expectedKilledResult).map(([name, value]) => [
      name,
      typeof value === "object" ? JSON.stringify(value) : String(value),
    ])),
  );
  assertFinalResultSummary(readFileSync(killedSummary, "utf8"), expectedKilledResult);

  const emittedResult = {
    ...expectedExecutionFailureResult(baseSha, headSha),
    analysis_state: "complete",
    configuration_fingerprint: configurationFingerprint,
    passes_requested: 3,
    passes_completed: 3,
    sample_state: "clean",
    bounded_converged: true,
    coverage: "bounded",
    remaining_analysis: [],
    scope_hash: trustedScopeHash,
    converged: true,
  };
  const emittedResultText = `${JSON.stringify(emittedResult, null, 2)}\n`;
  const emittedOutput = "analysis_state=complete\n";
  const emittedSummary = "## Agentic review\n\n| Result | Value |\n| --- | --- |\n| Analysis | `complete` |\n";
  writeFileSync(trustedPoster, `
import { appendFileSync, writeFileSync } from "node:fs";
writeFileSync(process.env.REVIEW_RESULT_FILE, process.env.EMITTED_RESULT);
appendFileSync(process.env.GITHUB_OUTPUT, process.env.EMITTED_OUTPUT);
appendFileSync(process.env.GITHUB_STEP_SUMMARY, process.env.EMITTED_SUMMARY);
process.exit(23);
`);
  const preservedOutput = join(directory, "preserved-output");
  const preservedResult = join(directory, "preserved-result.json");
  const preservedSummary = join(directory, "preserved-summary");
  const failedAfterResult = spawnSync("bash", ["-c", workflowRunStep("post review")], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...env,
      GITHUB_OUTPUT: preservedOutput,
      REVIEW_RESULT_FILE: preservedResult,
      GITHUB_STEP_SUMMARY: preservedSummary,
      EMITTED_RESULT: emittedResultText,
      EMITTED_OUTPUT: emittedOutput,
      EMITTED_SUMMARY: emittedSummary,
    },
  });

  assert.equal(failedAfterResult.status, 23, failedAfterResult.stderr);
  assert.equal(readFileSync(preservedResult, "utf8"), emittedResultText);
  assert.deepEqual(
    envFileValues(preservedOutput),
    Object.fromEntries(Object.entries(emittedResult).map(([name, value]) => [
      name,
      typeof value === "object" ? JSON.stringify(value) : String(value),
    ])),
  );
  const completedSummary = readFileSync(preservedSummary, "utf8");
  assert.ok(completedSummary.startsWith(emittedSummary));
  assertFinalResultSummary(completedSummary, emittedResult);

  writeFileSync(trustedPoster, `
import { writeFileSync } from "node:fs";
writeFileSync(process.env.REVIEW_RESULT_FILE, process.env.EMITTED_RESULT);
process.exit(29);
`);
  const repairedOutput = join(directory, "repaired-output");
  const preservedPartialResult = join(directory, "preserved-partial-result.json");
  const repairedSummary = join(directory, "repaired-summary");
  const failedAfterResultOnly = spawnSync("bash", ["-c", workflowRunStep("post review")], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...env,
      GITHUB_OUTPUT: repairedOutput,
      REVIEW_RESULT_FILE: preservedPartialResult,
      GITHUB_STEP_SUMMARY: repairedSummary,
      EMITTED_RESULT: emittedResultText,
    },
  });

  assert.equal(failedAfterResultOnly.status, 29, failedAfterResultOnly.stderr);
  assert.equal(readFileSync(preservedPartialResult, "utf8"), emittedResultText);
  assert.deepEqual(
    envFileValues(repairedOutput),
    Object.fromEntries(Object.entries(emittedResult).map(([name, value]) => [
      name,
      typeof value === "object" ? JSON.stringify(value) : String(value),
    ])),
  );
  assertFinalResultSummary(readFileSync(repairedSummary, "utf8"), emittedResult);

  const mismatchedResult = {
    ...emittedResult,
    base_sha: targetBaseSha,
  };
  const mismatchedOutput = join(directory, "mismatched-output");
  const mismatchedResultFile = join(directory, "mismatched-result.json");
  const mismatchedSummary = join(directory, "mismatched-summary");
  const failedWithMismatchedBase = spawnSync(
    "bash",
    ["-c", workflowRunStep("post review")],
    {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...env,
        GITHUB_OUTPUT: mismatchedOutput,
        REVIEW_RESULT_FILE: mismatchedResultFile,
        GITHUB_STEP_SUMMARY: mismatchedSummary,
        EMITTED_RESULT: `${JSON.stringify(mismatchedResult, null, 2)}\n`,
      },
    },
  );

  assert.equal(failedWithMismatchedBase.status, 29, failedWithMismatchedBase.stderr);
  assert.match(failedWithMismatchedBase.stderr, /result target must match the trusted review scope/);
  assert.deepEqual(
    JSON.parse(readFileSync(mismatchedResultFile, "utf8")),
    expectedKilledResult,
  );
});

test("workflow failure fallback is bounded by trusted runner analysis", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hosted-result-analysis-boundary-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const trustedPoster = join(directory, "scripts", "post-review.mjs");
  const publicationFile = join(directory, "review-publication.json");
  mkdirSync(dirname(trustedPoster), { recursive: true });
  writeFileSync(trustedPoster, `
import { writeFileSync } from "node:fs";
writeFileSync(process.env.REVIEW_RESULT_FILE, process.env.EMITTED_RESULT);
process.exit(41);
`);
  copyFileSync(resultCli, join(directory, "scripts", "review-result.mjs"));
  copyFileSync(join(dirname(resultCli), "lib-findings.mjs"), join(directory, "scripts", "lib-findings.mjs"));

  const baseSha = "1111111111111111111111111111111111111111";
  const headSha = "2222222222222222222222222222222222222222";
  const configurationFingerprint = "a".repeat(64);
  const requestedPasses = ["general", "correctness", "boundaries"];
  const env = {
    ...process.env,
    TARGET_ELIGIBLE: "true",
    PR_NUMBER: "7",
    GITHUB_REPO: "example/repository",
    HEAD_SHA: headSha,
    BASE_SHA: baseSha,
    TRUSTED_DATA_ROOT: directory,
    REVIEW_POSTER: trustedPoster,
    REVIEW_RESULT_HELPER: join(directory, "scripts", "review-result.mjs"),
    REVIEW_PUBLICATION_FILE: publicationFile,
    REVIEW_MODE: "summary",
    POST_COMMENT: "false",
    SUPPRESS_WRITES: "true",
    RESOLVE_STALE: "false",
    MAX_FINDINGS: "20",
    FAIL_ON_FINDINGS: "false",
    BLOCK_SEVERITIES: "Critical,High",
  };
  const incompleteRuns = [
    ["truncated diff", ["diff_truncated"]],
    ["finding cap", ["finding_cap_reached"]],
    ["mutable snapshot", ["snapshot_mutable"]],
    ["vote threshold", ["vote_threshold_applied"]],
    ["merge failure", ["merge_failed"]],
  ];

  for (const [name, remainingAnalysis] of incompleteRuns) {
    const trustedScopeHash = writeTrustedPublication({
      analysisState: "inconclusive",
      baseSha,
      configurationFingerprint,
      completedPasses: requestedPasses,
      coverage: "unknown",
      headSha,
      publicationFile: publicationFile,
      remainingAnalysis,
      requestedPasses,
    });
    const expectedResult = expectedExecutionFailureResult(baseSha, headSha, {
      configurationFingerprint,
      passesRequested: requestedPasses.length,
      passesCompleted: requestedPasses.length,
      scopeHash: trustedScopeHash,
      remainingAnalysis,
    });
    const strongerResult = {
      ...expectedResult,
      analysis_state: "complete",
      configuration_fingerprint: configurationFingerprint,
      passes_requested: requestedPasses.length,
      passes_completed: requestedPasses.length,
      sample_state: "clean",
      bounded_converged: true,
      coverage: "bounded",
      remaining_analysis: [],
      scope_hash: trustedScopeHash,
      converged: true,
    };
    const suffix = name.replaceAll(" ", "-");
    const outputFile = join(directory, `${suffix}-output`);
    const resultFile = join(directory, `${suffix}-result.json`);
    const summaryFile = join(directory, `${suffix}-summary`);
    const finalized = spawnSync("bash", ["-c", workflowRunStep("post review")], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...env,
        GITHUB_OUTPUT: outputFile,
        REVIEW_RESULT_FILE: resultFile,
        GITHUB_STEP_SUMMARY: summaryFile,
        EMITTED_RESULT: `${JSON.stringify(strongerResult, null, 2)}\n`,
      },
    });

    assert.equal(finalized.status, 41, finalized.stderr);
    assert.match(finalized.stderr, /must not strengthen trusted review metadata/);
    assert.deepEqual(JSON.parse(readFileSync(resultFile, "utf8")), expectedResult);
    assertFinalResultSummary(readFileSync(summaryFile, "utf8"), expectedResult);
  }

  const trustedScopeHash = writeTrustedPublication({
    baseSha,
    configurationFingerprint,
    completedPasses: requestedPasses,
    headSha,
    publicationFile: publicationFile,
    requestedPasses,
  });
  const reconciledResult = {
    ...expectedExecutionFailureResult(baseSha, headSha, {
      configurationFingerprint,
      passesRequested: requestedPasses.length,
      passesCompleted: requestedPasses.length,
      scopeHash: trustedScopeHash,
    }),
    analysis_state: "complete",
    merge_state: "blocked",
    sample_state: "findings",
    configuration_fingerprint: configurationFingerprint,
    passes_requested: requestedPasses.length,
    passes_completed: requestedPasses.length,
    unresolved_counts: { Critical: 0, High: 1, Medium: 0 },
    scope_hash: trustedScopeHash,
    remaining_analysis: ["reconciliation_unknown"],
  };
  const reconciledResultText = `${JSON.stringify(reconciledResult, null, 2)}\n`;
  const reconciledOutput = join(directory, "reconciled-output");
  const reconciledResultFile = join(directory, "reconciled-result.json");
  const reconciledSummary = join(directory, "reconciled-summary");
  const finalized = spawnSync("bash", ["-c", workflowRunStep("post review")], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...env,
      GITHUB_OUTPUT: reconciledOutput,
      REVIEW_RESULT_FILE: reconciledResultFile,
      GITHUB_STEP_SUMMARY: reconciledSummary,
      EMITTED_RESULT: reconciledResultText,
    },
  });

  assert.equal(finalized.status, 41, finalized.stderr);
  assert.equal(readFileSync(reconciledResultFile, "utf8"), reconciledResultText);
  assert.deepEqual(
    envFileValues(reconciledOutput),
    Object.fromEntries(Object.entries(reconciledResult).map(([name, value]) => [
      name,
      typeof value === "object" ? JSON.stringify(value) : String(value),
    ])),
  );
  assertFinalResultSummary(readFileSync(reconciledSummary, "utf8"), reconciledResult);
});

test("workflow boundary rejects a valid poster result for another trusted scope", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hosted-result-scope-mismatch-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const trustedPoster = join(directory, "scripts", "post-review.mjs");
  const publicationFile = join(directory, "review-publication.json");
  mkdirSync(dirname(trustedPoster), { recursive: true });
  writeFileSync(trustedPoster, `
import { writeFileSync } from "node:fs";
writeFileSync(process.env.REVIEW_RESULT_FILE, process.env.EMITTED_RESULT);
process.exit(37);
`);
  copyFileSync(resultCli, join(directory, "scripts", "review-result.mjs"));
  copyFileSync(join(dirname(resultCli), "lib-findings.mjs"), join(directory, "scripts", "lib-findings.mjs"));

  const baseSha = "1111111111111111111111111111111111111111";
  const headSha = "2222222222222222222222222222222222222222";
  const configurationFingerprint = "a".repeat(64);
  const trustedScopeHash = writeTrustedPublication({
    baseSha,
    configurationFingerprint,
    completedPasses: ["general", "correctness", "boundaries"],
    headSha,
    publicationFile: publicationFile,
    requestedPasses: ["general", "correctness", "boundaries"],
  });
  const validResultForAnotherScope = {
    ...expectedExecutionFailureResult(baseSha, headSha),
    analysis_state: "complete",
    configuration_fingerprint: configurationFingerprint,
    passes_requested: 3,
    passes_completed: 3,
    sample_state: "clean",
    bounded_converged: true,
    coverage: "bounded",
    remaining_analysis: [],
    scope_hash: "c".repeat(64),
    converged: true,
  };
  const resultFile = join(directory, "review-result.json");
  const outputFile = join(directory, "github-output");
  const summaryFile = join(directory, "step-summary");
  const finalized = spawnSync("bash", ["-c", workflowRunStep("post review")], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      TARGET_ELIGIBLE: "true",
      PR_NUMBER: "7",
      GITHUB_REPO: "example/repository",
      HEAD_SHA: headSha,
      BASE_SHA: baseSha,
      TRUSTED_DATA_ROOT: directory,
      REVIEW_POSTER: trustedPoster,
      REVIEW_RESULT_HELPER: join(directory, "scripts", "review-result.mjs"),
      REVIEW_PUBLICATION_FILE: publicationFile,
      REVIEW_RESULT_FILE: resultFile,
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      REVIEW_MODE: "summary",
      POST_COMMENT: "false",
      SUPPRESS_WRITES: "true",
      RESOLVE_STALE: "false",
      MAX_FINDINGS: "20",
      FAIL_ON_FINDINGS: "false",
      BLOCK_SEVERITIES: "Critical,High",
      EMITTED_RESULT: `${JSON.stringify(validResultForAnotherScope, null, 2)}\n`,
    },
  });

  const expectedResult = expectedExecutionFailureResult(baseSha, headSha, {
    configurationFingerprint,
    passesRequested: 3,
    passesCompleted: 3,
    scopeHash: trustedScopeHash,
  });
  assert.equal(finalized.status, 37, finalized.stderr);
  assert.match(finalized.stderr, /scope_hash must match the trusted review scope/);
  assert.deepEqual(JSON.parse(readFileSync(resultFile, "utf8")), expectedResult);
  assert.deepEqual(
    envFileValues(outputFile),
    Object.fromEntries(Object.entries(expectedResult).map(([name, value]) => [
      name,
      typeof value === "object" ? JSON.stringify(value) : String(value),
    ])),
  );
  assertFinalResultSummary(readFileSync(summaryFile, "utf8"), expectedResult);
});

test("workflow boundary replaces key-complete semantically invalid poster results", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hosted-invalid-result-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const trustedPoster = join(directory, "scripts", "post-review.mjs");
  const publicationFile = join(directory, "review-publication.json");
  mkdirSync(dirname(trustedPoster), { recursive: true });
  writeFileSync(trustedPoster, `
import { writeFileSync } from "node:fs";
writeFileSync(process.env.REVIEW_RESULT_FILE, process.env.EMITTED_RESULT);
process.exit(31);
`);
  copyFileSync(resultCli, join(directory, "scripts", "review-result.mjs"));
  copyFileSync(join(dirname(resultCli), "lib-findings.mjs"), join(directory, "scripts", "lib-findings.mjs"));

  const baseSha = "1111111111111111111111111111111111111111";
  const headSha = "2222222222222222222222222222222222222222";
  const configurationFingerprint = "a".repeat(64);
  const trustedScopeHash = writeTrustedPublication({
    baseSha,
    configurationFingerprint,
    completedPasses: ["general"],
    headSha,
    publicationFile: publicationFile,
    requestedPasses: ["general"],
  });
  const expectedResult = expectedExecutionFailureResult(baseSha, headSha, {
    configurationFingerprint,
    passesRequested: 1,
    passesCompleted: 1,
    scopeHash: trustedScopeHash,
  });
  const validResult = {
    ...expectedResult,
    configuration_fingerprint: configurationFingerprint,
    passes_requested: 1,
    passes_completed: 1,
    scope_hash: trustedScopeHash,
  };
  const invalidResults = [
    ["string boolean", { ...validResult, bounded_converged: "false" }],
    ["string pass count", { ...validResult, passes_requested: "0" }],
    [
      "completed passes exceed requested",
      { ...validResult, passes_requested: 1, passes_completed: 2 },
    ],
    [
      "invalid configuration fingerprint",
      { ...validResult, configuration_fingerprint: "A".repeat(64) },
    ],
    [
      "different valid configuration fingerprint",
      { ...validResult, configuration_fingerprint: "b".repeat(64) },
      /configuration_fingerprint must match trusted review metadata/,
    ],
    [
      "different requested pass count",
      { ...validResult, passes_requested: 2 },
      /pass counts must match trusted review metadata/,
    ],
    [
      "different completed pass count",
      { ...validResult, passes_completed: 0 },
      /pass counts must match trusted review metadata/,
    ],
    ["invalid scope hash", { ...validResult, scope_hash: "f".repeat(63) }],
    [
      "complete result with zero passes and empty identity",
      {
        ...validResult,
        configuration_fingerprint: "",
        passes_requested: 0,
        passes_completed: 0,
        analysis_state: "complete",
        sample_state: "clean",
        bounded_converged: true,
        coverage: "bounded",
        remaining_analysis: [],
        converged: true,
      },
    ],
    [
      "complete findings result with diff truncated",
      {
        ...validResult,
        analysis_state: "complete",
        passes_requested: 1,
        passes_completed: 1,
        configuration_fingerprint: "a".repeat(64),
        current_counts: { Critical: 0, High: 0, Medium: 1 },
        sample_state: "findings",
        scope_hash: trustedScopeHash,
        remaining_analysis: ["diff_truncated"],
      },
    ],
    [
      "complete result with execution failure",
      {
        ...validResult,
        analysis_state: "complete",
        passes_requested: 1,
        passes_completed: 1,
        configuration_fingerprint: "a".repeat(64),
        scope_hash: trustedScopeHash,
      },
    ],
    ["array count map", { ...validResult, current_counts: [] }],
    [
      "invalid count values",
      { ...validResult, unresolved_counts: { Critical: 0, High: -1, Medium: 0 } },
    ],
    [
      "stale target",
      {
        ...validResult,
        base_sha: "3333333333333333333333333333333333333333",
        head_sha: "4444444444444444444444444444444444444444",
        reviewed_head: "4444444444444444444444444444444444444444",
      },
    ],
    [
      "mismatched reviewed head",
      { ...validResult, reviewed_head: "3333333333333333333333333333333333333333" },
    ],
    [
      "clean result with findings",
      {
        ...validResult,
        sample_state: "clean",
        current_counts: { Critical: 0, High: 0, Medium: 1 },
      },
    ],
    ["findings result without counts", { ...validResult, sample_state: "findings" }],
    ["clean execution failure without counts", { ...validResult, sample_state: "clean" }],
    ["blocked result without findings", { ...validResult, merge_state: "blocked" }],
    [
      "ready result with configured blocking findings",
      {
        ...validResult,
        unresolved_counts: { Critical: 0, High: 1, Medium: 0 },
        sample_state: "findings",
      },
      /merge_state must agree with configured blocking severity counts/,
    ],
    [
      "blocked result without configured blockers",
      {
        ...validResult,
        merge_state: "blocked",
        current_counts: { Critical: 0, High: 0, Medium: 1 },
        sample_state: "findings",
      },
      /merge_state must agree with configured blocking severity counts/,
    ],
    ["unsupported remaining reason", { ...validResult, remaining_analysis: ["unsupported"] }],
    [
      "duplicate remaining reasons",
      { ...validResult, remaining_analysis: ["execution_failed", "execution_failed"] },
    ],
    [
      "remaining reasons outside canonical order",
      { ...validResult, remaining_analysis: ["execution_failed", "diff_truncated"] },
      /remaining_analysis must contain unique canonical ordered reason strings/,
    ],
    [
      "inconclusive result with reconciliation only",
      { ...validResult, remaining_analysis: ["reconciliation_unknown"] },
    ],
    [
      "incorrect convergence",
      { ...validResult, bounded_converged: true, converged: true },
    ],
    [
      "bounded coverage for incomplete unknown result",
      { ...validResult, coverage: "bounded", remaining_analysis: [] },
    ],
    [
      "unknown coverage for complete known result",
      {
        ...validResult,
        analysis_state: "complete",
        sample_state: "clean",
        bounded_converged: true,
        coverage: "unknown",
        remaining_analysis: [],
        converged: true,
      },
    ],
  ];

  for (const [name, invalidResult, expectedDiagnostic] of invalidResults) {
    const suffix = name.replaceAll(" ", "-");
    const outputFile = join(directory, `${suffix}-output`);
    const resultFile = join(directory, `${suffix}-result.json`);
    const summaryFile = join(directory, `${suffix}-summary`);
    const finalized = spawnSync("bash", ["-c", workflowRunStep("post review")], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        TARGET_ELIGIBLE: "true",
        PR_NUMBER: "7",
        GITHUB_REPO: "example/repository",
        HEAD_SHA: headSha,
        BASE_SHA: baseSha,
        TRUSTED_DATA_ROOT: directory,
        REVIEW_POSTER: trustedPoster,
        REVIEW_RESULT_HELPER: join(directory, "scripts", "review-result.mjs"),
        REVIEW_PUBLICATION_FILE: publicationFile,
        REVIEW_MODE: "summary",
        POST_COMMENT: "false",
        SUPPRESS_WRITES: "true",
        RESOLVE_STALE: "false",
        MAX_FINDINGS: "20",
        FAIL_ON_FINDINGS: "false",
        BLOCK_SEVERITIES: "Critical,High",
        GITHUB_OUTPUT: outputFile,
        REVIEW_RESULT_FILE: resultFile,
        GITHUB_STEP_SUMMARY: summaryFile,
        EMITTED_RESULT: JSON.stringify(invalidResult),
      },
    });

    assert.equal(finalized.status, 31, `${name}: ${finalized.stderr}`);
    assert.match(
      finalized.stderr,
      /review poster left an invalid result; replacing it conservatively/,
      name,
    );
    if (expectedDiagnostic) assert.match(finalized.stderr, expectedDiagnostic, name);
    assert.deepEqual(JSON.parse(readFileSync(resultFile, "utf8")), expectedResult, name);
    assert.deepEqual(
      envFileValues(outputFile),
      Object.fromEntries(Object.entries(expectedResult).map(([field, value]) => [
        field,
        typeof value === "object" ? JSON.stringify(value) : String(value),
      ])),
      name,
    );
    const summary = readFileSync(summaryFile, "utf8");
    assertFinalResultSummary(summary, expectedResult);
    assert.doesNotMatch(summary, /undefined|Bounded convergence \| `yes`/, name);
  }
});

test("target resolution failure finalizes conservatively while explicit ineligibility remains skipped", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hosted-target-failure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const markerFile = join(directory, "target-poster-ran");
  const targetPoster = join(directory, "scripts", "post-review.mjs");
  mkdirSync(dirname(targetPoster), { recursive: true });
  writeFileSync(targetPoster, `
import { writeFileSync } from "node:fs";
writeFileSync(process.env.TARGET_POSTER_MARKER, "executed");
`);

  const env = {
    ...process.env,
    TRUSTED_DATA_ROOT: directory,
    REVIEW_POSTER: targetPoster,
    REVIEW_MODE: "summary",
    POST_COMMENT: "false",
    SUPPRESS_WRITES: "true",
    RESOLVE_STALE: "false",
    MAX_FINDINGS: "20",
    FAIL_ON_FINDINGS: "false",
    BLOCK_SEVERITIES: "Critical,High",
    TARGET_POSTER_MARKER: markerFile,
  };
  for (const name of ["TARGET_ELIGIBLE", "PR_NUMBER", "GITHUB_REPO", "HEAD_SHA", "BASE_SHA"]) {
    delete env[name];
  }

  const failureOutput = join(directory, "failure-output");
  const failureResult = join(directory, "failure-result.json");
  const failureSummary = join(directory, "failure-summary");
  const failedResolution = spawnSync("bash", ["-c", workflowRunStep("post review")], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...env,
      GITHUB_OUTPUT: failureOutput,
      REVIEW_RESULT_FILE: failureResult,
      GITHUB_STEP_SUMMARY: failureSummary,
    },
  });

  assert.equal(failedResolution.status, 1, failedResolution.stderr);
  assert.equal(existsSync(markerFile), false);
  const expectedResult = expectedExecutionFailureResult("", "");
  assert.deepEqual(JSON.parse(readFileSync(failureResult, "utf8")), expectedResult);
  assert.deepEqual(
    envFileValues(failureOutput),
    Object.fromEntries(Object.entries(expectedResult).map(([name, value]) => [
      name,
      typeof value === "object" ? JSON.stringify(value) : String(value),
    ])),
  );
  assertFinalResultSummary(readFileSync(failureSummary, "utf8"), expectedResult);

  const skippedOutput = join(directory, "skipped-output");
  const skippedResult = join(directory, "skipped-result.json");
  const skipped = spawnSync("bash", ["-c", workflowRunStep("post review")], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...env,
      TARGET_ELIGIBLE: "false",
      GITHUB_OUTPUT: skippedOutput,
      REVIEW_RESULT_FILE: skippedResult,
    },
  });

  assert.equal(skipped.status, 0, skipped.stderr);
  assert.equal(existsSync(skippedOutput), false);
  assert.equal(existsSync(skippedResult), false);
  assert.equal(existsSync(markerFile), false);
});

test("hosted contract runs one trusted ensemble and one suppressed poster gate", (t) => {
  const workflowSource = readFileSync(workflow, "utf8");
  assert.match(workflowSource, /^  pull_request_target:/m);
  assert.doesNotMatch(workflowSource, /^  pull_request:/m);
  assert.match(workflowSource, /github\.event_name != 'pull_request'/);
  const maliciousExecutableMarker = join(tmpdir(), `hosted-target-executed-${process.pid}-${Date.now()}`);
  const targetDataMarker = "UNTRUSTED_TARGET_SUPPORT";
  const shared = finding("Shared hosted defect", {
    file: "alpha.txt",
    severity: "High",
  });
  const medium = finding("Correctness hosted defect", {
    file: "beta.txt",
    severity: "Medium",
  });
  const fixture = createFixture(t, {
    targetFiles: {
      "review/prompt.md": `${targetDataMarker}_PROMPT\n`,
      "review/format-json.md": `${targetDataMarker}_FORMAT\n`,
      "review/lenses/correctness.md": `# This pass: correctness\n${targetDataMarker}_CORRECTNESS\n`,
      "review/lenses/boundaries.md": `# This pass: boundaries\n${targetDataMarker}_BOUNDARIES\n`,
      "skills/infra-review/SKILL.md": `${targetDataMarker}_SKILL\n`,
      "scripts/review-result.mjs": `import { writeFileSync } from "node:fs"; writeFileSync(process.env.MALICIOUS_EXEC_MARKER, "review-result");\n`,
      "scripts/merge-findings.mjs": `import { writeFileSync } from "node:fs"; writeFileSync(process.env.MALICIOUS_EXEC_MARKER, "merge-findings");\n`,
      "scripts/run-review.sh": `#!/usr/bin/env bash\nprintf target > "$MALICIOUS_EXEC_MARKER"\n`,
      "scripts/post-review.mjs": `import { writeFileSync } from "node:fs"; writeFileSync(process.env.MALICIOUS_EXEC_MARKER, "poster");\n`,
      "scripts/strip-agent-config.sh": `#!/usr/bin/env bash\nprintf target > "$MALICIOUS_EXEC_MARKER"\n`,
    },
    baseFiles: {
      "review/prompt.md": `${targetDataMarker}_BASE_PROMPT\n`,
      "review/format-json.md": `${targetDataMarker}_BASE_FORMAT\n`,
      "review/lenses/correctness.md": `# This pass: correctness\n${targetDataMarker}_BASE_CORRECTNESS\n`,
      "review/lenses/boundaries.md": `# This pass: boundaries\n${targetDataMarker}_BASE_BOUNDARIES\n`,
      "skills/infra-review/SKILL.md": `${targetDataMarker}_BASE_SKILL\n`,
    },
  });
  t.after(() => rmSync(maliciousExecutableMarker, { force: true }));
  symlinkSync(trustedRoot, join(fixture.repository, ".central-skills"), "dir");

  const planFile = join(fixture.directory, "plan.json");
  const logFile = join(fixture.directory, "omp.log");
  writeFileSync(planFile, JSON.stringify({
    general: [{ findings: [shared] }],
    correctness: [{ findings: [medium] }],
    boundaries: [{ findings: [shared] }],
  }));

  const failedSupportSelection = spawnSync("bash", ["-c", workflowRunStep("select trusted support")], {
    cwd: fixture.repository,
    encoding: "utf8",
    env: {
      ...process.env,
      TARGET_REPO: "outside/target",
      CENTRAL_OUTCOME: "failure",
      CENTRAL_REPO: "atomikpanda/agentic-review",
      GITHUB_ENV: join(fixture.directory, "failed-support.env"),
    },
  });
  assert.notEqual(failedSupportSelection.status, 0);
  assert.match(`${failedSupportSelection.stdout}${failedSupportSelection.stderr}`, /trusted support checkout .* failed/);

  const supportEnvFile = join(fixture.directory, "support.env");
  const selectionResult = spawnSync("bash", ["-c", workflowRunStep("select trusted support")], {
    cwd: fixture.repository,
    encoding: "utf8",
    env: {
      ...process.env,
      TARGET_REPO: "outside/target",
      CENTRAL_OUTCOME: "success",
      CENTRAL_REPO: "atomikpanda/agentic-review",
      GITHUB_ENV: supportEnvFile,
    },
  });
  assert.equal(selectionResult.status, 0, selectionResult.stderr);
  const support = envFileValues(supportEnvFile);
  assert.equal(support.REVIEW_RUNNER, runner);
  assert.equal(support.REVIEW_POSTER, poster);
  assert.equal(support.REVIEW_RESULT_HELPER, resultCli);
  assert.equal(support.TRUSTED_DATA_ROOT, trustedRoot);

  const selfSupportEnvFile = join(fixture.directory, "self-support.env");
  const selfSelection = spawnSync("bash", ["-c", workflowRunStep("select trusted support")], {
    cwd: fixture.repository,
    encoding: "utf8",
    env: {
      ...process.env,
      TARGET_REPO: "atomikpanda/agentic-review",
      CENTRAL_REPO: "atomikpanda/agentic-review",
      CENTRAL_OUTCOME: "failure",
      GITHUB_ENV: selfSupportEnvFile,
    },
  });
  assert.notEqual(selfSelection.status, 0);
  assert.match(`${selfSelection.stdout}${selfSelection.stderr}`, /trusted support checkout .* failed/);

  const selfTrustedEnvFile = join(fixture.directory, "self-trusted.env");
  const selfTrustedSelection = spawnSync("bash", ["-c", workflowRunStep("select trusted support")], {
    cwd: fixture.repository,
    encoding: "utf8",
    env: {
      ...process.env,
      TARGET_REPO: "atomikpanda/agentic-review",
      CENTRAL_REPO: "atomikpanda/agentic-review",
      CENTRAL_OUTCOME: "success",
      GITHUB_ENV: selfTrustedEnvFile,
    },
  });
  assert.equal(selfTrustedSelection.status, 0, selfTrustedSelection.stderr);
  const selfSupport = envFileValues(selfTrustedEnvFile);
  assert.equal(selfSupport.TRUSTED_DATA_ROOT, trustedRoot);
  assert.equal(selfSupport.REVIEW_RUNNER, runner);
  assert.equal(selfSupport.REVIEW_POSTER, poster);
  assert.equal(selfSupport.REVIEW_RESULT_HELPER, resultCli);

  for (const path of ["/tmp/prompt-body.md", "/tmp/skill.md", "/tmp/one-skill.md"]) {
    rmSync(path, { force: true });
    t.after(() => rmSync(path, { force: true }));
  }
  const promptEnvFile = join(fixture.directory, "prompt.env");
  const promptResolution = spawnSync("bash", ["-c", workflowRunStep("resolve trusted prompt and skills")], {
    cwd: fixture.repository,
    encoding: "utf8",
    env: {
      ...process.env,
      ...support,
      BASE: fixture.baseSha,
      PROMPT_PATH: "review/prompt.md",
      SKILLS_PATH: "skills/infra-review/SKILL.md,skills/security-review/SKILL.md",
      GITHUB_ENV: promptEnvFile,
    },
  });
  assert.equal(promptResolution.status, 0, promptResolution.stderr);
  const promptSupport = envFileValues(promptEnvFile);
  assert.equal(promptSupport.PROMPT_FILE, "/tmp/prompt-body.md");
  assert.equal(promptSupport.SKILL_FILE, "/tmp/skill.md");
  assert.equal(readFileSync(promptSupport.PROMPT_FILE, "utf8").includes(targetDataMarker), false);
  assert.equal(readFileSync(promptSupport.SKILL_FILE, "utf8").includes(targetDataMarker), false);

  const findingsFile = "/tmp/review.md";
  const publicationFile = "/tmp/review-publication.json";
  const runnerOutFile = "/tmp/review-runner.out";
  const runnerErrFile = "/tmp/review-runner.err";
  for (const path of [findingsFile, publicationFile, runnerOutFile, runnerErrFile]) {
    rmSync(path, { force: true });
    t.after(() => rmSync(path, { force: true }));
  }
  const reviewResult = spawnSync("bash", ["-c", workflowRunStep("run agentic review (read-only)")], {
    cwd: fixture.repository,
    encoding: "utf8",
    env: {
      ...process.env,
      ...support,
      ...promptSupport,
      PATH: `${fixture.bin}:${process.env.PATH}`,
      OPENROUTER_API_KEY: "sk-or-hosted-test",
      FAKE_OMP_PLAN: planFile,
      FAKE_OMP_LOG: logFile,
      FAKE_OMP_STATE: fixture.state,
      MALICIOUS_EXEC_MARKER: maliciousExecutableMarker,
      BASE: fixture.baseSha,
      HEAD: fixture.headSha,
      MODEL: "openrouter/test/hosted",
      THINKING: "low",
      TOOLS: "read,grep,glob",
      MAX_TIME: "7m",
      MAX_FINDINGS: "5",
      MAX_DIFF_BYTES: "400000",
      REVIEW_MODE: "summary",
      OMP_VERSION: "latest",
      EXTRA_ARGS: "--print-thoughts",
      CODEGRAPH: "false",
    },
  });
  assert.equal(reviewResult.status, 0, reviewResult.stderr);

  const logs = readFileSync(logFile, "utf8").trim().split("\n").map(JSON.parse);
  const findingsDocument = JSON.parse(readFileSync(findingsFile, "utf8"));
  const { findings, metadata } = JSON.parse(readFileSync(publicationFile, "utf8"));
  assert.equal(logs.length, 3);
  assert.deepEqual(logs.map(({ id }) => id), ["general", "correctness", "boundaries"]);
  assert.ok(logs.every(({ attempt }) => attempt === 1));
  assert.ok(logs.every(({ argv }) => argv.includes("--print-thoughts")));
  assert.ok(logs.every(({ prompt }) => prompt.includes("Output a single JSON object and nothing else")));
  assert.ok(logs.every(({ prompt }) => !prompt.split("## Changed files", 1)[0].includes(targetDataMarker)));
  assert.ok(logs.every(({ skill }) => !skill.includes(targetDataMarker)));
  assert.equal(existsSync(maliciousExecutableMarker), false);
  assert.equal(existsSync(findingsFile), true);
  assert.equal(existsSync(publicationFile), true);
  assert.deepEqual(metadata.passes.requested, ["general", "correctness", "boundaries"]);
  assert.deepEqual(metadata.passes.completed, ["general", "correctness", "boundaries"]);
  assert.equal(metadata.analysis_state, "complete");
  assert.equal(metadata.reviewed_head, fixture.headSha);
  assert.match(metadata.scope_hash, /^[a-f0-9]{64}$/);
  assert.equal(metadata.coverage, "bounded");
  assert.deepEqual(metadata.remaining_analysis, []);
  assert.deepEqual(
    findings.map(({ title }) => title).sort(),
    ["Correctness hosted defect", "Shared hosted defect"],
  );
  assert.equal(findings.find(({ title }) => title === shared.title).votes, 2);
  assert.deepEqual(findings, findingsDocument.findings);

  const githubLogFile = join(fixture.directory, "github.log");
  const posterCallsFile = join(fixture.directory, "poster-calls.log");
  const outputFile = join(fixture.directory, "poster-output");
  const summaryFile = join(fixture.directory, "poster-summary");
  const resultFile = join(fixture.directory, "poster-result.json");
  const preloadFile = join(fixture.directory, "fake-github.mjs");
  writeFileSync(preloadFile, `
import { appendFileSync } from "node:fs";
let posterRecorded = false;
globalThis.fetch = async (url, options = {}) => {
  if (!posterRecorded) {
    appendFileSync(process.env.FAKE_POSTER_CALLS, "poster\\n");
    posterRecorded = true;
  }
  const method = options.method ?? "GET";
  const body = String(options.body ?? "");
  appendFileSync(process.env.FAKE_GITHUB_LOG, JSON.stringify({ url: String(url), method, body }) + "\\n");
  if (String(url).endsWith("/graphql") && body.includes("viewer")) {
    return { ok: true, status: 200, json: async () => ({ data: { viewer: { login: "review-app[bot]" } } }), text: async () => "" };
  }
  if (String(url).endsWith("/graphql") && body.includes("reviewThreads")) {
    return { ok: true, status: 200, json: async () => ({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }), text: async () => "" };
  }
  if (String(url).includes("/pulls/17/reviews") && method === "GET") {
    return { ok: true, status: 200, json: async () => [], text: async () => "" };
  }
  if (String(url).includes("/issues/17/comments") && method === "GET") {
    return { ok: true, status: 200, json: async () => [], text: async () => "" };
  }
  throw new Error("unexpected GitHub request: " + method + " " + url);
};
`);
  const posterResult = spawnSync("bash", ["-c", workflowRunStep("post review")], {
    cwd: fixture.repository,
    encoding: "utf8",
    env: {
      ...process.env,
      ...support,
      NODE_OPTIONS: `--import=${preloadFile}`,
      FAKE_GITHUB_LOG: githubLogFile,
      FAKE_POSTER_CALLS: posterCallsFile,
      GH_TOKEN: "installation-token",
      REVIEW_PUBLICATION_FILE: publicationFile,
      GITHUB_REPO: "outside/target",
      PR_NUMBER: "17",
      HEAD_SHA: fixture.headSha,
      BASE_SHA: fixture.baseSha,
      TARGET_REPO: "outside/target",
      PR: "17",
      TARGET_ELIGIBLE: "true",
      BASE: fixture.baseSha,
      HEAD: fixture.headSha,
      REVIEW_MODE: "summary",
      POST_COMMENT: "true",
      SUPPRESS_WRITES: "true",
      RESOLVE_STALE: "true",
      MAX_FINDINGS: "5",
      FAIL_ON_FINDINGS: "true",
      BLOCK_SEVERITIES: "Critical,High",
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      REVIEW_RESULT_FILE: resultFile,
    },
  });
  assert.equal(posterResult.status, 1, posterResult.stderr);
  assert.match(posterResult.stderr, /1 blocking finding/);
  assert.equal(readFileSync(posterCallsFile, "utf8"), "poster\n");
  const outputs = envFileValues(outputFile);
  assert.equal(outputs.analysis_state, "complete");
  assert.equal(outputs.merge_state, "blocked");
  assert.equal(outputs.sample_state, "findings");
  assert.equal(outputs.bounded_converged, "false");
  assert.equal(outputs.reviewed_head, fixture.headSha);
  assert.equal(outputs.scope_hash, metadata.scope_hash);
  assert.equal(outputs.coverage, "bounded");
  assert.deepEqual(JSON.parse(outputs.remaining_analysis), []);
  assert.equal(outputs.converged, "false");
  assert.equal(outputs.passes_requested, "3");
  assert.equal(outputs.passes_completed, "3");
  assert.deepEqual(JSON.parse(outputs.current_counts), { Critical: 0, High: 1, Medium: 1 });
  assert.deepEqual(JSON.parse(outputs.unresolved_counts), { Critical: 0, High: 0, Medium: 0 });
  assert.match(readFileSync(summaryFile, "utf8"), /\| Passes \| `3 requested \/ 3 completed` \|/);
  assert.equal(JSON.parse(readFileSync(resultFile, "utf8")).merge_state, "blocked");
  const githubRequests = readFileSync(githubLogFile, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(githubRequests.length, 4);
  assert.equal(
    githubRequests.some(({ url, method }) => url.includes("/comments") && method !== "GET"),
    false,
  );
  assert.equal(githubRequests.some(({ body }) => body.includes("mutation")), false);
  assert.equal(existsSync(maliciousExecutableMarker), false);
});

test("local suggest rendering consumes generated metadata and keeps the replacement", (t) => {
  const rendered = finding("Rendered fix", {
    file: "alpha.txt",
    start_line: 1,
    end_line: 1,
    severity: "High",
    suggestion: "alpha replacement\n",
  });
  const run = runReview(t, {
    general: [{ findings: [rendered] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    args: [],
    env: { AGENTIC_REVIEW_MODE: "suggest" },
  });

  assert.equal(run.result.status, 0, run.result.stderr);
  assert.match(run.result.stdout, /\| Analysis \| `complete` \|/);
  assert.match(run.result.stdout, /```suggestion\nalpha replacement\n```/);
  assert.doesNotMatch(run.result.stdout, /^\{\"findings\":/);
});

test("local rendering holds a multi-line finding across unrelated hunks and retires it after overlap", (t) => {
  const baseLines = Array.from({ length: 24 }, (_, index) => `base line ${index + 1}`);
  const reportedLines = [...baseLines];
  reportedLines[0] = "reported head";
  const prior = finding("Persistent local defect", {
    file: "alpha.txt",
    start_line: 8,
    end_line: 10,
    severity: "High",
  });
  const first = runReview(t, {
    general: [{ findings: [prior] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    args: [],
    baseFiles: { "alpha.txt": `${baseLines.join("\n")}\n` },
    targetFiles: { "alpha.txt": `${reportedLines.join("\n")}\n` },
    noState: false,
  });
  assert.equal(first.result.status, 0, first.result.stderr);
  assert.match(first.result.stdout, /\| Sample \| `findings` \|/);
  assert.match(first.result.stdout, /\| Held\/unresolved findings \| `Critical: 0 · High: 0 · Medium: 0` \|/);

  const omitted = {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  };
  const unrelatedLines = [...reportedLines];
  unrelatedLines[19] = "unrelated change";
  writeFileSync(join(first.repository, "alpha.txt"), `${unrelatedLines.join("\n")}\n`);
  git(first.repository, "commit", "-am", "change unrelated hunk");
  const unrelated = runReview(t, omitted, {
    args: [],
    existingFixture: first,
    noState: false,
  });
  assert.equal(unrelated.result.status, 0, unrelated.result.stderr);
  assert.match(unrelated.result.stdout, /\| Sample \| `findings` \|/);
  assert.match(unrelated.result.stdout, /\| Bounded convergence \| `no` \|/);
  assert.match(unrelated.result.stdout, /\| Held\/unresolved findings \| `Critical: 0 · High: 1 · Medium: 0` \|/);

  unrelatedLines[8] = "overlapping change";
  writeFileSync(join(first.repository, "alpha.txt"), `${unrelatedLines.join("\n")}\n`);
  git(first.repository, "commit", "-am", "change reported span");
  const overlapping = runReview(t, omitted, {
    args: [],
    existingFixture: first,
    noState: false,
  });
  assert.equal(overlapping.result.status, 0, overlapping.result.stderr);
  assert.match(overlapping.result.stdout, /\| Sample \| `clean` \|/);
  assert.match(overlapping.result.stdout, /\| Bounded convergence \| `yes` \|/);
});

test("malformed readable local state is not overwritten and makes rendering unknown", (t) => {
  const fixture = createFixture(t);
  const stateDirectory = join(fixture.repository, ".git", "agentic-review");
  const statePath = join(stateDirectory, "state.json");
  const malformed = "{\"findings\":";
  mkdirSync(stateDirectory, { recursive: true });
  writeFileSync(statePath, malformed);
  const run = runReview(t, {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    args: [],
    existingFixture: fixture,
    noState: false,
  });

  assert.equal(run.result.status, 0, run.result.stderr);
  assert.match(run.result.stdout, /\| Sample \| `unknown` \|/);
  assert.match(run.result.stdout, /\| Bounded convergence \| `no` \|/);
  assert.equal(readFileSync(statePath, "utf8"), malformed);
});

test("structurally invalid local entry makes rendering unknown and is not overwritten", (t) => {
  const fixture = createFixture(t);
  const stateDirectory = join(fixture.repository, ".git", "agentic-review");
  const statePath = join(stateDirectory, "state.json");
  const invalid = JSON.stringify({ findings: [{}] });
  mkdirSync(stateDirectory, { recursive: true });
  writeFileSync(statePath, invalid);
  const run = runReview(t, {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    args: [],
    existingFixture: fixture,
    noState: false,
  });

  assert.equal(run.result.status, 0, run.result.stderr);
  assert.match(run.result.stdout, /\| Sample \| `unknown` \|/);
  assert.match(run.result.stdout, /\| Bounded convergence \| `no` \|/);
  assert.equal(readFileSync(statePath, "utf8"), invalid);
});

test("--no-state reads held findings for state and default exit without mutating history", (t) => {
  const high = finding("Held local blocker", { file: "alpha.txt", severity: "High" });
  const medium = finding("Held local advisory", { file: "beta.txt", severity: "Medium" });
  const first = runReview(t, {
    general: [{ findings: [high, medium] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    args: [],
    noState: false,
  });
  assert.equal(first.result.status, 0, first.result.stderr);
  const statePath = join(first.repository, ".git", "agentic-review", "state.json");
  const stateBefore = readFileSync(statePath);

  const held = runReview(t, {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],

  }, {
    args: [],
    existingFixture: first,
    noFail: false,
    noState: true,
  });

  assert.equal(held.result.status, 1, held.result.stderr);
  assert.match(held.result.stdout, /\| Merge gate \| `blocked` \|/);
  assert.match(held.result.stdout, /\| Sample \| `findings` \|/);
  assert.match(held.result.stdout, /\| Bounded convergence \| `no` \|/);
  assert.match(held.result.stdout, /\| Held\/unresolved findings \| `Critical: 0 · High: 1 · Medium: 1` \|/);
  assert.deepEqual(readFileSync(statePath), stateBefore);
  const recurring = runReview(t, {
    general: [{ findings: [high, medium] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    args: [],
    existingFixture: first,
    noState: true,
  });
  assert.equal(recurring.result.status, 0, recurring.result.stderr);
  assert.equal(recurring.result.stdout.match(/\*\*Held local blocker\*\*/g)?.length, 1);
  assert.equal(recurring.result.stdout.match(/\*\*Held local advisory\*\*/g)?.length, 1);
  assert.match(recurring.result.stdout, /\| Held\/unresolved findings \| `Critical: 0 · High: 0 · Medium: 0` \|/);
  assert.doesNotMatch(recurring.result.stdout, /#### Held findings/);
  assert.deepEqual(readFileSync(statePath), stateBefore);
});
test("runner records validated incompleteness so partial local reviews cannot retire held evidence", (t) => {
  const fixture = createFixture(t);
  const blocker = finding("Standing local blocker", {
    file: "alpha.txt",
    severity: "High",
    start_line: 1,
    end_line: 1,
  });
  const first = runReview(t, {
    general: [{ findings: [blocker] }],
    correctness: [{ findings: [blocker] }],
    boundaries: [{ findings: [blocker] }],
  }, {
    existingFixture: fixture,
    noState: false,
  });
  assert.equal(first.result.status, 0, first.result.stderr);
  assert.equal(first.metadata.analysis_state, "complete");

  writeFileSync(join(fixture.repository, "alpha.txt"), "alpha changed after report\n");
  git(fixture.repository, "commit", "-am", "change standing finding span");
  const emptyPlan = {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  };
  const partial = runReview(t, emptyPlan, {
    args: ["--json"],
    env: { AGENTIC_REVIEW_MAX_DIFF_BYTES: "1" },
    existingFixture: fixture,
    noState: false,
  });
  assert.equal(partial.result.status, 0, partial.result.stderr);
  assert.equal(partial.metadata.analysis_state, "inconclusive");
  const held = spawnSync(process.execPath, [localState, "export-open"], {
    cwd: fixture.repository,
    encoding: "utf8",
  });
  assert.equal(held.status, 0, held.stderr);
  assert.deepEqual(JSON.parse(held.stdout).findings.map(({ title }) => title), [blocker.title]);

  const complete = runReview(t, emptyPlan, {
    args: ["--json"],
    existingFixture: fixture,
    noState: false,
  });
  assert.equal(complete.result.status, 0, complete.result.stderr);
  assert.equal(complete.metadata.analysis_state, "complete");
  const retired = spawnSync(process.execPath, [localState, "export-open"], {
    cwd: fixture.repository,
    encoding: "utf8",
  });
  assert.equal(retired.status, 0, retired.stderr);
  assert.deepEqual(JSON.parse(retired.stdout), { findings: [] });
});


function diffFileOrder(prompt) {
  const diff = prompt.match(/## The diff\n\n```diff\n([\s\S]*?)\n```/);
  assert.ok(diff, "prompt must contain a diff block");
  return [...diff[1].matchAll(/^diff --git a\/(.+?) b\/.+$/gm)].map((match) => match[1]);
}

test("malformed output receives one retry and records the successful second attempt", (t) => {
  const recovered = finding("Recovered after retry");
  const run = runReview(t, {
    general: ["not json", { findings: [recovered] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  });

  assert.equal(run.result.status, 0, run.result.stderr);
  assert.deepEqual(
    run.logs.map(({ id, attempt }) => ({ id, attempt })),
    [
      { id: "general", attempt: 1 },
      { id: "general", attempt: 2 },
      { id: "correctness", attempt: 1 },
      { id: "boundaries", attempt: 1 },
    ],
  );
  assert.equal(run.metadata.passes.results[0].attempts, 2);
  assert.equal(run.metadata.passes.results[0].status, "valid");
  assert.deepEqual(run.findings.findings.map(({ title }) => title), [recovered.title]);
});

test("empty or whitespace finding identity fields exhaust the structured-output retry", (t) => {
  for (const [field, value] of [["file", "  "], ["title", ""], ["body", "\n\t"]]) {
    const invalid = finding(`Invalid ${field}`, { [field]: value });
    const run = runReview(t, {
      general: [{ findings: [invalid] }, { findings: [invalid] }],
      correctness: [{ findings: [] }],
      boundaries: [{ findings: [] }],
    });

    assert.equal(run.result.status, 0, `${field}: ${run.result.stderr}`);
    assert.deepEqual(
      run.metadata.passes.results.map(({ id, status, attempts }) => ({ id, status, attempts })),
      [
        { id: "general", status: "failed", attempts: 2 },
        { id: "correctness", status: "valid", attempts: 1 },
        { id: "boundaries", status: "valid", attempts: 1 },
      ],
    );
    assert.equal(run.metadata.analysis_state, "inconclusive");
    assert.deepEqual(run.findings.findings, []);
  }
});

test("a permanently malformed pass is failed while valid pass findings survive the union", (t) => {
  const general = finding("General survives");
  const boundaries = finding("Boundaries survives");
  const run = runReview(t, {
    general: [{ findings: [general] }],
    correctness: ["not json", "still not json"],
    boundaries: [{ findings: [boundaries] }],
  });

  assert.equal(run.result.status, 0, run.result.stderr);
  assert.deepEqual(run.metadata.passes.completed, ["general", "boundaries"]);
  assert.equal(run.metadata.analysis_state, "inconclusive");
  assert.equal(run.metadata.coverage, "unknown");
  assert.deepEqual(run.metadata.remaining_analysis, ["pass_failed"]);
  assert.deepEqual(
    run.metadata.passes.results.map(({ id, status, attempts, finding_count }) => ({
      id, status, attempts, finding_count,
    })),
    [
      { id: "general", status: "valid", attempts: 1, finding_count: 1 },
      { id: "correctness", status: "failed", attempts: 2, finding_count: 0 },
      { id: "boundaries", status: "valid", attempts: 1, finding_count: 1 },
    ],
  );
  assert.deepEqual(
    run.findings.findings.map(({ title }) => title).sort(),
    [boundaries.title, general.title],
  );
  assert.equal(validatePublication(run.publicationFile).status, 0);
});

test("all-pass failure writes validated findings and publication diagnostics before exiting nonzero", (t) => {
  const run = runReview(t, {
    general: ["bad", "bad again"],
    correctness: ["bad", "bad again"],
    boundaries: ["bad", "bad again"],
  });

  assert.notEqual(run.result.status, 0);
  assert.deepEqual(run.findings, { findings: [] });
  assert.deepEqual(run.publication.findings, []);
  assert.equal(run.metadata.analysis_state, "inconclusive");
  assert.equal(run.metadata.coverage, "unknown");
  assert.deepEqual(run.metadata.remaining_analysis, ["pass_failed", "execution_failed"]);
  assert.deepEqual(run.metadata.passes.completed, []);
  assert.deepEqual(
    run.metadata.passes.results.map(({ status, attempts, finding_count, capped }) => ({
      status, attempts, finding_count, capped,
    })),
    Array.from({ length: 3 }, () => ({
      status: "failed", attempts: 2, finding_count: 0, capped: false,
    })),
  );
  assert.equal(validatePublication(run.publicationFile).status, 0);
  assert.doesNotMatch(run.result.stdout, /No findings/);
});

test("a raw finding count equal to the nonzero cap is capped and inconclusive", (t) => {
  const run = runReview(t, {
    general: [{ findings: [finding("At cap")] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    env: { AGENTIC_REVIEW_MAX_FINDINGS: "1" },
  });

  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.metadata.analysis_state, "inconclusive");
  assert.equal(run.metadata.coverage, "unknown");
  assert.deepEqual(run.metadata.remaining_analysis, ["finding_cap_reached"]);
  assert.equal(run.metadata.finding_cap, 1);
  assert.deepEqual(
    run.metadata.passes.results.map(({ finding_count, capped }) => ({ finding_count, capped })),
    [
      { finding_count: 1, capped: true },
      { finding_count: 0, capped: false },
      { finding_count: 0, capped: false },
    ],
  );
  assert.equal(validatePublication(run.publicationFile).status, 0);
});

test("diff truncation is recorded and makes an otherwise valid run inconclusive", (t) => {
  const run = runReview(t, {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    env: { AGENTIC_REVIEW_MAX_DIFF_BYTES: "80" },
  });

  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.metadata.analysis_state, "inconclusive");
  assert.equal(run.metadata.coverage, "unknown");
  assert.deepEqual(run.metadata.remaining_analysis, ["diff_truncated"]);
  assert.equal(run.metadata.diff.truncated, true);
  assert.ok(run.metadata.diff.bytes > run.metadata.diff.included_bytes);
  assert.equal(run.metadata.diff.included_bytes, 80);
  const trustedDiffBytes = run.scope.bytes;
  assert.equal(run.scope.included_bytes, 80);
  const expectedFullDiff = execFileSync("git", ["diff", "--no-color", "main", "HEAD"], {
    cwd: run.repository,
  });
  assert.deepEqual(Buffer.from(run.scope.diff_base64, "base64"), expectedFullDiff);
  assert.equal(run.scope.bytes, expectedFullDiff.length);
  assert.deepEqual(run.metadata.diff, {
    bytes: trustedDiffBytes,
    included_bytes: run.scope.included_bytes,
    truncated: true,
  });
  assert.equal(validatePublication(run.publicationFile).status, 0);
});

test("diff metadata and canonical scope preserve the exact UTF-8 git diff bytes", (t) => {
  const run = runReview(t, {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    env: { AGENTIC_REVIEW_MAX_DIFF_BYTES: "0" },
    targetFiles: { "unicode.txt": `${"é".repeat(40)}\n` },
  });

  assert.equal(run.result.status, 0, run.result.stderr);
  const expectedDiff = execFileSync("git", ["diff", "--no-color", "main", "HEAD"], {
    cwd: run.repository,
  });
  assert.equal(expectedDiff.at(-1), 10);
  assert.deepEqual(Buffer.from(run.scope.diff_base64, "base64"), expectedDiff);
  assert.equal(run.scope.bytes, expectedDiff.length);
  assert.equal(run.metadata.diff.bytes, expectedDiff.length);
  assert.equal(run.metadata.diff.included_bytes, expectedDiff.length);
  assert.equal(validatePublication(run.publicationFile).status, 0);
});

test("scope hashes distinguish invalid UTF-8 diff bytes while the raw review run validates", (t) => {
  const run = runReview(t, {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    env: { AGENTIC_REVIEW_MAX_DIFF_BYTES: "0" },
    baseFiles: { "invalid-utf8.txt": Buffer.from([0x61, 0x80, 0x0a]) },
    targetFiles: { "invalid-utf8.txt": Buffer.from([0x62, 0x80, 0x0a]) },
  });

  assert.equal(run.result.status, 0, run.result.stderr);
  const expectedDiff = execFileSync("git", ["diff", "--no-color", "main", "HEAD"], {
    cwd: run.repository,
  });
  const collidingUnderUtf8Decode = Buffer.from(
    expectedDiff.map((byte) => byte === 0x80 ? 0x81 : byte),
  );
  assert.equal(expectedDiff.includes(0x80), true);
  assert.equal(expectedDiff.toString("utf8"), collidingUnderUtf8Decode.toString("utf8"));
  assert.deepEqual(Buffer.from(run.scope.diff_base64, "base64"), expectedDiff);
  assert.equal(run.scope.bytes, expectedDiff.length);
  assert.equal(run.scope.included_bytes, expectedDiff.length);
  assert.deepEqual(run.metadata.diff, {
    bytes: expectedDiff.length,
    included_bytes: expectedDiff.length,
    truncated: false,
  });
  const alternateScopeHash = scopeHash({
    base_sha: run.scope.base_sha,
    configuration_fingerprint: run.scope.configuration_fingerprint,
    diff_base64: collidingUnderUtf8Decode.toString("base64"),
    head_sha: run.scope.head_sha,
  });
  assert.notEqual(run.metadata.scope_hash, alternateScopeHash);
  assert.equal(Buffer.from(run.logs[0].prompt_base64, "base64").includes(expectedDiff), true);
  for (const log of run.logs) {
    assert.equal(Buffer.from(log.prompt_base64, "base64").includes(0x80), true);
  }
  assert.equal(run.metadata.analysis_state, "complete");
  assert.equal(run.metadata.coverage, "bounded");
  assert.equal(validatePublication(run.publicationFile).status, 0);
});


test("external diff and textconv helpers cannot replace trusted diff evidence", (t) => {
  const fixture = createFixture(t, {
    baseFiles: { ".gitattributes": "*.txt diff=empty\n" },
  });
  const externalDiff = join(fixture.directory, "empty-diff");
  const externalDiffLog = join(fixture.directory, "empty-diff.log");
  writeFileSync(externalDiff, `#!/usr/bin/env bash
touch "\${EXTERNAL_DIFF_LOG}"
exit 0
`);
  chmodSync(externalDiff, 0o755);
  git(fixture.repository, "config", "diff.external", externalDiff);
  const textconv = join(fixture.directory, "empty-textconv");
  const textconvLog = join(fixture.directory, "empty-textconv.log");
  writeFileSync(textconv, `#!/usr/bin/env bash
touch "\${TEXTCONV_LOG}"
exit 0
`);
  chmodSync(textconv, 0o755);
  git(fixture.repository, "config", "diff.empty.textconv", textconv);

  const run = runReview(t, {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    env: {
      EXTERNAL_DIFF_LOG: externalDiffLog,
      GIT_EXTERNAL_DIFF: externalDiff,
      TEXTCONV_LOG: textconvLog,
    },
    existingFixture: fixture,
    fakeCodegraph: true,
    untrackedCodegraph: true,
  });
  const expectedDiff = execFileSync(
    "git",
    ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "main", "HEAD"],
    { cwd: fixture.repository },
  );

  assert.ok(expectedDiff.length > 0);
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(existsSync(externalDiffLog), false);
  assert.equal(existsSync(textconvLog), false);
  assert.deepEqual(Buffer.from(run.scope.diff_base64, "base64"), expectedDiff);
  assert.equal(run.metadata.scope_hash, scopeHash({
    base_sha: run.scope.base_sha,
    configuration_fingerprint: run.scope.configuration_fingerprint,
    diff_base64: run.scope.diff_base64,
    head_sha: run.scope.head_sha,
  }));
  assert.equal(run.logs.length, 3);
  for (const log of run.logs) {
    assert.match(log.prompt, /\+alpha head/);
    assert.match(log.prompt, /\+beta head/);
    assert.match(log.prompt, /\+gamma head/);
  }
  assert.ok(run.codegraphLogs.some(({ operation }) => operation === "query"));
  assert.equal(validatePublication(run.publicationFile).status, 0);
});

test("canonical diff rendering failures stop before model work", (t) => {
  const fixture = createFixture(t);
  const gitWrapper = join(fixture.bin, "git");
  writeFileSync(gitWrapper, `#!/usr/bin/env bash
if [ "\${1:-}" = "diff" ]; then
  for argument in "$@"; do
    [ "$argument" = "--no-color" ] && exit 73
  done
fi
PATH="\${PATH#*:}" exec git "$@"
`);
  chmodSync(gitWrapper, 0o755);

  const run = runReview(t, {}, {
    existingFixture: fixture,
    includeOutputs: false,
  });

  assert.notEqual(run.result.status, 0);
  assert.match(run.result.stderr, /could not render canonical diff/);
  assert.equal(run.logs.length, 0);
});

test("each pass receives the complete available diff in deterministic rotated file order", (t) => {
  const run = runReview(t, {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  });

  assert.equal(run.result.status, 0, run.result.stderr);
  assert.deepEqual(run.logs.map(({ prompt }) => diffFileOrder(prompt)), [
    ["alpha.txt", "beta.txt", "gamma.txt"],
    ["beta.txt", "gamma.txt", "alpha.txt"],
    ["gamma.txt", "alpha.txt", "beta.txt"],
  ]);
});

test("every rotated pass includes deletions and unusual filenames", (t) => {
  const unusualPath = "odd name\nline.txt";
  const run = runReview(t, {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    baseFiles: {
      "deleted file.txt": "DELETE_ME\n",
      [unusualPath]: "unusual base\n",
    },
    targetFiles: { [unusualPath]: "unusual head\n" },
    deleteFiles: ["deleted file.txt"],
  });

  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.logs.length, 3);
  for (const { prompt } of run.logs) {
    assert.match(prompt, /-DELETE_ME/);
    assert.match(prompt, /\+unusual head/);
  }
});

test("concurrent runners atomically publish findings, metadata, and scope for one run", async (t) => {
  const fixture = createFixture(t);
  const findingsFile = join(fixture.directory, "shared-findings.json");
  const publicationFile = join(fixture.directory, "shared-publication.json");
  const gateFile = join(fixture.directory, "publication-a-ready");
  const releaseFile = join(fixture.directory, "release-publication-a");
  const preload = join(fixture.directory, "gate-publication-rename.cjs");
  writeFileSync(preload, `
const fs = require("node:fs");
const originalRenameSync = fs.renameSync;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
fs.renameSync = (from, to) => {
  if (process.env.PUBLICATION_RUN === "a" && to === process.env.PUBLICATION_OUT) {
    fs.writeFileSync(process.env.PUBLICATION_GATE, "");
    while (!fs.existsSync(process.env.PUBLICATION_RELEASE)) {
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }
  return originalRenameSync(from, to);
};
`);

  const start = (name) => {
    const state = join(fixture.directory, `state-${name}`);
    const log = join(fixture.directory, `omp-${name}.log`);
    const planFile = join(fixture.directory, `plan-${name}.json`);
    writeFileSync(planFile, JSON.stringify({
      general: [{ findings: [finding(`Publication ${name.toUpperCase()} finding`)] }],
      correctness: [{ findings: [] }],
      boundaries: [{ findings: [] }],
    }));
    mkdirSync(state);
    const child = spawn("bash", [
      runner,
      "--base", "main",
      "--model", `openrouter/example-${name}`,
      "--no-codegraph",
      "--no-state",
      "--no-fail",
      "--out", findingsFile,
      "--publication-out", publicationFile,
      "--json",
    ], {
      cwd: fixture.repository,
      env: {
        ...process.env,
        OPENROUTER_API_KEY: "sk-or-runner-test",
        PATH: `${fixture.bin}:${process.env.PATH}`,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${preload}`.trim(),
        FAKE_OMP_PLAN: planFile,
        FAKE_OMP_LOG: log,
        FAKE_OMP_STATE: state,
        PUBLICATION_GATE: gateFile,
        PUBLICATION_OUT: publicationFile,
        PUBLICATION_RELEASE: releaseFile,
        PUBLICATION_RUN: name,
      },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.resume();
    return {
      child,
      done: once(child, "close").then(([status]) => ({ status, stderr })),
    };
  };

  const render = (name, publication) => {
    const snapshot = join(fixture.directory, `publication-${name}.json`);
    writeFileSync(snapshot, JSON.stringify(publication));
    return spawnSync(process.execPath, [poster], {
      encoding: "utf8",
      env: {
        ...process.env,
        HEAD_SHA: publication.metadata.head_sha,
        REVIEW_PUBLICATION_FILE: snapshot,
        RENDER: "1",
        REVIEW_MODE: "summary",
      },
    });
  };

  const first = start("a");
  for (let attempt = 0; attempt < 1000 && !existsSync(gateFile); attempt += 1) {
    await delay(10);
  }
  assert.equal(existsSync(gateFile), true, "first runner did not reach publication gate");

  const second = start("b");
  const secondResult = await second.done;
  const secondBytes = existsSync(publicationFile)
    ? readFileSync(publicationFile, "utf8")
    : null;
  const secondValidation = secondBytes === null ? null : validatePublication(publicationFile);

  writeFileSync(releaseFile, "");
  const firstResult = await first.done;
  assert.equal(secondResult.status, 0, secondResult.stderr);
  assert.notEqual(secondBytes, null, "second runner did not publish an evidence set");
  assert.equal(secondValidation.status, 0, secondValidation.stderr);
  const secondPublication = JSON.parse(secondBytes);
  assert.equal(firstResult.status, 0, firstResult.stderr);
  const firstPublication = JSON.parse(readFileSync(publicationFile, "utf8"));
  const standaloneFindings = JSON.parse(readFileSync(findingsFile, "utf8")).findings;

  const firstValidation = validatePublication(publicationFile);
  assert.equal(firstValidation.status, 0, firstValidation.stderr);
  assert.notEqual(
    firstPublication.metadata.configuration_fingerprint,
    secondPublication.metadata.configuration_fingerprint,
  );
  assert.equal(firstPublication.findings[0].title, "Publication A finding");
  assert.equal(secondPublication.findings[0].title, "Publication B finding");
  assert.equal(
    standaloneFindings[0].title,
    "Publication B finding",
    "the schedule must leave the human-readable output from a different run",
  );
  for (const publication of [secondPublication, firstPublication]) {
    assert.equal(
      publication.metadata.configuration_fingerprint,
      publication.scope.configuration_fingerprint,
    );
    assert.equal(
      publication.metadata.scope_hash,
      deriveTrustedScopeMetadata(publication.scope).scope_hash,
    );
  }

  const renderedSecond = render("b", secondPublication);
  assert.equal(renderedSecond.status, 0, renderedSecond.stderr);
  assert.match(renderedSecond.stdout, /Publication B finding/);
  assert.doesNotMatch(renderedSecond.stdout, /Publication A finding/);
  const renderedFirst = render("a", firstPublication);
  assert.equal(renderedFirst.status, 0, renderedFirst.stderr);
  assert.match(renderedFirst.stdout, /Publication A finding/);
  assert.doesNotMatch(renderedFirst.stdout, /Publication B finding/);
});

test("findings and publication destinations cannot resolve to the same file", (t) => {
  const plan = {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  };
  const dotAlias = runReview(t, plan, {
    outputPaths: ({ directory }) => ({
      findingsFile: join(directory, "same.json"),
      publicationFile: `${directory}/./same.json`,
    }),
  });
  assert.notEqual(dotAlias.result.status, 0);
  assert.equal(dotAlias.logs.length, 0);
  assert.match(dotAlias.result.stderr, /--out.*--publication-out|same destination/);

  const symlinkAlias = runReview(t, plan, {
    outputPaths: ({ directory }) => {
      const realDirectory = join(directory, "real-output");
      const aliasDirectory = join(directory, "alias-output");
      mkdirSync(realDirectory);
      symlinkSync(realDirectory, aliasDirectory, "dir");
      return {
        findingsFile: join(realDirectory, "result.json"),
        publicationFile: join(aliasDirectory, "result.json"),
      };
    },
  });
  assert.notEqual(symlinkAlias.result.status, 0);
  assert.equal(symlinkAlias.logs.length, 0);
  assert.match(symlinkAlias.result.stderr, /--out.*--publication-out|same destination/);
});

test("symlink artifact destinations are rejected before model work without replacing outputs", (t) => {
  const plan = {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  };
  for (const selected of ["findings", "publication"]) {
    let staleTarget;
    let otherOutput;
    const stale = selected === "findings"
      ? '{"findings":[{"title":"stale"}]}\n'
      : '{"analysis_state":"stale"}\n';
    const run = runReview(t, plan, {
      outputPaths: ({ directory, findingsFile, publicationFile }) => {
        staleTarget = join(directory, `${selected}-stale-target.json`);
        writeFileSync(staleTarget, stale);
        const symlink = join(directory, `${selected}-artifact.json`);
        symlinkSync(staleTarget, symlink);
        otherOutput = selected === "findings" ? publicationFile : findingsFile;
        return selected === "findings"
          ? { findingsFile: symlink, publicationFile }
          : { findingsFile, publicationFile: symlink };
      },
    });

    assert.notEqual(run.result.status, 0, `${selected}: ${run.result.stderr}`);
    assert.equal(run.logs.length, 0, selected);
    const selectedOutput = selected === "findings"
      ? run.findingsFile
      : run.publicationFile;
    assert.equal(lstatSync(selectedOutput).isSymbolicLink(), true);
    assert.equal(readFileSync(staleTarget, "utf8"), stale);
    assert.equal(existsSync(otherOutput), false, `${selected}: other artifact was partially written`);
    assert.match(
      run.result.stderr,
      /symlink.*(?:--out|--publication-out)|(?:--out|--publication-out).*symlink/i,
    );
  }
});

test("publication staging never follows a predictable user-destination temp symlink", (t) => {
  const plan = {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  };
  let victim;
  let publicationDestination;
  let bashEnv;
  const stale = "operator-owned data\n";
  const run = runReview(t, plan, {
    outputPaths: ({ directory, findingsFile, publicationFile }) => {
      victim = join(directory, "temp-symlink-victim");
      publicationDestination = publicationFile;
      bashEnv = join(directory, "attack-bash-env");
      writeFileSync(victim, stale);
      writeFileSync(bashEnv, [
        'if [ ! -e "$ATTACK_MARKER" ]; then',
        '  : > "$ATTACK_MARKER"',
        '  ln -s -- "$ATTACK_VICTIM" "$ATTACK_PUBLICATION.tmp.$$"',
        "fi",
        "",
      ].join("\n"));
      return { findingsFile, publicationFile };
    },
    env: {
      get BASH_ENV() { return bashEnv; },
      get ATTACK_MARKER() { return `${bashEnv}.ran`; },
      get ATTACK_PUBLICATION() { return publicationDestination; },
      get ATTACK_VICTIM() { return victim; },
    },
  });

  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(readFileSync(victim, "utf8"), stale);
  assert.equal(lstatSync(run.publicationFile).isSymbolicLink(), false);
  assert.equal(validatePublication(run.publicationFile).status, 0);
});

test("branch and staged reviews stay pinned when the source changes after worktree creation", (t) => {
  const plan = {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  };
  for (const mode of ["branch", "staged"]) {
    const run = runReview(t, plan, {
      staged: mode === "staged",
      mutateAfterWorktree: mode,
    });

    assert.equal(run.result.status, 0, `${mode}: ${run.result.stderr}`);
    assert.ok(run.logs.every(({ reviewedAlpha }) => reviewedAlpha === "alpha head\n"));
    assert.ok(run.logs.every(({ prompt }) => prompt.includes("+alpha head")));
    assert.ok(run.logs.every(({ prompt }) => !prompt.includes("late head")));
    assert.ok(run.logs.every(({ prompt }) => !prompt.includes("late concurrent head")));
    if (mode === "branch") {
      assert.equal(run.metadata.head_sha, run.headSha);
      assert.notEqual(git(run.repository, "rev-parse", "HEAD"), run.headSha);
    } else {
      assert.equal(git(run.repository, "show", `${run.metadata.head_sha}:alpha.txt`), "alpha head");
      assert.equal(git(run.repository, "show", ":alpha.txt"), "late head");
    }
  }
});

test("staged review uses an internal synthetic commit without configured Git identity", (t) => {
  const fixture = createFixture(t, { staged: true });
  git(fixture.repository, "config", "--local", "--unset-all", "user.name");
  git(fixture.repository, "config", "--local", "--unset-all", "user.email");
  const gitConfigHome = join(fixture.directory, "git-config-home");
  const xdgConfigHome = join(gitConfigHome, "xdg");
  mkdirSync(xdgConfigHome, { recursive: true });
  const identitylessEnv = {
    HOME: gitConfigHome,
    XDG_CONFIG_HOME: xdgConfigHome,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(gitConfigHome, "global-config"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "user.useConfigOnly",
    GIT_CONFIG_VALUE_0: "true",
    GIT_AUTHOR_NAME: "",
    GIT_AUTHOR_EMAIL: "",
    GIT_COMMITTER_NAME: "",
    GIT_COMMITTER_EMAIL: "",
  };
  for (const key of ["user.name", "user.email"]) {
    const configured = spawnSync("git", ["config", "--get", key], {
      cwd: fixture.repository,
      encoding: "utf8",
      env: { ...process.env, ...identitylessEnv },
    });
    assert.equal(configured.status, 1, `${key} unexpectedly configured: ${configured.stdout}`);
  }
  const localConfigBefore = git(fixture.repository, "config", "--local", "--list");
  const refsBefore = git(
    fixture.repository,
    "for-each-ref",
    "--format=%(refname) %(objectname)",
  );

  const run = runReview(t, {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    env: identitylessEnv,
    existingFixture: fixture,
    staged: true,
  });

  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.logs.length, 3);
  assert.equal(git(run.repository, "rev-parse", "HEAD"), fixture.baseSha);
  assert.equal(
    git(run.repository, "show", "-s", "--format=%an|%ae|%cn|%ce", run.metadata.head_sha),
    "agentic-review|agentic-review@localhost|agentic-review|agentic-review@localhost",
  );
  assert.equal(
    git(run.repository, "for-each-ref", "--format=%(refname)", "--contains", run.metadata.head_sha),
    "",
    "synthetic staged commit must not be published through a Git ref",
  );
  assert.equal(
    git(run.repository, "for-each-ref", "--format=%(refname) %(objectname)"),
    refsBefore,
  );
  assert.equal(
    git(run.repository, "config", "--local", "--list"),
    localConfigBefore,
    "staged review must not persist synthetic commit identity",
  );
});

test("staged review state keeps its synthetic target reachable for later reconciliation", (t) => {
  const reported = finding("Fixed staged defect", {
    file: "alpha.txt",
    start_line: 1,
    end_line: 1,
  });
  const first = runReview(t, {
    general: [{ findings: [reported] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    args: [],
    staged: true,
    noState: false,
  });
  assert.equal(first.result.status, 0, first.result.stderr);

  const statePath = join(first.repository, ".git", "agentic-review", "state.json");
  const [stored] = JSON.parse(readFileSync(statePath, "utf8")).findings;
  assert.equal(stored.lastCommit, first.metadata.head_sha);
  assert.equal(stored.stagedTarget, true);
  assert.notEqual(stored.lastCommit, git(first.repository, "rev-parse", "HEAD"));
  const retainingRefs = git(
    first.repository,
    "for-each-ref",
    "--format=%(refname)",
    "--contains",
    stored.lastCommit,
  ).split("\n").filter(Boolean);
  assert.ok(retainingRefs.length > 0, "stored staged target must have a durable Git ref");

  git(first.repository, "reflog", "expire", "--expire=now", "--all");
  git(first.repository, "prune", "--expire=now");
  const retainedTarget = spawnSync(
    "git",
    ["cat-file", "-e", `${stored.lastCommit}^{commit}`],
    { cwd: first.repository, encoding: "utf8" },
  );
  assert.equal(retainedTarget.status, 0, "stored staged target must survive Git pruning");

  writeFileSync(join(first.repository, "alpha.txt"), "alpha fixed\n");
  git(first.repository, "add", "alpha.txt");
  const fixed = runReview(t, {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    args: [],
    existingFixture: first,
    staged: true,
    noState: false,
  });

  assert.equal(fixed.result.status, 0, fixed.result.stderr);
  assert.match(fixed.result.stdout, /\| Sample \| `clean` \|/);
  const [retired] = JSON.parse(readFileSync(statePath, "utf8")).findings;
  assert.equal(retired.status, "gone");
  assert.equal(retired.stagedTarget, true);
});

test("concurrent local-state updates cannot prune a staged ref owned by final state", async (t) => {
  const fixture = createFixture(t);
  const head = git(fixture.repository, "rev-parse", "HEAD");
  const stagedTarget = git(
    fixture.repository,
    "commit-tree",
    `${head}^{tree}`,
    "-p",
    head,
    "-m",
    "synthetic staged target",
  );
  const ordinaryFinding = finding("Concurrent ordinary finding", { file: "beta.txt" });
  const stagedFinding = finding("Concurrent staged finding", { file: "alpha.txt" });
  const ordinaryFile = join(fixture.directory, "ordinary-findings.json");
  const stagedFile = join(fixture.directory, "staged-findings.json");
  writeFileSync(ordinaryFile, JSON.stringify({ findings: [ordinaryFinding] }));
  writeFileSync(stagedFile, JSON.stringify({ findings: [stagedFinding] }));

  const wrapper = join(fixture.bin, "git");
  const firstPruneReady = join(fixture.directory, "first-prune-ready");
  const releaseFirstPrune = join(fixture.directory, "release-first-prune");
  const secondStarted = join(fixture.directory, "second-started");
  const secondPruneReady = join(fixture.directory, "second-prune-ready");
  writeFileSync(wrapper, `#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (
  process.env.PROCESS_READY
  && args[0] === "rev-parse"
  && args[1] === "--git-common-dir"
) writeFileSync(process.env.PROCESS_READY, "ready");
if (
  process.env.PRUNE_READY
  && args[0] === "for-each-ref"
  && args.at(-1) === "${stagedTargetRefPrefix}"
) {
  writeFileSync(process.env.PRUNE_READY, "ready");
  while (process.env.RELEASE_PRUNE && !existsSync(process.env.RELEASE_PRUNE)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
const result = spawnSync("git", args, {
  encoding: "utf8",
  env: { ...process.env, PATH: process.env.REAL_GIT_PATH },
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`);
  chmodSync(wrapper, 0o755);

  const commonEnv = {
    ...process.env,
    PATH: `${fixture.bin}:${process.env.PATH}`,
    REAL_GIT_PATH: process.env.PATH,
  };
  const firstProcess = spawn(
    process.execPath,
    [localState, "record", ordinaryFile, fixture.baseSha, head, "inconclusive"],
    {
      cwd: fixture.repository,
      env: {
        ...commonEnv,
        PRUNE_READY: firstPruneReady,
        RELEASE_PRUNE: releaseFirstPrune,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const firstDone = once(firstProcess, "close");
  let firstError = "";
  firstProcess.stderr.setEncoding("utf8");
  firstProcess.stderr.on("data", (chunk) => { firstError += chunk; });
  t.after(() => { if (firstProcess.exitCode === null) firstProcess.kill("SIGKILL"); });

  const firstDeadline = Date.now() + 5_000;
  while (!existsSync(firstPruneReady)) {
    assert.equal(firstProcess.exitCode, null, firstError);
    assert.ok(Date.now() < firstDeadline, "first process did not reach staged-ref pruning");
    await delay(10);
  }
  const readWhileLocked = spawnSync(process.execPath, [localState, "export-open"], {
    cwd: fixture.repository,
    encoding: "utf8",
  });
  assert.equal(readWhileLocked.status, 0, readWhileLocked.stderr);
  assert.deepEqual(
    JSON.parse(readWhileLocked.stdout).findings.map(({ title }) => title),
    [ordinaryFinding.title],
    "read-only commands remain available while a mutation owns the lock",
  );

  const secondProcess = spawn(
    process.execPath,
    [localState, "record", stagedFile, fixture.baseSha, stagedTarget, "inconclusive"],
    {
      cwd: fixture.repository,
      env: {
        ...commonEnv,
        AGENTIC_REVIEW_STAGED_TARGET: stagedTarget,
        PROCESS_READY: secondStarted,
        PRUNE_READY: secondPruneReady,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const secondDone = once(secondProcess, "close");
  let secondError = "";
  secondProcess.stderr.setEncoding("utf8");
  secondProcess.stderr.on("data", (chunk) => { secondError += chunk; });
  t.after(() => { if (secondProcess.exitCode === null) secondProcess.kill("SIGKILL"); });

  const secondDeadline = Date.now() + 5_000;
  while (!existsSync(secondStarted)) {
    assert.equal(secondProcess.exitCode, null, secondError);
    assert.ok(Date.now() < secondDeadline, "second process did not start its state update");
    await delay(10);
  }
  const lockPath = join(fixture.repository, ".git", "agentic-review", "state.lock");
  if (existsSync(lockPath)) {
    await delay(50);
  } else {
    while (!existsSync(secondPruneReady)) {
      assert.equal(secondProcess.exitCode, null, secondError);
      assert.ok(Date.now() < secondDeadline, "second process did not reach staged-ref pruning");
      await delay(10);
    }
  }
  writeFileSync(releaseFirstPrune, "release");

  const [[firstStatus], [secondStatus]] = await Promise.all([firstDone, secondDone]);
  assert.equal(firstStatus, 0, firstError);
  assert.equal(secondStatus, 0, secondError);
  const state = JSON.parse(readFileSync(
    join(fixture.repository, ".git", "agentic-review", "state.json"),
    "utf8",
  ));
  const stored = state.findings.find(({ title }) => title === stagedFinding.title);
  assert.ok(stored, "the final state must retain the staged finding");
  assert.equal(stored.status, "open");
  assert.equal(stored.stagedTarget, true);
  assert.equal(stored.lastCommit, stagedTarget);
  assert.equal(
    git(fixture.repository, "rev-parse", `${stagedTargetRefPrefix}${stagedTarget}`),
    stagedTarget,
  );
  assert.equal(existsSync(lockPath), false, "successful mutations must release the state lock");
});

test("lock-free state readers see complete snapshots while JSON files are published", async (t) => {
  for (const publication of ["state", "run"]) {
    const fixture = createFixture(t);
    const head = git(fixture.repository, "rev-parse", "HEAD");
    const baselineFinding = finding(`Baseline ${publication} publication finding`, { file: "alpha.txt" });
    const replacementFinding = finding(`Replacement ${publication} publication finding`, { file: "beta.txt" });
    const baselineFile = join(fixture.directory, "baseline-findings.json");
    const replacementFile = join(fixture.directory, "replacement-findings.json");
    const epoch = 1_755_600_000_000;
    writeFileSync(baselineFile, JSON.stringify({ findings: [baselineFinding] }));
    writeFileSync(replacementFile, JSON.stringify({ findings: [replacementFinding] }));

    const baseline = spawnSync(
      process.execPath,
      [localState, "record", baselineFile, fixture.baseSha, head, "inconclusive"],
      {
        cwd: fixture.repository,
        encoding: "utf8",
        env: { ...process.env, RUN_EPOCH: String(epoch) },
      },
    );
    assert.equal(baseline.status, 0, baseline.stderr);

    const stateDirectory = join(fixture.repository, ".git", "agentic-review");
    const statePath = join(stateDirectory, "state.json");
    const stamp = new Date(epoch).toISOString().replace(/[:.]/g, "-");
    const runPrefix = join(stateDirectory, "runs", stamp);
    const publicationPath = publication === "state" ? statePath : runPrefix;
    const ready = join(fixture.directory, `${publication}-publication-ready`);
    const release = join(fixture.directory, `${publication}-publication-release`);
    const preload = join(fixture.directory, `${publication}-publication.cjs`);
    writeFileSync(preload, `
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const { resolve } = require("node:path");
const originalCloseSync = fs.closeSync;
const originalExistsSync = fs.existsSync;
const originalOpenSync = fs.openSync;
const originalRenameSync = fs.renameSync;
const originalWriteFileSync = fs.writeFileSync;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const target = resolve(process.env.PUBLICATION_PATH);
const samePath = (path) => {
  if (typeof path !== "string") return false;
  const resolved = resolve(path);
  return process.env.PUBLICATION_IS_RUN === "1"
    ? resolved.startsWith(target + "~") && resolved.endsWith(".json")
    : resolved === target;
};
const holdPublication = () => {
  originalWriteFileSync(process.env.PUBLICATION_READY, "ready");
  while (!originalExistsSync(process.env.PUBLICATION_RELEASE)) {
    Atomics.wait(sleeper, 0, 0, 10);
  }
};
fs.writeFileSync = (path, ...args) => {
  if (samePath(path)) {
    originalCloseSync(originalOpenSync(path, "w"));
    holdPublication();
  }
  return originalWriteFileSync(path, ...args);
};
fs.renameSync = (from, to) => {
  if (
    samePath(to)
    && typeof from === "string"
    && typeof to === "string"
    && resolve(from).startsWith(resolve(to) + ".pending-")
  ) holdPublication();
  return originalRenameSync(from, to);
};
syncBuiltinESMExports();
`);

    const writer = spawn(
      process.execPath,
      [localState, "record", replacementFile, fixture.baseSha, head, "inconclusive"],
      {
        cwd: fixture.repository,
        env: {
          ...process.env,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${preload}`.trim(),
          PUBLICATION_PATH: publicationPath,
          PUBLICATION_READY: ready,
          PUBLICATION_IS_RUN: publication === "run" ? "1" : "0",
          PUBLICATION_RELEASE: release,
          RUN_EPOCH: String(epoch),
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    const writerDone = once(writer, "close");
    let writerError = "";
    writer.stderr.setEncoding("utf8");
    writer.stderr.on("data", (chunk) => { writerError += chunk; });
    t.after(() => { if (writer.exitCode === null) writer.kill("SIGKILL"); });

    const deadline = Date.now() + 5_000;
    while (!existsSync(ready)) {
      assert.equal(writer.exitCode, null, writerError);
      assert.ok(Date.now() < deadline, `${publication} writer did not reach publication`);
      await delay(10);
    }

    const exported = spawnSync(process.execPath, [localState, "export-open"], {
      cwd: fixture.repository,
      encoding: "utf8",
    });
    const listed = spawnSync(process.execPath, [localState, "list"], {
      cwd: fixture.repository,
      encoding: "utf8",
    });
    const runs = spawnSync(process.execPath, [localState, "runs"], {
      cwd: fixture.repository,
      encoding: "utf8",
    });
    assert.equal(exported.status, 0, `${publication}: ${exported.stderr}`);
    assert.deepEqual(
      JSON.parse(exported.stdout).findings.map(({ title }) => title),
      [baselineFinding.title],
      `${publication}: export-open must read the prior complete state snapshot`,
    );
    assert.equal(listed.status, 0, `${publication}: ${listed.stderr}`);
    assert.match(listed.stdout, new RegExp(baselineFinding.title));
    assert.doesNotMatch(listed.stdout, new RegExp(replacementFinding.title));
    assert.equal(runs.status, 0, `${publication}: ${runs.stderr}`);
    assert.match(runs.stdout, /1 findings/);

    writeFileSync(release, "release");
    const [writerStatus] = await writerDone;
    assert.equal(writerStatus, 0, writerError);
  }
});

test("a stale lock is reclaimed when its PID belongs to a newer process instance", (t) => {
  const fixture = createFixture(t);
  const head = git(fixture.repository, "rev-parse", "HEAD");
  const reported = finding("PID reuse finding", { file: "alpha.txt" });
  const findingsFile = join(fixture.directory, "pid-reuse-findings.json");
  writeFileSync(findingsFile, JSON.stringify({ findings: [reported] }));
  const recorded = spawnSync(
    process.execPath,
    [localState, "record", findingsFile, fixture.baseSha, head, "inconclusive"],
    { cwd: fixture.repository, encoding: "utf8" },
  );
  assert.equal(recorded.status, 0, recorded.stderr);

  const stateDirectory = join(fixture.repository, ".git", "agentic-review");
  const statePath = join(stateDirectory, "state.json");
  const lockPath = join(stateDirectory, "state.lock");
  const [stored] = JSON.parse(readFileSync(statePath, "utf8")).findings;
  mkdirSync(lockPath);
  writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
    pid: process.pid,
    token: "reused-pid-owner",
    processIdentity: "a different process instance",
  }));
  const preload = join(fixture.directory, "pid-reuse-timeout.cjs");
  writeFileSync(preload, `
const realNow = Date.now;
let calls = 0;
Date.now = () => realNow() + (calls++ === 0 ? 0 : 60_000);
`);

  const dismissed = spawnSync(process.execPath, [localState, "dismiss", stored.id], {
    cwd: fixture.repository,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${preload}`.trim(),
    },
  });
  assert.equal(dismissed.status, 0, dismissed.stderr);
  assert.equal(existsSync(lockPath), false);
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).findings[0].status, "dismissed");
});

test("a creator cannot mutate after an ownerless lock is reaped during publication", async (t) => {
  const fixture = createFixture(t);
  const head = git(fixture.repository, "rev-parse", "HEAD");
  const creatorFile = join(fixture.directory, "creator-findings.json");
  const reaperFile = join(fixture.directory, "reaper-findings.json");
  const creatorFinding = finding("Creator publication finding", { file: "alpha.txt" });
  const reaperFinding = finding("Reaper replacement finding", { file: "beta.txt" });
  writeFileSync(creatorFile, JSON.stringify({ findings: [creatorFinding] }));
  writeFileSync(reaperFile, JSON.stringify({ findings: [reaperFinding] }));

  const lockPath = join(fixture.repository, ".git", "agentic-review", "state.lock");
  const ownerPath = join(lockPath, "owner.json");
  const runsPath = join(fixture.repository, ".git", "agentic-review", "runs");
  const creatorReady = join(fixture.directory, "creator-ready");
  const reaperReady = join(fixture.directory, "reaper-ready");
  const creatorOwnerPublished = join(fixture.directory, "creator-owner-published");
  const creatorRetried = join(fixture.directory, "creator-retried");
  const creatorActionStarted = join(fixture.directory, "creator-action-started");
  const replacementOwnerPublished = join(fixture.directory, "replacement-owner-published");
  const releaseReplacement = join(fixture.directory, "release-replacement");
  const creatorPreload = join(fixture.directory, "creator-lock-race.cjs");
  const reaperPreload = join(fixture.directory, "reaper-lock-race.cjs");

  writeFileSync(creatorPreload, `
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const { resolve } = require("node:path");
const originalExistsSync = fs.existsSync;
const originalMkdirSync = fs.mkdirSync;
const originalRenameSync = fs.renameSync;
const originalWriteFileSync = fs.writeFileSync;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const samePath = (left, right) => typeof left === "string" && resolve(left) === resolve(right);
const pendingLockPrefix = resolve(process.env.LOCK_PATH) + ".pending-";
const isCreatedLock = (path) => (
  samePath(path, process.env.LOCK_PATH)
  || (typeof path === "string" && resolve(path).startsWith(pendingLockPrefix))
);
const isOwner = (path) => (
  samePath(path, process.env.OWNER_PATH)
  || (
    typeof path === "string"
    && resolve(path).startsWith(pendingLockPrefix)
    && resolve(path).endsWith("/owner.json")
  )
);
const waitFor = (path) => {
  while (!originalExistsSync(path)) Atomics.wait(sleeper, 0, 0, 10);
};
let lockMkdirAttempts = 0;
fs.mkdirSync = (path, ...args) => {
  if (isCreatedLock(path)) {
    lockMkdirAttempts += 1;
    if (lockMkdirAttempts > 1) originalWriteFileSync(process.env.CREATOR_RETRIED, "retried");
  }
  const result = originalMkdirSync(path, ...args);
  if (isCreatedLock(path) && lockMkdirAttempts === 1) {
    originalWriteFileSync(process.env.CREATOR_READY, "ready");
    waitFor(process.env.REAPER_READY);
  }
  return result;
};
fs.existsSync = (path) => {
  const result = originalExistsSync(path);
  if (
    result
    && samePath(path, process.env.LOCK_PATH)
    && originalExistsSync(process.env.REPLACEMENT_OWNER_PUBLISHED)
  ) originalWriteFileSync(process.env.CREATOR_RETRIED, "retried");
  return result;
};
fs.renameSync = (from, to) => {
  if (
    samePath(to, process.env.LOCK_PATH)
    && originalExistsSync(process.env.REPLACEMENT_OWNER_PUBLISHED)
  ) originalWriteFileSync(process.env.CREATOR_RETRIED, "retried");
  return originalRenameSync(from, to);
};
fs.writeFileSync = (path, ...args) => {
  const result = originalWriteFileSync(path, ...args);
  if (isOwner(path) && !originalExistsSync(process.env.CREATOR_OWNER_PUBLISHED)) {
    originalWriteFileSync(process.env.CREATOR_OWNER_PUBLISHED, "published");
    waitFor(process.env.REPLACEMENT_OWNER_PUBLISHED);
  }
  if (
    typeof path === "string"
    && resolve(path).startsWith(resolve(process.env.RUNS_PATH) + "/")
    && !originalExistsSync(process.env.CREATOR_ACTION_STARTED)
  ) originalWriteFileSync(process.env.CREATOR_ACTION_STARTED, "started");
  return result;
};
syncBuiltinESMExports();
`);
  writeFileSync(reaperPreload, `
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const { resolve } = require("node:path");
const originalExistsSync = fs.existsSync;
const originalRenameSync = fs.renameSync;
const originalRmSync = fs.rmSync;
const originalWriteFileSync = fs.writeFileSync;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const samePath = (left, right) => typeof left === "string" && resolve(left) === resolve(right);
const contenderAdvanced = () => (
  originalExistsSync(process.env.CREATOR_OWNER_PUBLISHED)
  || originalExistsSync(process.env.CREATOR_RETRIED)
);
const holdReplacement = () => {
  originalWriteFileSync(process.env.REPLACEMENT_OWNER_PUBLISHED, "published");
  while (!originalExistsSync(process.env.RELEASE_REPLACEMENT)) {
    Atomics.wait(sleeper, 0, 0, 10);
  }
};
fs.renameSync = (from, to) => {
  const result = originalRenameSync(from, to);
  if (
    samePath(to, process.env.LOCK_PATH)
    && !originalExistsSync(process.env.REPLACEMENT_OWNER_PUBLISHED)
  ) {
    originalWriteFileSync(process.env.REAPER_READY, "ready");
    holdReplacement();
  }
  return result;
};
fs.rmSync = (path, ...args) => {
  if (samePath(path, process.env.LOCK_PATH) && !originalExistsSync(process.env.REAPER_READY)) {
    originalWriteFileSync(process.env.REAPER_READY, "ready");
    while (!contenderAdvanced()) Atomics.wait(sleeper, 0, 0, 10);
  }
  return originalRmSync(path, ...args);
};
fs.writeFileSync = (path, ...args) => {
  const result = originalWriteFileSync(path, ...args);
  if (
    samePath(path, process.env.OWNER_PATH)
    && originalExistsSync(process.env.REAPER_READY)
    && !originalExistsSync(process.env.REPLACEMENT_OWNER_PUBLISHED)
  ) holdReplacement();
  return result;
};
syncBuiltinESMExports();
`);

  const raceEnv = {
    ...process.env,
    LOCK_PATH: lockPath,
    OWNER_PATH: ownerPath,
    RUNS_PATH: runsPath,
    CREATOR_READY: creatorReady,
    REAPER_READY: reaperReady,
    CREATOR_OWNER_PUBLISHED: creatorOwnerPublished,
    CREATOR_RETRIED: creatorRetried,
    CREATOR_ACTION_STARTED: creatorActionStarted,
    REPLACEMENT_OWNER_PUBLISHED: replacementOwnerPublished,
    RELEASE_REPLACEMENT: releaseReplacement,
  };
  const creator = spawn(
    process.execPath,
    [localState, "record", creatorFile, fixture.baseSha, head, "inconclusive"],
    {
      cwd: fixture.repository,
      env: {
        ...raceEnv,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${creatorPreload}`.trim(),
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const creatorDone = once(creator, "close");
  let creatorError = "";
  creator.stderr.setEncoding("utf8");
  creator.stderr.on("data", (chunk) => { creatorError += chunk; });
  t.after(() => { if (creator.exitCode === null) creator.kill("SIGKILL"); });

  const creatorReadyDeadline = Date.now() + 5_000;
  while (!existsSync(creatorReady)) {
    assert.equal(creator.exitCode, null, creatorError);
    assert.ok(Date.now() < creatorReadyDeadline, "creator did not pause after creating the lock directory");
    await delay(10);
  }
  if (existsSync(lockPath)) utimesSync(lockPath, new Date(0), new Date(0));

  const reaper = spawn(
    process.execPath,
    [localState, "record", reaperFile, fixture.baseSha, head, "inconclusive"],
    {
      cwd: fixture.repository,
      env: {
        ...raceEnv,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${reaperPreload}`.trim(),
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const reaperDone = once(reaper, "close");
  let reaperError = "";
  reaper.stderr.setEncoding("utf8");
  reaper.stderr.on("data", (chunk) => { reaperError += chunk; });
  t.after(() => { if (reaper.exitCode === null) reaper.kill("SIGKILL"); });

  const replacementDeadline = Date.now() + 5_000;
  while (!existsSync(replacementOwnerPublished)) {
    assert.equal(creator.exitCode, null, creatorError);
    assert.equal(reaper.exitCode, null, reaperError);
    assert.ok(Date.now() < replacementDeadline, "reaper did not publish its replacement lock owner");
    await delay(10);
  }
  while (!existsSync(creatorRetried) && !existsSync(creatorActionStarted)) {
    assert.equal(creator.exitCode, null, creatorError);
    assert.ok(Date.now() < replacementDeadline, "creator neither retried acquisition nor entered mutation");
    await delay(10);
  }

  assert.equal(
    existsSync(creatorActionStarted),
    false,
    "creator must not enter mutation after its lock directory was replaced",
  );
  assert.equal(existsSync(creatorRetried), true, "creator must retry acquisition after losing publication");
  assert.equal(
    JSON.parse(readFileSync(ownerPath, "utf8")).pid,
    reaper.pid,
    "losing creator must not remove the replacement owner's lock",
  );
  writeFileSync(releaseReplacement, "release");

  const [[creatorStatus], [reaperStatus]] = await Promise.all([creatorDone, reaperDone]);
  assert.equal(creatorStatus, 0, creatorError);
  assert.equal(reaperStatus, 0, reaperError);
  assert.equal(existsSync(creatorActionStarted), true, "creator must mutate after acquiring a later lock");
  assert.equal(existsSync(lockPath), false, "both serialized mutations must release the state lock");
  const titles = JSON.parse(readFileSync(
    join(fixture.repository, ".git", "agentic-review", "state.json"),
    "utf8",
  )).findings.map(({ title }) => title).sort();
  assert.deepEqual(titles, [creatorFinding.title, reaperFinding.title].sort());
});

test("ordinary gone findings can reopen after their historical commit is pruned", (t) => {
  const reported = finding("Reopened branch defect", {
    file: "alpha.txt",
    start_line: 1,
    end_line: 1,
  });
  const first = runReview(t, {
    general: [{ findings: [reported] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    args: [],
    noState: false,
  });
  assert.equal(first.result.status, 0, first.result.stderr);

  const statePath = join(first.repository, ".git", "agentic-review", "state.json");
  const [stored] = JSON.parse(readFileSync(statePath, "utf8")).findings;
  assert.equal(stored.stagedTarget, false);

  writeFileSync(join(first.repository, "alpha.txt"), "alpha fixed\n");
  git(first.repository, "add", "alpha.txt");
  git(first.repository, "commit", "-m", "fix ordinary finding");
  const fixed = runReview(t, {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    args: [],
    existingFixture: first,
    noState: false,
  });
  assert.equal(fixed.result.status, 0, fixed.result.stderr);
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).findings[0].status, "gone");

  git(first.repository, "reset", "--hard", first.baseSha);
  writeFileSync(join(first.repository, "alpha.txt"), "replacement history\n");
  git(first.repository, "add", "alpha.txt");
  git(first.repository, "commit", "-m", "replace ordinary history");
  git(first.repository, "reflog", "expire", "--expire=now", "--all");
  git(first.repository, "prune", "--expire=now");
  const unavailableHistory = spawnSync(
    "git",
    ["cat-file", "-e", `${stored.lastCommit}^{commit}`],
    { cwd: first.repository, encoding: "utf8" },
  );
  assert.notEqual(unavailableHistory.status, 0, "ordinary historical commit must be pruned");

  const reopened = spawnSync(process.execPath, [localState, "reopen", stored.id], {
    cwd: first.repository,
    encoding: "utf8",
  });
  assert.equal(reopened.status, 0, reopened.stderr);
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).findings[0].status, "open");
  const stagedTarget = spawnSync(
    "git",
    ["show-ref", "--verify", "--quiet", `${stagedTargetRefPrefix}${stored.lastCommit}`],
    { cwd: first.repository, encoding: "utf8" },
  );
  assert.notEqual(stagedTarget.status, 0, "ordinary history must not gain a staged-target ref");
});

test("reopening a gone staged finding restores ownership before later pruning", (t) => {
  const reported = finding("Reopened staged defect", {
    file: "alpha.txt",
    start_line: 1,
    end_line: 1,
  });
  const first = runReview(t, {
    general: [{ findings: [reported] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    args: [],
    staged: true,
    noState: false,
  });
  assert.equal(first.result.status, 0, first.result.stderr);

  const statePath = join(first.repository, ".git", "agentic-review", "state.json");
  const [stored] = JSON.parse(readFileSync(statePath, "utf8")).findings;
  assert.equal(stored.stagedTarget, true);
  const stagedTargetRef = `${stagedTargetRefPrefix}${stored.lastCommit}`;
  const temporaryRef = "refs/agentic-review/test-reopen-target";
  git(first.repository, "update-ref", temporaryRef, stored.lastCommit);

  writeFileSync(join(first.repository, "alpha.txt"), "alpha fixed\n");
  git(first.repository, "add", "alpha.txt");
  const fixed = runReview(t, {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    args: [],
    existingFixture: first,
    staged: true,
    noState: false,
  });
  assert.equal(fixed.result.status, 0, fixed.result.stderr);

  const [gone] = JSON.parse(readFileSync(statePath, "utf8")).findings;
  assert.equal(gone.status, "gone");
  assert.equal(gone.stagedTarget, true);
  assert.equal(git(first.repository, "rev-parse", temporaryRef), stored.lastCommit);
  const released = spawnSync(
    "git",
    ["show-ref", "--verify", "--quiet", stagedTargetRef],
    { cwd: first.repository, encoding: "utf8" },
  );
  assert.notEqual(released.status, 0, "gone staged finding must release its private ref");

  const reopened = spawnSync(process.execPath, [localState, "reopen", stored.id], {
    cwd: first.repository,
    encoding: "utf8",
  });
  assert.equal(reopened.status, 0, reopened.stderr);
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).findings[0].status, "open");
  assert.equal(git(first.repository, "rev-parse", stagedTargetRef), stored.lastCommit);

  git(first.repository, "update-ref", "-d", temporaryRef);
  git(first.repository, "reflog", "expire", "--expire=now", "--all");
  git(first.repository, "prune", "--expire=now");
  const retainedTarget = spawnSync(
    "git",
    ["cat-file", "-e", `${stored.lastCommit}^{commit}`],
    { cwd: first.repository, encoding: "utf8" },
  );
  assert.equal(retainedTarget.status, 0, "reopened staged target must survive Git pruning");
});

test("unavailable staged targets block reopen atomically but not dismissal", (t) => {
  const reported = finding("Unavailable staged defect", {
    file: "alpha.txt",
    start_line: 1,
    end_line: 1,
  });
  const first = runReview(t, {
    general: [{ findings: [reported] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    args: [],
    staged: true,
    noState: false,
  });
  assert.equal(first.result.status, 0, first.result.stderr);

  const statePath = join(first.repository, ".git", "agentic-review", "state.json");
  const [stored] = JSON.parse(readFileSync(statePath, "utf8")).findings;
  assert.equal(stored.stagedTarget, true);
  const stagedTargetRef = `${stagedTargetRefPrefix}${stored.lastCommit}`;

  writeFileSync(join(first.repository, "alpha.txt"), "alpha fixed\n");
  git(first.repository, "add", "alpha.txt");
  const fixed = runReview(t, {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    args: [],
    existingFixture: first,
    staged: true,
    noState: false,
  });
  assert.equal(fixed.result.status, 0, fixed.result.stderr);
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).findings[0].status, "gone");
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).findings[0].stagedTarget, true);
  const released = spawnSync(
    "git",
    ["show-ref", "--verify", "--quiet", stagedTargetRef],
    { cwd: first.repository, encoding: "utf8" },
  );
  assert.notEqual(released.status, 0, "gone staged finding must release its private ref");

  git(first.repository, "reflog", "expire", "--expire=now", "--all");
  git(first.repository, "prune", "--expire=now");
  const unavailableTarget = spawnSync(
    "git",
    ["cat-file", "-e", `${stored.lastCommit}^{commit}`],
    { cwd: first.repository, encoding: "utf8" },
  );
  assert.notEqual(unavailableTarget.status, 0, "pruning must make the released target unavailable");
  const goneState = readFileSync(statePath, "utf8");

  const reopened = spawnSync(process.execPath, [localState, "reopen", stored.id], {
    cwd: first.repository,
    encoding: "utf8",
  });
  assert.notEqual(reopened.status, 0, "reopen must fail when its target cannot be retained");
  assert.equal(readFileSync(statePath, "utf8"), goneState);
  const lockPath = join(first.repository, ".git", "agentic-review", "state.lock");
  assert.equal(existsSync(lockPath), false, "failed mutations must release the state lock");
  const exitedOwner = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(exitedOwner.status, 0);
  mkdirSync(lockPath);
  writeFileSync(
    join(lockPath, "owner.json"),
    JSON.stringify({ pid: exitedOwner.pid, token: "exited-test-owner" }),
  );

  const dismissed = spawnSync(process.execPath, [localState, "dismiss", stored.id], {
    cwd: first.repository,
    encoding: "utf8",
  });
  assert.equal(dismissed.status, 0, dismissed.stderr);
  assert.equal(existsSync(lockPath), false, "the next mutation must reclaim the stale state lock");
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).findings[0].status, "dismissed");
  const retained = spawnSync(
    "git",
    ["show-ref", "--verify", "--quiet", stagedTargetRef],
    { cwd: first.repository, encoding: "utf8" },
  );
  assert.notEqual(retained.status, 0, "dismissing a gone finding must not retain its target");
});

test("multi-ID reopen validates every gone staged target before mutating state or refs", (t) => {
  const reachableFinding = finding("Reachable staged defect", {
    file: "alpha.txt",
    start_line: 1,
    end_line: 1,
  });
  const first = runReview(t, {
    general: [{ findings: [reachableFinding] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    args: [],
    staged: true,
    noState: false,
  });
  assert.equal(first.result.status, 0, first.result.stderr);

  const statePath = join(first.repository, ".git", "agentic-review", "state.json");
  const reachableTarget = first.metadata.head_sha;
  const temporaryRef = "refs/agentic-review/test-multi-reopen-target";
  git(first.repository, "update-ref", temporaryRef, reachableTarget);

  writeFileSync(join(first.repository, "alpha.txt"), "alpha fixed\n");
  writeFileSync(join(first.repository, "beta.txt"), "beta second defect\n");
  git(first.repository, "add", "alpha.txt", "beta.txt");
  const prunedFinding = finding("Pruned staged defect", {
    file: "beta.txt",
    start_line: 1,
    end_line: 1,
  });
  const second = runReview(t, {
    general: [{ findings: [prunedFinding] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    args: [],
    existingFixture: first,
    staged: true,
    noState: false,
  });
  assert.equal(second.result.status, 0, second.result.stderr);
  const prunedTarget = second.metadata.head_sha;
  assert.notEqual(prunedTarget, reachableTarget);

  writeFileSync(join(first.repository, "beta.txt"), "beta fixed\n");
  git(first.repository, "add", "beta.txt");
  const retired = runReview(t, {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    args: [],
    existingFixture: first,
    staged: true,
    noState: false,
  });
  assert.equal(retired.result.status, 0, retired.result.stderr);

  const goneFindings = JSON.parse(readFileSync(statePath, "utf8")).findings;
  const reachable = goneFindings.find(({ title }) => title === reachableFinding.title);
  const pruned = goneFindings.find(({ title }) => title === prunedFinding.title);
  assert.equal(reachable.status, "gone");
  assert.equal(reachable.stagedTarget, true);
  assert.equal(reachable.lastCommit, reachableTarget);
  assert.equal(pruned.status, "gone");
  assert.equal(pruned.stagedTarget, true);
  assert.equal(pruned.lastCommit, prunedTarget);

  git(first.repository, "reflog", "expire", "--expire=now", "--all");
  git(first.repository, "prune", "--expire=now");
  const reachableObject = spawnSync(
    "git",
    ["cat-file", "-e", `${reachableTarget}^{commit}`],
    { cwd: first.repository, encoding: "utf8" },
  );
  assert.equal(reachableObject.status, 0, "the first target must remain available for partial mutation");
  const unavailableObject = spawnSync(
    "git",
    ["cat-file", "-e", `${prunedTarget}^{commit}`],
    { cwd: first.repository, encoding: "utf8" },
  );
  assert.notEqual(unavailableObject.status, 0, "the later target must be pruned");

  const stateBefore = readFileSync(statePath);
  const refsBefore = git(
    first.repository,
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    stagedTargetRefPrefix,
  );
  const reopened = spawnSync(
    process.execPath,
    [localState, "reopen", reachable.id, pruned.id],
    { cwd: first.repository, encoding: "utf8" },
  );

  assert.notEqual(reopened.status, 0, "one unavailable target must fail the whole reopen");
  assert.deepEqual(readFileSync(statePath), stateBefore);
  assert.equal(git(
    first.repository,
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    stagedTargetRefPrefix,
  ), refsBefore);
});

test("legacy live-checkout fallback is explicitly mutable and inconclusive", (t) => {
  const run = runReview(t, {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    failWorktree: true,
  });

  assert.equal(run.result.status, 0, run.result.stderr);
  assert.ok(run.logs.every(({ cwd }) => cwd === run.repository));
  assert.equal(run.metadata.snapshot_immutable, false);
  assert.equal(run.metadata.analysis_state, "inconclusive");
  assert.equal(run.metadata.coverage, "unknown");
  assert.deepEqual(run.metadata.remaining_analysis, ["snapshot_mutable"]);
  assert.equal(validatePublication(run.publicationFile).status, 0);
});

test("codegraph context comes only from the pinned review snapshot", (t) => {
  const run = runReview(t, {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    baseFiles: { "codegraph.json": "{\"trusted\":\"base\"}\n" },
    targetFiles: { "codegraph.json": "{\"untrusted\":\"target\"}\n" },
    fakeCodegraph: true,
    untrackedCodegraph: true,
    mutateAfterWorktree: "branch-codegraph",
  });

  assert.equal(run.result.status, 0, run.result.stderr);
  const initializations = run.codegraphLogs.filter(({ operation }) => operation === "init");
  const queries = run.codegraphLogs.filter(({ operation }) => operation === "query");
  assert.equal(initializations.length, 1);
  assert.equal(initializations[0].project, run.logs[0].cwd);
  assert.notEqual(initializations[0].project, run.repository);
  assert.equal(initializations[0].source, "alpha head");
  assert.equal(initializations[0].config, "{\"trusted\":\"base\"}");
  for (const { reviewedCodegraph } of run.logs) {
    assert.deepEqual(
      reviewedCodegraph,
      { type: "file", contents: "{\"untrusted\":\"target\"}\n" },
    );
  }
  assert.ok(queries.length > 0);
  assert.ok(queries.every(({ project }) => project === run.logs[0].cwd));
  assert.ok(queries.every(({ marker }) => marker === "INDEX:alpha head"));
  assert.ok(run.logs.every(({ prompt }) => prompt.includes("INDEX:alpha head")));
  assert.ok(run.logs.every(({ prompt }) => !prompt.includes("LIVE_INDEX_MUTATION")));
  assert.equal(
    readFileSync(join(run.repository, ".codegraph", "source-marker"), "utf8"),
    "LIVE_INDEX_MUTATION\n",
  );
});

test("codegraph context is generated once and reused after the CLI changes between calls", (t) => {
  const run = runReview(t, {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    fakeCodegraph: true,
    untrackedCodegraph: true,
    env: {
      FAKE_CODEGRAPH_QUERY_MODE: "first-only",
      FAKE_CODEGRAPH_VERSION: "fake-codegraph 7.1.0",
    },
  });

  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.codegraphLogs.filter(({ operation }) => operation === "version").length, 1);
  assert.equal(run.codegraphLogs.filter(({ operation }) => operation === "query").length, 3);
  const contexts = run.logs.map(({ prompt }) =>
    prompt.match(/## Symbol and dependency index[\s\S]*?(?=\nReply with)/)?.[0] ?? null);
  assert.ok(contexts.every(Boolean));
  assert.equal(new Set(contexts).size, 1);
});

test("codegraph readiness, frozen context, and selected version affect the configuration fingerprint", (t) => {
  const plan = {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  };
  const run = (context, version, extraEnv = {}) => runReview(t, plan, {
    fakeCodegraph: true,
    untrackedCodegraph: true,
    env: {
      FAKE_CODEGRAPH_CONTEXT: context,
      FAKE_CODEGRAPH_VERSION: version,
      ...extraEnv,
    },
  });
  const first = run("CONTEXT_ALPHA", "fake-codegraph 7.1.0");
  const changedContext = run("CONTEXT_BETA", "fake-codegraph 7.1.0");
  const changedVersion = run("CONTEXT_ALPHA", "fake-codegraph 7.2.0");
  const unavailable = run("CONTEXT_ALPHA", "fake-codegraph 7.1.0", {
    FAKE_CODEGRAPH_INIT_FAIL: "1",
  });

  for (const result of [first, changedContext, changedVersion, unavailable]) {
    assert.equal(result.result.status, 0, result.result.stderr);
  }
  assert.notEqual(first.metadata.configuration_fingerprint, changedContext.metadata.configuration_fingerprint);
  assert.notEqual(first.metadata.configuration_fingerprint, changedVersion.metadata.configuration_fingerprint);
  assert.notEqual(first.metadata.configuration_fingerprint, unavailable.metadata.configuration_fingerprint);
  assert.ok(unavailable.logs.every(({ prompt }) => !prompt.includes("CONTEXT_ALPHA")));
});

test("OMP sees the exact target codegraph config after base-trusted snapshot indexing", async (t) => {
  const plan = {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  };
  const scenarios = [
    {
      name: "target addition",
      targetFiles: { "codegraph.json": "{\"target\":\"added\"}\n" },
      expectedInit: null,
      expectedTarget: { type: "file", contents: "{\"target\":\"added\"}\n" },
    },
    {
      name: "target deletion",
      baseFiles: { "codegraph.json": "{\"trusted\":\"base\"}\n" },
      deleteFiles: ["codegraph.json"],
      expectedInit: "{\"trusted\":\"base\"}",
      expectedTarget: { type: "absent" },
    },
    {
      name: "target symlink",
      baseFiles: { "codegraph.json": "{\"trusted\":\"base\"}\n" },
      targetFiles: { "target-codegraph.json": "{\"target\":\"linked\"}\n" },
      targetSymlinks: { "codegraph.json": "target-codegraph.json" },
      expectedInit: "{\"trusted\":\"base\"}",
      expectedTarget: {
        type: "symlink",
        target: "target-codegraph.json",
        contents: "{\"target\":\"linked\"}\n",
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, (t) => {
      const run = runReview(t, plan, {
        baseFiles: scenario.baseFiles,
        targetFiles: scenario.targetFiles,
        deleteFiles: scenario.deleteFiles,
        targetSymlinks: scenario.targetSymlinks,
        fakeCodegraph: true,
        untrackedCodegraph: true,
      });

      assert.equal(run.result.status, 0, run.result.stderr);
      const initializations = run.codegraphLogs.filter(({ operation }) => operation === "init");
      assert.equal(initializations.length, 1);
      assert.equal(initializations[0].config, scenario.expectedInit);
      for (const { reviewedCodegraph } of run.logs) {
        assert.deepEqual(reviewedCodegraph, scenario.expectedTarget);
      }
    });
  }
});

test("codegraph snapshot initialization failure omits optional context without failing review", (t) => {
  const run = runReview(t, {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    baseFiles: { "codegraph.json": "{\"trusted\":\"base\"}\n" },
    targetFiles: { "codegraph.json": "{\"target\":\"after-failure\"}\n" },
    fakeCodegraph: true,
    untrackedCodegraph: true,
    env: { FAKE_CODEGRAPH_INIT_FAIL: "1" },
  });

  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.metadata.analysis_state, "complete");
  const initializations = run.codegraphLogs.filter(({ operation }) => operation === "init");
  assert.equal(initializations.length, 1);
  assert.equal(initializations[0].config, "{\"trusted\":\"base\"}");
  assert.equal(run.codegraphLogs.filter(({ operation }) => operation === "query").length, 0);
  assert.ok(run.logs.every(({ prompt }) => !prompt.includes("# Snapshot symbol index")));
  for (const { reviewedCodegraph } of run.logs) {
    assert.deepEqual(
      reviewedCodegraph,
      { type: "file", contents: "{\"target\":\"after-failure\"}\n" },
    );
  }
});

test("summary, inline, and suggest all ask OMP for the structured JSON contract", (t) => {
  for (const mode of ["summary", "inline", "suggest"]) {
    const run = runReview(t, {
      general: [{ findings: [] }],
      correctness: [{ findings: [] }],
      boundaries: [{ findings: [] }],
    }, {
      args: ["--review-mode", mode, "--json"],
    });

    assert.equal(run.result.status, 0, `${mode}: ${run.result.stderr}`);
    assert.deepEqual(JSON.parse(run.result.stdout), run.findings);
    for (const { prompt } of run.logs) {
      assert.match(prompt, /Output a single JSON object and nothing else/);
      assert.match(prompt, /Reply with the single JSON object described above/);
      assert.doesNotMatch(prompt, /Reply with the markdown described above/);
    }
  }
});

test("trusted relative data ignores the reviewed tree, never falls back to it, and permits absolute overrides", (t) => {
  const executableProbeDirectory = mkdtempSync(join(tmpdir(), "review-exec-probe-"));
  t.after(() => rmSync(executableProbeDirectory, { recursive: true, force: true }));
  const executableProbe = join(executableProbeDirectory, "executed");
  const malicious = runReview(t, {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    env: {
      AGENTIC_REVIEW_TRUSTED_DATA_ROOT: trustedRoot,
      MALICIOUS_EXEC_MARKER: executableProbe,
    },
    targetFiles: {
      "review/lenses/boundaries.md": "# This pass: boundaries\\nMALICIOUS_TARGET_LENS\\n",
      "scripts/review-result.mjs": "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.MALICIOUS_EXEC_MARKER, 'executed');\\n",
    },
  });
  assert.equal(malicious.result.status, 0, malicious.result.stderr);
  const boundaryPrompt = malicious.logs.find(
    ({ prompt }) => prompt.includes("Prioritize concrete failures at component seams"),
  )?.prompt;
  assert.ok(boundaryPrompt, "the trusted boundary lens is present in exactly one pass");
  assert.equal(boundaryPrompt.match(/MALICIOUS_TARGET_LENS/g)?.length, 1, "target lens appears only as reviewed diff data");
  assert.equal(existsSync(executableProbe), false, "executable helpers remain anchored to SELF_ROOT");

  const missing = runReview(t, {}, {
    args: ["--prompt", "target-only-prompt.md", "--json"],
    env: { AGENTIC_REVIEW_TRUSTED_DATA_ROOT: trustedRoot },
    targetFiles: { "target-only-prompt.md": "TARGET_ONLY_PROMPT\\n" },
    includeOutputs: false,
  });
  assert.notEqual(missing.result.status, 0);
  assert.equal(missing.logs.length, 0);
  assert.match(missing.result.stderr, /no review instructions/);

  const absoluteDirectory = mkdtempSync(join(tmpdir(), "absolute-review-prompt-"));
  t.after(() => rmSync(absoluteDirectory, { recursive: true, force: true }));
  const absolutePrompt = join(absoluteDirectory, "prompt.md");
  writeFileSync(absolutePrompt, "ABSOLUTE_PROMPT_MARKER\\n");
  const absolute = runReview(t, {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    args: ["--prompt", absolutePrompt, "--json"],
    env: { AGENTIC_REVIEW_TRUSTED_DATA_ROOT: trustedRoot },
  });
  assert.equal(absolute.result.status, 0, absolute.result.stderr);
  assert.ok(absolute.logs.every(({ prompt }) => prompt.includes("ABSOLUTE_PROMPT_MARKER")));
});

test("legacy relative project data and local state remain available unless explicitly disabled", (t) => {
  const run = runReview(t, {
    general: [{ findings: [finding("Stored finding")] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    args: ["--prompt", "project-prompt.md", "--json"],
    targetFiles: { "project-prompt.md": "PROJECT_PROMPT_MARKER\\n" },
    noState: false,
    publicationViaEnv: true,
  });

  assert.equal(run.result.status, 0, run.result.stderr);
  assert.ok(run.logs.every(({ prompt }) => prompt.includes("PROJECT_PROMPT_MARKER")));
  assert.ok(existsSync(join(run.repository, ".git", "agentic-review", "state.json")));
  assert.equal(validatePublication(run.publicationFile).status, 0);
});

test("configuration fingerprint is shared before passes and excludes credentials", (t) => {
  const plan = {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  };
  const first = runReview(t, plan, {
    env: { OPENROUTER_API_KEY: "sk-or-first-credential" },
  });
  const second = runReview(t, plan, {
    env: { OPENROUTER_API_KEY: "sk-or-second-credential" },
  });

  assert.equal(first.result.status, 0, first.result.stderr);
  assert.equal(second.result.status, 0, second.result.stderr);
  assert.equal(first.metadata.configuration_fingerprint, second.metadata.configuration_fingerprint);
  assert.equal(new Set(first.metadata.passes.results.map(
    ({ configuration_fingerprint }) => configuration_fingerprint,
  )).size, 1);
});

test("advanced pass and lens overrides produce finite descriptors with stable unique ids", (t) => {
  const run = runReview(t, {
    general: [{ findings: [] }, { findings: [] }],
    security: [{ findings: [] }],
    docs: [{ findings: [] }],
  }, {
    args: ["--passes", "2", "--lenses", "security,docs", "--json"],
  });

  const noSkillDeclaration = runReview(t, {
    general: [{ findings: [] }],
    "empty-skills": [{ findings: [] }],
  }, {
    args: ["--passes", "1", "--lenses", "empty-skills", "--json"],
    targetFiles: {
      "review/lenses/empty-skills.md": "# This pass: empty skills\n\nNo optional skills are needed.\n",
    },
  });
  assert.equal(noSkillDeclaration.result.status, 0, noSkillDeclaration.result.stderr);
  assert.deepEqual(noSkillDeclaration.logs.map(({ id }) => id), ["general", "general"]);

  assert.equal(run.result.status, 0, run.result.stderr);
  assert.deepEqual(run.logs.map(({ id }) => id), ["general", "general", "security", "docs"]);
  assert.deepEqual(run.metadata.passes.requested, ["general", "general-2", "security", "docs"]);
  assert.deepEqual(run.metadata.passes.completed, run.metadata.passes.requested);

  const invalid = runReview(t, {}, {
    args: ["--passes", "Infinity", "--json"],
    includeOutputs: false,
  });
  assert.notEqual(invalid.result.status, 0);
  assert.equal(invalid.logs.length, 0);
  assert.match(invalid.result.stderr, /--passes/);
});

test("min-votes filtering cannot hide one-pass blocking evidence or report convergence", (t) => {
  const blocker = finding("Single-pass blocker", { severity: "High" });
  const run = runReview(t, {
    general: [{ findings: [blocker] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    args: ["--min-votes", "2", "--json"],
  });

  assert.equal(run.result.status, 0, run.result.stderr);
  assert.deepEqual(run.findings.findings.map(({ title }) => title), [blocker.title]);
  assert.equal(run.metadata.analysis_state, "inconclusive");
  assert.equal(run.metadata.min_votes, 2);
  assert.equal(run.metadata.merge_succeeded, true);
  assert.deepEqual(run.metadata.remaining_analysis, ["vote_threshold_applied"]);
  assert.equal(validatePublication(run.publicationFile).status, 0);
  const rendered = spawnSync(process.execPath, [poster], {
    encoding: "utf8",
    env: {
      ...process.env,
      HEAD_SHA: run.headSha,
      REVIEW_PUBLICATION_FILE: run.publicationFile,
      RENDER: "1",
      REVIEW_MODE: "inline",
      FAIL_ON_FINDINGS: "true",
    },
  });
  assert.notEqual(rendered.status, 0);
  assert.match(rendered.stdout, /\| Analysis \| `inconclusive` \|/);
  assert.match(rendered.stdout, /\| Merge gate \| `blocked` \|/);
  assert.match(rendered.stdout, /\| Bounded convergence \| `no` \|/);
  assert.match(rendered.stdout, /\| Coverage \| `unknown` \|/);
  assert.match(rendered.stdout, /\| Remaining analysis \| `\["vote_threshold_applied"\]` \|/);
  assert.match(rendered.stdout, /\| Converged \| `false` \|/);
  assert.match(rendered.stdout, /Single-pass blocker/);
});

test("merge failure preserves a structured valid-pass artifact but is never complete", (t) => {
  const general = finding("Available general result");
  const run = runReview(t, {
    general: [{ findings: [general] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    failMerge: true,
  });

  assert.equal(run.result.status, 0, run.result.stderr);
  assert.deepEqual(run.findings.findings.map(({ title }) => title), [general.title]);
  assert.equal(run.metadata.analysis_state, "inconclusive");
  assert.equal(run.metadata.merge_succeeded, false);
  assert.equal(run.metadata.coverage, "unknown");
  assert.deepEqual(run.metadata.remaining_analysis, ["merge_failed"]);
  assert.equal(validatePublication(run.publicationFile).status, 0);
});
