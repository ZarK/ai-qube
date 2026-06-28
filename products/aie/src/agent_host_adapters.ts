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

const CLAUDE_INSTRUCTIONS: InstructionTarget = {
  id: 'claude-instructions',
  path: 'CLAUDE.md',
  description: 'Always-loaded Executor instructions for Claude Code.',
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

const BUILTIN_CLAUDE_PROFILE: AgentHostProfile = {
  id: 'claude-code',
  displayName: 'Claude Code',
  instructionTargets: [CLAUDE_INSTRUCTIONS],
  commandTargets: [],
  todo: {
    tools: ['TodoWrite', 'TodoRead'],
    fallback: 'Use an explicit visible checklist if the host todo tools are unavailable.',
    instruction: 'For Claude Code, use `TodoWrite` and `TodoRead` or their current host-exposed equivalents directly from the main Claude Code agent. Do not delegate todo operations to subagents.',
  },
  dialogue: {
    expectation: 'Keep issue workflow state visible in the main Claude Code conversation and use subagents only for bounded support work.',
  },
  subagents: {
    supported: true,
    instruction: 'Use Claude Code subagents only for bounded support work; keep issue workflow todos in the main session.',
  },
  hooks: {
    supported: true,
    description: 'Claude Code hooks may exist in host settings; Executor init installs managed instructions only.',
  },
  supportsProjectCommands: false,
};

const HOST_ORDER: AgentHostId[] = ['opencode', 'codex', 'claude-code'];

const BUILTIN_PROFILES: Partial<Record<AgentHostId, AgentHostProfile>> = {
  opencode: BUILTIN_OPENCODE_PROFILE,
  'claude-code': BUILTIN_CLAUDE_PROFILE,
};

const ADAPTERS: readonly AgentHostAdapterMetadata[] = Object.freeze([
  Object.freeze({ id: 'opencode', packageName: '@tjalve/qube-adapter-opencode', installed: false }),
  Object.freeze({ id: 'codex', packageName: '@tjalve/qube-adapter-codex', installed: true }),
  Object.freeze({ id: 'claude-code', packageName: null, installed: true }),
]);

let cachedCodexProfile: AgentHostProfile | null | undefined;

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

async function resolveProfile(id: AgentHostId): Promise<AgentHostProfile> {
  if (id === 'codex') {
    const loaded = await loadCodexProfile();
    if (loaded) return loaded;
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

// Synchronous accessors for existing call sites during adapter transition.
const SYNC_PROFILES: Record<AgentHostId, AgentHostProfile> = {
  opencode: BUILTIN_OPENCODE_PROFILE,
  codex: {
    id: 'codex',
    displayName: 'Codex',
    instructionTargets: [AGENTS_INSTRUCTIONS],
    commandTargets: [{
      id: 'codex-review-focus-agent',
      path: pathPosix.join('.codex', 'agents', 'qube-review-focus.toml'),
      description: 'Codex read-only subagent for one focused local PR review lane.',
      optional: false,
      enabledBy: 'codexLocalReview',
      renderer: 'codex-review-focus-agent',
    }],
    todo: {
      tools: ['update_plan'],
      fallback: 'If no local todo tool is exposed, maintain an equivalent visible checklist in the conversation and use GitHub issue checkboxes/comments for durable shared state.',
      instruction: 'For Codex, use `update_plan` or the host plan/todo tool directly when available. If no local todo tool is exposed, maintain an equivalent visible checklist in the conversation and use GitHub issue checkboxes/comments for durable shared state. Do not invent an OpenCode todo hook.',
    },
    dialogue: {
      expectation: 'Use Codex plan/todo support in the main session, spawn independent Codex subagents for local PR review focuses, wait for all review subagents before publishing provider feedback, and keep durable state in configured provider records.',
    },
    subagents: {
      supported: true,
      instruction: 'For local PR review, create the review session lock, spawn one independent Codex subagent per active focus with `agent_type: "qube-review-focus"` and `fork_context: false` using each lane `promptText` from `pr gate --dry-run --json --local-review-prompts`, wait for all subagents before editing or testing in the main session, run `pr gate <pr> --json` without `--dry-run` to publish provider-visible GitHub feedback, delete the review session lock, then inspect PR comments for merge guidance.',
    },
    hooks: {
      supported: true,
      description: 'Codex host hooks may exist in trusted host configuration; Executor init does not install them.',
    },
    supportsProjectCommands: true,
  },
  'claude-code': BUILTIN_CLAUDE_PROFILE,
};

export function getAgentHostProfileSync(id: AgentHostId): AgentHostProfile {
  return SYNC_PROFILES[id];
}

export function getAgentHostProfilesSync(ids: AgentHostId[]): AgentHostProfile[] {
  const selected = new Set(ids);
  return HOST_ORDER.filter(id => selected.has(id)).map(id => SYNC_PROFILES[id]);
}

export function getAllAgentHostProfilesSync(): AgentHostProfile[] {
  return HOST_ORDER.map(id => SYNC_PROFILES[id]);
}

export function hostIdsForInstructionPathSync(path: string): AgentHostId[] | null {
  const hosts = HOST_ORDER.filter(id => SYNC_PROFILES[id].instructionTargets.some(target => target.path === path));
  return hosts.length === 0 ? null : hosts;
}

export function getInstructionTargetPathsSync(): string[] {
  return [...new Set(getAllAgentHostProfilesSync().flatMap(profile => profile.instructionTargets.map(target => target.path)))];
}