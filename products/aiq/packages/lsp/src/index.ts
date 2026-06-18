import path from "node:path";

import {
  AiqEngineCancelledError,
  type AiqProfileName,
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
import { aiqLspServerCapabilities } from "./protocol.js";
import {
  createDocumentDiagnosticReport,
  createDocumentDiagnosticReportFromRunResult,
  createWorkspaceDiagnosticReport,
  createWorkspaceDiagnosticReportFromRunResult,
  resolveDocumentPath,
} from "./diagnostics.js";
import type {
  AiqLspAdapterOptions,
  AiqLspProgressEvent,
  AiqLspProgressReporter,
  AiqLspServerCapabilities,
  DocumentDiagnosticReport,
  DocumentDiagnosticRequest,
  LspTextDocumentIdentifier,
  ResolvedLspSelection,
  WorkspaceDiagnosticReport,
  WorkspaceDiagnosticRequest,
} from "./protocol.js";

export { aiqLspServerCapabilities, lspDiagnosticSeverities } from "./protocol.js";
export {
  createDocumentDiagnosticReport,
  createDocumentDiagnosticReportFromRunResult,
  createWorkspaceDiagnosticReport,
  createWorkspaceDiagnosticReportFromRunResult,
  mapDiagnosticRangeToLspRange,
  mapDiagnosticSeverityToLspSeverity,
  mapEngineDiagnosticToLspDiagnostic,
  resolveDocumentPath,
  resolveDocumentUri,
} from "./diagnostics.js";
export type {
  AiqDiagnosticProvider,
  AiqLspAdapterOptions,
  AiqLspProgressEvent,
  AiqLspProgressReporter,
  AiqLspServerCapabilities,
  DocumentDiagnosticReport,
  DocumentDiagnosticRequest,
  FullDocumentDiagnosticReport,
  LspDiagnostic,
  LspDiagnosticSeverity,
  LspPosition,
  LspPreviousResultId,
  LspRange,
  LspTextDocumentIdentifier,
  UnchangedDocumentDiagnosticReport,
  WorkspaceDiagnosticReport,
  WorkspaceDiagnosticRequest,
  WorkspaceDocumentDiagnosticReport,
  WorkspaceFullDocumentDiagnosticReport,
  WorkspaceUnchangedDocumentDiagnosticReport,
} from "./protocol.js";

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
