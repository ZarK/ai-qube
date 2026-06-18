import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { loadAiqProgress } from "@tjalve/aiq/config";
import type { StageId } from "@tjalve/aiq/model";

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
import { detectProjectLanguages, formatDetectedLanguages } from "./doctor-discovery.js";
import {
  type DoctorPrerequisite,
  doctorPrerequisites,
  mergeDoctorPrerequisites,
  resolveDoctorBundledTools,
  resolveDoctorToolRequirements,
} from "./doctor-tools.js";

const execFileAsync = promisify(execFile);
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
      timeout: doctorProbeTimeoutMs,
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
