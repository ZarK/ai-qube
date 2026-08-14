import { executableExistsOnPath } from '@tjalve/qube-core';

import {
  detectInstalledRoutingHosts,
  MODEL_ROUTING_HOSTS,
  type ModelRoutingHostId,
} from '../core/model_routing.js';

export function commandExistsOnPath(command: string): boolean {
  return executableExistsOnPath(command);
}

export function detectInstalledRoutingHostsOnPath(
  lookup: (command: string) => boolean = commandExistsOnPath,
): readonly ModelRoutingHostId[] {
  return detectInstalledRoutingHosts(lookup);
}

export function routingHostChoices(installed: readonly ModelRoutingHostId[]): readonly ModelRoutingHostId[] {
  return MODEL_ROUTING_HOSTS.filter(host => installed.includes(host));
}
