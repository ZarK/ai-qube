import { chmod, copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { AIU_SCRIPT_FILE_NAMES, getAiuPackageAssetPaths } from "./assets.js";

export interface InstallAiUmpireOptions {
  force?: boolean;
  targetDir?: string;
}

export interface InstallAiUmpireResult {
  installed: string[];
  skipped: string[];
  targetDir: string;
}

export async function installAiUmpireIntoRepo(
  options: InstallAiUmpireOptions = {},
): Promise<InstallAiUmpireResult> {
  const targetDir = path.resolve(options.targetDir ?? process.cwd());
  const force = options.force ?? false;
  const installed: string[] = [];
  const skipped: string[] = [];
  const assets = getAiuPackageAssetPaths();

  await installTextAsset({
    content: buildPluginWrapperSource(),
    force,
    installed,
    mode: undefined,
    relativePath: assets.pluginWrapperRelativePath,
    skipped,
    targetDir,
  });

  await installCopiedAsset({
    force,
    installed,
    mode: undefined,
    relativePath: "queue-policy.json",
    skipped,
    sourcePath: assets.queuePolicyPath,
    targetDir,
  });

  for (const scriptFileName of AIU_SCRIPT_FILE_NAMES) {
    await installCopiedAsset({
      force,
      installed,
      mode: 0o755,
      relativePath: path.join("scripts", scriptFileName),
      skipped,
      sourcePath: path.join(assets.scriptsDir, scriptFileName),
      targetDir,
    });
  }

  return {
    installed,
    skipped,
    targetDir,
  };
}

function buildPluginWrapperSource(): string {
  return [
    'import AiUmpireContinuationPlugin from "@tjalve/aiu/opencode";',
    "",
    "export default AiUmpireContinuationPlugin;",
    "",
  ].join("\n");
}

async function installCopiedAsset(options: {
  force: boolean;
  installed: string[];
  mode?: number;
  relativePath: string;
  skipped: string[];
  sourcePath: string;
  targetDir: string;
}): Promise<void> {
  const destinationPath = path.join(options.targetDir, options.relativePath);
  if (!options.force && await pathExists(destinationPath)) {
    options.skipped.push(options.relativePath);
    return;
  }

  await mkdir(path.dirname(destinationPath), { recursive: true });
  await copyFile(options.sourcePath, destinationPath);
  if (options.mode !== undefined) {
    await chmod(destinationPath, options.mode);
  }
  options.installed.push(options.relativePath);
}

async function installTextAsset(options: {
  content: string;
  force: boolean;
  installed: string[];
  mode?: number;
  relativePath: string;
  skipped: string[];
  targetDir: string;
}): Promise<void> {
  const destinationPath = path.join(options.targetDir, options.relativePath);
  if (!options.force && await pathExists(destinationPath)) {
    options.skipped.push(options.relativePath);
    return;
  }

  await mkdir(path.dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, options.content, "utf8");
  if (options.mode !== undefined) {
    await chmod(destinationPath, options.mode);
  }
  options.installed.push(options.relativePath);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
