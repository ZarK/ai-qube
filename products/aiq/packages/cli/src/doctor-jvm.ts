import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
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
  if (result.checks.some((check) => check.name === wrapper)) {
    return;
  }
  const version = await readWrapperVersion(wrapper, tool);
  result.checks.push({
    name: wrapper,
    detail: `${tool} project wrapper; ${version}`,
    ok: true,
    required: true,
    source: "project",
  });
}

async function findJvmWrapper(
  directory: string,
  root: string,
  tool: "Maven" | "Gradle",
): Promise<string | undefined> {
  const name =
    tool === "Maven"
      ? process.platform === "win32"
        ? "mvnw.cmd"
        : "mvnw"
      : process.platform === "win32"
        ? "gradlew.bat"
        : "gradlew";
  let current = directory;
  while (true) {
    const wrapper = path.join(current, name);
    try {
      await access(wrapper);
      return wrapper;
    } catch {
      if (current === root || path.dirname(current) === current) {
        return undefined;
      }
      current = path.dirname(current);
    }
  }
}

async function readWrapperVersion(wrapper: string, tool: "Maven" | "Gradle"): Promise<string> {
  const properties =
    tool === "Maven"
      ? ".mvn/wrapper/maven-wrapper.properties"
      : "gradle/wrapper/gradle-wrapper.properties";
  try {
    const text = await readFile(path.join(path.dirname(wrapper), properties), "utf8");
    return /(?:apache-maven|gradle)-([\d.]+)-/u.exec(text)?.[1] ?? "version unavailable";
  } catch {
    return "version unavailable";
  }
}
