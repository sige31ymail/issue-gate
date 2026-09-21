import { describe, expect, it } from 'vitest';
import { classify, evaluate, failClosed, isAuthorAllowed } from '../src/gate/evaluate.js';
import type { CheckPolicy, Policy } from '../src/policy/types.js';

const labels = {
  night_ready: 'night-ready',
  needs_detail: 'needs-detail',
  needs_split: 'needs-split',
  human_review: 'human-review',
  blocked: 'blocked',
};

function policy(checks: Record<string, CheckPolicy>, deadBand = 0.05): Policy {
  return {
    version: 1,
    gate: 'night-ready',
    labels,
    dead_band: deadBand,
    allowed_authors: [],
    max_issue_chars: 12000,
    checks,
  };
}

const minCheck: CheckPolicy = {
  kind: 'noul',
  min_yes_probability: 0.9,
  outcome: 'NEEDS_DETAIL',
  instructions: 'q',
};

const maxCheck: CheckPolicy = {
  kind: 'noul',
  max_yes_probability: 0.1,
  outcome: 'BLOCKED',
  instructions: 'q',
};

describe('classify', () => {
  it('passes a min check only above the dead band', () => {
    expect(classify(0.96, minCheck, 0.05)).toBe('PASS');
    expect(classify(0.95, minCheck, 0.05)).toBe('PASS');
  });

  it('treats a min check as ambiguous while it straddles the threshold', () => {
    // Above the threshold but still inside the band: passing the raw comparison
    // is not enough to admit an Issue to unattended execution.
    expect(classify(0.92, minCheck, 0.05)).toBe('AMBIGUOUS');
    expect(classify(0.9, minCheck, 0.05)).toBe('AMBIGUOUS');
    expect(classify(0.86, minCheck, 0.05)).toBe('AMBIGUOUS');
  });

  it('fails a min check below the dead band', () => {
    expect(classify(0.84, minCheck, 0.05)).toBe('FAIL');
    expect(classify(0, minCheck, 0.05)).toBe('FAIL');
  });

  it('passes a max check only below the dead band', () => {
    expect(classify(0.05, maxCheck, 0.05)).toBe('PASS');
    expect(classify(0, maxCheck, 0.05)).toBe('PASS');
  });

  it('treats a max check as ambiguous while it straddles the threshold', () => {
    expect(classify(0.06, maxCheck, 0.05)).toBe('AMBIGUOUS');
    expect(classify(0.15, maxCheck, 0.05)).toBe('AMBIGUOUS');
  });

  it('fails a max check above the dead band', () => {
    expect(classify(0.16, maxCheck, 0.05)).toBe('FAIL');
    expect(classify(1, maxCheck, 0.05)).toBe('FAIL');
  });

  it('raises the effective bar by the dead band', () => {
    // A policy author writing min 0.90 with a 0.05 band is asking for 0.95.
    // The handoff's own worked example (0.94 against a 0.90 threshold) lands
    // inside the band and therefore does not reach READY.
    expect(classify(0.94, minCheck, 0.05)).toBe('AMBIGUOUS');
    expect(classify(0.95, minCheck, 0.05)).toBe('PASS');
  });

  it('is not defeated by binary floating point at the exact bound', () => {
    // 0.9 + 0.05 is 0.9500000000000001 in IEEE 754.
    expect(classify(0.95, minCheck, 0.05)).toBe('PASS');
    expect(classify(0.85, minCheck, 0.05)).toBe('AMBIGUOUS');
    expect(classify(0.3, { ...minCheck, min_yes_probability: 0.2 }, 0.1)).toBe('PASS');
  });

  it('reduces to a plain comparison when the dead band is zero', () => {
    expect(classify(0.9, minCheck, 0)).toBe('PASS');
    expect(classify(0.8999, minCheck, 0)).toBe('FAIL');
    expect(classify(0.1, maxCheck, 0)).toBe('PASS');
    expect(classify(0.1001, maxCheck, 0)).toBe('FAIL');
  });
});

describe('evaluate', () => {
  it('returns READY when every check clears its dead band', () => {
    const decision = evaluate(policy({ a: minCheck, b: maxCheck }), { a: 0.97, b: 0.02 });
    expect(decision.outcome).toBe('READY');
    expect(decision.checks.every((c) => c.status === 'PASS')).toBe(true);
  });

  it('records the probability as P(true) regardless of the threshold direction', () => {
    const decision = evaluate(policy({ b: maxCheck }), { b: 0.02 });
    expect(decision.checks[0]?.probability).toBe(0.02);
    expect(decision.checks[0]?.threshold).toBe('<= 0.10 (±0.05)');
  });

  it('withholds READY when a single check is ambiguous', () => {
    const decision = evaluate(policy({ a: minCheck, b: maxCheck }), { a: 0.92, b: 0.02 });
    expect(decision.outcome).toBe('HUMAN_REVIEW');
    expect(decision.checks.find((c) => c.name === 'a')?.status).toBe('AMBIGUOUS');
  });

  it('picks the most severe outcome when several checks fail', () => {
    const decision = evaluate(policy({ a: minCheck, b: maxCheck }), { a: 0.1, b: 0.9 });
    // NEEDS_DETAIL and BLOCKED both failed; BLOCKED outranks it.
    expect(decision.outcome).toBe('BLOCKED');
  });

  it('prefers a failure over an ambiguity', () => {
    const decision = evaluate(policy({ a: minCheck, b: maxCheck }), { a: 0.92, b: 0.9 });
    expect(decision.outcome).toBe('BLOCKED');
  });

  it('fails closed when an answer is missing', () => {
    const decision = evaluate(policy({ a: minCheck, b: maxCheck }), { a: 0.97 });
    expect(decision.outcome).toBe('HUMAN_REVIEW');
    expect(decision.checks.find((c) => c.name === 'b')?.status).toBe('FAIL');
  });

  it('fails closed when an answer is not a finite number', () => {
    const decision = evaluate(policy({ a: minCheck }), { a: Number.NaN });
    expect(decision.outcome).toBe('HUMAN_REVIEW');
  });

  it('never returns READY from failClosed', () => {
    const decision = failClosed('Jev request failed');
    expect(decision.outcome).toBe('HUMAN_REVIEW');
    expect(decision.error).toBe('Jev request failed');
    expect(decision.checks).toEqual([]);
  });

  it('reports every configured check even when all pass', () => {
    const decision = evaluate(policy({ a: minCheck, b: maxCheck }), { a: 0.99, b: 0.01 });
    expect(decision.checks.map((c) => c.name).sort()).toEqual(['a', 'b']);
  });
});

describe('isAuthorAllowed', () => {
  const withAuthors = (authors: string[]): Policy => ({
    ...policy({ a: minCheck }),
    allowed_authors: authors,
  });

  it('allows every author when the list is empty', () => {
    expect(isAuthorAllowed(withAuthors([]), 'anyone')).toBe(true);
    expect(isAuthorAllowed(withAuthors([]), '')).toBe(true);
  });

  it('allows a listed author', () => {
    expect(isAuthorAllowed(withAuthors(['sige31ymail']), 'sige31ymail')).toBe(true);
  });

  it('rejects an author who is not listed', () => {
    expect(isAuthorAllowed(withAuthors(['sige31ymail']), 'someone-else')).toBe(false);
  });

  it('matches a GitHub App by its bracketed login', () => {
    // The API reports an App as "<app>[bot]". A policy listing a bare "claude"
    // would silently reject every Issue the app writes.
    const p = withAuthors(['sige31ymail', 'claude[bot]']);
    expect(isAuthorAllowed(p, 'claude[bot]')).toBe(true);
    expect(isAuthorAllowed(p, 'claude')).toBe(false);
  });

  it('does not match on a prefix or a different case', () => {
    const p = withAuthors(['claude[bot]']);
    expect(isAuthorAllowed(p, 'claude[bot]x')).toBe(false);
    expect(isAuthorAllowed(p, 'Claude[bot]')).toBe(false);
  });

  it('rejects an empty author when a list is configured', () => {
    expect(isAuthorAllowed(withAuthors(['sige31ymail']), '')).toBe(false);
  });
});
