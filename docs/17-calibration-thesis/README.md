# Calibration

> Why solumbe grades its own risk signals against repository history, and why that does not require a model.

solumbe's gate scores a change partly on risk flags: does this diff touch
authentication, money flow, a data model, a migration. Each flag carries a
weight, and those weights were originally chosen by judgement.

A risk level that has never been compared to an outcome is a heuristic wearing
a number. This page is the record of comparing them, on real repositories, and
of what the comparison changed.

The source is TypeSafe's System One launch
([announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev),
[concepts](https://docs.typesafe.ai/concepts/system-one)). Its argument is that
software should not ask a model for prose and then parse it; it should ask
narrow typed questions and receive **calibrated probabilities**: numbers
trained against outcomes, so a 0.9 means roughly nine times in ten. The
accompanying guidance is equally pointed: route on confidence, escalate what
falls below a threshold, and let deterministic code keep control flow.

The obvious reading is "solumbe should call that model." The useful reading is the
question it raises about solumbe itself:

> **Is solumbe's own risk score calibrated?**

It had never been checked. The first attempt, recorded below, said more about
the measurement than about the score; the second one, with the join that
attempt proved was load-bearing, found a flag carrying weight it had not
earned, and a band ordering that was inverted. Both are now fixed, and the
question is answerable on demand rather than by argument: `solumbe calibrate`.

Partly, then. For the flags a repository has enough history to grade, and not
otherwise, which is itself a result this document takes seriously.

## The thesis in one line

> A risk level that has never been compared to an outcome is a heuristic wearing
> a number. solumbe's evidence is already deterministic and replayable;
> calibration makes it **accountable**: every flag carries a hit rate measured
> on this repository's own history.

## The substrate solumbe already has

| Calibration needs | solumbe's existing answer |
| --- | --- |
| A signal worth grading | `inferRisk` flags and level (`src/lib/pr-review.js`), `classifyPath` (`src/lib/risk-paths.js`) |
| Ground truth without a labelling budget | Git history: reverts, follow-up fixes to the same lines, CI outcome |
| Inputs that recompute identically | The gate is a pure function of repo state ([determinism thesis](../07-deterministic-verification/README.md)) |
| A tamper-evident identity per evaluation | Receipts over canonical, timestamp-free payloads (`src/lib/converge.js`) |
| Somewhere to publish the numbers | [Evaluation guide](../EVALS.md) and the `eval:accuracy` / `eval:harness` / `eval:gate` scripts |
| Dimensions to segment by | CODEOWNERS, risk paths, file kinds, code map fan-out |

Nothing here needs a network, a key, or a vendor. The measurement is the same
kind of object solumbe already ships: a deterministic function of repository
state, recorded in a receipt.

## What is asserted today

`inferRisk` sums hand-chosen weights (request surface +2, frontend/backend
contract +2, data model +3, auth/security +3, money flow +3, configuration +2,
large file diff +2, large PR +2, no test files changed +2, open discussion up to
+3, tests present −1), and then cuts the total into bands at **≥ 9 high** and
**≥ 4 medium**.

Every one of those numbers was chosen by judgement. That is a perfectly good way
to start, and a poor thing to leave permanently unexamined. The gate is
reproducible, which means a wrong weight is reproducibly wrong.

## The method

### 1. Outcomes, defined deterministically and reported separately

Three proxies, each computable from git alone:

- **Reverted**: a later commit that reverts this one (revert trailer or
  recorded sha).
- **Repaired**: a later commit within a bounded window that touches the same
  files, overlapping the same lines, and classifies as a fix.
- **Rejected**: in PR mode, a failing required check or a changes-requested
  review on the head sha.

These are proxies, not truth. A refactor that revisits the same lines is not a
repair; a revert can be a product decision. They are therefore reported
**separately and named**, never merged into a single "bug" label.

### 2. The backtest

Walk the repository's own history. For each commit (or merged PR), recompute the
risk flags and level from the state *at that time*, then join to the outcomes
above. Local, offline, and replayable, the same properties the gate already has.

### 3. The metrics

Per flag: base rate, hit rate, and lift over base rate. Per level: the confusion
matrix, and the ordering check that actually matters, are `high` changes
empirically worse than `medium`, and `medium` worse than `low`? A flag that
fires often and predicts nothing is noise; a flag that fires rarely and predicts
strongly deserves more weight than it has.

The per-flag hit rate is itself an empirical probability, P(outcome | flag).
That is calibration, arrived at without a model.

### 4. The calibration receipt

Same discipline as the convergence and validation receipts: a canonical,
timestamp-free payload recording the commit range, the window, the outcome
definitions, the counts, and the resulting rates, so a number in a README can
be traced to the run that produced it.

## First measurement (2026-09-19)

A throwaway prototype ran the `repaired` proxy over this repository (283
commits since 2026-05-18, 192 non-merge, 152 scoreable) using a deliberately
weaker join than the one specified above: same file, not same lines.

**`reverted` has no events.** Not one revert in the repository's history, so
that proxy cannot be validated here in either direction.

**A file-level `repaired` join measures co-change, not repair.** The base rate
tracks the window almost linearly:

| Window | 3 days | 7 days | 14 days | 30 days |
| --- | --- | --- | --- | --- |
| Repaired | 22.9% | 30.1% | 54.6% | 71.2% |

A defect signal should not triple as the window widens. Wait long enough in an
active repository and some fix touches every file. This is the evidence that the
line-overlap requirement above is load-bearing rather than decorative.

**This repository cannot calibrate this repository.** Per-flag counts:

| Flag | n | Repaired | Lift |
| --- | --- | --- | --- |
| configuration | 89 | 64.0% | 1.17x |
| auth/security | 2 | 50.0% | 0.92x |
| data model | 3 | 33.3% | 0.61x |
| money flow | 1 | 0.0% | n/a |
| (no flag) | 63 | 41.3% | 0.76x |

Every lift sits within noise of 1x, and the three flags the gate weights most
heavily carry n = 2, 3 and 1. Nothing can be concluded about them from this
corpus, in either direction.

One finding survives the sample-size problem: `configuration` fires on 89 of the
152 scoreable commits, 59%, contributing +2 to the risk score nearly every
time. A flag that fires on most changes carries little information whatever
calibration eventually says about it.

## Second corpus (2026-09-19)

The `configuration` finding above was the one result the first measurement could
support, so it was the first thing checked against a second repository:
`bashbop-api`, a production service with **2,680 commits, 2,303 non-merge, 1,064
scoreable**, seven times solumbe's corpus.

It reproduces, and sharpens.

| | solumbe | bashbop-api |
| --- | ---: | ---: |
| Scoreable commits | 152 | 1,064 |
| `configuration` fires on | 63.2% | **56.8%** |

A flag firing on well over half of all changes is therefore not an artifact of
solumbe's own young, chore-heavy history. Decomposing each firing by its sole
cause says what is actually driving it:

| Sole cause of the firing | bashbop-api | solumbe |
| --- | ---: | ---: |
| Dependency manifest / lockfile | **83%** | 61% |
| CI workflow | 4% | 18% |
| First-party application config | 6% | 4% |
| Mixed causes | 6% | 15% |

`configuration` is, in practice, a dependency-bump detector. On bashbop-api,
five firings in six are a lockfile or a manifest and nothing else.

One caveat keeps this honest: the corpus is a second repository, not a
representative sample of repositories. Two is better than one and still not
many.

### What was changed, and what was not

The loose path matching that contributed to the rate was narrowed: `"config"`,
`"lock"` and `"env"` matched as bare word tokens, and `"package.json"` as a raw
substring, so ordinary source modules and every nested fixture manifest flagged.
Anchoring those removed 20 of 35 matching paths on solumbe and 7 of 58 on
bashbop-api, with nothing newly matched and no risk band changed in either.

The rate barely moved: 65.1% → 63.2% on solumbe, 56.8% → 56.7% on bashbop-api.

That is the useful part of the result. The breadth was real and worth fixing,
but it was never what made the flag fire on most changes. **Dependency-manifest
churn is**, which is a claim about outcomes, and therefore one the base rate
could not settle. So it was measured.

## A note on the numbers

The sections above were produced by a prototype, before `solumbe calibrate`
existed. Its `scoreable` filter excluded any commit with the word "fix"
anywhere in the subject; the shipped command matches a `fix:`-style prefix
instead. That is why bashbop-api appears as **1,064 scoreable commits** in the
base-rate section and **1,178** from here onward, the same repository under
two slightly different definitions of "a commit that could be graded".

The prototype figures are left as they were measured rather than retro-fitted,
because rewriting a recorded measurement to match a later tool is how a record
stops being one. Everything from this point on is reproducible with the
shipped command, and each run carries a receipt:

```bash
solumbe calibrate /path/to/repo --window 30
```

## The first calibration (2026-09-19)

The line-overlap join specified above was implemented and run against
bashbop-api: 1,178 scoreable commits, 1,066 fix commits, 936 joined to a
parent. For each fix, blame the exact pre-image lines it modifies at its
parent; the commits owning those lines are the ones it repairs.

**The join matters more than any number it produces.** Against the same
corpus, the file-level join the first measurement used behaves completely
differently:

| Join | 3 days | 30 days | 90 days |
| --- | ---: | ---: | ---: |
| same file | 38.3% | 79.5% | **91.4%** |
| line overlap | 12.0% | 24.0% | **30.7%** |

At 90 days the file-level join calls 91% of all commits repaired. A proxy that
fires on nearly everything cannot separate anything, which is why the first
measurement could conclude so little. The line-overlap join leaves roughly
seven commits in ten unrepaired, and discriminates.

### `configuration` was two signals wearing one name

Base rate 25.8%, 30-day window:

| Subset of `configuration` | n | repaired | lift |
| --- | ---: | ---: | ---: |
| manifest / lockfile only | 513 | 10.7% | **0.42x** |
| includes a real config file | 107 | 52.3% | **2.03x** |
| _combined, as it shipped_ | 620 | 17.9% | _0.69x_ |

A 4.8x separation, stable at every window from 7 to 90 days. Merged, the two
destroyed each other: the combined flag scored below even the commits carrying
no flag at all. Real configuration predicts repair about as strongly as
auth/security does; dependency churn does not predict it at all. (An earlier
revision of this section called dependency churn *measurably safer* than an
average change. A third corpus put it at 1.05x (see below), so the claim that
survives is the weaker one: no consistent signal, in either direction.)

### The bands were mis-sorted

This is the finding that made the change urgent rather than tidy. Band
ordering was **non-monotonic at every window**: `medium` changes were
consistently *less* likely to be repaired than `low`, because +2 from a
lockfile bump pushed hundreds of otherwise-low commits into medium:

| Window | before (low / med / high) | after |
| --- | --- | --- |
| 7d | 17.3% / 11.7% / 34.8% | 6.7% / 28.4% / 33.8% |
| 30d | 26.9% / 17.3% / 53.2% | 10.1% / 42.1% / 52.6% |
| 90d | 34.1% / 23.4% / 63.1% | 12.8% / 56.8% / 61.7% |

A gate whose `medium` is safer than its `low` is mis-sorting changes whatever
its per-flag numbers say. Dependency manifests now carry a `dependency` flag
of their own, scored at zero, still surfaced as evidence, because a reviewer
wants to see a lockfile moved, but no longer inflating the score.

### What the surviving weights look like

With dependency churn separated out, every remaining flag lands where its
weight roughly implies:

| Flag | n | repaired | lift | weight |
| --- | ---: | ---: | ---: | ---: |
| money flow | 64 | 62.5% | 2.42x | +3 |
| auth/security | 186 | 58.1% | 2.25x | +3 |
| configuration | 107 | 52.3% | 2.03x | +2 |
| request surface | 410 | 51.7% | 2.00x | +2 |
| large file diff | 209 | 49.3% | 1.91x | +2 |
| data model | 230 | 46.5% | 1.80x | +3 |
| dependency | 545 | 13.8% | 0.53x | **+0** |

Whether `request surface` deserves more than `data model` is a real question
this corpus raises and does not settle. Nothing else was touched: calibration
grades the signal, it does not tune it, and a measured weight is still a
human-reviewed code change.

## A third corpus, and two claims it revises (2026-09-19)

`bashbop-event-web` (2,027 non-merge commits, 1,026 scoreable, 977 fix
commits) was measured next, chosen because it is a **frontend** repository.
A question about request surfaces answered only on an API is a question
answered on one kind of code.

Its base rate is 47.1%, nearly double bashbop-api's 25.8%: roughly half of all
commits in it announce themselves as fixes. Lift compresses toward 1.0 as the
base rate rises, so the magnitudes are not comparable across the two corpora,
only the ordering is.

| Flag | n | repaired | lift | weight |
| --- | ---: | ---: | ---: | ---: |
| data model | 51 | 70.6% | 1.50x | +3 |
| large file diff | 329 | 69.0% | 1.47x | +2 |
| configuration | 149 | 63.8% | 1.35x | +2 |
| auth/security | 144 | 61.1% | 1.30x | +3 |
| request surface | 515 | 60.8% | 1.29x | +2 |
| frontend/backend contract | 175 | 60.6% | 1.29x | +2 |
| dependency | 234 | 49.6% | 1.05x | **+0** |
| money flow | 53 | 47.2% | 1.00x | +3 |
| (no flag) | 223 | 29.1% | 0.62x | n/a |

**The band ordering holds.** Monotonic again, at low 35.4%, medium 63.3% and high
76.1%, on a repository that had no part in the change that fixed it. That is
the first genuinely independent check on the correction above.

**The open weight question closes, in favour of leaving it alone.** On
bashbop-api `request surface` (+2) outranked `data model` (+3), which looked
like an argument for re-weighting. Here the order is reversed and `data model`
is the strongest flag in the table while `request surface` sits near the
bottom. The inversion does not replicate; it was one repository's shape, an
API whose data model is stable and whose routes churn, not a property of the
signals. **The current weights stand.**

**A claim made here last iteration was too strong.** `dependency` was
described as *measurably safer than an average change*. It lifts 1.05x on this
corpus: indistinguishable from average, not safer. What survives both is the
weaker and more useful claim: dependency churn carries **no consistent
signal**, 0.53x in one repository and 1.05x in another, predictive in neither
direction. Zero is still the right weight; "safer" was one corpus talking.

That correction is the method working rather than a lapse in it. A rate from a
single repository is a hypothesis, and the thesis says so; this is what it
looks like when the second one disagrees.

### Ship the instrument, not just the number

All of the above now comes from `solumbe calibrate <repo>`, not a scratch
script, with the minimum-sample rule enforced in code rather than by hand,
and a receipt over a canonical timestamp-free payload so every number here can
be traced to the run that produced it.

Pointed at solumbe itself, the command mostly declines to answer:

```text
| money flow    | +3 | 1 | withheld (n < 30) | n/a |
| auth/security | +3 | 2 | withheld (n < 30) | n/a |
| data model    | +3 | 3 | withheld (n < 30) | n/a |

Monotonic (low < medium < high): unknown (a band fell below the minimum sample)
```

That is the rule working. This repository still cannot calibrate this
repository, and the tool now says so rather than printing a decimal.

## Grading the verdict, not only the flags (2026-10-10)

Everything above grades the risk flags, which are one input to the gate. It
does not grade what the gate says with them, and it cannot say whether showing
a verdict changes what happens next. Those are three different questions, and
`solumbe calibrate` now answers each with its own instrument.

| Question | Command | Evidence | What it cannot show |
| --- | --- | --- | --- |
| Does a WARN or FAIL change get repaired more often than a PASS one? | `solumbe calibrate <repo> --gate` | History: the real gate and convergence score replayed on each commit, joined to `repaired` | Whether the gate prevented anything |
| When a check warns, does anyone act on it? | `solumbe calibrate <repo> --follow-through` | The local usage log: the next run on the same repository | Whether the next run was the same change |
| Does showing the checks reduce repairs? | `solumbe calibrate <repo> --trial` | A trial with a control arm, `SOLUMBE_CHECK_MODE=trial` | Anything, until both arms hold 30 graded changes |

A check whose warnings do not predict a repair and are rarely cleared is a
false alarm. Neither of the first two numbers says that alone, and only the
third is evidence of an effect.

### The first replay

The command was pointed at this repository on the branch that introduced it:
314 non-merge commits, 111 replayed. Fix commits are the outcome, and release,
docs-only and under-30-day commits are not graded.

| Verdict | n | repaired | 95% interval | lift |
| --- | ---: | ---: | --- | ---: |
| PASS | 81 | 16.0% | 9.6% to 25.5% | 0.74x |
| WARN | 30 | 36.7% | 21.9% to 54.5% | 1.70x |
| FAIL | 0 | withheld | — | — |

The gate raised an alarm on 27.0% of changes (19.6% to 36.0%). Before the
review-state check stopped warning in local mode that figure was 100%, and
there was no PASS row to compare against. Of the 30 alarms, 19 were on a change
nothing later repaired: 63.3% (45.5% to 78.1%).

The direction is the one a useful gate would show. The claim is not earned:
the two intervals overlap, so on this corpus WARN is not shown to differ from
PASS. `Risk review` warned on 26 changes and `Dependency audit` on 6, both
under the minimum sample, so neither has a published rate. The convergence
bands read aligned 4 of 29 (withheld), partial 18.8% and drift 28.0%, with the
ordering unknown for the same reason. Receipt `gatecal_34e099cfe78b`.

Two cautions belong to the method, not to this corpus. The gate is replayed on
the commit as it landed, so a warning that made its author change the diff
left no trace: a check that works is graded on the changes it failed to stop.
And the convergence request is the commit subject, written after the change.

### A second corpus (2026-10-10)

The same command, on the released 4.4.0 engine, was pointed at `bashbop-api`:
2,340 non-merge commits, 618 replayed, and none the gate or the convergence
score could not evaluate. That is more than five times this repository's
corpus.

| Verdict | n | repaired | 95% interval | lift |
| --- | ---: | ---: | --- | ---: |
| PASS | 272 | 32.0% | 26.7% to 37.7% | 0.74x |
| WARN | 343 | 52.2% | 46.9% to 57.4% | 1.20x |
| FAIL | 3 | withheld | — | — |

The intervals do not overlap. On this corpus a change the gate warned on was
repaired more often than one it passed. The lift is modest because the base
rate is high, 43.4% (268 of 618), and lift compresses toward 1.0 as the base
rate rises, as it did in the flag tables above.

**The alarm is common, and wrong nearly half the time.** The gate raised an
alarm on 56.0% of changes (52.0% to 59.9%). Of those 346 alarms, 165 were on a
change nothing later repaired: 47.7% (42.5% to 52.9%). It had raised an alarm
on 181 of the 268 changes that were repaired: 67.5% (61.7% to 72.9%).

**One check carries the result.** `Risk review` warned on 333 of the 346
alarmed changes, repaired 52.3% (46.9% to 57.6%), a lift of 1.21x. `Migration
safety` warned on 29 (18 repaired), `Release discipline` on 15 (8) and `Secret
safety` on 1, all under the minimum sample and withheld. What this corpus
grades is the risk-path rule. It says nothing about the other checks in either
direction.

**The convergence band orders outcomes and does not separate them.**

| Band | n | repaired | 95% interval | lift |
| --- | ---: | ---: | --- | ---: |
| aligned | 82 | 32.9% | 23.7% to 43.7% | 0.76x |
| partial | 172 | 44.2% | 37.0% to 51.7% | 1.02x |
| drift | 364 | 45.3% | 40.3% to 50.5% | 1.04x |

Aligned is repaired least and drift most, so the ordering holds, but the drift
and aligned intervals overlap, and partial and drift are a point apart. 364 of
the 618 commits, 58.9%, score as drift against their own subject, which says
more about a commit subject as a stand-in for the request than about the
changes.

Across the two corpora the direction is the same, PASS repaired less often
than WARN, and it is established on one. None of it shows that the gate
prevents a repair. The replay ran on an otherwise idle machine, which matters:
the repair join reads a git call that times out as no evidence, so a loaded
machine can undercount repairs without saying so. Receipt
`gatecal_0059db10d1e2`.

### The trial

`SOLUMBE_CHECK_MODE=trial` puts each change in one of two arms, by a hash of
the repository root and the commit the change is being built on. In the shown
arm `convergence_score` and the local `review_gate` answer as usual. In the
withheld arm the MCP server computes and records the same result and tells the
agent only that it was recorded. `SOLUMBE_CHECK_SHOWN_SHARE` (default 0.5) sets
the split, and decisions go to `~/.solumbe/check-decisions.jsonl`
(`SOLUMBE_CHECK_LOG`).

A blocking FAIL is shown in both arms: a secret in a diff is not withheld for
a measurement. The command line, the pre-commit hook, CI and the pull request
gate are never part of the trial, which also means an agent in the withheld arm
can reach the result another way. Both facts pull the arms together, so the
trial understates whatever effect there is.

`solumbe calibrate <repo> --trial` grades the arms on the first commit made on
each head, joined to `repaired`. `node scripts/hooks/check-outcomes.mjs` grades
them sooner, on the same-session proxies the route outcomes use: whether the
next prompt pushed back, and whether the next turn edited the same files.

## What changes because of it

1. **Weights stop being folklore.** Changing one becomes a reviewed code change
   justified by a measurement, not a preference.
2. **Policy profiles get an honest basis.** `high-risk` can require the flags
   that demonstrably predict trouble in that repository.
3. **The claim upgrades.** "Deterministic" becomes "deterministic and measured"
   and unlike a benchmark, it is measured on the user's own history, which no
   competitor can copy.

## Why not simply call a calibrated model?

Because the dependency buys an opinion where solumbe sells evidence. A vendor's
probabilities are calibrated against its training outcomes, not against this
repository's. Adding a hosted call also trades the product's clearest sentence,
local-first, model-agnostic, no model calls in the core path, for a qualified
version of it.

If the backtest later exposes a blind spot that path rules genuinely cannot
close, that is the moment to revisit, with a measured job for the signal to do.
The boundary contract for that day, covering ratchet-only escalation, an allowlisted
payload and a receipt over the questions and answers, is written and parked on a
branch rather than merged, so the decision stays explicit instead of
incremental.

## What this is NOT

Not a bug predictor. Not a model, and not a route to one. Not automatic weight
tuning: a measured weight is still a human-reviewed code change. Not a claim
that git history is ground truth; it is a set of named proxies, each with known
failure modes. And not a new reason to block a merge: calibration grades the
signal, it does not become one.

## Sources

- TypeSafe AI, _Introducing System One Models & Jev_:
  <https://typesafe.ai/blog/introducing-system-one-models-and-jev>
- TypeSafe AI, _System One_ concepts and calibrated decisions:
  <https://docs.typesafe.ai/concepts/system-one>
- TypeSafe AI, _How to build with System One_ (confidence thresholds, atomic
  questions): <https://docs.typesafe.ai/concepts/how-to-build-with-system-one>
- solumbe source referenced above: `src/lib/pr-review.js`, `src/lib/risk-paths.js`,
  `src/lib/converge.js`, `src/lib/policy.js`
- Companions: [Deterministic Verification](../07-deterministic-verification/README.md),
  [Deterministic Verification](../07-deterministic-verification/README.md),
  [Deterministic Verification](../07-deterministic-verification/README.md),
  [Evaluation Guide](../EVALS.md)
