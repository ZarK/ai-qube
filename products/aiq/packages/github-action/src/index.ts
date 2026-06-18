import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  type AiqProfileName,
  type AiqProgressRunSelection,
  type GitHubAnnotation,
  type RunRequest,
  type RunResult,
  type RunStageConfigurations,
  type StageId,
  collectGitHubAnnotations,
  createAiqProgressRunSelection,
  formatRunResultAsText,
  loadAiqProgress,
  resolveAiqConfig,
  resolveAiqProgressStageIds,
  runEngine,
  stageIds,
} from "@tjalve/aiq/api";

const execFileAsync = promisify(execFile);

export interface GitHubArtifactUploadResult {
  id?: number;
  size?: number;
}

export interface GitHubActionIo {
  emitAnnotation(annotation: GitHubAnnotation): void;
  info(message: string): void;
  setFailed(message: string): void;
  setOutput(name: string, value: string | number | boolean): void;
  uploadArtifact?(
    name: string,
    files: string[],
    rootDirectory: string,
  ): Promise<GitHubArtifactUploadResult>;
}

export interface ListTrackedFilesOptions {
  cwd: string;
  gitBinary?: string;
  signal?: AbortSignal;
}

export type ListTrackedFilesImpl = (options: ListTrackedFilesOptions) => Promise<string[]>;

export type ReadTextFileImpl = (filePath: string, encoding: BufferEncoding) => Promise<string>;

export interface AiqGitHubActionAdapterOptions {
  cwd?: string;
  gitBinary?: string;
  listTrackedFilesImpl?: ListTrackedFilesImpl;
  readFileImpl?: ReadTextFileImpl;
  resolveConfigImpl?: typeof resolveAiqConfig;
  runEngineImpl?: typeof runEngine;
}

export interface AiqGitHubActionRunOptions {
  annotate?: boolean;
  artifactName?: string;
  cwd?: string;
  files?: readonly string[];
  filesFrom?: string;
  maxAnnotations?: number;
  outDir?: string;
  stages?: readonly StageId[];
  profile?: AiqProfileName;
  signal?: AbortSignal;
  uploadArtifact?: boolean;
}

export interface AiqGitHubActionExecutionResult {
  annotations: GitHubAnnotation[];
  artifactPaths: string[];
  files: string[];
  report?: RunResult;
  workflow?: AiqProgressRunSelection;
  skipped: boolean;
}

export interface AiqGitHubActionOutcome extends AiqGitHubActionExecutionResult {
  upload?: GitHubArtifactUploadResult;
}

interface ResolvedGitHubSelection {
  cwd: string;
  stages: StageId[];
  stageConfigurations?: RunStageConfigurations;
  profile: AiqProfileName;
  workflow?: AiqProgressRunSelection;
  publishDiagnostics: boolean;
}

interface ResolvedGitHubActionAdapterDependencies {
  cwd: string;
  gitBinary: string;
  listTrackedFilesImpl: ListTrackedFilesImpl;
  readFileImpl: ReadTextFileImpl;
  resolveConfigImpl: typeof resolveAiqConfig;
  runEngineImpl: typeof runEngine;
}

export class AiqGitHubActionAdapter {
  private readonly cwd: string;

  private readonly gitBinary: string;

  private readonly listTrackedFilesImpl: ListTrackedFilesImpl;

  private readonly readFileImpl: ReadTextFileImpl;

  private readonly resolveConfigImpl: typeof resolveAiqConfig;

  private readonly runEngineImpl: typeof runEngine;

  constructor(options: AiqGitHubActionAdapterOptions = {}) {
    const dependencies = resolveGitHubActionAdapterDependencies(options);
    this.cwd = dependencies.cwd;
    this.gitBinary = dependencies.gitBinary;
    this.listTrackedFilesImpl = dependencies.listTrackedFilesImpl;
    this.readFileImpl = dependencies.readFileImpl;
    this.resolveConfigImpl = dependencies.resolveConfigImpl;
    this.runEngineImpl = dependencies.runEngineImpl;
  }

  async run(options: AiqGitHubActionRunOptions = {}): Promise<AiqGitHubActionExecutionResult> {
    const cwd = path.resolve(options.cwd ?? this.cwd);
    const files = await this.resolveFiles(cwd, options);

    if (files.length === 0) {
      return {
        annotations: [],
        artifactPaths: [],
        files,
        skipped: true,
      };
    }

    const selection = await this.resolveSelection(cwd, options);
    const request: RunRequest = {
      context: "github",
      cwd: selection.cwd,
      manifest: {
        files,
        source: "direct",
      },
      mode: "check",
      stages: selection.stages,
      ...(selection.stageConfigurations === undefined
        ? {}
        : { stageConfigurations: selection.stageConfigurations }),
      profile: selection.profile,
      writeArtifacts: true,
    };

    if (options.outDir !== undefined) {
      request.outDir = options.outDir;
    }
    if (options.signal !== undefined) {
      request.signal = options.signal;
    }

    const result = await this.runEngineImpl(request);
    const reportPath = result.artifacts.reportPath;
    if (reportPath === undefined) {
      throw new Error("AIQ GitHub Action requires a canonical report artifact.");
    }

    const report = await readRunResultArtifact(reportPath, this.readFileImpl);
    const annotations =
      selection.publishDiagnostics && options.annotate !== false
        ? collectGitHubAnnotations(report, {
            workspaceRoot: selection.cwd,
            ...(options.maxAnnotations === undefined
              ? {}
              : { maxAnnotations: options.maxAnnotations }),
          })
        : [];

    return {
      annotations,
      artifactPaths: [result.artifacts.planPath, result.artifacts.reportPath].filter(
        (artifactPath): artifactPath is string => artifactPath !== undefined,
      ),
      files,
      report,
      ...(selection.workflow === undefined ? {} : { workflow: selection.workflow }),
      skipped: false,
    };
  }

  private async resolveFiles(cwd: string, options: AiqGitHubActionRunOptions): Promise<string[]> {
    const inputFiles = options.files === undefined ? [] : options.files.map((file) => file.trim());
    if (inputFiles.some((file) => file.length > 0)) {
      return normalizeFileList(cwd, inputFiles);
    }

    if (options.filesFrom !== undefined) {
      const fileList = await this.readFileImpl(path.resolve(cwd, options.filesFrom), "utf8");
      return normalizeFileList(cwd, splitLines(fileList));
    }

    return this.listTrackedFilesImpl({
      cwd,
      gitBinary: this.gitBinary,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  private async resolveSelection(
    cwd: string,
    options: AiqGitHubActionRunOptions,
  ): Promise<ResolvedGitHubSelection> {
    const progress =
      options.stages === undefined && options.profile === undefined
        ? await loadFileBackedProgress(cwd)
        : undefined;
    const resolved = await this.resolveConfigImpl({
      cwd,
      ...(options.stages === undefined
        ? progress === undefined
          ? {}
          : { stages: resolveAiqProgressStageIds(progress.progress.current_stage) }
        : { stages: [...options.stages] }),
      ...(options.profile === undefined ? {} : { profile: options.profile }),
      surface: "github",
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
      publishDiagnostics: resolved.publishDiagnostics,
    };
  }
}

export function createAiqGitHubActionAdapter(
  options?: AiqGitHubActionAdapterOptions,
): AiqGitHubActionAdapter {
  return new AiqGitHubActionAdapter(options);
}

function resolveGitHubActionAdapterDependencies(
  options: AiqGitHubActionAdapterOptions,
): ResolvedGitHubActionAdapterDependencies {
  return {
    cwd: path.resolve(withDefault(options.cwd, process.cwd())),
    gitBinary: withDefault(options.gitBinary, "git"),
    listTrackedFilesImpl: withDefault(options.listTrackedFilesImpl, listTrackedFiles),
    readFileImpl: withDefault(options.readFileImpl, readFile),
    resolveConfigImpl: withDefault(options.resolveConfigImpl, resolveAiqConfig),
    runEngineImpl: withDefault(options.runEngineImpl, runEngine),
  };
}

function withDefault<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

export async function runAiqGitHubAction(
  io: GitHubActionIo,
  options: AiqGitHubActionRunOptions = {},
  adapterOptions?: AiqGitHubActionAdapterOptions,
): Promise<AiqGitHubActionOutcome> {
  const adapter = createAiqGitHubActionAdapter(adapterOptions);
  const outcome = await adapter.run(options);

  if (outcome.skipped || outcome.report === undefined) {
    return reportSkippedGitHubAction(io, outcome);
  }

  const reportedOutcome: AiqGitHubActionExecutionResult & { report: RunResult } = {
    ...outcome,
    report: outcome.report,
  };
  for (const annotation of outcome.annotations) {
    io.emitAnnotation(annotation);
  }

  const upload = await uploadGitHubActionArtifacts(io, options, reportedOutcome);
  io.info(formatRunResultAsText(reportedOutcome.report).trimEnd());
  setGitHubActionOutputs(io, reportedOutcome, upload);
  reportGitHubActionFailure(io, reportedOutcome.report);

  return upload === undefined ? outcome : { ...outcome, upload };
}

function reportSkippedGitHubAction(
  io: GitHubActionIo,
  outcome: AiqGitHubActionExecutionResult,
): AiqGitHubActionExecutionResult {
  io.info("AIQ GitHub Action skipped: no files were selected.");
  io.setOutput("ok", true);
  io.setOutput("status", "skipped");
  io.setOutput("diagnostic-count", 0);
  io.setOutput("annotation-count", 0);
  return outcome;
}

async function uploadGitHubActionArtifacts(
  io: GitHubActionIo,
  options: AiqGitHubActionRunOptions,
  outcome: AiqGitHubActionExecutionResult & { report: RunResult },
): Promise<GitHubArtifactUploadResult | undefined> {
  if (!shouldUploadGitHubActionArtifact(io, options, outcome)) {
    return undefined;
  }

  const uploadArtifact = io.uploadArtifact;
  if (uploadArtifact === undefined) {
    return undefined;
  }

  return uploadArtifact.call(
    io,
    options.artifactName ?? "aiq-report",
    outcome.artifactPaths,
    outcome.report.artifacts.outDir,
  );
}

function shouldUploadGitHubActionArtifact(
  io: GitHubActionIo,
  options: AiqGitHubActionRunOptions,
  outcome: AiqGitHubActionExecutionResult,
): boolean {
  return (
    (options.uploadArtifact ?? true) &&
    io.uploadArtifact !== undefined &&
    outcome.artifactPaths.length > 0
  );
}

function setGitHubActionOutputs(
  io: GitHubActionIo,
  outcome: AiqGitHubActionExecutionResult & { report: RunResult },
  upload: GitHubArtifactUploadResult | undefined,
): void {
  setGitHubActionReportOutputs(io, outcome);
  setGitHubActionWorkflowOutputs(io, outcome);
  setGitHubActionArtifactOutputs(io, upload);
}

function setGitHubActionReportOutputs(
  io: GitHubActionIo,
  outcome: AiqGitHubActionExecutionResult & { report: RunResult },
): void {
  io.setOutput("ok", outcome.report.ok);
  io.setOutput("status", outcome.report.summary.status);
  io.setOutput("diagnostic-count", outcome.report.summary.diagnosticCount);
  io.setOutput("annotation-count", outcome.annotations.length);
  io.setOutput("report-path", outcome.report.artifacts.reportPath ?? "");
  io.setOutput("plan-path", outcome.report.artifacts.planPath ?? "");
  io.setOutput(
    "stages",
    (outcome.workflow?.selectedStages ?? outcome.report.request.selection.stages).join(","),
  );
}

function setGitHubActionWorkflowOutputs(
  io: GitHubActionIo,
  outcome: AiqGitHubActionExecutionResult,
): void {
  if (outcome.workflow === undefined) {
    return;
  }

  io.setOutput("current-stage", outcome.workflow.currentStage.index);
  io.setOutput("current-stage-name", outcome.workflow.currentStage.id);
  io.setOutput("progress-path", outcome.workflow.progressPath);
}

function setGitHubActionArtifactOutputs(
  io: GitHubActionIo,
  upload: GitHubArtifactUploadResult | undefined,
): void {
  if (upload?.id !== undefined) {
    io.setOutput("artifact-id", upload.id);
  }
  if (upload?.size !== undefined) {
    io.setOutput("artifact-size", upload.size);
  }
}

function reportGitHubActionFailure(io: GitHubActionIo, report: RunResult): void {
  if (report.ok) {
    return;
  }

  io.setFailed(
    `AIQ reported ${report.summary.diagnosticCount} diagnostic${report.summary.diagnosticCount === 1 ? "" : "s"} with status ${report.summary.status}.`,
  );
}

export async function listTrackedFiles(options: ListTrackedFilesOptions): Promise<string[]> {
  const cwd = path.resolve(options.cwd);
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

  const { stdout } = await execFileAsync(
    options.gitBinary ?? "git",
    ["ls-files", "-z"],
    execOptions,
  );
  return normalizeFileList(cwd, stdout.split("\0"));
}

export function parseGitHubActionStageInput(values: readonly string[]): StageId[] {
  const unique = new Set<StageId>();
  const stages: StageId[] = [];

  for (const value of values.map((entry) => entry.trim()).filter((entry) => entry.length > 0)) {
    if (!stageIds.includes(value as StageId)) {
      throw new Error(`Unsupported stage: ${value}`);
    }

    const stage = value as StageId;
    if (!unique.has(stage)) {
      unique.add(stage);
      stages.push(stage);
    }
  }

  return stages;
}

export function parsePositiveInteger(value: string | undefined, label: string): number | undefined {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0) {
    return undefined;
  }

  if (!/^\d+$/u.test(normalized)) {
    throw new Error(`${label} must be a non-negative integer.`);
  }

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }

  return parsed;
}

async function readRunResultArtifact(
  reportPath: string,
  readFileImpl: ReadTextFileImpl,
): Promise<RunResult> {
  const report = JSON.parse(await readFileImpl(reportPath, "utf8")) as Partial<RunResult>;
  if (report.artifactType !== "report") {
    throw new Error(`Expected a report artifact at ${reportPath}.`);
  }

  return report as RunResult;
}

function normalizeFileList(cwd: string, files: readonly string[]): string[] {
  const unique = new Set<string>();

  for (const file of files.map((entry) => entry.trim()).filter((entry) => entry.length > 0)) {
    unique.add(path.resolve(cwd, file));
  }

  return [...unique].sort();
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function loadFileBackedProgress(cwd: string) {
  const progress = await loadAiqProgress(cwd);
  return progress.source === "file" ? progress : undefined;
}
