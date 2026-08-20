import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const runner = fileURLToPath(new URL("./run-review.sh", import.meta.url));
const resultCli = fileURLToPath(new URL("./review-result.mjs", import.meta.url));
const localState = fileURLToPath(new URL("./local-state.mjs", import.meta.url));
const poster = fileURLToPath(new URL("./post-review.mjs", import.meta.url));
const workflow = fileURLToPath(new URL("../.github/workflows/agentic-review.yml", import.meta.url));
const installer = fileURLToPath(new URL("./install-review.sh", import.meta.url));
const trustedRoot = dirname(dirname(runner));

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
const prompt = readFileSync(promptPath, "utf8");
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
  metadataViaEnv = false,
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
  let metadataFile = join(fixture.directory, "metadata.json");
  if (outputPaths) {
    ({ findingsFile, metadataFile } = outputPaths({
      ...fixture,
      findingsFile,
      metadataFile,
    }));
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
          ...(metadataViaEnv ? [] : ["--metadata-out", metadataFile]),
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
      AGENTIC_REVIEW_METADATA_OUT: "",
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
      ...(metadataViaEnv ? { AGENTIC_REVIEW_METADATA_OUT: metadataFile } : {}),
      ...env,
    },
  });
  const logs = existsSync(logFile)
    ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    : [];
  const codegraphLogs = existsSync(codegraphLogFile)
    ? readFileSync(codegraphLogFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    : [];
  return {
    ...fixture,
    result,
    logs,
    codegraphLogs,
    findingsFile,
    metadataFile,
    bunxLogFile,
    findings: existsSync(findingsFile) ? JSON.parse(readFileSync(findingsFile, "utf8")) : null,
    metadata: existsSync(metadataFile) ? JSON.parse(readFileSync(metadataFile, "utf8")) : null,
  };
}

function validateMetadata(metadataFile) {
  return spawnSync(process.execPath, [resultCli, "validate", metadataFile], { encoding: "utf8" });
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
  for (const pass of run.metadata.passes.results) {
    assert.equal(pass.base_sha, run.baseSha);
    assert.equal(pass.head_sha, run.headSha);
    assert.equal(pass.configuration_fingerprint, run.metadata.configuration_fingerprint);
    assert.equal(pass.status, "valid");
    assert.equal(pass.attempts, 1);
    assert.equal(pass.capped, false);
  }
  const validation = validateMetadata(run.metadataFile);
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
  assert.match(source, /- name: post review[\s\S]*?\n\s+if: always\(\)/);
  assert.match(source, /\/tmp\/review-result\.json/);
});

test("early hosted setup failure still emits conservative reusable-workflow outputs", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hosted-finalizer-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const outputFile = join(directory, "github-output");
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
    UNTRUSTED_POSTER_MARKER: untrustedPosterMarker,
  };
  for (const name of [
    "TRUSTED_DATA_ROOT",
    "REVIEW_RUNNER",
    "REVIEW_STRIPPER",
    "REVIEW_POSTER",
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

  assert.equal(finalized.status, 0, finalized.stderr);
  assert.equal(existsSync(untrustedPosterMarker), false);
  const outputs = envFileValues(outputFile);
  assert.equal(outputs.analysis_state, "inconclusive");
  assert.equal(outputs.sample_state, "unknown");
  assert.equal(outputs.bounded_converged, "false");
  assert.equal(outputs.coverage, "unknown");
  assert.equal(outputs.converged, "false");

  const source = readFileSync(workflow, "utf8");
  for (const field of ["analysis_state", "sample_state", "bounded_converged", "coverage", "converged"]) {
    assert.match(source, new RegExp(`^        value: \\$\\{\\{ jobs\\.review\\.outputs\\.${field} \\}\\}`, "m"));
    assert.match(source, new RegExp(`^      ${field}: \\$\\{\\{ steps\\.poster\\.outputs\\.${field} \\}\\}`, "m"));
  }
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
  const metadataFile = "/tmp/review-meta.json";
  const runnerOutFile = "/tmp/review-runner.out";
  const runnerErrFile = "/tmp/review-runner.err";
  for (const path of [findingsFile, metadataFile, runnerOutFile, runnerErrFile]) {
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
  const findings = JSON.parse(readFileSync(findingsFile, "utf8"));
  const metadata = JSON.parse(readFileSync(metadataFile, "utf8"));
  assert.equal(logs.length, 3);
  assert.deepEqual(logs.map(({ id }) => id), ["general", "correctness", "boundaries"]);
  assert.ok(logs.every(({ attempt }) => attempt === 1));
  assert.ok(logs.every(({ argv }) => argv.includes("--print-thoughts")));
  assert.ok(logs.every(({ prompt }) => prompt.includes("Output a single JSON object and nothing else")));
  assert.ok(logs.every(({ prompt }) => !prompt.split("## Changed files", 1)[0].includes(targetDataMarker)));
  assert.ok(logs.every(({ skill }) => !skill.includes(targetDataMarker)));
  assert.equal(existsSync(maliciousExecutableMarker), false);
  assert.equal(existsSync(findingsFile), true);
  assert.equal(existsSync(metadataFile), true);
  assert.deepEqual(metadata.passes.requested, ["general", "correctness", "boundaries"]);
  assert.deepEqual(metadata.passes.completed, ["general", "correctness", "boundaries"]);
  assert.equal(metadata.analysis_state, "complete");
  assert.equal(metadata.reviewed_head, fixture.headSha);
  assert.match(metadata.scope_hash, /^[a-f0-9]{64}$/);
  assert.equal(metadata.coverage, "bounded");
  assert.deepEqual(metadata.remaining_analysis, []);
  assert.deepEqual(
    findings.findings.map(({ title }) => title).sort(),
    ["Correctness hosted defect", "Shared hosted defect"],
  );
  assert.equal(findings.findings.find(({ title }) => title === shared.title).votes, 2);

  const githubLogFile = join(fixture.directory, "github.log");
  const posterCallsFile = join(fixture.directory, "poster-calls.log");
  const outputFile = join(fixture.directory, "poster-output");
  const summaryFile = join(fixture.directory, "poster-summary");
  const preloadFile = join(fixture.directory, "fake-github.mjs");
  writeFileSync(preloadFile, `
import { appendFileSync } from "node:fs";
appendFileSync(process.env.FAKE_POSTER_CALLS, "poster\\n");
globalThis.fetch = async (url, options = {}) => {
  const method = options.method ?? "GET";
  const body = String(options.body ?? "");
  appendFileSync(process.env.FAKE_GITHUB_LOG, JSON.stringify({ url: String(url), method, body }) + "\\n");
  if (String(url).endsWith("/graphql") && body.includes("viewer")) {
    return { ok: true, status: 200, json: async () => ({ data: { viewer: { login: "review-app[bot]" } } }), text: async () => "" };
  }
  if (String(url).endsWith("/graphql") && body.includes("reviewThreads")) {
    return { ok: true, status: 200, json: async () => ({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }), text: async () => "" };
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
      FINDINGS_FILE: findingsFile,
      REVIEW_METADATA_FILE: metadataFile,
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
  const githubRequests = readFileSync(githubLogFile, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(githubRequests.length, 3);
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
  assert.equal(validateMetadata(run.metadataFile).status, 0);
});

test("all-pass failure writes valid diagnostic metadata before exiting nonzero", (t) => {
  const run = runReview(t, {
    general: ["bad", "bad again"],
    correctness: ["bad", "bad again"],
    boundaries: ["bad", "bad again"],
  });

  assert.notEqual(run.result.status, 0);
  assert.equal(run.findings, null);
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
  assert.equal(validateMetadata(run.metadataFile).status, 0);
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
  assert.equal(validateMetadata(run.metadataFile).status, 0);
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
  assert.equal(validateMetadata(run.metadataFile).status, 0);
});

test("diff metadata counts UTF-8 bytes rather than shell characters", (t) => {
  const run = runReview(t, {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  }, {
    env: { AGENTIC_REVIEW_MAX_DIFF_BYTES: "0" },
    targetFiles: { "unicode.txt": `${"é".repeat(40)}\n` },
  });

  assert.equal(run.result.status, 0, run.result.stderr);
  let expectedDiff = execFileSync("git", ["diff", "--no-color", "main", "HEAD"], {
    cwd: run.repository,
  });
  while (expectedDiff.at(-1) === 10) expectedDiff = expectedDiff.subarray(0, -1);
  assert.equal(run.metadata.diff.bytes, expectedDiff.length);
  assert.equal(run.metadata.diff.included_bytes, expectedDiff.length);
  assert.equal(validateMetadata(run.metadataFile).status, 0);
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

test("findings and metadata destinations cannot resolve to the same file", (t) => {
  const plan = {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  };
  const dotAlias = runReview(t, plan, {
    outputPaths: ({ directory }) => ({
      findingsFile: join(directory, "same.json"),
      metadataFile: `${directory}/./same.json`,
    }),
  });
  assert.notEqual(dotAlias.result.status, 0);
  assert.equal(dotAlias.logs.length, 0);
  assert.match(dotAlias.result.stderr, /--out.*--metadata-out|same destination/);

  const symlinkAlias = runReview(t, plan, {
    outputPaths: ({ directory }) => {
      const realDirectory = join(directory, "real-output");
      const aliasDirectory = join(directory, "alias-output");
      mkdirSync(realDirectory);
      symlinkSync(realDirectory, aliasDirectory, "dir");
      return {
        findingsFile: join(realDirectory, "result.json"),
        metadataFile: join(aliasDirectory, "result.json"),
      };
    },
  });
  assert.notEqual(symlinkAlias.result.status, 0);
  assert.equal(symlinkAlias.logs.length, 0);
  assert.match(symlinkAlias.result.stderr, /--out.*--metadata-out|same destination/);
});

test("symlink artifact destinations are rejected before model work without replacing either output", (t) => {
  const plan = {
    general: [{ findings: [] }],
    correctness: [{ findings: [] }],
    boundaries: [{ findings: [] }],
  };
  for (const selected of ["findings", "metadata"]) {
    let staleTarget;
    let otherOutput;
    const stale = selected === "findings"
      ? '{"findings":[{"title":"stale"}]}\n'
      : '{"analysis_state":"stale"}\n';
    const run = runReview(t, plan, {
      outputPaths: ({ directory, findingsFile, metadataFile }) => {
        staleTarget = join(directory, `${selected}-stale-target.json`);
        writeFileSync(staleTarget, stale);
        const symlink = join(directory, `${selected}-artifact.json`);
        symlinkSync(staleTarget, symlink);
        otherOutput = selected === "findings" ? metadataFile : findingsFile;
        return selected === "findings"
          ? { findingsFile: symlink, metadataFile }
          : { findingsFile, metadataFile: symlink };
      },
    });

    assert.notEqual(run.result.status, 0, `${selected}: ${run.result.stderr}`);
    assert.equal(run.logs.length, 0, selected);
    assert.equal(lstatSync(selected === "findings" ? run.findingsFile : run.metadataFile).isSymbolicLink(), true);
    assert.equal(readFileSync(staleTarget, "utf8"), stale);
    assert.equal(existsSync(otherOutput), false, `${selected}: other artifact was partially written`);
    assert.match(run.result.stderr, /symlink.*(?:--out|--metadata-out)|(?:--out|--metadata-out).*symlink/i);
  }
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
});

test("reopened staged findings retain their synthetic target through pruning", (t) => {
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
  for (const command of ["dismiss", "reopen"]) {
    const result = spawnSync(process.execPath, [localState, command, stored.id], {
      cwd: first.repository,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  }

  const retainingRefs = git(
    first.repository,
    "for-each-ref",
    "--format=%(refname)",
    "--contains",
    stored.lastCommit,
  ).split("\n").filter(Boolean);
  assert.ok(retainingRefs.length > 0, "reopened staged target must regain a durable Git ref");

  git(first.repository, "reflog", "expire", "--expire=now", "--all");
  git(first.repository, "prune", "--expire=now");
  const retainedTarget = spawnSync(
    "git",
    ["cat-file", "-e", `${stored.lastCommit}^{commit}`],
    { cwd: first.repository, encoding: "utf8" },
  );
  assert.equal(retainedTarget.status, 0, "reopened staged target must survive Git pruning");

  writeFileSync(join(first.repository, "alpha.txt"), "alpha fixed after reopening\n");
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
  const [retired] = JSON.parse(readFileSync(statePath, "utf8")).findings;
  assert.equal(retired.status, "gone");
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
  assert.equal(validateMetadata(run.metadataFile).status, 0);
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
    metadataViaEnv: true,
  });

  assert.equal(run.result.status, 0, run.result.stderr);
  assert.ok(run.logs.every(({ prompt }) => prompt.includes("PROJECT_PROMPT_MARKER")));
  assert.ok(existsSync(join(run.repository, ".git", "agentic-review", "state.json")));
  assert.equal(validateMetadata(run.metadataFile).status, 0);
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
  const rendered = spawnSync(process.execPath, [poster], {
    encoding: "utf8",
    env: {
      ...process.env,
      FINDINGS_FILE: run.findingsFile,
      REVIEW_METADATA_FILE: run.metadataFile,
      RENDER: "1",
      REVIEW_MODE: "inline",
      FAIL_ON_FINDINGS: "true",
    },
  });
  assert.notEqual(rendered.status, 0);
  assert.match(rendered.stdout, /\| Analysis \| `inconclusive` \|/);
  assert.match(rendered.stdout, /\| Merge gate \| `blocked` \|/);
  assert.match(rendered.stdout, /\| Bounded convergence \| `no` \|/);
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
  assert.equal(validateMetadata(run.metadataFile).status, 0);
});
