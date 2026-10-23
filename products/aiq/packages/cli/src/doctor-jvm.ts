import { readdir } from "node:fs/promises";
import path from "node:path";
import { findJvmWrapper } from "@tjalve/aiq/engine";
import type { StageId } from "@tjalve/aiq/model";
import type { DoctorPrerequisite } from "./doctor-tools.js";
import type { DoctorCheckOutput } from "./output.js";
import { defaultProjectScopeIgnoredDirectoryNames } from "./project-scope.js";

export async function detectJvmBuildTools(
  cwd: string,
  stages: readonly StageId[],
): Promise<{ checks: DoctorCheckOutput[]; requirements: DoctorPrerequisite[] }> {
  const result = { checks: [] as DoctorCheckOutput[], requirements: [] as DoctorPrerequisite[] };
  if (
    !stages.some((stage) => ["lint", "format", "typecheck", "unit", "coverage"].includes(stage))
  ) {
    return result;
  }
  await collectJvmBuildTools(cwd, cwd, result);
  return result;
}

async function collectJvmBuildTools(
  directory: string,
  root: string,
  result: { checks: DoctorCheckOutput[]; requirements: DoctorPrerequisite[] },
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = new Set(entries.map((entry) => entry.name));
  for (const [marker, tool] of [
    ["pom.xml", "Maven"],
    ["build.gradle", "Gradle"],
    ["build.gradle.kts", "Gradle"],
  ] as const) {
    if (names.has(marker)) {
      await addJvmBuildTool(tool, directory, root, result);
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !defaultProjectScopeIgnoredDirectoryNames.has(entry.name)) {
      await collectJvmBuildTools(path.join(directory, entry.name), root, result);
    }
  }
}

async function addJvmBuildTool(
  tool: "Maven" | "Gradle",
  directory: string,
  root: string,
  result: { checks: DoctorCheckOutput[]; requirements: DoctorPrerequisite[] },
): Promise<void> {
  const wrapper = await findJvmWrapper(directory, root, tool);
  if (wrapper === undefined) {
    if (!result.requirements.some((requirement) => requirement.name === tool)) {
      result.requirements.push({
        binaries: [tool === "Maven" ? "mvn" : "gradle"],
        install: `Install ${tool} on PATH or provide a project wrapper.`,
        name: tool,
        required: true,
      });
    }
    return;
  }
  if (result.checks.some((check) => check.name === wrapper.path)) {
    return;
  }
  result.checks.push({
    name: wrapper.path,
    detail: `${tool} project wrapper; ${wrapper.version}`,
    ok: true,
    required: true,
    source: "project",
  });
}
