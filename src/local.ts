/**
 * Local dry run and replay.
 *
 * Two modes, neither of which writes a label or a comment.
 *
 * Evaluate a real Issue, which costs one Jev request:
 *
 *   TYPESAFE_API_KEY=... GITHUB_TOKEN=... \
 *     npm run gate:local -- --repo sige31ymail/hexbound --issue 12
 *
 * Or re-score probabilities the gate already recorded, which costs nothing and
 * needs no credentials. This is the loop for tuning thresholds: edit
 * `policies/night-ready.yml`, replay the corpus, compare the labels.
 *
 *   npm run gate:local -- --replay fixtures/hexbound/*.json
 */
import { resolve } from 'node:path';
import { getOctokit } from '@actions/github';
import { evaluate, failClosed, type GateDecision } from './gate/evaluate.js';
import { GitHubGateClient } from './github/client.js';
import { JevClient } from './jev/client.js';
import { loadPolicyFile, mergePolicy, parseOverride } from './policy/load.js';
import { renderComment } from './render.js';
import { renderReplayTable, replayFile } from './replay.js';

interface Args {
  repo: string;
  issue: number;
  policy: string;
  overridePath: string;
  json: boolean;
}

const USAGE =
  'usage:\n' +
  '  gate:local --repo <owner/name> --issue <number> [--policy <path>] [--json]\n' +
  '  gate:local --replay <payload.json> [...] [--policy <path>] [--json]';

function get(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function policyPath(argv: string[]): string {
  return get(argv, 'policy') ?? resolve(process.cwd(), 'policies', 'night-ready.yml');
}

/** Every path after `--replay`, up to the next flag, so a shell glob expands into it. */
function replayPaths(argv: string[]): string[] {
  const index = argv.indexOf('--replay');
  if (index < 0) return [];
  const paths: string[] = [];
  for (const arg of argv.slice(index + 1)) {
    if (arg.startsWith('--')) break;
    paths.push(arg);
  }
  return paths;
}

function parseArgs(argv: string[]): Args {
  const repo = get(argv, 'repo');
  const issue = Number.parseInt(get(argv, 'issue') ?? '', 10);

  if (!repo || !repo.includes('/') || !Number.isInteger(issue)) {
    throw new Error(USAGE);
  }

  return {
    repo,
    issue,
    policy: policyPath(argv),
    overridePath: get(argv, 'override-path') ?? '.github/issue-gate.yml',
    json: argv.includes('--json'),
  };
}

/**
 * Score a corpus of recorded evaluations against the policy on disk.
 *
 * No override is merged: a replay answers what the shared policy does, and a
 * repository override would make the same corpus produce different labels
 * depending on which repository's file happened to be read.
 */
async function replay(argv: string[], paths: string[]): Promise<void> {
  const policy = await loadPolicyFile(policyPath(argv));
  const results = [];
  for (const path of paths) {
    results.push(await replayFile(policy, path));
  }

  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${renderReplayTable(results)}\n`);

  const ready = results.filter((r) => r.decision.outcome === 'READY').length;
  process.stdout.write(`\n${ready}/${results.length} would reach READY\n`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  const paths = replayPaths(argv);
  if (paths.length > 0) {
    await replay(argv, paths);
    return;
  }

  const args = parseArgs(argv);

  const apiKey = process.env['TYPESAFE_API_KEY'];
  const token = process.env['GITHUB_TOKEN'];
  if (!apiKey) throw new Error('TYPESAFE_API_KEY is not set');
  if (!token) throw new Error('GITHUB_TOKEN is not set (a read-only token is enough)');

  const [owner, name] = args.repo.split('/') as [string, string];
  const github = new GitHubGateClient(getOctokit(token), owner, name);

  const basePolicy = await loadPolicyFile(args.policy);
  const policy = mergePolicy(basePolicy, parseOverride(await github.readFile(args.overridePath)));
  const issue = await github.getIssue(args.issue);

  let decision: GateDecision;
  let model: string | undefined;
  try {
    const outcome = await new JevClient({ apiKey }).evaluate(
      {
        repository: args.repo,
        issue_number: issue.number,
        title: issue.title.slice(0, 500),
        body: issue.body.slice(0, policy.max_issue_chars),
      },
      policy.checks,
    );
    model = outcome.model;
    decision = evaluate(policy, outcome.probabilities);
  } catch (error) {
    decision = failClosed((error as Error).message);
  }

  const ctx = {
    repository: args.repo,
    issueNumber: issue.number,
    policyVersion: 'local',
    ...(model ? { model } : {}),
    evaluatedAt: new Date().toISOString(),
    labelApplied: decision.outcome === 'READY' ? policy.labels.night_ready : null,
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ decision, ctx }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${renderComment(decision, ctx)}\n`);
  process.stdout.write('\n(dry run: no label or comment was written)\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
});
