import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  type AiqProfileName,
  type ResolvedAiqConfig,
  type RunPlan,
  type RunRequest,
  type RunResult,
  type StageId,
  aiqProfileNames,
  createAiqProgressRunSelection,
  createRunPlan,
  formatRunResultAsText,
  loadAiqProgress,
  resolveAiqConfig,
  resolveAiqProgressStageIds,
  runEngine,
  stageIds,
} from "@tjalve/aiq/api";
import type {
  AiqMcpCheckOptions,
  AiqMcpCheckResult,
  AiqMcpExplainOptions,
  AiqMcpExplainResult,
  AiqMcpPlanResult,
  AiqMcpServerOptions,
  AiqMcpStatusResult,
  ResolvedMcpSelection,
} from "./types.js";

interface ResolvedMcpAdapterDependencies {
  cwd: string;
  profile: AiqProfileName | undefined;
  readFileImpl: typeof readFile;
  resolveConfigImpl: typeof resolveAiqConfig;
  runEngineImpl: typeof runEngine;
  stages: readonly StageId[] | undefined;
  writeArtifacts: boolean;
}

export class AiqMcpAdapter {
  private readonly cwd: string;

  private readonly stages: readonly StageId[] | undefined;

  private readonly profile: AiqProfileName | undefined;

  private readonly readFileImpl: typeof readFile;

  private readonly resolveConfigImpl: typeof resolveAiqConfig;

  private readonly runEngineImpl: typeof runEngine;

  private readonly writeArtifacts: boolean;

  constructor(options: AiqMcpServerOptions = {}) {
    const dependencies = resolveMcpAdapterDependencies(options);
    this.cwd = dependencies.cwd;
    this.stages = dependencies.stages;
    this.profile = dependencies.profile;
    this.readFileImpl = dependencies.readFileImpl;
    this.resolveConfigImpl = dependencies.resolveConfigImpl;
    this.runEngineImpl = dependencies.runEngineImpl;
    this.writeArtifacts = dependencies.writeArtifacts;
  }

  async check(options: AiqMcpCheckOptions): Promise<AiqMcpCheckResult> {
    const cwd = path.resolve(options.cwd ?? this.cwd);
    const files = normalizeExplicitFiles(cwd, options.files);
    if (files.length === 0) {
      throw new Error("MCP AIQ checks require at least one file.");
    }

    const selection = await this.resolveSelection(cwd, options);
    const report = await this.runEngineImpl({
      context: "mcp",
      cwd: selection.cwd,
      manifest: {
        files,
        source: "direct",
      },
      mode: "check",
      ...(options.outDir === undefined ? {} : { outDir: options.outDir }),
      stages: selection.stages,
      ...(selection.stageConfigurations === undefined
        ? {}
        : { stageConfigurations: selection.stageConfigurations }),
      profile: selection.profile,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      writeArtifacts: this.writeArtifacts,
    });

    return {
      files,
      ok: report.ok,
      ...(report.artifacts.planPath === undefined ? {} : { planPath: report.artifacts.planPath }),
      report,
      ...(report.artifacts.reportPath === undefined
        ? {}
        : { reportPath: report.artifacts.reportPath }),
      text: formatRunResultAsText(report).trimEnd(),
      ...(selection.workflow === undefined ? {} : { workflow: selection.workflow }),
    };
  }

  async plan(options: AiqMcpCheckOptions): Promise<AiqMcpPlanResult> {
    const cwd = path.resolve(options.cwd ?? this.cwd);
    const files = normalizeExplicitFiles(cwd, options.files);
    if (files.length === 0) {
      throw new Error("MCP AIQ plans require at least one file.");
    }

    const selection = await this.resolveSelection(cwd, options);
    const request = this.createRunRequest(selection, files, "plan", options);
    const plan = await createRunPlan(request);
    return {
      files,
      plan,
      text: formatMcpPlanText(plan),
      ...(selection.workflow === undefined ? {} : { workflow: selection.workflow }),
    };
  }

  async status(options: { cwd?: string } = {}): Promise<AiqMcpStatusResult> {
    const cwd = path.resolve(options.cwd ?? this.cwd);
    const selection = await this.resolveSelection(cwd, {});
    return {
      cwd: selection.cwd,
      profile: selection.profile,
      stages: selection.stages,
      text: formatMcpStatusText(selection),
      ...(selection.workflow === undefined ? {} : { workflow: selection.workflow }),
    };
  }

  async explain(options: AiqMcpExplainOptions): Promise<AiqMcpExplainResult> {
    assertExplainOptions(options);
    const cwd = path.resolve(options.cwd ?? this.cwd);
    const reportPath = normalizeOptionalString(options.reportPath);
    const report =
      reportPath === undefined
        ? (
            await this.check({
              files: options.files ?? [],
              ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
              ...(options.outDir === undefined ? {} : { outDir: options.outDir }),
              ...(options.stages === undefined ? {} : { stages: options.stages }),
              ...(options.profile === undefined ? {} : { profile: options.profile }),
              ...(options.signal === undefined ? {} : { signal: options.signal }),
            })
          ).report
        : await this.readReportArtifact(path.resolve(cwd, reportPath));

    return {
      diagnosticCount: report.summary.diagnosticCount,
      report,
      ...(report.artifacts.reportPath === undefined
        ? {}
        : { reportPath: report.artifacts.reportPath }),
      text: formatDiagnosticExplanation(report),
    };
  }

  private async readReportArtifact(reportPath: string): Promise<RunResult> {
    let report: Partial<RunResult>;

    try {
      report = JSON.parse(await this.readFileImpl(reportPath, "utf8")) as Partial<RunResult>;
    } catch (error) {
      throw new Error(
        `Failed to read AIQ report artifact at ${reportPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (report.artifactType !== "report") {
      throw new Error(`Expected an AIQ report artifact at ${reportPath}.`);
    }

    return report as RunResult;
  }

  private createRunRequest(
    selection: ResolvedMcpSelection,
    files: readonly string[],
    mode: RunRequest["mode"],
    options: Pick<AiqMcpCheckOptions, "outDir" | "signal">,
  ): RunRequest {
    return {
      context: "mcp",
      cwd: selection.cwd,
      manifest: {
        files,
        source: "direct",
      },
      mode,
      ...(options.outDir === undefined ? {} : { outDir: options.outDir }),
      stages: selection.stages,
      ...(selection.stageConfigurations === undefined
        ? {}
        : { stageConfigurations: selection.stageConfigurations }),
      profile: selection.profile,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      writeArtifacts: this.writeArtifacts,
    };
  }

  private async resolveSelection(
    cwd: string,
    options: Pick<AiqMcpCheckOptions, "stages" | "profile">,
  ): Promise<ResolvedMcpSelection> {
    const adapterStages =
      this.stages === undefined || this.stages.length === 0 ? undefined : [...this.stages];
    const adapterProfile = this.profile;
    const optionStages = normalizeStageOverride(options.stages, "MCP stages");
    const optionProfile = normalizeProfileOverride(options.profile, "MCP profile");
    const progress =
      adapterStages === undefined &&
      adapterProfile === undefined &&
      optionStages === undefined &&
      optionProfile === undefined
        ? await loadFileBackedProgress(cwd)
        : undefined;
    const resolved = await this.resolveConfigImpl({
      cwd,
      ...(adapterStages === undefined
        ? progress === undefined
          ? {}
          : { stages: resolveAiqProgressStageIds(progress.progress.current_stage) }
        : { stages: adapterStages }),
      ...(adapterProfile === undefined ? {} : { profile: adapterProfile }),
      ...(optionStages === undefined ? {} : { stages: optionStages }),
      ...(optionProfile === undefined ? {} : { profile: optionProfile }),
      surface: "mcp",
    });

    return {
      ...mapResolvedSelection(resolved),
      ...(progress === undefined
        ? {}
        : { workflow: createAiqProgressRunSelection(progress, resolved.stages) }),
    };
  }
}

function resolveMcpAdapterDependencies(
  options: AiqMcpServerOptions,
): ResolvedMcpAdapterDependencies {
  return {
    cwd: path.resolve(withDefault(options.cwd, process.cwd())),
    profile: options.profile,
    readFileImpl: withDefault(options.readFileImpl, readFile),
    resolveConfigImpl: withDefault(options.resolveConfigImpl, resolveAiqConfig),
    runEngineImpl: withDefault(options.runEngineImpl, runEngine),
    stages: options.stages,
    writeArtifacts: withDefault(options.writeArtifacts, false),
  };
}

function withDefault<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

export async function runAiqMcpCheck(
  options: AiqMcpCheckOptions,
  adapterOptions?: AiqMcpServerOptions,
): Promise<AiqMcpCheckResult> {
  return new AiqMcpAdapter(adapterOptions).check(options);
}

export async function explainAiqMcpDiagnostics(
  options: AiqMcpExplainOptions,
  adapterOptions?: AiqMcpServerOptions,
): Promise<AiqMcpExplainResult> {
  return new AiqMcpAdapter(adapterOptions).explain(options);
}

export function formatDiagnosticExplanation(report: RunResult): string {
  if (report.summary.diagnosticCount === 0) {
    return "AIQ found no diagnostics.";
  }

  const lines = [
    `AIQ diagnostics: ${report.summary.diagnosticCount}`,
    `Status: ${report.summary.status}`,
  ];

  for (const stage of report.stages) {
    if (stage.diagnostics.length === 0) {
      continue;
    }

    lines.push(`${stage.stageId}:`);
    for (const diagnostic of stage.diagnostics) {
      const location =
        diagnostic.range === undefined
          ? diagnostic.file
          : `${diagnostic.file}:${diagnostic.range.startLine}:${diagnostic.range.startColumn}`;
      lines.push(`- [${diagnostic.severity}] ${location} ${diagnostic.message}`);
    }
  }

  return lines.join("\n");
}

function assertExplainOptions(options: AiqMcpExplainOptions): void {
  if (normalizeOptionalString(options.reportPath) !== undefined) {
    return;
  }

  if (
    options.files !== undefined &&
    normalizeExplicitFiles(options.cwd ?? process.cwd(), options.files).length > 0
  ) {
    return;
  }

  throw new Error("Provide files or reportPath.");
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function mapResolvedSelection(resolved: ResolvedAiqConfig): ResolvedMcpSelection {
  return {
    cwd: resolved.cwd,
    stages: [...resolved.stages] as StageId[],
    ...(resolved.stageConfigurations === undefined
      ? {}
      : { stageConfigurations: resolved.stageConfigurations }),
    profile: resolved.profile,
  };
}

function formatMcpPlanText(plan: RunPlan): string {
  return [
    "AIQ plan",
    `Profile: ${plan.profile}`,
    `Stages: ${plan.stages.length === 0 ? "none configured yet" : plan.stages.join(", ")}`,
    `Files: ${plan.summary.fileCount}`,
    `Tasks: ${plan.summary.taskCount}`,
  ].join("\n");
}

function formatMcpStatusText(selection: ResolvedMcpSelection): string {
  return [
    "AIQ status",
    `Profile: ${selection.profile}`,
    `Stages: ${selection.stages.length === 0 ? "none configured yet" : selection.stages.join(", ")}`,
    selection.workflow === undefined
      ? undefined
      : `Current stage: ${selection.workflow.currentStage.index} ${selection.workflow.currentStage.id}`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

async function loadFileBackedProgress(cwd: string) {
  const progress = await loadAiqProgress(cwd);
  return progress.source === "file" ? progress : undefined;
}

function normalizeExplicitFiles(cwd: string, files: readonly string[]): string[] {
  const normalized = new Set<string>();

  for (const file of files.map((entry) => entry.trim()).filter((entry) => entry.length > 0)) {
    normalized.add(path.resolve(cwd, file));
  }

  return [...normalized].sort();
}

function parseStageList(values: readonly string[], label: string): StageId[] {
  const unique = new Set<StageId>();
  const stages: StageId[] = [];

  for (const value of values.map((entry) => entry.trim()).filter((entry) => entry.length > 0)) {
    if (!stageIds.includes(value as StageId)) {
      throw new Error(`${label} contains unsupported stage '${value}'.`);
    }

    const stage = value as StageId;
    if (!unique.has(stage)) {
      unique.add(stage);
      stages.push(stage);
    }
  }

  return stages;
}

function normalizeStageOverride(values: readonly string[] | undefined, label: string) {
  if (values === undefined) {
    return undefined;
  }

  const stages = parseStageList(values, label);
  return stages.length === 0 ? undefined : stages;
}

function normalizeProfileOverride(value: string | undefined, label: string) {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0
    ? undefined
    : parseProfile(normalized, label);
}

function parseProfile(value: string, label: string): AiqProfileName {
  const normalized = value.trim();
  if (!aiqProfileNames.includes(normalized as AiqProfileName)) {
    throw new Error(`${label} must be one of ${aiqProfileNames.join(", ")}.`);
  }

  return normalized as AiqProfileName;
}
