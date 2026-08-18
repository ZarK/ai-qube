import { createRequire } from 'node:module';
import { ISOLATED_REVIEW_HOST_PACKAGE_NAMES } from '@tjalve/qube-core';

export {
  AGENT_HOST_IDS,
  RETIRED_GROK_HOST_ID,
  retiredGrokHostIdMessage,
} from '@tjalve/qube-core';
import type { ReviewModelEffort } from '../core/policy.js';
import { isMissingAdapterPackage } from '../missing_adapter_package.js';
import { redact } from '../redact.js';
import type { LaneUsage } from '../review_usage.js';

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
  readonly windowsShell?: 'powershell';
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

const BUILTIN_REVIEW_HOST_ADAPTERS: readonly ReviewHostAdapter[] = Object.freeze([]);

let omittedReviewHostPackages = new Set<string>();

export function isolatedReviewHostPackageName(host: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(ISOLATED_REVIEW_HOST_PACKAGE_NAMES, host)) return null;
  return ISOLATED_REVIEW_HOST_PACKAGE_NAMES[host as keyof typeof ISOLATED_REVIEW_HOST_PACKAGE_NAMES];
}

export function unregisteredIsolatedReviewHostMessage(host: string): string {
  const packageName = isolatedReviewHostPackageName(host);
  if (packageName) {
    return `must name an installed review host adapter; ${host} is unavailable because ${packageName} is not installed`;
  }
  const registered = listReviewHostIds();
  return `must name a registered review host adapter, got ${JSON.stringify(host)} (registered: ${registered.join(', ') || 'none'})`;
}

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
    if (omittedReviewHostPackages.has(packageName)) continue;
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

export function omitReviewHostPackagesForTests(packageNames: readonly string[]): void {
  omittedReviewHostPackages = new Set(packageNames);
  reviewHostAdapters = loadRegisteredReviewHostAdapters();
}

export function resetReviewHostAdaptersForTests(): void {
  omittedReviewHostPackages = new Set();
  reviewHostAdapters = loadRegisteredReviewHostAdapters();
}
