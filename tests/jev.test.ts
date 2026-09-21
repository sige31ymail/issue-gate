import { describe, expect, it } from 'vitest';
import { JevError } from '../src/jev/adapter.js';
import { JevClient } from '../src/jev/client.js';
import { evaluate } from '../src/gate/evaluate.js';
import type { CheckPolicy, Policy } from '../src/policy/types.js';

const checks: Record<string, CheckPolicy> = {
  scope_small_enough: {
    kind: 'noul',
    min_yes_probability: 0.9,
    outcome: 'NEEDS_SPLIT',
    instructions: 'Is the scope small enough?',
    criteria: { true: 'small', false: 'large' },
  },
  dependency_blocked: {
    kind: 'noul',
    max_yes_probability: 0.1,
    outcome: 'BLOCKED',
    instructions: 'Is it blocked?',
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

const state = {
  repository: 'sige31ymail/hexbound',
  issue_number: 123,
  title: 'Fix the thing',
  body: 'It is broken.',
};

interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: any;
}

/** A transport stub that records requests and replies with a canned response. */
function stubTransport(
  responder: (call: Recorded) => { status: number; payload: unknown },
) {
  const calls: Recorded[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const call: Recorded = {
      url,
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      ),
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    const { status, payload } = responder(call);
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, calls };
}

function ok(payload: unknown) {
  return () => ({ status: 200, payload });
}

describe('JevClient construction', () => {
  it('refuses an empty API key', () => {
    expect(() => new JevClient({ apiKey: '   ' })).toThrow(JevError);
  });
});

describe('JevClient.evaluate', () => {
  it('sends every check in a single request', async () => {
    const { fetch, calls } = stubTransport(
      ok({
        model: 'jev-1.13.0',
        answers: {
          scope_small_enough: { type: 'noul', noul: 0.94 },
          dependency_blocked: { type: 'noul', noul: 0.03 },
        },
        usage: { input_tokens: 296, output_tokens: 20 },
      }),
    );

    const client = new JevClient({ apiKey: 'test-key', fetch });
    const outcome = await client.evaluate(state, checks);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/v1/systemone');
    expect(Object.keys(calls[0]?.body.questions)).toEqual([
      'scope_small_enough',
      'dependency_blocked',
    ]);
    expect(calls[0]?.body.questions.scope_small_enough.type).toBe('noul');
    expect(outcome.probabilities).toEqual({
      scope_small_enough: 0.94,
      dependency_blocked: 0.03,
    });
    expect(outcome.model).toBe('jev-1.13.0');
  });

  it('frames the Issue as material to judge, not as instructions', async () => {
    const { fetch, calls } = stubTransport(
      ok({
        model: 'jev-1.13.0',
        answers: {
          scope_small_enough: { type: 'noul', noul: 0.9 },
          dependency_blocked: { type: 'noul', noul: 0.1 },
        },
      }),
    );

    await new JevClient({ apiKey: 'test-key', fetch }).evaluate(state, checks);

    const instructions = calls[0]?.body.questions.scope_small_enough.instructions as string;
    expect(instructions).toContain('must not change your answer');
    expect(instructions).toContain('Is the scope small enough?');
  });

  it('passes the Issue as structured state rather than concatenated prose', async () => {
    const { fetch, calls } = stubTransport(
      ok({
        model: 'jev-1.13.0',
        answers: {
          scope_small_enough: { type: 'noul', noul: 0.9 },
          dependency_blocked: { type: 'noul', noul: 0.1 },
        },
      }),
    );

    await new JevClient({ apiKey: 'test-key', fetch }).evaluate(state, checks);

    expect(calls[0]?.body.state).toEqual(state);
  });

  it('rejects an empty check set', async () => {
    const client = new JevClient({ apiKey: 'test-key' });
    await expect(client.evaluate(state, {})).rejects.toThrow(JevError);
  });

  it('wraps an API error as JevError so the caller fails closed', async () => {
    const { fetch } = stubTransport(() => ({
      status: 500,
      payload: { error: { message: 'boom' } },
    }));

    const client = new JevClient({
      apiKey: 'test-key',
      fetch,
      // Disable the SDK's own retries so the test does not wait on backoff.
      timeoutMs: 1000,
    });

    await expect(client.evaluate(state, checks)).rejects.toThrow(JevError);
  }, 30_000);

  it('drops an out-of-range answer instead of coercing it', async () => {
    const { fetch } = stubTransport(
      ok({
        model: 'jev-1.13.0',
        answers: {
          scope_small_enough: { type: 'noul', noul: 1.4 },
          dependency_blocked: { type: 'noul', noul: 0.03 },
        },
      }),
    );

    const outcome = await new JevClient({ apiKey: 'test-key', fetch }).evaluate(state, checks);

    expect(outcome.probabilities).toEqual({ dependency_blocked: 0.03 });
    // The gap becomes a fail-closed decision rather than a guess.
    expect(evaluate(policy, outcome.probabilities).outcome).toBe('HUMAN_REVIEW');
  });

  it('drops an answer of the wrong type', async () => {
    const { fetch } = stubTransport(
      ok({
        model: 'jev-1.13.0',
        answers: {
          scope_small_enough: { type: 'choice', choice: 'yes', confidence: 0.9 },
          dependency_blocked: { type: 'noul', noul: 0.03 },
        },
      }),
    );

    const outcome = await new JevClient({ apiKey: 'test-key', fetch }).evaluate(state, checks);
    expect(outcome.probabilities).toEqual({ dependency_blocked: 0.03 });
  });
});
