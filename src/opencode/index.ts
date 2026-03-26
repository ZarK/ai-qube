import CoreAiUmpireContinuationPlugin, {
  type ContinuationLogLevel,
  type PluginContext,
  type PluginHooks,
} from "../../opencode/ai-umpire-continuation.js";

const REPO_DEFAULT_IDLE_DELAY_MS = 45_000;
const REPO_DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const REPO_DEFAULT_CONTINUATION_LOG_MAX_BYTES = 512 * 1024;
const REPO_DEFAULT_LOG_LEVEL: ContinuationLogLevel = "debug";

export async function AiUmpireContinuationPlugin(
  context: PluginContext,
): Promise<PluginHooks> {
  return CoreAiUmpireContinuationPlugin({
    ...context,
    commandTimeoutMs: context.commandTimeoutMs ?? REPO_DEFAULT_COMMAND_TIMEOUT_MS,
    continuationLogMaxBytes: context.continuationLogMaxBytes ?? REPO_DEFAULT_CONTINUATION_LOG_MAX_BYTES,
    idleDelayMs: context.idleDelayMs ?? REPO_DEFAULT_IDLE_DELAY_MS,
    logLevel: context.logLevel ?? REPO_DEFAULT_LOG_LEVEL,
  });
}

export type {
  ContinuationLogLevel,
  PluginContext,
  PluginHooks,
} from "../../opencode/ai-umpire-continuation.js";

export default AiUmpireContinuationPlugin;
