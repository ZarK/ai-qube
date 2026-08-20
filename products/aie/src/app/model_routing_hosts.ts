import { executableExistsOnPath } from '@tjalve/qube-core';

import {
  detectInstalledRoutingHosts,
  MODEL_ROUTING_HOSTS,
  type ModelRoutingHostId,
} from '../core/model_routing.js';
import { REVIEW_MODEL_HOST_IDS, type ReviewModelHostId } from '../core/policy.js';
import { getAgentHostProfileSync } from '../agent_host_adapters.js';
import { getReviewHostAdapter, isRegisteredReviewHost } from './review_host_adapters.js';

export function commandExistsOnPath(command: string): boolean {
  return executableExistsOnPath(command);
}

export function detectInstalledRoutingHostsOnPath(
  lookup: (command: string) => boolean = commandExistsOnPath,
): readonly ModelRoutingHostId[] {
  return detectInstalledRoutingHosts(lookup);
}

export function detectInstalledReviewHostsOnPath(
  lookup: (command: string) => boolean = commandExistsOnPath,
  platform: string = process.platform,
  installedRoutingHosts: readonly ModelRoutingHostId[] = detectInstalledRoutingHosts(lookup),
): readonly ReviewModelHostId[] {
  const routingHosts = new Set(installedRoutingHosts);
  return REVIEW_MODEL_HOST_IDS.filter(host => {
    if (routingHosts.has(host as ModelRoutingHostId)) return true;
    if (!isRegisteredReviewHost(host)) return false;
    const adapter = getReviewHostAdapter(host);
    if (adapter.supportsPlatform && !adapter.supportsPlatform(platform)) return false;
    const executables = getAgentHostProfileSync(host).executables;
    const names = platform === 'win32'
      ? [...executables.windowsNames, ...executables.names]
      : executables.names;
    return names.some(lookup);
  });
}

export function routingHostChoices(installed: readonly ModelRoutingHostId[]): readonly ModelRoutingHostId[] {
  return MODEL_ROUTING_HOSTS.filter(host => installed.includes(host));
}
