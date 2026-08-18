import type {
  IsolatedReviewHostAdapter,
  IsolatedReviewHostBuiltInvocation,
  IsolatedReviewHostInvocationContext,
  IsolatedReviewHostParsedEnvelope,
  IsolatedReviewHostProbeContext,
  IsolatedReviewHostProbeResult,
} from "@tjalve/qube-core";

export const CURSOR_HOST_ID = "cursor" as const;
export const CURSOR_MINIMUM_DATE_VERSION = "2026.08.11";

export const cursorHostProfile = Object.freeze({
  id: CURSOR_HOST_ID,
  displayName: "Cursor",
  instructionTargets: Object.freeze([{ id: "agents-instructions", path: "AGENTS.md", description: "Always-loaded Executor instructions for AGENTS.md hosts." }]),
  commandTargets: Object.freeze([]),
  todo: Object.freeze({
    tools: Object.freeze([] as string[]),
    fallback: "Keep the visible checklist and GitHub issue records current.",
    instruction: "Cursor has no QUBE todo integration. Keep local working state in the visible checklist and durable state in GitHub.",
  }),
  dialogue: Object.freeze({
    expectation: "Use Cursor only as isolated review compute. QUBE owns evidence validation and provider publication.",
  }),
  subagents: Object.freeze({ supported: false, instruction: "Do not use Cursor subagents for QUBE routed review. QUBE starts one fresh sandboxed Cursor process per lane." }),
  hooks: Object.freeze({ supported: false, description: "QUBE does not install Cursor hooks." }),
  supportsProjectCommands: false,
});

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

export function parseCursorEnvelope(stdout: string): IsolatedReviewHostParsedEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!isRecord(parsed)
    || parsed.type !== "result"
    || parsed.subtype !== "success"
    || parsed.is_error !== false
    || typeof parsed.result !== "string"
    || parsed.result.trim() === "") return null;
  return {
    text: parsed.result,
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

export function buildCursorInvocation(
  context: IsolatedReviewHostInvocationContext,
  _platform: NodeJS.Platform = process.platform,
): IsolatedReviewHostBuiltInvocation {
  const args = ["--print", "--output-format", "json", "--mode", "ask", "--sandbox", "enabled"];
  if (context.model) args.push("--model", context.model);
  args.push("--workspace", context.repoRoot);
  return { args, stdin: context.prompt };
}

export function probeCursor(
  { model, executable, prefixArgs, runCommand, version }: IsolatedReviewHostProbeContext,
  platform: string = process.platform,
): IsolatedReviewHostProbeResult {
  if (platform === "win32") {
    return {
      status: "blocked",
      modelListed: null,
      diagnostic: "Cursor review lanes require the Cursor sandbox, which is not available on native Windows. Run QUBE and the official Cursor CLI in WSL2, Linux, or macOS. QUBE will not weaken review isolation to use native Windows Ask mode.",
    };
  }
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
  const missing = requiredHelpMissing(help);
  if (missing.length > 0 || !/\bask\b/i.test(help) || !help.includes("--sandbox")) {
    const capabilities = [...missing, ...(!/\bask\b/i.test(help) ? ["ask-mode"] : []), ...(!help.includes("--sandbox") ? ["--sandbox"] : [])];
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
  if (model && !catalog.includes(model)) {
    return { status: "blocked", modelListed: false, diagnostic: `Configured review model "${model}" is not in the Cursor catalog (${sanitize(catalog.join(", "))}). Select a listed model.` };
  }
  return { status: "ready", modelListed: model ? true : null, diagnostic: null };
}

export const isolatedReviewHostAdapter: IsolatedReviewHostAdapter = Object.freeze({
  id: CURSOR_HOST_ID,
  capabilities: Object.freeze({ structuredOutput: true, readOnlySandbox: true }),
  requiredCapabilities: Object.freeze(["structured-output", "read-only-sandbox"] as const),
  executableNames: Object.freeze(["cursor-agent", "agent"]),
  windowsExecutableNames: Object.freeze([]),
  requiresPromptFile: false,
  requiresSchemaFile: false,
  unsupportedPlatformMessage: "Native Windows cannot provide the required Cursor sandbox. Run QUBE and the Cursor CLI inside WSL2.",
  supportsPlatform(platform: string): boolean { return platform !== "win32"; },
  windowsNodeModulesScriptPath(): string | null { return null; },
  windowsFallbackExecutablePath(): string | null { return null; },
  buildInvocation(context: IsolatedReviewHostInvocationContext): IsolatedReviewHostBuiltInvocation {
    return buildCursorInvocation(context);
  },
  parseEnvelope: parseCursorEnvelope,
  probeAfterVersion(context: IsolatedReviewHostProbeContext): IsolatedReviewHostProbeResult {
    return probeCursor(context, context.platform ?? process.platform);
  },
  listCatalog({ executable, prefixArgs, runCommand }: Pick<IsolatedReviewHostProbeContext, "executable" | "prefixArgs" | "runCommand">): string[] | null {
    return parseCursorModelCatalog(runCommand(executable, [...prefixArgs, "models"]));
  },
});

export const reviewHostAdapter = isolatedReviewHostAdapter;
