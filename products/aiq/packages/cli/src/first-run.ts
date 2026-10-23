import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { OutputFormat } from "./types.js";

export interface FirstRunProjectInference {
  displayName: string;
  manifestPath: string;
}

export interface FirstRunManifestCollection {
  files: string[];
  truncated: boolean;
  warnings: string[];
}

export interface FirstRunSetupGuidance {
  cwd: string;
  examples: string[];
  markers: string[];
  remediation: string;
  summary: string;
}

const firstRunPrimaryMarkerNames = new Map<string, string>([
  ["Cargo.toml", "Rust"],
  ["build.gradle", "JVM"],
  ["build.gradle.kts", "JVM"],
  ["go.mod", "Go"],
  ["package.json", "JavaScript/Node"],
  ["pom.xml", "JVM"],
  ["pyproject.toml", "Python"],
  ["tsconfig.json", "TypeScript"],
]);

const firstRunPrimaryMarkerExtensions = new Map<string, string>([
  [".csproj", ".NET"],
  [".sln", ".NET"],
  [".slnx", ".NET"],
]);

export const firstRunSupportedMarkers = [
  ...firstRunPrimaryMarkerNames.keys(),
  "*.csproj",
  "*.sln",
  "*.slnx",
].sort((left, right) => left.localeCompare(right));

export async function inferFirstRunProjects(cwd: string): Promise<FirstRunProjectInference[]> {
  const entries = await readdir(cwd, { withFileTypes: true });
  const projects: FirstRunProjectInference[] = [];

  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile()) {
        return;
      }

      const directDisplayName = firstRunPrimaryMarkerNames.get(entry.name);
      const extensionDisplayName = firstRunPrimaryMarkerExtensions.get(
        path.extname(entry.name).toLowerCase(),
      );
      const displayName = directDisplayName ?? extensionDisplayName;
      if (displayName === undefined) {
        return;
      }

      const manifestPath = path.join(cwd, entry.name);
      if (!(await isReadableFile(manifestPath))) {
        return;
      }

      projects.push({ displayName, manifestPath });
    }),
  );

  return projects.sort((left, right) =>
    left.displayName === right.displayName
      ? left.manifestPath.localeCompare(right.manifestPath)
      : left.displayName.localeCompare(right.displayName),
  );
}

export function createFirstRunSetupGuidance(cwd: string): FirstRunSetupGuidance {
  return {
    cwd,
    examples: ["aiq run src/index.ts", "aiq config", "aiq doctor", "aiq --help"],
    markers: firstRunSupportedMarkers,
    remediation:
      "Run aiq from a project root with a supported marker, or pass explicit files with aiq run <files...>.",
    summary: "No supported project marker was found, so Quality cannot safely choose inputs.",
  };
}

export function formatFirstRunDetectedProjects(
  projects: readonly FirstRunProjectInference[],
  cwd: string,
): string[] {
  return projects.map(
    (project) => `${project.displayName} (${path.relative(cwd, project.manifestPath)})`,
  );
}

export function writeFirstRunJsonPrelude(format: OutputFormat): boolean {
  return format === "json";
}

async function isReadableFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}
