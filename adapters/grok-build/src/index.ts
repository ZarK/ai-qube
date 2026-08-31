import { homedir } from "node:os";
import { join, posix as pathPosix } from "node:path";

import { defineAgentHostProfile } from "@tjalve/qube-core";
import type {
  AgentHostModelDiscoveryContext,
  AgentHostProfile,
  AgentHostReviewAgentTarget,
  InstructionTarget,
  IsolatedReviewHostAdapter,
  IsolatedReviewHostBuiltInvocation,
  IsolatedReviewHostInvocationContext,
  IsolatedReviewHostParsedEnvelope,
  IsolatedReviewHostProbeContext,
  IsolatedReviewHostProbeResult,
  MakeItSoSurface,
} from "@tjalve/qube-core";

const GROK_BUILD_EXECUTABLE_NAMES = ["grok"] as const;
const GROK_BUILD_WINDOWS_EXECUTABLE_NAMES = ["grok.exe"] as const;

export const GROK_BUILD_HOST_ID = "grok-build" as const;
export const grokBuildRouteRunnerPath = pathPosix.join(".grok", "agents", "qube-route-runner.md");

const AGENTS_INSTRUCTIONS: InstructionTarget = Object.freeze({
  id: "agents-instructions",
  path: "AGENTS.md",
  description: "Always-loaded Executor instructions for AGENTS.md hosts.",
});

const GROK_MAKE_IT_SO: MakeItSoSurface = Object.freeze({
  id: "grok-make-it-so",
  path: pathPosix.join(".grok", "commands", "make-it-so.md"),
  description: "Grok Build project command that starts or resumes the autonomous Executor workflow.",
  kind: "command",
  invocation: "/make-it-so",
});

const GROK_REVIEW_TARGETS: readonly AgentHostReviewAgentTarget[] = Object.freeze([
  Object.freeze({
    id: "grok-review-focus-agent",
    path: pathPosix.join(".grok", "agents", "qube-review-focus.md"),
    description: "Grok Build read-only subagent for one focused local PR review lane.",
    renderer: "grok-review-focus-agent",
  }),
  Object.freeze({
    id: "grok-review-explorer-agent",
    path: pathPosix.join(".grok", "agents", "qube-review-explorer.md"),
    description: "Grok Build read-only economy subagent that reads and summarizes large texts for a review lane.",
    renderer: "grok-review-explorer-agent",
  }),
  Object.freeze({
    id: "grok-review-digest-agent",
    path: pathPosix.join(".grok", "agents", "qube-review-digest.md"),
    description: "Grok Build read-only economy subagent that condenses diffs and test output for a review lane.",
    renderer: "grok-review-digest-agent",
  }),
  Object.freeze({
    id: "grok-review-librarian-agent",
    path: pathPosix.join(".grok", "agents", "qube-review-librarian.md"),
    description: "Grok Build read-only economy subagent that locates files, symbols, and prior review evidence for a review lane.",
    renderer: "grok-review-librarian-agent",
  }),
]);

const GROK_TASK_LIST = Object.freeze({
  support: "unsupported" as const,
  description: "QUBE has no tested Grok Build task-list integration.",
  nextAction: "Keep the visible checklist and configured provider records current.",
  tools: Object.freeze([] as string[]),
  fallback: "Keep the visible checklist and configured provider records current.",
  instruction: "For Grok Build, keep local tasks in the visible checklist and durable state in configured provider records. Do not invent a Grok task tool.",
});

export const grokBuildHostProfile: AgentHostProfile = defineAgentHostProfile({
  id: "grok-build",
  displayName: "Grok Build",
  executables: Object.freeze({
    names: Object.freeze([...GROK_BUILD_EXECUTABLE_NAMES]),
    windowsNames: Object.freeze([...GROK_BUILD_WINDOWS_EXECUTABLE_NAMES]),
  }),
  instructionTarget: AGENTS_INSTRUCTIONS,
  makeItSo: GROK_MAKE_IT_SO,
  taskList: GROK_TASK_LIST,
  review: Object.freeze({
    local: Object.freeze({
      support: "supported",
      description: "Grok Build can run a fresh read-only review subagent that returns one candidate lane result to the main session. The main session validates the result, writes evidence and provenance, and publishes provider feedback.",
      freshContext: true,
      readOnly: true,
      agents: GROK_REVIEW_TARGETS,
    }),
    isolated: Object.freeze({
      support: "supported",
      description: "QUBE can start a fresh Grok Build review process with strict read-only controls and validate its structured result.",
      freshContext: true,
      readOnly: true,
      agents: Object.freeze([]),
    }),
  }),
  modelDiscovery: Object.freeze({
    support: "supported",
    description: "Grok Build lists the models available to the signed-in user through its live CLI catalog.",
    listModels({ executable, prefixArgs, runCommand }: AgentHostModelDiscoveryContext) {
      return parseGrokModelCatalog(runCommand(executable, [...prefixArgs, "models"]));
    },
  }),
  umpire: Object.freeze({
    continuation: Object.freeze({
      support: "experimental",
      description: "A managed Grok Build Stop hook can emit a continuation prompt for current-issue recovery while Continuous Shipping is enabled.",
      nextAction: "Run `qube aiu init --tool grok-build`, review the hook, and trust it with `/hooks-trust`.",
      delivery: "stdout",
      currentIssueRecovery: true,
    }),
    probe: Object.freeze({
      support: "experimental",
      description: "QUBE can inspect Grok Build Umpire setup through AIU doctor.",
      nextAction: "Run `qube aiu doctor --json` and address any reported setup problems.",
      command: Object.freeze(["qube", "aiu", "doctor", "--json"] as const),
    }),
  }),
  trust: Object.freeze({
    required: true,
    description: "Grok Build must trust the managed project Stop hook before Umpire continuation can run.",
    actions: Object.freeze([
      Object.freeze({
        id: "review-grok-hook",
        kind: "review-files",
        description: "Review the managed Grok Build Stop hook.",
        paths: Object.freeze([".grok/hooks/ai-umpire.json"]),
      }),
      Object.freeze({
        id: "trust-grok-hook",
        kind: "run-command",
        description: "Trust the project Stop hook from Grok Build.",
        command: "/hooks-trust",
      }),
    ]),
  }),
  subagents: Object.freeze({
    support: "supported",
    description: "Grok Build supports bounded native subagents with fresh task contexts.",
    instruction: "Grok Build subagents may be used for bounded support work. Routed review already has a Grok host adapter. Local review-agent files are installed when local review includes this host.",
  }),
} satisfies AgentHostProfile);

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

function parseGrokEnvelopeRecords(stdout: string): Record<string, unknown>[] {
  try {
    const value: unknown = JSON.parse(stdout);
    if (isRecord(value)) return [value];
  } catch {
    // Grok may emit JSONL.
  }
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  const records: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) records.push(value);
    } catch {
      // Host diagnostics and progress prose are not review evidence.
    }
  }
  return records;
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
  const records = parseGrokEnvelopeRecords(stdout.trim());
  const objects: string[] = [];
  let sessionId: string | null = null;
  let reportedModel: string | undefined;
  let usage: Record<string, unknown> | undefined;
  for (const record of records) {
    if (typeof record.sessionId === "string") sessionId = record.sessionId;
    else if (typeof record.session_id === "string") sessionId = record.session_id;
    if (typeof record.model === "string" && record.model.trim() !== "") reportedModel = record.model.trim();
    usage = readGrokUsage(record.usage)
      ?? readGrokUsage(record.tokenUsage)
      ?? readGrokUsage(record.tokens)
      ?? usage;
    const payload = grokTextPayload(record);
    if (!payload) continue;
    const sequence = jsonObjectSequence(payload);
    if (sequence) objects.push(...sequence);
  }
  if (objects.length === 0) return null;
  return {
    text: objects[objects.length - 1]!,
    transientTexts: objects.slice(0, -1),
    sessionId,
    ...(reportedModel ? { reportedModel } : {}),
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
  grokBuildStopHookFile,
  isGrokSessionEndReason,
  parseGrokStopPayload,
} from "./stop_hook.js";
export type {
  GrokBuildStopHookFile,
  GrokBuildStopParseResult,
  GrokBuildStopPayload,
} from "./stop_hook.js";
export { grokBuildContinuationAdapter, grokBuildContinuationDeclaration, inspectGrokBuildFolderTrust } from "./continuation.js";
export type { GrokBuildFolderTrustInspection } from "./continuation.js";
