Review the changes on this branch.

You have read-only tools: `read`, `grep`, `glob`. Use them.
The whole point of this review is to check things the diff alone cannot show —
read the files a change depends on, not just the ones it touches.

Specifically worth checking, because these are where real defects have hidden
before:

- Does a config value referenced here actually exist where it is consumed?
  Follow it across files.
- Is a file the change depends on gitignored, and therefore absent in CI or on
  a fresh machine?
- Does something get installed, declared, or created but never configured,
  started, or referenced anywhere?
- Do documented credentials, scopes, flags and commands match what the code
  actually requires? Instructions that cannot succeed are defects.
- Would this change silently do nothing? That is the failure mode that survives
  code review.

Do NOT report: style, formatting, naming, test coverage, or anything a linter
already catches. shellcheck, actionlint, hadolint, tflint, trivy and gitleaks
run separately — duplicating them is noise.

Report ONLY defects you have verified by reading the relevant files. For each,
state the concrete failure: the input or condition, and the wrong behaviour
that results. If you cannot describe how it breaks, do not report it.

The output format you must use is described at the end of this prompt.
