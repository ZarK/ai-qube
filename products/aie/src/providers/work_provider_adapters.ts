import type { GhExec } from '../gh.js';
import type { ActionPlan, ActionResult } from '../core/action_plan.js';
import { createActionPlan } from '../core/action_plan.js';
import type { ExecutorPolicy } from '../core/policy.js';
import type { WorkItem, WorkItemKey } from '../core/work_item.js';
import { createGitHubWorkProvider } from './github/github_work_provider.js';
import type { WorkProvider, WorkProviderCapabilities, WorkProviderId } from './work_provider.js';

export interface WorkProviderAdapterOptions {
  readonly exec?: GhExec;
  readonly cwd?: string;
  readonly limit?: number;
  readonly client?: unknown;
  readonly workflowSchema?: unknown;
  readonly baseUrl?: string;
  readonly email?: string;
  readonly emailEnv?: string;
  readonly apiToken?: string;
  readonly apiTokenEnv?: string;
  readonly projectKey?: string;
  readonly jql?: string;
  readonly requestTimeoutMs?: number;
}

export interface WorkProviderAdapterMetadata {
  readonly id: WorkProviderId;
  readonly packageName: string;
  readonly installed: boolean;
  readonly capabilities: WorkProviderCapabilities;
  readonly setup: readonly string[];
}

interface WorkProviderAdapter extends WorkProviderAdapterMetadata {
  create(options: WorkProviderAdapterOptions): Promise<WorkProvider>;
}

type WorkProviderFactory = (options: WorkProviderAdapterOptions) => WorkProvider;

const GITHUB_CAPABILITIES: WorkProviderCapabilities = Object.freeze({
  listOpenWork: true,
  loadWork: true,
  planStatusSync: true,
  planLifecycleMutations: true,
  applyLifecycleMutations: true,
  commentMutations: true,
  reviewIntegration: true,
  ciMergeStatus: true,
});

const OPTIONAL_READ_CAPABILITIES: WorkProviderCapabilities = Object.freeze({
  listOpenWork: true,
  loadWork: true,
  planStatusSync: false,
  planLifecycleMutations: false,
  applyLifecycleMutations: false,
  commentMutations: false,
  reviewIntegration: false,
  ciMergeStatus: false,
});

const MISSING_CAPABILITIES: WorkProviderCapabilities = Object.freeze({
  listOpenWork: false,
  loadWork: false,
  planStatusSync: false,
  planLifecycleMutations: false,
  applyLifecycleMutations: false,
  commentMutations: false,
  reviewIntegration: false,
  ciMergeStatus: false,
});

const ADAPTERS: readonly WorkProviderAdapter[] = Object.freeze([
  Object.freeze({
    id: 'github',
    packageName: '@tjalve/qube-adapter-github',
    installed: true,
    capabilities: GITHUB_CAPABILITIES,
    setup: Object.freeze([
      'GitHub work support is available through the built-in Executor adapter boundary.',
      'Authenticate gh for the target repository before running mutating lifecycle commands.',
    ]),
    create: async (options: WorkProviderAdapterOptions) => createGitHubWorkProvider({
      exec: options.exec,
      cwd: options.cwd,
      includeAssignees: false,
      limit: options.limit,
    }),
  }),
  missingOptionalAdapter('gitlab', '@tjalve/qube-adapter-gitlab', [
    'Install the optional GitLab work-provider adapter package before selecting providers.work.kind=gitlab.',
    'Configure GITLAB_TOKEN, GITLAB_PROJECT_ID, and optional GITLAB_BASE_URL for GitLab issue reads.',
  ]),
  missingOptionalAdapter('linear', '@tjalve/qube-adapter-linear', [
    'Install the optional Linear work-provider adapter package before selecting providers.work.kind=linear.',
    'Configure LINEAR_API_KEY and LINEAR_TEAM_ID for Linear issue reads.',
  ]),
  missingOptionalAdapter('jira', '@tjalve/qube-adapter-jira', [
    'Install the optional Jira work-provider adapter package before selecting providers.work.kind=jira.',
    'Configure JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, and either JIRA_PROJECT_KEY or provider JQL for Jira issue reads.',
  ]),
]);

function missingOptionalAdapter(id: Exclude<WorkProviderId, 'github'>, packageName: string, setup: readonly string[]): WorkProviderAdapter {
  return Object.freeze({
    id,
    packageName,
    installed: false,
    capabilities: OPTIONAL_READ_CAPABILITIES,
    setup: Object.freeze([...setup]),
    create: async (options: WorkProviderAdapterOptions) => {
      const loaded = await loadOptionalAdapter(packageName, `create${capitalizeProviderId(id)}WorkProvider`);
      return loaded ? loaded(options) : new MissingWorkProvider(id, packageName, setup);
    },
  });
}

async function loadOptionalAdapter(packageName: string, factoryName: string): Promise<WorkProviderFactory | null> {
  try {
    const imported = await import(packageName);
    const factory = (imported as Record<string, unknown>)[factoryName];
    return typeof factory === 'function' ? factory as WorkProviderFactory : null;
  } catch (error) {
    if (isModuleMissing(error, packageName)) return null;
    throw error;
  }
}

function isModuleMissing(error: unknown, packageName: string): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? String((error as { code?: unknown }).code) : '';
  return code === 'ERR_MODULE_NOT_FOUND' && error.message.includes(packageName);
}

function capitalizeProviderId(id: string): string {
  return `${id.charAt(0).toUpperCase()}${id.slice(1)}`;
}

function adapterFor(id: WorkProviderId): WorkProviderAdapter {
  const adapter = ADAPTERS.find(candidate => candidate.id === id);
  if (!adapter) {
    throw new Error(`Unknown work provider adapter "${id}".`);
  }
  return adapter;
}

export function listWorkProviderAdapters(): readonly WorkProviderAdapterMetadata[] {
  return Object.freeze(ADAPTERS.map(adapter => Object.freeze({
    id: adapter.id,
    packageName: adapter.packageName,
    installed: adapter.installed,
    capabilities: adapter.capabilities,
    setup: adapter.setup,
  })));
}

export function workProviderAdapterPackage(id: WorkProviderId): string {
  return adapterFor(id).packageName;
}

export async function createWorkProvider(id: WorkProviderId, options: WorkProviderAdapterOptions = {}): Promise<WorkProvider> {
  return adapterFor(id).create(options);
}

class MissingWorkProvider implements WorkProvider {
  readonly id: WorkProviderId;

  constructor(id: WorkProviderId, private readonly packageName: string, private readonly setup: readonly string[]) {
    this.id = id;
  }

  capabilities(): WorkProviderCapabilities {
    return MISSING_CAPABILITIES;
  }

  async listOpenWorkItems(): Promise<WorkItem[]> {
    throw this.error('list work queue');
  }

  async getWorkItem(_key: WorkItemKey): Promise<WorkItem> {
    throw this.error('load work item');
  }

  planStatusSync(_items: WorkItem[], _policy: ExecutorPolicy): ActionPlan {
    return this.emptyPlan('status-sync');
  }

  planStart(_item: WorkItem, _policy: ExecutorPolicy): ActionPlan {
    return this.emptyPlan('start');
  }

  planPause(_item: WorkItem, _openItems: WorkItem[], _policy: ExecutorPolicy): ActionPlan {
    return this.emptyPlan('pause');
  }

  planComplete(_item: WorkItem, _dependents: WorkItem[], _policy: ExecutorPolicy): ActionPlan {
    return this.emptyPlan('complete');
  }

  async apply(_plan: ActionPlan): Promise<ActionResult[]> {
    throw this.error('apply lifecycle mutation');
  }

  private emptyPlan(command: string): ActionPlan {
    return createActionPlan({
      id: `${this.id}:${command}:adapter-missing`,
      purpose: this.message(command),
      dryRun: true,
      actions: [],
    });
  }

  private error(operation: string): Error {
    return new Error(this.message(operation));
  }

  private message(operation: string): string {
    return [
      `Cannot ${operation} with the ${this.id} work provider because optional adapter ${this.packageName} is not installed.`,
      ...this.setup,
      `Run qube install --work-provider ${this.id} --yes --dry-run to review the adapter-backed install plan.`,
    ].join(' ');
  }
}
