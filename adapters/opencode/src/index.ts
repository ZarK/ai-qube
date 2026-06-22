import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { defineQubeAdapter, type QubeAdapterCapability, type QubeAdapterContract } from "@tjalve/qube-core";

export type OpenCodeOperation =
  | "detect-host"
  | "read-instructions"
  | "install-project-command"
  | "use-todos"
  | "deliver-session-prompt"
  | "handle-stop-hook"
  | "run-aiq-plugin"
  | "request-external-review"
  | "create-git-branch"
  | "open-pull-request";

export type OpenCodeSupport = "supported" | "standalone" | "unsupported";

export interface OpenCodeOperationSupport {
  readonly id: OpenCodeOperation | string;
  readonly support: OpenCodeSupport;
  readonly owner: string;
  readonly summary: string;
  readonly nextAction: string;
  readonly paths?: readonly string[];
  readonly tools?: readonly string[];
}

export interface OpenCodeCommandInspection {
  readonly name: string;
  readonly path: string;
  readonly known: boolean;
  readonly description: string;
}

export interface OpenCodeWorkspaceInspection {
  readonly cwd: string;
  readonly instructionTarget: {
    readonly path: string;
    readonly present: boolean;
  };
  readonly commandDirectory: {
    readonly path: string;
    readonly present: boolean;
  };
  readonly commands: readonly OpenCodeCommandInspection[];
  readonly capabilities: readonly OpenCodeOperationSupport[];
}

const OPENCODE_COMMAND_DIRECTORY = ".opencode/commands";
const OPENCODE_INSTRUCTION_PATH = "AGENTS.md";
const OPENCODE_TODO_TOOLS = ["todowrite", "todoread"] as const;

const KNOWN_COMMANDS: Readonly<Record<string, string>> = Object.freeze({
  "aib-bootstrap.md": "AIB bootstrap planning command.",
  "make-it-so.md": "AIE autonomous issue workflow command.",
  "makeitso.md": "Optional AIE make-it-so alias.",
});

const SUPPORTED_OPERATIONS = [
  {
    id: "detect-host",
    support: "supported",
    owner: "@tjalve/qube-adapter-opencode",
    summary: "Detect OpenCode repository affordances from AGENTS.md and .opencode/commands.",
    nextAction: "Use inspectOpenCodeWorkspace(cwd) before claiming installed OpenCode command support.",
    paths: [OPENCODE_INSTRUCTION_PATH, OPENCODE_COMMAND_DIRECTORY],
  },
  {
    id: "read-instructions",
    support: "supported",
    owner: "@tjalve/aib and @tjalve/aie",
    summary: "OpenCode reads AGENTS.md as the repository instruction target for QUBE workflows.",
    nextAction: "Install or update AGENTS.md through the owning package init command.",
    paths: [OPENCODE_INSTRUCTION_PATH],
  },
  {
    id: "install-project-command",
    support: "supported",
    owner: "@tjalve/aib and @tjalve/aie",
    summary: "AIB and AIE install concrete OpenCode project commands under .opencode/commands.",
    nextAction: "Use qube aib init --agent opencode or qube aie init . --tool opencode for managed files; standalone aib remains valid for single-package installs.",
    paths: [OPENCODE_COMMAND_DIRECTORY],
  },
  {
    id: "use-todos",
    support: "supported",
    owner: "OpenCode host",
    summary: "OpenCode todo state is available through host todo tools, not through a hidden adapter store.",
    nextAction: "Use todowrite and todoread from the main OpenCode session when available.",
    tools: OPENCODE_TODO_TOOLS,
  },
  {
    id: "deliver-session-prompt",
    support: "supported",
    owner: "@tjalve/aiu",
    summary: "AIU can route continuation prompts from trusted state through an explicit OpenCode prompt deliverer.",
    nextAction: "Use createAiuOpenCodePlugin with a host deliverPrompt implementation.",
  },
  {
    id: "handle-stop-hook",
    support: "supported",
    owner: "@tjalve/aiu",
    summary: "AIU owns OpenCode stop-hook and idle-session continuation decisions.",
    nextAction: "Use AIU OpenCode plugin or hook-stop surfaces for continuation policy.",
  },
  {
    id: "run-aiq-plugin",
    support: "standalone",
    owner: "@tjalve/aiq OpenCode plugin package",
    summary: "AIQ exposes OpenCode quality tools as a standalone adapter package, not as a QUBE-facing host command.",
    nextAction: "Use the AIQ OpenCode plugin package for aiq_check_files, aiq_plan_files, aiq_status, and aiq_doctor.",
  },
] as const satisfies readonly OpenCodeOperationSupport[];

const UNSUPPORTED_OPERATIONS = [
  {
    id: "request-external-review",
    support: "unsupported",
    owner: "OpenCode host",
    summary: "OpenCode does not provide a QUBE API for requesting external reviewers.",
    nextAction: "Render the review prompt with qube aie review gate <issue> --prompt and send it to @oracle manually when that reviewer is available.",
  },
  {
    id: "create-git-branch",
    support: "unsupported",
    owner: "@tjalve/aie",
    summary: "OpenCode host support does not create repository branches.",
    nextAction: "Use qube aie branch create <issue> or the configured repository provider workflow.",
  },
  {
    id: "open-pull-request",
    support: "unsupported",
    owner: "@tjalve/aie GitHub provider",
    summary: "OpenCode host support does not open or approve pull requests.",
    nextAction: "Use qube aie pr body <issue>, repository PR tooling, and qube aie pr gate <pr>.",
  },
] as const satisfies readonly OpenCodeOperationSupport[];

const OPENCODE_OPERATIONS = Object.freeze([...SUPPORTED_OPERATIONS, ...UNSUPPORTED_OPERATIONS]);
const OPENCODE_OPERATION_MAP = new Map<string, OpenCodeOperationSupport>(
  OPENCODE_OPERATIONS.map((operation) => [operation.id, operation]),
);

export const opencodeAdapter = defineQubeAdapter({
  id: "opencode",
  packageName: "@tjalve/qube-adapter-opencode",
  surface: "opencode",
  owns: ["host-detection", "instruction-targets", "project-commands", "todo-tools", "session-prompts", "stop-hooks", "unsupported-capability-reporting"],
  boundary: "OpenCode host behavior stays at the adapter edge; product packages consume explicit capability records and own product-specific side effects.",
  capabilities: OPENCODE_OPERATIONS.map(toQubeCapability),
  contractOnly: false,
} satisfies QubeAdapterContract);

export function getOpenCodeOperationSupport(operation: OpenCodeOperation | string): OpenCodeOperationSupport {
  return OPENCODE_OPERATION_MAP.get(operation) ?? unsupportedOperation(operation);
}

export function listOpenCodeOperationSupport(): readonly OpenCodeOperationSupport[] {
  return OPENCODE_OPERATIONS;
}

export function assertOpenCodeOperationSupported(operation: OpenCodeOperation | string): OpenCodeOperationSupport {
  const support = getOpenCodeOperationSupport(operation);
  if (support.support === "unsupported") {
    throw new Error(openCodeUnsupportedCapabilityMessage(support));
  }
  return support;
}

export function openCodeUnsupportedCapabilityMessage(support: OpenCodeOperationSupport): string {
  return `Unsupported OpenCode capability "${support.id}": ${support.summary} Next action: ${support.nextAction}`;
}

export function inspectOpenCodeWorkspace(cwd = process.cwd()): OpenCodeWorkspaceInspection {
  const root = path.resolve(cwd);
  const instructionPath = path.join(root, OPENCODE_INSTRUCTION_PATH);
  const commandDirectoryPath = path.join(root, OPENCODE_COMMAND_DIRECTORY);
  const commandDirectoryPresent = directoryExists(commandDirectoryPath);

  return Object.freeze({
    cwd: root,
    instructionTarget: Object.freeze({
      path: instructionPath,
      present: fileExists(instructionPath),
    }),
    commandDirectory: Object.freeze({
      path: commandDirectoryPath,
      present: commandDirectoryPresent,
    }),
    commands: Object.freeze(commandDirectoryPresent ? readOpenCodeCommands(commandDirectoryPath) : []),
    capabilities: SUPPORTED_OPERATIONS,
  });
}

export function opencodeSessionTarget(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (trimmed.length === 0 || trimmed !== sessionId) {
    throw new Error("OpenCode session ids must be non-empty and already normalized.");
  }
  return `opencode:${sessionId}`;
}

function readOpenCodeCommands(commandDirectoryPath: string): OpenCodeCommandInspection[] {
  return readdirSync(commandDirectoryPath)
    .filter((name) => name.endsWith(".md") && fileExists(path.join(commandDirectoryPath, name)))
    .sort()
    .map((name) => {
      const description = KNOWN_COMMANDS[name] ?? "OpenCode project command.";
      return Object.freeze({
        name,
        path: path.join(commandDirectoryPath, name),
        known: name in KNOWN_COMMANDS,
        description,
      });
    });
}

function unsupportedOperation(operation: string): OpenCodeOperationSupport {
  return Object.freeze({
    id: operation,
    support: "unsupported",
    owner: "@tjalve/qube-adapter-opencode",
    summary: "No product package has registered real OpenCode behavior for this capability.",
    nextAction: "Use a documented QUBE package command or add a tested adapter capability before exposing this operation.",
  });
}

function toQubeCapability(operation: OpenCodeOperationSupport): QubeAdapterCapability {
  return {
    id: operation.id,
    support: operation.support,
    owner: operation.owner,
    summary: operation.summary,
  };
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
