import { isolatedReviewHostAdapter as codexReviewHostAdapter } from '@tjalve/qube-adapter-codex';
import { isolatedReviewHostAdapter as cursorReviewHostAdapter } from '@tjalve/qube-adapter-cursor';
import { isolatedReviewHostAdapter as grokBuildReviewHostAdapter } from '@tjalve/qube-adapter-grok-build';
import { AGENT_HOST_REGISTRATIONS } from '@tjalve/qube-core';
import type { ReviewModelEffort } from '../core/policy.js';
import { redact } from '../redact.js';
import type { LaneUsage } from '../review_usage.js';

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
  transientTexts?: string[];
  usage?: LaneUsage;
}

export interface ReviewHostInvocationContext {
  repoRoot: string;
  model: string | null;
  transportModel?: string | null;
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
  platform: string;
}

export interface ReviewHostProbeResult {
  status: 'ready' | 'blocked';
  modelListed: boolean | null;
  diagnostic: string | null;
  reasonCode?: string | null;
  transport?: string | null;
  resolvedModel?: string | null;
  availableModels?: readonly string[];
}

export interface ReviewHostAdapter {
  readonly id: string;
  readonly capabilities: ReviewHostCapabilities;
  readonly requiredCapabilities: readonly ReviewHostCapabilityNeed[];
  readonly executableNames: readonly string[];
  readonly windowsExecutableNames: readonly string[];
  readonly requiresPromptFile: boolean;
  readonly requiresSchemaFile: boolean;
  readonly windowsShell?: 'powershell';
  readonly unsupportedPlatformMessage?: string;
  supportsPlatform?(platform: string): boolean;
  resolveWindowsShim?(shim: string): ModelHostExecutable | null;
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

const BUILTIN_REVIEW_HOST_ADAPTERS: readonly ReviewHostAdapter[] = Object.freeze([
  codexReviewHostAdapter as ReviewHostAdapter,
  grokBuildReviewHostAdapter as ReviewHostAdapter,
  cursorReviewHostAdapter as ReviewHostAdapter,
]);

const isolatedHostPackages = Object.freeze(new Map(BUILTIN_REVIEW_HOST_ADAPTERS.map((adapter) => [
  adapter.id,
  AGENT_HOST_REGISTRATIONS[adapter.id as keyof typeof AGENT_HOST_REGISTRATIONS].packageName,
])));

export function isolatedReviewHostPackageName(host: string): string | null {
  return isolatedHostPackages.get(host) ?? null;
}

export function unregisteredIsolatedReviewHostMessage(host: string): string {
  const registered = listReviewHostIds();
  return `must name a registered review host adapter, got ${JSON.stringify(host)} (registered: ${registered.join(', ') || 'none'})`;
}

function builtinAdapterMap(): Map<string, ReviewHostAdapter> {
  return new Map(BUILTIN_REVIEW_HOST_ADAPTERS.map(adapter => [adapter.id, adapter]));
}

let reviewHostAdapters = builtinAdapterMap();

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
  reviewHostAdapters = builtinAdapterMap();
}
