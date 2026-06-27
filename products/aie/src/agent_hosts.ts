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

const CODEX_REVIEW_FOCUS_AGENT: CommandTarget = {
  id: 'codex-review-focus-agent',
  path: pathPosix.join('.codex', 'agents', 'qube-review-focus.toml'),
  description: 'Codex read-only subagent for one focused local PR review lane.',
  optional: false,
  enabledBy: 'codexLocalReview',
  renderer: 'codex-review-focus-agent',
};

const HOST_ORDER: AgentHostId[] = ['opencode', 'codex', 'claude-code'];

const HOST_PROFILES: Record<AgentHostId, AgentHostProfile> = {
  opencode: {
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
  },
  codex: {
    id: 'codex',
    displayName: 'Codex',
    instructionTargets: [AGENTS_INSTRUCTIONS],
    commandTargets: [CODEX_REVIEW_FOCUS_AGENT],
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
      instruction: 'For local PR review, spawn one independent Codex subagent per active focus using each lane `promptText` from `pr gate --dry-run --json --local-review-prompts`. Prefer `.codex/agents/qube-review-focus.toml` when available. Run lanes in parallel when supported, wait for all subagents, then run `pr gate <pr> --json` without `--dry-run` to publish provider-visible feedback.',
    },
    hooks: {
      supported: true,
      description: 'Codex host hooks may exist in trusted host configuration; Executor init does not install them.',
    },
    supportsProjectCommands: true,
  },
  'claude-code': {
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
  },
};

export function parseAgentHostSelection(value: string): AgentHostId[] | null {
  if (value === 'all') return [...HOST_ORDER];
  if (value === 'opencode' || value === 'codex' || value === 'claude-code') return [value];
  return null;
}

export function getAgentHostProfile(id: AgentHostId): AgentHostProfile {
  return HOST_PROFILES[id];
}

export function getAgentHostProfiles(ids: AgentHostId[]): AgentHostProfile[] {
  const selected = new Set(ids);
  return HOST_ORDER.filter(id => selected.has(id)).map(getAgentHostProfile);
}

export function getAllAgentHostProfiles(): AgentHostProfile[] {
  return HOST_ORDER.map(getAgentHostProfile);
}

export function uniqueAgentHostIds(ids: AgentHostId[]): AgentHostId[] {
  const selected = new Set(ids);
  return HOST_ORDER.filter(id => selected.has(id));
}

export function hostIdsForInstructionPath(path: string): AgentHostId[] | null {
  const hosts = HOST_ORDER.filter(id => HOST_PROFILES[id].instructionTargets.some(target => target.path === path));
  return hosts.length === 0 ? null : hosts;
}

export function getInstructionTargetPaths(): string[] {
  return [...new Set(getAllAgentHostProfiles().flatMap(profile => profile.instructionTargets.map(target => target.path)))];
}
