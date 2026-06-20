import { defineQubeAdapter, type QubeAdapterContract } from "@tjalve/qube-core";

export const opencodeAdapter = defineQubeAdapter({
  id: "opencode",
  packageName: "@tjalve/qube-adapter-opencode",
  surface: "opencode",
  owns: ["session-prompts", "stop-hooks", "plugin-entrypoints"],
  boundary: "OpenCode host behavior stays at the adapter edge; product packages consume host-neutral contracts.",
  contractOnly: true,
} satisfies QubeAdapterContract);

export function opencodeSessionTarget(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (trimmed.length === 0 || trimmed !== sessionId) {
    throw new Error("OpenCode session ids must be non-empty and already normalized.");
  }
  return `opencode:${sessionId}`;
}
