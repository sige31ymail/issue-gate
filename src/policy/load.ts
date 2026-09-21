import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import {
  FAILURE_OUTCOMES,
  type CheckPolicy,
  type FailureOutcome,
  type Policy,
  type PolicyOverride,
} from './types.js';

/** Raised when a policy file is malformed. The caller fails closed on it. */
export class PolicyError extends Error {}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new PolicyError(message);
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isFailureOutcome(value: unknown): value is FailureOutcome {
  return FAILURE_OUTCOMES.includes(value as FailureOutcome);
}

function validateCheck(name: string, check: unknown): CheckPolicy {
  assert(check && typeof check === 'object', `check "${name}" must be a mapping`);
  const c = check as Record<string, unknown>;

  assert(c['kind'] === 'noul', `check "${name}": only kind "noul" is supported`);

  const hasMin = c['min_yes_probability'] !== undefined;
  const hasMax = c['max_yes_probability'] !== undefined;
  assert(
    hasMin !== hasMax,
    `check "${name}": set exactly one of min_yes_probability / max_yes_probability`,
  );
  if (hasMin) {
    assert(
      isProbability(c['min_yes_probability']),
      `check "${name}": min_yes_probability must be between 0 and 1`,
    );
  }
  if (hasMax) {
    assert(
      isProbability(c['max_yes_probability']),
      `check "${name}": max_yes_probability must be between 0 and 1`,
    );
  }

  assert(
    isFailureOutcome(c['outcome']),
    `check "${name}": outcome must be one of ${FAILURE_OUTCOMES.join(', ')}`,
  );
  assert(
    typeof c['instructions'] === 'string' && c['instructions'].trim() !== '',
    `check "${name}": instructions is required`,
  );

  const criteria = c['criteria'] as CheckPolicy['criteria'];
  if (criteria !== undefined && criteria !== null) {
    assert(typeof criteria === 'object', `check "${name}": criteria must be a mapping`);
  }

  const enforced = c['enforced'];
  assert(
    enforced === undefined || typeof enforced === 'boolean',
    `check "${name}": enforced must be true or false`,
  );

  const result: CheckPolicy = {
    kind: 'noul',
    outcome: c['outcome'],
    instructions: c['instructions'],
  };
  if (enforced === false) result.enforced = false;
  if (hasMin) result.min_yes_probability = c['min_yes_probability'] as number;
  if (hasMax) result.max_yes_probability = c['max_yes_probability'] as number;
  if (criteria) result.criteria = criteria;
  return result;
}

/** Matches the tolerance {@link classify} uses, so the two agree at the bound. */
const EPSILON = 1e-9;

/**
 * Reject a threshold the dead band has pushed out of reach.
 *
 * `classify` passes a min check at `min + dead_band` and a max check at
 * `max - dead_band`, so a policy can quietly define a check nothing can satisfy:
 * min 0.95 with a dead band of 0.05 demands a probability of exactly 1.00. The
 * gate then never reaches READY and the reason is invisible in the audit record,
 * because every line reads as a legitimate AMBIGUOUS. A passing range that has
 * collapsed to a single point is an authoring mistake, not a strict policy.
 */
function assertReachable(name: string, check: CheckPolicy, deadBand: number): void {
  if (check.min_yes_probability !== undefined) {
    const bar = check.min_yes_probability + deadBand;
    assert(
      bar < 1 - EPSILON,
      `check "${name}": min_yes_probability ${check.min_yes_probability} with dead_band ` +
        `${deadBand} can only pass at P(true) >= ${bar.toFixed(2)}, which no answer reaches`,
    );
    return;
  }
  const bar = (check.max_yes_probability as number) - deadBand;
  assert(
    bar > EPSILON,
    `check "${name}": max_yes_probability ${check.max_yes_probability} with dead_band ` +
      `${deadBand} can only pass at P(true) <= ${bar.toFixed(2)}, which no answer reaches`,
  );
}

/**
 * Refuse a policy where nothing can decide anything.
 *
 * Every check set to `enforced: false` leaves no failing check to find and no
 * ambiguous one either, so the gate returns READY for every Issue it is given.
 * That is the one configuration that fails open, and it reads as a working
 * policy right up until an Issue is admitted.
 */
function assertSomethingDecides(checks: Record<string, CheckPolicy>): void {
  assert(
    Object.values(checks).some((c) => c.enforced !== false),
    'policy: at least one check must be enforced, or every Issue is admitted',
  );
}

/** Validate a parsed base policy, filling in nothing — every field is explicit in YAML. */
export function validatePolicy(raw: unknown): Policy {
  assert(raw && typeof raw === 'object', 'policy must be a mapping');
  const p = raw as Record<string, unknown>;

  assert(p['version'] === 1, 'policy: only version 1 is supported');
  assert(typeof p['gate'] === 'string', 'policy: gate must be a string');
  assert(
    isProbability(p['dead_band']),
    'policy: dead_band must be between 0 and 1',
  );
  // Absent means no undecided band, which is how a policy written before the
  // field existed behaves.
  const ambiguityBand = p['ambiguity_band'] ?? 0;
  assert(
    isProbability(ambiguityBand),
    'policy: ambiguity_band must be between 0 and 1',
  );
  assert(
    typeof p['max_issue_chars'] === 'number' && p['max_issue_chars'] > 0,
    'policy: max_issue_chars must be a positive number',
  );

  const authors = p['allowed_authors'] ?? [];
  assert(
    Array.isArray(authors) && authors.every((a) => typeof a === 'string'),
    'policy: allowed_authors must be a list of strings',
  );

  const labels = p['labels'] as Record<string, unknown> | undefined;
  assert(labels && typeof labels === 'object', 'policy: labels is required');
  for (const key of ['night_ready', 'needs_detail', 'needs_split', 'human_review', 'blocked']) {
    assert(
      typeof labels[key] === 'string' && (labels[key] as string).trim() !== '',
      `policy: labels.${key} is required`,
    );
  }

  const rawChecks = p['checks'] as Record<string, unknown> | undefined;
  assert(rawChecks && typeof rawChecks === 'object', 'policy: checks is required');
  const names = Object.keys(rawChecks);
  assert(names.length > 0, 'policy: at least one check is required');

  const checks: Record<string, CheckPolicy> = {};
  for (const name of names) {
    checks[name] = validateCheck(name, rawChecks[name]);
    assertReachable(name, checks[name] as CheckPolicy, p['dead_band'] as number);
  }
  assertSomethingDecides(checks);

  return {
    version: 1,
    gate: p['gate'] as string,
    labels: {
      night_ready: labels['night_ready'] as string,
      needs_detail: labels['needs_detail'] as string,
      needs_split: labels['needs_split'] as string,
      human_review: labels['human_review'] as string,
      blocked: labels['blocked'] as string,
    },
    dead_band: p['dead_band'] as number,
    ambiguity_band: ambiguityBand as number,
    allowed_authors: authors as string[],
    max_issue_chars: p['max_issue_chars'] as number,
    checks,
  };
}

/**
 * Merge a repository override onto the shared policy.
 *
 * Overrides stay small on purpose: they may retune scalars, patch individual
 * fields of an existing check, and add repository-specific checks. They cannot
 * delete a shared check, so a repository cannot quietly opt out of the gate.
 */
export function mergePolicy(base: Policy, override: PolicyOverride | null): Policy {
  if (!override) return base;

  const merged: Policy = {
    ...base,
    labels: { ...base.labels, ...(override.labels ?? {}) },
    checks: { ...base.checks },
  };

  if (override.dead_band !== undefined) {
    assert(isProbability(override.dead_band), 'override: dead_band must be between 0 and 1');
    merged.dead_band = override.dead_band;
  }
  if (override.ambiguity_band !== undefined) {
    assert(
      isProbability(override.ambiguity_band),
      'override: ambiguity_band must be between 0 and 1',
    );
    merged.ambiguity_band = override.ambiguity_band;
  }
  if (override.allowed_authors !== undefined) {
    assert(
      Array.isArray(override.allowed_authors) &&
        override.allowed_authors.every((a) => typeof a === 'string'),
      'override: allowed_authors must be a list of strings',
    );
    merged.allowed_authors = override.allowed_authors;
  }
  if (override.max_issue_chars !== undefined) {
    assert(
      typeof override.max_issue_chars === 'number' && override.max_issue_chars > 0,
      'override: max_issue_chars must be a positive number',
    );
    merged.max_issue_chars = override.max_issue_chars;
  }

  for (const [name, patch] of Object.entries(override.checks ?? {})) {
    const existing = base.checks[name];
    assert(existing, `override: check "${name}" does not exist in the shared policy`);
    // A patch that supplies one bound must clear the other, so a check never ends
    // up carrying both a min and a max.
    const next: Record<string, unknown> = { ...existing, ...patch };
    if (patch.min_yes_probability !== undefined && patch.max_yes_probability === undefined) {
      delete next['max_yes_probability'];
    }
    if (patch.max_yes_probability !== undefined && patch.min_yes_probability === undefined) {
      delete next['min_yes_probability'];
    }
    merged.checks[name] = validateCheck(name, next);
  }

  for (const [name, check] of Object.entries(override.additional_checks ?? {})) {
    assert(
      !merged.checks[name],
      `override: additional check "${name}" collides with an existing check`,
    );
    merged.checks[name] = validateCheck(name, check);
  }

  // An override can move a threshold or the dead band, so reachability is
  // re-checked across every check rather than only the ones it touched.
  for (const [name, check] of Object.entries(merged.checks)) {
    assertReachable(name, check, merged.dead_band);
  }
  assertSomethingDecides(merged.checks);

  return merged;
}

export async function loadPolicyFile(path: string): Promise<Policy> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new PolicyError(`cannot read policy file ${path}: ${(error as Error).message}`);
  }
  return validatePolicy(parse(text));
}

/** Parse an override supplied as text. `null` when the repository has no override. */
export function parseOverride(text: string | null): PolicyOverride | null {
  if (text === null || text.trim() === '') return null;
  const parsed = parse(text);
  if (parsed === null || parsed === undefined) return null;
  assert(typeof parsed === 'object', 'override: file must be a mapping');
  return parsed as PolicyOverride;
}
