/**
 * Local dry run.
 *
 * Evaluates a real Issue and prints what the gate would do, without writing a
 * label or a comment. This is the loop for tuning thresholds: change
 * `policies/night-ready.yml`, re-run, compare.
 *
 *   TYPESAFE_API_KEY=... GITHUB_TOKEN=... \
 *     npm run gate:local -- --repo sige31ymail/hexbound --issue 12
 */
import { resolve } from 'node:path';
import { getOctokit } from '@actions/github';
import { evaluate, failClosed, type GateDecision } from './gate/evaluate.js';
import { GitHubGateClient } from './github/client.js';
import { JevClient } from './jev/client.js';
import { loadPolicyFile, mergePolicy, parseOverride } from './policy/load.js';
import { renderComment } from './render.js';

interface Args {
  repo: string;
  issue: number;
  policy: string;
  overridePath: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const repo = get('repo');
  const issue = Number.parseInt(get('issue') ?? '', 10);

  if (!repo || !repo.includes('/') || !Number.isInteger(issue)) {
    throw new Error(
      'usage: gate:local --repo <owner/name> --issue <number> [--policy <path>] [--json]',
    );
  }

  return {
    repo,
    issue,
    policy: get('policy') ?? resolve(process.cwd(), 'policies', 'night-ready.yml'),
    overridePath: get('override-path') ?? '.github/issue-gate.yml',
    json: argv.includes('--json'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

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
