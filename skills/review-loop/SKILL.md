---
name: review-loop
description: Use when iterating on a branch until its review is clean — run the local reviewer, triage findings, fix, re-run, and confirm each finding actually went away rather than merely going unmentioned.
---

# Review loop

The loop is: **review → triage → fix → re-review → confirm gone.** The last step
is the one people skip, and it is the one that matters.

```bash
review --review-mode suggest      # findings + proposed fixes, nothing posted
review --open                     # what is still open from previous runs
review --dismiss <id>             # stop reporting one you have judged
review --history                  # past runs
```

State lives in the repository's git directory, so the loop remembers across runs
and across worktrees, and cannot be committed.

## Triage before fixing

Take findings in severity order — `P0`, then `P1`, then `P2` — and for each,
decide one of three things:

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
9 findings out of the same 11 on unchanged input. So `review --open` reports a
finding as gone only when the **file it pointed at actually changed**. If the
file is untouched, it stays open and the run says `unreported but unchanged`.

Treat that phrase as a warning, not as progress.

## Confirm the fix, not the silence

After fixing, verify directly rather than trusting the next review:

- Read the code path the finding described and check the failure it stated can
  no longer happen.
- Where a test can express it, write the test first, watch it fail, then fix.
- Re-run the review and confirm the finding is reported as gone rather than
  absent.

## When to stop

Stop when every `P0` and `P1` is fixed or dismissed with a reason, and the run
reports no `unreported but unchanged` findings. Remaining `P2`s are a judgement
call.

Do not loop for a clean sheet. Recall is roughly 8 or 9 real defects out of 11,
so a clean run is evidence that the reviewer found nothing, not that nothing is
there. Two or three iterations exhaust most of what it can see; beyond that you
are sampling noise.
