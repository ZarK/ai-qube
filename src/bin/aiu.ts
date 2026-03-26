#!/usr/bin/env node

import { stderr, stdout } from "node:process";

import { getAiuPackageAssetPaths } from "../assets.js";
import { installAiUmpireIntoRepo } from "../installer.js";

const helpText = `AI Umpire package CLI

Usage:
  aiu init [directory] [--force]
  aiu paths [--json]
  aiu --help
`;

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  const command = args[0];

  if (command === undefined || command === "--help" || command === "-h") {
    stdout.write(helpText);
    return 0;
  }

  if (command === "paths") {
    const jsonMode = args.includes("--json");
    const assetPaths = getAiuPackageAssetPaths();
    if (jsonMode) {
      stdout.write(`${JSON.stringify(assetPaths, null, 2)}\n`);
      return 0;
    }

    stdout.write(`packageRoot: ${assetPaths.packageRoot}\n`);
    stdout.write(`queuePolicyPath: ${assetPaths.queuePolicyPath}\n`);
    stdout.write(`scriptsDir: ${assetPaths.scriptsDir}\n`);
    stdout.write(`pluginWrapperRelativePath: ${assetPaths.pluginWrapperRelativePath}\n`);
    return 0;
  }

  if (command === "init") {
    const force = args.includes("--force");
    const targetDir = args.find((arg) => !arg.startsWith("--") && arg !== "init") ?? ".";
    const result = await installAiUmpireIntoRepo({ force, targetDir });
    stdout.write(`Initialized AI Umpire assets in ${result.targetDir}\n`);
    if (result.installed.length > 0) {
      stdout.write(`Installed:\n${result.installed.map((entry) => `- ${entry}`).join("\n")}\n`);
    }
    if (result.skipped.length > 0) {
      stdout.write(`Skipped existing:\n${result.skipped.map((entry) => `- ${entry}`).join("\n")}\n`);
    }
    return 0;
  }

  stderr.write(`Unknown command: ${command}\n`);
  stderr.write(helpText);
  return 2;
}

process.exitCode = await main(process.argv);
