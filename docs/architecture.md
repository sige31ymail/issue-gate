# Architecture

## Where the decision is made

```
GitHub Issue event (target repository)
  │
  ▼
thin caller workflow  .github/workflows/issue-gate.yml
  │
  ▼
sige31ymail/issue-gate@v1          ← this repository, unpacked on the runner
  │
  ├─ load policies/night-ready.yml          (ships with the action)
  ├─ load .github/issue-gate.yml            (from the target repository, optional)
  ├─ deterministic checks                   author, state, non-empty
  ├─ one Jev request, all questions         → P(true) per check
  ├─ deterministic evaluation               → READY | NEEDS_* | HUMAN_REVIEW | BLOCKED
  ├─ upsert the audit comment
  └─ reconcile labels
```

The split is deliberate. Jev answers narrow questions of judgment; nothing else.
Thresholds, precedence, the dead band and the fail-closed rule are ordinary code
reading ordinary YAML, so the decision can be reviewed without reading a prompt.

## Why a composite action rather than a reusable workflow

The handoff proposed a central reusable workflow. Two things pushed against it.

First, GitHub only allows a **private** repository's actions and reusable
workflows to be used by other repositories within an *organization*. This is a
personal account, so a private `issue-gate` could not be called from
`hexbound` at all. Making `issue-gate` public solves it, and only `issue-gate`
has to be public — the restriction is on the repository hosting the action, not
the one calling it.

Second, calling a reusable workflow does not bring along the rest of its
repository, so `policies/` would have needed a separate `actions/checkout`. When
a workflow uses an *action*, the runner unpacks the whole action repository, so
the shared policy ships with the code and needs no extra step or token.

## Why repository overrides live in the target repository

The handoff put them in `policies/repositories/<name>.yml` here. Since
`issue-gate` is public, that would publish the names of private repositories and
their internal conventions. Overrides therefore live in the target repository as
`.github/issue-gate.yml`, which stays as private as the repository does.

Overrides are additive and corrective only: they can retune scalars, patch a
field of an existing check, and add new checks. They cannot remove a shared
check.

## Probabilities are always P(true)

The handoff's audit example mixed directions — it recorded
`requires_human_decision: decision: NO, probability: 0.91` against a policy
written as `YES probability must be <= 0.10`. One is P(no), the other P(yes).

Everything here stores and compares the probability Jev returns, which is
P(true) for the check's own statement. The example above is recorded as
`P(true) = 0.09` against `<= 0.10`, and passes. A check declares a bound in one
direction only; the loader rejects a check carrying both.

## The dead band

`noul` returns a probability and nothing else — unlike `choice` and `score`, it
has no `confidence` field. So the acceptance criterion "cover the ambiguous /
low-confidence case" needed a definition, and proximity to the threshold is the
only signal available.

The first design put a symmetric band around every threshold and called
anything inside it `AMBIGUOUS`. Six real Issues showed that this measures the
wrong thing. `safe_for_unattended_execution` returned 0.93 against a bar of
0.95 — a confident answer falling just short, reported as indecision — while the
answers that genuinely carried no signal sat near 0.5 and were classified
cleanly as failures.

The band also created two numbers for every threshold, the written one and the
effective one. That bookkeeping produced a bar of 1.00 that nothing could reach,
needed a dedicated guard to catch, and made every audit line read as a plausible
`AMBIGUOUS` while the gate quietly admitted nothing.

Thresholds are now written as the value an answer must reach. Indecision is a
separate, threshold-independent rule: `|p - 0.5| < ambiguity_band`. An undecided
check prevents `READY` but never outranks a failing one, so an Issue with a
nameable fault is told the fault rather than handed to a person.

The alternative technique, self-consistency (asking each question several times
and looking at the spread), costs a request per repetition. It is worth
considering if the band proves too blunt, but it is not in the MVP.

## Which label an Issue gets

Four failure labels exist and the most severe wins. The ranking only routes
usefully while `HUMAN_REVIEW` stays rare, and the first corpus showed why.

`requires_human_decision` was mapped to `HUMAN_REVIEW` with a bar of 0.10. It
returned 0.55-0.76 on every under-specified Issue, so the result was pinned at
`HUMAN_REVIEW` or above and `NEEDS_SPLIT` and `NEEDS_DETAIL` could not appear at
all. Four labels were defined; two could ever be produced. The Issue that
actually needed one sentence of acceptance criteria was reported as needing a
person.

The rule that follows: a check whose failure the Issue's author can repair maps
to `NEEDS_DETAIL` or `NEEDS_SPLIT`. `HUMAN_REVIEW` is for the checks that
genuinely need a person, plus every fail-closed path. An unsettled design
decision is a detail the author can write down, so it moved to `NEEDS_DETAIL`.

## Calibrating against real outcomes

Thresholds set from a corpus of six recordings are bounded from one side only:
the corpus contains no Issue that should have passed, so the numbers are known
not to be too loose and unknown to be too tight. Closing that gap needs ground
truth, and ground truth is whether the night run actually produced a usable PR.

Collecting it has a sampling problem. An enforcing gate only ever lets through
the Issues it already approved, so the outcomes observed are conditioned on the
gate's own verdict and a false rejection never generates the evidence that would
expose it. `mode: shadow` admits everything and records the verdict without
acting on it, which makes the verdict a prediction that the run either confirms
or refutes.

Two limits are deliberate. Shadow mode waives the model's verdict but not a
fail-closed one, so `allowed_authors` still holds: without that, anyone able to
open an Issue could put text in front of an agent with write access. And it is
only defensible while the night agent opens pull requests rather than merging
them, which bounds the cost of a wrong admission to a closed PR.

A question can also be recorded without being enforced (`enforced: false`). Its
answers land in the audit payload under `recorded_only` and change nothing, so a
new check can be measured against the ones that already work before it is given
a vote.

## Replaying a corpus

`evaluate` is pure and takes probabilities, not Issues, so a recorded answer can
be scored against any policy. Retuning a threshold by calling Jev again mixes
the change under test with the model's own run-to-run variation and costs a
request per experiment; `--replay` removes both and needs no credentials.

The corpus is collected from the gate's own output: the audit comment already
carries every probability as JSON. `fixtures/hexbound/` holds the nine
recordings the current thresholds were set from, and the tests pin the label
each produces, so a future retune has to state what it does to real Issues.

`--outcomes` scores a replay against what the night run actually did.
`fixtures/hexbound/outcomes.json` records, per Issue, whether the run succeeded
or failed, the cause of a failure, and the evidence for that reading. A replay
carrying it prints a scoreboard rather than a label table, and separates the two
errors that are not equally bad: an Issue refused that would have succeeded is
work lost silently, while an Issue admitted that failed costs a closed PR. It
also counts how many of the admitted-but-failed cases had a cause the Issue text
could have shown, since a failure the text cannot predict is not the gate's to
catch.

## What the corpus measured

The first pass set thresholds from six Issues with no ground truth behind them,
reading each check's spread as evidence that it discriminated. On 2026-09-21 all
nine Issues ran through the night queue in shadow mode, and the verdicts could
finally be compared against what happened. Of nine checks, one predicted
anything.

- `dependency_blocked` found the real chain. The two Issues that failed waiting
  on unmerged work scored 0.75 and 0.83; every other Issue scored 0.24 or below,
  including the third failure, which failed for an unrelated reason.
- `acceptance_criteria_clear` and `acceptance_criteria_verifiable` are inverted.
  They gave the three failures 0.93-0.95 and 0.89-0.93, their highest marks in
  the set. The best-specified Issues were the ones that did not get done, which
  makes sense once stated: a large, carefully specified Issue is carefully
  specified because it is large.
- `requires_human_decision` is inverted too, averaging 0.60 across the successes
  and 0.35 across the failures, so its maximum bar refuses the wrong half.
- `scope_small_enough` overlaps completely, 0.11-0.81 on successes against
  0.30-0.51 on failures, and gave its lowest score of all to an Issue that
  finished.
- `safe_for_unattended_execution` returned 0.59-0.93 across nine changes that
  were all equally safe: 0.81 mean on the successes, 0.80 on the failures.
- The three repository-local checks hexbound added, `executor_can_handle` among
  them, separated nothing either, which is the argument for `enforced: false`
  rather than against adding them.

So every check but `dependency_blocked` is now recorded and not enforced. They
keep being asked and keep landing in the payload, and any of them earns a vote
the moment its answers start tracking outcomes.

Measured on the nine recordings, the recalibrated policy gets 8 of 9 right with
nothing refused that would have succeeded. The previous policy got 3 of 9 and
refused six Issues that went on to produce pull requests — it admitted nothing
at all, which scores well on the failures for no reason worth keeping.

### What the failures actually were

Two of the three were dependencies, which is an Issue property and the one thing
the gate caught. The third was the executor exhausting its 40-call tool budget
mid-run, which is a property of the runner. No question asked about Issue text
can predict that, and a check that appears to is reading Issue length — which is
the mistake `scope_small_enough` already makes.

### The queue's own report is not ground truth

The queue recorded five failures; six Issues produced a pull request. It called
#218 `worker_output_invalid` because the parent task returned without its final
JSON, while the child it had delegated to kept running and opened PR #232
afterwards. It called #224 a tool-limit cancellation, but the cancellation
landed during browser verification, after the implementation and its tests were
done, and PR #233 followed.

The first version of `outcomes.json` took the queue's report at face value and
scored two successes as failures. Both corrections went to Issues the gate had
admitted, so the error made the gate look worse than it was — but it could as
easily have run the other way, and a check tuned against it would have learned
to predict the runner's bookkeeping rather than whether the work got done.
Ground truth here is whether a pull request implementing the Issue exists.

## Comparisons carry a tolerance

Thresholds and the dead band are hand-written decimals, and binary floating
point does not add them exactly: `0.9 + 0.05` is `0.9500000000000001`. Without a
tolerance, a policy author's own `0.95` would fall on the wrong side of the bar
they wrote. Comparisons absorb `1e-9`, far below any precision a probability
carries.

## Re-evaluation

The caller workflow triggers on `edited` as well as `opened`. An Issue that was
promoted and then weakened loses `night-queue` again, because labels are
*reconciled* rather than added: the gate computes the set of labels the Issue
should carry and removes the ones it owns that are not in it. Labels outside the
managed set are never touched.

The audit comment is found by a marker (`<!-- issue-gate:v1 -->`) and edited in
place, so an Issue evaluated ten times still carries one comment — and the
latest evaluation is always the one on display.

## Untrusted Issue content

A `READY` result hands an Issue to an unattended agent with write access, which
makes Issue text a privilege-escalation path rather than merely input.

- `allowed_authors` runs before Jev, as a deterministic check. Who can trigger
  an unattended run is not something a model should weigh in on.
- Each question states that the Issue is material to judge and that any
  instruction or claim of approval inside it is part of that material.
- The client never logs at `debug`, which would write request bodies —
  including Issue text — into Actions logs.
- The workflow uses the `issues` event, never `pull_request_target`, and never
  checks out untrusted refs.

## No database

Audit records live in the Issue comments, as the handoff specified. The JSON
payload carries the repository, Issue number, every probability, the outcome,
the label, the policy version, the model and the run URL — enough for a later
pass to correlate gate decisions with night-run outcomes by searching for the
marker across repositories.

## Open questions

- **One check decides.** `dependency_blocked` is the only question whose answers
  have tracked outcomes, so it is the only one enforced. That is honest about
  the evidence and thin as a gate: an Issue that is genuinely too vague to
  implement will be admitted today. The repair is more outcomes, not more
  confident thresholds — the previous policy's numbers were all defensible when
  written and all wrong when measured.
- **The runner's failures are invisible here.** One of three failures came from
  the executor, not the Issue. A gate reading Issue text cannot see a tool-call
  limit coming, and a check that tries will learn to reject long Issues, which
  is the mistake `scope_small_enough` already made.
- **Ground truth costs more than it looks.** It was collected by hand from the
  repository's pull requests, because the queue's own success and failure
  reports disagreed with them on two of nine Issues. A larger corpus needs that
  reconciliation automated, or it will encode the runner's bookkeeping.
- **`safe_for_unattended_execution` maps to `HUMAN_REVIEW`.** It could argue for
  `BLOCKED`. `HUMAN_REVIEW` was chosen because the Issue is usually actionable
  once a person looks at it, whereas `BLOCKED` implies waiting on something
  external. The check is unenforced, so the mapping is not currently load-bearing.
