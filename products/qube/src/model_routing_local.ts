import { execFileSync } from "node:child_process";

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
  const locator = process.platform === "win32" ? "where.exe" : "which";
  try {
    const result = execFileSync(locator, [command], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return result.split(/\r?\n/).some(line => line.trim() !== "");
  } catch {
    return false;
  }
}
