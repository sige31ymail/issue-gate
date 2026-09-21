import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  parseOutcomes,
  parseRecorded,
  replayFile,
  replayOne,
  ReplayError,
  score,
  type ReplayResult,
} from '../src/replay.js';
import { loadPolicyFile, mergePolicy, parseOverride } from '../src/policy/load.js';
import type { Policy } from '../src/policy/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const shippedPolicy = (): Promise<Policy> =>
  loadPolicyFile(join(repoRoot, 'policies', 'night-ready.yml'));
const fixture = (name: string): string => join(repoRoot, 'fixtures', 'hexbound', name);

describe('parseRecorded', () => {
  it('reads the payload the gate writes into its comment', () => {
    const recorded = parseRecorded(
      JSON.stringify({
        gate_version: 1,
        result: 'BLOCKED',
        repository: 'sige31ymail/hexbound',
        issue_number: 219,
        checks: { dependency_blocked: 0.83 },
      }),
      'test',
    );
    expect(recorded.issue_number).toBe(219);
    expect(recorded.result).toBe('BLOCKED');
    expect(recorded.checks['dependency_blocked']).toBe(0.83);
  });

  it('keeps a null answer null rather than reading it as zero', () => {
    // null means the model gave no usable answer. Zero is a confident "no".
    const recorded = parseRecorded(
      JSON.stringify({ issue_number: 1, checks: { dependency_blocked: null } }),
      'test',
    );
    expect(recorded.checks['dependency_blocked']).toBeNull();
  });

  it('rejects a payload with no checks to replay', () => {
    expect(() => parseRecorded(JSON.stringify({ issue_number: 1 }), 'test')).toThrow(ReplayError);
  });

  it('rejects a non-numeric answer instead of scoring around it', () => {
    expect(() =>
      parseRecorded(JSON.stringify({ issue_number: 1, checks: { a: 'high' } }), 'test'),
    ).toThrow(ReplayError);
  });

  it('reports unreadable JSON with the source name', () => {
    expect(() => parseRecorded('{', 'issue-9.json')).toThrow(/issue-9\.json/);
  });
});

describe('replayOne', () => {
  it('names the checks a recording cannot answer', async () => {
    const policy = await shippedPolicy();
    const result = replayOne(policy, {
      repository: 'r',
      issue_number: 1,
      checks: { scope_small_enough: 0.95 },
    });
    // Reported rather than silently failed closed: a corpus scoring
    // HUMAN_REVIEW on a missing answer would read as a threshold result.
    expect(result.missing).toContain('dependency_blocked');
    expect(result.missing).not.toContain('scope_small_enough');
  });
});

describe('the hexbound corpus', () => {
  const outcomesPath = join(repoRoot, 'fixtures', 'hexbound', 'outcomes.json');
  const issues = [200, 218, 219, 220, 221, 222, 223, 224, 225];

  const replayAll = async (only: number[] = issues): Promise<ReplayResult[]> => {
    const policy = await shippedPolicy();
    return Promise.all(only.map((n) => replayFile(policy, fixture(`issue-${n}.json`))));
  };

  it('has a recording and an outcome for every Issue the night queue ran', async () => {
    const files = await readdir(join(repoRoot, 'fixtures', 'hexbound'));
    expect(files.filter((f) => f.startsWith('issue-')).sort()).toEqual(
      issues.map((n) => `issue-${n}.json`),
    );
    const outcomes = parseOutcomes(await readFile(outcomesPath, 'utf8'), 'outcomes');
    expect(Object.keys(outcomes).map(Number).sort((a, b) => a - b)).toEqual(issues);
  });

  it('answers every check the policy asks for', async () => {
    for (const result of await replayAll()) {
      expect(result.missing).toEqual([]);
    }
  });

  // The only two Issues that failed for a reason their text revealed.
  it('refuses the two Issues that waited on unmerged work, and only those', async () => {
    const refused = (await replayAll())
      .filter((r) => r.decision.outcome !== 'READY')
      .map((r) => r.issueNumber);
    expect(refused).toEqual([219, 220]);
  });

  it('refuses nothing that went on to succeed', async () => {
    // The fault the previous policy had: it blocked all six Issues that
    // produced a pull request. A gate that admits nothing is not a safe gate,
    // it is an absent one that nobody can tell is broken.
    const scored = score(await replayAll(), parseOutcomes(await readFile(outcomesPath, 'utf8'), 'o'));
    const wronglyRefused = scored.filter((s) => !s.admitted && s.outcome.result === 'succeeded');
    expect(wronglyRefused).toEqual([]);
  });

  it('is wrong only where the Issue text could not have told it', async () => {
    const scored = score(await replayAll(), parseOutcomes(await readFile(outcomesPath, 'utf8'), 'o'));
    const misses = scored.filter((s) => s.correct === false);
    // The runner exhausting its tool budget, which is a property of the
    // executor and not of the Issue.
    expect(misses.map((m) => m.outcome.cause)).toEqual(['tool_limit']);
  });

  it('reads outcomes from the pull requests, not from the queue', async () => {
    // The queue called #218 and #224 failures. Both produced a pull request:
    // #218's parent task returned without its final JSON while the child it
    // had delegated to finished the work, and #224 was cancelled during
    // browser verification with the implementation and its tests already done.
    // Scored against the queue's report instead, this corpus would teach a
    // check to predict the runner's bookkeeping.
    const outcomes = parseOutcomes(await readFile(outcomesPath, 'utf8'), 'o');
    expect(outcomes[218]?.result).toBe('succeeded');
    expect(outcomes[224]?.result).toBe('succeeded');
  });

  it('scores an inconclusive run neither way', async () => {
    // No Issue in this corpus is inconclusive, but the category has to keep
    // working: a run whose result cannot be read is not evidence either way,
    // and counting it as one is how a corpus acquires a fact nobody measured.
    const [result] = await replayAll([200]);
    const scored = score([result!], { 200: { result: 'inconclusive', cause: 'runner', evidence: 'n/a' } });
    expect(scored[0]?.correct).toBeNull();
  });
});

describe("a repository's merged policy", () => {
  // The shared policy is not what a repository with an override runs, and the
  // difference is not small. On 2026-09-21 the shared policy was recalibrated
  // to 8 of 9 on this corpus while hexbound's override still enforced a check
  // that failed on all nine, so hexbound's effective policy scored 3 of 9 and
  // refused six Issues that went on to open a pull request. Nothing in this
  // repository's tests could see that.
  const issues = [200, 218, 219, 220, 221, 222, 223, 224, 225];

  const mergedWith = async (overrideText: string): Promise<ReplayResult[]> => {
    const policy = mergePolicy(await shippedPolicy(), parseOverride(overrideText));
    return Promise.all(issues.map((n) => replayFile(policy, fixture(`issue-${n}.json`))));
  };

  it("scores the hexbound snapshot as well as the shared policy does", async () => {
    const results = await mergedWith(await readFile(fixture('override.yml'), 'utf8'));
    const outcomes = parseOutcomes(await readFile(fixture('outcomes.json'), 'utf8'), 'o');
    const scored = score(results, outcomes);
    expect(scored.filter((s) => !s.admitted && s.outcome.result === 'succeeded')).toEqual([]);
    expect(scored.filter((s) => s.correct === true)).toHaveLength(8);
  });

  it('shows an added check overriding every verdict the shared policy reaches', async () => {
    // The mechanism. An override cannot remove a shared check, which reads as
    // being unable to weaken the gate — but the most severe failing outcome
    // wins, so one added check that fails everywhere decides everything, and
    // the shared policy's thresholds stop mattering.
    const results = await mergedWith(
      [
        'additional_checks:',
        '  never_passes:',
        '    kind: noul',
        '    min_yes_probability: 0.99',
        '    outcome: HUMAN_REVIEW',
        '    instructions: is this Issue ready?',
        '    criteria:',
        '      true: it is',
        '      false: it is not',
      ].join('\n'),
    );
    // The corpus recorded no answer for this check, and a missing answer on an
    // enforced check fails closed, which is the same shape as an answer below
    // the bar. Seven of these nine reach READY under the shared policy alone.
    expect(results.filter((r) => r.decision.outcome === 'READY')).toEqual([]);
    // Still HUMAN_REVIEW rather than the added check's outcome everywhere: the
    // two Issues waiting on unmerged work stay BLOCKED, which outranks it. An
    // override drowns the shared policy's passes, not its findings.
    const outcomes = results.map((r) => r.decision.outcome);
    expect(new Set(outcomes)).toEqual(new Set(['HUMAN_REVIEW', 'BLOCKED']));
  });
});

describe('parseOutcomes', () => {
  it('rejects a file with no outcomes', () => {
    expect(() => parseOutcomes(JSON.stringify({ run: 'x' }), 'o')).toThrow(ReplayError);
  });

  it('rejects unreadable JSON with the source name', () => {
    expect(() => parseOutcomes('{', 'outcomes.json')).toThrow(/outcomes\.json/);
  });
});
