import { executableExistsOnPath } from "@tjalve/qube-core";

export const MODEL_ROUTING_HOSTS = Object.freeze(["codex", "claude-code", "opencode", "grok"] as const);
export type ModelRoutingHostId = (typeof MODEL_ROUTING_HOSTS)[number];

const HOST_COMMANDS: Readonly<Record<ModelRoutingHostId, readonly string[]>> = Object.freeze({
  codex: Object.freeze(["codex"]),
  "claude-code": Object.freeze(["claude"]),
  opencode: Object.freeze(["opencode"]),
  grok: Object.freeze(["grok"]),
});

export function isModelRoutingHost(value: string): value is ModelRoutingHostId {
  return (MODEL_ROUTING_HOSTS as readonly string[]).includes(value);
}

export function detectInstalledRoutingHostsOnPath(
  lookup: (command: string) => boolean = commandExistsOnPath,
): readonly ModelRoutingHostId[] {
  return MODEL_ROUTING_HOSTS.filter(host => HOST_COMMANDS[host].some(lookup));
}

export function commandExistsOnPath(command: string): boolean {
  return executableExistsOnPath(command);
}
