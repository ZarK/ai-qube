import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ISOLATED_REVIEW_HOST_PACKAGE_NAMES } from '@tjalve/qube-core';

export {
  AGENT_HOST_IDS,
  RETIRED_GROK_HOST_ID,
  retiredGrokHostIdMessage,
} from '@tjalve/qube-core';
import type { ReviewModelEffort } from '../core/policy.js';
import { isMissingAdapterPackage } from '../missing_adapter_package.js';
import { redact } from '../redact.js';
import { readHostUsage, type LaneUsage } from '../review_usage.js';

const requireAdapter = createRequire(import.meta.url);

export { readHostUsage, type LaneUsage } from '../review_usage.js';

export type ModelHostExecutable = string | { executable: string; prefixArgs: string[] };

export type ReviewHostCapabilityNeed = 'structured-output' | 'read-only-sandbox';

export interface ReviewHostCapabilities {
  structuredOutput: boolean;
  readOnlySandbox: boolean;
}

export interface ReviewHostParsedEnvelope {
  text: string;
  sessionId: string | null;
  priorTexts?: string[];
  usage?: LaneUsage;
}

export interface ReviewHostInvocationContext {
  repoRoot: string;
  model: string | null;
  effort: ReviewModelEffort | null;
  maxTurns: number;
  prompt: string;
  promptPath: string | null;
  schemaPath: string | null;
  schemaJson: string;
}

export interface ReviewHostBuiltInvocation {
  args: string[];
  stdin: string | null;
}

export type ReviewHostProbeCommandRunner = (executable: string, args: readonly string[]) => string;

export interface ReviewHostProbeContext {
  model: string | null;
  executable: string;
  prefixArgs: readonly string[];
  runCommand: ReviewHostProbeCommandRunner;
  version: string;
}

export interface ReviewHostProbeResult {
  status: 'ready' | 'blocked';
  modelListed: boolean | null;
  diagnostic: string | null;
}

export interface ReviewHostAdapter {
  readonly id: string;
  readonly capabilities: ReviewHostCapabilities;
  readonly requiredCapabilities: readonly ReviewHostCapabilityNeed[];
  readonly executableNames: readonly string[];
  readonly windowsExecutableNames: readonly string[];
  readonly requiresPromptFile: boolean;
  readonly requiresSchemaFile: boolean;
  windowsNodeModulesScriptPath(shimDir: string): string | null;
  windowsFallbackExecutablePath(): string | null;
  buildInvocation(context: ReviewHostInvocationContext, executable: ModelHostExecutable): ReviewHostBuiltInvocation;
  parseEnvelope(stdout: string): ReviewHostParsedEnvelope | null;
  probeAfterVersion(context: ReviewHostProbeContext): ReviewHostProbeResult;
  listCatalog?(context: Pick<ReviewHostProbeContext, 'executable' | 'prefixArgs' | 'runCommand'>): string[] | null;
}

const CAPABILITY_FIELD: Record<ReviewHostCapabilityNeed, keyof ReviewHostCapabilities> = {
  'structured-output': 'structuredOutput',
  'read-only-sandbox': 'readOnlySandbox',
};

export function missingReviewHostCapabilities(adapter: ReviewHostAdapter): ReviewHostCapabilityNeed[] {
  return adapter.requiredCapabilities.filter(need => !adapter.capabilities[CAPABILITY_FIELD[need]]);
}

// Host CLI output is untrusted: strip terminal control sequences and
// non-printable bytes, redact secrets, and bound the length before any of it
// reaches diagnostics, doctor output, or lane summaries.
export function sanitizeProbeText(value: string): string {
  return redact(value.replace(/\[[0-9;]*[A-Za-z]/g, '').replace(/[^ -~]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 200);
}



export function parseCodexModelCatalog(output: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.models)) return null;
  const models: string[] = [];
  for (const item of parsed.models) {
    if (!isRecord(item) || typeof item.slug !== 'string') continue;
    const slug = item.slug.trim();
    if (slug !== '') models.push(slug);
  }
  return models.length > 0 ? models : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function usageFromCodexEvent(record: Record<string, unknown>): LaneUsage | undefined {
  const direct = readHostUsage(record.usage);
  if (direct) return direct;
  if (record.type === 'token_count') {
    return readHostUsage(isRecord(record.info) ? record.info : record);
  }
  if (record.type === 'event_msg' && isRecord(record.payload) && record.payload.type === 'token_count') {
    const info = isRecord(record.payload.info) ? record.payload.info : record.payload;
    return readHostUsage(info.total_token_usage ?? info.last_token_usage ?? info);
  }
  if (isRecord(record.item) && record.item.type === 'usage') return readHostUsage(record.item);
  return undefined;
}

function parseCodexOutput(stdout: string): ReviewHostParsedEnvelope | null {
  const messages: string[] = [];
  let sessionId: string | null = null;
  let usage: LaneUsage | undefined;
  for (const line of stdout.split(/\r?\n/).filter(line => line.trim() !== '')) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
    const record = event as Record<string, unknown>;
    if (record.type === 'thread.started' && typeof record.thread_id === 'string') sessionId = record.thread_id;
    if (record.type === 'item.completed' && record.item && typeof record.item === 'object' && !Array.isArray(record.item)) {
      const item = record.item as Record<string, unknown>;
      if (item.type === 'agent_message' && typeof item.text === 'string') messages.push(item.text);
    }
    const eventUsage = usageFromCodexEvent(record);
    if (eventUsage) usage = eventUsage;
  }
  return messages.length === 1 ? { text: messages[0], sessionId, ...(usage ? { usage } : {}) } : null;
}

const FULL_CAPABILITIES: ReviewHostCapabilities = { structuredOutput: true, readOnlySandbox: true };
const FULL_REQUIRED_CAPABILITIES: readonly ReviewHostCapabilityNeed[] = ['structured-output', 'read-only-sandbox'];

const codexAdapter: ReviewHostAdapter = Object.freeze({
  id: 'codex',
  capabilities: FULL_CAPABILITIES,
  requiredCapabilities: FULL_REQUIRED_CAPABILITIES,
  requiresPromptFile: false,
  requiresSchemaFile: true,
  executableNames: Object.freeze(['codex']),
  windowsExecutableNames: Object.freeze(['codex.exe']),
  windowsNodeModulesScriptPath(shimDir: string): string | null {
    return join(shimDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  },
  windowsFallbackExecutablePath(): string | null {
    return null;
  },
  buildInvocation(context: ReviewHostInvocationContext): ReviewHostBuiltInvocation {
    if (!context.schemaPath) throw new Error('Codex review routing requires a private output schema file.');
    const args: string[] = ['exec'];
    if (context.model) args.push('--model', context.model);
    if (context.effort) args.push('--config', `model_reasoning_effort="${context.effort}"`);
    args.push(
      '--ignore-user-config', '--strict-config', '--config', 'mcp_servers={}', '--config', 'web_search="disabled"',
      '--disable', 'apps', '--disable', 'browser_use', '--disable', 'browser_use_external', '--disable', 'computer_use',
      '--disable', 'in_app_browser', '--disable', 'standalone_web_search', '--disable', 'multi_agent', '--disable', 'hooks', '--disable', 'plugins',
      '--sandbox', 'read-only', '--cd', context.repoRoot, '--skip-git-repo-check', '--ephemeral', '--output-schema', context.schemaPath, '--json', '-',
    );
    return { args, stdin: context.prompt };
  },
  parseEnvelope: parseCodexOutput,
  probeAfterVersion({ model, executable, prefixArgs, runCommand }: ReviewHostProbeContext): ReviewHostProbeResult {
    if (!model) return { status: 'ready', modelListed: null, diagnostic: null };
    let catalog: string[] | null;
    try {
      catalog = parseCodexModelCatalog(runCommand(executable, [...prefixArgs, 'debug', 'models']));
    } catch {
      return { status: 'ready', modelListed: null, diagnostic: null };
    }
    if (!catalog) return { status: 'ready', modelListed: null, diagnostic: null };
    if (!catalog.includes(model)) {
      return {
        status: 'blocked',
        modelListed: false,
        diagnostic: `Configured review model "${model}" is not in the Codex catalog (${sanitizeProbeText(catalog.join(', '))}). Update the trusted review model configuration to a listed model.`,
      };
    }
    return { status: 'ready', modelListed: true, diagnostic: null };
  },
  listCatalog({ executable, prefixArgs, runCommand }: Pick<ReviewHostProbeContext, 'executable' | 'prefixArgs' | 'runCommand'>): string[] | null {
    return parseCodexModelCatalog(runCommand(executable, [...prefixArgs, 'debug', 'models']));
  },
});

const BUILTIN_REVIEW_HOST_ADAPTERS: readonly ReviewHostAdapter[] = Object.freeze([codexAdapter]);

function isReviewAdapterUnavailable(error: unknown, packageName: string): boolean {
  return isMissingAdapterPackage(error, packageName);
}

function isReviewHostAdapter(value: unknown): value is ReviewHostAdapter {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const adapter = value as Partial<ReviewHostAdapter>;
  return typeof adapter.id === 'string'
    && Array.isArray(adapter.executableNames)
    && adapter.executableNames.length > 0
    && typeof adapter.buildInvocation === 'function'
    && typeof adapter.parseEnvelope === 'function'
    && typeof adapter.probeAfterVersion === 'function';
}

export function loadReviewHostAdapterPackage(packageName: string): ReviewHostAdapter | null {
  try {
    const imported = requireAdapter(packageName) as Record<string, unknown>;
    const adapter = imported.isolatedReviewHostAdapter ?? imported.reviewHostAdapter;
    return isReviewHostAdapter(adapter) ? adapter : null;
  } catch (error) {
    if (isReviewAdapterUnavailable(error, packageName)) return null;
    throw error;
  }
}

function builtinAdapterMap(): Map<string, ReviewHostAdapter> {
  return new Map(BUILTIN_REVIEW_HOST_ADAPTERS.map(adapter => [adapter.id, adapter]));
}

function loadRegisteredReviewHostAdapters(): Map<string, ReviewHostAdapter> {
  const adapters = builtinAdapterMap();
  for (const packageName of Object.values(ISOLATED_REVIEW_HOST_PACKAGE_NAMES)) {
    const loaded = loadReviewHostAdapterPackage(packageName);
    if (loaded) adapters.set(loaded.id, loaded);
  }
  return adapters;
}

let reviewHostAdapters = loadRegisteredReviewHostAdapters();

export function getReviewHostAdapter(id: string): ReviewHostAdapter {
  const adapter = reviewHostAdapters.get(id);
  if (!adapter) throw new Error(`No review host adapter is registered for "${id}".`);
  return adapter;
}

export function listReviewHostIds(): string[] {
  return [...reviewHostAdapters.keys()];
}

export function isRegisteredReviewHost(id: unknown): id is string {
  return typeof id === 'string' && reviewHostAdapters.has(id);
}

export function registerReviewHostAdapterForTests(adapter: ReviewHostAdapter): void {
  reviewHostAdapters.set(adapter.id, adapter);
}

export function resetReviewHostAdaptersForTests(): void {
  reviewHostAdapters = loadRegisteredReviewHostAdapters();
}
