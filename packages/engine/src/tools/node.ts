import * as binaries from "./binary-resolver.js";
import * as commands from "./command-builders.js";

import type { JavaScriptTestExecutionMode, JavaScriptTestRunner } from "../utils/node-utils.js";

export function createTypeScriptTypecheckCommand(project: string): {
  args: string[];
  scriptPath: string;
} {
  return {
    args: commands.createTscArgs({ project }),
    scriptPath: binaries.resolvePackageBinaryPath("typescript/package.json", "bin/tsc"),
  };
}

export function createJavaScriptTestCommand(options: {
  coverageDirectory: string;
  executionMode: JavaScriptTestExecutionMode;
  mode: "coverage" | "unit";
  reportPath: string;
  runner: JavaScriptTestRunner;
}): {
  args: string[];
  command: string;
} {
  if (options.executionMode === "direct") {
    const runnerBinary = resolveJavaScriptRunnerBinary(options.runner);
    return {
      args: [runnerBinary, ...commands.createDirectJavaScriptTestArgs(options)],
      command: process.execPath,
    };
  }

  return {
    args: commands.createJavaScriptTestArgs(options),
    command: binaries.resolveNpmCommand(),
  };
}

function resolveJavaScriptRunnerBinary(runner: JavaScriptTestRunner): string {
  return runner === "vitest"
    ? binaries.resolvePackageBinaryPath("vitest/package.json", "vitest.mjs")
    : binaries.resolvePackageBinaryPath("jest/package.json", "bin/jest.js");
}
