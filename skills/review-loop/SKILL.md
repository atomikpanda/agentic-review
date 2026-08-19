---
name: review-loop
description: Use when applying merged review findings to a branch with a bounded fix/re-review loop — validate the batch, repair shared causes, push once, and stop after three non-clean rounds.
---

# Review loop

The loop is: **review one immutable head → triage the merged batch → fix shared
causes → verify → push once → review the new immutable head.**

```bash
review --review-mode suggest      # findings + proposed fixes, nothing posted
review --open                     # what is still open from previous runs
review --dismiss <id>             # stop reporting one you have judged
review --history                  # past runs
```

State lives in the repository's git directory, so the loop remembers across runs
and across worktrees, and cannot be committed.

## Triage one merged batch before fixing

Treat the review as one batch merged from every successful pass for the current
immutable head. Validate **every** finding against the current code before
editing, then group the valid findings by shared invariant and affected
callsites. One broken contract may explain several reported symptoms; find its
owner and every caller before choosing the repair.

Take the groups in severity order — `P0`, then `P1`, then `P2` — and decide one
of three things for each finding:

- **Real** → fix it.
- **Wrong** → dismiss it with a reason you would say aloud. Reviewers are wrong
  roughly a fifth of the time on this codebase; dismissing is a normal outcome,
  not a failure.
- **Real but not now** → dismiss it and open an issue. Leaving it open means it
  reappears every run and you stop reading the output, which costs you the next
  real finding.

Do not fix a finding you cannot restate in your own words. If the description
does not make the failure clear, it is more likely to be wrong than subtle.

## "Gone" is not the same as "not mentioned"

A finding disappearing from the next run means one of two things, and they look
identical in the output:

1. It was fixed.
2. The reviewer did not mention it this time.

The second happens often — identical configurations have produced 5, 6, 7, 8 and
9 findings out of the same 11 on unchanged input. `review --open` reports a
finding as gone only after a changed hunk overlaps its latest confirmed line
span. Unrelated same-file changes and indeterminate comparisons leave it open,
and the run says `unreported without confirmed overlap`.

Treat that phrase as a warning, not as progress.

An earlier finding that is still valid remains actionable even when a later
stochastic sample omits it. Do not treat omission as dismissal.

## Confirm the fix, not the silence

Repair the shared owner or invariant and update every affected callsite rather
than patching each reported symptom independently. Add an observable behavior
regression when the contract is otherwise uncovered.

Verify the integrated batch directly: read the affected paths, exercise the
stated failures, and run the relevant focused checks. Then make **one
consolidated push** for the batch and review that new immutable head. Do not
push and re-review one comment at a time.

## When to stop

For one objective and head lineage, run at most **three non-clean review/fix
rounds**. Each round consumes one merged batch, applies and verifies the
integrated repair, makes one consolidated push, and reviews the new immutable
head.

Stop earlier only when the latest immutable head has
`analysis_state=complete`, `sample_state=clean`, and no held earlier finding.
Every reported finding must already be fixed or dismissed with a stated reason.
A bounded clean result means this sample found nothing actionable; it does not
prove the repository defect-free.

If the result after round three does not meet that stop condition, stop the
loop. Report the unresolved findings and/or why analysis is inconclusive, their
shared invariants or callsites, and the actual verification outcome; do **not**
assume verification failed, launch a fourth broad pass, or restart per-comment
patching. The cap constrains fixer churn, not the reviewer's obligation to
preserve and report valid evidence.
