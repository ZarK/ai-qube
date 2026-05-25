import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import {
  type AiqProfileName,
  type AiqProgressRunSelection,
  createAiqProgressRunSelection,
  loadAiqProgress,
  resolveAiqConfig,
  resolveAiqProgressStageIds,
} from "@tjalve/aiq-config-schema";
import { AiqEngineCancelledError, runEngine } from "@tjalve/aiq-engine";
import type { RunRequest, RunResult, RunStageConfigurations, StageId } from "@tjalve/aiq-model";

const execFileAsync = promisify(execFile);

export const defaultGitDiffFilter = "ACMRT";

export interface ListStagedFilesOptions {
  cwd: string;
  diffFilter?: string;
  gitBinary?: string;
  signal?: AbortSignal;
}

export type ListStagedFilesImpl = (options: ListStagedFilesOptions) => Promise<string[]>;

export interface AiqHookAdapterOptions {
  cwd?: string;
  diffFilter?: string;
  gitBinary?: string;
  listStagedFilesImpl?: ListStagedFilesImpl;
  stages?: readonly StageId[];
  profile?: AiqProfileName;
  resolveConfigImpl?: typeof resolveAiqConfig;
  runEngineImpl?: typeof runEngine;
  writeArtifacts?: boolean;
}

export interface AiqHookRunOptions {
  signal?: AbortSignal;
}

export interface AiqHookRunResult {
  exitCode: 0 | 1;
  ok: boolean;
  result?: RunResult;
  skipped: boolean;
  stagedFiles: string[];
  workflow?: AiqProgressRunSelection;
}

interface ResolvedHookSelection {
  cwd: string;
  stages: StageId[];
  stageConfigurations?: RunStageConfigurations;
  profile: AiqProfileName;
  workflow?: AiqProgressRunSelection;
}

export class AiqHookCancelledError extends Error {
  constructor(message = "AIQ hook run cancelled.") {
    super(message);
    this.name = "AiqHookCancelledError";
  }
}

export class AiqHookAdapter {
  private readonly cwd: string;

  private readonly diffFilter: string;

  private readonly gitBinary: string;

  private readonly listStagedFilesImpl: ListStagedFilesImpl;

  private readonly stages: readonly StageId[] | undefined;

  private readonly profile: AiqProfileName | undefined;

  private readonly resolveConfigImpl: typeof resolveAiqConfig;

  private readonly runEngineImpl: typeof runEngine;

  private readonly writeArtifacts: boolean;

  constructor(options: AiqHookAdapterOptions = {}) {
    this.cwd = path.resolve(options.cwd ?? process.cwd());
    this.diffFilter = options.diffFilter ?? defaultGitDiffFilter;
    this.gitBinary = options.gitBinary ?? "git";
    this.listStagedFilesImpl = options.listStagedFilesImpl ?? listStagedFiles;
    this.stages = options.stages;
    this.profile = options.profile;
    this.resolveConfigImpl = options.resolveConfigImpl ?? resolveAiqConfig;
    this.runEngineImpl = options.runEngineImpl ?? runEngine;
    this.writeArtifacts = options.writeArtifacts ?? true;
  }

  async run(options: AiqHookRunOptions = {}): Promise<AiqHookRunResult> {
    try {
      throwIfCancelled(options.signal);
      const stagedFiles = await this.listStagedFilesImpl({
        cwd: this.cwd,
        diffFilter: this.diffFilter,
        gitBinary: this.gitBinary,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });

      if (stagedFiles.length === 0) {
        return {
          exitCode: 0,
          ok: true,
          skipped: true,
          stagedFiles,
        };
      }

      const selection = await this.resolveSelection();
      const request: RunRequest = {
        context: "hook",
        cwd: selection.cwd,
        manifest: {
          files: stagedFiles,
          source: "direct",
        },
        mode: "check",
        stages: selection.stages,
        ...(selection.stageConfigurations === undefined
          ? {}
          : { stageConfigurations: selection.stageConfigurations }),
        profile: selection.profile,
        writeArtifacts: this.writeArtifacts,
      };

      if (options.signal !== undefined) {
        request.signal = options.signal;
      }

      const result = await this.runEngineImpl(request);
      return {
        exitCode: result.ok ? 0 : 1,
        ok: result.ok,
        result,
        skipped: false,
        stagedFiles,
        ...(selection.workflow === undefined ? {} : { workflow: selection.workflow }),
      };
    } catch (error) {
      if (isCancellationError(error)) {
        throw error instanceof AiqHookCancelledError ? error : new AiqHookCancelledError();
      }

      throw error;
    }
  }

  private async resolveSelection(): Promise<ResolvedHookSelection> {
    const progress =
      this.stages === undefined && this.profile === undefined
        ? await loadFileBackedProgress(this.cwd)
        : undefined;
    const resolved = await this.resolveConfigImpl({
      cwd: this.cwd,
      ...(this.stages === undefined
        ? progress === undefined
          ? {}
          : { stages: resolveAiqProgressStageIds(progress.progress.current_stage) }
        : { stages: [...this.stages] }),
      ...(this.profile === undefined ? {} : { profile: this.profile }),
      surface: "hook",
    });

    return {
      cwd: resolved.cwd,
      stages: [...resolved.stages] as StageId[],
      ...(resolved.stageConfigurations === undefined
        ? {}
        : { stageConfigurations: resolved.stageConfigurations }),
      profile: resolved.profile,
      ...(progress === undefined
        ? {}
        : { workflow: createAiqProgressRunSelection(progress, resolved.stages) }),
    };
  }
}

export function createAiqHookAdapter(options?: AiqHookAdapterOptions): AiqHookAdapter {
  return new AiqHookAdapter(options);
}

export async function runAiqHook(
  options: AiqHookAdapterOptions & AiqHookRunOptions = {},
): Promise<AiqHookRunResult> {
  const { signal, ...adapterOptions } = options;
  return createAiqHookAdapter(adapterOptions).run(signal === undefined ? {} : { signal });
}

export async function listStagedFiles(options: ListStagedFilesOptions): Promise<string[]> {
  const cwd = path.resolve(options.cwd);
  throwIfCancelled(options.signal);

  const execOptions: {
    cwd: string;
    encoding: "utf8";
    maxBuffer: number;
    signal?: AbortSignal;
  } = {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  };

  if (options.signal !== undefined) {
    execOptions.signal = options.signal;
  }

  try {
    const { stdout } = await execFileAsync(
      options.gitBinary ?? "git",
      [
        "diff",
        "--cached",
        "--name-only",
        `--diff-filter=${options.diffFilter ?? defaultGitDiffFilter}`,
        "-z",
      ],
      execOptions,
    );

    throwIfCancelled(options.signal);
    return splitNullSeparated(stdout).map((file) => path.resolve(cwd, file));
  } catch (error) {
    if (isAbortError(error)) {
      throw new AiqHookCancelledError();
    }

    throw error;
  }
}

export function renderPreCommitHookScript(): string {
  return [
    "#!/usr/bin/env sh",
    "set -eu",
    'repo_root="$(git rev-parse --show-toplevel)"',
    'if [ -x "$repo_root/node_modules/.bin/aiq-hook" ]; then',
    '  exec "$repo_root/node_modules/.bin/aiq-hook" "$@"',
    "fi",
    "printf '%s\\n' \"aiq-hook is not installed in $repo_root/node_modules/.bin.\" >&2",
    "exit 1",
    "",
  ].join("\n");
}

function splitNullSeparated(value: string): string[] {
  return value.split("\0").filter((entry) => entry.length > 0);
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new AiqHookCancelledError();
  }
}

function isCancellationError(error: unknown): boolean {
  return error instanceof AiqHookCancelledError || error instanceof AiqEngineCancelledError;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function loadFileBackedProgress(cwd: string) {
  const progress = await loadAiqProgress(cwd);
  return progress.source === "file" ? progress : undefined;
}
