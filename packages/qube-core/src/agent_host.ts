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

export type AgentHostId = "opencode" | "codex" | "claude-code";

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
  readonly enabledBy: "always" | "opencodeCommandAlias" | "codexLocalReview";
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
