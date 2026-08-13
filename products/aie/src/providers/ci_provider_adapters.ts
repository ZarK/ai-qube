import type { CiProviderKind } from '../config/types.js';
import {
  MISSING_CI_CAPABILITIES,
  type CiCheckResult,
  type CiCheckStatus,
  type CiProvider,
  type CiProviderCapabilities,
  type CiProviderId,
} from './ci_provider.js';

export interface CiProviderAdapterOptions {
  readonly client?: unknown;
  readonly baseUrl?: string;
  readonly user?: string;
  readonly apiToken?: string;
  readonly requestTimeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly headSha?: string;
}

export interface CiProviderAdapterMetadata {
  readonly id: CiProviderId;
  readonly packageName: string;
  readonly installed: boolean;
  readonly capabilities: CiProviderCapabilities;
  readonly setup: readonly string[];
}

interface CiProviderAdapter extends CiProviderAdapterMetadata {
  create(options: CiProviderAdapterOptions): Promise<CiProvider>;
}

const GITHUB_CAPABILITIES: CiProviderCapabilities = Object.freeze({
  readStatus: true,
  diagnoseStatus: true,
  readArtifacts: true,
  triggerRun: false,
});

const GITLAB_CAPABILITIES: CiProviderCapabilities = Object.freeze({
  readStatus: true,
  diagnoseStatus: true,
  readArtifacts: true,
  triggerRun: false,
});

const JENKINS_CAPABILITIES: CiProviderCapabilities = Object.freeze({
  readStatus: true,
  diagnoseStatus: true,
  readArtifacts: true,
  triggerRun: false,
});

const ADAPTERS: readonly CiProviderAdapter[] = Object.freeze([
  Object.freeze({
    id: 'github' as const,
    packageName: '@tjalve/qube-adapter-github',
    installed: false,
    capabilities: GITHUB_CAPABILITIES,
    setup: Object.freeze([
      'Install the optional GitHub adapter package before selecting providers.ci.kind=github.',
      'Authenticate gh for the target repository before reading GitHub check status.',
    ]),
    create: async (options: CiProviderAdapterOptions) => {
      const imported = await loadAdapterModule('@tjalve/qube-adapter-github');
      const mapCheck = imported ? imported.mapGitHubCheckStatus : null;
      if (typeof mapCheck !== 'function') {
        return new MissingCiProvider('github', '@tjalve/qube-adapter-github', [
          'Install the optional GitHub adapter package before selecting providers.ci.kind=github.',
        ]);
      }
      return new MappedCiProvider('github', GITHUB_CAPABILITIES, (check) => {
        const mapped = mapCheck(check) as {
          key?: string;
          name?: string;
          result?: string;
          reasonCode?: string;
          summary?: string;
          workflowName?: string | null;
        };
        return normalizeCheckStatus({
          key: mapped.key,
          name: mapped.name,
          result: mapped.result,
          reasonCode: mapped.reasonCode,
          summary: mapped.summary,
          workflowName: mapped.workflowName,
        });
      }, 'trigger-workflow-run', options.headSha);
    },
  }),
  Object.freeze({
    id: 'gitlab' as const,
    packageName: '@tjalve/qube-adapter-gitlab',
    installed: false,
    capabilities: GITLAB_CAPABILITIES,
    setup: Object.freeze([
      'Install the optional GitLab adapter package before selecting providers.ci.kind=gitlab.',
      'Set GITLAB_TOKEN, GITLAB_PROJECT_ID, and optional GITLAB_BASE_URL before reading GitLab pipeline status.',
    ]),
    create: async (options: CiProviderAdapterOptions) => {
      const imported = await loadAdapterModule('@tjalve/qube-adapter-gitlab');
      const factory = imported ? imported.createGitLabCiProvider : null;
      const mapCheck = imported ? imported.mapGitLabPipelineStatus : null;
      if (typeof factory === 'function') {
        const provider = factory(options) as CiProvider;
        return wrapLoadedCiProvider(provider, 'trigger-workflow-run');
      }
      if (typeof mapCheck === 'function') {
        return new MappedCiProvider('gitlab', GITLAB_CAPABILITIES, (check) => {
          return normalizeCheckStatus(mapCheck(check, options.headSha) as Record<string, unknown>);
        }, 'trigger-workflow-run', options.headSha);
      }
      return new MissingCiProvider('gitlab', '@tjalve/qube-adapter-gitlab', [
        'Install the optional GitLab adapter package before selecting providers.ci.kind=gitlab.',
      ]);
    },
  }),
  Object.freeze({
    id: 'jenkins' as const,
    packageName: '@tjalve/qube-adapter-jenkins',
    installed: false,
    capabilities: JENKINS_CAPABILITIES,
    setup: Object.freeze([
      'Install the optional Jenkins adapter package before selecting providers.ci.kind=jenkins.',
      'Set JENKINS_BASE_URL, and set JENKINS_USER plus JENKINS_API_TOKEN together when credentials are required.',
    ]),
    create: async (options: CiProviderAdapterOptions) => {
      const imported = await loadAdapterModule('@tjalve/qube-adapter-jenkins');
      const toEvidence = imported ? imported.jenkinsBuildToGateEvidence : null;
      const toQueued = imported ? imported.jenkinsQueueItemToGateEvidence : null;
      const unsupported = imported ? imported.unsupportedJenkinsMutation : null;
      if (typeof toEvidence !== 'function') {
        return new MissingCiProvider('jenkins', '@tjalve/qube-adapter-jenkins', [
          'Install the optional Jenkins adapter package before selecting providers.ci.kind=jenkins.',
        ]);
      }
      return new MappedCiProvider('jenkins', JENKINS_CAPABILITIES, (check) => {
        const record = asRecord(check);
        if (record.queueItem && typeof toQueued === 'function') {
          const evidence = toQueued({
            jobPath: typeof record.jobPath === 'string' ? record.jobPath : 'job',
            queueItem: record.queueItem,
          }) as { result?: string; reasonCode?: string; summary?: string; key?: string; name?: string; path?: string | null; providerRunId?: string | null; metadata?: { logUrl?: string | null; jenkinsResult?: string | null } };
          return normalizeCheckStatus({
            key: evidence.key,
            name: evidence.name,
            result: evidence.result === 'unknown' ? 'pending' : evidence.result,
            reasonCode: evidence.metadata?.jenkinsResult ?? evidence.reasonCode ?? 'jenkins-queued',
            summary: evidence.summary,
            url: evidence.path,
            runId: evidence.providerRunId,
            artifact: evidence.metadata?.logUrl ?? evidence.path,
          });
        }
        const evidence = toEvidence({
          jobPath: typeof record.jobPath === 'string' ? record.jobPath : 'job',
          build: record.build ?? record.buildRecord ?? 1,
          buildRecord: record.buildRecord ?? record,
        }) as { result?: string; reasonCode?: string; summary?: string; key?: string; name?: string; path?: string | null; providerRunId?: string | null; metadata?: { logUrl?: string | null; building?: boolean; jenkinsResult?: string | null } };
        let result = evidence.result;
        if (result === 'needs-work') result = 'failed';
        if (evidence.metadata?.building === true && (result === 'unknown' || result === 'missing')) result = 'pending';
        return normalizeCheckStatus({
          key: evidence.key,
          name: evidence.name,
          result,
          reasonCode: evidence.metadata?.jenkinsResult ?? evidence.reasonCode ?? evidence.result,
          summary: evidence.summary,
          url: evidence.path,
          runId: evidence.providerRunId,
          artifact: evidence.metadata?.logUrl ?? evidence.path,
        });
      }, 'trigger-ci-run', options.headSha, typeof unsupported === 'function' ? (operation: string) => unsupported(operation) : null);
    },
  }),
]);

async function loadAdapterModule(packageName: string): Promise<Record<string, unknown> | null> {
  try {
    return await import(packageName) as Record<string, unknown>;
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

function adapterFor(id: CiProviderId): CiProviderAdapter {
  const adapter = ADAPTERS.find(candidate => candidate.id === id);
  if (!adapter) {
    throw new Error(`Unknown CI provider adapter "${id}".`);
  }
  return adapter;
}

export function listCiProviderAdapters(): readonly CiProviderAdapterMetadata[] {
  return Object.freeze(ADAPTERS.map(adapter => Object.freeze({
    id: adapter.id,
    packageName: adapter.packageName,
    installed: adapter.installed,
    capabilities: adapter.capabilities,
    setup: adapter.setup,
  })));
}

export function ciProviderAdapterPackage(id: CiProviderId): string {
  return adapterFor(id).packageName;
}

export async function createCiProvider(id: CiProviderKind, options: CiProviderAdapterOptions = {}): Promise<CiProvider> {
  return adapterFor(id).create(options);
}

export function createMissingCiProvider(id: CiProviderId, packageName: string, setup: readonly string[]): CiProvider {
  return new MissingCiProvider(id, packageName, setup);
}

function wrapLoadedCiProvider(provider: CiProvider, triggerName: string): CiProvider {
  return {
    id: provider.id,
    capabilities: () => provider.capabilities(),
    mapCheck: (check) => normalizeCheckStatus(provider.mapCheck(check) as unknown as Record<string, unknown>),
    triggerRun: async () => {
      if (typeof provider.triggerRun === 'function') return provider.triggerRun();
      throw unsupportedTriggerError(provider.id, triggerName);
    },
  };
}

class MappedCiProvider implements CiProvider {
  constructor(
    readonly id: CiProviderId,
    private readonly declared: CiProviderCapabilities,
    private readonly map: (check: unknown) => CiCheckStatus,
    private readonly triggerName: string,
    private readonly headSha?: string,
    private readonly unsupportedMutation?: ((operation: string) => unknown) | null,
  ) {}

  capabilities(): CiProviderCapabilities {
    return this.declared;
  }

  mapCheck(check: unknown): CiCheckStatus {
    return this.map(check);
  }

  async triggerRun(): Promise<never> {
    if (typeof this.unsupportedMutation === 'function') {
      const result = this.unsupportedMutation(this.triggerName);
      const nextAction = asRecord(result).nextAction;
      throw new Error(`unsupported ${this.id} CI capability ${this.triggerName}${typeof nextAction === 'string' ? `: ${nextAction}` : ''}`);
    }
    throw unsupportedTriggerError(this.id, this.triggerName, this.headSha);
  }
}

class MissingCiProvider implements CiProvider {
  readonly id: CiProviderId;

  constructor(id: CiProviderId, private readonly packageName: string, private readonly setup: readonly string[]) {
    this.id = id;
  }

  capabilities(): CiProviderCapabilities {
    return MISSING_CI_CAPABILITIES;
  }

  mapCheck(_check: unknown): CiCheckStatus {
    throw this.error('read CI status');
  }

  async triggerRun(): Promise<never> {
    throw this.error('trigger a CI run');
  }

  private error(operation: string): Error {
    return new Error([
      `Cannot ${operation} with the ${this.id} CI provider because optional adapter ${this.packageName} is not installed.`,
      ...this.setup,
      'This capability is unknown until the selected adapter package is installed.',
    ].join(' '));
  }
}

function unsupportedTriggerError(id: string, triggerName: string, headSha?: string): Error {
  const head = headSha ? ` for head ${headSha}` : '';
  return new Error(`unsupported ${id} CI capability ${triggerName}${head}`);
}

function normalizeCheckStatus(value: Record<string, unknown>): CiCheckStatus {
  return {
    key: stringOr(value.key, 'ci-check:unknown'),
    name: stringOr(value.name, 'CI check'),
    result: normalizeResult(value.result),
    reasonCode: stringOr(value.reasonCode, 'ci-mapping-unknown'),
    summary: stringOr(value.summary, 'CI status is unknown.'),
    url: nullableString(value.url) ?? nullableString(value.path),
    runId: nullableString(value.runId) ?? nullableString(value.providerRunId),
    artifact: nullableString(value.artifact),
    workflowName: nullableString(value.workflowName),
  };
}

function normalizeResult(value: unknown): CiCheckResult {
  if (value === 'passed' || value === 'failed' || value === 'pending' || value === 'skipped' || value === 'unknown') return value;
  return 'unknown';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}
