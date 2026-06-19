import {
  stderr as defaultStderr,
  stdin as defaultStdin,
  stdout as defaultStdout,
} from "node:process";

import { existsSync } from "node:fs";
import path from "node:path";

import {
  createCli,
  createCommand,
  runCli as runSharedCli,
  type RuntimeCommand,
  type RuntimeCommandContext,
} from "@tjalve/qube-cli/runtime";
import type { CommandMetadata } from "@tjalve/qube-cli/metadata";
import type { BenchmarkScenarioKind } from "@tjalve/aiq/benchmark";
import { type AiqProfileName, type AiqProgressStageIndex, aiqProfileNames } from "@tjalve/aiq/config";
import { type StageId, stageIds } from "@tjalve/aiq/model";

import {
  runBenchCommand,
  runCheckCommand,
  runConfigCommand,
  runDoctorCommand,
  runEvidenceCommand,
  runFirstRunCommand,
  runPlanCommand,
  runSchemaCommand,
  runSetupCommand,
  runSetupGuidanceCommand,
  runStatusCommand,
} from "./commands.js";
import { runServeCommand } from "./serve.js";
import { formatError } from "./shared.js";
import { type CliIo, type CliRunOptions, type ParsedArgs, cliHelp } from "./types.js";
import { aiqPackageName, aiqPackageVersion } from "./version.js";
import { runWatchCommand } from "./watch.js";
import { aiqCommandMetadata, aiqCommandRegistry } from "./schema.js";
import { parseArgs } from "./args.js";

export * from "./api.js";
export * from "./schema.js";
export { cliHelp, type CliInput, type CliIo, type CliRunOptions } from "./types.js";

const firstRunCommandMetadata = {
  kind: "command",
  name: "first-run",
  description: "Run the configured project gate by inferring the local project.",
  flags: [
    {
      name: "up-to",
      description: "Run every ladder stage from 0 through the provided stage index.",
      type: "integer",
    },
    {
      name: "only",
      description: "Run one numeric ladder stage.",
      type: "integer",
    },
    {
      name: "stage",
      description: "Run one named stage.",
      type: "string",
      multiple: true,
    },
    {
      name: "profile",
      description: "Select the configured AIQ profile.",
      type: "option",
      options: ["fast", "standard", "deep"],
    },
    {
      name: "format",
      description: "Select text or JSON output.",
      type: "option",
      options: ["text", "json"],
      defaultValue: "text",
    },
    {
      name: "dry-run",
      description: "Render the resolved plan without executing tools or writing artifacts.",
      type: "boolean",
    },
    {
      name: "out-dir",
      description: "Override the AIQ artifact output directory.",
      type: "string",
    },
    {
      name: "verbose",
      description: "Include command and tool details in text output.",
      type: "boolean",
    },
  ],
  examples: [
    {
      command: "aiq --dry-run --format json",
      description: "Infer the local project and render a dry-run plan.",
    },
  ],
  output: { formats: ["text", "json"], defaultFormat: "text" },
  interactions: {
    json: true,
    dryRun: { supported: true },
    noColor: false,
    nonInteractive: true,
    ttyPrompt: false,
  },
  mutation: { categories: ["local-config", "local-files"] },
  supplyChain: {
    sensitive: true,
    kinds: ["package-manager", "dependency"],
    reason: "AIQ first-run may execute project quality tools selected by repository configuration.",
  },
  exitCodes: [
    {
      code: 0,
      category: "success",
      description: "The command completed successfully.",
    },
    {
      code: 1,
      category: "validation",
      description: "The quality run completed and reported quality failures.",
    },
    {
      code: 2,
      category: "usage",
      description: "The local project could not be inferred or command input was invalid.",
    },
    {
      code: 3,
      category: "unexpected",
      description: "AIQ hit an internal or host runtime error.",
    },
  ],
} as const satisfies CommandMetadata;

export async function runCli(
  argv: string[],
  io: CliIo = defaultIo(),
  options: CliRunOptions = {},
): Promise<number> {
  const input = argv.slice(2);
  const normalizedHelpInput = stripLeadingSeparators(input);
  if (normalizedHelpInput.includes("--help") || normalizedHelpInput.includes("-h")) {
    io.stdout.write(cliHelp);
    return 0;
  }

  const jsonOnlyFormatViolation = findJsonOnlyFormatViolation(normalizedHelpInput);
  if (jsonOnlyFormatViolation) {
    io.stderr.write(`${jsonOnlyFormatViolation}\n`);
    return 2;
  }

  if (isUnsupportedFlagFirstRunInput(normalizedHelpInput, io.cwd)) {
    io.stderr.write("aiq run requires explicit files or paths. Use aiq for the configured project gate, or use aiq run <paths...>.\n");
    return 2;
  }

  if (!isVersionInput(normalizedHelpInput)) {
    try {
      parseArgs(["node", "aiq", ...normalizedHelpInput], io.cwd);
    } catch (error) {
      io.stderr.write(`${formatError(error)}\n`);
      return 2;
    }
  }

  const result = await runSharedCli(createAiqCli(io, options), normalizeAiqInput(input, io.cwd));
  if (result.stdout.length > 0) io.stdout.write(result.stdout);
  if (result.stderr.length > 0) io.stderr.write(result.stderr);
  return result.exitCode;
}

function defaultIo(): CliIo {
  return {
    cwd: process.cwd(),
    stderr: defaultStderr,
    stdin: defaultStdin,
    stdout: defaultStdout,
  };
}

function createAiqCli(io: CliIo, options: CliRunOptions) {
  return createCli({
    bin: "aiq",
    packageName: aiqPackageName,
    packageVersion: aiqPackageVersion,
    description: "Staged AIQ code quality gate with agent-facing setup and remediation guidance.",
    registry: aiqCommandRegistry,
    commands: createRuntimeCommands(io, options),
  });
}

function createRuntimeCommands(io: CliIo, options: CliRunOptions): RuntimeCommand[] {
  return [...aiqCommandMetadata, firstRunCommandMetadata].map((metadata) =>
    createCommand(metadata, (context) => runAiqRuntimeCommand(context, io, options)),
  );
}

async function runAiqRuntimeCommand(
  context: RuntimeCommandContext,
  io: CliIo,
  options: CliRunOptions,
) {
  const command = resolveParsedCommandName(context);
  let parsed: ParsedArgs;
  try {
    parsed = createParsedArgs(command, context);
  } catch (error) {
    return { stderr: `${formatError(error)}\n`, exitCode: 2 };
  }
  if (streamsCommandOutput(parsed.command)) {
    const exitCode = await dispatchParsedCommand(parsed, io, options);
    return { exitCode };
  }
  const stdout = new BufferedOutput();
  const stderr = new BufferedOutput();
  const commandIo = { ...io, stderr, stdout };
  const exitCode = await dispatchParsedCommand(parsed, commandIo, options);
  return {
    exitCode,
    stdout: stdout.value,
    ...(stderr.value.length > 0 ? { stderr: stderr.value } : {}),
  };
}

function streamsCommandOutput(command: ParsedArgs["command"]): boolean {
  return command === "serve" || command === "watch";
}

class BufferedOutput {
  value = "";

  write(chunk: string | Uint8Array): boolean {
    this.value += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }
}

async function dispatchParsedCommand(
  parsed: ParsedArgs,
  io: CliIo,
  options: CliRunOptions,
): Promise<number> {
  switch (parsed.command) {
    case "watch":
      return runWatchCommand(parsed, io, options);
    case "serve":
      return runServeCommand(parsed, io, options);
    case "bench":
      return runBenchCommand(parsed, io);
    case "config":
      return runConfigCommand(parsed, io);
    case "doctor":
      return runDoctorCommand(parsed, io);
    case "evidence":
      return runEvidenceCommand(parsed, io);
    case "status":
      return runStatusCommand(parsed, io);
    case "schema":
      return runSchemaCommand(parsed, io);
    case "setup":
      return runSetupCommand(parsed, io);
    case "first-run":
      return runFirstRunCommand(parsed, io);
    case "ci":
    case "hook":
    case "ignore":
      return runSetupGuidanceCommand(parsed, io);
    case "plan":
      return runPlanCommand(parsed, io);
    case "run":
    case "check":
      return runCheckCommand(parsed, io);
  }
}

function resolveParsedCommandName(context: RuntimeCommandContext): ParsedArgs["command"] {
  const matchedName = (context as RuntimeCommandContext & { readonly matchedName?: string }).matchedName ?? context.command.name;
  if (context.command.name === "run" && matchedName === "check") {
    return "check";
  }
  return context.command.name as ParsedArgs["command"];
}

function createParsedArgs(command: ParsedArgs["command"], context: RuntimeCommandContext): ParsedArgs {
  const benchmarkCorpusRoot = readOptionalString(context.flags["corpus-root"]);
  const configSetStage = typeof context.flags["set-stage"] === "number" ? readStageIndex(context.flags["set-stage"]) : undefined;
  const filesFrom = readOptionalString(context.flags["files-from"]);
  const outDir = readOptionalString(context.flags["out-dir"]);
  const profile = readOptionalString(context.flags.profile);
  const setupSubcommand = readOptionalString(context.args.subcommand);
  const parsed: ParsedArgs = {
    benchmarkKinds: readStringArray(context.flags.kind).map(parseBenchmarkKindValue),
    benchmarkScenarioIds: readStringArray(context.flags.scenario),
    benchmarkTags: readStringArray(context.flags.tag),
    command,
    configPrint: context.flags["print-config"] === true,
    debounceMs: typeof context.flags["debounce-ms"] === "number" ? context.flags["debounce-ms"] : 75,
    diffOnly: context.flags["diff-only"] === true,
    dryRun: context.flags["dry-run"] === true,
    files: readFiles(context),
    format: readOutputFormat(context.flags.format),
    help: false,
    host: readOptionalString(context.flags.host) ?? "127.0.0.1",
    port: typeof context.flags.port === "number" ? context.flags.port : 3000,
    stages: readSelectedStages(context),
    stdinFileList: context.flags["stdin-file-list"] === true,
    verbose: context.flags.verbose === true,
  };
  if (benchmarkCorpusRoot !== undefined) parsed.benchmarkCorpusRoot = benchmarkCorpusRoot;
  if (configSetStage !== undefined) parsed.configSetStage = configSetStage;
  if (filesFrom !== undefined) parsed.filesFrom = filesFrom;
  if (outDir !== undefined) parsed.outDir = outDir;
  if (profile !== undefined) parsed.profile = readProfile(profile);
  if (setupSubcommand !== undefined) parsed.setupSubcommand = setupSubcommand;
  return parsed;
}

function readFiles(context: RuntimeCommandContext): string[] {
  return [...readStringArray(context.args.files), ...readStringArray(context.flags.files)];
}

function readSelectedStages(context: RuntimeCommandContext): StageId[] {
  const stages: StageId[] = [];
  if (typeof context.flags["up-to"] === "number") {
    const index = readStageIndex(context.flags["up-to"]);
    stages.push(...cliStageIds().slice(0, index + 1));
  }
  if (typeof context.flags.only === "number") {
    stages.push(cliStageIds()[readStageIndex(context.flags.only)] as StageId);
  }
  for (const stage of readStringArray(context.flags.stage)) {
    if (!stageIds.includes(stage as StageId)) {
      throw new Error(`Unsupported stage: ${stage}`);
    }
    stages.push(stage as StageId);
  }
  return stages;
}

function cliStageIds(): readonly StageId[] {
  return ["e2e", "lint", "format", "typecheck", "unit", "sloc", "complexity", "maintainability", "coverage", "security"];
}

function readStageIndex(value: number): AiqProgressStageIndex {
  if (!Number.isSafeInteger(value) || value < 0 || value >= cliStageIds().length) {
    throw new Error(`--stage index must be between 0 and ${cliStageIds().length - 1}.`);
  }
  return value as AiqProgressStageIndex;
}

function readOutputFormat(value: unknown): "json" | "text" {
  return value === "json" ? "json" : "text";
}

function readProfile(value: unknown): AiqProfileName {
  if (typeof value === "string" && aiqProfileNames.includes(value as AiqProfileName)) {
    return value as AiqProfileName;
  }
  throw new Error(`Unsupported profile: ${String(value)}`);
}

function parseBenchmarkKindValue(value: string): BenchmarkScenarioKind {
  if (value === "cold" || value === "diff-only" || value === "warm") {
    return value;
  }
  throw new Error(`Unsupported benchmark kind: ${value}`);
}

function readStringArray(value: unknown): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return typeof value === "string" ? [value] : [];
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeAiqInput(input: readonly string[], cwd: string): string[] {
  const args = stripLeadingSeparators(input);
  if (isVersionInput(args)) {
    return args;
  }
  if (isImplicitFirstRun(args, cwd)) {
    return ["first-run", ...args];
  }
  const commandToken = resolveCommandToken(args[0], cwd);
  if (commandToken === undefined && args[0]?.startsWith("-") === true && hasPositionalPathInput(args, cwd)) {
    return ["run", ...normalizeFlagFirstExplicitRunInput(args)];
  }
  return commandToken === undefined ? ["run", ...args] : args;
}

function stripLeadingSeparators(input: readonly string[]): string[] {
  const args = [...input];
  while (args[0] === "--") {
    args.shift();
  }
  return args;
}

function isVersionInput(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--version" || arg === "-v") && args.every((arg) => arg === "--version" || arg === "-v" || arg === "--json");
}

const knownCommandNames = new Set([
  "bench",
  "check",
  "ci",
  "config",
  "doctor",
  "evidence",
  "hook",
  "ignore",
  "plan",
  "run",
  "schema",
  "serve",
  "setup",
  "status",
  "watch",
]);

function resolveCommandToken(token: string | undefined, cwd: string): string | undefined {
  if (token === undefined || token.startsWith("-") || looksLikePath(token, cwd)) {
    return undefined;
  }
  return token;
}

function isImplicitFirstRun(args: readonly string[], cwd: string): boolean {
  if (args.length === 0) {
    return true;
  }
  const first = args[0];
  if (first === undefined) {
    return true;
  }
  if (knownCommandNames.has(first) || looksLikePath(first, cwd)) {
    return false;
  }
  if (hasExplicitManifestInput(args) || hasPositionalPathInput(args, cwd)) {
    return false;
  }
  return first.startsWith("-") && argsAreOnlyImplicitFirstRunOptions(args);
}

function hasExplicitManifestInput(args: readonly string[]): boolean {
  return args.some((argument) => argument === "--files" || argument === "--files-from" || argument === "--stdin-file-list");
}

function hasPositionalPathInput(args: readonly string[], cwd: string): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined || argument.length === 0) {
      continue;
    }
    if (argument.startsWith("-")) {
      if (flagConsumesNextValue(argument)) {
        index += 1;
      }
      continue;
    }
    if (looksLikePath(argument, cwd)) {
      return true;
    }
  }
  return false;
}

function isUnsupportedFlagFirstRunInput(args: readonly string[], cwd: string): boolean {
  return args[0]?.startsWith("-") === true && !isVersionInput(args) && !isImplicitFirstRun(args, cwd) && !hasPositionalPathInput(args, cwd) && !hasExplicitManifestInput(args);
}

function normalizeFlagFirstExplicitRunInput(args: readonly string[]): string[] {
  const flags: string[] = [];
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) {
      continue;
    }
    if (argument.startsWith("-")) {
      flags.push(argument);
      if (flagConsumesNextValue(argument)) {
        const value = args[index + 1];
        if (value !== undefined) {
          flags.push(value);
          index += 1;
        }
      }
      continue;
    }
    positionals.push(argument);
  }
  return [...positionals, ...flags];
}

function flagConsumesNextValue(flag: string): boolean {
  return !flag.includes("=") && ["--config", "--corpus-root", "--files", "--files-from", "--format", "--host", "--only", "--out-dir", "--port", "--profile", "--scenario", "--stage", "--tag", "--up-to"].includes(flag);
}

function argsAreOnlyImplicitFirstRunOptions(args: readonly string[]): boolean {
  const allowedValueFlags = new Set(["--format", "--only", "--out-dir", "--profile", "--stage", "--up-to"]);
  const allowedBooleanFlags = new Set(["--dry-run", "--verbose"]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) {
      continue;
    }
    if (allowedBooleanFlags.has(argument)) {
      continue;
    }
    if (allowedValueFlags.has(argument)) {
      if (args[index + 1] === undefined) {
        return false;
      }
      index += 1;
      continue;
    }
    return false;
  }
  return true;
}

function looksLikePath(token: string, cwd: string): boolean {
  return (
    token === "." ||
    token === ".." ||
    token.startsWith("./") ||
    token.startsWith("../") ||
    token.startsWith("/") ||
    token.includes("/") ||
    token.includes("\\") ||
    token.includes(".") ||
    existsSync(path.resolve(cwd, token))
  );
}

function findJsonOnlyFormatViolation(args: readonly string[]): string | undefined {
  const command = args[0];
  if (command !== "schema" && command !== "evidence") {
    return undefined;
  }
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] === "--format" && args[index + 1] !== "json") {
      return `The ${command} command only supports --format json.`;
    }
  }
  return undefined;
}
