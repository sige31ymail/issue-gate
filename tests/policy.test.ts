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
      checks: { scope_small_enough: { min_yes_probability: 0.95 } },
    });
    expect(merged.checks['scope_small_enough']?.min_yes_probability).toBe(0.95);
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
    mergePolicy(policy, { checks: { scope_small_enough: { min_yes_probability: 0.99 } } });
    expect(policy.checks['scope_small_enough']?.min_yes_probability).toBe(0.9);
  });

  it('cannot drop a shared check', () => {
    const policy = validatePolicy(clone(base));
    const merged = mergePolicy(policy, { dead_band: 0.2 });
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

  it('maps every outcome to a distinct managed label', async () => {
    const policy = await loadPolicyFile(new URL('../policies/night-ready.yml', import.meta.url).pathname);
    expect(labelForOutcome(policy.labels, 'BLOCKED')).toBe('blocked');
    expect(labelForOutcome(policy.labels, 'NEEDS_SPLIT')).toBe('needs-split');
    expect(new Set(managedLabels(policy.labels)).size).toBe(5);
  });
});
