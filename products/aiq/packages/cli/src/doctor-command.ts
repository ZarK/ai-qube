import os from "node:os";
import path from "node:path";
import { loadAiqProgress } from "@tjalve/aiq/config";
import { ToolRunner, resolvePathCommand, resolvePythonInterpreter } from "@tjalve/aiq/engine";
import type { StageId } from "@tjalve/aiq/model";

import { detectProjectLanguages, formatDetectedLanguages } from "./doctor-discovery.js";
import { detectJvmBuildTools } from "./doctor-jvm.js";
import {
  type DoctorPrerequisite,
  doctorPrerequisites,
  mergeDoctorPrerequisites,
  resolveDoctorBundledTools,
  resolveDoctorToolRequirements,
} from "./doctor-tools.js";
import { detectNativeConfigs, resolveDoctorNativeConfigChecks } from "./native-config.js";
import {
  type DoctorCheckOutput,
  type DoctorCommandOutput,
  type SetupCommandOutput,
  formatDoctorOutput,
  formatSetupOutput,
  toWorkflowStageOutput,
} from "./output.js";
import { resolveCliConfig } from "./requests.js";
import { formatError } from "./shared.js";
import { type CliIo, type ParsedArgs, cliStageShortcutIds } from "./types.js";

const doctorToolRunner = new ToolRunner();
const doctorProbeTimeoutMs = 5_000;

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
  const jvmTools = await detectJvmBuildTools(io.cwd, resolvedConfig.stages);
  const prerequisites = mergeDoctorPrerequisites(
    [...doctorPrerequisites, ...jvmTools.requirements],
    externalRequirements,
  );
  const prerequisiteChecks = await Promise.all(
    prerequisites.map(async (prerequisite) => {
      const installed = await resolvePrerequisite(prerequisite);
      const versionProblem =
        installed === undefined ? undefined : validateDoctorPrerequisiteVersion(prerequisite);
      return {
        detail: versionProblem ?? installed ?? (await missingPrerequisiteDetail(prerequisite)),
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
    ...jvmTools.checks,
    ...bundledChecks,
  ];

  return {
    checks,
    ...(resolvedConfig.configPath === undefined ? {} : { configPath: resolvedConfig.configPath }),
    ...(resolvedConfig.configPaths === undefined
      ? {}
      : { configPaths: resolvedConfig.configPaths }),
    ...(resolvedConfig.sources === undefined ? {} : { sources: resolvedConfig.sources }),
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

async function resolvePrerequisite(prerequisite: DoctorPrerequisite): Promise<string | undefined> {
  if (prerequisite.pythonModule === undefined) {
    return resolveInstalledCommand(prerequisite.binaries, prerequisite.versionArgs);
  }
  let interpreter: string;
  try {
    interpreter = await resolvePythonInterpreter();
  } catch {
    return undefined;
  }
  const result = await runCommand(
    interpreter,
    [
      "-E",
      "-P",
      "-c",
      "import importlib, importlib.metadata, sys; module = importlib.import_module(sys.argv[1]); print(module.__file__ + '; ' + importlib.metadata.version(sys.argv[1]))",
      prerequisite.pythonModule,
    ],
    os.tmpdir(),
  );
  return result.exitCode === 0
    ? `${prerequisite.pythonModule}; ${result.stdout.trim()}; Python interpreter: ${interpreter}`
    : undefined;
}

async function missingPrerequisiteDetail(prerequisite: DoctorPrerequisite): Promise<string> {
  if (prerequisite.pythonModule !== undefined) {
    try {
      const interpreter = await resolvePythonInterpreter();
      return `not detected in Python interpreter: ${interpreter}; ${prerequisite.install}`;
    } catch {
      return `not detected; Python interpreter unavailable; ${prerequisite.install}`;
    }
  }
  return `not detected; ${prerequisite.install}`;
}

async function resolveInstalledCommand(
  commandNames: readonly string[],
  versionArgs: readonly string[] = ["--version"],
): Promise<string | undefined> {
  for (const commandName of commandNames) {
    if (commandName === "node") {
      return `${process.execPath}; ${process.version}`;
    }

    const resolved = await resolvePathCommand(commandName);
    if (resolved !== undefined) {
      const version = await resolveCommandVersion(resolved, versionArgs);
      return version === undefined ? undefined : `${resolved}; ${version}`;
    }
  }

  return undefined;
}

async function resolveCommandVersion(
  command: string,
  args: readonly string[],
): Promise<string | undefined> {
  if (/^gofmt(?:\.exe)?$/iu.test(path.basename(command))) {
    const go = await resolvePathCommand("go");
    return go === undefined ? undefined : resolveCommandVersion(go, ["version", command]);
  }
  const result = await runCommand(command, [...args]);
  if (result.exitCode !== 0) {
    return undefined;
  }

  const lines = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.find((line) => /\d+\.\d+/u.test(line)) ?? lines[0];
}

async function runCommand(
  command: string,
  args: string[],
  cwd = process.cwd(),
): Promise<{ exitCode: number; stdout: string }> {
  try {
    const result = await doctorToolRunner.run(command, args, {
      cwd,
      signal: AbortSignal.timeout(doctorProbeTimeoutMs),
    });
    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout || result.stderr,
    };
  } catch {
    return { exitCode: 1, stdout: "" };
  }
}
