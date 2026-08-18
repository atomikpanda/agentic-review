import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GIT_DIFF_MAX_BUFFER_BYTES,
  THREAD_CHANGE_MARGIN_LINES,
  diffTouchesSpan,
  literalPathspec,
  changeIsConfirmed,
} from "./thread-change.mjs";

const hunk = (header) => `diff --git a/example.py b/example.py
--- a/example.py
+++ b/example.py
${header}
-old
+new
`;

test("empty diff leaves the thread span unchanged", () => {
  assert.equal(diffTouchesSpan("", 40, 40), false);
});

test("a changed line inside the thread span overlaps", () => {
  assert.equal(diffTouchesSpan(hunk("@@ -40 +40 @@"), 40, 40), true);
});

test("a distant changed line does not overlap", () => {
  assert.equal(diffTouchesSpan(hunk("@@ -20 +20 @@"), 40, 40), false);
});

test("the default margin includes exactly three surrounding lines", () => {
  assert.equal(THREAD_CHANGE_MARGIN_LINES, 3);
  assert.equal(diffTouchesSpan(hunk("@@ -37 +37 @@"), 40, 40), true);
  assert.equal(diffTouchesSpan(hunk("@@ -36 +36 @@"), 40, 40), false);
});

test("a hunk overlapping any line of a multi-line thread overlaps", () => {
  assert.equal(diffTouchesSpan(hunk("@@ -44,2 +44,2 @@"), 40, 45), true);
});

test("insert-only hunks are points in old-side coordinates", () => {
  assert.equal(diffTouchesSpan(hunk("@@ -37,0 +38 @@"), 40, 40), true);
  assert.equal(diffTouchesSpan(hunk("@@ -36,0 +37 @@"), 40, 40), false);
});

test("any overlapping hunk wins when a diff has multiple hunks", () => {
  const diff = hunk("@@ -10 +10 @@") + hunk("@@ -42 +42 @@");
  assert.equal(diffTouchesSpan(diff, 40, 40), true);
});

test("non-textual changes are indeterminate", () => {
  assert.equal(
    diffTouchesSpan("Binary files a/image.png and b/image.png differ\n", 40, 40),
    null,
  );
});

test("an insertion before the first line overlaps a thread on line one", () => {
  assert.equal(diffTouchesSpan(hunk("@@ -0,0 +1,2 @@"), 1, 1), true);
});

test("matches old-side coordinates from a real zero-context git diff", () => {
  const directory = mkdtempSync(join(tmpdir(), "thread-change-"));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();

  try {
    git("init", "--quiet");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Thread Change Test");
    const lines = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`);
    writeFileSync(join(directory, "example.py"), `${lines.join("\n")}\n`);
    git("add", "example.py");
    git("commit", "--quiet", "-m", "base");
    const base = git("rev-parse", "HEAD");

    lines[9] = "changed line 10";
    lines[79] = "changed line 80";
    writeFileSync(join(directory, "example.py"), `${lines.join("\n")}\n`);
    git("add", "example.py");
    git("commit", "--quiet", "-m", "head");
    const head = git("rev-parse", "HEAD");
    const diff = git("diff", "--unified=0", base, head, "--", "example.py");

    assert.equal(diffTouchesSpan(diff, 80, 80), true);
    assert.equal(diffTouchesSpan(diff, 40, 40), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("literal pathspecs do not select files through wildcard magic", () => {
  const directory = mkdtempSync(join(tmpdir(), "thread-pathspec-"));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();

  try {
    git("init", "--quiet");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Thread Change Test");
    writeFileSync(join(directory, "literal*.py"), "unchanged\n");
    writeFileSync(join(directory, "literal-other.py"), "before\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    const base = git("rev-parse", "HEAD");

    writeFileSync(join(directory, "literal-other.py"), "after\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "head");
    const head = git("rev-parse", "HEAD");

    assert.notEqual(git("diff", "--unified=0", base, head, "--", "literal*.py"), "");
    assert.equal(git("diff", "--unified=0", base, head, "--", literalPathspec("literal*.py")), "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("literal pathspecs stay anchored to the repository root", () => {
  const directory = mkdtempSync(join(tmpdir(), "thread-pathspec-root-"));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();

  try {
    git("init", "--quiet");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Thread Change Test");
    mkdirSync(join(directory, "docs"));
    writeFileSync(join(directory, "README.md"), "root\n");
    writeFileSync(join(directory, "docs", "README.md"), "before\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    const base = git("rev-parse", "HEAD");

    writeFileSync(join(directory, "docs", "README.md"), "after\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "head");
    const head = git("rev-parse", "HEAD");

    assert.equal(git("diff", "--unified=0", base, head, "--", literalPathspec("README.md")), "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("only a known overlap confirms that a thread region changed", () => {
  assert.equal(changeIsConfirmed(true), true);
  assert.equal(changeIsConfirmed(false), false);
  assert.equal(changeIsConfirmed(null), false);
});

test("the configured diff buffer handles output above Node's default", () => {
  const directory = mkdtempSync(join(tmpdir(), "thread-diff-buffer-"));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();

  try {
    git("init", "--quiet");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Thread Change Test");
    writeFileSync(join(directory, "large.txt"), `${"a".repeat(600_000)}\n`);
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    const base = git("rev-parse", "HEAD");

    writeFileSync(join(directory, "large.txt"), `${"b".repeat(600_000)}\n`);
    git("add", ".");
    git("commit", "--quiet", "-m", "head");
    const head = git("rev-parse", "HEAD");
    const diff = execFileSync(
      "git",
      ["diff", "--unified=0", base, head, "--", literalPathspec("large.txt")],
      { cwd: directory, encoding: "utf8", maxBuffer: GIT_DIFF_MAX_BUFFER_BYTES },
    );

    assert.ok(Buffer.byteLength(diff) > 1024 * 1024);
    assert.equal(diffTouchesSpan(diff, 1, 1), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
