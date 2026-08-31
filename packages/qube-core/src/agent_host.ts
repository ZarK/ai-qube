export const AGENT_HOST_IDS = ["opencode", "codex", "claude-code", "grok-build", "cursor"] as const;
export type AgentHostId = (typeof AGENT_HOST_IDS)[number];

export interface AgentHostRegistration {
  readonly id: AgentHostId;
  readonly displayName: string;
  readonly packageName: string;
}

export const AGENT_HOST_REGISTRATIONS = Object.freeze({
  opencode: Object.freeze({
    id: "opencode",
    displayName: "OpenCode",
    packageName: "@tjalve/qube-adapter-opencode",
  }),
  codex: Object.freeze({
    id: "codex",
    displayName: "Codex",
    packageName: "@tjalve/qube-adapter-codex",
  }),
  "claude-code": Object.freeze({
    id: "claude-code",
    displayName: "Claude Code",
    packageName: "@tjalve/qube-adapter-claude-code",
  }),
  "grok-build": Object.freeze({
    id: "grok-build",
    displayName: "Grok Build",
    packageName: "@tjalve/qube-adapter-grok-build",
  }),
  cursor: Object.freeze({
    id: "cursor",
    displayName: "Cursor",
    packageName: "@tjalve/qube-adapter-cursor",
  }),
} as const satisfies Readonly<Record<AgentHostId, AgentHostRegistration>>);

export type IsolatedReviewHostCapabilityNeed = "structured-output" | "read-only-sandbox";

export interface IsolatedReviewHostCapabilities {
  readonly structuredOutput: boolean;
  readonly readOnlySandbox: boolean;
}

export type IsolatedReviewHostExecutable = string | { executable: string; prefixArgs: string[] };

export interface IsolatedReviewHostParsedEnvelope {
  readonly text: string;
  readonly sessionId: string | null;
  /** Actual model identity reported by the executing host, when its envelope provides one. */
  readonly reportedModel?: string;
  /** Fixed adapter diagnostic identifier; never contains host response text. */
  readonly resultDecodeDiagnostic?: string;
  readonly transientTexts?: readonly string[];
  readonly usage?: Record<string, unknown>;
}

export interface IsolatedReviewHostEnvelopeFailure {
  readonly failureReasonCode: string;
  /** Fixed adapter diagnostic identifier; never contains host response text. */
  readonly failureDiagnostic: string;
}

export type IsolatedReviewHostEnvelopeResult =
  | IsolatedReviewHostParsedEnvelope
  | IsolatedReviewHostEnvelopeFailure
  | null;

export interface IsolatedReviewHostInvocationContext {
  readonly repoRoot: string;
  readonly model: string | null;
  /** Exact adapter transport value bound by the current readiness probe. */
  readonly transportModel?: string | null;
  readonly effort: string | null;
  readonly maxTurns: number;
  readonly prompt: string;
  readonly promptPath: string | null;
  readonly schemaPath: string | null;
  readonly schemaJson: string;
}

export interface IsolatedReviewHostBuiltInvocation {
  readonly args: string[];
  readonly stdin: string | null;
}

export type AgentHostCommandRunner = (
  executable: string,
  args: readonly string[],
) => string;

export type IsolatedReviewHostProbeCommandRunner = AgentHostCommandRunner;

export interface IsolatedReviewHostProbeContext {
  readonly model: string | null;
  readonly executable: string;
  readonly prefixArgs: readonly string[];
  readonly runCommand: IsolatedReviewHostProbeCommandRunner;
  readonly version: string;
  readonly platform?: string;
}

export interface IsolatedReviewHostProbeResult {
  readonly status: "ready" | "blocked";
  readonly modelListed: boolean | null;
  readonly diagnostic: string | null;
  readonly reasonCode?: string | null;
  readonly transport?: string | null;
  readonly resolvedModel?: string | null;
  readonly availableModels?: readonly string[];
}

export interface IsolatedReviewHostAdapter {
  readonly id: string;
  readonly executableNames: readonly string[];
  readonly windowsExecutableNames: readonly string[];
  readonly capabilities: IsolatedReviewHostCapabilities;
  readonly requiredCapabilities: readonly IsolatedReviewHostCapabilityNeed[];
  readonly requiresPromptFile: boolean;
  readonly requiresSchemaFile: boolean;
  readonly windowsShell?: "powershell";
  readonly unsupportedPlatformMessage?: string;
  supportsPlatform?(platform: string): boolean;
  resolveWindowsShim?(shim: string): IsolatedReviewHostExecutable | null;
  windowsNodeModulesScriptPath(shimDir: string): string | null;
  windowsFallbackExecutablePath(): string | null;
  buildInvocation(
    context: IsolatedReviewHostInvocationContext,
    executable: IsolatedReviewHostExecutable,
  ): IsolatedReviewHostBuiltInvocation;
  parseEnvelope(stdout: string): IsolatedReviewHostEnvelopeResult;
  probeAfterVersion(context: IsolatedReviewHostProbeContext): IsolatedReviewHostProbeResult;
  listCatalog?(
    context: Pick<IsolatedReviewHostProbeContext, "executable" | "prefixArgs" | "runCommand">,
  ): string[] | null;
}

export interface InstructionTarget {
  readonly id: string;
  readonly path: string;
  readonly description: string;
}

export interface AgentHostExecutables {
  readonly names: readonly string[];
  readonly windowsNames: readonly string[];
}

export type AgentHostReviewAgentRenderer =
  | "codex-review-focus-agent"
  | "codex-review-explorer-agent"
  | "codex-review-digest-agent"
  | "codex-review-librarian-agent"
  | "claude-review-focus-agent"
  | "claude-review-explorer-agent"
  | "claude-review-digest-agent"
  | "claude-review-librarian-agent"
  | "opencode-review-focus-agent"
  | "opencode-review-explorer-agent"
  | "opencode-review-digest-agent"
  | "opencode-review-librarian-agent"
  | "grok-review-focus-agent"
  | "grok-review-explorer-agent"
  | "grok-review-digest-agent"
  | "grok-review-librarian-agent";

export interface AgentHostReviewAgentTarget extends InstructionTarget {
  readonly renderer: AgentHostReviewAgentRenderer;
}

export type MakeItSoSurfaceKind = "command" | "skill";

export interface MakeItSoSurface extends InstructionTarget {
  readonly kind: MakeItSoSurfaceKind;
  readonly invocation: string;
}

export const AGENT_HOST_CAPABILITY_SUPPORT = ["supported", "experimental", "unsupported"] as const;
export type AgentHostCapabilitySupport = (typeof AGENT_HOST_CAPABILITY_SUPPORT)[number];

export interface AgentHostSupportedCapability {
  readonly support: "supported";
  readonly description: string;
  readonly nextAction?: string;
}

export interface AgentHostExperimentalCapability {
  readonly support: "experimental";
  readonly description: string;
  readonly nextAction: string;
}

export interface AgentHostUnsupportedCapability {
  readonly support: "unsupported";
  readonly description: string;
  readonly nextAction: string;
}

export type AgentHostCapability =
  | AgentHostSupportedCapability
  | AgentHostExperimentalCapability
  | AgentHostUnsupportedCapability;

export interface AgentHostTaskListDetails {
  readonly tools: readonly string[];
  readonly fallback: string;
  readonly instruction: string;
}

export type AgentHostTaskListCapability = AgentHostCapability & AgentHostTaskListDetails;

export interface AgentHostSubagentDetails {
  readonly instruction: string;
}

export type AgentHostSubagentCapability =
  | (AgentHostSupportedCapability & AgentHostSubagentDetails)
  | (AgentHostExperimentalCapability & AgentHostSubagentDetails)
  | (AgentHostUnsupportedCapability & AgentHostSubagentDetails);

export type AgentHostReviewModeCapability =
  | ((AgentHostSupportedCapability | AgentHostExperimentalCapability) & {
      readonly freshContext: boolean;
      readonly readOnly: boolean;
      readonly agents: readonly AgentHostReviewAgentTarget[];
    })
  | (AgentHostUnsupportedCapability & {
      readonly freshContext: false;
      readonly readOnly: false;
      readonly agents: readonly AgentHostReviewAgentTarget[];
    });

export interface AgentHostReviewCapability {
  readonly local: AgentHostReviewModeCapability;
  readonly isolated: AgentHostReviewModeCapability;
}

export interface AgentHostModelDiscoveryContext {
  readonly executable: string;
  readonly prefixArgs: readonly string[];
  readonly runCommand: AgentHostCommandRunner;
}

export type AgentHostModelDiscoveryCapability =
  | ((AgentHostSupportedCapability | AgentHostExperimentalCapability) & {
      listModels(context: AgentHostModelDiscoveryContext): readonly string[] | null;
    })
  | AgentHostUnsupportedCapability;

export type AgentHostContinuationDelivery = "host" | "stdout" | "none";

export type AgentHostUmpireContinuationCapability =
  | ((AgentHostSupportedCapability | AgentHostExperimentalCapability) & {
      readonly delivery: Exclude<AgentHostContinuationDelivery, "none">;
      readonly currentIssueRecovery: boolean;
    })
  | (AgentHostUnsupportedCapability & {
      readonly delivery: "none";
      readonly currentIssueRecovery: false;
    });

export type AgentHostUmpireProbeCapability =
  | ((AgentHostSupportedCapability | AgentHostExperimentalCapability) & {
      readonly command: readonly [string, ...string[]];
    })
  | AgentHostUnsupportedCapability;

export interface AgentHostUmpireCapability {
  readonly continuation: AgentHostUmpireContinuationCapability;
  readonly probe: AgentHostUmpireProbeCapability;
}

export type AgentHostTrustAction =
  | {
      readonly id: string;
      readonly kind: "review-files";
      readonly description: string;
      readonly paths: readonly string[];
    }
  | {
      readonly id: string;
      readonly kind: "approve";
      readonly description: string;
    }
  | {
      readonly id: string;
      readonly kind: "run-command";
      readonly description: string;
      readonly command: string;
    };

export interface AgentHostTrustCapability {
  readonly required: boolean;
  readonly description: string;
  readonly actions: readonly AgentHostTrustAction[];
}

export interface AgentHostProfile {
  readonly id: AgentHostId;
  readonly displayName: string;
  readonly executables: AgentHostExecutables;
  readonly instructionTarget: InstructionTarget;
  readonly makeItSo: MakeItSoSurface;
  readonly taskList: AgentHostTaskListCapability;
  readonly subagents: AgentHostSubagentCapability;
  readonly review: AgentHostReviewCapability;
  readonly modelDiscovery: AgentHostModelDiscoveryCapability;
  readonly umpire: AgentHostUmpireCapability;
  readonly trust: AgentHostTrustCapability;
}

export function defineAgentHostProfile<const T extends AgentHostProfile>(profile: T): Readonly<T> {
  if (profile.executables.names.length === 0) {
    throw new Error(`Agent host "${profile.id}" requires at least one executable name.`);
  }
  for (const name of [...profile.executables.names, ...profile.executables.windowsNames]) {
    if (name.trim().length === 0) {
      throw new Error(`Agent host "${profile.id}" cannot declare an empty executable name.`);
    }
  }

  if (profile.review.isolated.agents.length > 0) {
    throw new Error(`Agent host "${profile.id}" cannot attach native agents to isolated review.`);
  }
  if (profile.review.local.support === "unsupported" && profile.review.local.agents.length > 0) {
    throw new Error(`Agent host "${profile.id}" cannot attach native agents to unsupported local review.`);
  }

  if (profile.trust.required && profile.trust.actions.length === 0) {
    throw new Error(`Agent host "${profile.id}" requires at least one trust action.`);
  }
  if (!profile.trust.required && profile.trust.actions.length > 0) {
    throw new Error(`Agent host "${profile.id}" has trust actions but does not mark them as required.`);
  }

  return Object.freeze(profile);
}
