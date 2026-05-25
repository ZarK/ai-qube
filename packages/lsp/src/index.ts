import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  AiqEngineCancelledError,
  type AiqProfileName,
  type Diagnostic,
  type RunRequest,
  type RunResult,
  type RunStageConfigurations,
  type StageId,
  loadAiqProgress,
  resolveAiqConfig,
  resolveAiqProgressStageIds,
  runEngine,
  stageIds,
} from "@tjalve/aiq/api";

export const lspDiagnosticSeverities = {
  error: 1,
  hint: 4,
  info: 3,
  warning: 2,
} as const;

export type LspDiagnosticSeverity =
  (typeof lspDiagnosticSeverities)[keyof typeof lspDiagnosticSeverities];

export interface LspPosition {
  character: number;
  line: number;
}

export interface LspRange {
  end: LspPosition;
  start: LspPosition;
}

export interface LspDiagnostic {
  code?: string;
  message: string;
  range: LspRange;
  severity: LspDiagnosticSeverity;
  source: string;
}

export interface LspTextDocumentIdentifier {
  uri: string;
  version?: number | null;
}

export interface LspPreviousResultId {
  uri: string;
  value: string;
}

export interface FullDocumentDiagnosticReport {
  items: LspDiagnostic[];
  kind: "full";
  resultId: string;
}

export interface UnchangedDocumentDiagnosticReport {
  kind: "unchanged";
  resultId: string;
}

export type DocumentDiagnosticReport =
  | FullDocumentDiagnosticReport
  | UnchangedDocumentDiagnosticReport;

export interface WorkspaceFullDocumentDiagnosticReport extends FullDocumentDiagnosticReport {
  uri: string;
  version: number | null;
}

export interface WorkspaceUnchangedDocumentDiagnosticReport
  extends UnchangedDocumentDiagnosticReport {
  uri: string;
  version: number | null;
}

export type WorkspaceDocumentDiagnosticReport =
  | WorkspaceFullDocumentDiagnosticReport
  | WorkspaceUnchangedDocumentDiagnosticReport;

export interface WorkspaceDiagnosticReport {
  items: WorkspaceDocumentDiagnosticReport[];
}

export interface AiqLspProgressEvent {
  kind: "begin" | "end" | "report";
  message: string;
  percentage?: number;
}

export type AiqLspProgressReporter = (event: AiqLspProgressEvent) => void;

export interface DocumentDiagnosticRequest {
  onProgress?: AiqLspProgressReporter;
  previousResultId?: string;
  signal?: AbortSignal;
  textDocument: LspTextDocumentIdentifier;
}

export interface WorkspaceDiagnosticRequest {
  onProgress?: AiqLspProgressReporter;
  previousResultIds?: readonly LspPreviousResultId[];
  signal?: AbortSignal;
  textDocuments: readonly LspTextDocumentIdentifier[];
}

export interface AiqDiagnosticProvider {
  interFileDependencies: boolean;
  workDoneProgress: boolean;
  workspaceDiagnostics: boolean;
}

export interface AiqLspServerCapabilities {
  diagnosticProvider: AiqDiagnosticProvider;
}

export interface AiqLspAdapterOptions {
  cwd?: string;
  documentStages?: readonly StageId[];
  profile?: AiqProfileName;
  resolveConfigImpl?: typeof resolveAiqConfig;
  runEngineImpl?: typeof runEngine;
  workspaceStages?: readonly StageId[];
  writeArtifacts?: boolean;
}

interface ResolvedLspSelection {
  cwd: string;
  stages: StageId[];
  stageConfigurations?: RunStageConfigurations;
  profile: AiqProfileName;
  publishDiagnostics: boolean;
}

export const aiqLspServerCapabilities: AiqLspServerCapabilities = {
  diagnosticProvider: {
    interFileDependencies: true,
    workDoneProgress: true,
    workspaceDiagnostics: true,
  },
};

export class AiqLspCancelledError extends Error {
  constructor(message = "AIQ LSP request cancelled.") {
    super(message);
    this.name = "AiqLspCancelledError";
  }
}

export class AiqLspAdapter {
  private readonly cwd: string;

  private readonly documentStages: readonly StageId[] | undefined;

  private readonly profile: AiqProfileName | undefined;

  private readonly resolveConfigImpl: typeof resolveAiqConfig;

  private readonly runEngineImpl: typeof runEngine;

  private readonly workspaceStages: readonly StageId[] | undefined;

  private readonly writeArtifacts: boolean;

  constructor(options: AiqLspAdapterOptions = {}) {
    this.cwd = path.resolve(options.cwd ?? process.cwd());
    this.documentStages = options.documentStages;
    this.profile = options.profile;
    this.resolveConfigImpl = options.resolveConfigImpl ?? resolveAiqConfig;
    this.runEngineImpl = options.runEngineImpl ?? runEngine;
    this.workspaceStages = options.workspaceStages;
    this.writeArtifacts = options.writeArtifacts ?? false;
  }

  getServerCapabilities(): AiqLspServerCapabilities {
    return aiqLspServerCapabilities;
  }

  async getDocumentDiagnosticReport(
    request: DocumentDiagnosticRequest,
  ): Promise<DocumentDiagnosticReport> {
    const filePath = resolveDocumentPath(request.textDocument.uri);
    const selection = await this.resolveSelection("document");

    if (!selection.publishDiagnostics) {
      return createDocumentDiagnosticReport(
        request.previousResultId === undefined
          ? { diagnostics: [] }
          : {
              diagnostics: [],
              previousResultId: request.previousResultId,
            },
      );
    }

    const result = await this.executeRun(
      "document",
      [filePath],
      request.signal,
      request.onProgress,
      selection,
    );

    return createDocumentDiagnosticReportFromRunResult(result, request);
  }

  async getWorkspaceDiagnosticReport(
    request: WorkspaceDiagnosticRequest,
  ): Promise<WorkspaceDiagnosticReport> {
    const textDocuments = uniqueTextDocuments(request.textDocuments);
    if (textDocuments.length === 0) {
      return { items: [] };
    }

    const files = textDocuments.map((document) => resolveDocumentPath(document.uri));
    const selection = await this.resolveSelection("workspace");

    if (!selection.publishDiagnostics) {
      return createWorkspaceDiagnosticReport(
        request.previousResultIds === undefined
          ? { textDocuments }
          : {
              previousResultIds: request.previousResultIds,
              textDocuments,
            },
      );
    }

    const result = await this.executeRun(
      "workspace",
      files,
      request.signal,
      request.onProgress,
      selection,
    );

    return createWorkspaceDiagnosticReportFromRunResult(
      result,
      request.previousResultIds === undefined
        ? { textDocuments }
        : {
            previousResultIds: request.previousResultIds,
            textDocuments,
          },
    );
  }

  private async executeRun(
    scope: "document" | "workspace",
    files: readonly string[],
    signal: AbortSignal | undefined,
    onProgress: AiqLspProgressReporter | undefined,
    selection: ResolvedLspSelection,
  ): Promise<RunResult> {
    let completed = false;
    let started = false;

    try {
      throwIfCancelled(signal);
      started = true;
      reportProgress(onProgress, {
        kind: "begin",
        message: `Resolving AIQ ${scope} diagnostics.`,
        percentage: 0,
      });
      reportProgress(onProgress, {
        kind: "report",
        message: `Running AIQ ${scope} diagnostics for ${files.length} file${files.length === 1 ? "" : "s"}.`,
        percentage: 50,
      });

      const request: RunRequest = {
        context: "lsp",
        cwd: selection.cwd,
        manifest: {
          files: [...files],
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

      if (signal !== undefined) {
        request.signal = signal;
      }

      const result = await this.runEngineImpl(request);

      throwIfCancelled(signal);
      reportProgress(onProgress, {
        kind: "report",
        message: `Collected ${result.summary.diagnosticCount} diagnostic${result.summary.diagnosticCount === 1 ? "" : "s"}.`,
        percentage: 100,
      });
      completed = true;

      return result;
    } catch (error) {
      if (isCancellationError(error) || isAbortError(error) || signal?.aborted === true) {
        reportProgress(onProgress, {
          kind: "end",
          message: `AIQ ${scope} diagnostics cancelled.`,
        });
        throw error instanceof AiqLspCancelledError ? error : new AiqLspCancelledError();
      }

      reportProgress(onProgress, {
        kind: "end",
        message: `AIQ ${scope} diagnostics failed.`,
      });
      throw error;
    } finally {
      if (started && completed && signal?.aborted !== true) {
        reportProgress(onProgress, {
          kind: "end",
          message: `AIQ ${scope} diagnostics complete.`,
        });
      }
    }
  }

  private async resolveSelection(scope: "document" | "workspace"): Promise<ResolvedLspSelection> {
    const configuredStages = scope === "document" ? this.documentStages : this.workspaceStages;
    const progress =
      configuredStages === undefined && this.profile === undefined
        ? await loadFileBackedProgress(this.cwd)
        : undefined;
    const resolved = await this.resolveConfigImpl({
      cwd: this.cwd,
      ...(configuredStages === undefined
        ? progress === undefined
          ? {}
          : { stages: resolveAiqProgressStageIds(progress.progress.current_stage) }
        : { stages: [...configuredStages] }),
      ...(this.profile === undefined ? {} : { profile: this.profile }),
      surface: "lsp",
    });

    return {
      cwd: resolved.cwd,
      stages: toEngineStageIds(resolved.stages),
      ...(resolved.stageConfigurations === undefined
        ? {}
        : { stageConfigurations: resolved.stageConfigurations }),
      profile: resolved.profile,
      publishDiagnostics: resolved.publishDiagnostics,
    };
  }
}

export function createAiqLspAdapter(options?: AiqLspAdapterOptions): AiqLspAdapter {
  return new AiqLspAdapter(options);
}

export function createDocumentDiagnosticReportFromRunResult(
  result: RunResult,
  request: Pick<DocumentDiagnosticRequest, "previousResultId" | "textDocument">,
): DocumentDiagnosticReport {
  const filePath = resolveDocumentPath(request.textDocument.uri);
  const diagnostics = collectDiagnosticsForFile(result, filePath);
  return createDocumentDiagnosticReport(
    request.previousResultId === undefined
      ? { diagnostics }
      : {
          diagnostics,
          previousResultId: request.previousResultId,
        },
  );
}

export function createWorkspaceDiagnosticReportFromRunResult(
  result: RunResult,
  request: Pick<WorkspaceDiagnosticRequest, "previousResultIds" | "textDocuments">,
): WorkspaceDiagnosticReport {
  return createWorkspaceDiagnosticReport(
    request.previousResultIds === undefined
      ? {
          diagnosticsByFile: groupDiagnosticsByFile(result),
          textDocuments: request.textDocuments,
        }
      : {
          diagnosticsByFile: groupDiagnosticsByFile(result),
          previousResultIds: request.previousResultIds,
          textDocuments: request.textDocuments,
        },
  );
}

export function createDocumentDiagnosticReport(options: {
  diagnostics: readonly Diagnostic[];
  previousResultId?: string;
}): DocumentDiagnosticReport {
  const items = options.diagnostics.map(mapEngineDiagnosticToLspDiagnostic);
  const resultId = createResultId(items);

  if (options.previousResultId === resultId) {
    return {
      kind: "unchanged",
      resultId,
    };
  }

  return {
    items,
    kind: "full",
    resultId,
  };
}

export function createWorkspaceDiagnosticReport(options: {
  diagnosticsByFile?: ReadonlyMap<string, readonly Diagnostic[]>;
  previousResultIds?: readonly LspPreviousResultId[];
  textDocuments: readonly LspTextDocumentIdentifier[];
}): WorkspaceDiagnosticReport {
  const previousResultIds = new Map(
    (options.previousResultIds ?? []).map((entry) => [entry.uri, entry.value]),
  );
  const diagnosticsByFile = options.diagnosticsByFile ?? new Map<string, readonly Diagnostic[]>();
  const items = resolveWorkspaceTextDocuments(options.textDocuments, diagnosticsByFile).map(
    (textDocument) => {
      const filePath = resolveDocumentPath(textDocument.uri);
      const diagnostics = diagnosticsByFile.get(filePath) ?? [];
      const lspDiagnostics = diagnostics.map(mapEngineDiagnosticToLspDiagnostic);
      const resultId = createResultId(lspDiagnostics);

      if (previousResultIds.get(textDocument.uri) === resultId) {
        return {
          kind: "unchanged",
          resultId,
          uri: textDocument.uri,
          version: textDocument.version ?? null,
        } satisfies WorkspaceUnchangedDocumentDiagnosticReport;
      }

      return {
        items: lspDiagnostics,
        kind: "full",
        resultId,
        uri: textDocument.uri,
        version: textDocument.version ?? null,
      } satisfies WorkspaceFullDocumentDiagnosticReport;
    },
  );

  return { items };
}

export function mapEngineDiagnosticToLspDiagnostic(diagnostic: Diagnostic): LspDiagnostic {
  const lspDiagnostic: LspDiagnostic = {
    message: diagnostic.message,
    range: mapDiagnosticRangeToLspRange(diagnostic.range),
    severity: mapDiagnosticSeverityToLspSeverity(diagnostic.severity),
    source: `aiq/${diagnostic.source}`,
  };

  if (diagnostic.code !== undefined) {
    lspDiagnostic.code = diagnostic.code;
  }

  return lspDiagnostic;
}

export function mapDiagnosticSeverityToLspSeverity(
  severity: Diagnostic["severity"],
): LspDiagnosticSeverity {
  switch (severity) {
    case "error":
      return lspDiagnosticSeverities.error;
    case "warning":
      return lspDiagnosticSeverities.warning;
    case "info":
      return lspDiagnosticSeverities.info;
    default:
      return lspDiagnosticSeverities.hint;
  }
}

export function mapDiagnosticRangeToLspRange(diagnosticRange?: Diagnostic["range"]): LspRange {
  if (diagnosticRange === undefined) {
    return {
      end: { character: 0, line: 0 },
      start: { character: 0, line: 0 },
    };
  }

  const startLine = toZeroBasedPosition(diagnosticRange.startLine);
  const startCharacter = toZeroBasedPosition(diagnosticRange.startColumn);
  const endLine = toZeroBasedPosition(diagnosticRange.endLine ?? diagnosticRange.startLine);
  const endCharacter = toZeroBasedPosition(
    diagnosticRange.endColumn ?? diagnosticRange.startColumn,
  );

  return {
    end: {
      character: endCharacter,
      line: endLine,
    },
    start: {
      character: startCharacter,
      line: startLine,
    },
  };
}

export function resolveDocumentPath(uri: string): string {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new Error(`Invalid LSP document URI: ${uri}`);
  }

  if (url.protocol !== "file:") {
    throw new Error(`Unsupported LSP document URI protocol: ${uri}`);
  }

  return path.resolve(fileURLToPath(url));
}

export function resolveDocumentUri(filePath: string): string {
  return pathToFileURL(path.resolve(filePath)).href;
}

function collectDiagnosticsForFile(result: RunResult, filePath: string): Diagnostic[] {
  const resolvedFilePath = path.resolve(filePath);
  return result.stages.flatMap((stage) =>
    stage.diagnostics.filter((diagnostic) => path.resolve(diagnostic.file) === resolvedFilePath),
  );
}

function createResultId(items: readonly LspDiagnostic[]): string {
  const normalizedItems = items
    .map((item) => ({
      code: item.code ?? null,
      message: item.message,
      range: item.range,
      severity: item.severity,
      source: item.source,
    }))
    .sort((left, right) => compareSerializedValues(JSON.stringify(left), JSON.stringify(right)));

  return createHash("sha256").update(JSON.stringify(normalizedItems)).digest("hex");
}

function groupDiagnosticsByFile(result: RunResult): Map<string, readonly Diagnostic[]> {
  const grouped = new Map<string, Diagnostic[]>();

  for (const stage of result.stages) {
    for (const diagnostic of stage.diagnostics) {
      const filePath = path.resolve(diagnostic.file);
      const existing = grouped.get(filePath);
      if (existing === undefined) {
        grouped.set(filePath, [diagnostic]);
        continue;
      }

      existing.push(diagnostic);
    }
  }

  return grouped;
}

function isCancellationError(error: unknown): error is AiqLspCancelledError {
  return error instanceof AiqLspCancelledError;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof AiqEngineCancelledError ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function reportProgress(
  onProgress: AiqLspProgressReporter | undefined,
  event: AiqLspProgressEvent,
): void {
  onProgress?.(event);
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new AiqLspCancelledError();
  }
}

function toEngineStageIds(stages: readonly string[]): StageId[] {
  const resolved: StageId[] = [];

  for (const stage of stages) {
    if (!stageIds.includes(stage as StageId)) {
      throw new Error(`Unsupported AIQ stage '${stage}' for the LSP adapter.`);
    }

    resolved.push(stage as StageId);
  }

  return resolved;
}

async function loadFileBackedProgress(cwd: string) {
  const progress = await loadAiqProgress(cwd);
  return progress.source === "file" ? progress : undefined;
}

function toZeroBasedPosition(value: number): number {
  return Math.max(0, value - 1);
}

function uniqueTextDocuments(
  textDocuments: readonly LspTextDocumentIdentifier[],
): LspTextDocumentIdentifier[] {
  const documents = new Map<string, LspTextDocumentIdentifier>();

  for (const textDocument of textDocuments) {
    if (!documents.has(textDocument.uri)) {
      documents.set(textDocument.uri, textDocument);
    }
  }

  return [...documents.values()];
}

function resolveWorkspaceTextDocuments(
  textDocuments: readonly LspTextDocumentIdentifier[],
  diagnosticsByFile: ReadonlyMap<string, readonly Diagnostic[]>,
): LspTextDocumentIdentifier[] {
  const documents = new Map(
    uniqueTextDocuments(textDocuments).map((textDocument) => [textDocument.uri, textDocument]),
  );

  for (const filePath of [...diagnosticsByFile.keys()].sort(compareSerializedValues)) {
    const uri = resolveDocumentUri(filePath);
    if (!documents.has(uri)) {
      documents.set(uri, { uri, version: null });
    }
  }

  return [...documents.values()].sort((left, right) =>
    compareSerializedValues(left.uri, right.uri),
  );
}

function compareSerializedValues(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}
