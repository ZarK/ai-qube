import { readFile } from "node:fs/promises";

import { resolveReportArtifactPath } from "@tjalve/aiq/engine";
import type { RunResult, StageStatus } from "@tjalve/aiq/model";

import { isErrorCode } from "./shared.js";

const aiqEvidenceSchemaVersion = 1 as const;
const staleAfterMs = 24 * 60 * 60 * 1_000;

type AieGateResult = "failed" | "missing" | "passed" | "stale";
type AiuStateValueKind = "fail" | "malformed" | "missing" | "pass" | "stale" | "unsupported";

interface AiuTrustedStateCommandRef {
  id: string;
  argv: [string, ...string[]];
  maxOutputBytes?: number;
  timeoutMs?: number;
}

interface AiqQualityEvidence {
  schemaVersion: typeof aiqEvidenceSchemaVersion;
  result: AieGateResult;
  trust: "local-evidence";
  summary: string;
  recordedAt: string;
  reasonCode: "local-evidence-found" | "malformed-evidence" | "missing-evidence" | "stale-evidence";
  stale: boolean;
  metadata: {
    aiq: {
      reportPath: string;
      reportStatus: AiuStateValueKind;
      runId?: string;
      finishedAt?: string;
      ageMs?: number;
      staleAfterMs: number;
    };
  };
  states: [AiuQualityTrustedState];
}

interface AiuQualityTrustedState {
  sourceId: "aiq";
  observedAt: string;
  trustLevel: "trusted";
  capabilities: {
    quality: "supported";
  };
  freshness: {
    kind: "fresh";
    observedAt: string;
    ageMs: 0;
    staleAfterMs: typeof staleAfterMs;
  };
  value: AiuQualityState;
}

interface AiuQualityState {
  kind: "quality";
  status: "fail" | "pass";
  summary: string;
  ready: boolean;
  lastRunStatus: AiuStateValueKind;
  stages: AiuQualityStage[];
  findings: AiuQualityFinding[];
  failingChecks: string[];
  affectedPaths: string[];
  nextCommand: AiuTrustedStateCommandRef;
  rerunCommand: AiuTrustedStateCommandRef;
  selectedTarget?: AiuQualitySelectedTarget;
  humanApprovalRequired: false;
  supplyChainApprovalRequired: false;
}

interface AiuQualityStage {
  id: string;
  title: string;
  status: AiuStateValueKind;
  affectedPaths: string[];
  rerunCommand: AiuTrustedStateCommandRef;
}

interface AiuQualityFinding {
  id: string;
  title: string;
  stageId: string;
  status: "fail";
  severity: "high" | "medium";
  affectedPaths: string[];
  rerunCommand: AiuTrustedStateCommandRef;
}

interface AiuQualitySelectedTarget {
  kind: "finding" | "stage";
  id: string;
  title: string;
  stageId?: string;
  status: "fail";
  affectedPaths: string[];
  rerunCommand: AiuTrustedStateCommandRef;
  expectedEvidence: string;
}

interface LoadedReport {
  kind: "loaded";
  report: RunResult;
  reportPath: string;
}

interface MissingReport {
  kind: "missing";
  reportPath: string;
}

interface MalformedReport {
  kind: "malformed";
  reportPath: string;
}

type ReportLoadResult = LoadedReport | MalformedReport | MissingReport;

export async function createAiqQualityEvidence(cwd: string): Promise<AiqQualityEvidence> {
  const reportPath = resolveReportArtifactPath(cwd);
  const report = await loadReport(reportPath);
  const recordedAt = new Date().toISOString();
  return report.kind === "loaded"
    ? createReportEvidence(report.report, report.reportPath, recordedAt)
    : createUnavailableEvidence(report, recordedAt);
}

export function formatAiqQualityEvidenceJson(evidence: AiqQualityEvidence): string {
  return `${JSON.stringify(evidence, null, 2)}\n`;
}

async function loadReport(reportPath: string): Promise<ReportLoadResult> {
  let contents: string;
  try {
    contents = await readFile(reportPath, "utf8");
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return { kind: "missing", reportPath };
    }
    return { kind: "malformed", reportPath };
  }

  try {
    const value = JSON.parse(contents) as unknown;
    return isRunResult(value)
      ? { kind: "loaded", report: value, reportPath }
      : { kind: "malformed", reportPath };
  } catch {
    return { kind: "malformed", reportPath };
  }
}

function createReportEvidence(
  report: RunResult,
  reportPath: string,
  recordedAt: string,
): AiqQualityEvidence {
  const finishedAtMs = Date.parse(report.finishedAt);
  const recordedAtMs = Date.parse(recordedAt);
  const ageMs =
    Number.isFinite(finishedAtMs) && Number.isFinite(recordedAtMs)
      ? Math.max(0, recordedAtMs - finishedAtMs)
      : undefined;
  const stale = ageMs === undefined || ageMs > staleAfterMs;
  if (stale) {
    return buildEvidence({
      affectedPaths: report.request.manifest.files,
      lastRunStatus: "stale",
      recordedAt,
      reportPath,
      result: "stale",
      runId: report.runId,
      finishedAt: report.finishedAt,
      ...(ageMs === undefined ? {} : { ageMs }),
      summary: "AIQ report is stale; rerun AIQ before using quality evidence.",
      targetId: "stale-report",
      targetTitle: "Refresh stale AIQ report",
    });
  }

  if (report.summary.status === "passed") {
    const command = createRunCommand(report.request.manifest.files);
    return {
      schemaVersion: aiqEvidenceSchemaVersion,
      result: "passed",
      trust: "local-evidence",
      summary: `AIQ quality passed with ${String(report.summary.stageCount)} stage(s) and ${String(report.summary.fileCount)} file(s).`,
      recordedAt,
      reasonCode: "local-evidence-found",
      stale: false,
      metadata: {
        aiq: {
          reportPath,
          reportStatus: "pass",
          runId: report.runId,
          finishedAt: report.finishedAt,
          ...(ageMs === undefined ? {} : { ageMs }),
          staleAfterMs,
        },
      },
      states: [
        createState({
          affectedPaths: report.request.manifest.files,
          failingChecks: [],
          findings: [],
          lastRunStatus: "pass",
          recordedAt,
          ready: false,
          stages: report.stages.map((stage) => ({
            affectedPaths: stageAffectedPaths(stage, report),
            id: stage.stageId,
            rerunCommand: command,
            status: mapStageStatus(stage.status),
            title: stage.stageId,
          })),
          status: "pass",
          summary: `AIQ quality passed with ${String(report.summary.stageCount)} stage(s).`,
          command,
        }),
      ],
    };
  }

  const failingStages = report.stages.filter((stage) => stage.status !== "passed");
  const firstStage = failingStages[0];
  const selectedPaths =
    firstStage === undefined
      ? report.request.manifest.files
      : stageAffectedPaths(firstStage, report);
  const command = createRunCommand(report.request.manifest.files);
  const findings = failingStages.flatMap((stage) => stageFindings(stage, report, command));
  const stages = report.stages.map((stage) => ({
    affectedPaths: stageAffectedPaths(stage, report),
    id: stage.stageId,
    rerunCommand: command,
    status: mapStageStatus(stage.status),
    title: stage.stageId,
  }));

  return {
    schemaVersion: aiqEvidenceSchemaVersion,
    result: "failed",
    trust: "local-evidence",
    summary: `AIQ quality ${report.summary.status}; ${String(failingStages.length)} stage(s) need attention.`,
    recordedAt,
    reasonCode: "local-evidence-found",
    stale: false,
    metadata: {
      aiq: {
        reportPath,
        reportStatus: "fail",
        runId: report.runId,
        finishedAt: report.finishedAt,
        ...(ageMs === undefined ? {} : { ageMs }),
        staleAfterMs,
      },
    },
    states: [
      createState({
        affectedPaths: uniqueStrings(
          failingStages.flatMap((stage) => stageAffectedPaths(stage, report)),
        ),
        failingChecks: failingStages.map((stage) => stage.stageId),
        findings,
        lastRunStatus: "fail",
        recordedAt,
        ready: true,
        ...(firstStage === undefined
          ? {}
          : {
              selectedTarget: {
                kind: "stage",
                id: firstStage.stageId,
                title: `Fix AIQ ${firstStage.stageId}`,
                stageId: firstStage.stageId,
                status: "fail",
                affectedPaths: selectedPaths,
                rerunCommand: command,
                expectedEvidence: "Rerun AIQ and refresh aiq evidence after the stage passes.",
              },
            }),
        stages,
        status: "fail",
        summary: `AIQ quality ${report.summary.status}; rerun after fixing failing stages.`,
        command,
      }),
    ],
  };
}

function createUnavailableEvidence(
  report: MissingReport | MalformedReport,
  recordedAt: string,
): AiqQualityEvidence {
  if (report.kind === "missing") {
    return buildEvidence({
      affectedPaths: [],
      lastRunStatus: "missing",
      recordedAt,
      reportPath: report.reportPath,
      result: "missing",
      summary: "AIQ report is missing; run AIQ before using quality evidence.",
      targetId: "missing-report",
      targetTitle: "Create AIQ report",
    });
  }

  return buildEvidence({
    affectedPaths: [],
    lastRunStatus: "malformed",
    recordedAt,
    reportPath: report.reportPath,
    result: "failed",
    summary: "AIQ report is malformed or unreadable; rerun AIQ to refresh quality evidence.",
    targetId: "malformed-report",
    targetTitle: "Replace malformed AIQ report",
  });
}

function buildEvidence(input: {
  affectedPaths: readonly string[];
  ageMs?: number;
  finishedAt?: string;
  lastRunStatus: AiuStateValueKind;
  recordedAt: string;
  reportPath: string;
  result: AieGateResult;
  runId?: string;
  summary: string;
  targetId: string;
  targetTitle: string;
}): AiqQualityEvidence {
  const command = createRunCommand(input.affectedPaths);
  return {
    schemaVersion: aiqEvidenceSchemaVersion,
    result: input.result,
    trust: "local-evidence",
    summary: input.summary,
    recordedAt: input.recordedAt,
    reasonCode:
      input.result === "missing"
        ? "missing-evidence"
        : input.result === "stale"
          ? "stale-evidence"
          : input.lastRunStatus === "malformed"
            ? "malformed-evidence"
            : "local-evidence-found",
    stale: input.result === "stale",
    metadata: {
      aiq: {
        reportPath: input.reportPath,
        reportStatus: input.lastRunStatus,
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        ...(input.finishedAt === undefined ? {} : { finishedAt: input.finishedAt }),
        ...(input.ageMs === undefined ? {} : { ageMs: input.ageMs }),
        staleAfterMs,
      },
    },
    states: [
      createState({
        affectedPaths: [...input.affectedPaths],
        failingChecks: [input.targetId],
        findings: [
          {
            id: input.targetId,
            title: input.targetTitle,
            stageId: "aiq-evidence",
            status: "fail",
            severity: "high",
            affectedPaths: [...input.affectedPaths],
            rerunCommand: command,
          },
        ],
        lastRunStatus: input.lastRunStatus,
        recordedAt: input.recordedAt,
        ready: true,
        selectedTarget: {
          kind: "finding",
          id: input.targetId,
          title: input.targetTitle,
          stageId: "aiq-evidence",
          status: "fail",
          affectedPaths: [...input.affectedPaths],
          rerunCommand: command,
          expectedEvidence:
            "Run AIQ and refresh aiq evidence before claiming quality is satisfied.",
        },
        stages: [
          {
            id: "aiq-evidence",
            title: "AIQ evidence",
            status: "fail",
            affectedPaths: [...input.affectedPaths],
            rerunCommand: command,
          },
        ],
        status: "fail",
        summary: input.summary,
        command,
      }),
    ],
  };
}

function createState(input: {
  affectedPaths: readonly string[];
  command: AiuTrustedStateCommandRef;
  failingChecks: string[];
  findings: AiuQualityFinding[];
  lastRunStatus: AiuStateValueKind;
  recordedAt: string;
  ready: boolean;
  selectedTarget?: AiuQualitySelectedTarget;
  stages: AiuQualityStage[];
  status: "fail" | "pass";
  summary: string;
}): AiuQualityTrustedState {
  return {
    sourceId: "aiq",
    observedAt: input.recordedAt,
    trustLevel: "trusted",
    capabilities: {
      quality: "supported",
    },
    freshness: {
      kind: "fresh",
      observedAt: input.recordedAt,
      ageMs: 0,
      staleAfterMs,
    },
    value: {
      kind: "quality",
      status: input.status,
      summary: input.summary,
      ready: input.ready,
      lastRunStatus: input.lastRunStatus,
      stages: input.stages,
      findings: input.findings,
      failingChecks: input.failingChecks,
      affectedPaths: [...input.affectedPaths],
      nextCommand: input.command,
      rerunCommand: input.command,
      ...(input.selectedTarget === undefined ? {} : { selectedTarget: input.selectedTarget }),
      humanApprovalRequired: false,
      supplyChainApprovalRequired: false,
    },
  };
}

function stageFindings(
  stage: RunResult["stages"][number],
  report: RunResult,
  command: AiuTrustedStateCommandRef,
): AiuQualityFinding[] {
  if (stage.diagnostics.length === 0) {
    return [
      {
        id: `${stage.stageId}:stage`,
        title: `${stage.stageId} did not pass`,
        stageId: stage.stageId,
        status: "fail",
        severity: stage.status === "not_implemented" ? "medium" : "high",
        affectedPaths: stageAffectedPaths(stage, report),
        rerunCommand: command,
      },
    ];
  }

  return stage.diagnostics.map((diagnostic, index) => ({
    id: `${stage.stageId}:${String(index + 1)}`,
    title: diagnostic.message,
    stageId: stage.stageId,
    status: "fail",
    severity: diagnostic.severity === "warning" ? "medium" : "high",
    affectedPaths: [diagnostic.file],
    rerunCommand: command,
  }));
}

function stageAffectedPaths(stage: RunResult["stages"][number], report: RunResult): string[] {
  const diagnosticPaths = stage.diagnostics.map((diagnostic) => diagnostic.file);
  return uniqueStrings(
    diagnosticPaths.length > 0 ? diagnosticPaths : report.request.manifest.files,
  );
}

function createRunCommand(files: readonly string[]): AiuTrustedStateCommandRef {
  const argv = files.length === 0 ? ["aiq", "run", "."] : ["aiq", "run", ...files];
  return {
    id: "aiq-run",
    argv: argv as [string, ...string[]],
    timeoutMs: 600_000,
    maxOutputBytes: 1_048_576,
  };
}

function mapStageStatus(status: StageStatus): AiuStateValueKind {
  if (status === "passed") {
    return "pass";
  }
  if (status === "not_implemented") {
    return "unsupported";
  }
  return "fail";
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isRunResult(value: unknown): value is RunResult {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.artifactType === "report" &&
    typeof value.finishedAt === "string" &&
    typeof value.runId === "string" &&
    isRecord(value.summary) &&
    isRunStatus(value.summary.status) &&
    Array.isArray(value.stages) &&
    value.stages.every(isRunStage) &&
    isRecord(value.request) &&
    isRecord(value.request.manifest) &&
    Array.isArray(value.request.manifest.files) &&
    value.request.manifest.files.every((file) => typeof file === "string")
  );
}

function isRunStatus(value: unknown): value is RunResult["summary"]["status"] {
  return value === "failed" || value === "not_implemented" || value === "passed";
}

function isRunStage(value: unknown): value is RunResult["stages"][number] {
  return (
    isRecord(value) &&
    typeof value.stageId === "string" &&
    isStageStatus(value.status) &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every(isDiagnostic)
  );
}

function isStageStatus(value: unknown): value is StageStatus {
  return value === "failed" || value === "not_implemented" || value === "passed";
}

function isDiagnostic(value: unknown): value is RunResult["stages"][number]["diagnostics"][number] {
  return (
    isRecord(value) &&
    typeof value.file === "string" &&
    typeof value.message === "string" &&
    isDiagnosticSeverity(value.severity) &&
    typeof value.source === "string"
  );
}

function isDiagnosticSeverity(
  value: unknown,
): value is RunResult["stages"][number]["diagnostics"][number]["severity"] {
  return value === "error" || value === "warning" || value === "info";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
