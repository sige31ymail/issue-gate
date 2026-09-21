import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseRecorded, replayFile, replayOne, ReplayError } from '../src/replay.js';
import { loadPolicyFile } from '../src/policy/load.js';
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
  it('has a fixture for every Issue the gate has run on', async () => {
    const files = await readdir(join(repoRoot, 'fixtures', 'hexbound'));
    expect(files.filter((f) => f.endsWith('.json')).sort()).toEqual([
      'issue-218.json',
      'issue-219.json',
      'issue-220.json',
      'issue-221.json',
      'issue-224.json',
      'issue-225.json',
    ]);
  });

  // The routing these six recordings produce is the whole argument for the
  // thresholds in the shipped policy. Pinned so a retune has to state what it
  // does to real Issues rather than only to the numbers.
  const expected: Record<number, string> = {
    218: 'needs-split', // large foundation, well specified, wants splitting
    219: 'blocked', //     waits on #218
    220: 'blocked', //     waits on #218
    221: 'needs-split', // vague visual work, not a single run
    224: 'needs-detail', // narrow, but states no completion criteria
    225: 'needs-split', //  broad feature with no criteria
  };

  for (const [issue, label] of Object.entries(expected)) {
    it(`routes #${issue} to ${label}`, async () => {
      const result = await replayFile(await shippedPolicy(), fixture(`issue-${issue}.json`));
      expect(result.missing).toEqual([]);
      expect(result.label).toBe(label);
    });
  }

  it('admits none of them, because none is both small and well specified', async () => {
    const policy = await shippedPolicy();
    for (const issue of Object.keys(expected)) {
      const result = await replayFile(policy, fixture(`issue-${issue}.json`));
      expect(result.decision.outcome).not.toBe('READY');
    }
  });

  it('reaches a label other than human-review on every one', async () => {
    // The fault this corpus exposed: a quality check mapped to HUMAN_REVIEW
    // failed on every feature Issue, so the result was pinned there and the two
    // labels naming a concrete repair could never appear.
    const policy = await shippedPolicy();
    for (const issue of Object.keys(expected)) {
      const result = await replayFile(policy, fixture(`issue-${issue}.json`));
      expect(result.label).not.toBe('human-review');
    }
  });
});
