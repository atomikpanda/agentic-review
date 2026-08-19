import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const runner = fileURLToPath(new URL("./run-review.sh", import.meta.url));
const resultCli = fileURLToPath(new URL("./review-result.mjs", import.meta.url));
const trustedRoot = dirname(dirname(runner));

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
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

if (process.argv.includes("--version")) {
  process.stdout.write("fake-omp 1.0.0\\n");
  process.exit(0);
}
const promptArgument = process.argv.slice(2).find((argument) => argument.startsWith("@"));
if (!promptArgument) process.exit(2);
const promptPath = promptArgument.slice(1);
const prompt = readFileSync(promptPath, "utf8");
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
appendFileSync(process.env.FAKE_OMP_LOG, JSON.stringify({
  id,
  attempt,
  promptPath,
  prompt,
  cwd: process.cwd(),
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

function git(directory, ...args) {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
}

function createFixture(t, { targetFiles = {} } = {}) {
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
  git(repository, "add", ".");
  git(repository, "commit", "-m", "base");
  const baseSha = git(repository, "rev-parse", "HEAD");

  git(repository, "checkout", "-b", "feature");
  writeFileSync(join(repository, "alpha.txt"), "alpha head\n");
  writeFileSync(join(repository, "beta.txt"), "beta head\n");
  writeFileSync(join(repository, "gamma.txt"), "gamma head\n");
  for (const [path, contents] of Object.entries(targetFiles)) {
    const destination = join(repository, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
  }
  git(repository, "add", ".");
  git(repository, "commit", "-m", "change three files");
  const headSha = git(repository, "rev-parse", "HEAD");

  const omp = join(bin, "omp");
  writeFileSync(omp, fakeOmp);
  chmodSync(omp, 0o755);

  return { directory, repository, bin, state, baseSha, headSha };
}

function runReview(t, plan, {
  args = ["--json"],
  env = {},
  targetFiles = {},
  includeOutputs = true,
  metadataViaEnv = false,
  noState = true,
  failMerge = false,
} = {}) {
  const fixture = createFixture(t, { targetFiles });
  const planFile = join(fixture.directory, "plan.json");
  const logFile = join(fixture.directory, "omp.log");
  const findingsFile = join(fixture.directory, "findings.json");
  const metadataFile = join(fixture.directory, "metadata.json");
  writeFileSync(planFile, JSON.stringify(plan));
  const runnerArgs = [
    runner,
    "--base", "main",
    "--no-codegraph",
    "--no-fail",
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
      REAL_NODE: process.execPath,
      ...(metadataViaEnv ? { AGENTIC_REVIEW_METADATA_OUT: metadataFile } : {}),
      ...env,
    },
  });
  const logs = existsSync(logFile)
    ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    : [];
  return {
    ...fixture,
    result,
    logs,
    findingsFile,
    metadataFile,
    findings: existsSync(findingsFile) ? JSON.parse(readFileSync(findingsFile, "utf8")) : null,
    metadata: existsSync(metadataFile) ? JSON.parse(readFileSync(metadataFile, "utf8")) : null,
  };
}

function validateMetadata(metadataFile) {
  return spawnSync(process.execPath, [resultCli, "validate", metadataFile], { encoding: "utf8" });
}

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
  assert.equal(validateMetadata(run.metadataFile).status, 0);
});
