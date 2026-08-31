import { existsSync, readdirSync } from "node:fs";
import { win32 as windowsPath } from "node:path";
import { fileURLToPath } from "node:url";

import { defineAgentHostProfile } from "@tjalve/qube-core";
import type {
  AgentHostModelDiscoveryContext,
  AgentHostProfile,
  InstructionTarget,
  IsolatedReviewHostAdapter,
  IsolatedReviewHostBuiltInvocation,
  IsolatedReviewHostExecutable,
  IsolatedReviewHostInvocationContext,
  IsolatedReviewHostParsedEnvelope,
  IsolatedReviewHostProbeContext,
  IsolatedReviewHostProbeResult,
  MakeItSoSurface,
} from "@tjalve/qube-core";
import {
  compatibleCursorAcpModels,
  directCursorModel,
  parseCursorAcpCatalog,
  resolveCursorAcpModel,
  type CursorAcpCatalog,
  type CursorModelDescriptor,
} from "./model_resolution.js";

export {
  compatibleCursorAcpModels,
  cursorAcpModelOptions,
  directCursorModel,
  parseCursorAcpCatalog,
  resolveCursorAcpModel,
} from "./model_resolution.js";
export type { CursorAcpCatalog, CursorAcpModelOption, CursorModelDescriptor, CursorModelTransport } from "./model_resolution.js";

export const CURSOR_HOST_ID = "cursor" as const;
export const CURSOR_MINIMUM_DATE_VERSION = "2026.08.11";

const CURSOR_INSTRUCTIONS: InstructionTarget = Object.freeze({
  id: "agents-instructions",
  path: "AGENTS.md",
  description: "Always-loaded Executor instructions for Cursor.",
});

const CURSOR_MAKE_IT_SO: MakeItSoSurface = Object.freeze({
  id: "cursor-make-it-so",
  path: ".cursor/commands/make-it-so.md",
  description: "Cursor project command that starts or resumes the autonomous Executor workflow.",
  kind: "command",
  invocation: "/make-it-so",
});

const CURSOR_TASK_LIST = Object.freeze({
  support: "unsupported" as const,
  description: "QUBE has no tested Cursor task-list integration.",
  nextAction: "Keep the visible checklist and configured provider records current.",
  tools: Object.freeze([] as string[]),
  fallback: "Keep the visible checklist and configured provider records current.",
  instruction: "Cursor has no QUBE task-list integration. Keep local working state in the visible checklist and durable state in configured provider records.",
});

export const cursorHostProfile = defineAgentHostProfile({
  id: CURSOR_HOST_ID,
  displayName: "Cursor",
  executables: Object.freeze({
    names: Object.freeze(["cursor-agent", "agent"]),
    windowsNames: Object.freeze(["cursor-agent.exe", "agent.exe"]),
  }),
  instructionTarget: CURSOR_INSTRUCTIONS,
  makeItSo: CURSOR_MAKE_IT_SO,
  taskList: CURSOR_TASK_LIST,
  review: Object.freeze({
    local: Object.freeze({
      support: "unsupported",
      description: "QUBE has no tested Cursor native subagent integration for local review lanes.",
      nextAction: "Use Cursor through its isolated review adapter or select a host with tested native review subagents.",
      freshContext: false,
      readOnly: false,
      agents: Object.freeze([]),
    }),
    isolated: Object.freeze({
      support: "supported",
      description: "QUBE starts a fresh Cursor review session with read-only controls and validates one structured result.",
      freshContext: true,
      readOnly: true,
      agents: Object.freeze([]),
    }),
  }),
  modelDiscovery: Object.freeze({
    support: "supported",
    description: "Cursor lists only models that the active review transport can execute with the selected semantics.",
    listModels(context: AgentHostModelDiscoveryContext) {
      return listCursorModels(context);
    },
  }),
  umpire: Object.freeze({
    continuation: Object.freeze({
      support: "unsupported",
      description: "QUBE has no tested Cursor continuation hook or prompt-delivery integration.",
      nextAction: "Continue the current issue from the Cursor session or use a harness with supported Umpire continuation.",
      delivery: "none",
      currentIssueRecovery: false,
    }),
    probe: Object.freeze({
      support: "unsupported",
      description: "QUBE has no Cursor Umpire integration to inspect.",
      nextAction: "No Cursor Umpire probe is available.",
    }),
  }),
  trust: Object.freeze({
    required: false,
    description: "QUBE does not install Cursor hooks or other trust-gated runtime assets.",
    actions: Object.freeze([]),
  }),
  subagents: Object.freeze({
    support: "unsupported",
    description: "QUBE has no tested Cursor subagent integration.",
    nextAction: "Use the main Cursor session or a harness with tested native subagents.",
    instruction: "Do not use Cursor subagents for QUBE routed review. QUBE starts one fresh isolated Cursor process per lane.",
  }),
} satisfies AgentHostProfile);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sanitize(value: string): string {
  return value.replace(/\u001b\[[0-9;]*[A-Za-z]/g, " ").replace(/[^ -~]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

export function parseCursorStatus(output: string): boolean | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.isAuthenticated === true && parsed.status === "authenticated") return true;
  if (parsed.isAuthenticated === false || parsed.status === "unauthenticated") return false;
  return null;
}

export function parseCursorModelCatalog(output: string): string[] | null {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex(line => /^\s*Available models\s*$/i.test(line));
  if (start === -1) return null;
  const models: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^\s*([A-Za-z0-9][A-Za-z0-9._:/-]*)\s+-\s+/.exec(line);
    if (match) models.push(match[1]);
  }
  return models.length > 0 ? models : null;
}

export function listCursorModels(
  { executable, prefixArgs, runCommand }: AgentHostModelDiscoveryContext,
  platform: string = process.platform,
): string[] | null {
  const displayIds = parseCursorModelCatalog(runCommand(executable, [...prefixArgs, "models"]));
  if (!displayIds) return null;
  if (platform !== "win32") return displayIds;
  const acpCatalog = parseCursorAcpCatalog(runCommand(executable, [...prefixArgs, "--acp-models"]));
  if (!acpCatalog) return null;
  return compatibleCursorAcpModels(displayIds, acpCatalog.options).map(model => model.displayId);
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  try {
    if (isRecord(JSON.parse(trimmed))) return trimmed;
  } catch {
    // Cursor Grok often prefixes the lane JSON with a short thinking sentence.
  }
  for (let index = trimmed.lastIndexOf("{"); index >= 0; index = trimmed.lastIndexOf("{", Math.max(0, index - 1))) {
    const candidate = trimmed.slice(index);
    try {
      if (isRecord(JSON.parse(candidate))) return candidate;
    } catch {
      // Keep scanning earlier object starts.
    }
    if (index === 0) break;
  }
  return null;
}

export function parseCursorEnvelope(stdout: string): IsolatedReviewHostParsedEnvelope | null {
  const records: Record<string, unknown>[] = [];
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (isRecord(parsed)) records.push(parsed);
  } catch {
    for (const line of stdout.split(/\r?\n/)) {
      try {
        const parsed: unknown = JSON.parse(line.trim());
        if (isRecord(parsed)) records.push(parsed);
      } catch {
        // Host diagnostics and progress prose are not review evidence.
      }
    }
  }
  const terminalResults = records.filter(parsed => parsed.type === "result");
  if (terminalResults.length !== 1) return null;
  const parsed = terminalResults[0];
  if (parsed.subtype !== "success"
    || parsed.is_error !== false
    || typeof parsed.result !== "string"
    || parsed.result.trim() === "") return null;
  const text = extractJsonObject(parsed.result);
  if (!text) return null;
  return {
    text,
    sessionId: typeof parsed.session_id === "string" && parsed.session_id !== "" ? parsed.session_id : null,
  };
}

function dateVersion(version: string): string | null {
  const match = /\b(\d{4}\.\d{2}\.\d{2})(?:-|\b)/.exec(version);
  return match?.[1] ?? null;
}

function requiredHelpMissing(help: string): string[] {
  return ["--print", "--output-format", "--mode", "--model", "--workspace"]
    .filter(option => !help.includes(option));
}

function reviewPrompt(context: IsolatedReviewHostInvocationContext, windowsAcp = false): string {
  return [
    context.prompt,
    ...(windowsAcp ? [
      "",
      "Cursor ACP review capability boundary: use only Cursor's built-in repository read and search tools. Do not request shell or terminal commands, test execution, Git commands, writes, MCP tools, web access, or any other permission. Use the supplied review bundle and direct file reads; record unavailable command execution only as a completeness condition, not as a defect.",
    ] : []),
    "",
    "The following JSON Schema is the authoritative QUBE output contract. Return exactly one JSON object that validates against it. Preserve every required nested field, use only declared enum values, and do not add properties.",
    context.schemaJson,
  ].join("\n");
}

export function buildCursorInvocation(
  context: IsolatedReviewHostInvocationContext,
  platform: NodeJS.Platform = process.platform,
): IsolatedReviewHostBuiltInvocation {
  if (context.effort !== null) {
    throw new Error("Cursor review routing does not support a separate reasoning effort. Select the exact model from the Cursor catalog and set effort to null.");
  }
  if (platform === "win32") {
    const args = ["--acp-review"];
    if (context.model && context.transportModel === undefined) {
      throw new Error("Cursor Windows review requires the ACP model value recorded by the current route probe. Rerun review preflight before starting the lane.");
    }
    if (context.transportModel) args.push("--model", context.transportModel);
    if (context.model) args.push("--requested-model", context.model);
    args.push("--workspace", context.repoRoot);
    return {
      args,
      stdin: reviewPrompt(context, true),
    };
  }
  const args = ["--print", "--output-format", "json", "--mode", "ask", "--sandbox", "enabled"];
  if (context.model) args.push("--model", context.model);
  args.push("--workspace", context.repoRoot);
  return { args, stdin: reviewPrompt(context) };
}

export function resolveCursorWindowsShim(
  shim: string,
  fileExists: (path: string) => boolean = existsSync,
  _systemRoot: string | undefined = process.env.SystemRoot,
  listDirectory: (path: string) => string[] = path => readdirSync(path, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name),
): IsolatedReviewHostExecutable | null {
  const versions = windowsPath.join(windowsPath.dirname(shim), "versions");
  let names: string[];
  try { names = listDirectory(versions); }
  catch { return null; }
  const versionParts = (name: string): number[] => {
    const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{2})-(\d{2})-(\d{2}))?-[a-f0-9]+$/iu.exec(name);
    return match ? match.slice(1, 7).map(value => Number(value ?? 0)) : [];
  };
  const selected = names
    .filter(name => /^\d{4}\.\d{1,2}\.\d{1,2}(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/iu.test(name))
    .sort((left, right) => {
      const leftParts = versionParts(left);
      const rightParts = versionParts(right);
      for (let index = 0; index < leftParts.length; index += 1) {
        if (leftParts[index] !== rightParts[index]) return rightParts[index] - leftParts[index];
      }
      return right.localeCompare(left);
    })
    .find(name => fileExists(windowsPath.join(versions, name, "node.exe"))
      && fileExists(windowsPath.join(versions, name, "index.js")));
  if (!selected) return null;
  const cursorNode = windowsPath.join(versions, selected, "node.exe");
  const cursorScript = windowsPath.join(versions, selected, "index.js");
  return {
    executable: process.execPath,
    prefixArgs: [
      fileURLToPath(new URL("./cursor-acp-runner.js", import.meta.url)),
      "--cursor-executable", cursorNode,
      "--cursor-prefix-json", JSON.stringify([cursorScript]),
      "--",
    ],
  };
}

export function probeCursor(
  { model, executable, prefixArgs, runCommand, version }: IsolatedReviewHostProbeContext,
  platform: string = process.platform,
): IsolatedReviewHostProbeResult {
  const reportedDate = dateVersion(version);
  if (!reportedDate) {
    return { status: "blocked", modelListed: null, diagnostic: `The Cursor CLI reported an unsupported version (${sanitize(version) || "empty version"}). Install an official date-versioned Cursor CLI release before running routed review lanes.` };
  }
  if (reportedDate < CURSOR_MINIMUM_DATE_VERSION) {
    return { status: "blocked", modelListed: null, diagnostic: `The Cursor CLI version ${sanitize(version)} is older than the supported ${CURSOR_MINIMUM_DATE_VERSION} capability baseline. Update the official CLI before running routed review lanes.` };
  }
  let help: string;
  try {
    help = runCommand(executable, [...prefixArgs, "--help"]);
  } catch {
    return { status: "blocked", modelListed: null, diagnostic: "The Cursor CLI resolved but its capability help could not be read. Repair the official CLI before running routed review lanes." };
  }
  const windowsAcp = platform === "win32";
  const missing = windowsAcp ? [] : requiredHelpMissing(help);
  const askMissing = !/\bask\b/i.test(help);
  let acpHelp = "";
  if (windowsAcp) {
    try { acpHelp = runCommand(executable, [...prefixArgs, "acp", "--help"]); }
    catch { acpHelp = ""; }
  }
  const isolationMissing = windowsAcp ? !/\bAgent Client Protocol\b|\bUsage:\s*\S+\s+acp\b/iu.test(acpHelp) : !help.includes("--sandbox");
  if (missing.length > 0 || askMissing || isolationMissing) {
    const capabilities = [...missing, ...(askMissing ? ["ask-mode"] : []), ...(isolationMissing ? [windowsAcp ? "acp" : "--sandbox"] : [])];
    return { status: "blocked", modelListed: null, diagnostic: `The Cursor CLI does not expose required isolated-review capabilities (${capabilities.join(", ")}). Update the official CLI before running routed review lanes.` };
  }
  let authenticated: boolean | null;
  try {
    authenticated = parseCursorStatus(runCommand(executable, [...prefixArgs, "status", "--format", "json"]));
  } catch {
    authenticated = false;
  }
  if (authenticated !== true) {
    return { status: "blocked", modelListed: null, diagnostic: "The Cursor CLI is not authenticated. Run `cursor-agent login` for browser authentication or set CURSOR_API_KEY outside QUBE, then rerun." };
  }
  let catalog: string[] | null;
  try {
    catalog = parseCursorModelCatalog(runCommand(executable, [...prefixArgs, "models"]));
  } catch {
    catalog = null;
  }
  if (!catalog) {
    return { status: "blocked", modelListed: null, diagnostic: "The Cursor CLI model catalog could not be read. Verify account access with `cursor-agent models` before running routed review lanes." };
  }
  if (model && !catalog.includes(model) && !windowsAcp) {
    return {
      status: "blocked",
      modelListed: false,
      diagnostic: `Cursor model compatibility failed: requested ${model}; transport ${windowsAcp ? "acp" : "cli"}. The model is not in the Cursor catalog (${sanitize(catalog.join(", "))}). Select a listed model.`,
      reasonCode: "model-route-model-unsupported",
      transport: windowsAcp ? "acp" : "cli",
      resolvedModel: null,
      availableModels: Object.freeze([...catalog]),
    };
  }
  if (!windowsAcp) {
    const resolved = model ? directCursorModel(model) : null;
    return {
      status: "ready",
      modelListed: model ? true : null,
      diagnostic: null,
      reasonCode: null,
      transport: "cli",
      resolvedModel: resolved?.transportValue ?? null,
      availableModels: Object.freeze([...catalog]),
    };
  }
  let acpCatalog: CursorAcpCatalog | null;
  try {
    acpCatalog = parseCursorAcpCatalog(runCommand(executable, [...prefixArgs, "--acp-models"]));
  } catch {
    acpCatalog = null;
  }
  if (!acpCatalog) {
    return {
      status: "blocked",
      modelListed: null,
      diagnostic: "Cursor ACP model compatibility could not be inspected without a prompt. Authenticate the current Cursor CLI, then rerun init or doctor.",
      reasonCode: "model-route-probe-blocked",
      transport: "acp",
      resolvedModel: null,
      availableModels: Object.freeze([]),
    };
  }
  const compatible = compatibleCursorAcpModels(catalog, acpCatalog.options);
  const choices = compatible.map(candidate => candidate.displayId);
  if (model && !catalog.includes(model)) {
    return {
      status: "blocked",
      modelListed: false,
      diagnostic: `Cursor model compatibility failed: requested ${model}; transport acp. The model is not in the Cursor CLI catalog. Compatible Cursor choices: ${sanitize(choices.join(", ")) || "none"}. Select a compatible model, then rerun.`,
      reasonCode: "model-route-model-unsupported",
      transport: "acp",
      resolvedModel: null,
      availableModels: Object.freeze(choices),
    };
  }
  const descriptor: CursorModelDescriptor | null = model
    ? resolveCursorAcpModel(acpCatalog.options, model)
    : null;
  if (model && !descriptor) {
    return {
      status: "blocked",
      modelListed: false,
      diagnostic: `Cursor model compatibility failed: requested ${model}; transport acp. ACP cannot preserve the selected effort and speed. Compatible Cursor choices: ${sanitize(choices.join(", ")) || "none"}. Select a compatible model, then rerun.`,
      reasonCode: "model-route-model-unsupported",
      transport: "acp",
      resolvedModel: null,
      availableModels: Object.freeze(choices),
    };
  }
  return {
    status: "ready",
    modelListed: model ? true : null,
    diagnostic: null,
    reasonCode: null,
    transport: "acp",
    resolvedModel: descriptor?.transportValue ?? null,
    availableModels: Object.freeze(choices),
  };
}

export const isolatedReviewHostAdapter: IsolatedReviewHostAdapter = Object.freeze({
  id: CURSOR_HOST_ID,
  capabilities: Object.freeze({ structuredOutput: true, readOnlySandbox: true }),
  requiredCapabilities: Object.freeze(["structured-output", "read-only-sandbox"] as const),
  executableNames: Object.freeze(["cursor-agent", "agent"]),
  windowsExecutableNames: Object.freeze([]),
  requiresPromptFile: false,
  requiresSchemaFile: false,
  supportsPlatform(): boolean { return true; },
  resolveWindowsShim: resolveCursorWindowsShim,
  windowsNodeModulesScriptPath(): string | null { return null; },
  windowsFallbackExecutablePath(): string | null { return null; },
  buildInvocation(context: IsolatedReviewHostInvocationContext): IsolatedReviewHostBuiltInvocation {
    return buildCursorInvocation(context, process.platform);
  },
  parseEnvelope: parseCursorEnvelope,
  probeAfterVersion(context: IsolatedReviewHostProbeContext): IsolatedReviewHostProbeResult {
    return probeCursor(context, context.platform ?? process.platform);
  },
  listCatalog({ executable, prefixArgs, runCommand }: Pick<IsolatedReviewHostProbeContext, "executable" | "prefixArgs" | "runCommand">): string[] | null {
    return listCursorModels({ executable, prefixArgs, runCommand });
  },
});

export const reviewHostAdapter = isolatedReviewHostAdapter;
