import { posix as pathPosix } from 'path';
import { isMissingAdapterPackage } from './missing_adapter_package.js';

export type AgentHostId = 'opencode' | 'codex' | 'claude-code' | 'grok-build' | 'cursor';
export type AgentHostSelection = AgentHostId | 'all';

export interface InstructionTarget {
  id: string;
  path: string;
  description: string;
}

export type CommandRenderer =
  | 'make-it-so'
  | 'codex-review-focus-agent'
  | 'claude-review-focus-agent'
  | 'opencode-review-focus-agent'
  | 'codex-review-explorer-agent'
  | 'codex-review-digest-agent'
  | 'codex-review-librarian-agent'
  | 'claude-review-explorer-agent'
  | 'claude-review-digest-agent'
  | 'claude-review-librarian-agent'
  | 'opencode-review-explorer-agent'
  | 'opencode-review-digest-agent'
  | 'opencode-review-librarian-agent'
  | 'grok-review-focus-agent'
  | 'grok-review-explorer-agent'
  | 'grok-review-digest-agent'
  | 'grok-review-librarian-agent';

export interface CommandTarget {
  id: string;
  path: string;
  description: string;
  optional: boolean;
  enabledBy: 'always' | 'opencodeCommandAlias' | 'hostLocalReview';
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
  readonly displayName: string;
  readonly packageName: string | null;
  readonly installed: boolean;
  readonly instructionPaths: readonly string[];
}

const AGENTS_INSTRUCTIONS: InstructionTarget = {
  id: 'agents-instructions',
  path: 'AGENTS.md',
  description: 'Always-loaded Executor instructions for AGENTS.md hosts.',
};

const CLAUDE_INSTRUCTIONS: InstructionTarget = {
  id: 'claude-instructions',
  path: 'CLAUDE.md',
  description: 'Always-loaded Executor instructions for Claude Code hosts.',
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

const OPENCODE_REVIEW_FOCUS_AGENT: CommandTarget = {
  id: 'opencode-review-focus-agent',
  path: pathPosix.join('.opencode', 'agent', 'qube-review-focus.md'),
  description: 'OpenCode read-only subagent for one focused local PR review lane.',
  optional: false,
  enabledBy: 'hostLocalReview',
  renderer: 'opencode-review-focus-agent',
};

const OPENCODE_REVIEW_EXPLORER_AGENT: CommandTarget = {
  id: 'opencode-review-explorer-agent',
  path: pathPosix.join('.opencode', 'agent', 'qube-review-explorer.md'),
  description: 'OpenCode read-only economy subagent that reads and summarizes large texts for a review lane.',
  optional: false,
  enabledBy: 'hostLocalReview',
  renderer: 'opencode-review-explorer-agent',
};

const OPENCODE_REVIEW_DIGEST_AGENT: CommandTarget = {
  id: 'opencode-review-digest-agent',
  path: pathPosix.join('.opencode', 'agent', 'qube-review-digest.md'),
  description: 'OpenCode read-only economy subagent that condenses diffs and test output for a review lane.',
  optional: false,
  enabledBy: 'hostLocalReview',
  renderer: 'opencode-review-digest-agent',
};

const OPENCODE_REVIEW_LIBRARIAN_AGENT: CommandTarget = {
  id: 'opencode-review-librarian-agent',
  path: pathPosix.join('.opencode', 'agent', 'qube-review-librarian.md'),
  description: 'OpenCode read-only economy subagent that locates files, symbols, and prior review evidence for a review lane.',
  optional: false,
  enabledBy: 'hostLocalReview',
  renderer: 'opencode-review-librarian-agent',
};

const BUILTIN_OPENCODE_PROFILE: AgentHostProfile = {
  id: 'opencode',
  displayName: 'OpenCode',
  instructionTargets: [AGENTS_INSTRUCTIONS],
  commandTargets: [OPENCODE_COMMAND, OPENCODE_COMMAND_ALIAS, OPENCODE_REVIEW_FOCUS_AGENT, OPENCODE_REVIEW_EXPLORER_AGENT, OPENCODE_REVIEW_DIGEST_AGENT, OPENCODE_REVIEW_LIBRARIAN_AGENT],
  todo: {
    tools: ['todowrite', 'todoread'],
    fallback: 'Use a visible checklist only if the host todo tools are unavailable.',
    instruction: 'For OpenCode, use `todowrite` and `todoread` directly from the main agent for local issue todos. Never ask a Task/subagent to create, read, or complete todos.',
  },
  dialogue: {
    expectation: 'Operate autonomously in the main OpenCode session. Provider-visible PR reviews and GitHub issue comments remain the durable communication channel for review results.',
  },
  subagents: {
    supported: true,
    instruction: 'OpenCode subagents may be used only for bounded support work; QUBE does not currently have a tested OpenCode fresh-context review-runner API, so local-host review lanes must use Codex or a trusted local-command runner.',
  },
  hooks: {
    supported: true,
    description: 'OpenCode can enforce repository behavior through host permissions or hooks when configured outside Executor init.',
  },
  supportsProjectCommands: true,
};

const HOST_ORDER: AgentHostId[] = ['opencode', 'codex', 'claude-code', 'grok-build', 'cursor'];
const ALL_HOST_IDS: AgentHostId[] = ['opencode', 'codex', 'claude-code', 'grok-build', 'cursor'];

const BUILTIN_PROFILES: Partial<Record<AgentHostId, AgentHostProfile>> = {
  opencode: BUILTIN_OPENCODE_PROFILE,
};

const ADAPTERS: readonly AgentHostAdapterMetadata[] = Object.freeze([
  Object.freeze({ id: 'opencode', displayName: 'OpenCode', packageName: '@tjalve/qube-adapter-opencode', installed: false, instructionPaths: [AGENTS_INSTRUCTIONS.path] }),
  Object.freeze({ id: 'codex', displayName: 'Codex', packageName: '@tjalve/qube-adapter-codex', installed: true, instructionPaths: [AGENTS_INSTRUCTIONS.path] }),
  Object.freeze({ id: 'claude-code', displayName: 'Claude Code', packageName: '@tjalve/qube-adapter-claude-code', installed: true, instructionPaths: [CLAUDE_INSTRUCTIONS.path] }),
  Object.freeze({ id: 'grok-build', displayName: 'Grok Build', packageName: '@tjalve/qube-adapter-grok-build', installed: false, instructionPaths: [AGENTS_INSTRUCTIONS.path] }),
  Object.freeze({ id: 'cursor', displayName: 'Cursor', packageName: '@tjalve/qube-adapter-cursor', installed: false, instructionPaths: [AGENTS_INSTRUCTIONS.path] }),
]);

export function reviewerDisplayName(hostId: string | null | undefined): string {
  const raw = typeof hostId === 'string' ? hostId.trim() : '';
  if (raw === '') return 'unknown-host';
  const adapter = ADAPTERS.find(item => item.id === raw);
  if (adapter) return adapter.displayName;
  if (raw === 'grok') return 'Grok Build';
  return raw;
}

const HOST_PROFILE_EXPORTS: Readonly<Record<AgentHostId, string>> = Object.freeze({
  opencode: 'opencodeHostProfile',
  codex: 'codexHostProfile',
  'claude-code': 'claudeCodeHostProfile',
  'grok-build': 'grokBuildHostProfile',
  cursor: 'cursorHostProfile',
});

const profileCache = new Map<AgentHostId, AgentHostProfile | null>();
const extraProfilesForTests = new Map<AgentHostId, AgentHostProfile>();
let omittedHostProfilePackages = new Set<string>();

function isModuleMissing(error: unknown, packageName: string): boolean {
  return isMissingAdapterPackage(error, packageName);
}

export async function loadHostProfileFromPackage(packageName: string, exportName: string): Promise<AgentHostProfile | null> {
  try {
    const imported = await import(packageName);
    const profile = (imported as Record<string, unknown>)[exportName];
    if (!profile || typeof profile !== 'object') return null;
    return profile as AgentHostProfile;
  } catch (error) {
    if (isModuleMissing(error, packageName)) return null;
    throw error;
  }
}

async function loadPackageProfile(id: AgentHostId): Promise<AgentHostProfile | null> {
  if (profileCache.has(id)) return profileCache.get(id) ?? null;
  const adapter = ADAPTERS.find(item => item.id === id);
  if (adapter?.packageName && omittedHostProfilePackages.has(adapter.packageName)) {
    const builtin = BUILTIN_PROFILES[id] ?? null;
    profileCache.set(id, builtin);
    return builtin;
  }
  if (!adapter?.packageName) {
    const builtin = BUILTIN_PROFILES[id] ?? null;
    profileCache.set(id, builtin);
    return builtin;
  }
  const loaded = await loadHostProfileFromPackage(adapter.packageName, HOST_PROFILE_EXPORTS[id]);
  if (loaded) {
    profileCache.set(id, loaded);
    return loaded;
  }
  const builtin = BUILTIN_PROFILES[id] ?? null;
  profileCache.set(id, builtin);
  return builtin;
}

async function loadProfile(id: AgentHostId): Promise<AgentHostProfile | null> {
  const extra = extraProfilesForTests.get(id);
  if (extra) return extra;
  return loadPackageProfile(id);
}

export function registerAgentHostProfileForTests(profile: AgentHostProfile): void {
  extraProfilesForTests.set(profile.id, profile);
  profileCache.delete(profile.id);
}

export function omitHostProfilePackagesForTests(packageNames: readonly string[]): void {
  omittedHostProfilePackages = new Set(packageNames);
  profileCache.clear();
}

export function resetAgentHostProfilesForTests(): void {
  extraProfilesForTests.clear();
  omittedHostProfilePackages = new Set();
  profileCache.clear();
}

async function getAvailableAgentHostProfiles(): Promise<AgentHostProfile[]> {
  const profiles: AgentHostProfile[] = [];
  for (const id of HOST_ORDER) {
    const profile = await loadProfile(id);
    if (profile) profiles.push(profile);
  }
  return profiles;
}

function missingAdapterMessage(id: AgentHostId, packageName: string): string {
  if (id === 'codex') {
    return `Codex host profile adapter ${packageName} is not installed. Install the adapter or include it as an optional dependency before running \`aie init . --tool codex\`.`;
  }
  if (id === 'claude-code') {
    return `Claude Code host profile adapter ${packageName} is not installed. Install the adapter or include it as an optional dependency before running \`aie init . --tool claude-code\`.`;
  }
  return `Agent host profile adapter ${packageName} is not installed.`;
}

async function resolveProfile(id: AgentHostId): Promise<AgentHostProfile> {
  const loaded = await loadProfile(id);
  if (loaded) return loaded;
  const adapter = ADAPTERS.find(candidate => candidate.id === id);
  if (adapter?.packageName) throw new Error(missingAdapterMessage(id, adapter.packageName));
  throw new Error(`Unknown agent host "${id}".`);
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
  return getAvailableAgentHostProfiles();
}

export function parseAgentHostSelection(value: string): AgentHostId[] | null {
  const parts = value.split(',').map(part => part.trim()).filter(part => part.length > 0);
  if (parts.length === 0) return null;
  const selected: AgentHostId[] = [];
  for (const part of parts) {
    if (part === 'all') {
      selected.push(...ALL_HOST_IDS);
      continue;
    }
    if (part === 'opencode' || part === 'codex' || part === 'claude-code' || part === 'grok-build' || part === 'cursor') {
      selected.push(part);
      continue;
    }
    return null;
  }
  return uniqueAgentHostIds(selected);
}

export function uniqueAgentHostIds(ids: AgentHostId[]): AgentHostId[] {
  const selected = new Set(ids);
  return HOST_ORDER.filter(id => selected.has(id));
}

export async function hostIdsForInstructionPath(path: string): Promise<AgentHostId[] | null> {
  const hosts: AgentHostId[] = [];
  for (const profile of await getAvailableAgentHostProfiles()) {
    if (profile.instructionTargets.some(target => target.path === path)) hosts.push(profile.id);
  }
  return hosts.length === 0 ? null : hosts;
}

export async function getInstructionTargetPaths(ids?: AgentHostId[]): Promise<string[]> {
  const profiles = ids ? await getAgentHostProfiles(ids) : await getAvailableAgentHostProfiles();
  return [...new Set(profiles.flatMap(profile => profile.instructionTargets.map(target => target.path)))];
}

export function registeredInstructionPaths(): string[] {
  const paths = new Set<string>();
  for (const target of registeredInstructionTargets()) {
    if (target.path.trim() !== '') paths.add(target.path);
  }
  return [...paths];
}

export function defaultInstructionContextSources(): string[] {
  const sources: string[] = [];
  const seen = new Set<string>();
  for (const path of registeredInstructionPaths()) {
    const filename = path.split('/').pop() ?? path;
    if (filename === '' || seen.has(filename)) continue;
    seen.add(filename);
    sources.push(filename, `**/${filename}`);
  }
  return sources;
}

function registeredInstructionTargets(): InstructionTarget[] {
  const targets: InstructionTarget[] = [];
  const seen = new Set<string>();
  const add = (path: string) => {
    if (path.trim() === '' || seen.has(path)) return;
    seen.add(path);
    targets.push({ id: path, path, description: `Registered host instruction file ${path}.` });
  };
  for (const adapter of ADAPTERS) {
    for (const path of adapter.instructionPaths) add(path);
  }
  for (const profile of Object.values(BUILTIN_PROFILES)) {
    if (!profile) continue;
    for (const target of profile.instructionTargets) add(target.path);
  }
  return targets;
}
