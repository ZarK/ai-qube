import type {
  AiqProfileName,
  RunStageConfigurations,
  StageId,
  resolveAiqConfig,
  runEngine,
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

export interface ResolvedLspSelection {
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
