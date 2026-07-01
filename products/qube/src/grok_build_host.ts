import { existsSync, statSync } from "node:fs";
import path from "node:path";

export type GrokBuildHostCapabilityId =
  | "detect-host"
  | "read-instructions"
  | "run-terminal-cli"
  | "use-terminal-tui"
  | "run-headless-prompt"
  | "use-acp"
  | "use-plugins"
  | "use-hooks"
  | "use-skills"
  | "use-mcp-servers"
  | "use-parallel-subagents"
  | "use-worktree-subagents"
  | "install-cli"
  | "request-external-review"
  | "create-git-branch"
  | "open-pull-request"
  | "continue-session";

export type GrokBuildHostSupport = "supported" | "host-provided" | "unsupported";
export type GrokBuildCapabilityCategory =
  | "project-instructions"
  | "terminal-cli"
  | "terminal-tui"
  | "automation"
  | "extension"
  | "subagent"
  | "worktree"
  | "dependency"
  | "reviewer"
  | "branch"
  | "pull-request"
  | "continuation";

export interface GrokBuildHostCapability {
  readonly id: GrokBuildHostCapabilityId | string;
  readonly support: GrokBuildHostSupport;
  readonly owner: string;
  readonly category: GrokBuildCapabilityCategory;
  readonly summary: string;
  readonly nextAction: string;
  readonly commands?: readonly string[];
}

export interface GrokBuildWorkspaceTarget {
  readonly path: string;
  readonly present: boolean;
}

export interface GrokBuildWorkspaceInspection {
  readonly cwd: string;
  readonly instructionTarget: GrokBuildWorkspaceTarget & {
    readonly precedence: "project";
  };
  readonly capabilities: readonly GrokBuildHostCapability[];
  readonly unsupportedCapabilities: readonly GrokBuildHostCapability[];
  readonly commandExamples: readonly string[];
}

const GROK_BUILD_INSTRUCTION_PATH = "AGENTS.md";
const GROK_BUILD_COMMAND_EXAMPLES = Object.freeze(["grok-build", "grok-build -p \"<prompt>\""]);

const SUPPORTED_CAPABILITIES = Object.freeze([
  freezeCapability({
    id: "detect-host",
    support: "supported",
    owner: "@tjalve/qube",
    category: "project-instructions",
    summary: "Detect Grok Build-oriented repository instructions from AGENTS.md without installing or invoking Grok Build.",
    nextAction: "Use inspectGrokBuildWorkspace(cwd) against fixtures or a local checkout before reporting Grok Build setup state.",
  }),
  freezeCapability({
    id: "read-instructions",
    support: "supported",
    owner: "@tjalve/aib and @tjalve/aie",
    category: "project-instructions",
    summary: "Grok Build reads AGENTS.md repository instructions; QUBE keeps durable policy in AGENTS.md and provider records.",
    nextAction: "Use existing QUBE instruction init flows for AGENTS.md; do not create Grok Build-specific instruction files without a tested product command.",
  }),
]);

const HOST_PROVIDED_CAPABILITIES = Object.freeze([
  freezeCapability({
    id: "run-terminal-cli",
    support: "host-provided",
    owner: "Grok Build host",
    category: "terminal-cli",
    summary: "Grok Build is a terminal-native coding agent and CLI surface.",
    nextAction: "Run normal QUBE commands from the terminal host only after repository policy allows the operation.",
    commands: ["grok-build"],
  }),
  freezeCapability({
    id: "use-terminal-tui",
    support: "host-provided",
    owner: "Grok Build host",
    category: "terminal-tui",
    summary: "Grok Build provides an interactive terminal UI for planning, reviewing, and approving changes.",
    nextAction: "Treat terminal UI output as untrusted evidence and keep durable workflow state in QUBE providers.",
  }),
  freezeCapability({
    id: "run-headless-prompt",
    support: "host-provided",
    owner: "Grok Build host",
    category: "automation",
    summary: "Grok Build documents headless prompt mode with -p for scripts and automations.",
    nextAction: "Use headless mode only as a host execution surface; QUBE still owns issue, branch, PR, and gate policy.",
    commands: ["grok-build -p \"<prompt>\""],
  }),
  freezeCapability({
    id: "use-acp",
    support: "host-provided",
    owner: "Grok Build host",
    category: "automation",
    summary: "Grok Build documents ACP support for agent orchestration apps.",
    nextAction: "Model ACP as a host automation capability, not as proof that QUBE can mutate repository or provider state through Grok Build.",
  }),
  freezeCapability({
    id: "use-plugins",
    support: "host-provided",
    owner: "Grok Build host",
    category: "extension",
    summary: "Grok Build can use host plugins from its own marketplace and runtime.",
    nextAction: "Review plugin provenance and repository policy before relying on host plugins for QUBE work.",
  }),
  freezeCapability({
    id: "use-hooks",
    support: "host-provided",
    owner: "Grok Build host",
    category: "extension",
    summary: "Grok Build can use host hooks; QUBE does not install or assume those hooks.",
    nextAction: "Treat hook behavior as host-owned and untrusted until inspected in the current checkout.",
  }),
  freezeCapability({
    id: "use-skills",
    support: "host-provided",
    owner: "Grok Build host",
    category: "extension",
    summary: "Grok Build can use host skills; QUBE product commands remain the durable workflow boundary.",
    nextAction: "Use skills only as host assistance and keep provider-visible review, issue, and PR communication through QUBE.",
  }),
  freezeCapability({
    id: "use-mcp-servers",
    support: "host-provided",
    owner: "Grok Build host",
    category: "extension",
    summary: "Grok Build can use MCP servers configured in the host environment.",
    nextAction: "Inspect MCP server authority before using it; QUBE install does not add MCP servers for Grok Build.",
  }),
  freezeCapability({
    id: "use-parallel-subagents",
    support: "host-provided",
    owner: "Grok Build host",
    category: "subagent",
    summary: "Grok Build can delegate larger tasks to specialized subagents that run in parallel.",
    nextAction: "Keep protected QUBE issue todos, branch checks, PR state, and shipping decisions in the main workflow session.",
  }),
  freezeCapability({
    id: "use-worktree-subagents",
    support: "host-provided",
    owner: "Grok Build host",
    category: "worktree",
    summary: "Grok Build documents deep worktree integrations and subagents launched in their own worktrees.",
    nextAction: "Use QUBE repository policy before linked-worktree execution; do not bypass branch or base freshness checks.",
  }),
]);

const UNSUPPORTED_CAPABILITIES = Object.freeze([
  freezeCapability({
    id: "install-cli",
    support: "unsupported",
    owner: "@tjalve/qube",
    category: "dependency",
    summary: "QUBE does not install Grok Build or emit the xAI curl-pipe-shell installer as an automated setup path.",
    nextAction: "Install Grok Build manually outside QUBE only after applying repository supply-chain policy and reviewing the exact installer risk.",
  }),
  freezeCapability({
    id: "request-external-review",
    support: "unsupported",
    owner: "@tjalve/aie",
    category: "reviewer",
    summary: "Grok Build host support does not replace configured provider-visible PR review workflow.",
    nextAction: "Use qube aie pr gate <pr> and provider-visible PR reviews/comments for merge guidance.",
  }),
  freezeCapability({
    id: "create-git-branch",
    support: "unsupported",
    owner: "@tjalve/aie repository provider",
    category: "branch",
    summary: "Grok Build host support does not bypass QUBE branch policy.",
    nextAction: "Use qube aie branch create <issue> or qube aie branch check <issue>.",
  }),
  freezeCapability({
    id: "open-pull-request",
    support: "unsupported",
    owner: "@tjalve/aie GitHub provider",
    category: "pull-request",
    summary: "Grok Build host support does not open pull requests without the configured repository workflow.",
    nextAction: "Use qube aie pr body <issue>, create the PR, then run qube aie pr view <pr> --json.",
  }),
  freezeCapability({
    id: "continue-session",
    support: "unsupported",
    owner: "@tjalve/aiu",
    category: "continuation",
    summary: "QUBE does not yet own Grok Build continuation or stop-hook state.",
    nextAction: "Keep continuation state in provider records and .qube artifacts until AIU adds tested Grok Build continuation support.",
  }),
]);

const GROK_BUILD_CAPABILITIES = Object.freeze([
  ...SUPPORTED_CAPABILITIES,
  ...HOST_PROVIDED_CAPABILITIES,
  ...UNSUPPORTED_CAPABILITIES,
]);
const GROK_BUILD_CAPABILITY_MAP = new Map<string, GrokBuildHostCapability>(
  GROK_BUILD_CAPABILITIES.map((capability) => [capability.id, capability]),
);

export function getGrokBuildHostCapability(capability: GrokBuildHostCapabilityId): GrokBuildHostCapability;
export function getGrokBuildHostCapability(capability: string): GrokBuildHostCapability {
  return lookupGrokBuildHostCapability(capability);
}

export function listGrokBuildHostCapabilities(): readonly GrokBuildHostCapability[] {
  return Object.freeze([...GROK_BUILD_CAPABILITIES]);
}

export function assertGrokBuildHostCapabilityAvailable(capability: GrokBuildHostCapabilityId): GrokBuildHostCapability;
export function assertGrokBuildHostCapabilityAvailable(capability: string): GrokBuildHostCapability {
  const resolvedCapability = lookupGrokBuildHostCapability(capability);
  if (resolvedCapability.support === "unsupported") {
    throw new Error(formatGrokBuildUnsupportedCapabilityMessage(resolvedCapability));
  }
  return resolvedCapability;
}

export function formatGrokBuildUnsupportedCapabilityMessage(capability: GrokBuildHostCapability): string {
  return `Unsupported Grok Build capability "${capability.id}": ${capability.summary} Next action: ${capability.nextAction}`;
}

export function inspectGrokBuildWorkspace(cwd = process.cwd()): GrokBuildWorkspaceInspection {
  const root = path.resolve(cwd);
  const instructionPath = path.join(root, GROK_BUILD_INSTRUCTION_PATH);
  return Object.freeze({
    cwd: root,
    instructionTarget: Object.freeze({
      path: instructionPath,
      present: fileExists(instructionPath),
      precedence: "project" as const,
    }),
    capabilities: Object.freeze([...SUPPORTED_CAPABILITIES, ...HOST_PROVIDED_CAPABILITIES]),
    unsupportedCapabilities: Object.freeze([...UNSUPPORTED_CAPABILITIES]),
    commandExamples: Object.freeze([...GROK_BUILD_COMMAND_EXAMPLES]),
  });
}

export function listGrokBuildInstallFiles(): readonly string[] {
  const instruction = getGrokBuildHostCapability("read-instructions");
  return Object.freeze([`${GROK_BUILD_INSTRUCTION_PATH} policy notes: ${instruction.summary}`]);
}

export function listGrokBuildInstallNotes(): readonly string[] {
  const cli = getGrokBuildHostCapability("run-terminal-cli");
  const tui = getGrokBuildHostCapability("use-terminal-tui");
  const headless = getGrokBuildHostCapability("run-headless-prompt");
  const subagents = getGrokBuildHostCapability("use-parallel-subagents");
  const install = getGrokBuildHostCapability("install-cli");
  return Object.freeze([
    "Grok Build host support uses AGENTS.md for durable repository instructions and preserves repository policy precedence.",
    `${cli.summary} ${cli.nextAction}`,
    `${tui.summary} ${tui.nextAction}`,
    `${headless.summary} ${headless.nextAction}`,
    `${subagents.summary} ${subagents.nextAction}`,
    `${install.summary} ${install.nextAction}`,
  ]);
}

function createUnsupportedCapability(capability: string): GrokBuildHostCapability {
  return freezeCapability({
    id: capability,
    support: "unsupported",
    owner: "@tjalve/qube",
    category: "terminal-cli",
    summary: "No QUBE package has registered real Grok Build behavior for this capability.",
    nextAction: "Use a documented QUBE command or add a tested Grok Build host capability before exposing this operation.",
  });
}

function lookupGrokBuildHostCapability(capability: string): GrokBuildHostCapability {
  return GROK_BUILD_CAPABILITY_MAP.get(capability) ?? createUnsupportedCapability(capability);
}

function freezeCapability(capability: GrokBuildHostCapability): GrokBuildHostCapability {
  return Object.freeze({
    ...capability,
    ...(capability.commands ? { commands: Object.freeze([...capability.commands]) } : {}),
  });
}

function fileExists(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}
