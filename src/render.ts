import type { GateDecision } from './gate/evaluate.js';

/**
 * Stable marker identifying the gate's own comment.
 *
 * Every run finds its previous comment by this marker and edits it in place, so
 * an Issue re-evaluated ten times still carries exactly one gate comment.
 */
export const COMMENT_MARKER = '<!-- issue-gate:v1 -->';

export interface AuditContext {
  repository: string;
  issueNumber: number;
  policyVersion: string;
  model?: string;
  runUrl?: string;
  evaluatedAt: string;
  labelApplied: string | null;
}

/** The compact payload a later review pass aggregates across repositories. */
export interface AuditPayload {
  gate_version: 1;
  result: string;
  repository: string;
  issue_number: number;
  checks: Record<string, number | null>;
  label_applied: string | null;
  policy_version: string;
  model: string | null;
  run_url: string | null;
  evaluated_at: string;
  error: string | null;
}

export function buildPayload(decision: GateDecision, ctx: AuditContext): AuditPayload {
  const checks: Record<string, number | null> = {};
  for (const check of decision.checks) {
    checks[check.name] = Number.isFinite(check.probability) ? check.probability : null;
  }
  return {
    gate_version: 1,
    result: decision.outcome,
    repository: ctx.repository,
    issue_number: ctx.issueNumber,
    checks,
    label_applied: ctx.labelApplied,
    policy_version: ctx.policyVersion,
    model: ctx.model ?? null,
    run_url: ctx.runUrl ?? null,
    evaluated_at: ctx.evaluatedAt,
    error: decision.error ?? null,
  };
}

function percent(probability: number): string {
  return Number.isFinite(probability) ? `${(probability * 100).toFixed(0)}%` : 'n/a';
}

export function renderComment(decision: GateDecision, ctx: AuditContext): string {
  const lines: string[] = [COMMENT_MARKER, '', '## Issue Gate Evaluation', ''];

  if (decision.error) {
    lines.push(
      `> Evaluation could not complete: ${decision.error}`,
      '>',
      '> The gate fails closed, so the night-ready label was not applied.',
      '',
    );
  }

  if (decision.checks.length > 0) {
    lines.push(
      '| Check | P(true) | Threshold | Result |',
      '| --- | --- | --- | --- |',
    );
    for (const check of decision.checks) {
      lines.push(
        `| \`${check.name}\` | ${percent(check.probability)} | ${check.threshold} | ${check.status} |`,
      );
    }
    lines.push('');
    lines.push(
      '_Probabilities are P(true) as returned by the model — the probability that ' +
        'the check\'s statement holds. They route the decision; they are not a ' +
        'measure of how often the gate is correct._',
      '',
    );
  }

  lines.push(
    `**Final gate result: ${decision.outcome}**`,
    '',
    `- Label applied: ${ctx.labelApplied ? `\`${ctx.labelApplied}\`` : '_none_'}`,
    `- Policy version: \`${ctx.policyVersion}\``,
  );
  if (ctx.model) lines.push(`- Model: \`${ctx.model}\``);
  if (ctx.runUrl) lines.push(`- Run: ${ctx.runUrl}`);
  lines.push(`- Evaluated at: ${ctx.evaluatedAt}`);

  lines.push(
    '',
    '<details><summary>Machine-readable result</summary>',
    '',
    '```json',
    JSON.stringify(buildPayload(decision, ctx), null, 2),
    '```',
    '',
    '</details>',
  );

  return lines.join('\n');
}
