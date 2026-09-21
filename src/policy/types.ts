/**
 * Policy schema for the night-ready gate.
 *
 * A policy is version-controlled YAML. It owns every number the gate decides on,
 * so the final business logic stays inspectable outside the model prompt.
 */

/** Non-READY outcomes, ordered by severity in {@link OUTCOME_SEVERITY}. */
export const FAILURE_OUTCOMES = [
  'NEEDS_DETAIL',
  'NEEDS_SPLIT',
  'HUMAN_REVIEW',
  'BLOCKED',
] as const;

export type FailureOutcome = (typeof FAILURE_OUTCOMES)[number];

/** Every state the gate can reach for an Issue. */
export type GateOutcome = 'READY' | FailureOutcome;

/**
 * Severity ranking used when several checks fail at once.
 *
 * BLOCKED wins because a blocked Issue cannot be worked on at all; HUMAN_REVIEW
 * outranks the two "rewrite the Issue" outcomes because it needs a person rather
 * than a better description.
 *
 * That ranking only routes usefully while HUMAN_REVIEW stays rare. The first
 * corpus had a quality check mapped to it that failed on every feature Issue,
 * which pinned the result at HUMAN_REVIEW and made NEEDS_SPLIT and NEEDS_DETAIL
 * unreachable: four labels were defined and two could ever appear. A check whose
 * failure the Issue's author can fix belongs on NEEDS_DETAIL or NEEDS_SPLIT, and
 * HUMAN_REVIEW is reserved for the ones that genuinely need a person.
 */
export const OUTCOME_SEVERITY: Record<FailureOutcome, number> = {
  BLOCKED: 4,
  HUMAN_REVIEW: 3,
  NEEDS_SPLIT: 2,
  NEEDS_DETAIL: 1,
};

/**
 * One narrow yes/no question put to Jev.
 *
 * Exactly one of `min_yes_probability` / `max_yes_probability` must be set. Both
 * are expressed as P(true) — the probability Jev returns — so that a single
 * comparison direction is used everywhere in the audit record.
 */
export interface CheckPolicy {
  kind: 'noul';
  /** Pass when P(true) >= this value. */
  min_yes_probability?: number;
  /** Pass when P(true) <= this value. */
  max_yes_probability?: number;
  /** Outcome contributed when this check fails. */
  outcome: FailureOutcome;
  /**
   * Whether this check's answer affects the verdict. Defaults to true.
   *
   * A check set to false is still asked, scored and recorded, but cannot change
   * the outcome. That is how a question gets evidence before it is trusted with
   * a decision: the alternative is to enforce it from the first run and find out
   * afterwards whether it measured anything.
   */
  enforced?: boolean;
  /** The question put to Jev. */
  instructions: string;
  /** Optional descriptions of the true and false outcomes. */
  criteria?: {
    true?: string;
    false?: string;
  };
}

export interface LabelPolicy {
  /** The label night-issues already consumes. Configurable to avoid a breaking rename. */
  night_ready: string;
  needs_detail: string;
  needs_split: string;
  human_review: string;
  blocked: string;
}

export interface Policy {
  version: number;
  gate: string;
  labels: LabelPolicy;
  /**
   * Half-width of the uncertainty band straddling each threshold.
   *
   * `noul` answers carry no confidence value, so "the model is on the fence" has
   * to be derived from the probability itself. A result within this distance of
   * its threshold is treated as ambiguous and never promotes an Issue to READY.
   */
  dead_band: number;
  /**
   * Half-width of the undecided band around 0.5.
   *
   * Nearness to a threshold turned out not to measure indecision: 0.93 against a
   * bar of 0.95 is a confident yes that misses, not a model on the fence. An
   * answer near 0.5 is the one that genuinely carries no signal, so that is what
   * this band catches. It never overrides a failing check — an Issue with a
   * concrete problem is told what the problem is.
   */
  ambiguity_band: number;
  /** Issue authors the gate will evaluate. Empty means every author is allowed. */
  allowed_authors: string[];
  /** Issue body is truncated to this many characters before reaching Jev. */
  max_issue_chars: number;
  checks: Record<string, CheckPolicy>;
}

/** Shape of a repository-specific override file. */
export interface PolicyOverride {
  dead_band?: number;
  ambiguity_band?: number;
  allowed_authors?: string[];
  max_issue_chars?: number;
  labels?: Partial<LabelPolicy>;
  /** Partial overrides merged onto checks that already exist in the base policy. */
  checks?: Record<string, Partial<CheckPolicy>>;
  /** Extra checks contributed by this repository. */
  additional_checks?: Record<string, CheckPolicy>;
}

export function labelForOutcome(labels: LabelPolicy, outcome: FailureOutcome): string {
  switch (outcome) {
    case 'BLOCKED':
      return labels.blocked;
    case 'HUMAN_REVIEW':
      return labels.human_review;
    case 'NEEDS_SPLIT':
      return labels.needs_split;
    case 'NEEDS_DETAIL':
      return labels.needs_detail;
  }
}

/** Every label the gate manages. The gate never touches labels outside this set. */
export function managedLabels(labels: LabelPolicy): string[] {
  return [
    labels.night_ready,
    labels.needs_detail,
    labels.needs_split,
    labels.human_review,
    labels.blocked,
  ];
}
