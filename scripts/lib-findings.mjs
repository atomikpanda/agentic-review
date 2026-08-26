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
const VERIFICATION_ID_RE = /^K[1-9][0-9]*$/;
// Epistemic basis of a finding (issue #4). Models state concrete claims —
// "this endpoint does not exist", "this header is missing" — with equal
// confidence whether they traced the code or guessed from priors, and on this
// project's own PRs every such guess failed a one-line check against reality.
// The kind is declared by the model per finding so downstream rendering can
// mark hypotheses as hypotheses instead of trusting prose confidence.
export const EVIDENCE_KINDS = new Set(["observed", "static-proof", "inferred"]);

export function findingValidationError(value, path = "finding") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return `${path} must be an object`;
  }
  if (typeof value.file !== "string" || value.file.trim().length === 0) {
    return `${path}.file must be a non-empty string`;
  }
  if (
    typeof value.title !== "string"
    || value.title.trim().length === 0
    || /[\r\n]/.test(value.title)
  ) {
    return `${path}.title must be a non-empty single-line string`;
  }
  if (typeof value.body !== "string" || value.body.trim().length === 0) {
    return `${path}.body must be a non-empty string`;
  }
  if (!FINDING_SEVERITIES.has(value.severity)) {
    return `${path}.severity must be Critical, High, or Medium`;
  }
  if (!EVIDENCE_KINDS.has(value.evidence_kind)) {
    return `${path}.evidence_kind must be observed, static-proof, or inferred`;
  }
  if (typeof value.verification !== "string" || value.verification.trim().length === 0) {
    return `${path}.verification must be a non-empty string`;
  }
  if (!Number.isInteger(value.start_line) || value.start_line <= 0) {
    return `${path}.start_line must be a positive integer`;
  }
  if (!Number.isInteger(value.end_line) || value.end_line < value.start_line) {
    return `${path}.end_line must be an integer at least start_line`;
  }
  if (
    value.verification_id !== undefined
    && (
      typeof value.verification_id !== "string"
      || !VERIFICATION_ID_RE.test(value.verification_id)
    )
  ) {
    return `${path}.verification_id must match K<positive integer>`;
  }
  if (value.verification_of === undefined) {
    if (value.verification_classification !== undefined) {
      return `${path}.verification_classification requires verification_of`;
    }
  } else {
    if (
      typeof value.verification_of !== "string"
      || !VERIFICATION_ID_RE.test(value.verification_of)
    ) {
      return `${path}.verification_of must match K<positive integer>`;
    }
    if (value.verification_classification !== "linked_regression") {
      return `${path}.verification_classification must be linked_regression`;
    }
  }
  if (typeof value.suggestion !== "string" && value.suggestion !== null) {
    return `${path}.suggestion must be a string or null`;
  }
  return null;
}

export function isValidFinding(value) {
  return findingValidationError(value) === null;
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
    evidence_kind: value.evidence_kind,
    verification: value.verification,
    suggestion: value.suggestion,
    ...(value.verification_id === undefined
      ? {}
      : { verification_id: value.verification_id }),
    ...(value.verification_of === undefined
      ? {}
      : {
          verification_of: value.verification_of,
          verification_classification: value.verification_classification,
        }),
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
