import { posix as pathPosix } from 'path';

export type AgentHostId = 'opencode' | 'codex' | 'claude-code';
export type AgentHostSelection = AgentHostId | 'all';

export interface InstructionTarget {
  id: string;
  path: string;
  description: string;
}

export type CommandRenderer = 'make-it-so' | 'codex-review-focus-agent';

export interface CommandTarget {
  id: string;
  path: string;
  description: string;
  optional: boolean;
  enabledBy: 'always' | 'opencodeCommandAlias' | 'codexLocalReview';
  renderer: CommandRenderer;
}

export interface TodoCapability {
  tools: string[];
  fallback: string;
  instruction: string;
}

export interface DialogueCapability {
  expectation: string;
}

export interface HookCapability {
  supported: boolean;
  description: string;
}

export interface SubagentCapability {
  supported: boolean;
  instruction: string;
}

export interface AgentHostProfile {
  id: AgentHostId;
  displayName: string;
  instructionTargets: InstructionTarget[];
  commandTargets: CommandTarget[];
  todo: TodoCapability;
  dialogue: DialogueCapability;
  subagents: SubagentCapability;
  hooks: HookCapability;
  supportsProjectCommands: boolean;
}

export interface AgentHostAdapterMetadata {
  readonly id: AgentHostId;
  readonly packageName: string | null;
  readonly installed: boolean;
}

const AGENTS_INSTRUCTIONS: InstructionTarget = {
  id: 'agents-instructions',
  path: 'AGENTS.md',
  description: 'Always-loaded Executor instructions for AGENTS.md hosts.',
};

const OPENCODE_COMMAND: CommandTarget = {
  id: 'opencode-make-it-so',
  path: pathPosix.join('.opencode', 'commands', 'make-it-so.md'),
  description: 'OpenCode project command that starts or resumes the autonomous Executor workflow.',
  optional: false,
  enabledBy: 'always',
  renderer: 'make-it-so',
};

const OPENCODE_COMMAND_ALIAS: CommandTarget = {
  id: 'opencode-makeitso-alias',
  path: pathPosix.join('.opencode', 'commands', 'makeitso.md'),
  description: 'Optional OpenCode convenience alias for make-it-so.',
  optional: true,
  enabledBy: 'opencodeCommandAlias',
  renderer: 'make-it-so',
};

const BUILTIN_OPENCODE_PROFILE: AgentHostProfile = {
  id: 'opencode',
  displayName: 'OpenCode',
  instructionTargets: [AGENTS_INSTRUCTIONS],
  commandTargets: [OPENCODE_COMMAND, OPENCODE_COMMAND_ALIAS],
  todo: {
    tools: ['todowrite', 'todoread'],
    fallback: 'Use a visible checklist only if the host todo tools are unavailable.',
    instruction: 'For OpenCode, use `todowrite` and `todoread` directly from the main agent for local issue todos. Never ask a Task/subagent to create, read, or complete todos.',
  },
  dialogue: {
    expectation: 'Operate autonomously in the main OpenCode session and use subagents only for bounded research or review work.',
  },
  subagents: {
    supported: true,
    instruction: 'Use OpenCode subagents only for bounded research or review work; keep issue workflow todos in the main session.',
  },
  hooks: {
    supported: true,
    description: 'OpenCode can enforce repository behavior through host permissions or hooks when configured outside Executor init.',
  },
  supportsProjectCommands: true,
};

const HOST_ORDER: AgentHostId[] = ['opencode', 'codex', 'claude-code'];

const BUILTIN_PROFILES: Partial<Record<AgentHostId, AgentHostProfile>> = {
  opencode: BUILTIN_OPENCODE_PROFILE,
};

const ADAPTERS: readonly AgentHostAdapterMetadata[] = Object.freeze([
  Object.freeze({ id: 'opencode', packageName: '@tjalve/qube-adapter-opencode', installed: false }),
  Object.freeze({ id: 'codex', packageName: '@tjalve/qube-adapter-codex', installed: true }),
  Object.freeze({ id: 'claude-code', packageName: '@tjalve/qube-adapter-claude-code', installed: true }),
]);

let cachedCodexProfile: AgentHostProfile | null | undefined;
let cachedClaudeCodeProfile: AgentHostProfile | null | undefined;

async function loadCodexProfile(): Promise<AgentHostProfile | null> {
  if (cachedCodexProfile !== undefined) return cachedCodexProfile;
  try {
    const imported = await import('@tjalve/qube-adapter-codex');
    const profile = (imported as Record<string, unknown>).codexHostProfile;
    if (!profile || typeof profile !== 'object') {
      cachedCodexProfile = null;
      return null;
    }
    cachedCodexProfile = profile as AgentHostProfile;
    return cachedCodexProfile;
  } catch {
    cachedCodexProfile = null;
    return null;
  }
}

async function loadClaudeCodeProfile(): Promise<AgentHostProfile | null> {
  if (cachedClaudeCodeProfile !== undefined) return cachedClaudeCodeProfile;
  try {
    const imported = await import('@tjalve/qube-adapter-claude-code');
    const profile = (imported as Record<string, unknown>).claudeCodeHostProfile;
    if (!profile || typeof profile !== 'object') {
      cachedClaudeCodeProfile = null;
      return null;
    }
    cachedClaudeCodeProfile = profile as AgentHostProfile;
    return cachedClaudeCodeProfile;
  } catch (error) {
    if (isModuleMissing(error, '@tjalve/qube-adapter-claude-code')) {
      cachedClaudeCodeProfile = null;
      return null;
    }
    throw error;
  }
}

function isModuleMissing(error: unknown, packageName: string): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? String((error as { code?: unknown }).code) : '';
  return code === 'ERR_MODULE_NOT_FOUND' && error.message.includes(packageName);
}

async function resolveProfile(id: AgentHostId): Promise<AgentHostProfile> {
  if (id === 'codex') {
    const loaded = await loadCodexProfile();
    if (loaded) return loaded;
  }
  if (id === 'claude-code') {
    const loaded = await loadClaudeCodeProfile();
    if (loaded) return loaded;
    throw new Error('Claude Code host profile adapter @tjalve/qube-adapter-claude-code is not installed. Install the adapter or include it as an optional dependency before running `aie init . --tool claude-code`.');
  }
  const builtin = BUILTIN_PROFILES[id];
  if (!builtin) throw new Error(`Unknown agent host "${id}".`);
  return builtin;
}

export function listAgentHostAdapters(): readonly AgentHostAdapterMetadata[] {
  return ADAPTERS;
}

export async function getAgentHostProfile(id: AgentHostId): Promise<AgentHostProfile> {
  return resolveProfile(id);
}

export async function getAgentHostProfiles(ids: AgentHostId[]): Promise<AgentHostProfile[]> {
  const selected = new Set(ids);
  const profiles: AgentHostProfile[] = [];
  for (const id of HOST_ORDER) {
    if (selected.has(id)) profiles.push(await resolveProfile(id));
  }
  return profiles;
}

export async function getAllAgentHostProfiles(): Promise<AgentHostProfile[]> {
  return Promise.all(HOST_ORDER.map(id => resolveProfile(id)));
}

export function parseAgentHostSelection(value: string): AgentHostId[] | null {
  if (value === 'all') return [...HOST_ORDER];
  if (value === 'opencode' || value === 'codex' || value === 'claude-code') return [value];
  return null;
}

export function uniqueAgentHostIds(ids: AgentHostId[]): AgentHostId[] {
  const selected = new Set(ids);
  return HOST_ORDER.filter(id => selected.has(id));
}

export async function hostIdsForInstructionPath(path: string): Promise<AgentHostId[] | null> {
  const hosts: AgentHostId[] = [];
  for (const id of HOST_ORDER) {
    const profile = await resolveProfile(id);
    if (profile.instructionTargets.some(target => target.path === path)) hosts.push(id);
  }
  return hosts.length === 0 ? null : hosts;
}

export async function getInstructionTargetPaths(): Promise<string[]> {
  const profiles = await getAllAgentHostProfiles();
  return [...new Set(profiles.flatMap(profile => profile.instructionTargets.map(target => target.path)))];
}
