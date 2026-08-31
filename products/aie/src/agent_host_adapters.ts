import { claudeCodeHostProfile } from '@tjalve/qube-adapter-claude-code';
import { codexHostProfile } from '@tjalve/qube-adapter-codex';
import { cursorHostProfile } from '@tjalve/qube-adapter-cursor';
import { grokBuildHostProfile } from '@tjalve/qube-adapter-grok-build';
import { opencodeHostProfile } from '@tjalve/qube-adapter-opencode';
import {
  AGENT_HOST_IDS,
  AGENT_HOST_CAPABILITY_PROFILES,
  AGENT_HOST_REGISTRATIONS,
  defineAgentHostProfile,
  type AgentHostId,
  type AgentHostProfile,
  type AgentHostCapabilityProfile,
  type AgentHostReviewAgentRenderer,
  type AgentHostReviewAgentTarget,
  type InstructionTarget,
} from '@tjalve/qube-core';

export type {
  AgentHostId,
  AgentHostProfile,
  AgentHostReviewAgentRenderer,
  AgentHostReviewAgentTarget,
  InstructionTarget,
} from '@tjalve/qube-core';

export type AgentHostSelection = AgentHostId | 'all';

export interface AgentHostAdapterMetadata {
  readonly id: AgentHostId;
  readonly displayName: string;
  readonly packageName: string;
  readonly instructionPaths: readonly string[];
}

const profilesById = Object.freeze({
  opencode: defineAgentHostProfile(opencodeHostProfile),
  codex: defineAgentHostProfile(codexHostProfile),
  'claude-code': defineAgentHostProfile(claudeCodeHostProfile),
  'grok-build': defineAgentHostProfile(grokBuildHostProfile),
  cursor: defineAgentHostProfile(cursorHostProfile),
} satisfies Readonly<Record<AgentHostId, AgentHostProfile>>);

const adapters: readonly AgentHostAdapterMetadata[] = Object.freeze(
  AGENT_HOST_IDS.map((id) => Object.freeze({
    id,
    displayName: AGENT_HOST_CAPABILITY_PROFILES[id].displayName,
    packageName: AGENT_HOST_REGISTRATIONS[id].packageName,
    instructionPaths: Object.freeze([AGENT_HOST_CAPABILITY_PROFILES[id].instructionPath]),
  })),
);

export function getCanonicalAgentHostProfile(id: AgentHostId): AgentHostCapabilityProfile {
  return AGENT_HOST_CAPABILITY_PROFILES[id];
}

export function reviewerDisplayName(hostId: string | null | undefined): string {
  const raw = typeof hostId === 'string' ? hostId.trim() : '';
  if (raw === '') return 'unknown-host';
  return adapters.find((adapter) => adapter.id === raw)?.displayName ?? raw;
}

export function listAgentHostAdapters(): readonly AgentHostAdapterMetadata[] {
  return adapters;
}

export async function getAgentHostProfile(id: AgentHostId): Promise<AgentHostProfile> {
  return profilesById[id];
}

export function getAgentHostProfileSync(id: AgentHostId): AgentHostProfile {
  return profilesById[id];
}

export async function getAgentHostProfiles(ids: AgentHostId[]): Promise<AgentHostProfile[]> {
  const selected = new Set(ids);
  return AGENT_HOST_IDS.filter((id) => selected.has(id)).map((id) => profilesById[id]);
}

export async function getAllAgentHostProfiles(): Promise<AgentHostProfile[]> {
  return AGENT_HOST_IDS.map((id) => profilesById[id]);
}

export function parseAgentHostSelection(value: string): AgentHostId[] | null {
  const parts = value.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  const selected: AgentHostId[] = [];
  for (const part of parts) {
    if (part === 'all') {
      selected.push(...AGENT_HOST_IDS);
      continue;
    }
    if ((AGENT_HOST_IDS as readonly string[]).includes(part)) {
      selected.push(part as AgentHostId);
      continue;
    }
    return null;
  }
  return uniqueAgentHostIds(selected);
}

export function uniqueAgentHostIds(ids: AgentHostId[]): AgentHostId[] {
  const selected = new Set(ids);
  return AGENT_HOST_IDS.filter((id) => selected.has(id));
}

export async function hostIdsForInstructionPath(path: string): Promise<AgentHostId[] | null> {
  const hosts = AGENT_HOST_IDS.filter((id) => AGENT_HOST_CAPABILITY_PROFILES[id].instructionPath === path);
  return hosts.length === 0 ? null : hosts;
}

export async function getInstructionTargetPaths(ids?: AgentHostId[]): Promise<string[]> {
  const selected = ids ? new Set(ids) : null;
  return [...new Set(
    AGENT_HOST_IDS
      .filter((id) => selected === null || selected.has(id))
      .map((id) => AGENT_HOST_CAPABILITY_PROFILES[id].instructionPath),
  )];
}

export function registeredInstructionPaths(): string[] {
  return [...new Set(AGENT_HOST_IDS.map((id) => AGENT_HOST_CAPABILITY_PROFILES[id].instructionPath))];
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
