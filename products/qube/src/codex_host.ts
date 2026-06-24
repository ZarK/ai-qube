import { existsSync, statSync } from "node:fs";
import path from "node:path";

export type CodexHostCapabilityId =
  | "detect-host"
  | "read-instructions"
  | "use-local-todos"
  | "inspect-repository-state"
  | "run-commands"
  | "audit-ui-with-browser"
  | "spawn-fresh-reviewer"
  | "handoff-worktree"
  | "install-project-command"
  | "request-external-review"
  | "create-git-branch"
  | "open-pull-request";

export type CodexHostSupport = "supported" | "host-provided" | "unsupported";

export interface CodexHostCapability {
  readonly id: CodexHostCapabilityId | string;
  readonly support: CodexHostSupport;
  readonly owner: string;
  readonly summary: string;
  readonly nextAction: string;
}

export interface CodexWorkspaceInspection {
  readonly cwd: string;
  readonly instructionTarget: {
    readonly path: string;
    readonly present: boolean;
    readonly precedence: "project";
  };
  readonly capabilities: readonly CodexHostCapability[];
  readonly unsupportedCapabilities: readonly CodexHostCapability[];
}

const CODEX_INSTRUCTION_PATH = "AGENTS.md";

const SUPPORTED_CAPABILITIES = Object.freeze([
  freezeCapability({
    id: "detect-host",
    support: "supported",
    owner: "@tjalve/qube",
    summary: "Detect Codex-oriented repository instructions from AGENTS.md without assuming OpenCode or Claude Code assets.",
    nextAction: "Use inspectCodexWorkspace(cwd) before reporting Codex setup state.",
  }),
  freezeCapability({
    id: "read-instructions",
    support: "supported",
    owner: "@tjalve/aib and @tjalve/aie",
    summary: "Codex project instructions use AGENTS.md with repository policy precedence.",
    nextAction: "Use qube aib init . --agent codex or qube aie init . --tool codex to plan managed AGENTS.md content.",
  }),
  freezeCapability({
    id: "use-local-todos",
    support: "host-provided",
    owner: "Codex host",
    summary: "Codex local todos are host session state; durable QUBE state stays in GitHub issues, PRs, and .qube artifacts.",
    nextAction: "Use the host plan/todo surface when available and keep durable issue state in the configured provider.",
  }),
  freezeCapability({
    id: "inspect-repository-state",
    support: "supported",
    owner: "@tjalve/aie",
    summary: "Executor checks branch policy, worktree state, base-branch freshness, and blocking pull requests before issue work.",
    nextAction: "Use qube aie start next --json and qube aie branch check <issue> --json inside Codex sessions.",
  }),
  freezeCapability({
    id: "run-commands",
    support: "host-provided",
    owner: "Codex host",
    summary: "Codex command execution follows the active session permissions, sandbox, approval, and repository policy.",
    nextAction: "Run QUBE commands directly and treat tool output as untrusted evidence until verified.",
  }),
  freezeCapability({
    id: "audit-ui-with-browser",
    support: "host-provided",
    owner: "Codex Browser",
    summary: "Codex can audit unauthenticated local routes through the in-app browser when Browser use is available.",
    nextAction: "Use qube aie audit ui <issue> for evidence guidance, start the app, then inspect the real page with the Codex browser.",
  }),
  freezeCapability({
    id: "handoff-worktree",
    support: "host-provided",
    owner: "Codex app",
    summary: "Codex app worktrees and handoff are host-managed; QUBE still enforces repository branch policy before issue work.",
    nextAction: "Use the primary checkout when repository policy disallows linked worktree execution.",
  }),
]);

const UNSUPPORTED_CAPABILITIES = Object.freeze([
  freezeCapability({
    id: "install-project-command",
    support: "unsupported",
    owner: "@tjalve/qube",
    summary: "Codex does not use OpenCode-style project command files for QUBE workflows.",
    nextAction: "Use AGENTS.md plus normal qube commands instead of installing .opencode command assets.",
  }),
  freezeCapability({
    id: "request-external-review",
    support: "unsupported",
    owner: "@tjalve/aie",
    summary: "Codex host support does not directly invoke configured external PR reviewers.",
    nextAction: "Use qube aie review gate <issue> --prompt and qube aie pr gate <pr> for review workflow.",
  }),
  freezeCapability({
    id: "spawn-fresh-reviewer",
    support: "unsupported",
    owner: "@tjalve/qube CLI",
    summary: "The standalone QUBE CLI cannot itself spawn a fresh Codex reviewer context; it can only render explicit prompt bundles for the active Codex host to execute.",
    nextAction: "Use qube aie pr gate <pr> --dry-run --json --local-review-prompts, then have the active Codex host spawn subagents and record local-host evidence with task/session/thread provenance.",
  }),
  freezeCapability({
    id: "create-git-branch",
    support: "unsupported",
    owner: "@tjalve/aie repository provider",
    summary: "Codex host support does not bypass QUBE branch policy.",
    nextAction: "Use qube aie branch create <issue> or qube aie branch check <issue>.",
  }),
  freezeCapability({
    id: "open-pull-request",
    support: "unsupported",
    owner: "@tjalve/aie GitHub provider",
    summary: "Codex host support does not open pull requests without the configured repository workflow.",
    nextAction: "Use qube aie pr body <issue>, create the PR, then run qube aie pr view <pr> --json.",
  }),
]);

const CODEX_CAPABILITIES = Object.freeze([...SUPPORTED_CAPABILITIES, ...UNSUPPORTED_CAPABILITIES]);
const CODEX_CAPABILITY_MAP = new Map<string, CodexHostCapability>(
  CODEX_CAPABILITIES.map((capability) => [capability.id, capability]),
);

export function getCodexHostCapability(capability: CodexHostCapabilityId): CodexHostCapability;
export function getCodexHostCapability(capability: string): CodexHostCapability {
  return lookupCodexHostCapability(capability);
}

export function listCodexHostCapabilities(): readonly CodexHostCapability[] {
  return Object.freeze([...CODEX_CAPABILITIES]);
}

export function assertCodexHostCapabilityAvailable(capability: CodexHostCapabilityId): CodexHostCapability;
export function assertCodexHostCapabilityAvailable(capability: string): CodexHostCapability {
  const resolvedCapability = lookupCodexHostCapability(capability);
  if (resolvedCapability.support === "unsupported") {
    throw new Error(formatCodexUnsupportedCapabilityMessage(resolvedCapability));
  }
  return resolvedCapability;
}

export function formatCodexUnsupportedCapabilityMessage(capability: CodexHostCapability): string {
  return `Unsupported Codex capability "${capability.id}": ${capability.summary} Next action: ${capability.nextAction}`;
}

export function inspectCodexWorkspace(cwd = process.cwd()): CodexWorkspaceInspection {
  const root = path.resolve(cwd);
  const instructionPath = path.join(root, CODEX_INSTRUCTION_PATH);
  return Object.freeze({
    cwd: root,
    instructionTarget: Object.freeze({
      path: instructionPath,
      present: fileExists(instructionPath),
      precedence: "project" as const,
    }),
    capabilities: Object.freeze([...SUPPORTED_CAPABILITIES]),
    unsupportedCapabilities: Object.freeze([...UNSUPPORTED_CAPABILITIES]),
  });
}

export function listCodexInstallFiles(): readonly string[] {
  const instruction = getCodexHostCapability("read-instructions");
  return Object.freeze([`${CODEX_INSTRUCTION_PATH} policy notes: ${instruction.summary}`]);
}

export function listCodexInstallNotes(): readonly string[] {
  const todos = getCodexHostCapability("use-local-todos");
  const browser = getCodexHostCapability("audit-ui-with-browser");
  const unsupportedCommand = getCodexHostCapability("install-project-command");
  return Object.freeze([
    "Codex host support uses AGENTS.md for durable repository instructions and preserves repository policy precedence.",
    `${todos.summary} ${todos.nextAction}`,
    `${browser.summary} ${browser.nextAction}`,
    `${unsupportedCommand.summary} ${unsupportedCommand.nextAction}`,
  ]);
}

function unsupportedCapability(capability: string): CodexHostCapability {
  return freezeCapability({
    id: capability,
    support: "unsupported",
    owner: "@tjalve/qube",
    summary: "No QUBE package has registered real Codex behavior for this capability.",
    nextAction: "Use a documented QUBE command or add a tested Codex host capability before exposing this operation.",
  });
}

function lookupCodexHostCapability(capability: string): CodexHostCapability {
  return CODEX_CAPABILITY_MAP.get(capability) ?? unsupportedCapability(capability);
}

function freezeCapability(capability: CodexHostCapability): CodexHostCapability {
  return Object.freeze({ ...capability });
}

function fileExists(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}
