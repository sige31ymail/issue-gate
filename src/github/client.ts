import type { getOctokit } from '@actions/github';
import { COMMENT_MARKER } from '../render.js';

type Octokit = ReturnType<typeof getOctokit>;

export interface IssueSnapshot {
  number: number;
  title: string;
  body: string;
  author: string;
  labels: string[];
  state: string;
}

export class GitHubGateClient {
  constructor(
    private readonly octokit: Octokit,
    private readonly owner: string,
    private readonly repo: string,
  ) {}

  async getIssue(issueNumber: number): Promise<IssueSnapshot> {
    const { data } = await this.octokit.rest.issues.get({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
    });
    return {
      number: data.number,
      title: data.title ?? '',
      body: data.body ?? '',
      author: data.user?.login ?? '',
      labels: (data.labels ?? []).map((label) =>
        typeof label === 'string' ? label : (label.name ?? ''),
      ),
      state: data.state,
    };
  }

  /** Read a file from the target repository. `null` when it does not exist. */
  async readFile(path: string, ref?: string): Promise<string | null> {
    try {
      const { data } = await this.octokit.rest.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path,
        ...(ref ? { ref } : {}),
      });
      if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') {
        return null;
      }
      return Buffer.from(data.content, data.encoding as BufferEncoding).toString('utf8');
    } catch (error) {
      if ((error as { status?: number }).status === 404) return null;
      throw error;
    }
  }

  /**
   * Create the gate comment, or edit the one already there.
   *
   * Re-evaluation is expected — an Issue gets edited and re-gated — so the gate
   * keeps a single comment rather than appending a new one per run.
   */
  async upsertComment(issueNumber: number, body: string): Promise<void> {
    const existing = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      per_page: 100,
    });

    const mine = existing.find((comment) => comment.body?.includes(COMMENT_MARKER));
    if (mine) {
      await this.octokit.rest.issues.updateComment({
        owner: this.owner,
        repo: this.repo,
        comment_id: mine.id,
        body,
      });
      return;
    }

    await this.octokit.rest.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      body,
    });
  }

  private async ensureLabel(name: string): Promise<void> {
    try {
      await this.octokit.rest.issues.getLabel({
        owner: this.owner,
        repo: this.repo,
        name,
      });
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
      try {
        await this.octokit.rest.issues.createLabel({
          owner: this.owner,
          repo: this.repo,
          name,
        });
      } catch (createError) {
        // 422 means it was created concurrently, which is the state we wanted.
        if ((createError as { status?: number }).status !== 422) throw createError;
      }
    }
  }

  /**
   * Bring the Issue's gate labels in line with `desired`.
   *
   * Only labels in `managed` are touched, so labels the gate does not own are
   * left exactly as they are. Removing is what lets a previously-READY Issue
   * lose its night-ready label once an edit makes it unready again.
   */
  async reconcileLabels(
    issueNumber: number,
    current: string[],
    managed: string[],
    desired: string[],
  ): Promise<{ added: string[]; removed: string[] }> {
    const currentSet = new Set(current);
    const desiredSet = new Set(desired);

    const toAdd = desired.filter((label) => !currentSet.has(label));
    const toRemove = managed.filter(
      (label) => currentSet.has(label) && !desiredSet.has(label),
    );

    for (const label of toRemove) {
      try {
        await this.octokit.rest.issues.removeLabel({
          owner: this.owner,
          repo: this.repo,
          issue_number: issueNumber,
          name: label,
        });
      } catch (error) {
        // Already gone is the desired end state.
        if ((error as { status?: number }).status !== 404) throw error;
      }
    }

    if (toAdd.length > 0) {
      for (const label of toAdd) await this.ensureLabel(label);
      await this.octokit.rest.issues.addLabels({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        labels: toAdd,
      });
    }

    return { added: toAdd, removed: toRemove };
  }
}
