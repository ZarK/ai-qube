import { createAction, createActionPlan, type Action, type ActionPlan, type ActionResult, type ExecutorPolicy, type WorkItem, type WorkItemKey, type WorkProvider, type WorkProviderCapabilities } from "@tjalve/qube-core";
import { attachJiraBlockedBy, jiraIssueToWorkItem, type JiraIssue, type JiraWorkflowSchema } from "./jira_work_codec.js";

export interface JiraRestClient {
  listIssues(input: { jql: string; limit: number; fields?: readonly string[] }): Promise<JiraIssue[]>;
  getIssue(key: string): Promise<JiraIssue>;
}

export interface JiraWorkProviderOptions {
  readonly client?: JiraRestClient;
  readonly baseUrl?: string;
  readonly email?: string;
  readonly emailEnv?: string;
  readonly apiToken?: string;
  readonly apiTokenEnv?: string;
  readonly projectKey?: string;
  readonly jql?: string;
  readonly limit?: number;
  readonly workflowSchema?: JiraWorkflowSchema;
  readonly requestTimeoutMs?: number;
}

interface JiraSearchResponse {
  readonly issues?: readonly JiraIssue[];
  readonly startAt?: number;
  readonly maxResults?: number;
  readonly total?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_SEARCH_PAGE_SIZE = 100;
const DEFAULT_WORK_ITEM_LIMIT = 100;
const MAX_WORK_ITEM_LIMIT = 1_000;
const JIRA_PROJECT_KEY = /^[A-Z][A-Z0-9_]*$/u;

function required(value: string | undefined, name: string): string {
  if (value && value.trim() !== "") return value.trim();
  throw new Error(`Jira work provider requires ${name}. Set it explicitly in provider options or the documented environment variable before reading Jira work.`);
}

function requestTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Jira work provider requestTimeoutMs must be a positive number of milliseconds.");
  }
  return value;
}

function isAbortTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || error.name === "AbortError";
}

class FetchJiraRestClient implements JiraRestClient {
  private readonly baseUrl: string;
  private readonly email: string;
  private readonly apiToken: string;
  private readonly requestTimeoutMs: number;
  private readonly fields: readonly string[];

  constructor(options: JiraWorkProviderOptions) {
    this.baseUrl = normalizeBaseUrl(required(options.baseUrl ?? process.env.JIRA_BASE_URL, "JIRA_BASE_URL"));
    const emailEnv = options.emailEnv ?? "JIRA_EMAIL";
    const apiTokenEnv = options.apiTokenEnv ?? "JIRA_API_TOKEN";
    this.email = required(options.email ?? process.env[emailEnv], emailEnv);
    this.apiToken = required(options.apiToken ?? process.env[apiTokenEnv], apiTokenEnv);
    this.requestTimeoutMs = requestTimeoutMs(options.requestTimeoutMs);
    this.fields = searchFields(options.workflowSchema);
  }

  async listIssues(input: { jql: string; limit: number; fields?: readonly string[] }): Promise<JiraIssue[]> {
    const issues: JiraIssue[] = [];
    const fields = input.fields ?? this.fields;
    let startAt = 0;
    while (issues.length < input.limit) {
      const maxResults = Math.min(DEFAULT_SEARCH_PAGE_SIZE, input.limit - issues.length);
      const payload = await this.searchPage({ jql: input.jql, fields, startAt, maxResults });
      const pageIssues = [...(payload.issues ?? [])];
      issues.push(...pageIssues);
      if (pageIssues.length === 0) break;
      const total = payload.total;
      if (typeof total === "number" && issues.length >= total) break;
      if (typeof total !== "number" && pageIssues.length < maxResults) break;
      startAt = (payload.startAt ?? startAt) + pageIssues.length;
    }
    return issues;
  }

  private async searchPage(input: { jql: string; fields: readonly string[]; startAt: number; maxResults: number }): Promise<JiraSearchResponse> {
    const url = new URL(`${this.baseUrl}/rest/api/3/search`);
    url.searchParams.set("jql", input.jql);
    url.searchParams.set("startAt", String(input.startAt));
    url.searchParams.set("maxResults", String(input.maxResults));
    url.searchParams.set("fields", input.fields.join(","));
    return this.request<JiraSearchResponse>(url);
  }

  async getIssue(key: string): Promise<JiraIssue> {
    const url = new URL(`${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}`);
    url.searchParams.set("fields", this.fields.join(","));
    return this.request<JiraIssue>(url);
  }

  private async request<T>(url: URL): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.email}:${this.apiToken}`, "utf8").toString("base64")}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      if (isAbortTimeout(error)) {
        throw new Error(`Jira REST request timed out after ${this.requestTimeoutMs}ms. Service may be stalling or unreachable. Verify JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN, then retry.`);
      }
      throw error;
    }
    if (!response.ok) {
      throw new Error(`Jira REST request failed with HTTP ${response.status}.`);
    }
    return response.json() as Promise<T>;
  }
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error("Jira work provider requires JIRA_BASE_URL to use https when sending JIRA_EMAIL and JIRA_API_TOKEN.");
  }
  return url.toString().replace(/\/+$/u, "");
}

function searchFields(schema: JiraWorkflowSchema | undefined): readonly string[] {
  const fields = [
    "summary",
    "description",
    "issuetype",
    "status",
    "priority",
    "labels",
    "components",
    "assignee",
    "project",
    "comment",
    "issuelinks",
    "parent",
  ];
  for (const field of [schema?.sprintField, schema?.epicField]) {
    if (field && !fields.includes(field)) fields.push(field);
  }
  return fields;
}

function defaultJql(options: JiraWorkProviderOptions): string {
  if (options.jql && options.jql.trim() !== "") return options.jql.trim();
  const projectKey = required(options.projectKey ?? process.env.JIRA_PROJECT_KEY, "JIRA_PROJECT_KEY or jql");
  if (!JIRA_PROJECT_KEY.test(projectKey)) {
    throw new Error("Jira work provider projectKey must be a Jira project key such as ENG or OPS_2. Use explicit jql for custom project clauses.");
  }
  return `project = "${projectKey}" AND resolution = Unresolved ORDER BY priority DESC, updated DESC`;
}

function unsupportedAction(item: WorkItem | null, kind: Action["kind"], operation: string): Action {
  const id = item ? item.key.id : "jira-provider";
  return createAction({
    id: `jira:${kind}:${id}`,
    kind,
    target: { kind: item ? "work-item" : "policy", id },
    mutation: "work-provider",
    description: operation,
    expectedResult: "Jira provider reports this mutation as unsupported instead of falling back to GitHub behavior.",
    details: {
      providerId: "jira",
      displayId: item?.displayId ?? null,
      unsupported: true,
      nextAction: "Use Jira queue/view reads and AIB Jira draft rendering, or add tested Jira transition/comment mutations with explicit workflow transition IDs before enabling lifecycle mutations.",
    },
  });
}

function failedUnsupported(action: Action): ActionResult {
  return {
    actionId: action.id,
    status: "failed",
    failure: {
      operation: action.description,
      cause: "Jira work provider lifecycle mutation is not implemented.",
      nextAction: "Configure the GitHub work provider for lifecycle mutation, or add Jira workflow transition/comment mutations with explicit transition IDs and tests.",
    },
    details: action.details,
  };
}

export class JiraWorkProvider implements WorkProvider {
  readonly id = "jira" as const;
  private readonly client: JiraRestClient;
  private readonly jql: string;
  private readonly limit: number;
  private readonly workflowSchema: JiraWorkflowSchema | undefined;

  constructor(options: JiraWorkProviderOptions = {}) {
    this.client = options.client ?? new FetchJiraRestClient(options);
    this.jql = defaultJql(options);
    this.limit = workItemLimit(options.limit);
    this.workflowSchema = options.workflowSchema;
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
    const issues = await this.client.listIssues({ jql: this.jql, limit: this.limit, fields: searchFields(this.workflowSchema) });
    return attachJiraBlockedBy(issues.map(issue => jiraIssueToWorkItem(issue, this.workflowSchema)).filter(item => item.state === "open"));
  }

  async getWorkItem(key: WorkItemKey): Promise<WorkItem> {
    if (key.providerId !== this.id) {
      throw new Error(`load Jira work item failed: providerId ${key.providerId} is unsupported. Use a jira work item key.`);
    }
    return jiraIssueToWorkItem(await this.client.getIssue(key.id), this.workflowSchema);
  }

  planStatusSync(items: WorkItem[]): ActionPlan {
    const actions = items.map(item => unsupportedAction(item, "sync-work-status", `Synchronize Jira workflow state for ${item.displayId}`));
    return createActionPlan({ id: "jira:status-sync", purpose: "Report unsupported Jira status synchronization explicitly.", dryRun: true, actions });
  }

  planStart(item: WorkItem): ActionPlan {
    const action = unsupportedAction(item, "start-work", `Start Jira issue ${item.displayId}`);
    return createActionPlan({ id: `jira:start:${item.key.id}`, purpose: `Start ${item.displayId}.`, dryRun: true, actions: [action] });
  }

  planPause(item: WorkItem, _openItems: WorkItem[], _policy: ExecutorPolicy): ActionPlan {
    const action = unsupportedAction(item, "pause-work", `Pause Jira issue ${item.displayId}`);
    return createActionPlan({ id: `jira:pause:${item.key.id}`, purpose: `Pause ${item.displayId}.`, dryRun: true, actions: [action] });
  }

  planComplete(item: WorkItem, _dependents: WorkItem[], _policy: ExecutorPolicy): ActionPlan {
    const action = unsupportedAction(item, "close-work", `Complete Jira issue ${item.displayId}`);
    return createActionPlan({ id: `jira:complete:${item.key.id}`, purpose: `Complete ${item.displayId}.`, dryRun: true, actions: [action] });
  }

  async apply(plan: ActionPlan): Promise<ActionResult[]> {
    return plan.actions.map(failedUnsupported);
  }
}

export function createJiraWorkProvider(options: JiraWorkProviderOptions = {}): JiraWorkProvider {
  return new JiraWorkProvider(options);
}

function workItemLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_WORK_ITEM_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_WORK_ITEM_LIMIT) {
    throw new Error(`Jira work provider limit must be an integer between 1 and ${MAX_WORK_ITEM_LIMIT}.`);
  }
  return value;
}
