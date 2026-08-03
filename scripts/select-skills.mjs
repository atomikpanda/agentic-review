#!/usr/bin/env node
// Emit only the parts of the skill files that apply to the files a branch
// changed.
//
// WHY. Adherence to injected rules collapses with rule count: measured perfect-
// response rates run ~85-94% at 10 instructions, 10-31% at 40, and ~0% at 80 —
// across every model and format tested (arXiv 2607.19257). The two skills plus
// the prompts come to 84 discrete rules, which is in the zero band, and it
// shows: on a benchmark against a known set, 6 of 7 missed findings were
// explicitly catalogued in the skill that was in the prompt the whole time.
//
// The same work found that rewording or reformatting does not help past ~40 —
// only splitting does. This is the cheapest split available: ship the Caddy
// rules when a Caddyfile changed, not when it didn't.
//
// HOW. A section declares what it applies to, immediately under its heading:
//
//     ## Caddy / reverse proxies
//     <!-- when: Caddyfile, edge/** -->
//
// A section with no `when:` is always included — that is the right default for
// framing and for the "what must not be reported" rules, which are not tied to
// any file type.
//
// Env:
//   CHANGED_FILES  newline-separated paths     (required)
//   SKILL_FILES    space-separated skill paths (required)
//   VERBOSE=1      report what was kept and dropped, on stderr

import { readFileSync } from "node:fs";

const changed = (process.env.CHANGED_FILES ?? "")
  .split("\n").map((s) => s.trim()).filter(Boolean);
const skillFiles = (process.env.SKILL_FILES ?? "")
  .split(/\s+/).map((s) => s.trim()).filter(Boolean);
const VERBOSE = process.env.VERBOSE === "1";

// Glob subset: ** any depth, * within a segment. Matched against the full path
// and, for a bare pattern with no slash, against the basename too — so
// `Caddyfile` matches `edge/Caddyfile` without every skill needing `**/`.
function globToRe(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function matches(glob, files) {
  const re = globToRe(glob);
  const bare = !glob.includes("/");
  return files.some((f) => re.test(f) || (bare && re.test(f.split("/").pop())));
}

// Split a skill into a preamble plus `##` sections, carrying each section's
// `when:` line if it has one.
function sections(text) {
  const lines = text.split("\n");
  const out = [];
  let cur = { heading: null, when: null, body: [] };
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      out.push(cur);
      cur = { heading: line, when: null, body: [] };
      continue;
    }
    const m = line.match(/^<!--\s*when:\s*(.+?)\s*-->\s*$/);
    if (m && cur.heading && cur.body.every((l) => !l.trim())) {
      cur.when = m[1].split(",").map((s) => s.trim()).filter(Boolean);
      continue; // the marker is metadata, not content
    }
    cur.body.push(line);
  }
  out.push(cur);
  return out;
}

const countRules = (s) => (s.match(/^\s*[-*] /gm) ?? []).length;

let kept = 0, dropped = 0, keptRules = 0, droppedRules = 0;
const chunks = [];

for (const file of skillFiles) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch { continue; }
  const parts = sections(text);
  const emitted = [];
  for (const p of parts) {
    const block = (p.heading ? p.heading + "\n" : "") + p.body.join("\n");
    const rules = countRules(block);
    // No marker, or no changed-file list to filter against: keep it.
    const applies = !p.when || changed.length === 0 || p.when.some((g) => matches(g, changed));
    if (applies) {
      emitted.push(block);
      if (p.heading) { kept++; keptRules += rules; }
    } else {
      dropped++; droppedRules += rules;
      if (VERBOSE) process.stderr.write(`    drop  ${p.heading.replace(/^##\s+/, "")}\n`);
    }
  }
  if (emitted.join("").trim()) chunks.push(emitted.join("\n").replace(/\n{3,}/g, "\n\n"));
}

process.stdout.write(chunks.join("\n\n"));
process.stderr.write(
  `  skills: kept ${kept} sections (${keptRules} rules), dropped ${dropped} (${droppedRules} rules)\n`,
);
