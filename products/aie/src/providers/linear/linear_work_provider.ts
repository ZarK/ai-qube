import { createAction, createActionPlan, type Action, type ActionPlan, type ActionResult } from '../../core/action_plan.js';
import type { ExecutorPolicy } from '../../core/policy.js';
import type { WorkItem, WorkItemKey } from '../../core/work_item.js';
import type { WorkProvider, WorkProviderCapabilities } from '../work_provider.js';
import { attachLinearBlockedBy, linearIssueToWorkItem, type LinearIssue } from './linear_work_codec.js';

interface LinearGraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

interface LinearIssueConnection {
  nodes?: LinearIssue[];
}

interface LinearIssuesQuery {
  team?: {
    issues?: LinearIssueConnection;
  } | null;
}

interface LinearIssueQuery {
  issue?: LinearIssue | null;
}

export interface LinearGraphqlClient {
  listOpenIssues(input: { teamId: string; limit: number }): Promise<LinearIssue[]>;
  getIssue(idOrIdentifier: string): Promise<LinearIssue>;
}

export interface LinearWorkProviderOptions {
  client?: LinearGraphqlClient;
  apiKey?: string;
  teamId?: string;
  limit?: number;
  endpoint?: string;
  requestTimeoutMs?: number;
}

const LINEAR_ENDPOINT = 'https://api.linear.app/graphql';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

const LIST_OPEN_ISSUES_QUERY = `
query QubeLinearIssues($teamId: String!, $first: Int!) {
  team(id: $teamId) {
    issues(first: $first, filter: { archivedAt: { null: true } }) {
      nodes {
        id
        identifier
        number
        title
        description
        url
        priority
        archivedAt
        team { id key name }
        state { id name type }
        assignee { id name displayName email }
        labels { nodes { id name } }
        project { id name targetDate status { name type } }
        relations { nodes { type relatedIssue { id identifier } } }
      }
    }
  }
}`;

const GET_ISSUE_QUERY = `
query QubeLinearIssue($id: String!) {
  issue(id: $id) {
    id
    identifier
    number
    title
    description
    url
    priority
    archivedAt
    team { id key name }
    state { id name type }
    assignee { id name displayName email }
    labels { nodes { id name } }
    project { id name targetDate status { name type } }
    relations { nodes { type relatedIssue { id identifier } } }
  }
}`;

function required(value: string | undefined, name: string): string {
  if (value && value.trim() !== '') return value.trim();
  throw new Error(`Linear work provider requires ${name}. Set it explicitly in provider options or the documented environment variable before reading Linear work.`);
}

function graphqlErrors(errors: LinearGraphqlResponse<unknown>['errors']): string {
  return (errors ?? []).map(error => error.message ?? 'unknown GraphQL error').join('; ');
}

function requestTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Linear work provider requestTimeoutMs must be a positive number of milliseconds.');
  }
  return value;
}

function isAbortTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'TimeoutError' || error.name === 'AbortError';
}

class FetchLinearGraphqlClient implements LinearGraphqlClient {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly requestTimeoutMs: number;

  constructor(options: LinearWorkProviderOptions) {
    this.endpoint = options.endpoint ?? LINEAR_ENDPOINT;
    this.apiKey = required(options.apiKey ?? process.env.LINEAR_API_KEY, 'LINEAR_API_KEY');
    this.requestTimeoutMs = requestTimeoutMs(options.requestTimeoutMs);
  }

  async listOpenIssues(input: { teamId: string; limit: number }): Promise<LinearIssue[]> {
    const response = await this.query<LinearIssuesQuery>(LIST_OPEN_ISSUES_QUERY, { teamId: input.teamId, first: input.limit });
    return response.team?.issues?.nodes ?? [];
  }

  async getIssue(idOrIdentifier: string): Promise<LinearIssue> {
    const response = await this.query<LinearIssueQuery>(GET_ISSUE_QUERY, { id: idOrIdentifier });
    if (!response.issue) {
      throw new Error(`Linear issue ${idOrIdentifier} was not found.`);
    }
    return response.issue;
  }

  private async query<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      if (isAbortTimeout(error)) {
        throw new Error(`Linear GraphQL request timed out after ${this.requestTimeoutMs}ms. Service may be stalling or unreachable. Verify LINEAR_API_KEY and endpoint, then retry.`);
      }
      throw error;
    }
    if (!response.ok) {
      throw new Error(`Linear GraphQL request failed with HTTP ${response.status}.`);
    }
    const payload = await response.json() as LinearGraphqlResponse<T>;
    if (payload.errors?.length) {
      throw new Error(`Linear GraphQL request returned errors: ${graphqlErrors(payload.errors)}.`);
    }
    if (!payload.data) {
      throw new Error('Linear GraphQL request returned no data.');
    }
    return payload.data;
  }
}

function unsupportedAction(item: WorkItem | null, kind: Action['kind'], operation: string): Action {
  const id = item ? item.key.id : 'linear-provider';
  return createAction({
    id: `linear:${kind}:${id}`,
    kind,
    target: { kind: item ? 'work-item' : 'policy', id },
    mutation: 'work-provider',
    description: operation,
    expectedResult: 'Linear provider reports this mutation as unsupported instead of falling back to GitHub behavior.',
    details: {
      providerId: 'linear',
      displayId: item?.displayId ?? null,
      unsupported: true,
      nextAction: 'Use Linear queue/view reads and AIB Linear draft rendering, or add a tested Linear workflow-state mutation adapter before enabling lifecycle mutations.',
    },
  });
}

function failedUnsupported(action: Action): ActionResult {
  return {
    actionId: action.id,
    status: 'failed',
    failure: {
      operation: action.description,
      cause: 'Linear work provider lifecycle mutation is not implemented.',
      nextAction: 'Configure the GitHub work provider for lifecycle mutation, or add Linear workflow-state/comment mutations with explicit state IDs and tests.',
    },
    details: action.details,
  };
}

export class LinearWorkProvider implements WorkProvider {
  readonly id = 'linear' as const;
  private readonly client: LinearGraphqlClient;
  private readonly teamId: string;
  private readonly limit: number;

  constructor(options: LinearWorkProviderOptions = {}) {
    this.client = options.client ?? new FetchLinearGraphqlClient(options);
    this.teamId = required(options.teamId ?? process.env.LINEAR_TEAM_ID, 'LINEAR_TEAM_ID');
    this.limit = options.limit ?? 100;
  }

  capabilities(): WorkProviderCapabilities {
    return {
      listOpenWork: true,
      loadWork: true,
      planStatusSync: false,
      planLifecycleMutations: false,
      applyLifecycleMutations: false,
      commentMutations: false,
      reviewIntegration: false,
      ciMergeStatus: false,
    };
  }

  async listOpenWorkItems(): Promise<WorkItem[]> {
    const issues = await this.client.listOpenIssues({ teamId: this.teamId, limit: this.limit });
    return attachLinearBlockedBy(issues.map(linearIssueToWorkItem).filter(item => item.state === 'open'));
  }

  async getWorkItem(key: WorkItemKey): Promise<WorkItem> {
    if (key.providerId !== this.id) {
      throw new Error(`load Linear work item failed: providerId ${key.providerId} is unsupported. Use a linear work item key.`);
    }
    return linearIssueToWorkItem(await this.client.getIssue(key.id));
  }

  planStatusSync(items: WorkItem[]): ActionPlan {
    const actions = items.map(item => unsupportedAction(item, 'sync-work-status', `Synchronize Linear workflow state for ${item.displayId}`));
    return createActionPlan({ id: 'linear:status-sync', purpose: 'Report unsupported Linear status synchronization explicitly.', dryRun: true, actions });
  }

  planStart(item: WorkItem): ActionPlan {
    const action = unsupportedAction(item, 'start-work', `Start Linear issue ${item.displayId}`);
    return createActionPlan({ id: `linear:start:${item.key.id}`, purpose: `Start ${item.displayId}.`, dryRun: true, actions: [action] });
  }

  planPause(item: WorkItem, _openItems: WorkItem[], _policy: ExecutorPolicy): ActionPlan {
    const action = unsupportedAction(item, 'pause-work', `Pause Linear issue ${item.displayId}`);
    return createActionPlan({ id: `linear:pause:${item.key.id}`, purpose: `Pause ${item.displayId}.`, dryRun: true, actions: [action] });
  }

  planComplete(item: WorkItem, _dependents: WorkItem[], _policy: ExecutorPolicy): ActionPlan {
    const action = unsupportedAction(item, 'close-work', `Complete Linear issue ${item.displayId}`);
    return createActionPlan({ id: `linear:complete:${item.key.id}`, purpose: `Complete ${item.displayId}.`, dryRun: true, actions: [action] });
  }

  async apply(plan: ActionPlan): Promise<ActionResult[]> {
    return plan.actions.map(failedUnsupported);
  }
}

export function createLinearWorkProvider(options: LinearWorkProviderOptions = {}): LinearWorkProvider {
  return new LinearWorkProvider(options);
}
