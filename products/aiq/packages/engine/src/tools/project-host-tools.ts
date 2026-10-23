import path from "node:path";

import type { StageId } from "../contracts.js";
import { resolveJavaScriptE2eRunner } from "../languages/javascript-e2e-runner.js";
import {
  collapseConfiguredJavaScriptE2eProjects,
  resolveJavaScriptE2eProjects,
} from "../languages/javascript-e2e.js";
import {
  isJavaScriptTestTaskFile,
  resolveJavaScriptProjects,
} from "../languages/javascript-projects.js";
import { createJavaScriptRunnerRuntime } from "../runner-runtimes.js";
import { findMatchingFiles } from "../runner-toolbox.js";
import { resolveNpmCommand } from "./binary-resolver.js";
import { createJavaScriptTestCommand } from "./node.js";

interface JavaScriptHostCommand {
  command: string;
  install: string;
  name: string;
  source: "external" | "project";
}

export async function resolveJavaScriptHostCommands(
  cwd: string,
  stages: readonly StageId[],
  ignoredDirectoryNames: ReadonlySet<string>,
): Promise<JavaScriptHostCommand[]> {
  if (!stages.some((stage) => stage === "unit" || stage === "coverage" || stage === "e2e")) {
    return [];
  }

  const files = await findMatchingFiles(cwd, isJavaScriptTestTaskFile, (directory) =>
    ignoredDirectoryNames.has(path.basename(directory)),
  );
  const commands = new Map<string, JavaScriptHostCommand>();
  if (stages.includes("unit") || stages.includes("coverage")) {
    const { projects } = await resolveJavaScriptProjects(undefined, files);
    for (const project of projects) {
      if (project.executionMode === "npm") {
        const command = createJavaScriptTestCommand({
          coverageDirectory: "",
          executionMode: project.executionMode,
          mode: stages.includes("coverage") ? "coverage" : "unit",
          reportPath: "",
          runner: project.runner,
        }).command;
        commands.set(command, createNpmRequirement(command));
      }
    }
  }

  if (stages.includes("e2e")) {
    const runtime = createJavaScriptRunnerRuntime(cwd, undefined);
    const { projects } = await resolveJavaScriptE2eProjects(undefined, files);
    for (const project of await collapseConfiguredJavaScriptE2eProjects(projects, runtime)) {
      const runner = await resolveJavaScriptE2eRunner(project, runtime);
      if (runner === undefined) {
        continue;
      }
      if (runner.command === resolveNpmCommand()) {
        commands.set(runner.command, createNpmRequirement(runner.command));
      } else {
        commands.set(runner.command, {
          command: runner.command,
          install: "Install the project's Playwright dependency to run its configured e2e tests.",
          name: `Playwright (${path.relative(cwd, project.projectRoot) || "."})`,
          source: "project",
        });
      }
    }
  }
  return [...commands.values()];
}

function createNpmRequirement(command: string): JavaScriptHostCommand {
  return {
    command,
    install: "Install npm with Node.js to run the project's configured test scripts.",
    name: "npm package manager",
    source: "external",
  };
}
