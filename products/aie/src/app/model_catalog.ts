import { MODEL_ROUTING_HOSTS, type ModelRoutingHostId } from '../core/model_routing.js';
import type { ReviewModelsPolicy } from '../core/policy.js';
import { getReviewHostAdapter, isRegisteredReviewHost, type ReviewHostProbeCommandRunner } from './review_host_adapters.js';
import { resolveModelHostExecutableSync } from './model_review_runner.js';
import { execFileSync } from 'node:child_process';

export type HostModelListingStatus = 'ready' | 'unavailable' | 'blocked';

export interface HostModelListing {
  host: ModelRoutingHostId;
  status: HostModelListingStatus;
  models: string[];
  diagnostic: string | null;
}

export interface ConfiguredHostModelStatus {
  host: ModelRoutingHostId;
  configured: string[];
  listing: HostModelListing;
  served: string[];
  absent: string[];
}

const PROBE_TIMEOUT_MS = 5000;
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

export function configuredModelsForHost(models: ReviewModelsPolicy, host: ModelRoutingHostId): string[] {
  const ids = new Set<string>();
  for (const tier of ['review', 'economy', 'synthesis'] as const) {
    const binding = models[tier][host];
    if (binding?.model && binding.model.trim() !== '') ids.add(binding.model.trim());
  }
  return [...ids];
}

export function listHostModels(
  host: ModelRoutingHostId,
  runCommand: ReviewHostProbeCommandRunner = defaultRunCommand,
): HostModelListing {
  let adapter;
  try {
    adapter = getReviewHostAdapter(host);
  } catch (error: unknown) {
    return {
      host,
      status: 'unavailable',
      models: [],
      diagnostic: error instanceof Error ? error.message : String(error),
    };
  }
  let executable: string;
  let prefixArgs: string[] = [];
  try {
    const resolved = resolveModelHostExecutableSync(host);
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
  if (typeof adapter.listCatalog === 'function') {
    try {
      const models = adapter.listCatalog({ executable, prefixArgs, runCommand });
      if (models === null) return { host, status: 'unavailable', models: [], diagnostic: null };
      return { host, status: 'ready', models, diagnostic: null };
    } catch (error: unknown) {
      return {
        host,
        status: 'blocked',
        models: [],
        diagnostic: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { host, status: 'unavailable', models: [], diagnostic: `The ${host} CLI does not expose a model catalog command.` };
}

function registeredIsolatedRoutingHosts(): readonly ModelRoutingHostId[] {
  return MODEL_ROUTING_HOSTS.filter(host => isRegisteredReviewHost(host));
}

export function reviewModelHostStatuses(
  models: ReviewModelsPolicy,
  hosts: readonly ModelRoutingHostId[] = registeredIsolatedRoutingHosts(),
  list: (host: ModelRoutingHostId) => HostModelListing = listHostModels,
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
