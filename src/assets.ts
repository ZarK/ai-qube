import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const AIU_PLUGIN_WRAPPER_RELATIVE_PATH = path.join(
  ".opencode",
  "plugins",
  "ai-umpire-continuation.ts",
);

export const AIU_SCRIPT_FILE_NAMES = [
  "_queue-policy.sh",
  "gh-ensure-labels.sh",
  "gh-issue-start.sh",
  "gh-priority-order.sh",
  "gh-update-labels.sh",
] as const;

export interface AiuPackageAssetPaths {
  packageRoot: string;
  pluginWrapperRelativePath: string;
  queuePolicyPath: string;
  scriptsDir: string;
  scriptFileNames: readonly string[];
}

export function getAiuPackageRoot(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, ".."),
    path.resolve(moduleDir, "..", ".."),
  ];

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "queue-policy.json")) && existsSync(path.join(candidate, "scripts"))) {
      return candidate;
    }
  }

  return candidates[0] ?? moduleDir;
}

export function getAiuPackageAssetPaths(): AiuPackageAssetPaths {
  return {
    packageRoot: getAiuPackageRoot(),
    pluginWrapperRelativePath: AIU_PLUGIN_WRAPPER_RELATIVE_PATH,
    queuePolicyPath: path.resolve(getAiuPackageRoot(), "queue-policy.json"),
    scriptFileNames: [...AIU_SCRIPT_FILE_NAMES],
    scriptsDir: path.resolve(getAiuPackageRoot(), "scripts"),
  };
}
