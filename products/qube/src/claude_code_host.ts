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

type ClaudeCodeAdapter = typeof import("@tjalve/qube-adapter-claude-code");

const claudeCodeAdapter: ClaudeCodeAdapter | null = await import("@tjalve/qube-adapter-claude-code").catch((error: unknown) => {
  if (isModuleMissing(error, "@tjalve/qube-adapter-claude-code")) return null;
  throw error;
});

function loadClaudeCodeAdapter(): ClaudeCodeAdapter | null {
  return claudeCodeAdapter;
}

function isModuleMissing(error: unknown, packageName: string): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String((error as { code?: unknown }).code) : "";
  return (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") && error.message.includes(packageName);
}

function missingClaudeCodeAdapter(): Error {
  return new Error([
    "Claude Code host support requires optional adapter @tjalve/qube-adapter-claude-code.",
    "Run qube install --host claude-code --yes --dry-run to review the adapter-backed install plan.",
  ].join(" "));
}

export function assertClaudeCodeHostCapabilityAvailable(id: string): ReturnType<ClaudeCodeAdapter["assertClaudeCodeOperationAvailable"]> {
  const adapter = loadClaudeCodeAdapter();
  if (!adapter) throw missingClaudeCodeAdapter();
  return adapter.assertClaudeCodeOperationAvailable(id);
}

export function formatClaudeCodeUnsupportedCapabilityMessage(capability: Parameters<ClaudeCodeAdapter["formatClaudeCodeUnsupportedOperationMessage"]>[0]): string {
  const adapter = loadClaudeCodeAdapter();
  if (!adapter) return missingClaudeCodeAdapter().message;
  return adapter.formatClaudeCodeUnsupportedOperationMessage(capability);
}

export function getClaudeCodeHostCapability(id: string): ReturnType<ClaudeCodeAdapter["getClaudeCodeOperationSupport"]> {
  const adapter = loadClaudeCodeAdapter();
  if (!adapter) throw missingClaudeCodeAdapter();
  return adapter.getClaudeCodeOperationSupport(id);
}

export function inspectClaudeCodeWorkspace(cwd: string): ReturnType<ClaudeCodeAdapter["inspectClaudeCodeWorkspace"]> {
  const adapter = loadClaudeCodeAdapter();
  if (!adapter) throw missingClaudeCodeAdapter();
  return adapter.inspectClaudeCodeWorkspace(cwd);
}

export function listClaudeCodeInstallFiles(): ReturnType<ClaudeCodeAdapter["listClaudeCodeInstallFiles"]> {
  const adapter = loadClaudeCodeAdapter();
  if (!adapter) {
    return Object.freeze([
      "CLAUDE.md policy notes: Install @tjalve/qube-adapter-claude-code with qube install --host claude-code.",
    ]);
  }
  return adapter.listClaudeCodeInstallFiles();
}

export function listClaudeCodeInstallNotes(): ReturnType<ClaudeCodeAdapter["listClaudeCodeInstallNotes"]> {
  const adapter = loadClaudeCodeAdapter();
  if (!adapter) {
    return Object.freeze([
      "Claude Code host support requires @tjalve/qube-adapter-claude-code.",
      "Run qube install --host claude-code --yes --dry-run to review the adapter-backed install plan.",
    ]);
  }
  return adapter.listClaudeCodeInstallNotes();
}

export function listClaudeCodeHostCapabilities(): ReturnType<ClaudeCodeAdapter["listClaudeCodeOperationSupport"]> {
  const adapter = loadClaudeCodeAdapter();
  if (!adapter) return Object.freeze([]);
  return adapter.listClaudeCodeOperationSupport();
}
