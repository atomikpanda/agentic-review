# Benchmark

A reference set for measuring whether a change to this reviewer actually helps.
Without one, every tuning decision is a guess, and several guesses made against
this repo turned out to be wrong.

## The set

`atomikpanda/personal-services`, commit `c0757bd`, diffed against `main`:
43 files, 3,193 added lines of Caddy, cloud-init, Terraform, Docker Compose,
shell and GitHub Actions. Macroscope reviewed that exact commit and produced
**11 findings**, which are the ground truth.

Two properties make it usable: the findings were produced independently of this
project, and the code is real rather than synthetic — both failure modes that
[SecLLMHolmes](https://arxiv.org/pdf/2312.12575) shows inflate benchmark scores.

Run it against the commit, not the branch tip. Later commits *fixed* most of
those 11, so reviewing the final state measures nothing:

```bash
git worktree add -f --detach /tmp/bench c0757bd
cd /tmp/bench && run-review.sh --base main --review-mode suggest --passes 3
```

## What it cannot tell you

**It is defined as Macroscope's output**, so Macroscope scores 11/11 by
construction. It measures reproduction, not superiority. Every run so far has
also produced real findings *outside* the set — the `git clone || true`, the
unguarded Tailscale join, the ungated production environment — which score zero.

## Measured variance — read this before trusting a number

The same configuration, run twice, scored **8/11 and 6/11**:

| Run | Passes parsed | Recall | Distinct findings |
|---|---|---|---|
| 3 passes | 2 of 3 | 8/11 | 20 raw → 14 |
| 3 passes | 3 of 3 | 6/11 | 16 |
| Union of both | | **9/11** | |

A ±2 swing on an 11-item set is roughly ±18 points. **A single run cannot
distinguish two configurations** unless the gap is large, and several
comparisons made during development were single-sample and therefore weaker
evidence than they appeared. Run at least three samples per configuration
before believing a difference; at ~$0.02 a run there is no reason not to.

The underlying cause is documented: models give inconsistent verdicts across
runs of identical code. Repeated sampling is why the union beats any single run.

## Results so far

| Configuration | Samples | Recall | Findings | Notes |
|---|---|---|---|---|
| 1 pass, default thinking | 1 | 5/11 | 9 | ~$0.007, ~55s |
| 1 pass, `gpt-5.6-terra`, default thinking | 1 | 5/11 | 7 | 10× the price bought nothing |
| 1 pass, `deepseek-v4-flash`, default thinking | 1 | 5/11 | 7 | 6× slower |
| 3 passes, default thinking | 2 | 6/11, 8/11 | 16–20 | ~$0.02 |
| 3 lens passes, default thinking | 1 | 5/11 | 9 | mapping was wrong, see below |
| **1 pass, `thinking: high`** | **4** | **8, 9, 8, 8** | **14–17** | ~$0.03, ~4 min |
| Union across everything | | 10/11 | | |

**Reasoning effort is the largest lever measured, by a distance.** At the model's
default the agent made 3 turns and 2 tool calls on a 43-file diff — it read the
diff and answered, which is the single-shot behaviour this project exists to
beat. At `high` the same input produced 11 turns and 25 tool calls.

It also *narrows* the variance that makes this benchmark awkward: four samples
at `high` scored 8, 9, 8, 8, against 5–8 for the default. One high-effort pass
beats three default passes, at a third of the passes.

Note what did **not** help: a model 10× the price, at default effort, scored the
same as the cheap one. It is not model strength, it is how long the model is
allowed to look.

Precision has been 100% in every run scored — no finding has yet failed
verification against the code.

Two of the 11 have never been found in any configuration: the tailnet CIDR that
cannot reach the dashboard over a public hostname, and the `validate` task that
destroys a real `.env`. Both are "the stated thing cannot work" defects, which
remains this reviewer's weakest class.

The lens result is not a clean refutation of lenses: 5/11 sits inside the
observed noise band. What *is* solid is the mechanism found while investigating
it — the security lens was mapped to `skills/security-review` only, so it never
saw the Caddy entry whose own text calls it "an auth bypass". Knowledge split on
file boundaries loses whatever sits on the wrong side.
