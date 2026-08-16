import { homedir } from "node:os";
import { join, posix as pathPosix } from "node:path";

import type {
  IsolatedReviewHostAdapter,
  IsolatedReviewHostBuiltInvocation,
  IsolatedReviewHostInvocationContext,
  IsolatedReviewHostParsedEnvelope,
  IsolatedReviewHostProbeContext,
  IsolatedReviewHostProbeResult,
} from "@tjalve/qube-core";

const GROK_BUILD_EXECUTABLE_NAMES = ["grok"] as const;
const GROK_BUILD_WINDOWS_EXECUTABLE_NAMES = ["grok.exe"] as const;

export const GROK_BUILD_HOST_ID = "grok-build" as const;

export interface InstructionTarget {
  readonly id: string;
  readonly path: string;
  readonly description: string;
}

export type CommandRenderer =
  | "make-it-so"
  | "grok-review-focus-agent"
  | "grok-review-explorer-agent"
  | "grok-review-digest-agent"
  | "grok-review-librarian-agent";

export interface CommandTarget {
  readonly id: string;
  readonly path: string;
  readonly description: string;
  readonly optional: boolean;
  readonly enabledBy: "always" | "opencodeCommandAlias" | "hostLocalReview";
  readonly renderer: CommandRenderer;
}

export interface AgentHostProfile {
  readonly id: "grok-build";
  readonly displayName: string;
  readonly instructionTargets: readonly InstructionTarget[];
  readonly commandTargets: readonly CommandTarget[];
  readonly todo: { readonly tools: readonly string[]; readonly fallback: string; readonly instruction: string };
  readonly dialogue: { readonly expectation: string };
  readonly subagents: { readonly supported: boolean; readonly instruction: string };
  readonly hooks: { readonly supported: boolean; readonly description: string };
  readonly supportsProjectCommands: boolean;
}

const AGENTS_INSTRUCTIONS: InstructionTarget = Object.freeze({
  id: "agents-instructions",
  path: "AGENTS.md",
  description: "Always-loaded Executor instructions for AGENTS.md hosts.",
});

export const grokBuildHostProfile: AgentHostProfile = Object.freeze({
  id: "grok-build",
  displayName: "Grok Build",
  instructionTargets: Object.freeze([AGENTS_INSTRUCTIONS]),
  commandTargets: Object.freeze([
    Object.freeze({
      id: "grok-make-it-so",
      path: pathPosix.join(".grok", "commands", "make-it-so.md"),
      description: "Grok Build project command that starts or resumes the autonomous Executor workflow.",
      optional: false,
      enabledBy: "always",
      renderer: "make-it-so",
    }),
    Object.freeze({
      id: "grok-make-it-so-skill",
      path: pathPosix.join(".grok", "skills", "make-it-so", "SKILL.md"),
      description: "Grok Build skill that starts or resumes the autonomous Executor workflow.",
      optional: false,
      enabledBy: "always",
      renderer: "make-it-so",
    }),
    Object.freeze({
      id: "grok-review-focus-agent",
      path: pathPosix.join(".grok", "agents", "qube-review-focus.md"),
      description: "Grok Build read-only subagent for one focused local PR review lane.",
      optional: false,
      enabledBy: "hostLocalReview",
      renderer: "grok-review-focus-agent",
    }),
    Object.freeze({
      id: "grok-review-explorer-agent",
      path: pathPosix.join(".grok", "agents", "qube-review-explorer.md"),
      description: "Grok Build read-only economy subagent that reads and summarizes large texts for a review lane.",
      optional: false,
      enabledBy: "hostLocalReview",
      renderer: "grok-review-explorer-agent",
    }),
    Object.freeze({
      id: "grok-review-digest-agent",
      path: pathPosix.join(".grok", "agents", "qube-review-digest.md"),
      description: "Grok Build read-only economy subagent that condenses diffs and test output for a review lane.",
      optional: false,
      enabledBy: "hostLocalReview",
      renderer: "grok-review-digest-agent",
    }),
    Object.freeze({
      id: "grok-review-librarian-agent",
      path: pathPosix.join(".grok", "agents", "qube-review-librarian.md"),
      description: "Grok Build read-only economy subagent that locates files, symbols, and prior review evidence for a review lane.",
      optional: false,
      enabledBy: "hostLocalReview",
      renderer: "grok-review-librarian-agent",
    }),
  ]),
  todo: Object.freeze({
    tools: Object.freeze([] as string[]),
    fallback: "Keep durable todos in the visible checklist plus GitHub issue checkboxes and comments.",
    instruction: "For Grok Build, keep durable todos in the visible checklist plus provider records. Do not invent a Grok todo tool.",
  }),
  dialogue: Object.freeze({
    expectation: "Operate autonomously in the main Grok Build session. Provider-visible PR reviews and GitHub issue comments remain the durable communication channel for review results.",
  }),
  subagents: Object.freeze({
    supported: true,
    instruction: "Grok Build subagents may be used for bounded support work. Routed review already has a Grok host adapter. Local review-agent files are installed when local review includes this host.",
  }),
  hooks: Object.freeze({
    supported: true,
    description: "Grok Build Stop hooks are host-provided. Executor init writes Grok command, skill, and review-agent files, not hook files.",
  }),
  supportsProjectCommands: true,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sanitizeProbeText(value: string): string {
  return value.replace(/\u001b\[[0-9;]*[A-Za-z]/g, " ").replace(/[^ -~]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

export function parseGrokModelCatalog(output: string): string[] | null {
  const lines = output.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => /available models\s*:/i.test(line));
  if (headerIndex === -1) return null;
  const models: string[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const match = /^\s*[-*]?\s*([A-Za-z0-9][\w.-]*)/.exec(line);
    if (!match) {
      if (line.trim() === "") continue;
      break;
    }
    models.push(match[1]);
  }
  return models.length > 0 ? models : null;
}

function jsonObjectSequence(text: string): string[] | null {
  let index = 0;
  const objects: string[] = [];
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index])) index += 1;
    if (index >= text.length) break;
    if (text[index] !== "{") return null;
    const start = index;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === "\"") inString = false;
        continue;
      }
      if (character === "\"") inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          index += 1;
          break;
        }
      }
    }
    if (depth !== 0 || inString) return null;
    const candidate = text.slice(start, index);
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (!isRecord(parsed)) return null;
    } catch {
      return null;
    }
    objects.push(candidate);
  }
  return objects.length > 0 ? objects : null;
}

function parseGrokEnvelopeRecord(stdout: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(stdout);
    if (isRecord(value)) return value;
  } catch {
    // Grok may emit JSONL.
  }
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value: unknown = JSON.parse(lines[index]);
      if (isRecord(value)) return value;
    } catch {
      // Keep scanning toward the final event.
    }
  }
  return null;
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readGrokUsage(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const usage: Record<string, unknown> = {};
  const inputTokens = readNonNegativeNumber(value.inputTokens ?? value.input_tokens ?? value.prompt_tokens);
  const outputTokens = readNonNegativeNumber(value.outputTokens ?? value.output_tokens ?? value.completion_tokens);
  const cachedInputTokens = readNonNegativeNumber(value.cachedInputTokens ?? value.cached_input_tokens);
  const totalTokens = readNonNegativeNumber(value.totalTokens ?? value.total_tokens);
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (cachedInputTokens !== undefined) usage.cachedInputTokens = cachedInputTokens;
  if (totalTokens !== undefined) usage.totalTokens = totalTokens;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function grokTextPayload(record: Record<string, unknown>): string | null {
  if (typeof record.text === "string" && record.text.trim() !== "") return record.text;
  if (isRecord(record.text)) return JSON.stringify(record.text);
  if (typeof record.recommendation === "string" || typeof record.status === "string") return JSON.stringify(record);
  return null;
}

function parseGrokOutput(stdout: string): IsolatedReviewHostParsedEnvelope | null {
  const record = parseGrokEnvelopeRecord(stdout.trim());
  if (!record) return null;
  const payload = grokTextPayload(record);
  if (!payload) return null;
  const objects = jsonObjectSequence(payload);
  if (!objects) return null;
  const sessionId = typeof record.sessionId === "string"
    ? record.sessionId
    : typeof record.session_id === "string"
      ? record.session_id
      : null;
  const usage = readGrokUsage(record.usage)
    ?? readGrokUsage(record.tokenUsage)
    ?? readGrokUsage(record.tokens);
  return {
    text: objects[objects.length - 1]!,
    priorTexts: objects.slice(0, -1),
    sessionId,
    ...(usage ? { usage } : {}),
  };
}

const FULL_CAPABILITIES = Object.freeze({ structuredOutput: true, readOnlySandbox: true });
const FULL_REQUIRED = Object.freeze(["structured-output", "read-only-sandbox"] as const);

export const isolatedReviewHostAdapter: IsolatedReviewHostAdapter = Object.freeze({
  id: GROK_BUILD_HOST_ID,
  capabilities: FULL_CAPABILITIES,
  requiredCapabilities: FULL_REQUIRED,
  requiresPromptFile: true,
  requiresSchemaFile: false,
  executableNames: Object.freeze([...GROK_BUILD_EXECUTABLE_NAMES]),
  windowsExecutableNames: Object.freeze([...GROK_BUILD_WINDOWS_EXECUTABLE_NAMES]),
  windowsNodeModulesScriptPath(): string | null {
    return null;
  },
  windowsFallbackExecutablePath(): string | null {
    return join(homedir(), ".grok", "bin", "grok.exe");
  },
  buildInvocation(context: IsolatedReviewHostInvocationContext): IsolatedReviewHostBuiltInvocation {
    if (!context.promptPath) throw new Error("Grok review routing requires a private prompt file.");
    const args: string[] = [
      "--cwd", context.repoRoot,
      "--permission-mode", "dontAsk",
      "--sandbox", "strict",
      "--allow", "Read",
      "--allow", "Grep",
      "--deny", "Bash(*)",
      "--deny", "Edit",
      "--deny", "WebFetch",
      "--deny", "MCPTool(*)",
      "--deny", "Read(.qube/aie/reviews/**)",
      "--no-plan",
      "--no-subagents",
      "--disable-web-search",
      "--no-memory",
      "--max-turns", String(context.maxTurns),
      "--json-schema", context.schemaJson,
    ];
    if (context.effort) args.push("--reasoning-effort", context.effort);
    if (context.model) args.push("--model", context.model);
    args.push("--verbatim", "--prompt-file", context.promptPath);
    return { args, stdin: null };
  },
  parseEnvelope: parseGrokOutput,
  probeAfterVersion({ model, executable, prefixArgs, runCommand, version }: IsolatedReviewHostProbeContext): IsolatedReviewHostProbeResult {
    if (!model) return { status: "ready", modelListed: null, diagnostic: null };
    let catalogOutput: string;
    try {
      catalogOutput = runCommand(executable, [...prefixArgs, "models"]);
    } catch {
      return {
        status: "blocked",
        modelListed: null,
        diagnostic: `The grok CLI resolved (${version}) but its model catalog could not be read. Run \`grok models\` manually and fix authentication or CLI state before running routed review lanes.`,
      };
    }
    const catalog = parseGrokModelCatalog(catalogOutput);
    if (!catalog) {
      return {
        status: "blocked",
        modelListed: null,
        diagnostic: `The grok CLI resolved (${version}) but its model catalog output was unrecognized. Run \`grok models\` manually and update the trusted review route configuration.`,
      };
    }
    if (!catalog.includes(model)) {
      return {
        status: "blocked",
        modelListed: false,
        diagnostic: `Configured review model "${model}" is not in the grok catalog (${sanitizeProbeText(catalog.join(", "))}). Update the trusted review model configuration to a listed model.`,
      };
    }
    return { status: "ready", modelListed: true, diagnostic: null };
  },
  listCatalog({ executable, prefixArgs, runCommand }: Pick<IsolatedReviewHostProbeContext, "executable" | "prefixArgs" | "runCommand">): string[] | null {
    return parseGrokModelCatalog(runCommand(executable, [...prefixArgs, "models"]));
  },
});

export const reviewHostAdapter = isolatedReviewHostAdapter;

export {
  assertGrokBuildHostCapabilityAvailable,
  formatGrokBuildUnsupportedCapabilityMessage,
  getGrokBuildHostCapability,
  inspectGrokBuildWorkspace,
  listGrokBuildHostCapabilities,
  listGrokBuildInstallFiles,
  listGrokBuildInstallNotes,
} from "./host_capabilities.js";
export type {
  GrokBuildCapabilityCategory,
  GrokBuildHostCapability,
  GrokBuildHostCapabilityId,
  GrokBuildHostSupport,
  GrokBuildWorkspaceInspection,
  GrokBuildWorkspaceTarget,
} from "./host_capabilities.js";
export { grokBuildHostFiles } from "./host_files.js";
export type { GrokBuildHostFile } from "./host_files.js";
export {
  grokBuildStopHookFile,
  isGrokSessionEndReason,
  parseGrokStopPayload,
} from "./stop_hook.js";
export type {
  GrokBuildStopHookFile,
  GrokBuildStopParseResult,
  GrokBuildStopPayload,
} from "./stop_hook.js";
