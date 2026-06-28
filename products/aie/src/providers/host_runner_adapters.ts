export type HostRunnerId = 'codex' | 'opencode' | 'local-command';

export interface HostReviewCapability {
  readonly host: HostRunnerId;
  readonly independentReviewer: boolean;
  readonly freshContext: boolean;
  readonly promptOnly: boolean;
  readonly hooks: boolean;
  readonly evidenceWriting: boolean;
  readonly missingCapabilities: readonly string[];
  readonly nextAction: string;
}

export interface HostRunnerProbeHints {
  readonly independentReviewerCommand?: string | null;
  readonly hostProvided?: boolean;
}

interface HostRunnerAdapter {
  readonly id: HostRunnerId;
  readonly packageName: string | null;
  readonly installed: boolean;
  probe(hints?: HostRunnerProbeHints): Promise<HostReviewCapability>;
}

const LOCAL_COMMAND_CAPABILITY: HostReviewCapability = Object.freeze({
  host: 'local-command',
  independentReviewer: true,
  freshContext: true,
  promptOnly: false,
  hooks: false,
  evidenceWriting: true,
  missingCapabilities: Object.freeze([]),
  nextAction: 'Run configured local-command review lanes and record current-head evidence.',
});

const MISSING_OPENCODE_CAPABILITY: HostReviewCapability = Object.freeze({
  host: 'opencode',
  independentReviewer: false,
  freshContext: false,
  promptOnly: true,
  hooks: false,
  evidenceWriting: false,
  missingCapabilities: Object.freeze(['opencode-local-review-runner-not-implemented']),
  nextAction: 'OpenCode host review runner support is not configured. Use local-command or Codex local-host review lanes.',
});

async function loadCodexProbe(): Promise<((command?: string | null, hostProvided?: boolean) => HostReviewCapability) | null> {
  try {
    const imported = await import('@tjalve/qube-adapter-codex');
    const probe = (imported as Record<string, unknown>).probeCodexReviewCapability;
    return typeof probe === 'function' ? probe as (command?: string | null, hostProvided?: boolean) => HostReviewCapability : null;
  } catch (error) {
    if (isModuleMissing(error, '@tjalve/qube-adapter-codex')) return null;
    throw error;
  }
}

function isModuleMissing(error: unknown, packageName: string): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? String((error as { code?: unknown }).code) : '';
  return code === 'ERR_MODULE_NOT_FOUND' && error.message.includes(packageName);
}

const ADAPTERS: readonly HostRunnerAdapter[] = Object.freeze([
  Object.freeze({
    id: 'codex',
    packageName: '@tjalve/qube-adapter-codex',
    installed: true,
    probe: async (hints?: HostRunnerProbeHints) => {
      const probe = await loadCodexProbe();
      if (!probe) {
        return Object.freeze({
          host: 'codex' as const,
          independentReviewer: false,
          freshContext: false,
          promptOnly: true,
          hooks: false,
          evidenceWriting: false,
          missingCapabilities: Object.freeze(['codex-adapter-not-installed']),
          nextAction: 'Install @tjalve/qube-adapter-codex before requiring Codex local-host review lanes.',
        });
      }
      const capability = probe(hints?.independentReviewerCommand, hints?.hostProvided === true);
      return Object.freeze({ ...capability, host: 'codex' as const });
    },
  }),
  Object.freeze({
    id: 'opencode',
    packageName: '@tjalve/qube-adapter-opencode',
    installed: false,
    probe: async () => MISSING_OPENCODE_CAPABILITY,
  }),
  Object.freeze({
    id: 'local-command',
    packageName: null,
    installed: true,
    probe: async (hints?: HostRunnerProbeHints) => {
      const commandConfigured = typeof hints?.independentReviewerCommand === 'string' && hints.independentReviewerCommand.trim() !== '';
      if (!commandConfigured) {
        return Object.freeze({
          ...LOCAL_COMMAND_CAPABILITY,
          independentReviewer: false,
          freshContext: false,
          promptOnly: true,
          evidenceWriting: false,
          missingCapabilities: Object.freeze(['local-command-not-configured']),
          nextAction: 'Configure a trusted local-command review lane before requiring local-command review execution.',
        });
      }
      return LOCAL_COMMAND_CAPABILITY;
    },
  }),
]);

function adapterFor(id: HostRunnerId): HostRunnerAdapter {
  const adapter = ADAPTERS.find(candidate => candidate.id === id);
  if (!adapter) throw new Error(`Unknown host review runner "${id}".`);
  return adapter;
}

export function listHostRunnerAdapters(): readonly Pick<HostRunnerAdapter, 'id' | 'packageName' | 'installed'>[] {
  return Object.freeze(ADAPTERS.map(adapter => Object.freeze({
    id: adapter.id,
    packageName: adapter.packageName,
    installed: adapter.installed,
  })));
}

export async function probeHostReviewRunner(id: HostRunnerId, hints: HostRunnerProbeHints = {}): Promise<HostReviewCapability> {
  return adapterFor(id).probe(hints);
}

function probeCodexCapabilitySync(independentReviewerCommand?: string | null, hostProvided = false): HostReviewCapability {
  const commandConfigured = typeof independentReviewerCommand === 'string' && independentReviewerCommand.trim() !== '';
  const canSpawnFreshReviewer = commandConfigured || hostProvided;
  return Object.freeze({
    host: 'codex',
    independentReviewer: canSpawnFreshReviewer,
    freshContext: canSpawnFreshReviewer,
    promptOnly: !canSpawnFreshReviewer,
    hooks: false,
    evidenceWriting: canSpawnFreshReviewer,
    missingCapabilities: Object.freeze(canSpawnFreshReviewer ? [] : ['codex-local-reviewer-not-configured']),
    nextAction: commandConfigured
      ? 'Codex local-host review execution is configured; run local-host lanes and record current-head local-host evidence.'
      : hostProvided
        ? 'QUBE rendered promptText for host-run Codex subagents. Spawn independent Codex subagents from the active host and record local-host evidence with task, session, or thread provenance, then rerun the PR gate.'
        : 'Codex local-host review support was not explicitly configured. Configure codex as a local review agent or provide a trusted local-host command before requiring local-host review lanes.',
  });
}

export function probeHostReviewRunnerSync(id: HostRunnerId, hints: HostRunnerProbeHints = {}): HostReviewCapability {
  if (id === 'codex') return probeCodexCapabilitySync(hints.independentReviewerCommand, hints.hostProvided === true);
  if (id === 'local-command') {
    const commandConfigured = typeof hints.independentReviewerCommand === 'string' && hints.independentReviewerCommand.trim() !== '';
    if (!commandConfigured) {
      return Object.freeze({
        ...LOCAL_COMMAND_CAPABILITY,
        independentReviewer: false,
        freshContext: false,
        promptOnly: true,
        evidenceWriting: false,
        missingCapabilities: Object.freeze(['local-command-not-configured']),
        nextAction: 'Configure a trusted local-command review lane before requiring local-command review execution.',
      });
    }
    return LOCAL_COMMAND_CAPABILITY;
  }
  return MISSING_OPENCODE_CAPABILITY;
}