import { formatBenchmarkReportAsJson, formatBenchmarkReportAsText } from "@tjalve/aiq-benchmark";
import type { RunPlan, RunResult, StageId, ToolRunResult } from "@tjalve/aiq-model";
import {
  formatPlanAsJson,
  formatPlanAsText,
  formatRunResultAsJson,
  formatRunResultAsText,
} from "@tjalve/aiq-reporters";

import type { CliIo, OutputFormat } from "./types.js";
import type { SetupGuidanceCommand, VerboseToolRunDetail } from "./types.js";

export interface ConfigCommandOutput {
  config: unknown;
  configPath?: string;
  progress: unknown;
  progressPath: string;
  progressSource: "defaults" | "file";
  profile: string;
  stages: string[];
}

export interface ConfigInitOutput {
  configCreated: boolean;
  configPath: string;
  progressCreated: boolean;
  progressPath: string;
}

export interface ConfigStageOutput {
  current_stage: number;
  progressPath: string;
}

export interface DoctorCheckOutput {
  detail?: string;
  install?: string;
  name: string;
  ok: boolean;
  required?: boolean;
  source?: "bundled" | "external" | "project";
}

export interface DoctorCommandOutput {
  checks: DoctorCheckOutput[];
  configPath?: string;
  cwd: string;
  detectedTech: string[];
  ok: boolean;
  progressPath: string;
  progressSource: "defaults" | "file";
  profile: string;
  stages: string[];
}

export interface FirstRunDetectionOutput {
  configCreated: boolean;
  configPath: string;
  detectedProjects: string[];
  progressCreated: boolean;
  progressPath: string;
  stages: string[];
  target: string;
  truncated: boolean;
  warnings: string[];
}

export interface FirstRunSetupOutput {
  cwd: string;
  examples: string[];
  markers: string[];
  remediation: string;
  summary: string;
}

export interface SetupGuidanceOutput {
  command: SetupGuidanceCommand;
  replacement: string;
  requested: string;
  summary: string;
}

type BenchmarkReport = Parameters<typeof formatBenchmarkReportAsJson>[0];

interface WatchRunEnvelope {
  event: "run";
  result: RunResult;
  trigger: string;
}

interface ServeListeningEnvelope {
  event: "listening";
  host: string;
  port: number;
  url: string;
}

export function formatBenchmarkOutput(format: OutputFormat, report: BenchmarkReport): string {
  return format === "json"
    ? formatBenchmarkReportAsJson(report)
    : formatBenchmarkReportAsText(report);
}

export function formatPlanOutput(format: OutputFormat, plan: RunPlan): string {
  return format === "json" ? formatPlanAsJson(plan) : formatPlanAsText(plan);
}

export function formatRunResultOutput(
  format: OutputFormat,
  result: RunResult,
  displayMode?: RunResult["mode"] | "run",
  options: { verbose?: boolean } = {},
): string {
  if (format === "json") {
    return formatRunResultAsJson(result);
  }

  const baseOutput =
    displayMode === undefined || displayMode === result.mode
      ? formatRunResultAsText(result)
      : formatRunResultAsText(result).replace(
          new RegExp(`^AIQ ${escapeRegExp(result.mode)}\\n`, "u"),
          `AIQ ${displayMode}\n`,
        );

  if (!options.verbose) {
    return baseOutput;
  }

  return `${baseOutput.trimEnd()}\n${formatVerboseToolRunDetails(collectVerboseToolRuns(result))}`;
}

export function formatFirstRunResultDetails(result: RunResult): string {
  const diagnostics = result.stages.flatMap((stage) =>
    stage.diagnostics.map((diagnostic) => ({ diagnostic, stageId: stage.stageId })),
  );
  if (diagnostics.length === 0) {
    return "";
  }

  return [
    "First-run diagnostics:",
    ...diagnostics.slice(0, 5).map(({ diagnostic, stageId }) => {
      const file = diagnostic.file.length === 0 ? "workspace" : diagnostic.file;
      return `  - ${stageId}/${diagnostic.source}: ${file} - ${diagnostic.message}`;
    }),
    diagnostics.length > 5 ? `  ... ${diagnostics.length - 5} more diagnostic(s)` : undefined,
    "Remediation: fix the listed diagnostics, or run aiq doctor if a tool prerequisite appears to be missing.",
    "",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function formatDryRunOutput(format: OutputFormat, plan: RunPlan): string {
  if (format === "json") {
    return `${JSON.stringify({ dryRun: true, plan }, null, 2)}\n`;
  }

  return [
    "AIQ dry run",
    `Run: ${plan.runId}`,
    `Context: ${plan.context}`,
    `Profile: ${plan.profile}`,
    `Files: ${plan.input.summary.fileCount}`,
    `Stages: ${plan.stages.length === 0 ? "none configured yet" : plan.stages.join(", ")}`,
    `Tasks: ${plan.summary.taskCount}`,
    "No tools executed and no artifacts written.",
    "",
  ].join("\n");
}

export function formatDoctorOutput(format: OutputFormat, output: DoctorCommandOutput): string {
  if (format === "json") {
    return `${JSON.stringify(output, null, 2)}\n`;
  }

  return [
    "AIQ doctor",
    `Config: ${output.configPath ?? "defaults"}`,
    `Progress: ${output.progressPath} (${output.progressSource})`,
    `Profile: ${output.profile}`,
    `Stages: ${output.stages.join(", ")}`,
    `Technologies: ${output.detectedTech.length === 0 ? "none detected" : output.detectedTech.join(", ")}`,
    ...output.checks.map(
      (check) =>
        `${formatDoctorCheckStatus(check)} ${check.name}${check.detail === undefined ? "" : ` - ${check.detail}`}`,
    ),
    `Status: ${output.ok ? "passed" : "failed"}`,
    "",
  ].join("\n");
}

export function formatFirstRunDetectionOutput(
  format: OutputFormat,
  output: FirstRunDetectionOutput,
): string {
  if (format === "json") {
    return `${JSON.stringify({ firstRun: output }, null, 2)}\n`;
  }

  return [
    "AIQ first run",
    `Detected project: ${output.detectedProjects.join(", ")}`,
    `Target: ${output.target}`,
    `Stages: ${output.stages.join(", ")}`,
    `${output.configCreated ? "Wrote" : "Found"} config: ${output.configPath}`,
    `${output.progressCreated ? "Wrote" : "Found"} progress: ${output.progressPath}`,
    ...(output.truncated
      ? [
          "Warning: first-run input collection reached its safety limit; pass explicit files or configure inputs.ignore for full control.",
        ]
      : []),
    ...output.warnings.map((warning) => `Warning: ${warning}`),
    "Change stage: aiq config --set-stage <0-9>",
    "Check missing tools/config: aiq doctor",
    "Run a specific path: aiq run <files...>",
    "",
  ].join("\n");
}

export function formatFirstRunSetupOutput(
  format: OutputFormat,
  output: FirstRunSetupOutput,
): string {
  if (format === "json") {
    return `${JSON.stringify({ firstRun: output }, null, 2)}\n`;
  }

  return [
    "AIQ first run",
    output.summary,
    `Current directory: ${output.cwd}`,
    output.remediation,
    `Supported markers: ${output.markers.join(", ")}`,
    "Examples:",
    ...output.examples.map((example) => `  ${example}`),
    "",
  ].join("\n");
}

function formatDoctorCheckStatus(check: DoctorCheckOutput): "INFO" | "MISSING" | "OK" {
  if (check.source === "bundled" || check.source === "project") {
    return "INFO";
  }

  if (check.ok) {
    return check.detail?.startsWith("not detected;") ? "INFO" : "OK";
  }

  return "MISSING";
}

export function formatSetupGuidanceOutput(
  format: OutputFormat,
  output: SetupGuidanceOutput,
): string {
  if (format === "json") {
    return `${JSON.stringify(output, null, 2)}\n`;
  }

  return [`AIQ ${output.requested}`, output.summary, output.replacement, ""].join("\n");
}

export function formatConfigOutput(format: OutputFormat, output: ConfigCommandOutput): string {
  if (format === "json") {
    return `${JSON.stringify(output, null, 2)}\n`;
  }

  const configPath = output.configPath ?? "defaults";
  return [
    "AIQ config",
    `Config: ${configPath}`,
    `Progress: ${output.progressPath} (${output.progressSource})`,
    `Current stage: ${formatProgressStage(output.progress)}`,
    `Profile: ${output.profile}`,
    `Stages: ${output.stages.join(", ")}`,
    "",
  ].join("\n");
}

export function formatConfigInitOutput(format: OutputFormat, output: ConfigInitOutput): string {
  if (format === "json") {
    return `${JSON.stringify(output, null, 2)}\n`;
  }

  return [
    "AIQ config initialized",
    `${output.configCreated ? "Wrote" : "Found"} config: ${output.configPath}`,
    `${output.progressCreated ? "Wrote" : "Found"} progress: ${output.progressPath}`,
    "",
  ].join("\n");
}

export function formatConfigStageOutput(format: OutputFormat, output: ConfigStageOutput): string {
  if (format === "json") {
    return `${JSON.stringify(output, null, 2)}\n`;
  }

  return `Set current_stage=${output.current_stage} in ${output.progressPath}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function collectVerboseToolRuns(result: RunResult): VerboseToolRunDetail[] {
  return result.stages.flatMap((stage) =>
    stage.toolRuns.map((toolRun) => toVerboseToolRunDetail(stage.stageId, toolRun)),
  );
}

function toVerboseToolRunDetail(stageId: StageId, toolRun: ToolRunResult): VerboseToolRunDetail {
  return {
    args: toolRun.args,
    ...(toolRun.exitCode === undefined ? {} : { exitCode: toolRun.exitCode }),
    stageId,
    status: toolRun.status,
    tool: toolRun.tool,
  };
}

function formatVerboseToolRunDetails(details: VerboseToolRunDetail[]): string {
  if (details.length === 0) {
    return "Verbose tool details:\n  No tool commands were executed.\n";
  }

  return [
    "Verbose tool details:",
    ...details.map((detail) => {
      const command = [detail.tool, ...detail.args].join(" ");
      const exitCode = detail.exitCode === undefined ? "n/a" : String(detail.exitCode);
      return `  - ${detail.stageId}: ${command} [status=${detail.status}, exit=${exitCode}]`;
    }),
    "",
  ].join("\n");
}

function formatProgressStage(progress: unknown): string {
  if (
    typeof progress === "object" &&
    progress !== null &&
    "current_stage" in progress &&
    typeof progress.current_stage === "number"
  ) {
    return String(progress.current_stage);
  }

  return "unknown";
}

export function writeWatchOutput(
  io: CliIo,
  format: OutputFormat,
  trigger: string,
  result: RunResult,
): void {
  if (format === "json") {
    const payload: WatchRunEnvelope = {
      event: "run",
      result,
      trigger,
    };
    io.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }

  const body = formatRunResultAsText(result).trimEnd();
  io.stdout.write(`AIQ watch (${trigger})\n${body}\n`);
}

export function writeServeListeningOutput(
  io: CliIo,
  format: OutputFormat,
  host: string,
  port: number,
): void {
  const url = `http://${formatServeHost(host)}:${port}`;
  if (format === "json") {
    const payload: ServeListeningEnvelope = {
      event: "listening",
      host,
      port,
      url,
    };
    io.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }

  io.stdout.write(`AIQ serve listening on ${url}\n`);
}

function formatServeHost(host: string): string {
  if (host.startsWith("[") || !host.includes(":")) {
    return host;
  }

  return `[${host}]`;
}
