import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { runBenchmarkSuite } from "@tjalve/aiq/benchmark";
import {
  initializeAiqProjectConfig,
  loadAiqProgress,
  resolveAiqConfig,
  setAiqProgressStage,
} from "@tjalve/aiq/config";
import {
  createRunPlan,
  resolvePlanArtifactPath,
  resolveReportArtifactPath,
  runEngine,
  writePlanArtifact,
} from "@tjalve/aiq/engine";
import type { LanguageId, RunRequest, RunResult, StageId } from "@tjalve/aiq/model";

import { createAiqQualityEvidence, formatAiqQualityEvidenceJson } from "./evidence.js";
import {
  collectFirstRunManifestFiles,
  createFirstRunSetupGuidance,
  formatFirstRunDetectedProjects,
  inferFirstRunProjects,
  writeFirstRunJsonPrelude,
} from "./first-run.js";
import { detectNativeConfigs, resolveDoctorNativeConfigChecks } from "./native-config.js";
import {
  type DoctorCheckOutput,
  type DoctorCommandOutput,
  type SetupCommandOutput,
  formatBenchmarkOutput,
  formatConfigInitOutput,
  formatConfigOutput,
  formatConfigStageOutput,
  formatDoctorOutput,
  formatDryRunOutput,
  formatFirstRunDetectionOutput,
  formatFirstRunResultDetails,
  formatFirstRunSetupOutput,
  formatPlanOutput,
  formatRunResultOutput,
  formatSetupGuidanceOutput,
  formatSetupOutput,
  formatStatusOutput,
  toWorkflowStageOutput,
} from "./output.js";
import { defaultProjectScopeIgnoredDirectoryNames } from "./project-scope.js";
import { createRunRequest, resolveCliConfig } from "./requests.js";
import { renderAiqCommandSchemaJson } from "./schema.js";
import { formatError, isErrorCode } from "./shared.js";
import {
  type CliIo,
  type ParsedArgs,
  type SetupGuidanceCommand,
  cliStageShortcutIds,
} from "./types.js";
import { createDefaultRunOutput, createRunWorkflowOutput, resolveNextCommand } from "./workflow.js";

const execFileAsync = promisify(execFile);

const doctorPrerequisites = [
  {
    binaries: ["node"],
    install: "Install Node.js 24 or newer from your normal Node version manager.",
    minimumMajor: 24,
    required: true,
    name: "Node.js runtime",
  },
  {
    binaries: ["npm"],
    install: "Install npm with Node.js, or use the package manager configured for this project.",
    required: false,
    name: "npm package manager",
  },
  {
    binaries: ["git"],
    install: "Install Git from your OS package manager or git-scm.com.",
    required: false,
    name: "Git",
  },
] as const satisfies readonly DoctorPrerequisite[];

interface DoctorPrerequisite {
  binaries: readonly string[];
  install: string;
  minimumMajor?: number;
  name: string;
  required: boolean;
}

interface DoctorToolRequirement extends DoctorPrerequisite {
  source: "external";
}

interface DoctorBundledTool {
  detail: string;
  name: string;
  source: "bundled" | "project";
}

const doctorMaxScannedFiles = 2_000;

const doctorLanguageLabels: Record<LanguageId, string> = {
  bash: "Bash",
  css: "CSS",
  documents: "Documents",
  dotnet: ".NET",
  go: "Go",
  hcl: "HCL",
  html: "HTML",
  java: "Java",
  javascript: "JavaScript",
  kotlin: "Kotlin",
  powershell: "PowerShell",
  python: "Python",
  rust: "Rust",
  sql: "SQL",
  terraform: "Terraform",
  typescript: "TypeScript",
  yaml: "YAML",
};

const doctorLanguageOrder: LanguageId[] = [
  "javascript",
  "typescript",
  "python",
  "go",
  "rust",
  "dotnet",
  "java",
  "kotlin",
  "terraform",
  "hcl",
  "bash",
  "powershell",
  "html",
  "css",
  "yaml",
  "sql",
  "documents",
];

export async function runBenchCommand(parsed: ParsedArgs, io: CliIo): Promise<number> {
  try {
    const { report } = await runBenchmarkSuite({
      ...(parsed.benchmarkCorpusRoot === undefined
        ? {}
        : { corpusRoot: parsed.benchmarkCorpusRoot }),
      cwd: io.cwd,
      ...(parsed.benchmarkKinds.length === 0 ? {} : { kinds: parsed.benchmarkKinds }),
      ...(parsed.outDir === undefined ? {} : { outDir: parsed.outDir }),
      ...(parsed.benchmarkScenarioIds.length === 0
        ? {}
        : { scenarioIds: parsed.benchmarkScenarioIds }),
      ...(parsed.benchmarkTags.length === 0 ? {} : { tags: parsed.benchmarkTags }),
    });
    io.stdout.write(formatBenchmarkOutput(parsed.format, report));
    return report.summary.failedBudgetCount === 0 ? 0 : 1;
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return 1;
  }
}

export async function runConfigCommand(parsed: ParsedArgs, io: CliIo): Promise<number> {
  try {
    if (parsed.configSetStage !== undefined) {
      const progress = await setAiqProgressStage(io.cwd, parsed.configSetStage);
      io.stdout.write(
        formatConfigStageOutput(parsed.format, {
          current_stage: progress.progress.current_stage,
          progressPath: progress.path,
        }),
      );
      return 0;
    }

    if (parsed.configPrint) {
      const [resolvedConfig, loadedProgress] = await Promise.all([
        resolveAiqConfig({ cwd: io.cwd, surface: "cli" }),
        loadAiqProgress(io.cwd),
      ]);
      io.stdout.write(
        formatConfigOutput(parsed.format, {
          config: resolvedConfig.config,
          ...(resolvedConfig.configPath === undefined
            ? {}
            : { configPath: resolvedConfig.configPath }),
          progress: loadedProgress.progress,
          progressPath: loadedProgress.path,
          progressSource: loadedProgress.source,
          profile: resolvedConfig.profile,
          stages: resolvedConfig.stages,
        }),
      );
      return 0;
    }

    const result = await initializeAiqProjectConfig(io.cwd);
    io.stdout.write(formatConfigInitOutput(parsed.format, result));
    return 0;
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return 2;
  }
}

export async function runPlanCommand(parsed: ParsedArgs, io: CliIo): Promise<number> {
  let request: RunRequest;
  try {
    request = await createRunRequest(parsed, io, {
      context: "cli",
      includeProgressStage: true,
      mode: "plan",
      surface: "cli",
    });
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return 2;
  }

  try {
    const plan = await createRunPlan(request);
    if (request.writeArtifacts !== false) {
      await writePlanArtifact(plan, plan.artifacts.outDir);
    }
    io.stdout.write(formatPlanOutput(parsed.format, plan));
    return 0;
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return 1;
  }
}

export async function runDoctorCommand(parsed: ParsedArgs, io: CliIo): Promise<number> {
  try {
    const output = await createDoctorCommandOutput(parsed, io);
    io.stdout.write(formatDoctorOutput(parsed.format, output));
    return output.ok ? 0 : 1;
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return 2;
  }
}

export async function runSetupCommand(parsed: ParsedArgs, io: CliIo): Promise<number> {
  try {
    const doctorOutput = await createDoctorCommandOutput(parsed, io);
    const output = createSetupCommandOutput(doctorOutput, parsed);
    io.stdout.write(formatSetupOutput(parsed.format, output));
    return output.ok ? 0 : 1;
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return 2;
  }
}

export async function runStatusCommand(parsed: ParsedArgs, io: CliIo): Promise<number> {
  try {
    const [resolvedConfig, loadedProgress] = await Promise.all([
      resolveCliConfig(parsed, io, {
        includeProgressStage: true,
        surface: "cli",
      }),
      loadAiqProgress(io.cwd),
    ]);
    const reportPath = resolveReportArtifactPath(resolvedConfig.cwd);
    const planPath = resolvePlanArtifactPath(resolvedConfig.cwd);
    const report = await readStatusReport(reportPath);
    const artifactPaths = {
      plan: report.artifactPaths?.plan ?? planPath,
      report: report.artifactPaths?.report ?? reportPath,
    };
    const currentStage = toWorkflowStageOutput(loadedProgress.progress.current_stage);
    const lastRun = report.lastRun;
    const currentStageSatisfied = resolveLastRunCurrentStageSatisfied(lastRun, currentStage);
    io.stdout.write(
      formatStatusOutput(parsed.format, {
        artifactPaths,
        currentStage,
        ...(currentStageSatisfied === undefined ? {} : { currentStageSatisfied }),
        defaultRun: createDefaultRunOutput(loadedProgress.progress.current_stage),
        lastRun,
        nextCommand: resolveNextCommand(
          currentStage,
          lastRun.failedStages,
          lastRun.status,
          currentStageSatisfied,
        ),
        progressLastRun: loadedProgress.progress.last_run,
        progressPath: loadedProgress.path,
        progressSource: loadedProgress.source,
        selectedStages: resolvedConfig.stages,
      }),
    );
    return 0;
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return 2;
  }
}

export function runSetupGuidanceCommand(parsed: ParsedArgs, io: CliIo): number {
  const command = parsed.command as SetupGuidanceCommand;
  const output = createSetupGuidanceOutput(command, parsed.setupSubcommand);
  io.stdout.write(formatSetupGuidanceOutput(parsed.format, output));
  return 0;
}

export function runSchemaCommand(_parsed: ParsedArgs, io: CliIo): number {
  io.stdout.write(renderAiqCommandSchemaJson());
  return 0;
}

export async function runEvidenceCommand(_parsed: ParsedArgs, io: CliIo): Promise<number> {
  try {
    const evidence = await createAiqQualityEvidence(io.cwd);
    io.stdout.write(formatAiqQualityEvidenceJson(evidence));
    return 0;
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return 2;
  }
}

export async function runFirstRunCommand(parsed: ParsedArgs, io: CliIo): Promise<number> {
  let projects: Awaited<ReturnType<typeof inferFirstRunProjects>>;
  try {
    projects = await inferFirstRunProjects(io.cwd);
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return 3;
  }

  if (projects.length === 0) {
    io.stdout.write(formatFirstRunSetupOutput(parsed.format, createFirstRunSetupGuidance(io.cwd)));
    return 2;
  }

  let initialization: Awaited<ReturnType<typeof initializeAiqProjectConfig>>;
  let request: RunRequest;
  try {
    initialization = await initializeAiqProjectConfig(io.cwd);
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return 3;
  }

  let manifestCollection: Awaited<ReturnType<typeof collectFirstRunManifestFiles>>;
  try {
    manifestCollection = await collectFirstRunManifestFiles(io.cwd, projects);
    const firstRunParsed: ParsedArgs = {
      ...parsed,
      command: "run",
      files: manifestCollection.files,
    };
    request = await createRunRequest(firstRunParsed, io, {
      context: "cli",
      includeProgressStage: !initialization.progressCreated,
      mode: "check",
      surface: "cli",
    });
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return 2;
  }

  io.stdout.write(
    formatFirstRunDetectionOutput(parsed.format, {
      configCreated: initialization.configCreated,
      configPath: initialization.configPath,
      detectedProjects: formatFirstRunDetectedProjects(projects, io.cwd),
      progressCreated: initialization.progressCreated,
      progressPath: initialization.progressPath,
      stages: [...(request.stages ?? [])],
      target: ".",
      truncated: manifestCollection.truncated,
      warnings: manifestCollection.warnings,
    }),
  );

  try {
    if (parsed.dryRun) {
      request.writeArtifacts = false;
      const plan = await createRunPlan(request);
      io.stdout.write(formatDryRunOutput(parsed.format, plan));
      return 0;
    }

    const result = await runEngine(request);
    io.stdout.write(
      writeFirstRunJsonPrelude(parsed.format)
        ? formatRunResultOutput(parsed.format, result)
        : formatRunResultOutput(parsed.format, result, "run", { verbose: parsed.verbose }),
    );
    if (parsed.format === "text") {
      io.stdout.write(formatFirstRunResultDetails(result));
    }
    return result.ok ? 0 : 1;
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return 3;
  }
}

export async function runCheckCommand(parsed: ParsedArgs, io: CliIo): Promise<number> {
  const outputCommand = parsed.command === "run" ? "run" : "check";
  let request: RunRequest;
  let loadedProgress: Awaited<ReturnType<typeof loadAiqProgress>> | undefined;
  try {
    request = await createRunRequest(parsed, io, {
      context: "cli",
      includeProgressStage: true,
      mode: "check",
      surface: "cli",
    });
    loadedProgress = await loadOptionalRunProgress(parsed, io);
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return 2;
  }

  try {
    if (parsed.dryRun) {
      request.writeArtifacts = false;
      const plan = await createRunPlan(request);
      io.stdout.write(formatDryRunOutput(parsed.format, plan));
      return 0;
    }

    const result = await runEngine(request);
    io.stdout.write(
      formatRunResultOutput(parsed.format, result, outputCommand, {
        verbose: parsed.verbose,
        ...(loadedProgress === undefined
          ? {}
          : { workflow: createRunWorkflowOutput(loadedProgress, request, result) }),
      }),
    );
    return result.ok ? 0 : 1;
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return 1;
  }
}

type StatusLastRun = Parameters<typeof formatStatusOutput>[1]["lastRun"];

async function readStatusReport(reportPath: string): Promise<{
  artifactPaths?: {
    plan?: string;
    report?: string;
  };
  lastRun: StatusLastRun;
}> {
  let rawReport: string;
  try {
    rawReport = await readFile(reportPath, "utf8");
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return {
        lastRun: {
          failedStages: [],
          stages: [],
          status: "none",
        },
      };
    }

    return {
      lastRun: {
        failedStages: [],
        stages: [],
        status: "unreadable",
      },
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(rawReport);
  } catch {
    return {
      lastRun: {
        failedStages: [],
        stages: [],
        status: "unreadable",
      },
    };
  }

  if (!isRecord(value)) {
    return {
      lastRun: {
        failedStages: [],
        stages: [],
        status: "unreadable",
      },
    };
  }

  const status = readRunStatus(value);
  if (status === undefined) {
    return {
      lastRun: {
        failedStages: [],
        stages: [],
        status: "unreadable",
      },
    };
  }

  const runId = typeof value.runId === "string" ? value.runId : undefined;
  const finishedAt = typeof value.finishedAt === "string" ? value.finishedAt : undefined;
  const artifacts = isRecord(value.artifacts) ? value.artifacts : {};
  const planPath = typeof artifacts.planPath === "string" ? artifacts.planPath : undefined;
  const actualReportPath =
    typeof artifacts.reportPath === "string" ? artifacts.reportPath : undefined;
  const artifactPaths =
    planPath === undefined && actualReportPath === undefined
      ? undefined
      : {
          ...(planPath === undefined ? {} : { plan: planPath }),
          ...(actualReportPath === undefined ? {} : { report: actualReportPath }),
        };

  return {
    ...(artifactPaths === undefined ? {} : { artifactPaths }),
    lastRun: {
      failedStages: readFailedStages(value),
      ...(finishedAt === undefined ? {} : { finishedAt }),
      ...(runId === undefined ? {} : { runId }),
      stages: readStageStatuses(value),
      status,
    },
  };
}

async function loadOptionalRunProgress(
  parsed: ParsedArgs,
  io: CliIo,
): Promise<Awaited<ReturnType<typeof loadAiqProgress>> | undefined> {
  try {
    return await loadAiqProgress(io.cwd);
  } catch (error) {
    if (parsed.stages.length > 0 || parsed.profile !== undefined) {
      return undefined;
    }

    throw error;
  }
}

function readRunStatus(value: Record<string, unknown>): StatusLastRun["status"] | undefined {
  const summary = value.summary;
  if (!isRecord(summary)) {
    return undefined;
  }

  switch (summary.status) {
    case "failed":
    case "not_implemented":
    case "passed":
      return summary.status;
    default:
      return undefined;
  }
}

function readFailedStages(value: Record<string, unknown>) {
  return readStageStatuses(value)
    .filter((stage) => stage.status !== "passed")
    .map((stage) => stage.stage);
}

function readStageStatuses(value: Record<string, unknown>) {
  if (!Array.isArray(value.stages)) {
    return [];
  }

  return value.stages
    .filter((stage): stage is Record<string, unknown> => isRecord(stage))
    .map((stage) => {
      const stageId = typeof stage.stageId === "string" ? stage.stageId : undefined;
      const status = readStageStatus(stage.status);
      return stageId === undefined || !isStageId(stageId) || status === undefined
        ? undefined
        : {
            stage: toWorkflowStageOutput(resolveStageIndex(stageId)),
            status,
          };
    })
    .filter((stage): stage is NonNullable<typeof stage> => stage !== undefined);
}

function resolveLastRunCurrentStageSatisfied(
  lastRun: StatusLastRun,
  currentStage: ReturnType<typeof toWorkflowStageOutput>,
): boolean | undefined {
  const stage = lastRun.stages.find((candidate) => candidate.stage.id === currentStage.id);
  return stage === undefined ? undefined : stage.status === "passed";
}

function readStageStatus(value: unknown): "failed" | "not_implemented" | "passed" | undefined {
  switch (value) {
    case "failed":
    case "not_implemented":
    case "passed":
      return value;
    default:
      return undefined;
  }
}

async function createDoctorCommandOutput(
  parsed: ParsedArgs,
  io: CliIo,
): Promise<DoctorCommandOutput> {
  const [resolvedConfig, loadedProgress, detectedLanguages, nativeConfigs] = await Promise.all([
    resolveCliConfig(parsed, io, {
      includeProgressStage: true,
      surface: "cli",
    }),
    loadAiqProgress(io.cwd),
    detectProjectLanguages(io.cwd),
    detectNativeConfigs(io.cwd),
  ]);
  const externalRequirements = resolveDoctorToolRequirements(
    detectedLanguages,
    resolvedConfig.stages,
  );
  const prerequisites = mergeDoctorPrerequisites(doctorPrerequisites, externalRequirements);
  const prerequisiteChecks = await Promise.all(
    prerequisites.map(async (prerequisite) => {
      const installed = await resolveInstalledCommand(prerequisite.binaries, {
        includeVersion: parsed.verbose,
      });
      const versionProblem =
        installed === undefined ? undefined : validateDoctorPrerequisiteVersion(prerequisite);
      return {
        detail:
          versionProblem ??
          installed ??
          (prerequisite.required
            ? `not detected; ${prerequisite.install}`
            : `not detected; ${prerequisite.install}`),
        install: prerequisite.install,
        name: prerequisite.name,
        ok: installed !== undefined && versionProblem === undefined ? true : !prerequisite.required,
        required: prerequisite.required,
        source: "source" in prerequisite ? prerequisite.source : "external",
      };
    }),
  );
  const bundledChecks = resolveDoctorBundledTools(detectedLanguages, resolvedConfig.stages).map(
    (tool) => ({
      detail: tool.detail,
      name: tool.name,
      ok: true,
      required: false,
      source: tool.source,
    }),
  );
  const checks = [
    {
      detail: resolvedConfig.configPath ?? "using built-in defaults",
      name: "Config is valid",
      ok: true,
    },
    {
      detail: `${loadedProgress.path} (${loadedProgress.source})`,
      name: "Progress state is valid",
      ok: true,
    },
    ...resolveDoctorNativeConfigChecks(detectedLanguages, resolvedConfig.stages, nativeConfigs),
    ...prerequisiteChecks,
    ...bundledChecks,
  ];

  return {
    checks,
    ...(resolvedConfig.configPath === undefined ? {} : { configPath: resolvedConfig.configPath }),
    cwd: resolvedConfig.cwd,
    detectedTech: formatDetectedLanguages(detectedLanguages),
    ok: checks.every((check) => check.ok),
    progressPath: loadedProgress.path,
    progressSource: loadedProgress.source,
    profile: resolvedConfig.profile,
    stages: resolvedConfig.stages,
  };
}

function createSetupCommandOutput(
  doctorOutput: DoctorCommandOutput,
  parsed: ParsedArgs,
): SetupCommandOutput {
  const toolChecks = doctorOutput.checks.filter(isToolSetupCheck);
  const missingPrerequisites = toolChecks.filter((check) => check.required && !check.ok);
  const stageFlags = formatStageSelectionFlags(parsed);
  const doctorCommand =
    stageFlags.length === 0 ? "aiq doctor" : `aiq doctor ${stageFlags.join(" ")}`;
  const rerunCommand = stageFlags.length === 0 ? "aiq" : `aiq ${stageFlags.join(" ")}`;
  return {
    actions: toolChecks.map((check) => ({
      detail: check.detail ?? "",
      ...(check.install === undefined ? {} : { install: check.install }),
      name: check.name,
      required: check.required === true,
      source: check.source ?? "external",
      status: resolveSetupActionStatus(check),
    })),
    ...(doctorOutput.configPath === undefined ? {} : { configPath: doctorOutput.configPath }),
    cwd: doctorOutput.cwd,
    detectedTech: doctorOutput.detectedTech,
    missingPrerequisites,
    nextCommands:
      missingPrerequisites.length === 0
        ? [rerunCommand]
        : [
            "Install missing required tools through the normal language, project, or host toolchain.",
            doctorCommand,
            rerunCommand,
          ],
    ok: missingPrerequisites.length === 0,
    progressPath: doctorOutput.progressPath,
    progressSource: doctorOutput.progressSource,
    profile: doctorOutput.profile,
    stages: doctorOutput.stages,
    summary:
      missingPrerequisites.length === 0
        ? "Selected AIQ stages have no missing required setup."
        : "Selected AIQ stages need required setup before the agent can run them.",
  };
}

function isToolSetupCheck(
  check: DoctorCheckOutput,
): check is DoctorCheckOutput & { source: "bundled" | "external" | "project" } {
  return check.source === "bundled" || check.source === "external" || check.source === "project";
}

function resolveSetupActionStatus(
  check: DoctorCheckOutput & { source: "bundled" | "external" | "project" },
): SetupCommandOutput["actions"][number]["status"] {
  if (!check.ok && check.required === true) {
    return "missing";
  }

  if (check.source === "bundled" || check.source === "project") {
    return "provided";
  }

  return check.detail?.startsWith("not detected") ? "missing" : check.ok ? "available" : "missing";
}

function formatStageSelectionFlags(parsed: ParsedArgs): string[] {
  if (parsed.stages.length === 0) {
    return parsed.profile === undefined ? [] : ["--profile", parsed.profile];
  }

  return parsed.stages.flatMap((stage) => ["--stage", stage]);
}

function resolveStageIndex(stageId: StageId): number {
  return cliStageShortcutIds.indexOf(stageId);
}

function isStageId(value: string | undefined): value is StageId {
  return value !== undefined && cliStageShortcutIds.includes(value as StageId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function detectProjectLanguages(cwd: string): Promise<Set<LanguageId>> {
  const languages = new Set<LanguageId>();
  await collectProjectLanguages(cwd, languages, { scannedFiles: 0 });
  return languages;
}

async function collectProjectLanguages(
  directory: string,
  languages: Set<LanguageId>,
  state: { scannedFiles: number },
): Promise<void> {
  if (state.scannedFiles >= doctorMaxScannedFiles) {
    return;
  }

  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (state.scannedFiles >= doctorMaxScannedFiles) {
      return;
    }

    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!defaultProjectScopeIgnoredDirectoryNames.has(entry.name)) {
        await collectProjectLanguages(entryPath, languages, state);
      }
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    state.scannedFiles += 1;
    addDetectedLanguages(entry.name, languages);
    addMarkerLanguages(entry.name, languages);
  }
}

function addMarkerLanguages(fileName: string, languages: Set<LanguageId>): void {
  switch (fileName) {
    case "Cargo.toml":
      languages.add("rust");
      return;
    case "go.mod":
      languages.add("go");
      return;
    case "package.json":
      languages.add("javascript");
      return;
    case "pyproject.toml":
    case "requirements.txt":
      languages.add("python");
      return;
    case "tsconfig.json":
      languages.add("typescript");
      return;
    case "pom.xml":
    case "build.gradle":
    case "build.gradle.kts":
    case "settings.gradle":
    case "settings.gradle.kts":
      languages.add("java");
      return;
  }
}

function addDetectedLanguages(fileName: string, languages: Set<LanguageId>): void {
  const extension = path.extname(fileName).toLowerCase();
  switch (extension) {
    case ".bash":
    case ".bats":
    case ".sh":
      languages.add("bash");
      return;
    case ".cjs":
    case ".js":
    case ".jsx":
    case ".mjs":
      languages.add("javascript");
      return;
    case ".css":
      languages.add("css");
      return;
    case ".cs":
    case ".csproj":
    case ".fsproj":
    case ".sln":
    case ".slnx":
    case ".vbproj":
      languages.add("dotnet");
      return;
    case ".go":
      languages.add("go");
      return;
    case ".hcl":
      languages.add("hcl");
      return;
    case ".htm":
    case ".html":
      languages.add("html");
      return;
    case ".java":
      languages.add("java");
      return;
    case ".kt":
    case ".kts":
      languages.add("kotlin");
      return;
    case ".ps1":
    case ".psd1":
    case ".psm1":
      languages.add("powershell");
      return;
    case ".py":
    case ".pyi":
      languages.add("python");
      return;
    case ".rs":
      languages.add("rust");
      return;
    case ".sql":
      languages.add("sql");
      return;
    case ".tf":
    case ".tfvars":
      languages.add("terraform");
      return;
    case ".ts":
    case ".tsx":
    case ".cts":
    case ".mts":
      languages.add("typescript");
      return;
    case ".yaml":
    case ".yml":
      languages.add("yaml");
      return;
  }
}

function formatDetectedLanguages(languages: ReadonlySet<LanguageId>): string[] {
  return doctorLanguageOrder
    .filter((language) => languages.has(language))
    .map((language) => doctorLanguageLabels[language]);
}

function resolveDoctorToolRequirements(
  languages: ReadonlySet<LanguageId>,
  stages: readonly StageId[],
): DoctorToolRequirement[] {
  const requirements = new Map<string, DoctorToolRequirement>();
  const selected = new Set(stages);

  const addRequirement = (requirement: DoctorToolRequirement) => {
    requirements.set(requirement.name, requirement);
  };

  if (
    languages.has("python") &&
    usesAnyStage(selected, [
      "lint",
      "format",
      "typecheck",
      "unit",
      "sloc",
      "complexity",
      "maintainability",
      "coverage",
    ])
  ) {
    addRequirement({
      binaries: ["python3", "python"],
      install: "Install Python 3 and project Python tools such as ruff, ty, pytest, and radon.",
      name: "Python runtime",
      required: true,
      source: "external",
    });
  }

  if (
    languages.has("go") &&
    usesAnyStage(selected, [
      "lint",
      "format",
      "typecheck",
      "unit",
      "sloc",
      "complexity",
      "maintainability",
      "coverage",
    ])
  ) {
    addRequirement({
      binaries: ["go"],
      install: "Install the Go toolchain from your normal toolchain manager.",
      name: "Go toolchain",
      required: true,
      source: "external",
    });
  }

  if (
    languages.has("rust") &&
    usesAnyStage(selected, [
      "lint",
      "format",
      "typecheck",
      "unit",
      "sloc",
      "complexity",
      "maintainability",
      "coverage",
    ])
  ) {
    addRequirement({
      binaries: ["cargo"],
      install: "Install Rust and Cargo with rustup or your normal toolchain manager.",
      name: "Rust Cargo",
      required: true,
      source: "external",
    });
  }

  if (
    languages.has("dotnet") &&
    usesAnyStage(selected, [
      "lint",
      "format",
      "typecheck",
      "unit",
      "sloc",
      "complexity",
      "maintainability",
      "coverage",
    ])
  ) {
    addRequirement({
      binaries: ["dotnet"],
      install: "Install the .NET SDK for this project.",
      name: ".NET SDK",
      required: true,
      source: "external",
    });
  }

  if (
    (languages.has("java") || languages.has("kotlin")) &&
    usesAnyStage(selected, [
      "lint",
      "format",
      "typecheck",
      "unit",
      "sloc",
      "complexity",
      "maintainability",
      "coverage",
    ])
  ) {
    addRequirement({
      binaries: ["java"],
      install: "Install a JVM runtime and the project build tool wrapper or Maven/Gradle.",
      name: "JVM runtime",
      required: true,
      source: "external",
    });
  }

  if (
    (languages.has("terraform") || languages.has("hcl")) &&
    usesAnyStage(selected, ["lint", "format", "typecheck"])
  ) {
    addRequirement({
      binaries: ["terraform"],
      install: "Install Terraform CLI to enable Terraform/HCL lint, format, and validation.",
      name: "Terraform CLI",
      required: true,
      source: "external",
    });
  }

  if (
    languages.has("powershell") &&
    usesAnyStage(selected, ["lint", "format", "unit", "coverage"])
  ) {
    addRequirement({
      binaries:
        process.platform === "win32"
          ? ["pwsh.exe", "pwsh", "powershell.exe", "powershell"]
          : ["pwsh"],
      install: "Install PowerShell 7 (pwsh) and project PowerShell modules.",
      name: "PowerShell runtime",
      required: true,
      source: "external",
    });
  }

  if (usesAnyStage(selected, ["sloc", "complexity", "maintainability"])) {
    const lizardLanguages: LanguageId[] = [
      "javascript",
      "typescript",
      "go",
      "rust",
      "dotnet",
      "java",
      "kotlin",
    ];
    if (lizardLanguages.some((language) => languages.has(language))) {
      addRequirement({
        binaries: ["lizard"],
        install: "Install lizard where AIQ runs to enable non-Python metrics stages.",
        name: "Lizard metrics tool",
        required: true,
        source: "external",
      });
    }
  }

  return [...requirements.values()];
}

function resolveDoctorBundledTools(
  languages: ReadonlySet<LanguageId>,
  stages: readonly StageId[],
): DoctorBundledTool[] {
  const selected = new Set(stages);
  const checks = new Map<string, DoctorBundledTool>();
  const add = (tool: DoctorBundledTool) => {
    checks.set(tool.name, tool);
  };

  if (
    (languages.has("javascript") || languages.has("typescript")) &&
    usesAnyStage(selected, ["lint", "format"])
  ) {
    add({
      detail: "provided by the @tjalve/aiq package dependency graph",
      name: "Biome JS/TS lint/format tool",
      source: "bundled",
    });
  }

  if (languages.has("typescript") && selected.has("typecheck")) {
    add({
      detail: "provided by the @tjalve/aiq package dependency graph",
      name: "TypeScript compiler",
      source: "bundled",
    });
  }

  if (
    usesAnyStage(selected, ["unit", "coverage"]) &&
    (languages.has("javascript") || languages.has("typescript"))
  ) {
    add({
      detail: "uses the project's configured npm test runner when present",
      name: "JS/TS test runner",
      source: "project",
    });
  }

  if (
    usesAnyStage(selected, ["lint", "format"]) &&
    (languages.has("html") || languages.has("css") || languages.has("yaml") || languages.has("sql"))
  ) {
    add({
      detail: "provided by the @tjalve/aiq package dependency graph",
      name: "Bundled web/data document tools",
      source: "bundled",
    });
  }

  if (selected.has("security") && languages.size > 0) {
    add({
      detail: "provided by the @tjalve/aiq package runtime",
      name: "AIQ shared security scanner",
      source: "bundled",
    });
  }

  return [...checks.values()];
}

function mergeDoctorPrerequisites(
  prerequisites: readonly DoctorPrerequisite[],
  requirements: readonly DoctorToolRequirement[],
): Array<DoctorPrerequisite | DoctorToolRequirement> {
  const merged = new Map<string, DoctorPrerequisite | DoctorToolRequirement>();
  for (const prerequisite of prerequisites) {
    merged.set(prerequisite.name, prerequisite);
  }

  for (const requirement of requirements) {
    merged.set(requirement.name, requirement);
  }

  return [...merged.values()];
}

function usesAnyStage(selected: ReadonlySet<StageId>, stages: readonly StageId[]): boolean {
  return stages.some((stage) => selected.has(stage));
}

function validateDoctorPrerequisiteVersion(prerequisite: DoctorPrerequisite): string | undefined {
  if (prerequisite.minimumMajor === undefined) {
    return undefined;
  }

  if (!prerequisite.binaries.includes("node")) {
    return undefined;
  }

  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
  if (Number.isFinite(major) && major >= prerequisite.minimumMajor) {
    return undefined;
  }

  return `detected Node.js ${process.version}; ${prerequisite.install}`;
}

async function resolveInstalledCommand(
  commandNames: readonly string[],
  options: { includeVersion?: boolean } = {},
): Promise<string | undefined> {
  for (const commandName of commandNames) {
    if (commandName === "node") {
      return options.includeVersion ? `${process.execPath}; ${process.version}` : "detected";
    }

    const result = await runCommand(process.platform === "win32" ? "where" : "which", [
      commandName,
    ]);
    if (result.exitCode === 0) {
      const resolved = result.stdout
        .split(/\r?\n/u)
        .map((value) => value.trim())
        .find((value) => value.length > 0);
      const resolvedCommand = resolved ?? commandName;
      if (!options.includeVersion) {
        return "detected";
      }
      const version = await resolveCommandVersion(resolvedCommand);
      return version === undefined ? resolvedCommand : `${resolvedCommand}; ${version}`;
    }
  }

  return undefined;
}

async function resolveCommandVersion(command: string): Promise<string | undefined> {
  const result = await runCommand(command, ["--version"]);
  if (result.exitCode !== 0) {
    return undefined;
  }

  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

async function runCommand(
  command: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string }> {
  try {
    const result = await execFileAsync(command, args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return { exitCode: 0, stdout: result.stdout };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      const code = (error as { code?: unknown }).code;
      const stdout = (error as { stdout?: unknown }).stdout;
      return {
        exitCode: typeof code === "number" ? code : 1,
        stdout: typeof stdout === "string" ? stdout : "",
      };
    }

    return { exitCode: 1, stdout: "" };
  }
}

function createSetupGuidanceOutput(command: SetupGuidanceCommand, subcommand?: string) {
  switch (command) {
    case "hook":
      return {
        command,
        requested: `hook ${subcommand ?? ""}`.trim(),
        summary: "Hook setup uses the dedicated AIQ hook adapter.",
        replacement:
          "Use your repository hook manager to invoke the aiq-hook package, or run aiq check/run directly in pre-commit automation.",
      };
    case "ci":
      return {
        command,
        requested: `ci ${subcommand ?? ""}`.trim(),
        summary: "CI setup uses explicit workflow configuration.",
        replacement:
          "Use npx @tjalve/aiq run <files> in CI and keep stage/profile selection in .aiq/aiq.config.json.",
      };
    case "ignore":
      return {
        command,
        requested: `ignore ${subcommand ?? ""}`.trim(),
        summary: "Ignored inputs are configured in the canonical AIQ config file.",
        replacement:
          "Run aiq config to initialize .aiq/aiq.config.json, then edit inputs.ignore there so the ignored paths are reviewed with project config.",
      };
  }
}
