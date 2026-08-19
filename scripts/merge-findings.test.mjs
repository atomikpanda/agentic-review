import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("./merge-findings.mjs", import.meta.url);

function finding(title, overrides = {}) {
  return {
    title,
    body: `${title} causes incorrect review behavior`,
    severity: "Medium",
    file: `src/${title.toLowerCase().replaceAll(" ", "-")}.js`,
    start_line: 1,
    end_line: 1,
    ...overrides,
  };
}

function runCli(documents, args = []) {
  const directory = mkdtempSync(join(tmpdir(), "merge-findings-"));
  try {
    const files = documents.map((document, index) => {
      const file = join(directory, `pass-${index + 1}.json`);
      writeFileSync(file, typeof document === "string" ? document : JSON.stringify(document));
      return file;
    });
    return spawnSync(process.execPath, [script.pathname, ...args, ...files], { encoding: "utf8" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the default min-votes 1 union keeps findings seen by only one pass", () => {
  const documents = [
    { findings: [finding("General only")] },
    { findings: [finding("Correctness only")] },
    { findings: [finding("Boundaries only")] },
  ];

  const result = runCli(documents);

  assert.equal(result.status, 0, result.stderr);
  const merged = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(merged).sort(), ["findings", "passes"]);
  assert.equal(merged.passes, 3);
  assert.deepEqual(
    merged.findings.map(({ title, votes }) => ({ title, votes })),
    [
      { title: "Boundaries only", votes: 1 },
      { title: "Correctness only", votes: 1 },
      { title: "General only", votes: 1 },
    ],
  );
});

test("fuzzy duplicates use the shared finding identity and retain vote count", () => {
  const first = finding("Configured Bun version is ignored", {
    body: "The configured Bun version is never passed to setup-bun, so the action always installs latest.",
    file: "action.yml",
  });
  const second = finding("Configured Bun version is not passed to setup-bun", {
    body: "The configured Bun version is ignored because setup-bun never receives the requested version.",
    file: "./action.yml",
    severity: "High",
  });

  const result = runCli([{ findings: [first] }, { findings: [second] }]);

  assert.equal(result.status, 0, result.stderr);
  const merged = JSON.parse(result.stdout);
  assert.equal(merged.findings.length, 1);
  assert.equal(merged.findings[0].votes, 2);
  assert.equal(merged.findings[0].severity, "High");
});

test("an explicit stricter min-votes filters findings without changing the default", () => {
  const repeated = finding("Repeated finding", {
    body: "Repeated finding shares enough specific lifecycle transition vocabulary.",
    file: "src/shared.js",
  });
  const reworded = finding("Repeated lifecycle finding", {
    body: "The specific lifecycle transition vocabulary identifies the repeated finding.",
    file: "./src/shared.js",
  });
  const documents = [
    { findings: [repeated, finding("Seen once")] },
    { findings: [reworded] },
  ];

  const strict = runCli(documents, ["--min-votes", "2"]);
  const defaultUnion = runCli(documents);

  assert.equal(strict.status, 0, strict.stderr);
  assert.deepEqual(
    JSON.parse(strict.stdout).findings.map(({ title, votes }) => ({ title, votes })),
    [{ title: "Repeated finding", votes: 2 }],
  );
  assert.equal(JSON.parse(defaultUnion.stdout).findings.length, 2);
});

test("malformed documents report status to importers and diagnostics to the CLI", () => {
  const valid = JSON.stringify({ findings: [finding("Valid pass")] });
  const code = `
    const { mergeFindingDocuments } = await import(process.argv[1]);
    const result = mergeFindingDocuments([process.argv[2], process.argv[3]], { minVotes: 1 });
    process.stdout.write(JSON.stringify(result));
  `;
  const imported = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", code, script.href, valid, "not json"],
    { encoding: "utf8" },
  );

  assert.equal(imported.status, 0, imported.stderr);
  const result = JSON.parse(imported.stdout);
  assert.deepEqual(result.statuses, [
    { status: "valid", finding_count: 1 },
    { status: "malformed", finding_count: 0 },
  ]);
  assert.equal(result.passes, 1);
  assert.equal(result.findings.length, 1);

  const cli = runCli([valid, "not json"]);
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stderr, /pass .*pass-2\.json: unparseable, skipped/);
  assert.equal(JSON.parse(cli.stdout).passes, 1);
});

test("importing the module has no stdout, stderr, or exit side effects", () => {
  const imported = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", "await import(process.argv[1]);", script.href],
    { encoding: "utf8" },
  );

  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, "");
  assert.equal(imported.stderr, "");
});

test("--check accepts bare findings JSON and rejects prose-wrapped or empty output", () => {
  const json = JSON.stringify({ findings: [] });
  const bare = runCli([json], ["--check"]);
  const prose = runCli([`Review complete. ${json}`], ["--check"]);
  const empty = runCli([""], ["--check"]);

  assert.equal(bare.status, 0, bare.stderr);
  assert.notEqual(prose.status, 0);
  assert.notEqual(empty.status, 0);
});

test("output ordering is severity-first and deterministic across document order", () => {
  const documents = [
    { findings: [finding("Medium", { file: "src/z.js", severity: "Medium" })] },
    { findings: [finding("High B", { file: "src/b.js", severity: "High" })] },
    { findings: [finding("Critical", { file: "src/c.js", severity: "Critical" })] },
    { findings: [finding("High A", { file: "src/a.js", severity: "High" })] },
  ];

  const forward = runCli(documents);
  const reversed = runCli([...documents].reverse());

  assert.equal(forward.status, 0, forward.stderr);
  assert.equal(reversed.status, 0, reversed.stderr);
  assert.deepEqual(JSON.parse(forward.stdout), JSON.parse(reversed.stdout));
  assert.deepEqual(
    JSON.parse(forward.stdout).findings.map(({ title }) => title),
    ["Critical", "High A", "High B", "Medium"],
  );
});
