import { REVIEW_MODEL_HOST_IDS, type ReviewModelHostId, type ReviewModelsPolicy } from '../core/policy.js';
import { resolveExecutable, type AgentHostExecutables } from '@tjalve/qube-core';
import { getAgentHostProfileSync } from '../agent_host_adapters.js';
import { isRegisteredReviewHost, type ReviewHostProbeCommandRunner } from './review_host_adapters.js';
import { resolveModelHostExecutableSync, resolveWindowsNodeShimSync, type ModelHostExecutable } from './model_review_runner.js';
import { execFileSync } from 'node:child_process';

export type HostModelListingStatus = 'ready' | 'unavailable' | 'blocked';

export interface HostModelListing {
  host: ReviewModelHostId;
  status: HostModelListingStatus;
  models: string[];
  diagnostic: string | null;
}

export interface ConfiguredHostModelStatus {
  host: ReviewModelHostId;
  configured: string[];
  listing: HostModelListing;
  served: string[];
  absent: string[];
}

// Cursor's prompt-free ACP discovery performs three bounded four-second
// requests. Keep the outer catalog process bound above that complete handshake.
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_MAX_BUFFER = 1024 * 1024;

function defaultRunCommand(executable: string, args: readonly string[]): string {
  return execFileSync(executable, [...args], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: PROBE_MAX_BUFFER,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function configuredModelsForHost(models: ReviewModelsPolicy, host: ReviewModelHostId): string[] {
  const ids = new Set<string>();
  for (const tier of ['review', 'economy', 'synthesis'] as const) {
    const binding = models[tier][host];
    if (binding?.model && binding.model.trim() !== '') ids.add(binding.model.trim());
  }
  return [...ids];
}

function resolveCatalogExecutable(host: ReviewModelHostId, executables: AgentHostExecutables): ModelHostExecutable {
  if (isRegisteredReviewHost(host)) return resolveModelHostExecutableSync(host, executables);
  const names = process.platform === 'win32'
    ? [...executables.windowsNames, ...executables.names]
    : executables.names;
  for (const name of names) {
    const resolved = resolveExecutable(name).resolvedPath;
    if (!resolved) continue;
    if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(resolved)) {
      const nodeShim = resolveWindowsNodeShimSync(resolved);
      if (nodeShim) return nodeShim;
    }
    return resolved;
  }
  throw new Error(`${host} model catalog is unavailable. Expose the authenticated ${executables.names[0] ?? host} CLI on PATH; QUBE does not install or authenticate agent harnesses.`);
}

export function listHostModels(
  host: ReviewModelHostId,
  runCommand: ReviewHostProbeCommandRunner = defaultRunCommand,
): HostModelListing {
  let profile;
  try {
    profile = getAgentHostProfileSync(host);
  } catch (error: unknown) {
    return {
      host,
      status: 'unavailable',
      models: [],
      diagnostic: error instanceof Error ? error.message : String(error),
    };
  }
  const discovery = profile.modelDiscovery;
  if (discovery.support === 'unsupported') {
    return {
      host,
      status: 'unavailable',
      models: [],
      diagnostic: `${discovery.description} ${discovery.nextAction}`,
    };
  }
  let executable: string;
  let prefixArgs: string[] = [];
  try {
    const resolved = resolveCatalogExecutable(host, profile.executables);
    if (typeof resolved === 'string') executable = resolved;
    else {
      executable = resolved.executable;
      prefixArgs = [...resolved.prefixArgs];
    }
  } catch (error: unknown) {
    return {
      host,
      status: 'blocked',
      models: [],
      diagnostic: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    const models = discovery.listModels({ executable, prefixArgs, runCommand });
    if (models === null) return { host, status: 'unavailable', models: [], diagnostic: discovery.description };
    return { host, status: 'ready', models: [...models], diagnostic: discovery.support === 'experimental' ? discovery.description : null };
  } catch (error: unknown) {
    return {
      host,
      status: 'blocked',
      models: [],
      diagnostic: error instanceof Error ? error.message : String(error),
    };
  }
}

export function reviewModelHostStatuses(
  models: ReviewModelsPolicy,
  hosts: readonly ReviewModelHostId[] = REVIEW_MODEL_HOST_IDS,
  list: (host: ReviewModelHostId) => HostModelListing = listHostModels,
): ConfiguredHostModelStatus[] {
  return hosts.map(host => {
    const configured = configuredModelsForHost(models, host);
    const listing = list(host);
    const live = new Set(listing.models);
    return {
      host,
      configured,
      listing,
      served: listing.status === 'ready' ? configured.filter(model => live.has(model)) : [],
      absent: listing.status === 'ready' ? configured.filter(model => !live.has(model)) : [],
    };
  });
}
