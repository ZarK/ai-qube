export {
  AiUmpireContinuationPlugin,
  default,
} from "../opencode/ai-umpire-continuation.js";
export type {
  ContinuationLogLevel,
  PluginContext,
  PluginHooks,
  WhipState,
  WhipTask,
} from "../opencode/ai-umpire-continuation.js";
export {
  AIU_PLUGIN_WRAPPER_RELATIVE_PATH,
  AIU_SCRIPT_FILE_NAMES,
  getAiuPackageAssetPaths,
  getAiuPackageRoot,
} from "./assets.js";
export {
  installAiUmpireIntoRepo,
} from "./installer.js";
export type {
  AiuPackageAssetPaths,
} from "./assets.js";
export type {
  InstallAiUmpireOptions,
  InstallAiUmpireResult,
} from "./installer.js";
