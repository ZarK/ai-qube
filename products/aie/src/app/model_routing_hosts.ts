import { execFileSync } from 'node:child_process';

import {
  detectInstalledRoutingHosts,
  MODEL_ROUTING_HOSTS,
  type ModelRoutingHostId,
} from '../core/model_routing.js';

export function commandExistsOnPath(command: string): boolean {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const result = execFileSync(locator, [command], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return result.split(/\r?\n/).some(line => line.trim() !== '');
  } catch {
    return false;
  }
}

export function detectInstalledRoutingHostsOnPath(
  lookup: (command: string) => boolean = commandExistsOnPath,
): readonly ModelRoutingHostId[] {
  return detectInstalledRoutingHosts(lookup);
}

export function routingHostChoices(installed: readonly ModelRoutingHostId[]): readonly ModelRoutingHostId[] {
  return MODEL_ROUTING_HOSTS.filter(host => installed.includes(host));
}
