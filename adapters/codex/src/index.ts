import { posix as pathPosix } from "node:path";

import { defineQubeAdapter, type QubeAdapterCapability, type QubeAdapterContract } from "@tjalve/qube-core";

export type CodexOperation =
  | "detect-host"
  | "read-instructions"
  | "install-review-focus-agent"
  | "use-plan-todos"
  | "spawn-review-subagent"
  | "probe-local-review-runner";

export type CodexSupport = "supported" | "standalone" | "unsupported";

export interface CodexOperationSupport {
  readonly id: CodexOperation | string;
  readonly support: CodexSupport;
  readonly owner: string;
  readonly summary: string;
  readonly nextAction: string;
  readonly paths?: readonly string[];
  readonly tools?: readonly string[];
}

export interface CodexReviewCapability {
  readonly host: "codex";
  readonly independentReviewer: boolean;
  readonly freshContext: boolean;
  readonly promptOnly: boolean;
  readonly hooks: boolean;
  readonly evidenceWriting: boolean;
  readonly missingCapabilities: readonly string[];
  readonly nextAction: string;
}

export interface InstructionTarget {
  readonly id: string;
  readonly path: string;
  readonly description: string;
}

export type CommandRenderer = "make-it-so" | "codex-review-focus-agent";

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
  readonly id: "codex";
  readonly displayName: string;
  readonly instructionTargets: readonly InstructionTarget[];
  readonly commandTargets: readonly CommandTarget[];
  readonly todo: TodoCapability;
  readonly dialogue: DialogueCapability;
  readonly subagents: SubagentCapability;
  readonly hooks: HookCapability;
  readonly supportsProjectCommands: boolean;
}

const AGENTS_INSTRUCTIONS: InstructionTarget = Object.freeze({
  id: "agents-instructions",
  path: "AGENTS.md",
  description: "Always-loaded Executor instructions for AGENTS.md hosts.",
});

const CODEX_REVIEW_FOCUS_AGENT: CommandTarget = Object.freeze({
  id: "codex-review-focus-agent",
  path: pathPosix.join(".codex", "agents", "qube-review-focus.toml"),
  description: "Codex read-only subagent for one focused local PR review lane.",
  optional: false,
  enabledBy: "codexLocalReview",
  renderer: "codex-review-focus-agent",
});

export const codexHostProfile: AgentHostProfile = Object.freeze({
  id: "codex",
  displayName: "Codex",
  instructionTargets: Object.freeze([AGENTS_INSTRUCTIONS]),
  commandTargets: Object.freeze([CODEX_REVIEW_FOCUS_AGENT]),
  todo: Object.freeze({
    tools: Object.freeze(["update_plan"]),
    fallback: "If no local todo tool is exposed, maintain an equivalent visible checklist in the conversation and use GitHub issue checkboxes/comments for durable shared state.",
    instruction: "For Codex, use `update_plan` or the host plan/todo tool directly when available. If no local todo tool is exposed, maintain an equivalent visible checklist in the conversation and use GitHub issue checkboxes/comments for durable shared state. Do not invent an OpenCode todo hook.",
  }),
  dialogue: Object.freeze({
    expectation: "Use Codex plan/todo support in the main session, spawn independent Codex subagents for local PR review focuses, wait for all review subagents before publishing provider feedback, and keep durable state in configured provider records.",
  }),
  subagents: Object.freeze({
    supported: true,
    instruction: "For local PR review, create the review session lock, spawn one independent Codex subagent per active focus with `agent_type: \"qube-review-focus\"` and `fork_context: false` using each lane `promptText` from `pr gate --dry-run --json --local-review-prompts`, wait for all subagents before editing or testing in the main session, run `pr gate <pr> --json` without `--dry-run` to publish provider-visible GitHub feedback, delete the review session lock, then inspect PR comments for merge guidance.",
  }),
  hooks: Object.freeze({
    supported: true,
    description: "Codex host hooks may exist in trusted host configuration; Executor init does not install them.",
  }),
  supportsProjectCommands: true,
});

const SUPPORTED_OPERATIONS = Object.freeze([
  freezeOperation({
    id: "detect-host",
    support: "supported",
    owner: "@tjalve/qube-adapter-codex",
    summary: "Detect Codex repository affordances from AGENTS.md and .codex/agents.",
    nextAction: "Use codexHostProfile before claiming installed Codex review support.",
    paths: ["AGENTS.md", ".codex/agents"],
  }),
  freezeOperation({
    id: "probe-local-review-runner",
    support: "supported",
    owner: "@tjalve/aie",
    summary: "Probe whether Codex can run independent fresh-context local review lanes.",
    nextAction: "Use probeCodexReviewCapability before requiring local-host review lanes.",
  }),
  freezeOperation({
    id: "spawn-review-subagent",
    support: "supported",
    owner: "Codex host",
    summary: "Codex can spawn independent qube-review-focus subagents from rendered lane promptText.",
    nextAction: "Use pr gate --dry-run --json --local-review-prompts and spawn one subagent per lane.",
  }),
]);

const UNSUPPORTED_OPERATIONS = Object.freeze([
  freezeOperation({
    id: "install-review-focus-agent",
    support: "unsupported",
    owner: "@tjalve/aie",
    summary: "Codex review-focus agent installation is owned by Executor init, not the adapter runtime.",
    nextAction: "Use qube aie init . --tool codex for managed review-focus agent files.",
    paths: [CODEX_REVIEW_FOCUS_AGENT.path],
  }),
]);

const CODEX_OPERATIONS = Object.freeze([...SUPPORTED_OPERATIONS, ...UNSUPPORTED_OPERATIONS]);
const CODEX_OPERATION_MAP = new Map<string, CodexOperationSupport>(
  CODEX_OPERATIONS.map((operation) => [operation.id, operation]),
);

export const codexAdapter = defineQubeAdapter({
  id: "codex",
  packageName: "@tjalve/qube-adapter-codex",
  surface: "codex",
  owns: ["host-detection", "instruction-targets", "review-subagents", "local-review-probes", "unsupported-capability-reporting"],
  boundary: "Codex host behavior stays at the adapter edge; product packages consume explicit capability records and own product-specific side effects.",
  capabilities: Object.freeze(CODEX_OPERATIONS.map(toQubeCapability)),
  contractOnly: false,
} satisfies QubeAdapterContract);

export function probeCodexReviewCapability(independentReviewerCommand?: string | null, hostProvided = false): CodexReviewCapability {
  const commandConfigured = typeof independentReviewerCommand === "string" && independentReviewerCommand.trim() !== "";
  const canSpawnFreshReviewer = commandConfigured || hostProvided;
  return Object.freeze({
    host: "codex",
    independentReviewer: canSpawnFreshReviewer,
    freshContext: canSpawnFreshReviewer,
    promptOnly: !canSpawnFreshReviewer,
    hooks: false,
    evidenceWriting: canSpawnFreshReviewer,
    missingCapabilities: Object.freeze(canSpawnFreshReviewer ? [] : ["codex-local-reviewer-not-configured"]),
    nextAction: commandConfigured
      ? "Codex local-host review execution is configured; run local-host lanes and record current-head local-host evidence."
      : hostProvided
        ? "QUBE rendered promptText for host-run Codex subagents. Spawn independent Codex subagents from the active host and record local-host evidence with task, session, or thread provenance, then rerun the PR gate."
        : "Codex local-host review support was not explicitly configured. Configure codex as a local review agent or provide a trusted local-host command before requiring local-host review lanes.",
  });
}

export interface CodexHostRunnerAdapter {
  readonly id: "codex";
  readonly host: "codex";
  probe(independentReviewerCommand?: string | null, hostProvided?: boolean): CodexReviewCapability;
}

export const codexHostRunnerAdapter: CodexHostRunnerAdapter = Object.freeze({
  id: "codex",
  host: "codex",
  probe: probeCodexReviewCapability,
});

export function createCodexHostRunnerAdapter(): CodexHostRunnerAdapter {
  return codexHostRunnerAdapter;
}

export function getCodexOperationSupport(operation: CodexOperation | string): CodexOperationSupport {
  return CODEX_OPERATION_MAP.get(operation) ?? unsupportedOperation(operation);
}

export function listCodexOperationSupport(): readonly CodexOperationSupport[] {
  return Object.freeze([...CODEX_OPERATIONS]);
}

function unsupportedOperation(operation: string): CodexOperationSupport {
  return freezeOperation({
    id: operation,
    support: "unsupported",
    owner: "@tjalve/qube-adapter-codex",
    summary: "No product package has registered real Codex behavior for this capability.",
    nextAction: "Use a documented QUBE package command or add a tested adapter capability before exposing this operation.",
  });
}

function toQubeCapability(operation: CodexOperationSupport): QubeAdapterCapability {
  return Object.freeze({
    id: operation.id,
    support: operation.support,
    owner: operation.owner,
    summary: operation.summary,
  });
}

function freezeOperation(operation: CodexOperationSupport): CodexOperationSupport {
  return Object.freeze({
    ...operation,
    ...(operation.paths ? { paths: Object.freeze([...operation.paths]) } : {}),
    ...(operation.tools ? { tools: Object.freeze([...operation.tools]) } : {}),
  });
}