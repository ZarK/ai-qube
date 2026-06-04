import { existsSync } from "node:fs";
import path from "node:path";

import type { BenchmarkScenarioKind } from "@tjalve/aiq/benchmark";
import {
  type AiqProfileName,
  type AiqProgressStageIndex,
  aiqProfileNames,
} from "@tjalve/aiq/config";
import { type StageId, stageIds } from "@tjalve/aiq/model";

import {
  type CommandName,
  type ParsedArgs,
  cliStageShortcutIds,
  defaultServeHost,
  defaultServePort,
  defaultWatchDebounceMs,
} from "./types.js";

type PublicCommandName = Exclude<CommandName, "first-run">;

const knownCommandNames = [
  "bench",
  "check",
  "ci",
  "config",
  "doctor",
  "evidence",
  "hook",
  "ignore",
  "install-tools",
  "plan",
  "run",
  "schema",
  "serve",
  "status",
  "watch",
] as const satisfies readonly PublicCommandName[];
const knownCommandNameSet = new Set<string>(knownCommandNames);

export function parseArgs(argv: string[], cwd = process.cwd()): ParsedArgs {
  const args = argv.slice(2);
  while (args[0] === "--") {
    args.shift();
  }
  const isFirstRun = isImplicitFirstRun(args, cwd);
  const commandToken = isFirstRun ? undefined : resolveCommandToken(args[0], cwd);
  const command: CommandName = isFirstRun ? "first-run" : parseCommand(commandToken);
  const startIndex = commandToken === undefined ? 0 : 1;

  const parsed: ParsedArgs = {
    benchmarkKinds: [],
    benchmarkScenarioIds: [],
    benchmarkTags: [],
    command,
    configPrint: false,
    debounceMs: defaultWatchDebounceMs,
    diffOnly: false,
    dryRun: false,
    files: [],
    format: "text",
    help: args.includes("--help") || args.includes("-h"),
    host: defaultServeHost,
    port: defaultServePort,
    stages: [],
    stdinFileList: false,
    verbose: false,
  };

  for (let index = startIndex; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) {
      continue;
    }

    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
      continue;
    }

    if (argument === "--diff-only") {
      parsed.diffOnly = true;
      continue;
    }

    if (argument === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }

    if (argument === "--verbose" || argument === "-v") {
      parsed.verbose = true;
      continue;
    }

    if (argument === "--format") {
      const value = args[++index];
      if (value !== "json" && value !== "text") {
        throw new Error(`Unsupported format: ${value ?? "<missing>"}`);
      }
      parsed.format = value;
      continue;
    }

    if (argument === "--out-dir") {
      parsed.outDir = requireValue(argument, args[++index]);
      continue;
    }

    if (argument === "--print-config") {
      parsed.configPrint = true;
      continue;
    }

    if (argument === "--set-stage") {
      parsed.configSetStage = parseStageIndexFlag(argument, args[++index]);
      continue;
    }

    if (argument === "--corpus-root") {
      parsed.benchmarkCorpusRoot = requireValue(argument, args[++index]);
      continue;
    }

    if (argument === "--scenario") {
      parsed.benchmarkScenarioIds.push(requireValue(argument, args[++index]));
      continue;
    }

    if (argument === "--tag") {
      parsed.benchmarkTags.push(requireValue(argument, args[++index]));
      continue;
    }

    if (argument === "--kind") {
      parsed.benchmarkKinds.push(parseBenchmarkKind(argument, args[++index]));
      continue;
    }

    if (argument === "--stage") {
      parsed.stages.push(parseStageIdFlag(argument, args[++index]));
      continue;
    }

    if (argument === "--only") {
      parsed.stages.push(resolveCliStageShortcut(argument, args[++index]));
      continue;
    }

    if (argument === "--up-to") {
      parsed.stages.push(...resolveCliStagesUpTo(argument, args[++index]));
      continue;
    }

    if (argument === "--profile") {
      const profile = requireValue(argument, args[++index]);
      if (!aiqProfileNames.includes(profile as AiqProfileName)) {
        throw new Error(`Unsupported profile: ${profile}`);
      }
      parsed.profile = profile as AiqProfileName;
      continue;
    }

    if (argument === "--debounce-ms") {
      parsed.debounceMs = parseIntegerFlag(argument, args[++index]);
      continue;
    }

    if (argument === "--host") {
      parsed.host = requireValue(argument, args[++index]);
      continue;
    }

    if (argument === "--port") {
      parsed.port = parseIntegerFlag(argument, args[++index]);
      continue;
    }

    if (argument === "--files") {
      index = collectTrailingFiles(args, index + 1, parsed.files);
      continue;
    }

    if (argument === "--files-from") {
      parsed.filesFrom = requireValue(argument, args[++index]);
      continue;
    }

    if (argument === "--stdin-file-list") {
      parsed.stdinFileList = true;
      continue;
    }

    if (argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    }

    if (isSetupGuidanceCommand(parsed.command) && parsed.setupSubcommand === undefined) {
      parsed.setupSubcommand = argument;
      continue;
    }

    parsed.files.push(argument);
  }

  if (
    parsed.command !== "run" &&
    parsed.command !== "check" &&
    (parsed.diffOnly ||
      (parsed.dryRun && parsed.command !== "first-run") ||
      (parsed.verbose && parsed.command !== "doctor" && parsed.command !== "first-run"))
  ) {
    throw new Error(
      "--diff-only is only supported by run/check; --dry-run is supported by aiq and run/check; --verbose is supported by aiq, run/check, and doctor.",
    );
  }

  if (parsed.help) {
    return parsed;
  }

  if (
    parsed.command === "serve" &&
    (parsed.files.length > 0 ||
      parsed.filesFrom !== undefined ||
      parsed.setupSubcommand !== undefined ||
      parsed.stdinFileList)
  ) {
    throw new Error(
      "The serve command receives files per request and does not accept startup manifest inputs.",
    );
  }

  if (
    parsed.command === "bench" &&
    (parsed.files.length > 0 ||
      parsed.filesFrom !== undefined ||
      parsed.setupSubcommand !== undefined ||
      parsed.stdinFileList ||
      parsed.stages.length > 0 ||
      parsed.profile !== undefined)
  ) {
    throw new Error(
      `The ${parsed.command} command manages its own corpus and only accepts benchmark filters plus output options.`,
    );
  }

  if (parsed.command === "config") {
    if (
      parsed.files.length > 0 ||
      parsed.filesFrom !== undefined ||
      parsed.setupSubcommand !== undefined ||
      parsed.stdinFileList ||
      parsed.stages.length > 0 ||
      parsed.profile !== undefined ||
      parsed.outDir !== undefined ||
      parsed.benchmarkCorpusRoot !== undefined ||
      parsed.benchmarkScenarioIds.length > 0 ||
      parsed.benchmarkTags.length > 0 ||
      parsed.benchmarkKinds.length > 0 ||
      parsed.debounceMs !== defaultWatchDebounceMs ||
      parsed.host !== defaultServeHost ||
      parsed.port !== defaultServePort
    ) {
      throw new Error(
        "The config command only accepts --print-config, --set-stage, and --format options.",
      );
    }

    if (parsed.configPrint && parsed.configSetStage !== undefined) {
      throw new Error("Use either --print-config or --set-stage, not both.");
    }
  } else if (parsed.configPrint || parsed.configSetStage !== undefined) {
    throw new Error("--print-config and --set-stage are only supported by the config command.");
  }

  if (parsed.command === "doctor") {
    if (
      parsed.files.length > 0 ||
      parsed.filesFrom !== undefined ||
      parsed.setupSubcommand !== undefined ||
      parsed.stdinFileList ||
      parsed.outDir !== undefined ||
      parsed.benchmarkCorpusRoot !== undefined ||
      parsed.benchmarkScenarioIds.length > 0 ||
      parsed.benchmarkTags.length > 0 ||
      parsed.benchmarkKinds.length > 0 ||
      parsed.debounceMs !== defaultWatchDebounceMs ||
      parsed.host !== defaultServeHost ||
      parsed.port !== defaultServePort
    ) {
      throw new Error(
        "The doctor command accepts --format, --verbose, --up-to, --only, --stage, and --profile.",
      );
    }
  }

  if (parsed.command === "evidence") {
    if ((parsed.format !== "json" && args.includes("--format")) || hasNonJsonOnlyFormat(args)) {
      throw new Error("The evidence command only supports --format json.");
    }

    if (
      parsed.files.length > 0 ||
      parsed.filesFrom !== undefined ||
      parsed.setupSubcommand !== undefined ||
      parsed.stdinFileList ||
      parsed.stages.length > 0 ||
      parsed.profile !== undefined ||
      parsed.outDir !== undefined ||
      parsed.benchmarkCorpusRoot !== undefined ||
      parsed.benchmarkScenarioIds.length > 0 ||
      parsed.benchmarkTags.length > 0 ||
      parsed.benchmarkKinds.length > 0 ||
      parsed.configPrint ||
      parsed.configSetStage !== undefined ||
      parsed.debounceMs !== defaultWatchDebounceMs ||
      parsed.host !== defaultServeHost ||
      parsed.port !== defaultServePort
    ) {
      throw new Error("The evidence command only accepts --format.");
    }

    parsed.format = "json";
  }

  if (parsed.command === "status") {
    if (
      parsed.files.length > 0 ||
      parsed.filesFrom !== undefined ||
      parsed.setupSubcommand !== undefined ||
      parsed.stdinFileList ||
      parsed.stages.length > 0 ||
      parsed.profile !== undefined ||
      parsed.outDir !== undefined ||
      parsed.benchmarkCorpusRoot !== undefined ||
      parsed.benchmarkScenarioIds.length > 0 ||
      parsed.benchmarkTags.length > 0 ||
      parsed.benchmarkKinds.length > 0 ||
      parsed.debounceMs !== defaultWatchDebounceMs ||
      parsed.host !== defaultServeHost ||
      parsed.port !== defaultServePort
    ) {
      throw new Error("The status command only accepts --format.");
    }
  }

  if (parsed.command === "schema") {
    if ((parsed.format !== "json" && args.includes("--format")) || hasNonJsonOnlyFormat(args)) {
      throw new Error("The schema command only supports --format json.");
    }

    if (
      parsed.files.length > 0 ||
      parsed.filesFrom !== undefined ||
      parsed.setupSubcommand !== undefined ||
      parsed.stdinFileList ||
      parsed.stages.length > 0 ||
      parsed.profile !== undefined ||
      parsed.outDir !== undefined ||
      parsed.benchmarkCorpusRoot !== undefined ||
      parsed.benchmarkScenarioIds.length > 0 ||
      parsed.benchmarkTags.length > 0 ||
      parsed.benchmarkKinds.length > 0 ||
      parsed.configPrint ||
      parsed.configSetStage !== undefined ||
      parsed.debounceMs !== defaultWatchDebounceMs ||
      parsed.host !== defaultServeHost ||
      parsed.port !== defaultServePort
    ) {
      throw new Error("The schema command only accepts --format.");
    }

    parsed.format = "json";
  }

  if (isSetupGuidanceCommand(parsed.command)) {
    validateSetupGuidanceCommand(parsed);
  }

  return parsed;
}

function isSetupGuidanceCommand(
  command: CommandName,
): command is "ci" | "hook" | "ignore" | "install-tools" {
  return (
    command === "ci" || command === "hook" || command === "ignore" || command === "install-tools"
  );
}

function validateSetupGuidanceCommand(parsed: ParsedArgs): void {
  if (
    parsed.files.length > 0 ||
    parsed.filesFrom !== undefined ||
    parsed.stdinFileList ||
    parsed.stages.length > 0 ||
    parsed.profile !== undefined ||
    parsed.outDir !== undefined ||
    parsed.benchmarkCorpusRoot !== undefined ||
    parsed.benchmarkScenarioIds.length > 0 ||
    parsed.benchmarkTags.length > 0 ||
    parsed.benchmarkKinds.length > 0 ||
    parsed.debounceMs !== defaultWatchDebounceMs ||
    parsed.host !== defaultServeHost ||
    parsed.port !== defaultServePort
  ) {
    throw new Error(
      "Setup guidance commands only accept their documented subcommand and --format.",
    );
  }

  if (parsed.command === "install-tools") {
    if (parsed.setupSubcommand !== undefined) {
      throw new Error("Use aiq install-tools without a subcommand.");
    }
    return;
  }

  const expectedSubcommand =
    parsed.command === "hook" ? "install" : parsed.command === "ci" ? "setup" : "write";
  if (parsed.setupSubcommand !== expectedSubcommand) {
    throw new Error(`Use aiq ${parsed.command} ${expectedSubcommand}.`);
  }
}

function hasNonJsonOnlyFormat(args: string[]): boolean {
  return args.some((argument, index) => argument === "--format" && args[index + 1] !== "json");
}

function parseCommand(command?: string): CommandName {
  if (isCommandName(command)) {
    return command;
  }

  if (command === undefined || command === "--help" || command === "-h") {
    return "run";
  }

  throw new Error(`Unknown command: ${command}`);
}

function resolveCommandToken(token: string | undefined, cwd: string): string | undefined {
  if (isCommandName(token) || token === "--help" || token === "-h") {
    return token;
  }

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
  if (first === undefined || first === "--help" || first === "-h") {
    return false;
  }

  if (isCommandName(first) || looksLikePath(first, cwd)) {
    return false;
  }

  if (hasExplicitManifestInput(args)) {
    return false;
  }

  if (hasPositionalPathInput(args, cwd)) {
    return false;
  }

  return first.startsWith("-") && argsAreOnlyImplicitFirstRunOptions(args);
}

function hasExplicitManifestInput(args: readonly string[]): boolean {
  return args.some(
    (argument) =>
      argument === "--files" || argument === "--files-from" || argument === "--stdin-file-list",
  );
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

function flagConsumesNextValue(flag: string): boolean {
  return (
    !flag.includes("=") &&
    [
      "--config",
      "--corpus-root",
      "--files",
      "--files-from",
      "--format",
      "--host",
      "--only",
      "--out-dir",
      "--port",
      "--profile",
      "--scenario",
      "--stage",
      "--tag",
      "--up-to",
    ].includes(flag)
  );
}

function argsAreOnlyImplicitFirstRunOptions(args: readonly string[]): boolean {
  const allowedValueFlags = new Set([
    "--format",
    "--only",
    "--out-dir",
    "--profile",
    "--stage",
    "--up-to",
  ]);
  const allowedBooleanFlags = new Set(["--dry-run", "--verbose", "-v"]);

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

function isCommandName(token?: string): token is PublicCommandName {
  return token !== undefined && knownCommandNameSet.has(token);
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

function requireValue(flag: string, value?: string): string {
  if (value === undefined) {
    throw new Error(`Missing value for ${flag}`);
  }

  return value;
}

function parseIntegerFlag(flag: string, value?: string): number {
  const rawValue = requireValue(flag, value);
  if (!/^\d+$/u.test(rawValue)) {
    throw new Error(`${flag} must be a non-negative integer.`);
  }

  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer.`);
  }

  return parsed;
}

function parseStageIdFlag(flag: string, value?: string): StageId {
  const stage = requireValue(flag, value);
  if (!stageIds.includes(stage as StageId)) {
    throw new Error(`Unsupported stage: ${stage}`);
  }

  return stage as StageId;
}

function resolveCliStageShortcut(flag: string, value?: string): StageId {
  const index = parseIntegerFlag(flag, value);
  const stage = cliStageShortcutIds[index];
  if (stage === undefined) {
    throw new Error(`${flag} must be between 0 and ${cliStageShortcutIds.length - 1}.`);
  }

  return stage;
}

function resolveCliStagesUpTo(flag: string, value?: string): StageId[] {
  const index = parseIntegerFlag(flag, value);
  if (index >= cliStageShortcutIds.length) {
    throw new Error(`${flag} must be between 0 and ${cliStageShortcutIds.length - 1}.`);
  }

  return [...cliStageShortcutIds.slice(0, index + 1)];
}

export function parseStageIndexFlag(flag: string, value?: string): AiqProgressStageIndex {
  const index = parseIntegerFlag(flag, value);
  if (index >= cliStageShortcutIds.length) {
    throw new Error(`${flag} must be between 0 and ${cliStageShortcutIds.length - 1}.`);
  }

  return index as AiqProgressStageIndex;
}

export function parsePositiveIntegerFlag(flag: string, value?: string): number {
  const parsed = parseIntegerFlag(flag, value);
  if (parsed < 1) {
    throw new Error(`${flag} must be a positive integer.`);
  }

  return parsed;
}

function parseBenchmarkKind(flag: string, value?: string): BenchmarkScenarioKind {
  const kind = requireValue(flag, value);
  if (kind !== "cold" && kind !== "diff-only" && kind !== "warm") {
    throw new Error(`Unsupported benchmark kind: ${kind}`);
  }

  return kind;
}

function collectTrailingFiles(args: string[], startIndex: number, target: string[]): number {
  let index = startIndex;
  while (index < args.length) {
    const argument = args[index];
    if (argument === undefined || argument.startsWith("--")) {
      return index - 1;
    }

    target.push(argument);
    index += 1;
  }

  return args.length - 1;
}
