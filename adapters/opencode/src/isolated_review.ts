import { join } from "node:path";

import type {
  IsolatedReviewHostAdapter,
  IsolatedReviewHostBuiltInvocation,
  IsolatedReviewHostInvocationContext,
  IsolatedReviewHostParsedEnvelope,
  IsolatedReviewHostProbeContext,
  IsolatedReviewHostProbeResult,
} from "@tjalve/qube-core";

import { parseOpenCodeModelCatalog } from "./index.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readOpenCodeUsage(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const usage: Record<string, unknown> = {};
  const inputTokens = readNonNegativeNumber(value.input);
  const outputTokens = readNonNegativeNumber(value.output);
  const totalTokens = readNonNegativeNumber(value.total);
  const cache = isRecord(value.cache) ? value.cache : null;
  const cachedInputTokens = cache ? readNonNegativeNumber(cache.read) : undefined;
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (cachedInputTokens !== undefined) usage.cachedInputTokens = cachedInputTokens;
  if (totalTokens !== undefined) usage.totalTokens = totalTokens;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export function parseOpenCodeOutput(stdout: string): IsolatedReviewHostParsedEnvelope | null {
  const texts: string[] = [];
  let sessionId: string | null = null;
  let usage: Record<string, unknown> | undefined;
  let sawError = false;
  for (const line of stdout.split(/\r?\n/).filter(entry => entry.trim() !== "")) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      // The JSON event stream is the whole output contract: any malformed
      // line makes the output untrustworthy, not just that line.
      return null;
    }
    if (!isRecord(event)) continue;
    if (typeof event.sessionID === "string" && event.sessionID !== "") sessionId = event.sessionID;
    if (event.type === "error") sawError = true;
    if (!isRecord(event.part)) continue;
    if (event.type === "text" && event.part.type === "text" && typeof event.part.text === "string") {
      texts.push(event.part.text);
    }
    if (event.type === "step_finish") {
      usage = readOpenCodeUsage(event.part.tokens) ?? usage;
    }
  }
  if (sawError || texts.length === 0) return null;
  return {
    text: texts[texts.length - 1]!,
    ...(texts.length > 1 ? { transientTexts: texts.slice(0, -1) } : {}),
    sessionId,
    ...(usage ? { usage } : {}),
  };
}

function reviewPrompt(context: IsolatedReviewHostInvocationContext): string {
  return [
    context.prompt,
    "",
    "The following JSON Schema is the authoritative QUBE output contract. Return exactly one JSON object that validates against it. Preserve every required nested field, use only declared enum values, and do not add properties.",
    context.schemaJson,
  ].join("\n");
}

export const isolatedReviewHostAdapter: IsolatedReviewHostAdapter = Object.freeze({
  id: "opencode",
  capabilities: Object.freeze({ structuredOutput: true, readOnlySandbox: true }),
  requiredCapabilities: Object.freeze(["structured-output", "read-only-sandbox"] as const),
  requiresPromptFile: false,
  requiresSchemaFile: false,
  executableNames: Object.freeze(["opencode"]),
  windowsExecutableNames: Object.freeze(["opencode.exe"]),
  windowsNodeModulesScriptPath(shimDir: string): string | null {
    return join(shimDir, "node_modules", "opencode-ai", "bin", "opencode.exe");
  },
  windowsFallbackExecutablePath(): string | null {
    return null;
  },
  buildInvocation(context: IsolatedReviewHostInvocationContext): IsolatedReviewHostBuiltInvocation {
    const args: string[] = [
      "run",
      "--format", "json",
      // The plan agent cannot edit files, so the review cannot change the
      // checkout while it inspects it. --pure keeps project plugins (which
      // may write logs or state) out of the isolated session.
      "--agent", "plan",
      "--pure",
      "--dir", context.repoRoot,
    ];
    if (context.model) args.push("--model", context.model);
    if (context.effort) args.push("--variant", context.effort);
    return { args, stdin: reviewPrompt(context) };
  },
  parseEnvelope: parseOpenCodeOutput,
  probeAfterVersion({ model, executable, prefixArgs, runCommand, version }: IsolatedReviewHostProbeContext): IsolatedReviewHostProbeResult {
    if (!model) return { status: "ready", modelListed: null, diagnostic: null };
    let catalog: string[] | null;
    try {
      catalog = parseOpenCodeModelCatalog(runCommand(executable, [...prefixArgs, "models"]));
    } catch {
      return {
        status: "blocked",
        modelListed: null,
        diagnostic: `The OpenCode CLI resolved (${version}) but its model catalog could not be read. Run \`opencode models\` manually and fix authentication or CLI state before running routed review lanes.`,
      };
    }
    if (!catalog) {
      return {
        status: "blocked",
        modelListed: null,
        diagnostic: `The OpenCode CLI resolved (${version}) but its model catalog output was unrecognized. Run \`opencode models\` manually and update the trusted review route configuration.`,
      };
    }
    if (!catalog.includes(model)) {
      return {
        status: "blocked",
        modelListed: false,
        diagnostic: `Configured review model "${model}" is not in the OpenCode catalog. Update the trusted review model configuration to a listed model.`,
      };
    }
    return { status: "ready", modelListed: true, diagnostic: null };
  },
  listCatalog({ executable, prefixArgs, runCommand }: Pick<IsolatedReviewHostProbeContext, "executable" | "prefixArgs" | "runCommand">): string[] | null {
    return parseOpenCodeModelCatalog(runCommand(executable, [...prefixArgs, "models"]));
  },
});

export const reviewHostAdapter = isolatedReviewHostAdapter;
