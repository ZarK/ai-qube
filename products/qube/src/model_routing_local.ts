import { getAgentHostProfileSync } from "@tjalve/aie";
import { AGENT_HOST_IDS, executableExistsOnPath, type AgentHostId } from "@tjalve/qube-core";

export const MODEL_ROUTING_HOSTS = AGENT_HOST_IDS;
export type ModelRoutingHostId = AgentHostId;

export function isModelRoutingHost(value: string): value is ModelRoutingHostId {
  return (MODEL_ROUTING_HOSTS as readonly string[]).includes(value);
}

export function detectInstalledRoutingHostsOnPath(
  lookup: (command: string) => boolean = commandExistsOnPath,
): readonly ModelRoutingHostId[] {
  return MODEL_ROUTING_HOSTS.filter((host) => {
    const executables = getAgentHostProfileSync(host).executables;
    return [...executables.names, ...executables.windowsNames].some(lookup);
  });
}

export function commandExistsOnPath(command: string): boolean {
  return executableExistsOnPath(command);
}
