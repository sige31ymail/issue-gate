import { describe, expect, it } from 'vitest';
import { loadPolicyFile, mergePolicy, parseOverride, PolicyError, validatePolicy } from '../src/policy/load.js';
import { labelForOutcome, managedLabels } from '../src/policy/types.js';

const base = {
  version: 1,
  gate: 'night-ready',
  labels: {
    night_ready: 'night-ready',
    needs_detail: 'needs-detail',
    needs_split: 'needs-split',
    human_review: 'human-review',
    blocked: 'blocked',
  },
  dead_band: 0.05,
  allowed_authors: ['sige31ymail'],
  max_issue_chars: 12000,
  checks: {
    scope_small_enough: {
      kind: 'noul',
      min_yes_probability: 0.9,
      outcome: 'NEEDS_SPLIT',
      instructions: 'q',
    },
    dependency_blocked: {
      kind: 'noul',
      max_yes_probability: 0.1,
      outcome: 'BLOCKED',
      instructions: 'q',
    },
  },
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('validatePolicy', () => {
  it('accepts the shipped shape', () => {
    const policy = validatePolicy(clone(base));
    expect(Object.keys(policy.checks)).toHaveLength(2);
    expect(policy.labels.night_ready).toBe('night-ready');
  });

  it('rejects a check carrying both bounds', () => {
    const raw = clone(base) as Record<string, any>;
    raw['checks']['scope_small_enough']['max_yes_probability'] = 0.5;
    expect(() => validatePolicy(raw)).toThrow(PolicyError);
  });

  it('rejects a check carrying neither bound', () => {
    const raw = clone(base) as Record<string, any>;
    delete raw['checks']['scope_small_enough']['min_yes_probability'];
    expect(() => validatePolicy(raw)).toThrow(PolicyError);
  });

  it('rejects a probability outside 0..1', () => {
    const raw = clone(base) as Record<string, any>;
    raw['checks']['scope_small_enough']['min_yes_probability'] = 1.5;
    expect(() => validatePolicy(raw)).toThrow(PolicyError);
  });

  it('rejects an unknown outcome', () => {
    const raw = clone(base) as Record<string, any>;
    raw['checks']['scope_small_enough']['outcome'] = 'MAYBE';
    expect(() => validatePolicy(raw)).toThrow(PolicyError);
  });

  it('rejects a missing label', () => {
    const raw = clone(base) as Record<string, any>;
    delete raw['labels']['night_ready'];
    expect(() => validatePolicy(raw)).toThrow(PolicyError);
  });

  it('rejects an unsupported version', () => {
    const raw = clone(base) as Record<string, any>;
    raw['version'] = 2;
    expect(() => validatePolicy(raw)).toThrow(PolicyError);
  });

  it('rejects an empty check set', () => {
    const raw = clone(base) as Record<string, any>;
    raw['checks'] = {};
    expect(() => validatePolicy(raw)).toThrow(PolicyError);
  });
});

describe('mergePolicy', () => {
  it('returns the base policy when there is no override', () => {
    const policy = validatePolicy(clone(base));
    expect(mergePolicy(policy, null)).toBe(policy);
  });

  it('retunes a single threshold without touching the rest of the check', () => {
    const policy = validatePolicy(clone(base));
    const merged = mergePolicy(policy, {
      checks: { scope_small_enough: { min_yes_probability: 0.85 } },
    });
    expect(merged.checks['scope_small_enough']?.min_yes_probability).toBe(0.85);
    expect(merged.checks['scope_small_enough']?.outcome).toBe('NEEDS_SPLIT');
    expect(merged.checks['scope_small_enough']?.instructions).toBe('q');
  });

  it('swaps the bound direction without leaving both set', () => {
    const policy = validatePolicy(clone(base));
    const merged = mergePolicy(policy, {
      checks: { scope_small_enough: { max_yes_probability: 0.2 } },
    });
    expect(merged.checks['scope_small_enough']?.max_yes_probability).toBe(0.2);
    expect(merged.checks['scope_small_enough']?.min_yes_probability).toBeUndefined();
  });

  it('adds a repository-specific check', () => {
    const policy = validatePolicy(clone(base));
    const merged = mergePolicy(policy, {
      additional_checks: {
        ui_verification_defined: {
          kind: 'noul',
          min_yes_probability: 0.9,
          outcome: 'NEEDS_DETAIL',
          instructions: 'q',
        },
      },
    });
    expect(Object.keys(merged.checks)).toHaveLength(3);
  });

  it('refuses to patch a check the shared policy does not define', () => {
    const policy = validatePolicy(clone(base));
    expect(() =>
      mergePolicy(policy, { checks: { nonexistent: { min_yes_probability: 0.5 } } }),
    ).toThrow(PolicyError);
  });

  it('refuses an additional check that collides with a shared one', () => {
    const policy = validatePolicy(clone(base));
    expect(() =>
      mergePolicy(policy, {
        additional_checks: {
          scope_small_enough: {
            kind: 'noul',
            min_yes_probability: 0.1,
            outcome: 'NEEDS_DETAIL',
            instructions: 'q',
          },
        },
      }),
    ).toThrow(PolicyError);
  });

  it('leaves the base policy unmutated', () => {
    const policy = validatePolicy(clone(base));
    mergePolicy(policy, { checks: { scope_small_enough: { min_yes_probability: 0.94 } } });
    expect(policy.checks['scope_small_enough']?.min_yes_probability).toBe(0.9);
  });

  it('cannot drop a shared check', () => {
    const policy = validatePolicy(clone(base));
    const merged = mergePolicy(policy, { dead_band: 0.08 });
    expect(Object.keys(merged.checks).sort()).toEqual(['dependency_blocked', 'scope_small_enough']);
  });
});

describe('parseOverride', () => {
  it('treats absent and empty files as no override', () => {
    expect(parseOverride(null)).toBeNull();
    expect(parseOverride('')).toBeNull();
    expect(parseOverride('   \n')).toBeNull();
    expect(parseOverride('# only a comment\n')).toBeNull();
  });

  it('parses a small override', () => {
    expect(parseOverride('dead_band: 0.1\n')).toEqual({ dead_band: 0.1 });
  });
});

describe('threshold reachability', () => {
  it('rejects a min threshold the dead band pushes to 1.00', () => {
    const raw = clone(base);
    raw.checks.scope_small_enough.min_yes_probability = 0.95;
    expect(() => validatePolicy(raw)).toThrow(/no answer reaches/);
  });

  it('rejects a max threshold the dead band pushes to 0.00', () => {
    const raw = clone(base);
    raw.checks.dependency_blocked.max_yes_probability = 0.05;
    expect(() => validatePolicy(raw)).toThrow(/no answer reaches/);
  });

  it('accepts a threshold that lands just inside the range', () => {
    const raw = clone(base);
    raw.checks.scope_small_enough.min_yes_probability = 0.94;
    expect(validatePolicy(raw).checks['scope_small_enough']?.min_yes_probability).toBe(0.94);
  });

  it('rejects an override that widens the dead band past a threshold', () => {
    const policy = validatePolicy(clone(base));
    // The check itself is untouched; only the dead band moves, which is exactly
    // the case a per-check validation would miss.
    expect(() => mergePolicy(policy, { dead_band: 0.11 })).toThrow(/no answer reaches/);
  });

  it('rejects an additional check that cannot pass', () => {
    const policy = validatePolicy(clone(base));
    expect(() =>
      mergePolicy(policy, {
        additional_checks: {
          never_passes: {
            kind: 'noul',
            min_yes_probability: 0.96,
            outcome: 'HUMAN_REVIEW',
            instructions: 'q',
          },
        },
      }),
    ).toThrow(/no answer reaches/);
  });
});

describe('the shipped policy', () => {
  it('loads and validates', async () => {
    const policy = await loadPolicyFile(new URL('../policies/night-ready.yml', import.meta.url).pathname);
    expect(policy.gate).toBe('night-ready');
    expect(Object.keys(policy.checks)).toEqual([
      'scope_small_enough',
      'acceptance_criteria_clear',
      'acceptance_criteria_verifiable',
      'requires_human_decision',
      'dependency_blocked',
      'safe_for_unattended_execution',
    ]);
  });

  it('uses the label night-issues actually consumes', async () => {
    // Pinned so a rename is a deliberate change with a failing test, not a
    // silent drift away from what the night queue reads.
    const policy = await loadPolicyFile(new URL('../policies/night-ready.yml', import.meta.url).pathname);
    expect(policy.labels.night_ready).toBe('night-queue');
  });

  it('keeps every threshold reachable once the dead band is added', async () => {
    // The first live run returned 0.91 on safe_for_unattended_execution and the
    // gate still refused it: the bar had been 0.95 + 0.05 = 1.00. Pinned so the
    // gate cannot silently become one that never says READY.
    const policy = await loadPolicyFile(new URL('../policies/night-ready.yml', import.meta.url).pathname);
    for (const check of Object.values(policy.checks)) {
      if (check.min_yes_probability !== undefined) {
        expect(check.min_yes_probability + policy.dead_band).toBeLessThan(1);
      } else {
        expect((check.max_yes_probability as number) - policy.dead_band).toBeGreaterThan(0);
      }
    }
  });

  it('lets the Claude app through, since it writes most of the Issues', async () => {
    const policy = await loadPolicyFile(new URL('../policies/night-ready.yml', import.meta.url).pathname);
    expect(policy.allowed_authors).toContain('claude[bot]');
    expect(policy.allowed_authors).toContain('sige31ymail');
  });

  it('maps every outcome to a distinct managed label', async () => {
    const policy = await loadPolicyFile(new URL('../policies/night-ready.yml', import.meta.url).pathname);
    expect(labelForOutcome(policy.labels, 'BLOCKED')).toBe('blocked');
    expect(labelForOutcome(policy.labels, 'NEEDS_SPLIT')).toBe('needs-split');
    expect(new Set(managedLabels(policy.labels)).size).toBe(5);
  });
});

describe('the shipped policy routes to a nameable repair', () => {
  const load = () =>
    loadPolicyFile(new URL('../policies/night-ready.yml', import.meta.url).pathname);

  it('reserves human-review for checks a person must actually settle', async () => {
    // Four failure labels exist; two of them only appear when no check mapped to
    // HUMAN_REVIEW fails. A quality check sitting on HUMAN_REVIEW therefore
    // silences them, which is what requires_human_decision used to do.
    const policy = await load();
    const humanReview = Object.entries(policy.checks)
      .filter(([, c]) => c.outcome === 'HUMAN_REVIEW')
      .map(([name]) => name);
    expect(humanReview).toEqual(['safe_for_unattended_execution']);
  });

  it('states thresholds as the value an answer must reach', async () => {
    const policy = await load();
    expect(policy.dead_band).toBe(0);
  });

  it('treats answers near a coin flip as carrying no signal', async () => {
    const policy = await load();
    expect(policy.ambiguity_band).toBeGreaterThan(0);
  });
});

describe('enforced', () => {
  it('rejects a policy where every check is recorded only', () => {
    // Nothing fails, nothing is ambiguous, so every Issue comes back READY.
    // The one configuration that fails open.
    const raw = clone(base);
    (raw.checks.scope_small_enough as Record<string, unknown>)['enforced'] = false;
    (raw.checks.dependency_blocked as Record<string, unknown>)['enforced'] = false;
    expect(() => validatePolicy(raw)).toThrow(/at least one check must be enforced/);
  });

  it('rejects an override that turns off the last enforced check', () => {
    const raw = clone(base);
    (raw.checks.dependency_blocked as Record<string, unknown>)['enforced'] = false;
    const policy = validatePolicy(raw);
    expect(() =>
      mergePolicy(policy, { checks: { scope_small_enough: { enforced: false } } }),
    ).toThrow(/at least one check must be enforced/);
  });

  it('rejects a non-boolean enforced', () => {
    const raw = clone(base);
    (raw.checks.scope_small_enough as Record<string, unknown>)['enforced'] = 'no';
    expect(() => validatePolicy(raw)).toThrow(PolicyError);
  });

  it('accepts an additional check that only records', () => {
    const policy = validatePolicy(clone(base));
    const merged = mergePolicy(policy, {
      additional_checks: {
        executor_can_handle: {
          kind: 'noul',
          min_yes_probability: 0.7,
          outcome: 'HUMAN_REVIEW',
          instructions: 'q',
          enforced: false,
        },
      },
    });
    expect(merged.checks['executor_can_handle']?.enforced).toBe(false);
  });
});
