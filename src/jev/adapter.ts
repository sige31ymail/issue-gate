import type { CheckPolicy } from '../policy/types.js';

/** What the gate needs from a decision engine, independent of any vendor. */
export interface JevAdapter {
  /**
   * Answer every check about one Issue.
   *
   * @returns P(true) keyed by check name.
   * @throws when the engine cannot answer; the caller fails closed.
   */
  evaluate(state: JevState, checks: Record<string, CheckPolicy>): Promise<JevOutcome>;
}

/**
 * The Issue as handed to the decision engine.
 *
 * Structured rather than concatenated into prose so the engine sees where the
 * untrusted Issue text begins and ends.
 */
export interface JevState {
  repository: string;
  issue_number: number;
  title: string;
  body: string;
}

export interface JevOutcome {
  /** P(true) keyed by check name. */
  probabilities: Record<string, number>;
  /** Model that answered, for the audit record. */
  model: string;
  usage?: { input_tokens: number; output_tokens: number };
}

export class JevError extends Error {}
