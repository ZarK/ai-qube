import {
  AGENT_HOST_IDS,
  AGENT_HOST_REGISTRATIONS,
  type AgentHostCapabilitySupport,
  type AgentHostId,
} from "./agent_host.js";
import { resolveExecutable } from "./executable.js";

export const AGENT_HOST_PROFILE_VERSION = 1 as const;
export const AGENT_HOST_READINESS_VERSION = 1 as const;

export const AGENT_HOST_SURFACES = ["cli", "desktop", "cloud"] as const;
export type AgentHostSurface = (typeof AGENT_HOST_SURFACES)[number];

export const AGENT_HOST_CAPABILITY_IDS = [
  "task-read",
  "task-write",
  "subagent-invoke",
  "review-host-guided",
  "review-isolated",
  "model-catalog",
  "model-invoke",
  "continuation-stop-hook",
  "continuation-idle-event",
  "continuation-selected-session-delivery",
  "continuation-wait",
  "session-target",
  "session-resume",
  "process-restart",
  "authentication",
  "repository-trust",
  "sandbox-read-only",
  "permission-approval",
] as const;
export type AgentHostCapabilityId = (typeof AGENT_HOST_CAPABILITY_IDS)[number];

export interface AgentHostSurfaceDescriptor {
  readonly surface: AgentHostSurface;
  readonly support: AgentHostCapabilitySupport;
  readonly description: string;
  readonly unavailableReason: string | null;
}

export interface AgentHostCapabilityDescriptor {
  readonly id: AgentHostCapabilityId;
  readonly support: AgentHostCapabilitySupport;
  readonly surfaces: readonly AgentHostSurface[];
  readonly minimumVersion: string | null;
  readonly description: string;
  readonly unavailableReason: string | null;
  readonly nextAction: string;
}

export interface AgentHostCapabilityProfile {
  readonly version: typeof AGENT_HOST_PROFILE_VERSION;
  readonly id: AgentHostId;
  readonly displayName: string;
  readonly instructionPath: string;
  readonly executables: {
    readonly names: readonly string[];
    readonly windowsNames: readonly string[];
  };
  readonly surfaces: Readonly<Record<AgentHostSurface, AgentHostSurfaceDescriptor>>;
  readonly capabilities: Readonly<Record<AgentHostCapabilityId, AgentHostCapabilityDescriptor>>;
}

type CapabilityDeclaration = Readonly<{
  support: AgentHostCapabilitySupport;
  description: string;
  unavailableReason?: string;
  nextAction?: string;
  surfaces?: readonly AgentHostSurface[];
  minimumVersion?: string | null;
}>;

const unsupportedSurface = (surface: AgentHostSurface, displayName: string): AgentHostSurfaceDescriptor => Object.freeze({
  surface,
  support: "unsupported",
  description: `${displayName} has no QUBE capability contract for its ${surface} surface.`,
  unavailableReason: `No ${surface} adapter surface is declared.`,
});

function surfaceProfile(id: AgentHostId): Readonly<Record<AgentHostSurface, AgentHostSurfaceDescriptor>> {
  const displayName = AGENT_HOST_REGISTRATIONS[id].displayName;
  return Object.freeze({
    cli: Object.freeze({
      surface: "cli",
      support: "supported",
      description: `${displayName} is integrated through its command-line surface.`,
      unavailableReason: null,
    }),
    desktop: unsupportedSurface("desktop", displayName),
    cloud: unsupportedSurface("cloud", displayName),
  });
}

const noCapability = (description: string, nextAction: string): CapabilityDeclaration => Object.freeze({
  support: "unsupported",
  description,
  unavailableReason: description,
  nextAction,
});

function freezeSerializable<T>(value: T, path: string, ancestors = new WeakSet<object>()): T {
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint" || value === undefined) {
    throw new TypeError(`Serializable ${path} cannot contain executable or non-JSON values.`);
  }
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) throw new TypeError(`Serializable ${path} cannot contain cycles.`);
  ancestors.add(value);
  for (const [key, child] of Object.entries(value)) freezeSerializable(child, `${path}.${key}`, ancestors);
  ancestors.delete(value);
  return Object.freeze(value);
}

function capability(
  id: AgentHostCapabilityId,
  declaration: CapabilityDeclaration,
): AgentHostCapabilityDescriptor {
  const surfaces = declaration.surfaces ?? (declaration.support === "unsupported" ? [] : ["cli"]);
  return Object.freeze({
    id,
    support: declaration.support,
    surfaces: Object.freeze([...surfaces]),
    minimumVersion: declaration.minimumVersion ?? null,
    description: declaration.description,
    unavailableReason: declaration.support === "unsupported"
      ? declaration.unavailableReason ?? declaration.description
      : null,
    nextAction: declaration.nextAction ?? "No action is required.",
  });
}

interface HostDeclarations {
  readonly task: AgentHostCapabilitySupport;
  readonly subagents: AgentHostCapabilitySupport;
  readonly hostReview: AgentHostCapabilitySupport;
  readonly isolatedReview: AgentHostCapabilitySupport;
  readonly modelCatalog: AgentHostCapabilitySupport;
  readonly modelInvoke: AgentHostCapabilitySupport;
  readonly stopHook: AgentHostCapabilitySupport;
  readonly idleEvent: AgentHostCapabilitySupport;
  readonly selectedSession: AgentHostCapabilitySupport;
  readonly wait: AgentHostCapabilitySupport;
  readonly trust: AgentHostCapabilitySupport;
  readonly readOnlySandbox: AgentHostCapabilitySupport;
}

const HOST_DECLARATIONS = Object.freeze({
  opencode: Object.freeze({ task: "supported", subagents: "supported", hostReview: "supported", isolatedReview: "unsupported", modelCatalog: "supported", modelInvoke: "unsupported", stopHook: "unsupported", idleEvent: "supported", selectedSession: "supported", wait: "supported", trust: "supported", readOnlySandbox: "supported" }),
  codex: Object.freeze({ task: "supported", subagents: "supported", hostReview: "supported", isolatedReview: "supported", modelCatalog: "supported", modelInvoke: "supported", stopHook: "experimental", idleEvent: "unsupported", selectedSession: "unsupported", wait: "unsupported", trust: "experimental", readOnlySandbox: "supported" }),
  "claude-code": Object.freeze({ task: "supported", subagents: "supported", hostReview: "supported", isolatedReview: "unsupported", modelCatalog: "unsupported", modelInvoke: "unsupported", stopHook: "experimental", idleEvent: "unsupported", selectedSession: "unsupported", wait: "unsupported", trust: "experimental", readOnlySandbox: "supported" }),
  "grok-build": Object.freeze({ task: "unsupported", subagents: "supported", hostReview: "supported", isolatedReview: "supported", modelCatalog: "supported", modelInvoke: "supported", stopHook: "experimental", idleEvent: "unsupported", selectedSession: "unsupported", wait: "unsupported", trust: "experimental", readOnlySandbox: "supported" }),
  cursor: Object.freeze({ task: "unsupported", subagents: "unsupported", hostReview: "unsupported", isolatedReview: "supported", modelCatalog: "supported", modelInvoke: "supported", stopHook: "unsupported", idleEvent: "unsupported", selectedSession: "unsupported", wait: "unsupported", trust: "unsupported", readOnlySandbox: "supported" }),
} as const satisfies Readonly<Record<AgentHostId, HostDeclarations>>);

const HOST_EXECUTABLES = Object.freeze({
  opencode: Object.freeze({ names: Object.freeze(["opencode"]), windowsNames: Object.freeze(["opencode.exe"]) }),
  codex: Object.freeze({ names: Object.freeze(["codex"]), windowsNames: Object.freeze(["codex.exe"]) }),
  "claude-code": Object.freeze({ names: Object.freeze(["claude"]), windowsNames: Object.freeze(["claude.exe"]) }),
  "grok-build": Object.freeze({ names: Object.freeze(["grok"]), windowsNames: Object.freeze(["grok.exe"]) }),
  cursor: Object.freeze({ names: Object.freeze(["cursor-agent", "agent"]), windowsNames: Object.freeze(["cursor-agent.exe", "agent.exe"]) }),
} as const satisfies Readonly<Record<AgentHostId, { readonly names: readonly string[]; readonly windowsNames: readonly string[] }>>);

const HOST_INSTRUCTION_PATHS = Object.freeze({
  opencode: "AGENTS.md",
  codex: "AGENTS.md",
  "claude-code": "CLAUDE.md",
  "grok-build": "AGENTS.md",
  cursor: "AGENTS.md",
} as const satisfies Readonly<Record<AgentHostId, string>>);

function declared(
  support: AgentHostCapabilitySupport,
  available: string,
  unavailable: string,
  nextAction: string,
): CapabilityDeclaration {
  return support === "unsupported"
    ? noCapability(unavailable, nextAction)
    : Object.freeze({ support, description: available, nextAction });
}

function buildProfile(id: AgentHostId): AgentHostCapabilityProfile {
  const displayName = AGENT_HOST_REGISTRATIONS[id].displayName;
  const d = HOST_DECLARATIONS[id];
  const continuationAction = `Use a separately supported ${displayName} continuation mechanism; QUBE does not emulate this capability.`;
  const capabilities = Object.freeze({
    "task-read": capability("task-read", declared(d.task, `${displayName} exposes QUBE task-list reads.`, `${displayName} has no QUBE task-list read integration.`, "Use the visible checklist and provider records.")),
    "task-write": capability("task-write", declared(d.task, `${displayName} exposes QUBE task-list writes.`, `${displayName} has no QUBE task-list write integration.`, "Use the visible checklist and provider records.")),
    "subagent-invoke": capability("subagent-invoke", declared(d.subagents, `${displayName} can start bounded native subagents.`, `${displayName} has no tested QUBE native subagent integration.`, "Use the main session or a harness with tested native subagents.")),
    "review-host-guided": capability("review-host-guided", declared(d.hostReview, `${displayName} can run host-guided review in a fresh read-only context.`, `${displayName} has no tested host-guided review integration.`, "Select a supported host-guided review harness.")),
    "review-isolated": capability("review-isolated", declared(d.isolatedReview, `QUBE can invoke ${displayName} for isolated read-only review.`, `QUBE has no tested isolated ${displayName} review contract.`, "Select host-guided review or a harness with isolated review support.")),
    "model-catalog": capability("model-catalog", declared(d.modelCatalog, `${displayName} exposes a bounded model catalog command.`, `${displayName} has no supported non-interactive model catalog.`, "Select a model explicitly or use the harness model picker.")),
    "model-invoke": capability("model-invoke", declared(d.modelInvoke, `QUBE can bind a selected model to an isolated ${displayName} invocation.`, `QUBE has no tested model-bound ${displayName} invocation contract.`, "Use host-guided execution or a supported invocation adapter.")),
    "continuation-stop-hook": capability("continuation-stop-hook", declared(d.stopHook, `${displayName} can emit a Stop-hook continuation prompt.`, `${displayName} continuation does not use a tested Stop hook.`, continuationAction)),
    "continuation-idle-event": capability("continuation-idle-event", declared(d.idleEvent, `${displayName} can deliver a bounded idle event to the managed continuation plugin.`, `${displayName} does not expose tested idle-event delivery.`, continuationAction)),
    "continuation-selected-session-delivery": capability("continuation-selected-session-delivery", declared(d.selectedSession, `${displayName} can deliver continuation to the selected session.`, `${displayName} does not expose tested selected-session delivery.`, continuationAction)),
    "continuation-wait": capability("continuation-wait", declared(d.wait, `${displayName} can observe whether the selected session is available before delivery.`, `${displayName} does not expose tested continuation wait behavior.`, continuationAction)),
    "session-target": capability("session-target", declared(d.selectedSession, `${displayName} can identify the selected continuation session.`, `${displayName} does not expose a tested session-targeting contract.`, continuationAction)),
    "session-resume": capability("session-resume", noCapability(`QUBE does not resume ${displayName} sessions through the harness adapter.`, "Resume the session in the harness itself.")),
    "process-restart": capability("process-restart", noCapability(`QUBE does not restart ${displayName} processes.`, "Restart the harness outside QUBE if required.")),
    authentication: capability("authentication", Object.freeze({ support: "supported", description: `${displayName} authentication is owned by the harness and must be observed at runtime.`, nextAction: `Authenticate with ${displayName} outside QUBE.` })),
    "repository-trust": capability("repository-trust", declared(d.trust, `${displayName} exposes an explicit repository trust or approval boundary for managed assets.`, `${displayName} has no QUBE-managed trust-gated assets.`, `Review and approve ${displayName} project assets outside QUBE.`)),
    "sandbox-read-only": capability("sandbox-read-only", declared(d.readOnlySandbox, `${displayName} supports the read-only boundary used by its declared review mode.`, `${displayName} has no tested read-only review boundary.`, "Select a harness with a tested read-only review boundary.")),
    "permission-approval": capability("permission-approval", declared(d.trust, `${displayName} requires explicit approval for QUBE-managed executable assets.`, `${displayName} has no QUBE-managed permission approval step.`, `Approve managed ${displayName} assets outside QUBE.`)),
  } satisfies Readonly<Record<AgentHostCapabilityId, AgentHostCapabilityDescriptor>>);
  return defineAgentHostCapabilityProfile({
    version: AGENT_HOST_PROFILE_VERSION,
    id,
    displayName,
    instructionPath: HOST_INSTRUCTION_PATHS[id],
    executables: HOST_EXECUTABLES[id],
    surfaces: surfaceProfile(id),
    capabilities,
  });
}

export function defineAgentHostCapabilityProfile(profile: AgentHostCapabilityProfile): AgentHostCapabilityProfile {
  if (profile.version !== AGENT_HOST_PROFILE_VERSION) {
    throw new TypeError(`Unsupported agent host profile version ${String(profile.version)}. Regenerate the profile with version ${AGENT_HOST_PROFILE_VERSION}.`);
  }
  if (profile.id !== AGENT_HOST_REGISTRATIONS[profile.id]?.id) throw new TypeError(`Unknown agent host profile id: ${String(profile.id)}.`);
  if (profile.executables.names.length === 0 || profile.executables.names.some((name) => name.trim() === "")) {
    throw new TypeError(`Agent host "${profile.id}" requires a non-empty executable identity candidate.`);
  }
  for (const surface of AGENT_HOST_SURFACES) {
    if (profile.surfaces[surface]?.surface !== surface) throw new TypeError(`Agent host "${profile.id}" is missing surface "${surface}".`);
  }
  for (const id of AGENT_HOST_CAPABILITY_IDS) {
    const entry = profile.capabilities[id];
    if (!entry || entry.id !== id) throw new TypeError(`Agent host "${profile.id}" is missing capability "${id}".`);
    if (entry.support === "unsupported" && entry.unavailableReason === null) throw new TypeError(`Unsupported capability "${id}" requires an unavailable reason.`);
    if (entry.support !== "unsupported" && entry.surfaces.length === 0) throw new TypeError(`Available capability "${id}" requires an applicable surface.`);
    if (entry.support === "unsupported" && entry.surfaces.length > 0) throw new TypeError(`Unsupported capability "${id}" cannot declare an applicable surface.`);
    for (const surface of entry.surfaces) {
      if (profile.surfaces[surface].support === "unsupported") throw new TypeError(`Capability "${id}" cannot use unsupported surface "${surface}".`);
    }
  }
  try {
    return freezeSerializable(profile, `agent host profile "${profile.id}"`);
  } catch (error) {
    if (error instanceof TypeError && /non-JSON values/u.test(error.message)) {
      throw new TypeError(`Serializable capability profile "${profile.id}" cannot contain executable functions or non-JSON values.`);
    }
    throw error;
  }
}

export const AGENT_HOST_CAPABILITY_PROFILES: Readonly<Record<AgentHostId, AgentHostCapabilityProfile>> = Object.freeze(
  Object.fromEntries(AGENT_HOST_IDS.map((id) => [id, buildProfile(id)])) as Record<AgentHostId, AgentHostCapabilityProfile>,
);

export function getAgentHostCapabilityProfile(id: AgentHostId): AgentHostCapabilityProfile {
  return AGENT_HOST_CAPABILITY_PROFILES[id];
}

export const AGENT_HOST_READINESS_FACT_IDS = [
  "adapter",
  "executable",
  "version",
  "version-compatibility",
  "authentication",
  "repository-trust",
  "managed-assets",
  "feature-activation",
] as const;
export type AgentHostReadinessFactId = (typeof AGENT_HOST_READINESS_FACT_IDS)[number];
export const AGENT_HOST_READINESS_STATES = ["ready", "blocked", "unknown", "not-required"] as const;
export type AgentHostReadinessState = (typeof AGENT_HOST_READINESS_STATES)[number];

export interface AgentHostReadinessFact {
  readonly id: AgentHostReadinessFactId;
  readonly state: AgentHostReadinessState;
  readonly reasonCode: string;
  readonly reason: string;
  readonly observedAt: string;
  readonly nextAction: string;
}

export interface AgentHostReadinessReport {
  readonly version: typeof AGENT_HOST_READINESS_VERSION;
  readonly host: AgentHostId;
  readonly facts: Readonly<Record<AgentHostReadinessFactId, AgentHostReadinessFact>>;
}

function validateReadinessFact(id: AgentHostReadinessFactId, fact: AgentHostReadinessFact): void {
  if (!fact || fact.id !== id) throw new TypeError(`Readiness fact "${id}" has the wrong identity.`);
  if (!AGENT_HOST_READINESS_STATES.includes(fact.state)) throw new TypeError(`Readiness fact "${id}" has an invalid state.`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(fact.reasonCode) || fact.reason.trim() === "" || fact.nextAction.trim() === "" || !Number.isFinite(Date.parse(fact.observedAt))) {
    throw new TypeError(`Readiness fact "${id}" requires a reason, observation time, and safe next action.`);
  }
  for (const value of [fact.reason, fact.nextAction]) {
    if (/\b(?:token|secret|password|authorization)\s*[:=]/iu.test(value)) throw new TypeError(`Readiness fact "${id}" contains unsafe probe output.`);
    if (value.length > 500 || /[\r\n\0]/u.test(value)) throw new TypeError(`Readiness fact "${id}" contains unbounded probe output.`);
  }
}

export function defineAgentHostReadinessReport(report: AgentHostReadinessReport): AgentHostReadinessReport {
  if (report.version !== AGENT_HOST_READINESS_VERSION) {
    throw new TypeError(`Unsupported agent host readiness version ${String(report.version)}. Re-run the command with a QUBE version that emits version ${AGENT_HOST_READINESS_VERSION}.`);
  }
  if (!AGENT_HOST_IDS.includes(report.host)) throw new TypeError(`Unknown readiness host: ${String(report.host)}.`);
  for (const id of AGENT_HOST_READINESS_FACT_IDS) {
    const fact = report.facts[id];
    if (!fact || fact.id !== id) throw new TypeError(`Readiness report for "${report.host}" is missing fact "${id}".`);
    validateReadinessFact(id, fact);
  }
  return freezeSerializable(report, `agent host readiness report "${report.host}"`);
}

function observedFact(
  id: AgentHostReadinessFactId,
  state: AgentHostReadinessState,
  observedAt: string,
  reason: string,
  nextAction: string,
): AgentHostReadinessFact {
  return Object.freeze({ id, state, reasonCode: `${id}-${state}`, observedAt, reason, nextAction });
}

export function observeAgentHostReadiness(
  profile: AgentHostCapabilityProfile,
  observedAt = new Date().toISOString(),
  resolve: typeof resolveExecutable = resolveExecutable,
): AgentHostReadinessReport {
  const candidates = process.platform === "win32"
    ? [...profile.executables.windowsNames, ...profile.executables.names]
    : profile.executables.names;
  const executable = candidates.map((name) => resolve(name)).find((result) => result.status === "found");
  const present = executable !== undefined;
  const inspectAction = `Run the bounded ${profile.displayName} adapter readiness probe for the selected command.`;
  const missingAction = `Install ${profile.displayName} outside QUBE and expose its CLI on PATH.`;
  const facts = Object.freeze({
    adapter: observedFact("adapter", "ready", observedAt, `The bundled ${AGENT_HOST_REGISTRATIONS[profile.id].packageName} adapter is registered.`, "No action is required."),
    executable: observedFact("executable", present ? "unknown" : "blocked", observedAt, present ? `${profile.displayName} has a PATH candidate, but its identity has not been verified.` : `${profile.displayName} has no executable candidate on PATH.`, present ? inspectAction : missingAction),
    version: observedFact("version", present ? "unknown" : "blocked", observedAt, present ? `${profile.displayName} version has not been observed.` : `${profile.displayName} version cannot be observed without its CLI.`, present ? inspectAction : missingAction),
    "version-compatibility": observedFact("version-compatibility", present ? "unknown" : "blocked", observedAt, present ? `${profile.displayName} compatibility has not been proved.` : `${profile.displayName} compatibility cannot be proved without its CLI.`, present ? inspectAction : missingAction),
    authentication: observedFact("authentication", "unknown", observedAt, `${profile.displayName} authentication was not probed by component discovery.`, inspectAction),
    "repository-trust": observedFact("repository-trust", profile.capabilities["repository-trust"].support === "unsupported" ? "not-required" : "unknown", observedAt, profile.capabilities["repository-trust"].support === "unsupported" ? `${profile.displayName} has no QUBE-managed trust requirement.` : `${profile.displayName} repository trust was not probed by component discovery.`, profile.capabilities["repository-trust"].support === "unsupported" ? "No action is required." : inspectAction),
    "managed-assets": observedFact("managed-assets", profile.capabilities["continuation-stop-hook"].support === "unsupported" && profile.capabilities["continuation-idle-event"].support === "unsupported" ? "not-required" : "unknown", observedAt, "Managed continuation assets were not inspected by component discovery.", "Run the selected init dry-run or doctor command before mutation."),
    "feature-activation": observedFact("feature-activation", "unknown", observedAt, `${profile.displayName} feature activation was not probed by component discovery.`, inspectAction),
  } satisfies Record<AgentHostReadinessFactId, AgentHostReadinessFact>);
  return defineAgentHostReadinessReport({ version: AGENT_HOST_READINESS_VERSION, host: profile.id, facts });
}

export interface AgentHostCommandRequirement {
  readonly command: string;
  readonly capabilities: readonly AgentHostCapabilityId[];
  readonly readinessFacts: readonly AgentHostReadinessFactId[];
}

function requirement(
  command: string,
  capabilities: readonly AgentHostCapabilityId[],
  readinessFacts: readonly AgentHostReadinessFactId[],
): AgentHostCommandRequirement {
  return Object.freeze({ command, capabilities: Object.freeze([...capabilities]), readinessFacts: Object.freeze([...readinessFacts]) });
}

export const AGENT_HOST_COMMAND_REQUIREMENTS = Object.freeze({
  help: requirement("help", [], []),
  version: requirement("version", [], []),
  queue: requirement("queue", [], []),
  view: requirement("view", [], []),
  status: requirement("status", [], []),
  "models-list": requirement("models-list", ["model-catalog"], ["adapter", "executable", "version", "version-compatibility", "authentication", "feature-activation"]),
  "init-dry-run": requirement("init-dry-run", [], ["adapter", "executable", "version", "version-compatibility"]),
  "review-host-guided": requirement("review-host-guided", ["review-host-guided", "sandbox-read-only"], ["adapter", "executable", "version", "version-compatibility", "authentication", "repository-trust", "feature-activation"]),
  "review-isolated": requirement("review-isolated", ["review-isolated", "model-invoke", "sandbox-read-only"], ["adapter", "executable", "version", "version-compatibility", "authentication", "feature-activation"]),
  "continuation-stop-hook": requirement("continuation-stop-hook", ["continuation-stop-hook"], ["adapter", "executable", "version", "version-compatibility", "authentication", "repository-trust", "managed-assets", "feature-activation"]),
  "continuation-selected-session": requirement("continuation-selected-session", ["continuation-idle-event", "continuation-selected-session-delivery", "continuation-wait"], ["adapter", "executable", "version", "version-compatibility", "authentication", "repository-trust", "managed-assets", "feature-activation"]),
} as const);

export function commandRequirement(command: string): AgentHostCommandRequirement {
  const declared = AGENT_HOST_COMMAND_REQUIREMENTS[command as keyof typeof AGENT_HOST_COMMAND_REQUIREMENTS];
  if (!declared) throw new TypeError(`Unknown agent host command requirement: ${command}.`);
  return declared;
}

export interface AgentHostCommandReadiness {
  readonly ready: boolean;
  readonly missingCapabilities: readonly AgentHostCapabilityId[];
  readonly blockingFacts: readonly AgentHostReadinessFactId[];
}

export function evaluateAgentHostCommandReadiness(
  requirement: AgentHostCommandRequirement,
  profile: AgentHostCapabilityProfile,
  report?: AgentHostReadinessReport,
): AgentHostCommandReadiness {
  const missingCapabilities = requirement.capabilities.filter((id) => profile.capabilities[id].support === "unsupported");
  const blockingFacts = requirement.readinessFacts.filter((id) => report?.facts[id].state !== "ready" && report?.facts[id].state !== "not-required");
  return Object.freeze({
    ready: missingCapabilities.length === 0 && blockingFacts.length === 0,
    missingCapabilities: Object.freeze(missingCapabilities),
    blockingFacts: Object.freeze(blockingFacts),
  });
}

export interface AgentHostReadinessProbe {
  readonly id: string;
  readonly facts: readonly AgentHostReadinessFactId[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly run: () => Promise<readonly AgentHostReadinessFact[]>;
}

export async function runBoundedAgentHostReadinessProbe(probe: AgentHostReadinessProbe): Promise<readonly AgentHostReadinessFact[]> {
  if (probe.timeoutMs < 1 || probe.timeoutMs > 30_000) throw new TypeError(`Readiness probe "${probe.id}" requires a timeout from 1 to 30000 ms.`);
  if (probe.maxOutputBytes < 1 || probe.maxOutputBytes > 1024 * 1024) throw new TypeError(`Readiness probe "${probe.id}" exceeds the one-megabyte output bound.`);
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Readiness probe "${probe.id}" timed out.`)), probe.timeoutMs).unref?.();
  });
  const facts = await Promise.race([probe.run(), timeout]);
  const serialized = JSON.stringify(facts);
  if (Buffer.byteLength(serialized, "utf8") > probe.maxOutputBytes) throw new Error(`Readiness probe "${probe.id}" exceeded its output bound.`);
  const allowed = new Set(probe.facts);
  const observed = new Set<AgentHostReadinessFactId>();
  for (const fact of facts) {
    if (!allowed.has(fact.id)) throw new TypeError(`Readiness probe "${probe.id}" returned undeclared fact "${fact.id}".`);
    if (observed.has(fact.id)) throw new TypeError(`Readiness probe "${probe.id}" returned duplicate fact "${fact.id}".`);
    observed.add(fact.id);
    validateReadinessFact(fact.id, fact);
  }
  return Object.freeze([...facts]);
}
