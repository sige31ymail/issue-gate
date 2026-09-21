# issue-gate

A readiness gate in front of the night-time Issue automation.

`issue-gate` does not implement Issues. It judges whether an Issue is ready to be
handed to an unattended coding-agent run, and labels it accordingly. Issues that
pass get the label `night-issues` already consumes; everything else gets a label
saying what is missing.

## How it decides

Several narrow yes/no questions go to [Jev](https://docs.typesafe.ai), which
returns a probability for each. The final decision is then made in ordinary code
from those probabilities and a version-controlled policy. Jev is never asked
"is this a good Issue?" — the business logic stays out of the prompt and in
`policies/night-ready.yml`, where it can be read and reviewed.

All checks travel in a single API request, so evaluating an Issue costs one
round trip.

### Outcomes

| Outcome | Meaning | Label |
| --- | --- | --- |
| `READY` | Safe to run unattended | `night-queue` |
| `NEEDS_DETAIL` | Acceptance criteria are unclear or unverifiable | `needs-detail` |
| `NEEDS_SPLIT` | Too large for one run | `needs-split` |
| `HUMAN_REVIEW` | Needs a person's decision, or the model was undecided | `human-review` |
| `BLOCKED` | Waiting on a prerequisite | `blocked` |

When several checks fail at once, the most severe outcome wins:
`BLOCKED` > `HUMAN_REVIEW` > `NEEDS_SPLIT` > `NEEDS_DETAIL`.

### Undecided answers

A `noul` answer is a probability and carries no confidence value, so "the model
is undecided" has to be derived from the probability itself.

The first attempt put a dead band around each threshold and treated anything
inside it as undecided. Measured against real Issues that turned out to be the
wrong signal: 0.93 against a bar of 0.95 is a confident answer that falls short,
not a model on the fence. It also meant the written threshold and the effective
one differed, which produced a bar of 1.00 that nothing could reach.

Thresholds are now the value an answer must actually reach, and indecision is
measured where it lives — near 0.5. `ambiguity_band` is the half-width of that
band. An undecided check prevents `READY`, but never outranks a check that named
a concrete problem, so an Issue with a fixable fault is told what the fault is.

### Which label an Issue gets

Four failure labels exist, and the most severe one wins. That only routes
usefully while `HUMAN_REVIEW` stays rare: a quality check mapped to it will fail
on nearly every Issue, pin the result there, and make `NEEDS_SPLIT` and
`NEEDS_DETAIL` unreachable. The first live corpus did exactly that.

So a check whose failure the Issue's author can fix maps to `NEEDS_DETAIL` or
`NEEDS_SPLIT`, and `HUMAN_REVIEW` is reserved for the ones that genuinely need a
person — today, only the fail-closed paths.

### Recording a check before trusting it

A check with `enforced: false` is asked, scored and written into the audit
record, but cannot change the verdict. That is how a new question earns its
place: run it alongside the ones that decide, see whether its answers correlate
with anything, and only then give it a vote. Enforcing a question from its first
run means discovering afterwards whether it measured anything.

A policy where every check is unenforced is rejected at load time — nothing
would fail, so every Issue would come back `READY`.

### Shadow mode

`mode: shadow` records the verdict and admits the Issue to the night queue
anyway. It exists for one purpose: while the gate is enforcing, the only Issues
that ever run are the ones it already liked, so a wrongly rejected Issue never
produces the evidence that would show the rejection was wrong. Shadow mode
removes that blind spot, and the audit comment still states what the gate would
have decided, which is what a later calibration pass compares against.

It waives the model's verdict, never a fail-closed one. An Issue that could not
be judged — an author outside `allowed_authors`, a closed or empty Issue, Jev
unreachable, a malformed policy — is not admitted, because admitting on the
author check would let anyone who can open an Issue put text in front of an
agent that holds write access.

### Tuning thresholds

`evaluate` is pure, so a probability recorded once can be scored against any
number of policies. The gate writes every probability into the audit comment;
save those payloads and replay them:

```
npm run gate:local -- --replay fixtures/hexbound/*.json
```

No credentials, no requests, and no model variation mixed into the comparison.
`fixtures/hexbound/` holds the nine recordings the shipped thresholds were set
from, and `tests/replay.test.ts` pins the label each one produces.

A repository that adds its own checks runs a different policy from the one this
repository ships, so `--override` merges its file in and answers what that
repository actually does:

```
npm run gate:local -- --replay fixtures/hexbound/issue-*.json \
  --override fixtures/hexbound/override.yml
```

Answering without it is how a calibration can measure clean and change nothing.
On 2026-09-21 the shared policy was retuned to 8 of 9 on this corpus while
hexbound's own override still enforced a check that failed on all nine, so the
policy that actually ran there scored 3 of 9 and refused six Issues that went on
to open a pull request. An override cannot remove a shared check, which reads as
being unable to weaken the gate — but the most severe failing outcome wins, so
one added check that fails everywhere decides everything.

Add `--outcomes` to score those verdicts against what the night run actually
did:

```
npm run gate:local -- --replay fixtures/hexbound/*.json \
  --outcomes fixtures/hexbound/outcomes.json
```

That prints a scoreboard instead of a label table, and keeps the two kinds of
error apart: an Issue refused that would have succeeded is work lost silently,
while an Issue admitted that failed costs a closed PR.

### What the outcomes showed

All nine Issues ran on 2026-09-21 with the gate in shadow mode, and six produced
a pull request. Of nine checks, exactly one predicted anything.
`dependency_blocked` found the real chain: 0.75 and 0.83 for the two Issues that
failed waiting on unmerged work, 0.24 or below for everything else.

Three checks are inverted. The two acceptance-criteria questions gave the
failures their highest marks in the set, 0.93-0.95 and 0.89-0.93 — the
best-specified Issues were the ones that did not get done.
`requires_human_decision` averaged 0.60 across the successes and 0.35 across the
failures, so its bar refuses the wrong half. The rest carried no signal at all.

Every check but `dependency_blocked` is therefore recorded and not enforced.
They keep being asked and keep landing in the payload, and any of them earns a
vote once its answers start tracking outcomes. The recalibrated policy scores
8 of 9 with nothing refused that would have succeeded; the previous one scored
3 of 9 and refused six Issues that went on to produce pull requests.

The one remaining miss came from the executor rather than the Issue: it
exhausted its 40-call tool budget mid-run. No question about Issue text can
predict that.

Ground truth was read from the repository's pull requests, not from the queue's
own report, because the two disagree. The queue called two Issues failures that
had in fact produced a PR. See [`docs/architecture.md`](docs/architecture.md).

### Fail closed

Anything that prevents a clean decision — Jev unreachable, a malformed policy, a
missing answer, an Issue from an author outside `allowed_authors` — produces
`HUMAN_REVIEW`, never `READY`. A failure can never promote an Issue into the
night queue.

## Adding a repository

1. Add `TYPESAFE_API_KEY` to that repository's **Actions secrets**
   (Settings → Secrets and variables → Actions). The key belongs to each target
   repository, not to `issue-gate`: the workflow runs in the target
   repository's context.

2. Copy [`examples/caller-workflow.yml`](examples/caller-workflow.yml) into the
   repository as `.github/workflows/issue-gate.yml`. That file is the entire
   per-repository footprint — the policy, the questions and the decision logic
   all stay here.

3. Add the author to `allowed_authors` in `policies/night-ready.yml` if it is
   someone new.

The target repository can be private. Only `issue-gate` itself has to be public,
because GitHub only allows sharing a *private* repository's actions within an
organization — a restriction on the repository hosting the action, not on the
one calling it.

### Repository-specific overrides

Optional, and they live in the **target** repository as `.github/issue-gate.yml`
so a private repository's conventions stay private. See
[`examples/repository-override.yml`](examples/repository-override.yml).

An override may retune scalars, patch fields of an existing check, and add new
checks. It cannot delete a shared check, so a repository cannot quietly opt out
of the gate.

## The audit record

Every evaluated Issue carries one `issue-gate` comment, edited in place on each
re-run rather than appended to. It shows each check's probability, threshold and
result, and embeds a compact JSON payload for later aggregation:

```json
{
  "gate_version": 1,
  "result": "READY",
  "repository": "sige31ymail/hexbound",
  "issue_number": 123,
  "checks": { "scope_small_enough": 0.96, "dependency_blocked": 0.03 },
  "label_applied": "night-queue",
  "policy_version": "v1",
  "model": "jev-1.13.0",
  "run_url": "https://github.com/...",
  "evaluated_at": "2026-09-21T09:00:00.000Z",
  "error": null
}
```

The probabilities route the decision. They are **not** a measure of how often
the gate is correct.

## Tuning thresholds locally

Evaluate a real Issue without writing anything:

```sh
export TYPESAFE_API_KEY=...   # your Jev key
export GITHUB_TOKEN=...       # read-only is enough
npm run gate:local -- --repo sige31ymail/hexbound --issue 12
```

Add `--json` for machine-readable output, or `--policy <path>` to try a
different policy file. Edit `policies/night-ready.yml`, re-run, compare.

## Security notes

An Issue body is untrusted input, and a `READY` result is what admits an Issue
to an unattended run with repository write access. Three things follow:

- `allowed_authors` is a deterministic check that runs **before** Jev. Who can
  trigger an unattended run is not a model judgment.
- Every question tells the model that the Issue is material to judge, not
  instructions to follow, so text inside an Issue cannot argue for its own
  promotion.
- The Jev client never runs at `debug` log level, which would put Issue bodies
  into Actions logs unredacted.

The workflow triggers on `issues`, never `pull_request_target`, and needs only
`contents: read` and `issues: write`.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build      # bundles to dist/, which is committed
```

`dist/` is committed because GitHub Actions runs the bundle directly. Rebuild
and commit it with any source change.

## Layout

```
issue-gate/
├─ action.yml                     composite action manifest
├─ policies/night-ready.yml       the shared policy — every number lives here
├─ src/
│  ├─ index.ts                    action entrypoint
│  ├─ local.ts                    local dry run
│  ├─ policy/                     schema, validation, override merge
│  ├─ jev/                        adapter interface + Jev implementation
│  ├─ gate/                       deterministic evaluation (pure)
│  ├─ github/                     Issue read, label reconcile, comment upsert
│  └─ render.ts                   audit comment
├─ tests/
├─ examples/
└─ docs/architecture.md
```

See [docs/architecture.md](docs/architecture.md) for the reasoning behind the
structure and the open questions.
