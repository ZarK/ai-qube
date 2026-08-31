import path from "node:path";

import { getAiuPackageRoot } from "./package_metadata.js";

export { getAiuPackageRoot, getAiuPackageVersion } from "./package_metadata.js";

export const AIU_PLUGIN_WRAPPER_RELATIVE_PATH = ".opencode/plugins/ai-umpire-continuation.ts";
export const AIU_OPENCODE_PACKAGE_MANIFEST_RELATIVE_PATH = ".opencode/package.json";

export interface AiuPackageAssetPaths {
  packageRoot: string;
  pluginWrapperRelativePath: string;
}

export function getAiuPackageAssetPaths(): AiuPackageAssetPaths {
  return {
    packageRoot: getAiuPackageRoot(),
    pluginWrapperRelativePath: AIU_PLUGIN_WRAPPER_RELATIVE_PATH,
  };
}
