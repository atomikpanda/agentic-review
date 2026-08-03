# Output format

Output a single JSON object and nothing else. No prose before or after, no
markdown fence around it. If you found nothing, output exactly:

    {"findings": []}

Otherwise:

    {
      "findings": [
        {
          "file": "path/relative/to/the/repository/root",
          "start_line": 42,
          "end_line": 44,
          "severity": "Critical",
          "title": "One line, no trailing period",
          "body": "What breaks: the input or condition, and the wrong behaviour that results. Markdown is allowed here.",
          "suggestion": "    the exact replacement text for lines 42-44\n    including every line\n"
        }
      ]
    }

Rules that decide whether a finding can be shown at all:

- `start_line` and `end_line` are line numbers **in the new version of the
  file** — the state after this branch's changes, which is what you read from
  disk. They are inclusive.
- They must fall on lines **this branch actually changed**. GitHub can only
  anchor a comment to a line inside the diff. If the defect is real but lives
  in untouched code, still report it — anchor it to the changed line that
  causes the problem, and explain the connection in `body`.
- **Verify the numbers by reading the file.** Do not infer them from the diff
  or estimate. An off-by-one anchors the comment to the wrong code, and a
  suggestion that replaces the wrong lines is worse than no suggestion.

`suggestion` is the valuable part. It must be the **complete replacement text
for `start_line` through `end_line` inclusive**:

- Reproduce the exact leading whitespace of the original lines. It replaces
  them verbatim.
- No diff markers, no `+`/`-` prefixes, no surrounding code fence.
- Include every line of the range, not just the one you are changing.
- It must be the finished code, not a sketch or a placeholder.
- Set it to `null` when you cannot produce a correct complete replacement —
  because the fix spans several files, needs a judgement call, or is "delete
  this and rethink it". A comment with no suggestion is a good outcome. A
  wrong suggestion is not: someone will click the button.

`severity` is one of `Critical`, `High`, `Medium`. Same bar as before — report
only defects you verified by reading the relevant files, and state the concrete
failure. If you cannot describe how it breaks, leave it out.
