import type { JsonObject } from "./json_value.js";

export type HostReviewRunnerId = "codex" | "opencode" | "local-command";

export interface HostReviewRunnerCapabilities {
  readonly independentReviewer: boolean;
  readonly freshContext: boolean;
  readonly promptOnly: boolean;
  readonly hooks: boolean;
  readonly evidenceWriting: boolean;
  readonly missingCapabilities: readonly string[];
  readonly nextAction: string;
}

export interface CodexReviewCapability extends HostReviewRunnerCapabilities {
  readonly host: "codex";
}

export interface HostReviewRunnerAdapter {
  readonly id: HostReviewRunnerId;
  probeCapability(configHints?: JsonObject): Promise<HostReviewRunnerCapabilities | CodexReviewCapability>;
}

export const AGENT_HOST_IDS = ["opencode", "codex", "claude-code", "grok-build", "cursor"] as const;
export type AgentHostId = (typeof AGENT_HOST_IDS)[number];

export const RETIRED_GROK_HOST_ID = "grok";
export const GROK_BUILD_EXECUTABLE_NAMES = ["grok"] as const;
export const GROK_BUILD_WINDOWS_EXECUTABLE_NAMES = ["grok.exe"] as const;

export const ISOLATED_REVIEW_HOST_PACKAGE_NAMES = Object.freeze({
  codex: "@tjalve/qube-adapter-codex",
  "grok-build": "@tjalve/qube-adapter-grok-build",
  cursor: "@tjalve/qube-adapter-cursor",
} as const);

export function retiredGrokHostIdMessage(): string {
  return "`grok` is not a host id. Use `grok-build`. The grok CLI remains the Grok Build executable name.";
}

export type IsolatedReviewHostCapabilityNeed = "structured-output" | "read-only-sandbox";

export interface IsolatedReviewHostCapabilities {
  readonly structuredOutput: boolean;
  readonly readOnlySandbox: boolean;
}

export type IsolatedReviewHostExecutable = string | { executable: string; prefixArgs: string[] };

export interface IsolatedReviewHostParsedEnvelope {
  readonly text: string;
  readonly sessionId: string | null;
  readonly transientTexts?: readonly string[];
  /** @deprecated Use transientTexts. Earlier host messages are never review evidence. */
  readonly priorTexts?: readonly string[];
  readonly usage?: Record<string, unknown>;
}

export interface IsolatedReviewHostInvocationContext {
  readonly repoRoot: string;
  readonly model: string | null;
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

export type IsolatedReviewHostProbeCommandRunner = (
  executable: string,
  args: readonly string[],
) => string;

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
  parseEnvelope(stdout: string): IsolatedReviewHostParsedEnvelope | null;
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

export type CommandRenderer = "make-it-so" | "codex-review-focus-agent" | "claude-review-focus-agent" | "opencode-review-focus-agent";

export interface CommandTarget {
  readonly id: string;
  readonly path: string;
  readonly description: string;
  readonly optional: boolean;
  readonly enabledBy: "always" | "opencodeCommandAlias" | "hostLocalReview";
  readonly renderer: CommandRenderer;
}

export interface TodoCapability {
  readonly tools: readonly string[];
  readonly fallback: string;
  readonly instruction: string;
}

export interface DialogueCapability {
  readonly expectation: string;
}

export interface HookCapability {
  readonly supported: boolean;
  readonly description: string;
}

export interface SubagentCapability {
  readonly supported: boolean;
  readonly instruction: string;
}

export interface AgentHostProfile {
  readonly id: AgentHostId;
  readonly displayName: string;
  readonly instructionTargets: readonly InstructionTarget[];
  readonly commandTargets: readonly CommandTarget[];
  readonly todo: TodoCapability;
  readonly dialogue: DialogueCapability;
  readonly subagents: SubagentCapability;
  readonly hooks: HookCapability;
  readonly supportsProjectCommands: boolean;
}
