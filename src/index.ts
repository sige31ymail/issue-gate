import { resolve } from 'node:path';
import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';
import {
  desiredLabels,
  evaluate,
  failClosed,
  isAuthorAllowed,
  type GateDecision,
} from './gate/evaluate.js';
import { GitHubGateClient } from './github/client.js';
import { JevClient } from './jev/client.js';
import { loadPolicyFile, mergePolicy, parseOverride, PolicyError } from './policy/load.js';
import { managedLabels } from './policy/types.js';
import { renderComment, type AuditContext } from './render.js';

/**
 * Resolve a path inside the action's own repository checkout.
 *
 * The runner unpacks the whole action repository, so the shared policies ship
 * with the action and need no extra checkout in the calling workflow.
 */
function actionPath(...parts: string[]): string {
  return resolve(__dirname, '..', ...parts);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n\n[truncated by issue-gate]`;
}

interface Inputs {
  token: string;
  apiKey: string;
  issueNumber: number;
  policyPath: string;
  overridePath: string;
  model: string;
  dryRun: boolean;
}

function readInputs(): Inputs {
  const rawIssue = core.getInput('issue-number') || `${context.payload.issue?.number ?? ''}`;
  const issueNumber = Number.parseInt(rawIssue, 10);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(
      'issue-number could not be determined; pass it explicitly or trigger on an issue event',
    );
  }

  return {
    token: core.getInput('github-token', { required: true }),
    apiKey: core.getInput('typesafe-api-key', { required: true }),
    issueNumber,
    policyPath: core.getInput('policy') || actionPath('policies', 'night-ready.yml'),
    overridePath: core.getInput('override-path') || '.github/issue-gate.yml',
    model: core.getInput('model'),
    dryRun: core.getBooleanInput('dry-run'),
  };
}

export async function run(): Promise<void> {
  const inputs = readInputs();
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  const octokit = getOctokit(inputs.token);
  const github = new GitHubGateClient(octokit, context.repo.owner, context.repo.repo);

  // The shared policy ships with the action; the override lives in the target
  // repository so a private repository's conventions stay private.
  const basePolicy = await loadPolicyFile(inputs.policyPath);
  const overrideText = await github.readFile(inputs.overridePath);
  const policy = mergePolicy(basePolicy, parseOverride(overrideText));

  const issue = await github.getIssue(inputs.issueNumber);

  let decision: GateDecision;
  let model: string | undefined;

  // Deterministic gates run before Jev: cheaper, and they are facts rather than
  // judgments. An untrusted author is exactly the case where a model's opinion
  // about the Issue text should not be what decides anything.
  if (!isAuthorAllowed(policy, issue.author)) {
    decision = failClosed(
      `Issue author "${issue.author}" is not in the policy's allowed_authors list`,
    );
  } else if (issue.state !== 'open') {
    decision = failClosed(`Issue is ${issue.state}`);
  } else if (issue.title.trim() === '' && issue.body.trim() === '') {
    decision = failClosed('Issue has no title or body to evaluate');
  } else {
    try {
      const jev = new JevClient({
        apiKey: inputs.apiKey,
        ...(inputs.model ? { model: inputs.model } : {}),
      });
      const outcome = await jev.evaluate(
        {
          repository,
          issue_number: issue.number,
          title: truncate(issue.title, 500),
          body: truncate(issue.body, policy.max_issue_chars),
        },
        policy.checks,
      );
      model = outcome.model;
      decision = evaluate(policy, outcome.probabilities);
      if (outcome.usage) {
        core.info(
          `Jev usage: ${outcome.usage.input_tokens} in / ${outcome.usage.output_tokens} out`,
        );
      }
    } catch (error) {
      decision = failClosed((error as Error).message);
    }
  }

  const labels = desiredLabels(policy, decision);
  // Every outcome carries a label, READY included. Reporting only the READY
  // label left the audit record claiming "none" on an Issue that had just been
  // labelled human-review.
  const labelApplied = labels[0] ?? null;

  const auditContext: AuditContext = {
    repository,
    issueNumber: issue.number,
    policyVersion: process.env['GITHUB_ACTION_REF'] ?? `v${policy.version}`,
    ...(model ? { model } : {}),
    runUrl: `${context.serverUrl}/${repository}/actions/runs/${context.runId}`,
    evaluatedAt: new Date().toISOString(),
    labelApplied,
  };

  const comment = renderComment(decision, auditContext);

  if (inputs.dryRun) {
    core.info('dry-run: no labels or comments were written');
    core.info(comment);
  } else {
    await github.upsertComment(issue.number, comment);
    const { added, removed } = await github.reconcileLabels(
      issue.number,
      issue.labels,
      managedLabels(policy.labels),
      labels,
    );
    if (added.length) core.info(`Added labels: ${added.join(', ')}`);
    if (removed.length) core.info(`Removed labels: ${removed.join(', ')}`);
  }

  core.setOutput('result', decision.outcome);
  core.setOutput('label-applied', labelApplied ?? '');
  core.setOutput('ready', String(decision.outcome === 'READY'));

  if (decision.error) {
    // Surface the reason without failing the job: a fail-closed run did its job.
    core.warning(`issue-gate failed closed: ${decision.error}`);
  }
  core.info(`issue-gate result for #${issue.number}: ${decision.outcome}`);
}

run().catch((error: unknown) => {
  // Reaching here means the gate could not even record a decision. Nothing was
  // admitted to the night queue, which is the outcome that matters.
  const message = error instanceof PolicyError ? `invalid policy: ${error.message}` : String(error);
  core.setFailed(message);
});
