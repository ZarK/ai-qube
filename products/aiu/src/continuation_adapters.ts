import { buildClaudeCodeVerifyInvocation, claudeCodeContinuationAdapter, claudeCodeHostProfile } from "@tjalve/qube-adapter-claude-code";
import { buildCodexVerifyInvocation, codexContinuationAdapter, codexHostProfile } from "@tjalve/qube-adapter-codex";
import { buildGrokBuildVerifyInvocation, grokBuildContinuationAdapter, grokBuildHostProfile } from "@tjalve/qube-adapter-grok-build";
import { buildOpenCodeVerifyInvocation, opencodeContinuationAdapter, opencodeHostProfile } from "@tjalve/qube-adapter-opencode";
import {
  AGENT_HOST_CAPABILITY_PROFILES,
  AGENT_HOST_REGISTRATIONS,
  createContinuationAdapterRegistry,
  type AgentHostId,
  type AgentHostProfile,
  type ContinuationAdapter,
  type ContinuationDecodeResult,
} from "@tjalve/qube-core";

export type AiuContinuationHost = Exclude<AgentHostId, "cursor">;

const adapterList = Object.freeze([
  opencodeContinuationAdapter,
  codexContinuationAdapter,
  claudeCodeContinuationAdapter,
  grokBuildContinuationAdapter,
] satisfies readonly ContinuationAdapter[]);

const runtimeProfiles = Object.freeze([
  opencodeHostProfile,
  codexHostProfile,
  claudeCodeHostProfile,
  grokBuildHostProfile,
] satisfies readonly AgentHostProfile[]);

const adapterRegistry = createContinuationAdapterRegistry(adapterList);
const runtimeProfileRegistry = new Map(runtimeProfiles.map((profile) => [profile.id, profile] as const));

for (const [hostId, adapter] of adapterRegistry) {
  if (!AGENT_HOST_REGISTRATIONS[hostId]) throw new TypeError(`Continuation adapter ${hostId} has no canonical host registration.`);
  const capabilities = AGENT_HOST_CAPABILITY_PROFILES[hostId].capabilities;
  const declaresContinuation = capabilities["continuation-stop-hook"].support !== "unsupported"
    || capabilities["continuation-idle-event"].support !== "unsupported";
  if (!declaresContinuation) throw new TypeError(`Continuation adapter ${hostId} has no declared continuation capability.`);
  if (!runtimeProfileRegistry.has(hostId)) throw new TypeError(`Continuation adapter ${hostId} has no runtime host profile.`);
  if (adapter.declaration.hostId === "cursor") throw new TypeError("Cursor continuation is not supported.");
}

export const AIU_CONTINUATION_HOSTS = Object.freeze([...adapterRegistry.keys()] as AiuContinuationHost[]);

export function getAiuContinuationAdapter(host: AiuContinuationHost): ContinuationAdapter {
  const adapter = adapterRegistry.get(host);
  if (!adapter) throw new TypeError(`No continuation adapter is registered for ${host}.`);
  return adapter;
}

export function getAiuRuntimeHostProfile(host: AiuContinuationHost): AgentHostProfile {
  const profile = runtimeProfileRegistry.get(host);
  if (!profile) throw new TypeError(`No runtime host profile is registered for ${host}.`);
  return profile;
}

export function buildAiuVerifyInvocation(
  host: AiuContinuationHost,
  input: { readonly root: string; readonly prompt: string; readonly model?: string; readonly attachUrl?: string },
): { readonly args: readonly string[]; readonly stdin?: string } {
  if (host === "opencode") return buildOpenCodeVerifyInvocation(input);
  if (host === "codex") return buildCodexVerifyInvocation(input);
  if (host === "claude-code") return buildClaudeCodeVerifyInvocation(input);
  return buildGrokBuildVerifyInvocation(input);
}

export function decodeAiuContinuationEvent(
  host: AiuContinuationHost,
  input: { readonly surface: string; readonly version: string | null; readonly event: unknown },
): ContinuationDecodeResult {
  const adapter = getAiuContinuationAdapter(host);
  const probe = adapter.probe({ surface: input.surface, version: input.version });
  if (probe.status === "blocked") return Object.freeze({ ok: false, code: "unsupported-event", error: probe.reason });
  return adapter.decodeEvent(input.event);
}
