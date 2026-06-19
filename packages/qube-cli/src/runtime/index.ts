import { Command, Parser } from "@oclif/core";
import type { Interfaces } from "@oclif/core";

import type { ArgumentMetadata, CommandMetadata, FlagMetadata, MetadataExtensions, TopicMetadata } from "../metadata/index.js";
import { defineCommand } from "../metadata/index.js";
import type { CommandRegistry } from "../registry/index.js";
import { createCommandRegistry, listCommands } from "../registry/index.js";
import { normalizeHelpRequest, renderHelp, suggestCommand, suggestFlag } from "../help/index.js";
import { renderSchemaJson } from "../schema/index.js";
import type { SchemaSections } from "../schema/index.js";
import { createCliError, exitCodeForCategory, isCliError, renderCliErrorText } from "../errors/index.js";
import { renderJsonError, renderJsonSuccess, type JsonFields } from "../output/index.js";

type OclifShortFlag = Interfaces.AlphabetLowercase | Interfaces.AlphabetUppercase;

export interface RuntimeCommandContext {
  readonly command: CommandMetadata;
  readonly matchedName: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly flags: Readonly<Record<string, unknown>>;
  readonly argv: readonly string[];
}

export interface RuntimeCommandResult {
  readonly json?: JsonFields;
  readonly jsonStdout?: string;
  readonly human?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

export type RuntimeCommandHandler = (context: RuntimeCommandContext) => Promise<RuntimeCommandResult> | RuntimeCommandResult;

export interface RuntimeCommand {
  readonly metadata: CommandMetadata;
  readonly handler: RuntimeCommandHandler;
  readonly oclifCommand: typeof Command;
}

export interface RuntimeTopic {
  readonly metadata: TopicMetadata;
}

export interface RuntimePackageIdentity {
  readonly name: string;
  readonly version: string;
}

export interface CliRuntimeOptions {
  readonly bin: string;
  readonly packageName?: string | undefined;
  readonly packageVersion?: string | undefined;
  readonly description?: string | undefined;
  readonly registry: CommandRegistry;
  readonly commands: readonly RuntimeCommand[];
  readonly topics?: readonly RuntimeTopic[];
}

export interface CliRuntime {
  readonly bin: string;
  readonly package?: RuntimePackageIdentity;
  readonly description?: string | undefined;
  readonly registry: CommandRegistry;
  readonly commands: readonly RuntimeCommand[];
  readonly topics: readonly RuntimeTopic[];
}

export interface CliRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly executedCommand?: string;
}

export interface SchemaCommandOptions {
  readonly registry: CommandRegistry | (() => CommandRegistry);
  readonly bin: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly sections?: SchemaSections;
  readonly extensions?: MetadataExtensions;
}

export function createCommand(metadata: CommandMetadata, handler: RuntimeCommandHandler): RuntimeCommand {
  const args = createOclifArgs(metadata.arguments ?? []);
  const flags = createOclifFlags(metadata.flags ?? []);
  const examples = (metadata.examples ?? []).map((example) => `${example.command}  # ${example.description}`);

  class MetadataCommand extends Command {
    static override aliases = [...(metadata.aliases ?? [])];
    static override args = args;
    static override description = metadata.description;
    static override examples = examples;
    static override flags = flags;
    static override id = metadata.name;
    static override summary = metadata.description;

    async run(): Promise<RuntimeCommandResult> {
      const parsed = await this.parse(MetadataCommand);
      return handler({
        command: metadata,
        matchedName: metadata.name,
        args: parsed.args,
        flags: parsed.flags,
        argv: this.argv
      });
    }
  }

  return Object.freeze({ metadata, handler, oclifCommand: MetadataCommand });
}

export function createTopicCommand(metadata: TopicMetadata): RuntimeTopic {
  return Object.freeze({ metadata });
}

export function createSchemaCommand(options: SchemaCommandOptions): RuntimeCommand {
  const metadata = defineCommand({
    kind: "command",
    name: "schema",
    description: "Render deterministic command schema as JSON.",
    flags: [
      {
        name: "json",
        description: "Render machine-readable JSON output.",
        type: "boolean"
      }
    ],
    examples: [
      {
        description: "Render the command schema.",
        command: `${options.bin} schema --json`
      }
    ],
    output: {
      formats: ["json"],
      defaultFormat: "json"
    },
    interactions: {
      json: true,
      noColor: true,
      nonInteractive: true,
      ttyPrompt: false
    }
  });

  return createCommand(metadata, () => {
    const resolved = resolveRegistry(options.registry);
    const schemaOptions = options.extensions
      ? {
          packageName: options.packageName,
          packageVersion: options.packageVersion,
          bin: options.bin,
          ...(options.sections ? { sections: options.sections } : {}),
          extensions: options.extensions
        }
      : {
          packageName: options.packageName,
          packageVersion: options.packageVersion,
          bin: options.bin,
          ...(options.sections ? { sections: options.sections } : {})
        };
    return {
      stdout: renderSchemaJson(resolved, schemaOptions),
      jsonStdout: renderSchemaJson(resolved, schemaOptions)
    };
  });
}

export function createCli(options: CliRuntimeOptions): CliRuntime {
  const runtimeCommands = [...options.commands];
  const runtimeMetadata = runtimeCommands.map((command) => command.metadata);
  const registry = createCommandRegistry({
    topics: options.registry.topics,
    commands: mergeCommands(options.registry.commands, runtimeMetadata)
  });
  ensureCommandHandlers(registry, runtimeCommands);
  const packageIdentity = createPackageIdentity(options);

  const runtime = {
    bin: options.bin,
    description: options.description,
    registry,
    commands: Object.freeze(runtimeCommands),
    topics: Object.freeze([...(options.topics ?? [])])
  };
  return Object.freeze(packageIdentity ? { ...runtime, package: packageIdentity } : runtime);
}

export async function runCli(cli: CliRuntime, argv: readonly string[]): Promise<CliRunResult> {
  const helpRequest = normalizeHelpRequest(argv);
  if (helpRequest) {
    return renderHelpResult(cli, helpRequest);
  }

  const versionRequest = normalizeVersionRequest(argv);
  if (versionRequest) {
    return renderVersionResult(cli, versionRequest.json);
  }

  const match = matchRuntimeCommand(cli, argv);
  if (!match) {
    const attemptedCommand = trimAtFirstFlag(argv).join(" ");
    const suggestion = suggestCommand(cli.registry, attemptedCommand);
    const error = createCliError({
      command: attemptedCommand || "<empty>",
      kind: "unknown-command",
      operation: "match command",
      likelyCause: `No command named "${attemptedCommand || "<empty>"}" is registered.`,
      suggestedNextAction: suggestion ? `Run "${suggestion.value}" instead.` : "Run help to list available commands.",
      category: "usage"
    });
    if (argvRequestsJson(argv)) {
      return renderErrorResult(error, true);
    }
    return {
      exitCode: error.exitCode,
      stdout: "",
      stderr: `Unknown command: ${attemptedCommand || "<empty>"}${suggestion ? `\nDid you mean "${suggestion.value}"?` : ""}\n`
    };
  }

  const jsonMode = commandRequestsJson(match.command.metadata, match.argv);

  const unknownFlag = findUnknownFlag(match.command.metadata, match.argv);
  if (unknownFlag) {
    const suggestion = suggestFlag(match.command.metadata, unknownFlag);
    const error = createCliError({
      command: match.command.metadata.name,
      kind: "unknown-flag",
      operation: "parse flags",
      likelyCause: `Flag "${unknownFlag}" is not defined for ${match.command.metadata.name}.`,
      suggestedNextAction: suggestion ? `Use "${suggestion.value}" instead.` : "Run command help to list supported flags.",
      category: "usage"
    });
    if (jsonMode) {
      return renderErrorResult(error, true);
    }
    return {
      exitCode: error.exitCode,
      stdout: "",
      stderr: `Unknown flag: ${unknownFlag}${suggestion ? `\nDid you mean "${suggestion.value}"?` : ""}\n`
    };
  }

  const negatableConflict = findNegatableFlagConflict(match.command.metadata, match.argv);
  if (negatableConflict) {
    const error = createCliError({
      command: match.command.metadata.name,
      kind: "invalid-command-usage",
      operation: "parse flags",
      likelyCause: `Flag "${negatableConflict}" was provided more than once or with conflicting negated forms.`,
      suggestedNextAction: "Provide either the positive or negative form once.",
      category: "usage"
    });
    if (jsonMode) {
      return renderErrorResult(error, true);
    }
    return {
      exitCode: error.exitCode,
      stdout: "",
      stderr: renderCliErrorText(error)
    };
  }

  const parsed = await parseCommandArgs(match.command.metadata, match.argv, jsonMode);
  if (parsed.result) {
    return parsed.result;
  }

  try {
    const result = await match.command.handler({
        command: match.command.metadata,
        matchedName: match.matchedName,
        args: parsed.args,
        flags: parsed.flags,
        argv: match.argv
    });
    return renderCommandResult(match.command.metadata.name, result, jsonMode);
  } catch (error) {
    return renderErrorResult(normalizeThrownError(error, match.command.metadata.name), jsonMode);
  }
}

async function parseCommandArgs(
  command: CommandMetadata,
  argv: readonly string[],
  jsonMode: boolean
): Promise<
  | { readonly args: Readonly<Record<string, unknown>>; readonly flags: Readonly<Record<string, unknown>>; readonly result?: never }
  | { readonly result: CliRunResult; readonly args?: never; readonly flags?: never }
> {
  const variadicArgs = extractVariadicArguments(command, argv, jsonMode);
  if (variadicArgs?.result) {
    return { result: variadicArgs.result };
  }

  try {
    const parserArguments = variadicArgs
      ? (command.arguments ?? []).filter((argument) => argument !== variadicArgs.argument)
      : command.arguments ?? [];
    const parsed = await Parser.parse([...(variadicArgs?.argv ?? argv)], {
      args: createOclifArgs(parserArguments),
      flags: createOclifFlags(command.flags ?? []),
      strict: true
    });
    return {
      args: variadicArgs ? { ...parsed.args, [variadicArgs.argument.name]: variadicArgs.values } : parsed.args,
      flags: parsed.flags
    };
  } catch (error) {
    return {
      result: renderErrorResult(
        createCliError({
          command: command.name,
          kind: "invalid-command-usage",
          operation: "parse command arguments",
          likelyCause: error instanceof Error ? error.message : String(error),
          suggestedNextAction: "Run command help and retry with valid arguments and flags.",
          category: "usage"
        }),
        jsonMode
      )
    };
  }
}

function extractVariadicArguments(
  command: CommandMetadata,
  argv: readonly string[],
  jsonMode: boolean
):
  | {
      readonly argument: ArgumentMetadata;
      readonly argv: readonly string[];
      readonly values: readonly string[];
      readonly result?: never;
    }
  | { readonly result: CliRunResult; readonly argument?: never; readonly argv?: never; readonly values?: never }
  | undefined {
  const variadicArguments = (command.arguments ?? []).filter((argument) => argument.multiple === true);
  if (variadicArguments.length === 0) {
    return undefined;
  }

  const [argument] = variadicArguments;
  if (!argument || variadicArguments.length > 1 || (command.arguments ?? []).at(-1) !== argument) {
    return {
      result: renderErrorResult(
        createCliError({
          command: command.name,
          kind: "invalid-command-metadata",
          operation: "parse command arguments",
          likelyCause: "Variadic positional arguments must be declared once and as the final argument.",
          suggestedNextAction: "Fix the command metadata before running this command.",
          category: "unexpected"
        }),
        jsonMode
      )
    };
  }

  const fixedPositionalCount = Math.max(0, (command.arguments ?? []).indexOf(argument));
  const split = splitVariadicArgv(command, argv, fixedPositionalCount);
  if (argument.required === true && split.values.length === 0) {
    return {
      result: renderErrorResult(
        createCliError({
          command: command.name,
          kind: "invalid-command-usage",
          operation: "parse command arguments",
          likelyCause: `Missing required argument: ${argument.name}.`,
          suggestedNextAction: "Run command help and retry with valid arguments and flags.",
          category: "usage"
        }),
        jsonMode
      )
    };
  }

  return { argument, argv: split.argv, values: split.values };
}

function splitVariadicArgv(
  command: CommandMetadata,
  argv: readonly string[],
  fixedPositionalCount: number
): { readonly argv: readonly string[]; readonly values: readonly string[] } {
  const parserArgv: string[] = [];
  const values: string[] = [];
  let consumedFixedPositionals = 0;
  const longFlags = new Map<string, FlagMetadata>();
  const shortFlags = new Map<string, FlagMetadata>();
  for (const flag of command.flags ?? []) {
    longFlags.set(flag.name, flag);
    for (const alias of flag.aliases ?? []) {
      longFlags.set(alias, flag);
    }
    if (flag.short) {
      shortFlags.set(flag.short, flag);
    }
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }

    if (token === "--") {
      for (const rest of argv.slice(index + 1)) {
        if (consumedFixedPositionals < fixedPositionalCount) {
          parserArgv.push(rest);
          consumedFixedPositionals += 1;
        } else {
          values.push(rest);
        }
      }
      break;
    }

    const flag = resolveFlagToken(token, longFlags, shortFlags);
    if (flag) {
      parserArgv.push(token);
      if (flag.type !== "boolean" && !token.includes("=")) {
        const value = argv[index + 1];
        if (value !== undefined) {
          parserArgv.push(value);
          index += 1;
        }
      }
      continue;
    }

    if (consumedFixedPositionals < fixedPositionalCount) {
      parserArgv.push(token);
      consumedFixedPositionals += 1;
    } else {
      values.push(token);
    }
  }

  return { argv: parserArgv, values };
}

function resolveFlagToken(
  token: string,
  longFlags: ReadonlyMap<string, FlagMetadata>,
  shortFlags: ReadonlyMap<string, FlagMetadata>
): FlagMetadata | undefined {
  if (token.startsWith("--")) {
    const [rawName] = token.slice(2).split("=", 1);
    if (!rawName) {
      return undefined;
    }
    const flag = longFlags.get(rawName);
    if (flag) {
      return flag;
    }
    if (rawName.startsWith("no-")) {
      const negated = longFlags.get(rawName.slice(3));
      return negated?.negatable === true ? negated : undefined;
    }
    return undefined;
  }

  if (/^-\d/.test(token) || !token.startsWith("-")) {
    return undefined;
  }

  const [rawName] = token.slice(1).split("=", 1);
  return rawName ? shortFlags.get(rawName) : undefined;
}

function renderCommandResult(command: string, result: RuntimeCommandResult, jsonMode: boolean): CliRunResult {
  const exitCode = result.exitCode ?? 0;
  if (jsonMode && result.jsonStdout !== undefined) {
    return {
      exitCode,
      stdout: validateJsonStdout(result.jsonStdout),
      stderr: joinOutput([result.stderr, result.human]),
      executedCommand: command
    };
  }

  if (jsonMode && exitCode !== 0) {
    return renderErrorResult(
      createCliError({
        command,
        kind: "command-failed",
        operation: `run ${command}`,
        likelyCause: firstNonEmpty([result.stderr, result.human, result.stdout]) ?? `Command exited with code ${exitCode}.`,
        suggestedNextAction: "Inspect the command failure and retry after the underlying issue is fixed.",
        category: "unexpected",
        exitCode
      }),
      true
    );
  }

  if (jsonMode && result.json) {
    return {
      exitCode,
      stdout: renderJsonSuccess(command, result.json),
      stderr: joinOutput([result.stderr, result.stdout]),
      executedCommand: command
    };
  }

  return {
    exitCode,
    stdout: jsonMode ? renderJsonSuccess(command, { output: result.stdout ?? result.human ?? "" }) : result.human ?? result.stdout ?? "",
    stderr: result.stderr ?? "",
    executedCommand: command
  };
}

function renderErrorResult(error: ReturnType<typeof createCliError>, jsonMode: boolean): CliRunResult {
  if (jsonMode) {
    const result = {
      exitCode: error.exitCode,
      stdout: renderJsonError(error),
      stderr: ""
    };
    return error.command ? { ...result, executedCommand: error.command } : result;
  }
  const result = {
    exitCode: error.exitCode,
    stdout: "",
    stderr: renderCliErrorText(error)
  };
  return error.command ? { ...result, executedCommand: error.command } : result;
}

function renderVersionResult(cli: CliRuntime, jsonMode: boolean): CliRunResult {
  if (!cli.package) {
    const error = createCliError({
      command: "version",
      kind: "version-not-configured",
      operation: "render version",
      likelyCause: "No package name and version were configured for this CLI runtime.",
      suggestedNextAction: "Pass packageName and packageVersion to createCli.",
      category: "usage"
    });
    return renderErrorResult(error, jsonMode);
  }

  if (jsonMode) {
    return {
      exitCode: 0,
      stdout: renderJsonSuccess("version", {
        package: {
          name: cli.package.name,
          version: cli.package.version
        },
        version: cli.package.version
      }),
      stderr: "",
      executedCommand: "version"
    };
  }

  return {
    exitCode: 0,
    stdout: `${cli.package.version}\n`,
    stderr: "",
    executedCommand: "version"
  };
}

function normalizeThrownError(error: unknown, command: string): ReturnType<typeof createCliError> {
  if (isCliError(error)) {
    return error.command ? error : createCliError({ ...error, command });
  }
  return createCliError({
    command,
    kind: "unexpected-error",
    operation: `run ${command}`,
    likelyCause: error instanceof Error ? error.message : String(error),
    suggestedNextAction: "Inspect the command failure and retry after the underlying issue is fixed.",
    category: "unexpected",
    exitCode: exitCodeForCategory("unexpected")
  });
}

function commandRequestsJson(command: CommandMetadata, argv: readonly string[]): boolean {
  if (command.interactions?.json !== true) {
    return false;
  }
  return argvRequestsJson(argv) || commandFlagRequestsJson(command, argv);
}

function argvRequestsJson(argv: readonly string[]): boolean {
  const positionalSeparatorIndex = argv.indexOf("--");
  const flagArgv = positionalSeparatorIndex === -1 ? argv : argv.slice(0, positionalSeparatorIndex);
  return flagArgv.some(
    (token, index) => token === "--json" || token === "--output=json" || (token === "--output" && flagArgv[index + 1] === "json")
  );
}

function commandFlagRequestsJson(command: CommandMetadata, argv: readonly string[]): boolean {
  const positionalSeparatorIndex = argv.indexOf("--");
  const flagArgv = positionalSeparatorIndex === -1 ? argv : argv.slice(0, positionalSeparatorIndex);
  const jsonShorts = new Set((command.flags ?? []).filter((flag) => flag.name === "json").map((flag) => flag.short).filter(isString));
  const outputShorts = new Set((command.flags ?? []).filter((flag) => flag.name === "output").map((flag) => flag.short).filter(isString));
  return flagArgv.some((token, index) => {
    if (!token.startsWith("-") || token.startsWith("--")) {
      return false;
    }
    const [shortName] = token.slice(1).split("=", 1);
    if (!shortName) {
      return false;
    }
    if (jsonShorts.has(shortName)) {
      return true;
    }
    return outputShorts.has(shortName) && (token === `-${shortName}=json` || flagArgv[index + 1] === "json");
  });
}

function normalizeVersionRequest(argv: readonly string[]): { readonly json: boolean } | undefined {
  if (argv.length === 0) {
    return undefined;
  }
  let hasVersion = false;
  let hasJson = false;
  for (const token of argv) {
    if (token === "--version" || token === "-v") {
      hasVersion = true;
      continue;
    }
    if (token === "--json") {
      hasJson = true;
      continue;
    }
    return undefined;
  }
  return hasVersion ? { json: hasJson } : undefined;
}

function joinOutput(parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part.length > 0).join("");
}

function firstNonEmpty(parts: readonly (string | undefined)[]): string | undefined {
  return parts.find((part): part is string => part !== undefined && part.length > 0);
}

function validateJsonStdout(stdout: string): string {
  JSON.parse(stdout);
  return stdout;
}

function renderHelpResult(cli: CliRuntime, helpRequest: NonNullable<ReturnType<typeof normalizeHelpRequest>>): CliRunResult {
  try {
    return {
      exitCode: 0,
      stdout: renderHelp(
        cli.registry,
        helpRequest,
        cli.package
          ? { bin: cli.bin, packageVersion: cli.package.version, description: cli.description }
          : { bin: cli.bin, description: cli.description }
      ),
      stderr: ""
    };
  } catch (error) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `${error instanceof Error ? error.message : String(error)}\n`
    };
  }
}

function createOclifArgs(args: readonly ArgumentMetadata[]): Interfaces.ArgInput {
  const input: Interfaces.ArgInput = {};
  for (const argument of args) {
    const arg = {
      input: [],
      name: argument.name,
      description: argument.description,
      ...(argument.multiple === true ? { multiple: true } : {}),
      required: argument.required === true,
      parse: async (value: string) => value
    };
    input[argument.name] = arg as Interfaces.Arg<unknown>;
  }
  return input;
}

function createOclifFlags(flags: readonly FlagMetadata[]): Interfaces.FlagInput {
  const input: Interfaces.FlagInput = {};
  for (const flag of flags) {
    input[flag.name] = createOclifFlag(flag);
  }
  return input;
}

function createOclifFlag(flag: FlagMetadata): Interfaces.Flag<unknown> {
  const common = {
    description: flag.description,
    name: flag.name,
    required: flag.required === true
  };
  const aliases = flag.aliases && flag.aliases.length > 0 ? { aliases: [...flag.aliases] } : {};
  const short = flag.short ? { char: flag.short as OclifShortFlag } : {};

  if (flag.type === "boolean") {
    return {
      ...common,
      ...aliases,
      ...short,
      allowNo: flag.negatable === true,
      parse: async (value: boolean) => value,
      type: "boolean"
    };
  }

  const options = flag.options && flag.options.length > 0 ? { options: [...flag.options] } : {};
  return {
    ...common,
    ...aliases,
    ...short,
    ...options,
    input: [],
    multiple: flag.multiple === true,
    ...(flag.multiple === true ? { multipleNonGreedy: true } : {}),
    parse: async (value: string) => parseFlagValue(flag, value),
    type: "option"
  };
}

async function parseFlagValue(flag: FlagMetadata, value: string): Promise<unknown> {
  if (flag.type === "integer") {
    if (!/^-?\d+$/.test(value)) {
      throw new Error(`Expected an integer but received: ${value}`);
    }
    return Number.parseInt(value, 10);
  }
  if (flag.type === "number") {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      throw new Error(`Expected a number but received: ${value}`);
    }
    return number;
  }
  if (flag.type === "option" && flag.options && !flag.options.includes(value)) {
    throw new Error(`Expected one of ${flag.options.join(", ")} but received: ${value}`);
  }
  return value;
}

function matchRuntimeCommand(
  cli: CliRuntime,
  argv: readonly string[]
): { readonly command: RuntimeCommand; readonly matchedName: string; readonly argv: readonly string[] } | undefined {
  const commandByName = new Map(cli.commands.map((command) => [command.metadata.name, command]));
  const commandByAlias = new Map(cli.commands.flatMap((command) => (command.metadata.aliases ?? []).map((alias) => [alias, command])));
  const commandNames = [...commandByName.keys()].sort((left, right) => right.split(" ").length - left.split(" ").length || compareText(left, right));
  for (const commandName of commandNames) {
    const tokens = commandName.split(" ");
    if (tokens.every((token, index) => argv[index] === token)) {
      const command = commandByName.get(commandName);
      if (command) {
        return { command, matchedName: commandName, argv: argv.slice(tokens.length) };
      }
    }
  }

  const [firstToken] = argv;
  if (firstToken) {
    const aliasMatch = commandByAlias.get(firstToken);
    if (aliasMatch) {
      return { command: aliasMatch, matchedName: firstToken, argv: argv.slice(1) };
    }
  }
  return undefined;
}

function mergeCommands(registryCommands: readonly CommandMetadata[], runtimeCommands: readonly CommandMetadata[]): readonly CommandMetadata[] {
  const commands = new Map(registryCommands.map((command) => [command.name, command]));
  for (const runtimeCommand of runtimeCommands) {
    commands.set(runtimeCommand.name, runtimeCommand);
  }
  return [...commands.values()];
}

function resolveRegistry(registry: CommandRegistry | (() => CommandRegistry)): CommandRegistry {
  return typeof registry === "function" ? registry() : registry;
}

function createPackageIdentity(options: CliRuntimeOptions): RuntimePackageIdentity | undefined {
  const hasName = options.packageName !== undefined;
  const hasVersion = options.packageVersion !== undefined;
  if (hasName !== hasVersion) {
    throw new TypeError("createCli requires packageName and packageVersion to be configured together.");
  }
  if (!hasName || !hasVersion) {
    return undefined;
  }
  requireNonEmpty(options.packageName, "packageName");
  requireNonEmpty(options.packageVersion, "packageVersion");
  return Object.freeze({ name: options.packageName, version: options.packageVersion });
}

function ensureCommandHandlers(registry: CommandRegistry, commands: readonly RuntimeCommand[]): void {
  const commandNames = new Set(commands.map((command) => command.metadata.name));
  const missingHandlers = listCommands(registry).filter((command) => !commandNames.has(command.name));
  if (missingHandlers.length > 0) {
    throw new TypeError(`Missing runtime handlers for commands: ${missingHandlers.map((command) => command.name).join(", ")}.`);
  }
}

function findUnknownFlag(command: CommandMetadata, argv: readonly string[]): string | undefined {
  const knownFlags = new Set((command.flags ?? []).flatMap(renderKnownLongFlagNames));
  const knownShortFlags = new Set((command.flags ?? []).map((flag) => flag.short).filter(isString));
  for (const token of argv) {
    if (token === "--") {
      return undefined;
    }
    if (!token.startsWith("-")) {
      continue;
    }
    if (token.startsWith("--")) {
      const [name] = token.slice(2).split("=", 1);
      if (name && !knownFlags.has(name)) {
        return `--${name}`;
      }
      continue;
    }
    if (/^-\d/.test(token)) {
      continue;
    }
    const [name] = token.slice(1).split("=", 1);
    if (name && !knownShortFlags.has(name)) {
      return `-${name}`;
    }
  }
  return undefined;
}

function findNegatableFlagConflict(command: CommandMetadata, argv: readonly string[]): string | undefined {
  const positionalSeparatorIndex = argv.indexOf("--");
  const flagArgv = positionalSeparatorIndex === -1 ? argv : argv.slice(0, positionalSeparatorIndex);
  for (const flag of command.flags ?? []) {
    if (flag.negatable !== true) {
      continue;
    }
    const positive = new Set([flag.name, ...(flag.aliases ?? [])].map((name) => `--${name}`));
    const negative = new Set([flag.name, ...(flag.aliases ?? [])].map((name) => `--no-${name}`));
    const count = flagArgv.filter((token) => positive.has(token) || negative.has(token)).length;
    if (count > 1) {
      return flag.name;
    }
  }
  return undefined;
}

function renderKnownLongFlagNames(flag: FlagMetadata): readonly string[] {
  return [
    flag.name,
    ...(flag.negatable === true ? [`no-${flag.name}`] : []),
    ...(flag.aliases ?? []).flatMap((alias) => [alias, ...(flag.negatable === true ? [`no-${alias}`] : [])])
  ];
}

function trimAtFirstFlag(tokens: readonly string[]): readonly string[] {
  const flagIndex = tokens.findIndex((token) => token.startsWith("-"));
  return flagIndex === -1 ? tokens : tokens.slice(0, flagIndex);
}

function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${field} must not be empty.`);
  }
}

function isString(value: string | undefined): value is string {
  return typeof value === "string";
}
