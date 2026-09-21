import { describe, expect, it } from 'vitest';
import { evaluate, failClosed } from '../src/gate/evaluate.js';
import { buildPayload, COMMENT_MARKER, renderComment, type AuditContext } from '../src/render.js';
import type { CheckPolicy, Policy } from '../src/policy/types.js';

const checks: Record<string, CheckPolicy> = {
  scope_small_enough: {
    kind: 'noul',
    min_yes_probability: 0.9,
    outcome: 'NEEDS_SPLIT',
    instructions: 'q',
  },
  requires_human_decision: {
    kind: 'noul',
    max_yes_probability: 0.1,
    outcome: 'HUMAN_REVIEW',
    instructions: 'q',
  },
};

const policy: Policy = {
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
  ambiguity_band: 0,
  allowed_authors: [],
  max_issue_chars: 12000,
  checks,
};

const ctx: AuditContext = {
  repository: 'sige31ymail/hexbound',
  issueNumber: 123,
  policyVersion: 'v1',
  model: 'jev-1.13.0',
  runUrl: 'https://github.com/sige31ymail/hexbound/actions/runs/42',
  evaluatedAt: '2026-09-21T09:00:00.000Z',
  labelApplied: 'night-ready',
};

describe('renderComment', () => {
  it('carries the marker so the next run edits it in place', () => {
    const decision = evaluate(policy, { scope_small_enough: 0.97, requires_human_decision: 0.02 });
    expect(renderComment(decision, ctx)).toContain(COMMENT_MARKER);
  });

  it('shows each check with its probability, threshold and result', () => {
    const decision = evaluate(policy, { scope_small_enough: 0.97, requires_human_decision: 0.02 });
    const comment = renderComment(decision, ctx);
    expect(comment).toContain('`scope_small_enough`');
    expect(comment).toContain('97%');
    expect(comment).toContain('>= 0.90');
    expect(comment).toContain('<= 0.10');
    expect(comment).toContain('PASS');
    expect(comment).toContain('**Final gate result: READY**');
  });

  it('shows the dead band alongside the threshold, since it moves the bar', () => {
    const decision = evaluate(policy, { scope_small_enough: 0.97, requires_human_decision: 0.02 });
    expect(renderComment(decision, ctx)).toContain('>= 0.90 (±0.05)');
  });

  it('states that probabilities route the decision rather than measure correctness', () => {
    const decision = evaluate(policy, { scope_small_enough: 0.97, requires_human_decision: 0.02 });
    expect(renderComment(decision, ctx)).toContain('not a measure of how often the gate is correct');
  });

  it('explains a fail-closed run and records no label', () => {
    const decision = failClosed('Jev request failed: 503');
    const comment = renderComment(decision, { ...ctx, labelApplied: null });
    expect(comment).toContain('Evaluation could not complete');
    expect(comment).toContain('Jev request failed: 503');
    expect(comment).toContain('fails closed');
    expect(comment).toContain('Label applied: _none_');
  });

  it('renders a missing answer as n/a rather than a number', () => {
    const decision = evaluate(policy, { scope_small_enough: 0.97 });
    expect(renderComment(decision, { ...ctx, labelApplied: null })).toContain('n/a');
  });
});

describe('buildPayload', () => {
  it('records every check as P(true)', () => {
    const decision = evaluate(policy, { scope_small_enough: 0.96, requires_human_decision: 0.03 });
    const payload = buildPayload(decision, ctx);
    expect(payload.checks).toEqual({
      scope_small_enough: 0.96,
      requires_human_decision: 0.03,
    });
    expect(payload.result).toBe('READY');
    expect(payload.label_applied).toBe('night-ready');
    expect(payload.error).toBeNull();
  });

  it('nulls a missing probability instead of inventing one', () => {
    const decision = evaluate(policy, { scope_small_enough: 0.96 });
    const payload = buildPayload(decision, { ...ctx, labelApplied: null });
    expect(payload.checks['requires_human_decision']).toBeNull();
    expect(payload.result).toBe('HUMAN_REVIEW');
  });

  it('carries the fields a later review pass needs to aggregate runs', () => {
    const decision = evaluate(policy, { scope_small_enough: 0.96, requires_human_decision: 0.03 });
    const payload = buildPayload(decision, ctx);
    expect(payload.repository).toBe('sige31ymail/hexbound');
    expect(payload.issue_number).toBe(123);
    expect(payload.policy_version).toBe('v1');
    expect(payload.model).toBe('jev-1.13.0');
    expect(payload.run_url).toContain('/actions/runs/42');
    expect(payload.evaluated_at).toBe('2026-09-21T09:00:00.000Z');
  });

  it('records the reason on a fail-closed run', () => {
    const payload = buildPayload(failClosed('policy invalid'), { ...ctx, labelApplied: null });
    expect(payload.error).toBe('policy invalid');
    expect(payload.label_applied).toBeNull();
  });

  it('round-trips as JSON inside the comment', () => {
    const decision = evaluate(policy, { scope_small_enough: 0.96, requires_human_decision: 0.03 });
    const comment = renderComment(decision, ctx);
    const json = comment.match(/```json\n([\s\S]*?)\n```/)?.[1];
    expect(json).toBeDefined();
    expect(JSON.parse(json as string)).toEqual(buildPayload(decision, ctx));
  });
});

describe('shadow mode in the audit record', () => {
  const decision = () =>
    evaluate(policy, { scope_small_enough: 0.2, requires_human_decision: 0.9 });

  it('says plainly that the verdict was not acted on', () => {
    const comment = renderComment(decision(), {
      ...ctx,
      mode: 'shadow',
      labelApplied: 'night-ready',
    });
    expect(comment).toContain('not enforced');
    // The verdict is still stated, because comparing it against what the run
    // actually did is the whole point of recording it.
    expect(comment).toContain('**Final gate result: HUMAN_REVIEW**');
    expect(comment).toContain('Label applied: `night-ready`');
  });

  it('is absent from an enforcing run', () => {
    expect(renderComment(decision(), ctx)).not.toContain('not enforced');
  });

  it('records the mode and the label that was really written', () => {
    const payload = buildPayload(decision(), {
      ...ctx,
      mode: 'shadow',
      labelApplied: 'night-ready',
    });
    expect(payload.mode).toBe('shadow');
    expect(payload.result).toBe('HUMAN_REVIEW');
    expect(payload.label_applied).toBe('night-ready');
  });

  it('defaults to enforce when the mode is not given', () => {
    expect(buildPayload(decision(), ctx).mode).toBe('enforce');
  });
});

describe('recorded-only checks in the comment', () => {
  const withRecorded: Policy = {
    ...policy,
    checks: {
      ...checks,
      executor_can_handle: {
        kind: 'noul',
        min_yes_probability: 0.7,
        outcome: 'HUMAN_REVIEW',
        instructions: 'q',
        enforced: false,
      },
    },
  };

  it('marks the row so a failing one does not read as ignored', () => {
    const decision = evaluate(withRecorded, {
      scope_small_enough: 0.97,
      requires_human_decision: 0.02,
      executor_can_handle: 0.1,
    });
    const comment = renderComment(decision, ctx);
    expect(comment).toContain('`executor_can_handle` (recorded only)');
    expect(comment).toContain('**Final gate result: READY**');
  });

  it('names them in the payload', () => {
    const decision = evaluate(withRecorded, {
      scope_small_enough: 0.97,
      requires_human_decision: 0.02,
      executor_can_handle: 0.1,
    });
    const payload = buildPayload(decision, ctx);
    expect(payload.recorded_only).toEqual(['executor_can_handle']);
    expect(payload.checks['executor_can_handle']).toBe(0.1);
  });
});
