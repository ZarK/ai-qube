import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ReviewModelEffort } from '../core/policy.js';
import { redact } from '../redact.js';

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
  readonly requiresPromptFile: boolean;
  readonly requiresSchemaFile: boolean;
  readonly windowsExecutableNames: readonly string[];
  windowsNodeModulesScriptPath(shimDir: string): string | null;
  windowsFallbackExecutablePath(): string | null;
  buildInvocation(context: ReviewHostInvocationContext, executable: ModelHostExecutable): ReviewHostBuiltInvocation;
  parseEnvelope(stdout: string): ReviewHostParsedEnvelope | null;
  probeAfterVersion(context: ReviewHostProbeContext): ReviewHostProbeResult;
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

export function parseGrokModelCatalog(output: string): string[] | null {
  const lines = output.split(/\r?\n/);
  const headerIndex = lines.findIndex(line => /available models\s*:/i.test(line));
  if (headerIndex === -1) return null;
  const models: string[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const match = /^\s*\*?\s*([A-Za-z0-9][\w.-]*)/.exec(line);
    if (!match) {
      if (line.trim() === '') continue;
      break;
    }
    models.push(match[1]);
  }
  return models.length > 0 ? models : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseCodexOutput(stdout: string): ReviewHostParsedEnvelope | null {
  const messages: string[] = [];
  let sessionId: string | null = null;
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
  }
  return messages.length === 1 ? { text: messages[0], sessionId } : null;
}

function jsonObjectSequence(text: string): string[] | null {
  let index = 0;
  const objects: string[] = [];
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index])) index += 1;
    if (index >= text.length) break;
    if (text[index] !== '{') return null;
    const start = index;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          index += 1;
          break;
        }
      }
    }
    if (depth !== 0 || inString) return null;
    const candidate = text.slice(start, index);
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (!isRecord(parsed)) return null;
    } catch {
      return null;
    }
    objects.push(candidate);
  }
  return objects.length > 0 ? objects : null;
}

function parseGrokOutput(stdout: string): ReviewHostParsedEnvelope | null {
  try {
    const value: unknown = JSON.parse(stdout);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.text !== 'string') return null;
    const objects = jsonObjectSequence(record.text);
    return objects ? { text: objects.at(-1)!, priorTexts: objects.slice(0, -1), sessionId: typeof record.sessionId === 'string' ? record.sessionId : null } : null;
  } catch {
    return null;
  }
}

const FULL_CAPABILITIES: ReviewHostCapabilities = { structuredOutput: true, readOnlySandbox: true };
const FULL_REQUIRED_CAPABILITIES: readonly ReviewHostCapabilityNeed[] = ['structured-output', 'read-only-sandbox'];

const codexAdapter: ReviewHostAdapter = Object.freeze({
  id: 'codex',
  capabilities: FULL_CAPABILITIES,
  requiredCapabilities: FULL_REQUIRED_CAPABILITIES,
  requiresPromptFile: false,
  requiresSchemaFile: true,
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
  probeAfterVersion(): ReviewHostProbeResult {
    // Codex exposes no model-catalog command, so model presence is verified at
    // execution time; hosts without a configured model use the host default.
    return { status: 'ready', modelListed: null, diagnostic: null };
  },
});

const grokAdapter: ReviewHostAdapter = Object.freeze({
  id: 'grok',
  capabilities: FULL_CAPABILITIES,
  requiredCapabilities: FULL_REQUIRED_CAPABILITIES,
  requiresPromptFile: true,
  requiresSchemaFile: false,
  windowsExecutableNames: Object.freeze(['grok.exe']),
  windowsNodeModulesScriptPath(): string | null {
    return null;
  },
  windowsFallbackExecutablePath(): string | null {
    return join(homedir(), '.grok', 'bin', 'grok.exe');
  },
  buildInvocation(context: ReviewHostInvocationContext): ReviewHostBuiltInvocation {
    if (!context.promptPath) throw new Error('Grok review routing requires a private prompt file.');
    const args: string[] = [
      '--cwd', context.repoRoot,
      '--permission-mode', 'dontAsk',
      '--sandbox', 'strict',
      '--allow', 'Read',
      '--allow', 'Grep',
      '--deny', 'Bash(*)',
      '--deny', 'Edit',
      '--deny', 'WebFetch',
      '--deny', 'MCPTool(*)',
      '--no-plan',
      '--no-subagents',
      '--disable-web-search',
      '--no-memory',
      '--max-turns', String(context.maxTurns),
      '--json-schema', context.schemaJson,
    ];
    if (context.effort) args.push('--reasoning-effort', context.effort);
    if (context.model) args.push('--model', context.model);
    args.push('--verbatim', '--prompt-file', context.promptPath);
    return { args, stdin: null };
  },
  parseEnvelope: parseGrokOutput,
  probeAfterVersion({ model, executable, prefixArgs, runCommand, version }: ReviewHostProbeContext): ReviewHostProbeResult {
    if (!model) return { status: 'ready', modelListed: null, diagnostic: null };
    let catalogOutput: string;
    try {
      catalogOutput = runCommand(executable, [...prefixArgs, 'models']);
    } catch {
      return {
        status: 'blocked',
        modelListed: null,
        diagnostic: `The grok CLI resolved (${version}) but its model catalog could not be read. Run \`grok models\` manually and fix authentication or CLI state before running routed review lanes.`,
      };
    }
    const catalog = parseGrokModelCatalog(catalogOutput);
    if (!catalog) {
      return {
        status: 'blocked',
        modelListed: null,
        diagnostic: `The grok CLI resolved (${version}) but its model catalog output was unrecognized. Run \`grok models\` manually and update the trusted review route configuration.`,
      };
    }
    if (!catalog.includes(model)) {
      return {
        status: 'blocked',
        modelListed: false,
        diagnostic: `Configured review model "${model}" is not in the grok catalog (${sanitizeProbeText(catalog.join(', '))}). Update the trusted review model configuration to a listed model.`,
      };
    }
    return { status: 'ready', modelListed: true, diagnostic: null };
  },
});

const BUILTIN_REVIEW_HOST_ADAPTERS: readonly ReviewHostAdapter[] = Object.freeze([codexAdapter, grokAdapter]);

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
