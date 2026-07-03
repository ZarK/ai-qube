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

export {
  assertClaudeCodeOperationAvailable as assertClaudeCodeHostCapabilityAvailable,
  formatClaudeCodeUnsupportedOperationMessage as formatClaudeCodeUnsupportedCapabilityMessage,
  getClaudeCodeOperationSupport as getClaudeCodeHostCapability,
  inspectClaudeCodeWorkspace,
  listClaudeCodeInstallFiles,
  listClaudeCodeInstallNotes,
  listClaudeCodeOperationSupport as listClaudeCodeHostCapabilities,
} from "@tjalve/qube-adapter-claude-code";
