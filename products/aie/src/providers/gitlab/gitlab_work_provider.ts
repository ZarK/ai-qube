import { createAction, createActionPlan, type Action, type ActionPlan, type ActionResult } from '../../core/action_plan.js';
import type { ExecutorPolicy } from '../../core/policy.js';
import type { WorkItem, WorkItemKey } from '../../core/work_item.js';
import type { WorkProvider, WorkProviderCapabilities } from '../work_provider.js';
import { attachGitLabBlockedBy, gitLabIssueToWorkItem, type GitLabIssue, type GitLabIssueLink } from './gitlab_work_codec.js';

export interface GitLabRestClient {
  listOpenIssues(input: { projectId: string; limit: number }): Promise<GitLabIssue[]>;
  getIssue(input: { projectId: string; iid: string }): Promise<GitLabIssue>;
}

export interface GitLabWorkProviderOptions {
  client?: GitLabRestClient;
  token?: string;
  projectId?: string;
  baseUrl?: string;
  limit?: number;
  includeIssueLinks?: boolean;
  requestTimeoutMs?: number;
}

const GITLAB_BASE_URL = 'https://gitlab.com';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const GITLAB_PAGE_LIMIT = 100;
const DEFAULT_LIMIT = Number.MAX_SAFE_INTEGER;

function required(value: string | undefined, name: string): string {
  if (value && value.trim() !== '') return value.trim();
  throw new Error(`GitLab work provider requires ${name}. Set it explicitly in provider options or the documented environment variable before reading GitLab work.`);
}

function requestTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('GitLab work provider requestTimeoutMs must be a positive number of milliseconds.');
  }
  return value;
}

function requestLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('GitLab work provider limit must be a positive integer.');
  }
  return value;
}

function isAbortTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'TimeoutError' || error.name === 'AbortError';
}

function encodeProjectId(projectId: string): string {
  return encodeURIComponent(projectId);
}

function normalizeIssueIid(value: string): string {
  return value.replace(/^#/, '');
}

class FetchGitLabRestClient implements GitLabRestClient {
  private readonly apiBaseUrl: string;
  private readonly token: string;
  private readonly includeIssueLinks: boolean;
  private readonly requestTimeoutMs: number;

  constructor(options: GitLabWorkProviderOptions) {
    this.apiBaseUrl = `${(options.baseUrl ?? process.env.GITLAB_BASE_URL ?? GITLAB_BASE_URL).replace(/\/+$/, '')}/api/v4`;
    this.token = required(options.token ?? process.env.GITLAB_TOKEN, 'GITLAB_TOKEN');
    this.includeIssueLinks = options.includeIssueLinks ?? true;
    this.requestTimeoutMs = requestTimeoutMs(options.requestTimeoutMs);
  }

  async listOpenIssues(input: { projectId: string; limit: number }): Promise<GitLabIssue[]> {
    const issues: GitLabIssue[] = [];
    let page: string | null = '1';
    while (page && issues.length < input.limit) {
      const perPage = Math.min(GITLAB_PAGE_LIMIT, input.limit - issues.length);
      const result: { value: GitLabIssue[]; nextPage: string | null } = await this.getPage<GitLabIssue[]>(`/projects/${encodeProjectId(input.projectId)}/issues`, {
        state: 'opened',
        scope: 'all',
        per_page: String(perPage),
        page,
      });
      issues.push(...result.value);
      page = result.nextPage;
    }
    if (!this.includeIssueLinks) return issues;
    return Promise.all(issues.map(async issue => ({
      ...issue,
      links: await this.listIssueLinks({ projectId: input.projectId, iid: String(issue.iid) }),
    })));
  }

  async getIssue(input: { projectId: string; iid: string }): Promise<GitLabIssue> {
    const issue = await this.get<GitLabIssue>(`/projects/${encodeProjectId(input.projectId)}/issues/${encodeURIComponent(normalizeIssueIid(input.iid))}`);
    if (!this.includeIssueLinks) return issue;
    return {
      ...issue,
      links: await this.listIssueLinks(input),
    };
  }

  private async listIssueLinks(input: { projectId: string; iid: string }): Promise<GitLabIssueLink[]> {
    return this.get<GitLabIssueLink[]>(`/projects/${encodeProjectId(input.projectId)}/issues/${encodeURIComponent(normalizeIssueIid(input.iid))}/links`);
  }

  private async get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    return (await this.getPage<T>(path, query)).value;
  }

  private async getPage<T>(path: string, query: Record<string, string> = {}): Promise<{ value: T; nextPage: string | null }> {
    const url = new URL(`${this.apiBaseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          'PRIVATE-TOKEN': this.token,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      if (isAbortTimeout(error)) {
        throw new Error(`GitLab API request timed out after ${this.requestTimeoutMs}ms. Service may be stalling or unreachable. Verify GITLAB_TOKEN, GITLAB_BASE_URL, and GITLAB_PROJECT_ID, then retry.`);
      }
      throw error;
    }
    if (!response.ok) {
      throw new Error(`GitLab API request failed while reading ${path}. Cause: HTTP ${response.status}. Next action: verify GITLAB_TOKEN, GITLAB_BASE_URL, GITLAB_PROJECT_ID, and project permissions, then retry.`);
    }
    const nextPage = response.headers.get('x-next-page')?.trim() || null;
    return { value: await response.json() as T, nextPage };
  }
}

function unsupportedAction(item: WorkItem | null, kind: Action['kind'], operation: string): Action {
  const id = item ? item.key.id : 'gitlab-provider';
  return createAction({
    id: `gitlab:${kind}:${id}`,
    kind,
    target: { kind: item ? 'work-item' : 'policy', id },
    mutation: 'work-provider',
    description: operation,
    expectedResult: 'GitLab provider reports this mutation as unsupported instead of falling back to GitHub behavior.',
    details: {
      providerId: 'gitlab',
      displayId: item?.displayId ?? null,
      unsupported: true,
      nextAction: 'Use GitLab queue/view reads and AIB GitLab draft rendering, or add tested GitLab issue and merge-request mutation adapters before enabling lifecycle mutations.',
    },
  });
}

function failedUnsupported(action: Action): ActionResult {
  return {
    actionId: action.id,
    status: 'failed',
    failure: {
      operation: action.description,
      cause: 'GitLab work provider lifecycle mutation is unsupported.',
      nextAction: 'Configure the GitHub work provider for lifecycle mutation, or add GitLab issue state/comment/merge-request mutations with explicit tests.',
    },
    details: action.details,
  };
}

export class GitLabWorkProvider implements WorkProvider {
  readonly id = 'gitlab' as const;
  private readonly client: GitLabRestClient;
  private readonly projectId: string;
  private readonly limit: number;

  constructor(options: GitLabWorkProviderOptions = {}) {
    this.client = options.client ?? new FetchGitLabRestClient(options);
    this.projectId = required(options.projectId ?? process.env.GITLAB_PROJECT_ID, 'GITLAB_PROJECT_ID');
    this.limit = requestLimit(options.limit);
  }

  capabilities(): WorkProviderCapabilities {
    return {
      listOpenWork: true,
      loadWork: true,
      planStatusSync: false,
      planLifecycleMutations: false,
      applyLifecycleMutations: false,
    };
  }

  async listOpenWorkItems(): Promise<WorkItem[]> {
    const issues = await this.client.listOpenIssues({ projectId: this.projectId, limit: this.limit });
    return attachGitLabBlockedBy(issues.map(gitLabIssueToWorkItem).filter(item => item.state === 'open'));
  }

  async getWorkItem(key: WorkItemKey): Promise<WorkItem> {
    if (key.providerId !== this.id) {
      throw new Error(`load GitLab work item failed: providerId ${key.providerId} is unsupported. Use a gitlab work item key.`);
    }
    return gitLabIssueToWorkItem(await this.client.getIssue({ projectId: this.projectId, iid: key.id }));
  }

  planStatusSync(items: WorkItem[]): ActionPlan {
    const actions = items.map(item => unsupportedAction(item, 'sync-work-status', `Synchronize GitLab issue state for ${item.displayId}`));
    return createActionPlan({ id: 'gitlab:status-sync', purpose: 'Report unsupported GitLab status synchronization explicitly.', dryRun: true, actions });
  }

  planStart(item: WorkItem): ActionPlan {
    const action = unsupportedAction(item, 'start-work', `Start GitLab issue ${item.displayId}`);
    return createActionPlan({ id: `gitlab:start:${item.key.id}`, purpose: `Start ${item.displayId}.`, dryRun: true, actions: [action] });
  }

  planPause(item: WorkItem, _openItems: WorkItem[], _policy: ExecutorPolicy): ActionPlan {
    const action = unsupportedAction(item, 'pause-work', `Pause GitLab issue ${item.displayId}`);
    return createActionPlan({ id: `gitlab:pause:${item.key.id}`, purpose: `Pause ${item.displayId}.`, dryRun: true, actions: [action] });
  }

  planComplete(item: WorkItem, _dependents: WorkItem[], _policy: ExecutorPolicy): ActionPlan {
    const action = unsupportedAction(item, 'close-work', `Complete GitLab issue ${item.displayId}`);
    return createActionPlan({ id: `gitlab:complete:${item.key.id}`, purpose: `Complete ${item.displayId}.`, dryRun: true, actions: [action] });
  }

  async apply(plan: ActionPlan): Promise<ActionResult[]> {
    return plan.actions.map(failedUnsupported);
  }
}

export function createGitLabWorkProvider(options: GitLabWorkProviderOptions = {}): GitLabWorkProvider {
  return new GitLabWorkProvider(options);
}
