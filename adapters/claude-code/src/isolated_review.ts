import { homedir } from "node:os";
import { join } from "node:path";

import type {
  IsolatedReviewHostAdapter,
  IsolatedReviewHostBuiltInvocation,
  IsolatedReviewHostInvocationContext,
  IsolatedReviewHostParsedEnvelope,
  IsolatedReviewHostProbeContext,
  IsolatedReviewHostProbeResult,
} from "@tjalve/qube-core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readClaudeUsage(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const usage: Record<string, unknown> = {};
  const inputTokens = readNonNegativeNumber(value.input_tokens);
  const outputTokens = readNonNegativeNumber(value.output_tokens);
  const cacheReadInputTokens = readNonNegativeNumber(value.cache_read_input_tokens);
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (cacheReadInputTokens !== undefined) usage.cachedInputTokens = cacheReadInputTokens;
  if (inputTokens !== undefined && outputTokens !== undefined) {
    usage.totalTokens = inputTokens + outputTokens + (cacheReadInputTokens ?? 0);
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export function parseClaudeOutput(stdout: string): IsolatedReviewHostParsedEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.type !== "result") return null;
  if (parsed.is_error === true || parsed.subtype !== "success") return null;
  let text: string | null = null;
  if (isRecord(parsed.structured_output)) {
    text = JSON.stringify(parsed.structured_output);
  } else if (typeof parsed.result === "string" && parsed.result.trim() !== "") {
    text = parsed.result.trim();
  }
  if (!text) return null;
  const modelUsage = isRecord(parsed.modelUsage) ? parsed.modelUsage : null;
  const reportedModel = modelUsage ? Object.keys(modelUsage)[0] : undefined;
  const usage = readClaudeUsage(parsed.usage);
  return {
    text,
    sessionId: typeof parsed.session_id === "string" && parsed.session_id !== "" ? parsed.session_id : null,
    ...(reportedModel ? { reportedModel } : {}),
    ...(usage ? { usage } : {}),
  };
}

export const isolatedReviewHostAdapter: IsolatedReviewHostAdapter = Object.freeze({
  id: "claude-code",
  capabilities: Object.freeze({ structuredOutput: true, readOnlySandbox: true }),
  requiredCapabilities: Object.freeze(["structured-output", "read-only-sandbox"] as const),
  requiresPromptFile: false,
  requiresSchemaFile: false,
  executableNames: Object.freeze(["claude"]),
  windowsExecutableNames: Object.freeze(["claude.exe"]),
  windowsNodeModulesScriptPath(shimDir: string): string | null {
    return join(shimDir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
  },
  windowsFallbackExecutablePath(): string | null {
    return join(homedir(), ".local", "bin", "claude.exe");
  },
  buildInvocation(context: IsolatedReviewHostInvocationContext): IsolatedReviewHostBuiltInvocation {
    const args: string[] = [
      "-p",
      "--output-format", "json",
      "--json-schema", context.schemaJson,
      // Plan mode never edits files or runs mutating commands, so the review
      // cannot change the checkout while it inspects it.
      "--permission-mode", "plan",
      "--no-session-persistence",
    ];
    if (context.model) args.push("--model", context.model);
    if (context.effort) args.push("--effort", context.effort);
    return { args, stdin: context.prompt };
  },
  parseEnvelope: parseClaudeOutput,
  probeAfterVersion({ model, executable, prefixArgs, runCommand, version }: IsolatedReviewHostProbeContext): IsolatedReviewHostProbeResult {
    let help: string;
    try {
      help = runCommand(executable, [...prefixArgs, "--help"]);
    } catch {
      return {
        status: "blocked",
        modelListed: null,
        diagnostic: `The Claude Code CLI resolved (${version}) but its help could not be read. Run \`claude --help\` manually and fix the CLI state before running routed review lanes.`,
      };
    }
    const missing = ["--json-schema", "--permission-mode", "--output-format"].filter(flag => !help.includes(flag));
    if (missing.length > 0) {
      return {
        status: "blocked",
        modelListed: null,
        diagnostic: `The Claude Code CLI (${version}) does not expose required isolated-review flags (${missing.join(", ")}). Update the official CLI before running routed review lanes.`,
      };
    }
    let loggedIn = false;
    try {
      const status: unknown = JSON.parse(runCommand(executable, [...prefixArgs, "auth", "status"]));
      loggedIn = isRecord(status) && status.loggedIn === true;
    } catch {
      loggedIn = false;
    }
    if (!loggedIn) {
      return {
        status: "blocked",
        modelListed: null,
        diagnostic: "The Claude Code CLI is not authenticated. Run `claude auth login` outside QUBE, then rerun.",
      };
    }
    // Claude Code exposes no non-interactive model catalog, so a configured
    // model cannot be listed here; the lane result reports the model that ran.
    return { status: "ready", modelListed: null, diagnostic: null };
  },
});

export const reviewHostAdapter = isolatedReviewHostAdapter;
