import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Diagnostic, RunResult } from "@tjalve/aiq/api";
import { lspDiagnosticSeverities } from "./protocol.js";
import type {
  DocumentDiagnosticReport,
  DocumentDiagnosticRequest,
  LspDiagnostic,
  LspDiagnosticSeverity,
  LspPreviousResultId,
  LspRange,
  LspTextDocumentIdentifier,
  WorkspaceDiagnosticReport,
  WorkspaceDiagnosticRequest,
  WorkspaceFullDocumentDiagnosticReport,
  WorkspaceUnchangedDocumentDiagnosticReport,
} from "./protocol.js";

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

function toZeroBasedPosition(value: number): number {
  return Math.max(0, value - 1);
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
