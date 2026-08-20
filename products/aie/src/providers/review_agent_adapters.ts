import { AGENT_HOST_REGISTRATIONS, type AgentHostProfile } from '@tjalve/qube-core';
import { getAllAgentHostProfiles } from '../agent_host_adapters.js';

export interface ReviewAgentAdapterDescriptor {
  readonly handle: string;
  readonly id: string;
  readonly aliases: readonly string[];
  readonly name: string;
  readonly trigger: 'github-reviewer' | 'comment' | 'local-host' | 'local-command';
  readonly externalService: boolean;
  readonly summary: string;
  readonly forgeId: string;
  readonly forgeAffinity: readonly string[];
  readonly packageName: string;
  readonly installed: boolean;
}

interface ReviewAgentRegistryEntry {
  readonly forgeId: string;
  readonly packageName: string;
  listAgents(configuredHandles?: readonly string[]): Promise<readonly ReviewAgentAdapterDescriptor[]>;
}

const BUILTIN_LOCAL_COMMAND_AGENT: ReviewAgentAdapterDescriptor = Object.freeze({
  handle: 'local-command',
  id: 'local-command',
  aliases: Object.freeze(['local-command']),
  name: 'local-command',
  trigger: 'local-command',
  externalService: false,
  summary: 'Trusted local-command review runner configured through review lane commands.',
  forgeId: 'builtin',
  forgeAffinity: Object.freeze(['local']),
  packageName: '@tjalve/aie',
  installed: true,
});

function descriptorFromHostProfile(profile: AgentHostProfile): ReviewAgentAdapterDescriptor {
  return Object.freeze({
    handle: profile.id,
    id: profile.id,
    aliases: Object.freeze([profile.id]),
    name: profile.displayName,
    trigger: 'local-host',
    externalService: false,
    summary: profile.review.local.description,
    forgeId: profile.id,
    forgeAffinity: Object.freeze(['local']),
    packageName: AGENT_HOST_REGISTRATIONS[profile.id].packageName,
    installed: true,
  });
}

function descriptorFromGitHubAgent(agent: Record<string, unknown>): ReviewAgentAdapterDescriptor {
  const id = typeof agent.id === 'string' ? agent.id : 'unknown';
  const aliases = Array.isArray(agent.aliases) ? agent.aliases.filter((item): item is string => typeof item === 'string') : [];
  const handle = aliases[0] ? (aliases[0].startsWith('@') ? aliases[0] : `@${aliases[0]}`) : `@${id}`;
  const trigger = typeof agent.triggerFor === 'function'
    ? (agent.triggerFor(id) === 'github-reviewer' ? 'github-reviewer' : 'comment')
    : id === 'copilot'
      ? 'github-reviewer'
      : 'comment';
  return Object.freeze({
    handle,
    id,
    aliases: Object.freeze([...aliases]),
    name: id,
    trigger,
    externalService: id !== 'qubereview',
    summary: `GitHub review agent ${id}.`,
    forgeId: 'github',
    forgeAffinity: Object.freeze(['github']),
    packageName: '@tjalve/qube-adapter-github',
    installed: true,
  });
}

async function loadGitHubReviewAgents(configuredHandles?: readonly string[]): Promise<readonly ReviewAgentAdapterDescriptor[]> {
  try {
    const imported = await import('@tjalve/qube-adapter-github');
    const list = (imported as Record<string, unknown>).listGitHubReviewAgents;
    if (typeof list !== 'function') return [];
    const agents = await Promise.resolve(list(configuredHandles ? { agents: configuredHandles } : undefined));
    if (!Array.isArray(agents)) return [];
    return agents
      .filter((agent): agent is Record<string, unknown> => agent !== null && typeof agent === 'object')
      .map(descriptorFromGitHubAgent);
  } catch {
    return [];
  }
}

const REGISTRY: readonly ReviewAgentRegistryEntry[] = Object.freeze([
  Object.freeze({
    forgeId: 'github',
    packageName: '@tjalve/qube-adapter-github',
    listAgents: loadGitHubReviewAgents,
  }),
]);

function normalizeHandle(handle: string): string {
  const trimmed = handle.trim();
  if (trimmed === '') return trimmed;
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

async function installedHostReviewAgents(): Promise<ReviewAgentAdapterDescriptor[]> {
  const profiles = await getAllAgentHostProfiles();
  return profiles
    .filter(profile => profile.review.local.support !== 'unsupported')
    .map(descriptorFromHostProfile);
}

export async function listReviewAgentAdapters(forgeId: string, configuredHandles?: readonly string[]): Promise<readonly ReviewAgentAdapterDescriptor[]> {
  const localAgents = [BUILTIN_LOCAL_COMMAND_AGENT, ...await installedHostReviewAgents()];
  const builtins = forgeId === 'builtin' || forgeId === 'local' ? localAgents : [];
  const entry = REGISTRY.find(candidate => candidate.forgeId === forgeId);
  if (!entry) return Object.freeze([...builtins]);
  const forgeAgents = await entry.listAgents(configuredHandles);
  return Object.freeze([...builtins, ...forgeAgents]);
}

export async function resolveReviewAgent(handle: string, forgeId = 'github', configuredHandles?: readonly string[]): Promise<ReviewAgentAdapterDescriptor | null> {
  const normalized = normalizeHandle(handle);
  const normalizedId = normalized.replace(/^@/, '').toLowerCase();
  const agents = await listReviewAgentAdapters(forgeId, configuredHandles);
  return agents.find(agent => agent.handle.toLowerCase() === normalized.toLowerCase() || agent.id.toLowerCase() === normalizedId || agent.aliases.some(alias => alias.toLowerCase() === normalizedId)) ?? null;
}
