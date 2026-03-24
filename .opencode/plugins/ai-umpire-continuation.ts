import CoreAiUmpireContinuationPlugin, {
  type ContinuationLogLevel,
  type PluginContext,
} from "../../opencode/ai-umpire-continuation.ts";

const REPO_DEFAULT_IDLE_DELAY_MS = 45_000;
const REPO_DEFAULT_LOG_LEVEL: ContinuationLogLevel = "debug";

export async function AiUmpireContinuationPlugin(
  context: PluginContext,
) {
  return CoreAiUmpireContinuationPlugin({
    ...context,
    idleDelayMs: context.idleDelayMs ?? REPO_DEFAULT_IDLE_DELAY_MS,
    logLevel: context.logLevel ?? REPO_DEFAULT_LOG_LEVEL,
  });
}

export default AiUmpireContinuationPlugin;
