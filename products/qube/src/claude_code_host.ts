import { existsSync, statSync } from "node:fs";
import path from "node:path";

export type ClaudeCodeHostCapabilityId =
  | "detect-host"
  | "read-instructions"
  | "use-task-state"
  | "inspect-repository-state"
  | "run-commands"
  | "use-hooks"
  | "use-slash-commands"
  | "use-subagents"
  | "continue-session"
  | "install-slash-command"
  | "request-external-review"
  | "create-git-branch"
  | "open-pull-request";

export type ClaudeCodeHostSupport = "supported" | "host-provided" | "unsupported";

export interface ClaudeCodeHostCapability {
  readonly id: ClaudeCodeHostCapabilityId | string;
  readonly support: ClaudeCodeHostSupport;
  readonly owner: string;
  readonly summary: string;
  readonly nextAction: string;
  readonly paths?: readonly string[];
  readonly tools?: readonly string[];
}

export interface ClaudeCodeWorkspaceTarget {
  readonly path: string;
  readonly present: boolean;
}

export interface ClaudeCodeWorkspaceInspection {
  readonly cwd: string;
  readonly instructionTarget: ClaudeCodeWorkspaceTarget & {
    readonly precedence: "project";
  };
  readonly settingsDirectory: ClaudeCodeWorkspaceTarget;
  readonly projectSettings: ClaudeCodeWorkspaceTarget;
  readonly localSettings: ClaudeCodeWorkspaceTarget;
  readonly commandDirectory: ClaudeCodeWorkspaceTarget;
  readonly skillsDirectory: ClaudeCodeWorkspaceTarget;
  readonly capabilities: readonly ClaudeCodeHostCapability[];
  readonly unsupportedCapabilities: readonly ClaudeCodeHostCapability[];
}

const CLAUDE_CODE_INSTRUCTION_PATH = "CLAUDE.md";
const CLAUDE_CODE_SETTINGS_DIRECTORY = ".claude";
const CLAUDE_CODE_PROJECT_SETTINGS_PATH = ".claude/settings.json";
const CLAUDE_CODE_LOCAL_SETTINGS_PATH = ".claude/settings.local.json";
const CLAUDE_CODE_COMMAND_DIRECTORY = ".claude/commands";
const CLAUDE_CODE_SKILLS_DIRECTORY = ".claude/skills";
const CLAUDE_CODE_TASK_TOOLS = ["TaskCreate", "TaskGet", "TaskUpdate", "TaskList", "TodoWrite"] as const;

const SUPPORTED_CAPABILITIES = Object.freeze([
  freezeCapability({
    id: "detect-host",
    support: "supported",
    owner: "@tjalve/qube",
    summary: "Detect Claude Code-oriented repository instructions from CLAUDE.md and .claude assets without assuming Codex or OpenCode assets.",
    nextAction: "Use inspectClaudeCodeWorkspace(cwd) before reporting Claude Code setup state.",
    paths: [CLAUDE_CODE_INSTRUCTION_PATH, CLAUDE_CODE_SETTINGS_DIRECTORY],
  }),
  freezeCapability({
    id: "read-instructions",
    support: "supported",
    owner: "@tjalve/aib and @tjalve/aie",
    summary: "Claude Code project instructions use CLAUDE.md with repository policy precedence.",
    nextAction: "Use qube aib init . --agent claude-code or qube aie init . --tool claude-code to plan managed CLAUDE.md content.",
    paths: [CLAUDE_CODE_INSTRUCTION_PATH],
  }),
  freezeCapability({
    id: "inspect-repository-state",
    support: "supported",
    owner: "@tjalve/aie",
    summary: "Executor checks branch policy, worktree state, base-branch freshness, and blocking pull requests before issue work.",
    nextAction: "Use qube aie start next --json and qube aie branch check <issue> --json inside Claude Code sessions.",
  }),
]);

const HOST_PROVIDED_CAPABILITIES = Object.freeze([
  freezeCapability({
    id: "use-task-state",
    support: "host-provided",
    owner: "Claude Code host",
    summary: "Claude Code task and todo state is host session state; durable QUBE state stays in GitHub issues, pull requests, and .qube artifacts.",
    nextAction: "Use TaskCreate, TaskUpdate, TaskList, or the current host-exposed task tools from the main Claude Code agent when available.",
    tools: CLAUDE_CODE_TASK_TOOLS,
  }),
  freezeCapability({
    id: "run-commands",
    support: "host-provided",
    owner: "Claude Code host",
    summary: "Claude Code command execution follows the active permission mode, settings, hooks, and repository policy.",
    nextAction: "Run QUBE commands directly and treat tool output as untrusted evidence until verified.",
  }),
  freezeCapability({
    id: "use-hooks",
    support: "host-provided",
    owner: "Claude Code host",
    summary: "Claude Code hooks are configured through host settings and can observe lifecycle events such as tool use and Stop.",
    nextAction: "Review project .claude/settings.json before relying on hook behavior; use qube aiu init --tool claude-code for AIU stop-hook planning.",
    paths: [CLAUDE_CODE_PROJECT_SETTINGS_PATH, CLAUDE_CODE_LOCAL_SETTINGS_PATH],
  }),
  freezeCapability({
    id: "use-slash-commands",
    support: "host-provided",
    owner: "Claude Code host",
    summary: "Claude Code slash commands and skills are host customization assets, separate from Codex AGENTS.md and OpenCode project commands.",
    nextAction: "Use host-native slash commands or skills only when they are already installed and reviewed.",
    paths: [CLAUDE_CODE_COMMAND_DIRECTORY, CLAUDE_CODE_SKILLS_DIRECTORY],
  }),
  freezeCapability({
    id: "use-subagents",
    support: "host-provided",
    owner: "Claude Code host",
    summary: "Claude Code can delegate bounded work to subagents, but protected QUBE issue workflow state stays in the main session.",
    nextAction: "Use subagents for bounded research or review only; keep issue todos, branch checks, and shipping state in the main Claude Code conversation.",
  }),
  freezeCapability({
    id: "continue-session",
    support: "host-provided",
    owner: "Claude Code host",
    summary: "Claude Code can continue or resume host conversations, while QUBE continuation remains anchored in provider and .qube state.",
    nextAction: "Use Claude Code resume only for host context; use qube aie complete, qube aie next, and qube aiu status for workflow state.",
  }),
]);

const UNSUPPORTED_CAPABILITIES = Object.freeze([
  freezeCapability({
    id: "install-slash-command",
    support: "unsupported",
    owner: "@tjalve/qube",
    summary: "QUBE composer install notes do not create Claude Code slash command or skill assets.",
    nextAction: "Use CLAUDE.md plus normal qube commands, or add a tested product command before installing .claude command assets.",
  }),
  freezeCapability({
    id: "request-external-review",
    support: "unsupported",
    owner: "@tjalve/aie",
    summary: "Claude Code host support does not directly invoke configured external PR reviewers.",
    nextAction: "Use qube aie review gate <issue> --prompt and qube aie pr gate <pr> for review workflow.",
  }),
  freezeCapability({
    id: "create-git-branch",
    support: "unsupported",
    owner: "@tjalve/aie repository provider",
    summary: "Claude Code host support does not bypass QUBE branch policy.",
    nextAction: "Use qube aie branch create <issue> or qube aie branch check <issue>.",
  }),
  freezeCapability({
    id: "open-pull-request",
    support: "unsupported",
    owner: "@tjalve/aie GitHub provider",
    summary: "Claude Code host support does not open pull requests without the configured repository workflow.",
    nextAction: "Use qube aie pr body <issue>, create the PR, then run qube aie pr view <pr> --json.",
  }),
]);

const CLAUDE_CODE_CAPABILITIES = Object.freeze([
  ...SUPPORTED_CAPABILITIES,
  ...HOST_PROVIDED_CAPABILITIES,
  ...UNSUPPORTED_CAPABILITIES,
]);
const CLAUDE_CODE_CAPABILITY_MAP = new Map<string, ClaudeCodeHostCapability>(
  CLAUDE_CODE_CAPABILITIES.map((capability) => [capability.id, capability]),
);

export function getClaudeCodeHostCapability(capability: ClaudeCodeHostCapabilityId): ClaudeCodeHostCapability;
export function getClaudeCodeHostCapability(capability: string): ClaudeCodeHostCapability {
  return lookupClaudeCodeHostCapability(capability);
}

export function listClaudeCodeHostCapabilities(): readonly ClaudeCodeHostCapability[] {
  return Object.freeze([...CLAUDE_CODE_CAPABILITIES]);
}

export function assertClaudeCodeHostCapabilityAvailable(capability: ClaudeCodeHostCapabilityId): ClaudeCodeHostCapability;
export function assertClaudeCodeHostCapabilityAvailable(capability: string): ClaudeCodeHostCapability {
  const resolvedCapability = lookupClaudeCodeHostCapability(capability);
  if (resolvedCapability.support === "unsupported") {
    throw new Error(formatClaudeCodeUnsupportedCapabilityMessage(resolvedCapability));
  }
  return resolvedCapability;
}

export function formatClaudeCodeUnsupportedCapabilityMessage(capability: ClaudeCodeHostCapability): string {
  return `Unsupported Claude Code capability "${capability.id}": ${capability.summary} Next action: ${capability.nextAction}`;
}

export function inspectClaudeCodeWorkspace(cwd = process.cwd()): ClaudeCodeWorkspaceInspection {
  const root = path.resolve(cwd);
  return Object.freeze({
    cwd: root,
    instructionTarget: Object.freeze({
      path: path.join(root, CLAUDE_CODE_INSTRUCTION_PATH),
      present: fileExists(path.join(root, CLAUDE_CODE_INSTRUCTION_PATH)),
      precedence: "project" as const,
    }),
    settingsDirectory: inspectDirectory(root, CLAUDE_CODE_SETTINGS_DIRECTORY),
    projectSettings: inspectFile(root, CLAUDE_CODE_PROJECT_SETTINGS_PATH),
    localSettings: inspectFile(root, CLAUDE_CODE_LOCAL_SETTINGS_PATH),
    commandDirectory: inspectDirectory(root, CLAUDE_CODE_COMMAND_DIRECTORY),
    skillsDirectory: inspectDirectory(root, CLAUDE_CODE_SKILLS_DIRECTORY),
    capabilities: Object.freeze([...SUPPORTED_CAPABILITIES, ...HOST_PROVIDED_CAPABILITIES]),
    unsupportedCapabilities: Object.freeze([...UNSUPPORTED_CAPABILITIES]),
  });
}

export function listClaudeCodeInstallFiles(): readonly string[] {
  const instruction = getClaudeCodeHostCapability("read-instructions");
  const hooks = getClaudeCodeHostCapability("use-hooks");
  return Object.freeze([
    `${CLAUDE_CODE_INSTRUCTION_PATH} policy notes: ${instruction.summary}`,
    `${CLAUDE_CODE_PROJECT_SETTINGS_PATH} hook notes: ${hooks.summary}`,
  ]);
}

export function listClaudeCodeInstallNotes(): readonly string[] {
  const tasks = getClaudeCodeHostCapability("use-task-state");
  const hooks = getClaudeCodeHostCapability("use-hooks");
  const slashCommands = getClaudeCodeHostCapability("use-slash-commands");
  const unsupportedSlashCommand = getClaudeCodeHostCapability("install-slash-command");
  return Object.freeze([
    "Claude Code host support uses CLAUDE.md for durable repository instructions and preserves repository policy precedence.",
    `${tasks.summary} ${tasks.nextAction}`,
    `${hooks.summary} ${hooks.nextAction}`,
    `${slashCommands.summary} ${slashCommands.nextAction}`,
    `${unsupportedSlashCommand.summary} ${unsupportedSlashCommand.nextAction}`,
  ]);
}

function unsupportedCapability(capability: string): ClaudeCodeHostCapability {
  return freezeCapability({
    id: capability,
    support: "unsupported",
    owner: "@tjalve/qube",
    summary: "No QUBE package has registered real Claude Code behavior for this capability.",
    nextAction: "Use a documented QUBE command or add a tested Claude Code host capability before exposing this operation.",
  });
}

function lookupClaudeCodeHostCapability(capability: string): ClaudeCodeHostCapability {
  return CLAUDE_CODE_CAPABILITY_MAP.get(capability) ?? unsupportedCapability(capability);
}

function freezeCapability(capability: ClaudeCodeHostCapability): ClaudeCodeHostCapability {
  return Object.freeze({
    ...capability,
    ...(capability.paths ? { paths: Object.freeze([...capability.paths]) } : {}),
    ...(capability.tools ? { tools: Object.freeze([...capability.tools]) } : {}),
  });
}

function inspectFile(root: string, relativePath: string): ClaudeCodeWorkspaceTarget {
  const filePath = path.join(root, relativePath);
  return Object.freeze({
    path: filePath,
    present: fileExists(filePath),
  });
}

function inspectDirectory(root: string, relativePath: string): ClaudeCodeWorkspaceTarget {
  const directoryPath = path.join(root, relativePath);
  return Object.freeze({
    path: directoryPath,
    present: directoryExists(directoryPath),
  });
}

function fileExists(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function directoryExists(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}
