import path from "node:path";

import { type Plugin, tool } from "@opencode-ai/plugin";
import {
  type AiqProfileName,
  type AiqProgressRunSelection,
  type ResolvedAiqConfig,
  type RunPlan,
  type RunRequest,
  type RunResult,
  type RunStageConfigurations,
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

export interface AiqOpenCodeAdapterOptions {
  cwd?: string;
  stages?: readonly StageId[];
  profile?: AiqProfileName;
  resolveConfigImpl?: typeof resolveAiqConfig;
  runEngineImpl?: typeof runEngine;
  writeArtifacts?: boolean;
}

export interface AiqOpenCodeRunOptions {
  cwd?: string;
  files: readonly string[];
  outDir?: string;
  stages?: readonly string[];
  profile?: string;
  signal?: AbortSignal;
}

export interface AiqOpenCodeCheckResult {
  diagnostics: RunResult["stages"][number]["diagnostics"];
  files: string[];
  ok: boolean;
  planPath?: string;
  publishDiagnostics: boolean;
  report: RunResult;
  reportPath?: string;
  text: string;
  workflow?: AiqProgressRunSelection;
}

export interface AiqOpenCodePlanResult {
  files: string[];
  plan: RunPlan;
  text: string;
  workflow?: AiqProgressRunSelection;
}

export interface AiqOpenCodeStatusResult {
  cwd: string;
  profile: AiqProfileName;
  stages: StageId[];
  text: string;
  workflow?: AiqProgressRunSelection;
}

export interface AiqOpenCodePluginContext {
  directory: string;
  worktree?: string | null;
}

export interface AiqOpenCodeToolContext {
  directory?: string;
  signal?: AbortSignal;
  worktree?: string | null;
}

interface ResolvedOpenCodeSelection {
  cwd: string;
  stages: StageId[];
  stageConfigurations?: RunStageConfigurations;
  profile: AiqProfileName;
  publishDiagnostics: boolean;
  workflow?: AiqProgressRunSelection;
}

export class AiqOpenCodeAdapter {
  private readonly cwd: string;

  private readonly stages: readonly StageId[] | undefined;

  private readonly profile: AiqProfileName | undefined;

  private readonly resolveConfigImpl: typeof resolveAiqConfig;

  private readonly runEngineImpl: typeof runEngine;

  private readonly writeArtifacts: boolean;

  constructor(options: AiqOpenCodeAdapterOptions = {}) {
    this.cwd = path.resolve(options.cwd ?? process.cwd());
    this.stages = options.stages;
    this.profile = options.profile;
    this.resolveConfigImpl = options.resolveConfigImpl ?? resolveAiqConfig;
    this.runEngineImpl = options.runEngineImpl ?? runEngine;
    this.writeArtifacts = options.writeArtifacts ?? false;
  }

  async run(options: AiqOpenCodeRunOptions): Promise<AiqOpenCodeCheckResult> {
    const cwd = path.resolve(options.cwd ?? this.cwd);
    const files = normalizeExplicitFiles(cwd, options.files);
    if (files.length === 0) {
      throw new Error("OpenCode AIQ checks require at least one file.");
    }

    const selection = await this.resolveSelection(cwd, options);
    const report = await this.runEngineImpl({
      context: "opencode",
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

    const diagnostics = selection.publishDiagnostics
      ? report.stages.flatMap((stage) => stage.diagnostics)
      : [];

    return {
      diagnostics,
      files,
      ok: report.ok,
      ...(report.artifacts.planPath === undefined ? {} : { planPath: report.artifacts.planPath }),
      publishDiagnostics: selection.publishDiagnostics,
      report,
      ...(report.artifacts.reportPath === undefined
        ? {}
        : { reportPath: report.artifacts.reportPath }),
      text: formatAiqOpenCodeResult(report, selection.publishDiagnostics),
      ...(selection.workflow === undefined ? {} : { workflow: selection.workflow }),
    };
  }

  async plan(options: AiqOpenCodeRunOptions): Promise<AiqOpenCodePlanResult> {
    const cwd = path.resolve(options.cwd ?? this.cwd);
    const files = normalizeExplicitFiles(cwd, options.files);
    if (files.length === 0) {
      throw new Error("OpenCode AIQ plans require at least one file.");
    }

    const selection = await this.resolveSelection(cwd, options);
    const plan = await createRunPlan(this.createRunRequest(selection, files, "plan", options));
    return {
      files,
      plan,
      text: formatOpenCodePlanText(plan),
      ...(selection.workflow === undefined ? {} : { workflow: selection.workflow }),
    };
  }

  async status(options: { cwd?: string } = {}): Promise<AiqOpenCodeStatusResult> {
    const selection = await this.resolveSelection(path.resolve(options.cwd ?? this.cwd), {});
    return {
      cwd: selection.cwd,
      profile: selection.profile,
      stages: selection.stages,
      text: formatOpenCodeStatusText(selection),
      ...(selection.workflow === undefined ? {} : { workflow: selection.workflow }),
    };
  }

  private createRunRequest(
    selection: ResolvedOpenCodeSelection,
    files: readonly string[],
    mode: RunRequest["mode"],
    options: Pick<AiqOpenCodeRunOptions, "outDir" | "signal">,
  ): RunRequest {
    return {
      context: "opencode",
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
    options: Pick<AiqOpenCodeRunOptions, "stages" | "profile">,
  ): Promise<ResolvedOpenCodeSelection> {
    const adapterStages =
      this.stages === undefined || this.stages.length === 0 ? undefined : [...this.stages];
    const adapterProfile = this.profile;
    const optionStages = normalizeStageOverride(options.stages, "OpenCode stages");
    const optionProfile = normalizeProfileOverride(options.profile, "OpenCode profile");
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
      surface: "opencode",
    });

    return {
      ...mapResolvedSelection(resolved),
      ...(progress === undefined
        ? {}
        : { workflow: createAiqProgressRunSelection(progress, resolved.stages) }),
    };
  }
}

export async function runAiqOpenCodeCheck(
  options: AiqOpenCodeRunOptions,
  adapterOptions?: AiqOpenCodeAdapterOptions,
): Promise<AiqOpenCodeCheckResult> {
  return new AiqOpenCodeAdapter(adapterOptions).run(options);
}

export async function buildAiqOpenCodeHooks(
  context: AiqOpenCodePluginContext,
  options: AiqOpenCodeAdapterOptions = {},
): Promise<Awaited<ReturnType<Plugin>>> {
  const adapter = new AiqOpenCodeAdapter({
    ...options,
    cwd: context.worktree ?? context.directory,
  });

  return {
    tool: {
      aiq_check_files: tool({
        description:
          "Run AIQ checks for explicit files. Defaults to current-stage cumulative stages when .qube/aiq/progress.json is present.",
        args: {
          files: tool.schema.array(tool.schema.string()).min(1),
          outDir: tool.schema.string().optional(),
          stages: tool.schema.array(tool.schema.string()).optional(),
          profile: tool.schema.string().optional(),
        },
        async execute(
          args: { files: string[]; outDir?: string; stages?: string[]; profile?: string },
          toolContext: AiqOpenCodeToolContext,
        ) {
          const result = await adapter.run({
            cwd:
              toolContext.worktree ??
              toolContext.directory ??
              context.worktree ??
              context.directory,
            files: args.files,
            ...(args.outDir === undefined ? {} : { outDir: args.outDir }),
            ...(args.stages === undefined ? {} : { stages: args.stages }),
            ...(args.profile === undefined ? {} : { profile: args.profile }),
            ...(toolContext.signal === undefined ? {} : { signal: toolContext.signal }),
          });

          return result.text;
        },
      }),
      aiq_plan_files: tool({
        description: "Plan AIQ checks for explicit files without executing tools.",
        args: {
          files: tool.schema.array(tool.schema.string()).min(1),
          outDir: tool.schema.string().optional(),
          stages: tool.schema.array(tool.schema.string()).optional(),
          profile: tool.schema.string().optional(),
        },
        async execute(
          args: { files: string[]; outDir?: string; stages?: string[]; profile?: string },
          toolContext: AiqOpenCodeToolContext,
        ) {
          const result = await adapter.plan({
            cwd:
              toolContext.worktree ??
              toolContext.directory ??
              context.worktree ??
              context.directory,
            files: args.files,
            ...(args.outDir === undefined ? {} : { outDir: args.outDir }),
            ...(args.stages === undefined ? {} : { stages: args.stages }),
            ...(args.profile === undefined ? {} : { profile: args.profile }),
            ...(toolContext.signal === undefined ? {} : { signal: toolContext.signal }),
          });

          return result.text;
        },
      }),
      aiq_status: tool({
        description: "Report AIQ stage/profile status and current-stage defaults.",
        args: {},
        async execute(_args: Record<string, never>, toolContext: AiqOpenCodeToolContext) {
          const result = await adapter.status({
            cwd:
              toolContext.worktree ??
              toolContext.directory ??
              context.worktree ??
              context.directory,
          });
          return result.text;
        },
      }),
      aiq_doctor: tool({
        description: "Validate AIQ OpenCode config/progress stage selection.",
        args: {},
        async execute(_args: Record<string, never>, toolContext: AiqOpenCodeToolContext) {
          const result = await adapter.status({
            cwd:
              toolContext.worktree ??
              toolContext.directory ??
              context.worktree ??
              context.directory,
          });
          return `AIQ doctor\n${result.text}\nStatus: passed`;
        },
      }),
    },
  };
}

export function createAiqOpenCodePlugin(options: AiqOpenCodeAdapterOptions = {}): Plugin {
  return async (context) =>
    buildAiqOpenCodeHooks(
      {
        directory: context.directory,
        ...(context.worktree === undefined ? {} : { worktree: context.worktree }),
      },
      options,
    );
}

export const AiqOpenCodePlugin: Plugin = createAiqOpenCodePlugin();

export function formatAiqOpenCodeResult(result: RunResult, publishDiagnostics: boolean): string {
  const base = formatRunResultAsText(result).trimEnd();
  if (publishDiagnostics) {
    return base;
  }

  return `${base}\nDiagnostics are hidden because surfaces.opencode.publishDiagnostics=false.`;
}

function mapResolvedSelection(resolved: ResolvedAiqConfig): ResolvedOpenCodeSelection {
  return {
    cwd: resolved.cwd,
    stages: [...resolved.stages] as StageId[],
    ...(resolved.stageConfigurations === undefined
      ? {}
      : { stageConfigurations: resolved.stageConfigurations }),
    profile: resolved.profile,
    publishDiagnostics: resolved.publishDiagnostics,
  };
}

function formatOpenCodePlanText(plan: RunPlan): string {
  return [
    "AIQ plan",
    `Profile: ${plan.profile}`,
    `Stages: ${plan.stages.length === 0 ? "none configured yet" : plan.stages.join(", ")}`,
    `Files: ${plan.summary.fileCount}`,
    `Tasks: ${plan.summary.taskCount}`,
  ].join("\n");
}

function formatOpenCodeStatusText(selection: ResolvedOpenCodeSelection): string {
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
