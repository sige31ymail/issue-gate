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
| `READY` | Safe to run unattended | `night-ready` |
| `NEEDS_DETAIL` | Acceptance criteria are unclear or unverifiable | `needs-detail` |
| `NEEDS_SPLIT` | Too large for one run | `needs-split` |
| `HUMAN_REVIEW` | Needs a person's decision, or the model was undecided | `human-review` |
| `BLOCKED` | Waiting on a prerequisite | `blocked` |

When several checks fail at once, the most severe outcome wins:
`BLOCKED` > `HUMAN_REVIEW` > `NEEDS_SPLIT` > `NEEDS_DETAIL`.

### The dead band, and why thresholds are not the whole story

A `noul` answer is a probability and carries no confidence value, so "the model
is undecided" has to be derived from the probability itself. Each threshold is
surrounded by a dead band; a result landing inside it yields `HUMAN_REVIEW`
rather than `READY`.

**This raises the effective bar.** A check with `min_yes_probability: 0.90` and
`dead_band: 0.05` only passes at 0.95. Both numbers appear in the audit comment
so the arithmetic is never hidden. Set `dead_band: 0` to compare against the raw
threshold instead.

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
  "label_applied": "night-ready",
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
