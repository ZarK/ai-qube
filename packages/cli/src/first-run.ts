import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { defaultProjectScopeIgnoredDirectoryNames } from "./project-scope.js";
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

const firstRunSupportedFileExtensions = new Set([
  ".bash",
  ".bats",
  ".c",
  ".cjs",
  ".cs",
  ".csproj",
  ".css",
  ".cts",
  ".go",
  ".hcl",
  ".htm",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".kt",
  ".mjs",
  ".mts",
  ".ps1",
  ".psd1",
  ".psm1",
  ".py",
  ".pyi",
  ".rs",
  ".sh",
  ".sln",
  ".slnx",
  ".sql",
  ".tf",
  ".tfvars",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const firstRunMaxCollectedFiles = 500;

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

export async function collectFirstRunManifestFiles(
  cwd: string,
  projects: readonly FirstRunProjectInference[],
): Promise<FirstRunManifestCollection> {
  const files = new Set(projects.map((project) => path.relative(cwd, project.manifestPath)));
  const warnings: string[] = [];
  const truncated = await collectSupportedFiles(cwd, cwd, files, warnings);

  return {
    files: [...files]
      .filter((file) => file.length > 0)
      .sort((left, right) => left.localeCompare(right)),
    truncated,
    warnings,
  };
}

export function createFirstRunSetupGuidance(cwd: string): FirstRunSetupGuidance {
  return {
    cwd,
    examples: ["aiq run src/index.ts", "aiq config", "aiq doctor", "aiq --help"],
    markers: firstRunSupportedMarkers,
    remediation:
      "Run aiq from a project root with a supported marker, or pass explicit files with aiq run <files...>.",
    summary: "No supported project marker was found, so AIQ cannot safely choose inputs.",
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

async function collectSupportedFiles(
  root: string,
  directory: string,
  files: Set<string>,
  warnings: string[],
): Promise<boolean> {
  if (files.size >= firstRunMaxCollectedFiles) {
    return true;
  }

  let entries: Awaited<ReturnType<typeof readDirectoryEntries>>;
  try {
    entries = await readDirectoryEntries(directory);
  } catch (error) {
    warnings.push(
      `Skipped unreadable directory ${path.relative(root, directory) || "."}: ${formatTraversalError(error)}`,
    );
    return false;
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (files.size >= firstRunMaxCollectedFiles) {
      return true;
    }

    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!defaultProjectScopeIgnoredDirectoryNames.has(entry.name)) {
        const truncated = await collectSupportedFiles(root, entryPath, files, warnings);
        if (truncated) {
          return true;
        }
      }
      continue;
    }

    if (!entry.isFile() || !isFirstRunSupportedInputFile(entry.name)) {
      continue;
    }

    files.add(path.relative(root, entryPath));
  }

  return false;
}

function isFirstRunSupportedInputFile(fileName: string): boolean {
  return (
    firstRunPrimaryMarkerNames.has(fileName) ||
    firstRunPrimaryMarkerExtensions.has(path.extname(fileName).toLowerCase()) ||
    firstRunSupportedFileExtensions.has(path.extname(fileName).toLowerCase())
  );
}

async function readDirectoryEntries(directory: string) {
  return readdir(directory, { withFileTypes: true });
}

function formatTraversalError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function isReadableFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}
