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

Each threshold is surrounded by a symmetric band. Inside it, the check is
`AMBIGUOUS` and the Issue gets `HUMAN_REVIEW`.

The consequence is worth stating plainly: **the dead band raises every bar.**
With `min_yes_probability: 0.90` and `dead_band: 0.05`, a check passes at 0.95,
not 0.90. The handoff's own worked example — `scope_small_enough` at 0.94
against a 0.90 threshold — lands inside the band and does *not* reach `READY`
under the shipped policy. That is intentional for a first run, where admitting
too few Issues is cheaper than admitting a bad one, but it is the first number
to revisit once there is real data. Set `dead_band: 0` to compare against the
raw threshold.

The alternative technique, self-consistency (asking each question several times
and looking at the spread), costs a request per repetition. It is worth
considering if the band proves too blunt, but it is not in the MVP.

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

- **Threshold calibration.** Every number in the shipped policy is a starting
  value. Six checks ANDed at 0.90–0.95, plus the dead band, will admit few
  Issues at first. That is the intended direction of error for a first run, but
  the point of the audit payload is to replace guesses with data.
- **`safe_for_unattended_execution` maps to `HUMAN_REVIEW`.** It could argue for
  `BLOCKED`. `HUMAN_REVIEW` was chosen because the Issue is usually actionable
  once a person looks at it, whereas `BLOCKED` implies waiting on something
  external.
