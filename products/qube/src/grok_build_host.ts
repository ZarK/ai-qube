import { createRequire } from "node:module";

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

export interface GrokBuildHostFile {
  readonly id: string;
  readonly kind: "instruction" | "command" | "skill" | "subagent" | "hook";
  readonly source: "aie" | "aiu";
  readonly description: string;
  readonly path: string;
  readonly required: boolean;
}

interface GrokBuildAdapterModule {
  assertGrokBuildHostCapabilityAvailable(id: string): GrokBuildHostCapability;
  formatGrokBuildUnsupportedCapabilityMessage(capability: GrokBuildHostCapability): string;
  getGrokBuildHostCapability(id: string): GrokBuildHostCapability;
  inspectGrokBuildWorkspace(cwd?: string): GrokBuildWorkspaceInspection;
  listGrokBuildInstallFiles(): readonly string[];
  listGrokBuildInstallNotes(): readonly string[];
  listGrokBuildHostCapabilities(): readonly GrokBuildHostCapability[];
  grokBuildHostFiles: readonly GrokBuildHostFile[];
}

const requireAdapter = createRequire(import.meta.url);

function loadGrokBuildAdapter(): GrokBuildAdapterModule | null {
  try {
    return requireAdapter("@tjalve/qube-adapter-grok-build") as GrokBuildAdapterModule;
  } catch (error) {
    if (isModuleMissing(error, "@tjalve/qube-adapter-grok-build")) return null;
    throw error;
  }
}

function isModuleMissing(error: unknown, packageName: string): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String((error as { code?: unknown }).code) : "";
  const message = error.message.replace(/\\/g, "/");
  const needle = packageName.replace(/\\/g, "/");
  if (!message.includes(needle)) return false;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND" || /cannot find package|cannot find module/i.test(message);
}

function missingGrokBuildAdapter(): Error {
  return new Error([
    "Grok Build host support requires optional adapter @tjalve/qube-adapter-grok-build.",
    "Run qube install --host grok-build --yes --dry-run to review the adapter-backed install plan.",
  ].join(" "));
}

export function assertGrokBuildHostCapabilityAvailable(id: string): GrokBuildHostCapability {
  const adapter = loadGrokBuildAdapter();
  if (!adapter) throw missingGrokBuildAdapter();
  return adapter.assertGrokBuildHostCapabilityAvailable(id);
}

export function formatGrokBuildUnsupportedCapabilityMessage(capability: GrokBuildHostCapability): string {
  const adapter = loadGrokBuildAdapter();
  if (!adapter) return missingGrokBuildAdapter().message;
  return adapter.formatGrokBuildUnsupportedCapabilityMessage(capability);
}

export function getGrokBuildHostCapability(id: string): GrokBuildHostCapability {
  const adapter = loadGrokBuildAdapter();
  if (!adapter) throw missingGrokBuildAdapter();
  return adapter.getGrokBuildHostCapability(id);
}

export function inspectGrokBuildWorkspace(cwd?: string): GrokBuildWorkspaceInspection {
  const adapter = loadGrokBuildAdapter();
  if (!adapter) throw missingGrokBuildAdapter();
  return adapter.inspectGrokBuildWorkspace(cwd);
}

export function listGrokBuildInstallFiles(): readonly string[] {
  const adapter = loadGrokBuildAdapter();
  if (!adapter) {
    return Object.freeze([
      "AGENTS.md policy notes: Install @tjalve/qube-adapter-grok-build with qube install --host grok-build.",
    ]);
  }
  return adapter.listGrokBuildInstallFiles();
}

export function listGrokBuildInstallNotes(): readonly string[] {
  const adapter = loadGrokBuildAdapter();
  if (!adapter) {
    return Object.freeze([
      "Grok Build host support requires @tjalve/qube-adapter-grok-build.",
      "Run qube install --host grok-build --yes --dry-run to review the adapter-backed install plan.",
    ]);
  }
  return adapter.listGrokBuildInstallNotes();
}

export function listGrokBuildHostCapabilities(): readonly GrokBuildHostCapability[] {
  const adapter = loadGrokBuildAdapter();
  if (!adapter) return Object.freeze([]);
  return adapter.listGrokBuildHostCapabilities();
}

export function listGrokBuildHostFiles(): readonly GrokBuildHostFile[] {
  const adapter = loadGrokBuildAdapter();
  if (!adapter) return Object.freeze([]);
  return adapter.grokBuildHostFiles;
}
