import {
  labelForOutcome,
  OUTCOME_SEVERITY,
  type CheckPolicy,
  type FailureOutcome,
  type GateOutcome,
  type Policy,
} from '../policy/types.js';

export type CheckStatus = 'PASS' | 'FAIL' | 'AMBIGUOUS';

export interface CheckResult {
  name: string;
  /** Probability of "true" as returned by Jev. Always P(true), never P(false). */
  probability: number;
  /** Human-readable threshold, e.g. ">= 0.90". */
  threshold: string;
  status: CheckStatus;
  /** Outcome this check contributes when it fails. */
  outcome: FailureOutcome;
}

export interface GateDecision {
  outcome: GateOutcome;
  checks: CheckResult[];
  /** Set when the gate stopped before or during evaluation. Always fails closed. */
  error?: string;
}

/**
 * Tolerance for threshold comparisons.
 *
 * Thresholds and the dead band are decimal fractions written by hand, and
 * adding them in binary floating point misses by an ulp: `0.9 + 0.05` is
 * `0.9500000000000001`, which would make a policy author's `0.95` fall on the
 * wrong side of its own bound. Probabilities carry nowhere near this precision,
 * so absorbing the error is safe.
 */
const EPSILON = 1e-9;

/**
 * The threshold as shown in the audit record.
 *
 * Both numbers appear because the dead band moves the bar: a check with
 * `min_yes_probability: 0.90` and `dead_band: 0.05` only passes at 0.95.
 */
function describeThreshold(check: CheckPolicy, deadBand: number): string {
  const band = deadBand > 0 ? ` (±${deadBand.toFixed(2)})` : '';
  return check.min_yes_probability !== undefined
    ? `>= ${check.min_yes_probability.toFixed(2)}${band}`
    : `<= ${(check.max_yes_probability as number).toFixed(2)}${band}`;
}

/**
 * Classify a single probability against its threshold.
 *
 * The dead band straddles the threshold symmetrically. `noul` answers carry no
 * confidence value, so proximity to the threshold is the only available signal
 * that the model is undecided — and an undecided check must never be the reason
 * an Issue reaches unattended execution.
 */
export function classify(
  probability: number,
  check: CheckPolicy,
  deadBand: number,
): CheckStatus {
  if (check.min_yes_probability !== undefined) {
    const threshold = check.min_yes_probability;
    if (probability >= threshold + deadBand - EPSILON) return 'PASS';
    if (probability < threshold - deadBand - EPSILON) return 'FAIL';
    return 'AMBIGUOUS';
  }

  const threshold = check.max_yes_probability as number;
  if (probability <= threshold - deadBand + EPSILON) return 'PASS';
  if (probability > threshold + deadBand + EPSILON) return 'FAIL';
  return 'AMBIGUOUS';
}

/**
 * Decide the gate result from Jev probabilities and the policy.
 *
 * Pure and total: it performs no I/O and every path returns a decision, so the
 * fail-closed guarantee is testable without a network.
 */
export function evaluate(
  policy: Policy,
  probabilities: Record<string, number>,
): GateDecision {
  const checks: CheckResult[] = [];

  for (const [name, check] of Object.entries(policy.checks)) {
    const probability = probabilities[name];

    // A missing or malformed answer is required data we do not have. Treat it as
    // a failure needing a person rather than guessing.
    if (probability === undefined || !Number.isFinite(probability)) {
      checks.push({
        name,
        probability: Number.NaN,
        threshold: describeThreshold(check, policy.dead_band),
        status: 'FAIL',
        outcome: 'HUMAN_REVIEW',
      });
      continue;
    }

    checks.push({
      name,
      probability,
      threshold: describeThreshold(check, policy.dead_band),
      status: classify(probability, check, policy.dead_band),
      outcome: check.outcome,
    });
  }

  const failed = checks.filter((c) => c.status === 'FAIL');
  if (failed.length > 0) {
    // Several checks can fail at once; the most severe outcome wins so the label
    // reflects the biggest obstacle rather than whichever check ran first.
    const outcome = failed.reduce<FailureOutcome>(
      (worst, c) =>
        OUTCOME_SEVERITY[c.outcome] > OUTCOME_SEVERITY[worst] ? c.outcome : worst,
      failed[0]!.outcome,
    );
    return { outcome, checks };
  }

  if (checks.some((c) => c.status === 'AMBIGUOUS')) {
    return { outcome: 'HUMAN_REVIEW', checks };
  }

  return { outcome: 'READY', checks };
}

/**
 * Whether the gate will evaluate an Issue from this author.
 *
 * A READY result hands an Issue to an unattended agent holding repository
 * write access, so this is a deterministic check that runs before Jev ever
 * sees the text. An empty list allows every author.
 *
 * Matching is exact and case-sensitive. GitHub reports an App's login as
 * `<app>[bot]`, so that suffix belongs in the policy verbatim.
 */
export function isAuthorAllowed(policy: Policy, author: string): boolean {
  if (policy.allowed_authors.length === 0) return true;
  return policy.allowed_authors.includes(author);
}

/**
 * The decision used whenever evaluation cannot complete.
 *
 * Jev being unreachable, a malformed policy, or an untrusted Issue author all
 * land here: never READY, so a failure can never promote an Issue into the
 * night queue.
 */
export function failClosed(error: string): GateDecision {
  return { outcome: 'HUMAN_REVIEW', checks: [], error };
}

/**
 * The labels the Issue should carry after a run. Always exactly one.
 *
 * Every outcome names a label, READY included, so the audit record can report
 * what was written without deriving it a second time.
 */
export function desiredLabels(policy: Policy, decision: GateDecision): string[] {
  return decision.outcome === 'READY'
    ? [policy.labels.night_ready]
    : [labelForOutcome(policy.labels, decision.outcome)];
}
