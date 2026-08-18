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

function readHostUsage(value: unknown): Record<string, unknown> | undefined {
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

function sanitizeProbeText(value: string): string {
  return value.replace(/\u001b\[[0-9;]*[A-Za-z]/g, " ").replace(/[^ -~]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

export function parseCodexModelCatalog(output: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.models)) return null;
  const models: string[] = [];
  for (const item of parsed.models) {
    if (!isRecord(item) || typeof item.slug !== "string") continue;
    const slug = item.slug.trim();
    if (slug !== "") models.push(slug);
  }
  return models.length > 0 ? models : null;
}

function usageFromCodexEvent(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const direct = readHostUsage(record.usage);
  if (direct) return direct;
  if (record.type === "token_count") {
    return readHostUsage(isRecord(record.info) ? record.info : record);
  }
  if (record.type === "event_msg" && isRecord(record.payload) && record.payload.type === "token_count") {
    const info = isRecord(record.payload.info) ? record.payload.info : record.payload;
    return readHostUsage(info.total_token_usage ?? info.last_token_usage ?? info);
  }
  if (isRecord(record.item) && record.item.type === "usage") return readHostUsage(record.item);
  return undefined;
}

function parseCodexOutput(stdout: string): IsolatedReviewHostParsedEnvelope | null {
  const messages: string[] = [];
  let sessionId: string | null = null;
  let usage: Record<string, unknown> | undefined;
  for (const line of stdout.split(/\r?\n/).filter((entry) => entry.trim() !== "")) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const record = event as Record<string, unknown>;
    if (record.type === "thread.started" && typeof record.thread_id === "string") sessionId = record.thread_id;
    if (record.type === "item.completed" && record.item && typeof record.item === "object" && !Array.isArray(record.item)) {
      const item = record.item as Record<string, unknown>;
      if (item.type === "agent_message" && typeof item.text === "string") messages.push(item.text);
    }
    const eventUsage = usageFromCodexEvent(record);
    if (eventUsage) usage = eventUsage;
  }
  if (messages.length === 0) return null;
  return {
    text: messages[messages.length - 1]!,
    sessionId,
    ...(messages.length > 1 ? { priorTexts: messages.slice(0, -1) } : {}),
    ...(usage ? { usage } : {}),
  };
}

export const isolatedReviewHostAdapter: IsolatedReviewHostAdapter = Object.freeze({
  id: "codex",
  capabilities: Object.freeze({ structuredOutput: true, readOnlySandbox: true }),
  requiredCapabilities: Object.freeze(["structured-output", "read-only-sandbox"] as const),
  requiresPromptFile: false,
  requiresSchemaFile: true,
  windowsShell: "powershell",
  executableNames: Object.freeze(["codex"]),
  windowsExecutableNames: Object.freeze(["codex.exe"]),
  windowsNodeModulesScriptPath(shimDir: string): string | null {
    return join(shimDir, "node_modules", "@openai", "codex", "bin", "codex.js");
  },
  windowsFallbackExecutablePath(): string | null {
    return null;
  },
  buildInvocation(context: IsolatedReviewHostInvocationContext): IsolatedReviewHostBuiltInvocation {
    if (!context.schemaPath) throw new Error("Codex review routing requires a private output schema file.");
    const args: string[] = ["exec"];
    if (context.model) args.push("--model", context.model);
    if (context.effort) args.push("--config", `model_reasoning_effort="${context.effort}"`);
    args.push(
      "--ignore-user-config",
      "--ignore-rules",
      "--strict-config",
      "--config",
      "mcp_servers={}",
      "--config",
      'web_search="disabled"',
      "--config",
      "shell_environment_policy.inherit=all",
    );
    // Isolated review ignores user config. On Windows that also drops the
    // restricted-token sandbox backend, so read-only becomes a policy shape
    // with nothing to enforce and PowerShell-wrapped git/rg die as
    // "blocked by policy". Unelevated restores a real backend.
    if (process.platform === "win32") {
      args.push("--config", 'windows.sandbox="unelevated"');
    }
    args.push(
      "--disable",
      "apps",
      "--disable",
      "browser_use",
      "--disable",
      "browser_use_external",
      "--disable",
      "computer_use",
      "--disable",
      "in_app_browser",
      "--disable",
      "standalone_web_search",
      "--disable",
      "multi_agent",
      "--disable",
      "hooks",
      "--disable",
      "plugins",
      "--sandbox",
      "read-only",
      "--cd",
      context.repoRoot,
      "--skip-git-repo-check",
      "--ephemeral",
      "--output-schema",
      context.schemaPath,
      "--json",
      "-",
    );
    return { args, stdin: context.prompt };
  },
  parseEnvelope: parseCodexOutput,
  probeAfterVersion({ model, executable, prefixArgs, runCommand }: IsolatedReviewHostProbeContext): IsolatedReviewHostProbeResult {
    if (!model) return { status: "ready", modelListed: null, diagnostic: null };
    let catalog: string[] | null;
    try {
      catalog = parseCodexModelCatalog(runCommand(executable, [...prefixArgs, "debug", "models"]));
    } catch {
      return { status: "ready", modelListed: null, diagnostic: null };
    }
    if (!catalog) return { status: "ready", modelListed: null, diagnostic: null };
    if (!catalog.includes(model)) {
      return {
        status: "blocked",
        modelListed: false,
        diagnostic: `Configured review model "${model}" is not in the Codex catalog (${sanitizeProbeText(catalog.join(", "))}). Update the trusted review model configuration to a listed model.`,
      };
    }
    return { status: "ready", modelListed: true, diagnostic: null };
  },
  listCatalog({ executable, prefixArgs, runCommand }: Pick<IsolatedReviewHostProbeContext, "executable" | "prefixArgs" | "runCommand">): string[] | null {
    return parseCodexModelCatalog(runCommand(executable, [...prefixArgs, "debug", "models"]));
  },
});

export const reviewHostAdapter = isolatedReviewHostAdapter;
