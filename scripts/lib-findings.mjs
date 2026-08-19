// Shared identity logic for findings. Imported by post-review.mjs (matching a
// finding to an existing review thread) and merge-findings.mjs (matching the
// same finding across repeated passes). One copy, because a divergence would
// mean the merge treats two findings as one and the poster does not.
//
// Identity is fuzzy on purpose. A model rewords the same defect between runs:
// on this project's own PR one issue arrived as "bun_version input is not
// passed to setup-bun", "Configured Bun version is ignored" and "Configured Bun
// version is not passed to setup-bun". Hashing the title matches none of those
// to each other.
//
// Threshold measured on two different populations, because they turned out to
// have different distributions and the first number did not transfer:
//
//   matching a finding to an existing THREAD   same 0.37-0.49  different 0.03-0.16
//   matching the same finding across PASSES    same 0.26-0.29  different <= 0.14
//
// Cross-pass wording drifts further than cross-commit wording — a model
// re-describing a defect from scratch shares less vocabulary than one revisiting
// it. 0.30 was tuned on the first population alone and merged 0 of 6 true
// cross-pass duplicates. 0.20 separates both: everything genuinely the same
// scores >= 0.26, everything different <= 0.16.

export const SIMILARITY_DEFAULT = 0.20;

const FINDING_SEVERITIES = new Set(["Critical", "High", "Medium"]);

export function isValidFinding(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof value.file === "string"
    && value.file.trim().length > 0
    && typeof value.title === "string"
    && value.title.trim().length > 0
    && typeof value.body === "string"
    && value.body.trim().length > 0
    && FINDING_SEVERITIES.has(value.severity)
    && Number.isInteger(value.start_line)
    && value.start_line > 0
    && Number.isInteger(value.end_line)
    && value.end_line >= value.start_line
    && (typeof value.suggestion === "string" || value.suggestion === null);
}

export function projectPublicFinding(value) {
  if (!isValidFinding(value)) return null;
  return {
    title: value.title,
    body: value.body,
    severity: value.severity,
    file: value.file,
    start_line: value.start_line,
    end_line: value.end_line,
    suggestion: value.suggestion,
  };
}

const STOPWORDS = new Set(
  ("this that with from have when then than been they them there which while would could" +
    " should must into over under only also more most much some such very each other same" +
    " about after before again where whether because during through does not"
  ).split(" "),
);

export function tokenSet(text) {
  return new Set(
    String(text ?? "")
      .toLowerCase()
      .replace(/```[\s\S]*?```/g, " ")   // suggestion blocks are not identity
      .replace(/<!--[\s\S]*?-->/g, " ")  // our own markers
      .replace(/<\/?details>|<\/?summary>/g, " ")
      .replace(/[^a-z0-9_]+/g, " ")
      .split(" ")
      .filter((w) => w.length > 3 && !STOPWORDS.has(w)),
  );
}

export function similarity(a, b) {
  const inter = [...a].filter((x) => b.has(x)).length;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

export function identityTokens(value) {
  if (!value || typeof value !== "object" || !Object.hasOwn(value, "identity_tokens")) {
    return [...tokenSet(`${value?.title} ${value?.body}`)];
  }
  if (!Array.isArray(value.identity_tokens) || value.identity_tokens.length === 0) return null;
  const normalized = [];
  for (const token of value.identity_tokens) {
    if (typeof token !== "string" || token.trim().length === 0) return null;
    normalized.push(token.trim().toLowerCase());
  }
  return normalized;
}

// Same file, and enough shared vocabulary.
export function sameFinding(a, b, threshold = SIMILARITY_DEFAULT) {
  const fa = String(a.file ?? "").replace(/^\.\//, "");
  const fb = String(b.file ?? "").replace(/^\.\//, "");
  if (fa !== fb) return false;
  const left = identityTokens(a);
  const right = identityTokens(b);
  if (!left || !right) return false;
  return similarity(new Set(left), new Set(right)) >= threshold;
}
