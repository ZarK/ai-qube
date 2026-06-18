import { stat } from "node:fs/promises";
import path from "node:path";

import * as binaries from "../tools/binary-resolver.js";
import * as commands from "../tools/command-builders.js";
import { findNearestPlaywrightConfig, playwrightConfigNames } from "../tools/native-config.js";
import { hasPackageDependency, readPackageJson } from "../utils/node-utils.js";
import type { JavaScriptRunnerRuntime } from "./contracts.js";
import type { JavaScriptE2eProject, JavaScriptE2eRunner } from "./javascript-projects.js";
import { readPackageScripts } from "./javascript-utils.js";

export async function resolveJavaScriptE2eRunner(
  project: JavaScriptE2eProject,
  runtime: JavaScriptRunnerRuntime,
): Promise<JavaScriptE2eRunner | undefined> {
  const packageJson = await readPackageJson(project.packageJsonPath);
  const script = selectE2eScript(packageJson);
  if (script !== undefined) {
    return {
      args: ["run", script.name, "--", ...script.extraArgs],
      command: binaries.resolveNpmCommand(),
      kind: script.kind,
      name:
        script.kind === "agent-browser"
          ? "agent-browser"
          : script.kind === "script"
            ? "e2e"
            : "playwright",
    };
  }

  if (!(await hasPlaywrightSignals(project, runtime, packageJson))) {
    return undefined;
  }

  const playwrightBinary = await resolveLocalPlaywrightBinary(project.projectRoot);
  if (playwrightBinary === undefined) {
    return {
      installMessage:
        "Playwright e2e is configured, but the local Playwright binary was not found in node_modules/.bin. Run aiq setup for required setup steps, then install this project's dependencies.",
      kind: "missing-playwright",
      name: "playwright",
    };
  }

  const configPath = await findNearestPlaywrightConfig(project.packageJsonPath);
  return {
    args: commands.createPlaywrightTestArgs(configPath === undefined ? {} : { configPath }),
    command: playwrightBinary,
    kind: "playwright",
    name: "playwright",
  };
}

function selectE2eScript(
  packageJson: Record<string, unknown>,
):
  | { extraArgs: string[]; kind: "agent-browser" | "playwright-script" | "script"; name: string }
  | undefined {
  const scripts = readPackageScripts(packageJson);
  const preferredNames = ["aiq:e2e", "test:e2e", "e2e", "audit:ui", "aiq:audit-ui"];
  for (const name of preferredNames) {
    const script = scripts.get(name)?.toLowerCase();
    if (script === undefined) {
      continue;
    }

    if (script.includes("agent-browser") || script.includes("manual-audit")) {
      return { extraArgs: [], kind: "agent-browser", name };
    }

    if (script.includes("playwright")) {
      return { extraArgs: ["--reporter=json"], kind: "playwright-script", name };
    }

    if (name === "aiq:e2e" || name === "test:e2e" || name === "e2e") {
      return { extraArgs: [], kind: "script", name };
    }
  }

  return undefined;
}

async function hasPlaywrightSignals(
  project: JavaScriptE2eProject,
  runtime: JavaScriptRunnerRuntime,
  packageJson: Record<string, unknown>,
): Promise<boolean> {
  return (
    hasPackageDependency(packageJson, "@playwright/test") ||
    hasPackageDependency(packageJson, "playwright") ||
    (await hasAnyProjectFile(project.projectRoot, playwrightConfigNames)) ||
    (await hasAnyPlaywrightSpec(project.projectRoot, runtime))
  );
}

async function hasAnyProjectFile(root: string, names: readonly string[]): Promise<boolean> {
  for (const name of names) {
    if (await fileExists(path.join(root, name))) {
      return true;
    }
  }

  return false;
}

async function hasAnyPlaywrightSpec(
  root: string,
  runtime: JavaScriptRunnerRuntime,
): Promise<boolean> {
  const files = await runtime.findMatchingFiles(
    root,
    (filePath) => isPlaywrightSpecFile(filePath),
    runtime.shouldSkipProjectDirectory,
  );
  return files.length > 0;
}

async function resolveLocalPlaywrightBinary(projectRoot: string): Promise<string | undefined> {
  const binName = process.platform === "win32" ? "playwright.cmd" : "playwright";
  const binaryPath = path.join(projectRoot, "node_modules", ".bin", binName);
  return (await fileExists(binaryPath)) ? binaryPath : undefined;
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stats = await stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

function isPlaywrightSpecFile(filePath: string): boolean {
  const name = path.basename(filePath).toLowerCase();
  return /\.(?:e2e|spec)\.[cm]?[jt]sx?$/u.test(name);
}
