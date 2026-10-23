import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { ToolRunner } from "../tool-runner.js";

const wrapperProbeTimeoutMs = 5_000;
const wrapperToolRunner = new ToolRunner();

interface JvmWrapper {
  path: string;
  version: string;
}

export async function findJvmWrapper(
  directory: string,
  root: string,
  tool: "Maven" | "Gradle",
): Promise<JvmWrapper | undefined> {
  const name =
    tool === "Maven"
      ? process.platform === "win32"
        ? "mvnw.cmd"
        : "mvnw"
      : process.platform === "win32"
        ? "gradlew.bat"
        : "gradlew";
  let current = path.resolve(directory);
  const resolvedRoot = path.resolve(root);
  const relativeDirectory = path.relative(resolvedRoot, current);
  const boundary =
    path.isAbsolute(relativeDirectory) ||
    relativeDirectory === ".." ||
    relativeDirectory.startsWith(`..${path.sep}`)
      ? current
      : resolvedRoot;
  while (true) {
    const wrapper = path.join(current, name);
    const version = await resolveWrapperVersion(wrapper, tool);
    if (version !== undefined) {
      return { path: wrapper, version };
    }
    if (current === boundary || path.dirname(current) === current) {
      return undefined;
    }
    current = path.dirname(current);
  }
}

async function resolveWrapperVersion(
  wrapper: string,
  tool: "Maven" | "Gradle",
): Promise<string | undefined> {
  try {
    const metadata = await stat(wrapper);
    if (!metadata.isFile() || metadata.size === 0) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  const propertiesVersion = await readWrapperPropertiesVersion(wrapper, tool);
  if (propertiesVersion !== undefined) {
    return propertiesVersion;
  }

  try {
    const result = await wrapperToolRunner.run(wrapper, ["--version"], {
      cwd: path.dirname(wrapper),
      signal: AbortSignal.timeout(wrapperProbeTimeoutMs),
    });
    if (result.exitCode !== 0) {
      return undefined;
    }
    return readReportedVersion(`${result.stdout}\n${result.stderr}`, tool);
  } catch {
    return undefined;
  }
}

async function readWrapperPropertiesVersion(
  wrapper: string,
  tool: "Maven" | "Gradle",
): Promise<string | undefined> {
  const properties =
    tool === "Maven"
      ? ".mvn/wrapper/maven-wrapper.properties"
      : "gradle/wrapper/gradle-wrapper.properties";
  try {
    const text = await readFile(path.join(path.dirname(wrapper), properties), "utf8");
    const value = /^distributionUrl\s*=\s*(\S+)\s*$/mu.exec(text)?.[1];
    if (value === undefined) {
      return undefined;
    }
    const distribution = new URL(value.replaceAll("\\:", ":"));
    const archivePattern =
      tool === "Maven"
        ? /\/apache-maven-([0-9]+(?:\.[0-9]+)+)-bin\.zip$/u
        : /\/gradle-([0-9]+(?:\.[0-9]+)+)-(?:bin|all)\.zip$/u;
    return archivePattern.exec(distribution.pathname)?.[1];
  } catch {
    return undefined;
  }
}

function readReportedVersion(output: string, tool: "Maven" | "Gradle"): string | undefined {
  const versionPattern =
    tool === "Maven"
      ? /^Apache Maven\s+[0-9]+(?:\.[0-9]+)+(?:\s|$)/iu
      : /^Gradle\s+[0-9]+(?:\.[0-9]+)+(?:\s|$)/iu;
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => versionPattern.test(line));
}
