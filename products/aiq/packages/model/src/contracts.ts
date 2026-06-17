import type {
  LanguageId,
  ManifestSource,
  RunContext,
  RunMode,
  RunTelemetryEventType,
  StageId,
} from "./ids.js";

export const artifactSchemaVersion = 1 as const;

export type ArtifactSchemaVersion = typeof artifactSchemaVersion;

export interface FileManifestInput {
  files: readonly string[];
  source: ManifestSource;
}

export interface FileManifestEntry {
  extension: string;
  path: string;
}

export interface FileManifestSummary {
  fileCount: number;
}

export interface FileManifest {
  entries: FileManifestEntry[];
  files: string[];
  root: string;
  source: ManifestSource;
  summary: FileManifestSummary;
}

export interface RunStageLanguageConfiguration {
  toolId: string;
}

export interface RunStageConfiguration {
  languages: Partial<Record<LanguageId, RunStageLanguageConfiguration>>;
}

export type RunStageConfigurations = Partial<Record<StageId, RunStageConfiguration>>;

export interface RunRequest {
  context?: RunContext;
  cwd?: string;
  diffOnly?: boolean;
  diffOnlyFiles?: readonly string[];
  manifest: FileManifestInput;
  mode: RunMode;
  outDir?: string;
  stages?: readonly StageId[];
  stageConfigurations?: RunStageConfigurations;
  profile?: string;
  signal?: AbortSignal;
  writeArtifacts?: boolean;
}

export interface RunSelection {
  stages: StageId[];
  stageConfigurations?: RunStageConfigurations;
  profile: string;
}

export interface PlanArtifactTarget {
  outDir: string;
}

export interface ResolvedRunRequest {
  context: RunContext;
  cwd: string;
  diffOnly: boolean;
  diffOnlyFiles: string[];
  manifest: FileManifest;
  mode: RunMode;
  outDir: string;
  selection: RunSelection;
  signal?: AbortSignal;
  writeArtifacts: boolean;
}

export interface PlannedTask {
  fileCount: number;
  files: string[];
  id: string;
  stageId: StageId;
}

export interface RunPlanSummary {
  fileCount: number;
  stageCount: number;
  taskCount: number;
}

export interface RunPlan {
  artifactType: "plan";
  artifactVersion: ArtifactSchemaVersion;
  artifacts: PlanArtifactTarget;
  context: RunContext;
  createdAt: string;
  engineVersion: string;
  input: FileManifest;
  stages: StageId[];
  profile: string;
  runId: string;
  summary: RunPlanSummary;
  tasks: PlannedTask[];
}

export type StageStatus = "failed" | "not_implemented" | "passed";

export type ToolRunStatus = "failed" | "not_implemented" | "passed";

export interface DiagnosticRange {
  endColumn?: number;
  endLine?: number;
  startColumn: number;
  startLine: number;
}

export interface Diagnostic {
  code?: string;
  file: string;
  message: string;
  range?: DiagnosticRange;
  severity: "error" | "warning" | "info";
  source: string;
}

export interface ToolRunResult {
  args: string[];
  cacheHit: boolean;
  durationMs: number;
  exitCode?: number;
  finishedAt?: string;
  startedAt?: string;
  status: ToolRunStatus;
  stderrRef?: string;
  stdoutRef?: string;
  tool: string;
}

export interface StageResult {
  diagnostics: Diagnostic[];
  durationMs: number;
  notes: string[];
  stageId: StageId;
  status: StageStatus;
  toolRuns: ToolRunResult[];
}

export interface ArtifactPaths {
  metricsPath?: string;
  outDir: string;
  planPath?: string;
  reportPath?: string;
}

export interface RunTelemetryEvent {
  artifact?: "metrics" | "plan" | "report";
  artifactPath?: string;
  artifactType: "metrics-event";
  artifactVersion: ArtifactSchemaVersion;
  cacheHit?: boolean;
  cacheHitRate?: number;
  context: RunContext;
  diagnosticCount?: number;
  durationMs?: number;
  event: RunTelemetryEventType;
  fileCount?: number;
  stageCount?: number;
  stageId?: StageId;
  profile: string;
  runId: string;
  status?: StageStatus | RunStatus | ToolRunStatus;
  taskCount?: number;
  timestamp: string;
  tool?: string;
  toolRunCount?: number;
}

export type RunStatus = "failed" | "not_implemented" | "passed";

export interface RunSummary {
  cacheHitCount: number;
  cacheHitRate: number;
  cacheMissCount: number;
  diagnosticCount: number;
  durationMs: number;
  fileCount: number;
  notImplementedStageCount: number;
  stageCount: number;
  status: RunStatus;
  taskCount: number;
  toolDurationMs: number;
  toolRunCount: number;
}

export interface RunResult {
  artifactType: "report";
  artifactVersion: ArtifactSchemaVersion;
  artifacts: ArtifactPaths;
  context: RunContext;
  durationMs: number;
  engineVersion: string;
  finishedAt: string;
  mode: RunMode;
  ok: boolean;
  stages: StageResult[];
  plan: RunPlan;
  request: ResolvedRunRequest;
  runId: string;
  startedAt: string;
  summary: RunSummary;
}
