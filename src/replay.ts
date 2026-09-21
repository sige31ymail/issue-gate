/**
 * Re-score recorded evaluations against a candidate policy.
 *
 * `evaluate` is pure, so a probability recorded once can be scored against any
 * number of policies without another Jev request. Tuning a threshold by calling
 * the API again mixes the change under test with the model's own variation
 * between runs, and costs a request per experiment; replay removes both.
 *
 * The recorded probabilities come from the audit payload the gate already
 * writes into its comment, so a corpus is collected by copying those payloads
 * out of the Issues the gate has run on.
 */
import { readFile } from 'node:fs/promises';
import { evaluate, desiredLabels, type GateDecision } from './gate/evaluate.js';
import type { Policy } from './policy/types.js';

/** The part of an audit payload a replay needs. */
export interface RecordedEvaluation {
  repository: string;
  issue_number: number;
  checks: Record<string, number | null>;
  /** The outcome the recorded run reached, for comparison against the replay. */
  result?: string;
}

export interface ReplayResult {
  repository: string;
  issueNumber: number;
  recorded: string | null;
  decision: GateDecision;
  label: string;
  /** Checks the policy asks for that the recording has no answer for. */
  missing: string[];
}

export class ReplayError extends Error {}

/**
 * Read one recorded payload.
 *
 * Accepts the payload object itself or anything carrying it, so a file copied
 * straight out of a comment works without editing.
 */
export function parseRecorded(text: string, source: string): RecordedEvaluation {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ReplayError(`${source}: not valid JSON: ${(error as Error).message}`);
  }
  if (!raw || typeof raw !== 'object') {
    throw new ReplayError(`${source}: expected an object`);
  }

  const r = raw as Record<string, unknown>;
  const checks = r['checks'];
  if (!checks || typeof checks !== 'object') {
    throw new ReplayError(`${source}: no "checks" object to replay`);
  }

  const probabilities: Record<string, number | null> = {};
  for (const [name, value] of Object.entries(checks as Record<string, unknown>)) {
    if (value === null) {
      probabilities[name] = null;
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ReplayError(`${source}: check "${name}" is not a number`);
    }
    probabilities[name] = value;
  }

  return {
    repository: typeof r['repository'] === 'string' ? r['repository'] : 'unknown',
    issue_number: typeof r['issue_number'] === 'number' ? r['issue_number'] : 0,
    checks: probabilities,
    ...(typeof r['result'] === 'string' ? { result: r['result'] } : {}),
  };
}

/**
 * Score one recording against a policy.
 *
 * A recording predates any check the policy has gained since, so the checks it
 * cannot answer are reported rather than silently failed closed — a replay is a
 * calibration tool, and a corpus quietly scoring HUMAN_REVIEW on a missing
 * answer would read as a threshold result.
 */
export function replayOne(policy: Policy, recorded: RecordedEvaluation): ReplayResult {
  const answered: Record<string, number> = {};
  const missing: string[] = [];

  for (const name of Object.keys(policy.checks)) {
    const value = recorded.checks[name];
    if (typeof value === 'number') {
      answered[name] = value;
    } else {
      missing.push(name);
    }
  }

  const decision = evaluate(policy, answered);
  return {
    repository: recorded.repository,
    issueNumber: recorded.issue_number,
    recorded: recorded.result ?? null,
    decision,
    label: desiredLabels(policy, decision)[0] as string,
    missing,
  };
}

export async function replayFile(policy: Policy, path: string): Promise<ReplayResult> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new ReplayError(`cannot read ${path}: ${(error as Error).message}`);
  }
  return replayOne(policy, parseRecorded(text, path));
}

/** A fixed-width table, so a threshold sweep is read by scanning a column. */
export function renderReplayTable(results: ReplayResult[]): string {
  const rows = results.map((r) => ({
    issue: `#${r.issueNumber}`,
    recorded: r.recorded ?? '-',
    outcome: r.decision.outcome,
    label: r.label,
    note: r.missing.length ? `missing: ${r.missing.join(', ')}` : '',
  }));

  const headers = { issue: 'Issue', recorded: 'Recorded', outcome: 'Replay', label: 'Label', note: '' };
  const width = (key: keyof typeof headers): number =>
    Math.max(headers[key].length, ...rows.map((r) => r[key].length));

  const line = (r: typeof headers): string =>
    [
      r.issue.padEnd(width('issue')),
      r.recorded.padEnd(width('recorded')),
      r.outcome.padEnd(width('outcome')),
      r.label.padEnd(width('label')),
      r.note,
    ]
      .join('  ')
      .trimEnd();

  return [line(headers), ...rows.map(line)].join('\n');
}

/** What the night queue actually did with an Issue. */
export interface Outcome {
  result: 'succeeded' | 'failed' | 'inconclusive';
  /** Why a failure happened; null on success. */
  cause: 'dependency' | 'tool_limit' | 'runner' | null;
  evidence: string;
}

export type Outcomes = Record<string, Outcome>;

export interface Scored {
  issueNumber: number;
  admitted: boolean;
  outcome: Outcome;
  /** Right when admitting an Issue that succeeded, or refusing one that failed. */
  correct: boolean | null;
}

/** Read the outcomes file that sits beside a corpus. */
export function parseOutcomes(text: string, source: string): Outcomes {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ReplayError(`${source}: not valid JSON: ${(error as Error).message}`);
  }
  const outcomes = (raw as { outcomes?: unknown })?.outcomes;
  if (!outcomes || typeof outcomes !== 'object') {
    throw new ReplayError(`${source}: no "outcomes" object`);
  }
  return outcomes as Outcomes;
}

/**
 * Set replayed verdicts against what actually happened.
 *
 * An Issue whose run was inconclusive scores neither way. #218's queue entry
 * failed on a runner fault while its implementation completed, so counting it
 * as either would be counting the runner's bug as the gate's.
 */
export function score(results: ReplayResult[], outcomes: Outcomes): Scored[] {
  const scored: Scored[] = [];
  for (const result of results) {
    const outcome = outcomes[String(result.issueNumber)];
    if (!outcome) continue;
    const admitted = result.decision.outcome === 'READY';
    scored.push({
      issueNumber: result.issueNumber,
      admitted,
      outcome,
      correct:
        outcome.result === 'inconclusive' ? null : admitted === (outcome.result === 'succeeded'),
    });
  }
  return scored;
}

/**
 * Report how a policy would have done, split by what it could have known.
 *
 * A failure the Issue text cannot reveal — the runner exhausting its tool
 * budget, or losing a worker's output — is not the gate's to catch. Counting
 * those against a policy invites tightening thresholds until they block real
 * work, which is how the first calibration produced a gate that admitted
 * nothing.
 */
export function renderScoreboard(scored: Scored[]): string {
  const lines: string[] = [];
  for (const s of scored) {
    const verdict = s.correct === null ? 'n/a ' : s.correct ? 'ok  ' : 'MISS';
    const cause = s.outcome.cause ? ` (${s.outcome.cause})` : '';
    lines.push(
      `${verdict} #${s.issueNumber}  ${s.admitted ? 'admitted' : 'refused '}  ` +
        `${s.outcome.result}${cause}`,
    );
  }

  const judged = scored.filter((s) => s.correct !== null);
  const right = judged.filter((s) => s.correct).length;
  const admittedAndFailed = judged.filter((s) => s.admitted && s.outcome.result === 'failed');
  const refusedAndSucceeded = judged.filter((s) => !s.admitted && s.outcome.result === 'succeeded');
  const knowable = admittedAndFailed.filter((s) => s.outcome.cause === 'dependency');

  lines.push(
    '',
    `${right}/${judged.length} correct`,
    `admitted but failed: ${admittedAndFailed.length}` +
      ` (${knowable.length} from a cause the Issue text shows)`,
    `refused but would have succeeded: ${refusedAndSucceeded.length}`,
  );
  return lines.join('\n');
}
