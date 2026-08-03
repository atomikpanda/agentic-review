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

| Configuration | Recall | Notes |
|---|---|---|
| 1 pass, `gpt-5.6-luna` | 5/11 | ~$0.007 |
| 1 pass, `gpt-5.6-terra` (10× price) | 5/11 | model tier bought nothing |
| 1 pass, `deepseek-v4-flash` | 5/11 | 6× slower |
| 3 passes, `gpt-5.6-luna` | 6–8/11 | ~$0.02 |
| 3 lens passes (security/correctness/docs) | 5/11 | see below |
| Union across 6 passes | 9/11 | |

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
