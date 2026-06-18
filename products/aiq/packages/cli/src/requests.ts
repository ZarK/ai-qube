import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  type AiqProfileName,
  type AiqSurfaceId,
  loadAiqProgress,
  resolveAiqConfig,
  resolveAiqProgressStageIds,
} from "@tjalve/aiq/config";
import { resolveRunRequest } from "@tjalve/aiq/engine";
import type { FileManifestInput, RunContext, RunRequest, StageId } from "@tjalve/aiq/model";

import { isErrorCode, readStdin, splitLines } from "./shared.js";
import type { CliIo, ParsedArgs } from "./types.js";

const execFileAsync = promisify(execFile);

const diffOnlySafeStages = new Set<StageId>([
  "lint",
  "format",
  "sloc",
  "complexity",
  "maintainability",
]);

export interface RunRequestOptions {
  context: RunContext;
  includeProgressStage?: boolean;
  mode: RunRequest["mode"];
  surface: AiqSurfaceId;
}

export interface ResolveCliConfigOptions {
  includeProgressStage?: boolean;
  profileOverride?: AiqProfileName;
  stageOverrides?: StageId[];
  surface: AiqSurfaceId;
}

export async function createManifestInput(
  parsed: ParsedArgs,
  io: CliIo,
  cachedStreamFiles?: string[],
): Promise<FileManifestInput> {
  const manifestFiles = [...parsed.files];
  const sources = new Set<FileManifestInput["source"]>();

  if (parsed.files.length > 0) {
    sources.add("direct");
  }

  if (parsed.filesFrom !== undefined) {
    manifestFiles.push(...(await readFilesFromList(parsed.filesFrom, io.cwd)));
    sources.add("file-list");
  }

  if (parsed.stdinFileList) {
    manifestFiles.push(...(cachedStreamFiles ?? splitLines(await readStdin(io.stdin))));
    sources.add("stream");
  }

  if (manifestFiles.length === 0) {
    throw new Error(createMissingManifestMessage(parsed.command));
  }

  if (
    (parsed.command === "run" || parsed.command === "check") &&
    manifestFiles.some((file) => resolvesToProjectRoot(file, io.cwd))
  ) {
    throw new Error(
      `Use aiq for the configured project gate. Use aiq ${parsed.command} <paths...> only when you want explicit file or subtree targets.`,
    );
  }

  return {
    files: manifestFiles,
    source: resolveManifestSource(sources),
  };
}

async function readFilesFromList(filesFrom: string, cwd: string): Promise<string[]> {
  try {
    return splitLines(await readFile(path.resolve(cwd, filesFrom), "utf8"));
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      throw new Error(
        `File list not found: ${filesFrom}. Check the path or pass files directly with aiq run <paths...>.`,
        { cause: error },
      );
    }

    throw error;
  }
}

function resolvesToProjectRoot(file: string, cwd: string): boolean {
  const resolvedFile = path.resolve(cwd, file);
  const resolvedCwd = path.resolve(cwd);
  return resolvedFile === resolvedCwd;
}

function createMissingManifestMessage(command: ParsedArgs["command"]): string {
  if (command === "run") {
    return "aiq run requires explicit files or paths. Use aiq for the configured project gate, or pass targets such as aiq run src/index.ts.";
  }

  if (command === "check") {
    return "aiq check requires explicit files or paths. Use aiq for the configured project gate, or pass targets such as aiq check src/index.ts.";
  }

  return "At least one input file is required.";
}

export async function resolveCliConfig(
  parsed: ParsedArgs,
  io: CliIo,
  options: ResolveCliConfigOptions,
): Promise<Awaited<ReturnType<typeof resolveAiqConfig>>> {
  const progressStageOverrides = await resolveProgressStageOverrides(parsed, io, options);
  return resolveAiqConfig({
    cwd: io.cwd,
    ...(options.stageOverrides === undefined
      ? parsed.stages.length > 0
        ? { stages: parsed.stages }
        : progressStageOverrides === undefined
          ? {}
          : { stages: progressStageOverrides }
      : { stages: options.stageOverrides }),
    ...(options.profileOverride === undefined
      ? parsed.profile === undefined
        ? {}
        : { profile: parsed.profile }
      : { profile: options.profileOverride }),
    surface: options.surface,
  });
}

export async function createRunRequest(
  parsed: ParsedArgs,
  io: CliIo,
  options: RunRequestOptions,
): Promise<RunRequest> {
  const manifest = await createManifestInput(parsed, io);
  const resolvedConfig = await resolveCliConfig(parsed, io, {
    ...(options.includeProgressStage === undefined
      ? {}
      : { includeProgressStage: options.includeProgressStage }),
    surface: options.surface,
  });
  const requestManifest =
    parsed.diffOnly && hasDiffOnlyFullRunStages(resolvedConfig.stages)
      ? {
          files: await collectGitWorkspaceFiles(io.cwd, manifest.files),
          source: manifest.source,
        }
      : manifest;

  const request: RunRequest = {
    context: options.context,
    cwd: resolvedConfig.cwd,
    manifest: requestManifest,
    mode: options.mode,
    stages: resolvedConfig.stages,
    diffOnly: parsed.diffOnly,
    ...(parsed.diffOnly ? { diffOnlyFiles: manifest.files } : {}),
    ...(resolvedConfig.stageConfigurations === undefined
      ? {}
      : { stageConfigurations: resolvedConfig.stageConfigurations }),
    profile: resolvedConfig.profile,
    writeArtifacts: true,
  };

  if (parsed.outDir !== undefined) {
    request.outDir = parsed.outDir;
  }

  await resolveRunRequest(request);
  return request;
}

function hasDiffOnlyFullRunStages(stages: readonly StageId[]): boolean {
  return stages.some((stage) => !diffOnlySafeStages.has(stage));
}

async function collectGitWorkspaceFiles(
  cwd: string,
  changedFiles: readonly string[],
): Promise<string[]> {
  const root = path.resolve(cwd);
  let files: string[];

  try {
    const result = await execFileAsync(
      "git",
      ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      {
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    files = result.stdout
      .split("\0")
      .filter((file) => file.length > 0)
      .map((file) => path.resolve(root, file));
  } catch (error) {
    throw new Error(
      "--diff-only full-run stages require Git workspace enumeration. Run this command inside a Git work tree or omit full-run stages: e2e, typecheck, unit, coverage, security.",
      { cause: error },
    );
  }

  for (const file of changedFiles) {
    files.push(path.resolve(root, file));
  }
  const uniqueFiles = [...new Set(files)].sort((left, right) => left.localeCompare(right));
  if (uniqueFiles.length === 0) {
    throw new Error("No workspace files were found for --diff-only full-stage planning.");
  }

  return uniqueFiles;
}

async function resolveProgressStageOverrides(
  parsed: ParsedArgs,
  io: CliIo,
  options: ResolveCliConfigOptions,
): Promise<StageId[] | undefined> {
  if (
    !options.includeProgressStage ||
    options.stageOverrides !== undefined ||
    parsed.stages.length > 0 ||
    parsed.profile !== undefined ||
    options.profileOverride !== undefined
  ) {
    return undefined;
  }

  const progress = await loadAiqProgress(io.cwd);
  if (progress.source !== "file") {
    return undefined;
  }

  return resolveAiqProgressStageIds(progress.progress.current_stage);
}

function resolveManifestSource(
  sources: Set<FileManifestInput["source"]>,
): FileManifestInput["source"] {
  if (sources.size === 1) {
    const [source] = [...sources];
    if (source !== undefined) {
      return source;
    }
  }

  return "mixed";
}
