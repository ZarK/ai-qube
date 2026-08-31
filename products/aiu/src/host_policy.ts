import path from "node:path";

import { AGENT_HOST_CAPABILITY_PROFILES, AGENT_HOST_CAPABILITY_SUPPORT, type AgentHostCapabilityProfile, type AgentHostCapabilitySupport, type AgentHostProfile, type ContinuationRenderedAsset } from "@tjalve/qube-core";

import type { AiuContinuationMode, AiuHost, AiuHostCapabilityName, AiuHostsConfig } from "./config.js";
import { AIU_CONTINUATION_HOSTS, getAiuContinuationAdapter, getAiuRuntimeHostProfile } from "./continuation_adapters.js";
import { getAiuPackageVersion } from "./package_metadata.js";
import { resolveAiuHookCommand } from "./hook_command.js";

export const AIU_HOST_SUPPORT_LEVELS = AGENT_HOST_CAPABILITY_SUPPORT;
export const AIU_HOST_CAPABILITY_SUPPORT = ["supported", "experimental", "disabled", "unsupported", "unknown"] as const;

export type AiuHostSupportLevel = AgentHostCapabilitySupport;
export type AiuHostCapabilitySupport = (typeof AIU_HOST_CAPABILITY_SUPPORT)[number];
export type AiuHostPromptDelivery = "none" | "stdout" | "host";

export type AiuManagedHostFile = Omit<ContinuationRenderedAsset, "ownership"> & { readonly host: AiuHost } & (
  | { readonly ownership: "dedicated" }
  | { readonly ownership: "shared" }
);

export interface AiuHostCapabilityDescriptor {
  readonly name: AiuHostCapabilityName;
  readonly support: AiuHostCapabilitySupport;
  readonly delivery?: AiuHostPromptDelivery;
  readonly requiredForModes: readonly AiuContinuationMode[];
  readonly description: string;
}

export interface AiuHostStopHookPolicy {
  readonly support: AiuHostCapabilitySupport;
  readonly blocksByDefault: boolean;
  readonly description: string;
}

export interface AiuHostProbePolicy {
  readonly support: AiuHostSupportLevel;
  readonly description: string;
  readonly command?: readonly [string, ...string[]];
}

export interface AiuHostCapabilityProfile {
  readonly tool: AiuHost;
  readonly supportLevel: AiuHostSupportLevel;
  readonly description: string;
  readonly capabilities: Readonly<Record<AiuHostCapabilityName, AiuHostCapabilityDescriptor>>;
  readonly currentIssueRecovery: boolean;
  readonly probe: AiuHostProbePolicy;
  readonly stopHook: AiuHostStopHookPolicy;
  readonly managedFiles: readonly AiuManagedHostFile[];
  readonly trustSteps: readonly string[];
}

export interface AiuHostModePolicyCheck {
  readonly host: AiuHost;
  readonly mode: AiuContinuationMode;
  readonly requiredCapabilities: readonly AiuHostCapabilityName[];
  readonly status: "ok" | "warning" | "error";
  readonly kind: "host-mode-supported" | "host-capability-disabled" | "host-capability-experimental" | "host-capability-unsupported";
  readonly message: string;
  readonly suggestedNextAction: string;
}

export interface AiuHostRuntimePolicyReport {
  readonly enabledHosts: readonly AiuHost[];
  readonly profiles: readonly AiuHostCapabilityProfile[];
  readonly modeChecks: readonly AiuHostModePolicyCheck[];
  readonly warnings: readonly AiuHostModePolicyCheck[];
  readonly errors: readonly AiuHostModePolicyCheck[];
}

const HOST_MODE_REQUIREMENTS: Readonly<Record<AiuContinuationMode, readonly AiuHostCapabilityName[]>> = Object.freeze({
  continue: Object.freeze(["promptDelivery"] satisfies AiuHostCapabilityName[]),
  repair: Object.freeze(["promptDelivery"] satisfies AiuHostCapabilityName[]),
  wait: Object.freeze(["sessionState", "userActivity"] satisfies AiuHostCapabilityName[]),
  stop: Object.freeze([] satisfies AiuHostCapabilityName[]),
});

function buildHostProfile(tool: AiuHost, declared: AgentHostCapabilityProfile, runtime: AgentHostProfile, repoRoot?: string): AiuHostCapabilityProfile {
  const continuation = getAiuContinuationAdapter(tool);
  const stopHook = declared.capabilities["continuation-stop-hook"];
  const idleEvent = declared.capabilities["continuation-idle-event"];
  const selectedSession = declared.capabilities["continuation-selected-session-delivery"];
  const wait = declared.capabilities["continuation-wait"];
  const delivery: AiuHostPromptDelivery = selectedSession.support !== "unsupported" ? "host" : stopHook.support !== "unsupported" ? "stdout" : "none";
  const continuationSupport = selectedSession.support !== "unsupported" ? selectedSession.support : stopHook.support;
  const usesHostDelivery = delivery === "host";
  const usesStopHook = delivery === "stdout";
  const stopHookSupport = stopHook.support;
  const trustSupport = declared.capabilities["repository-trust"].support;
  const capabilities: Record<AiuHostCapabilityName, AiuHostCapabilityDescriptor> = {
    idleEvents: capability("idleEvents", idleEvent.support, [], idleEvent.description),
    stopHook: capability("stopHook", stopHookSupport, [], stopHook.description),
    todoRead: capability("todoRead", declared.capabilities["task-read"].support, [], declared.capabilities["task-read"].description),
    sessionState: capability("sessionState", wait.support, ["wait"], wait.description),
    promptDelivery: capability("promptDelivery", continuationSupport, ["continue", "repair"], selectedSession.support !== "unsupported" ? selectedSession.description : stopHook.description, delivery),
    selectedSession: capability("selectedSession", selectedSession.support, [], selectedSession.description),
    modelTargeting: capability("modelTargeting", "unknown", [], "Model targeting is outside the Umpire continuation contract."),
    userActivity: capability("userActivity", wait.support, ["wait"], wait.description),
    projectTrust: capability("projectTrust", trustSupport, [], declared.capabilities["repository-trust"].description),
  };
  const probe = runtime.umpire.probe;
  return Object.freeze({
    tool,
    supportLevel: continuationSupport,
    description: selectedSession.support !== "unsupported" ? selectedSession.description : stopHook.description,
    capabilities: Object.freeze(capabilities),
    currentIssueRecovery: continuation.declaration.currentIssueRecovery,
    probe: Object.freeze({
      support: probe.support,
      description: probe.description,
      ...(probe.support === "unsupported" ? {} : { command: Object.freeze([...probe.command]) as readonly [string, ...string[]] }),
    }),
    stopHook: Object.freeze({
      support: stopHookSupport,
      blocksByDefault: usesStopHook && continuationSupport !== "unsupported",
      description: usesStopHook
        ? `AI Umpire init enables ${declared.displayName} Stop-hook blocking. An explicit false value disables blocking.`
        : `${declared.displayName} continuation uses host delivery rather than a blocking Stop hook.`,
    }),
    managedFiles: Object.freeze(continuation.renderManagedAssets({
      packageVersions: { "@tjalve/aiu": getAiuPackageVersion() },
      ...(repoRoot && usesStopHook ? { commandPrefix: resolveAiuHookCommand(repoRoot).commandPrefix } : {}),
    }).map((file) => Object.freeze({ ...file, relativePath: file.relativePath.split("/").join(path.sep), host: tool }))),
    trustSteps: Object.freeze(runtime.trust.actions.map((action) => action.description)),
  });
}

export function getAiuHostCapabilityProfile(tool: AiuHost, repoRoot?: string): AiuHostCapabilityProfile {
  return buildHostProfile(tool, AGENT_HOST_CAPABILITY_PROFILES[tool], getAiuRuntimeHostProfile(tool), repoRoot);
}

export function getAiuHostCapabilityProfiles(tools: readonly AiuHost[], repoRoot?: string): readonly AiuHostCapabilityProfile[] {
  return Object.freeze(tools.map((tool) => getAiuHostCapabilityProfile(tool, repoRoot)));
}

export function getAllAiuHostCapabilityProfiles(): readonly AiuHostCapabilityProfile[] {
  return Object.freeze(AIU_CONTINUATION_HOSTS.map((tool) => getAiuHostCapabilityProfile(tool)));
}

export function getDefaultHostCapabilityOverrides(tool: AiuHost): Readonly<Partial<Record<AiuHostCapabilityName, boolean | "none" | "stdout" | "host">>> {
  const profile = getAiuHostCapabilityProfile(tool);
  return Object.freeze(
    Object.fromEntries(
      Object.entries(profile.capabilities).flatMap(([name, capability]) => {
        const value = capabilityOverrideValue(capability);
        return value === undefined ? [] : [[name, value]];
      }),
    ),
  );
}

export function getDefaultHostModes(tool: AiuHost): readonly AiuContinuationMode[] {
  const profile = getAiuHostCapabilityProfile(tool);
  if (!profile.currentIssueRecovery || profile.supportLevel === "unsupported") {
    return Object.freeze(["stop"]);
  }
  return Object.freeze(profile.capabilities.promptDelivery.delivery === "host"
    ? ["continue", "repair", "wait", "stop"]
    : ["continue", "repair", "stop"]);
}

export function getDefaultStopHookBlocking(tool: AiuHost): boolean {
  return getAiuHostCapabilityProfile(tool).stopHook.blocksByDefault;
}

export function evaluateAiuHostRuntimePolicy(hosts: AiuHostsConfig, globalModes: readonly AiuContinuationMode[]): AiuHostRuntimePolicyReport {
  const profiles = getAiuHostCapabilityProfiles(hosts.enabled);
  const modeChecks = profiles.flatMap((profile) => {
    const modes = hosts.modes[profile.tool] ?? globalModes;
    return modes.map((mode) => evaluateHostMode(profile, hosts.capabilities[profile.tool] ?? {}, hosts.stopHookBlocking[profile.tool], mode));
  });
  const warnings = modeChecks.filter((item) => item.status === "warning");
  const errors = modeChecks.filter((item) => item.status === "error");
  return Object.freeze({
    enabledHosts: Object.freeze([...hosts.enabled]),
    profiles,
    modeChecks: Object.freeze(modeChecks),
    warnings: Object.freeze(warnings),
    errors: Object.freeze(errors),
  });
}

function evaluateHostMode(
  profile: AiuHostCapabilityProfile,
  overrides: Readonly<Partial<Record<AiuHostCapabilityName, boolean | "none" | "stdout" | "host">>>,
  stopHookBlocking: boolean | undefined,
  mode: AiuContinuationMode,
): AiuHostModePolicyCheck {
  const requiredCapabilities = HOST_MODE_REQUIREMENTS[mode];
  if ((mode === "continue" || mode === "repair") && profile.capabilities.promptDelivery.delivery === "stdout" && stopHookBlocking !== true) {
    return modeCheck(profile.tool, mode, requiredCapabilities, "error", "host-capability-disabled", `${profile.tool} cannot use ${mode}: Stop hook blocking is disabled.`, `Set hosts.stopHookBlocking.${profile.tool} to true or remove ${mode} from hosts.modes.${profile.tool}.`);
  }
  const unsupported = requiredCapabilities.find((name) => effectiveSupport(profile.capabilities[name], overrides[name]) === "unsupported");
  const disabled = requiredCapabilities.find((name) => effectiveSupport(profile.capabilities[name], overrides[name]) === "disabled");
  const experimental = requiredCapabilities.find((name) => effectiveSupport(profile.capabilities[name], overrides[name]) === "experimental");
  const unknown = requiredCapabilities.find((name) => effectiveSupport(profile.capabilities[name], overrides[name]) === "unknown");
  if (disabled !== undefined) {
    return modeCheck(profile.tool, mode, requiredCapabilities, "error", "host-capability-disabled", `${profile.tool} cannot use ${mode}: required capability ${disabled} is disabled.`, `Enable ${disabled} for ${profile.tool} or remove ${mode} from hosts.modes.${profile.tool}.`);
  }
  if (unsupported !== undefined || unknown !== undefined) {
    const capability = unsupported ?? unknown;
    return modeCheck(profile.tool, mode, requiredCapabilities, "error", "host-capability-unsupported", `${profile.tool} cannot use ${mode}: required capability ${capability} is not supported.`, `Remove ${mode} from hosts.modes.${profile.tool} or choose a host profile that supports ${capability}.`);
  }
  if (experimental !== undefined) {
    return modeCheck(profile.tool, mode, requiredCapabilities, "warning", "host-capability-experimental", `${profile.tool} uses experimental ${experimental} support for ${mode}.`, `Keep ${profile.tool} stop-hook blocking explicitly configured and covered by trusted-state tests.`);
  }
  return modeCheck(profile.tool, mode, requiredCapabilities, "ok", "host-mode-supported", `${profile.tool} supports ${mode} with the configured capabilities.`, "Continue using this host runtime policy.");
}

function modeCheck(
  host: AiuHost,
  mode: AiuContinuationMode,
  requiredCapabilities: readonly AiuHostCapabilityName[],
  status: "ok" | "warning" | "error",
  kind: AiuHostModePolicyCheck["kind"],
  message: string,
  suggestedNextAction: string,
): AiuHostModePolicyCheck {
  return Object.freeze({
    host,
    mode,
    requiredCapabilities: Object.freeze([...requiredCapabilities]),
    status,
    kind,
    message,
    suggestedNextAction,
  });
}

function capability(
  name: AiuHostCapabilityName,
  support: AiuHostCapabilitySupport,
  requiredForModes: readonly AiuContinuationMode[],
  description: string,
  delivery?: AiuHostPromptDelivery,
): AiuHostCapabilityDescriptor {
  return Object.freeze({
    name,
    support,
    ...(delivery ? { delivery } : {}),
    requiredForModes: Object.freeze([...requiredForModes]),
    description,
  });
}

function effectiveSupport(capability: AiuHostCapabilityDescriptor, override: boolean | "none" | "stdout" | "host" | undefined): AiuHostCapabilitySupport {
  if (override === false || override === "none") {
    return "disabled";
  }
  if (override === true || override === "stdout" || override === "host") {
    return capability.support;
  }
  return capability.support;
}

function capabilityOverrideValue(capability: AiuHostCapabilityDescriptor): boolean | "none" | "stdout" | "host" | undefined {
  if (capability.delivery !== undefined) {
    return capability.delivery;
  }
  if (capability.support === "supported" || capability.support === "experimental") {
    return true;
  }
  return undefined;
}
