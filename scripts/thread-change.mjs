export const THREAD_CHANGE_MARGIN_LINES = 3;

export const literalPathspec = (path) => `:(literal)${path}`;

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm;

export function diffTouchesSpan(
  diffText,
  startLine,
  endLine,
  margin = THREAD_CHANGE_MARGIN_LINES,
) {
  if (!diffText) return false;
  if (![startLine, endLine, margin].every(Number.isInteger) || startLine < 1 || endLine < 1 || margin < 0) {
    return null;
  }

  const spanStart = Math.max(1, Math.min(startLine, endLine) - margin);
  const spanEnd = Math.max(startLine, endLine) + margin;
  let sawHunk = false;

  HUNK_HEADER.lastIndex = 0;
  for (const match of diffText.matchAll(HUNK_HEADER)) {
    sawHunk = true;
    const hunkStart = Math.max(1, Number(match[1]));
    const lineCount = match[2] === undefined ? 1 : Number(match[2]);
    const hunkEnd = lineCount === 0 ? hunkStart : hunkStart + lineCount - 1;
    if (hunkStart <= spanEnd && hunkEnd >= spanStart) return true;
  }

  return sawHunk ? false : null;
}
