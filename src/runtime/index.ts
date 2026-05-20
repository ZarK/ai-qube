import { Command, Parser } from "@oclif/core";
import type { Interfaces } from "@oclif/core";

import type { ArgumentMetadata, CommandMetadata, FlagMetadata, MetadataExtensions, TopicMetadata } from "../metadata/index.js";
import { defineCommand } from "../metadata/index.js";
import type { CommandRegistry } from "../registry/index.js";
import { createCommandRegistry, listCommands } from "../registry/index.js";
import { normalizeHelpRequest, renderHelp, suggestCommand, suggestFlag } from "../help/index.js";
import { renderSchemaJson } from "../schema/index.js";
import { createCliError, exitCodeForCategory, isCliError, renderCliErrorText } from "../errors/index.js";
import { renderJsonError, renderJsonSuccess, type JsonFields } from "../output/index.js";

export interface RuntimeCommandContext {
  readonly command: CommandMetadata;
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

export interface CliRuntimeOptions {
  readonly bin: string;
  readonly description?: string | undefined;
  readonly registry: CommandRegistry;
  readonly commands: readonly RuntimeCommand[];
  readonly topics?: readonly RuntimeTopic[];
}

export interface CliRuntime {
  readonly bin: string;
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
          extensions: options.extensions
        }
      : {
          packageName: options.packageName,
          packageVersion: options.packageVersion,
          bin: options.bin
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

  return Object.freeze({
    bin: options.bin,
    description: options.description,
    registry,
    commands: Object.freeze(runtimeCommands),
    topics: Object.freeze([...(options.topics ?? [])])
  });
}

export async function runCli(cli: CliRuntime, argv: readonly string[]): Promise<CliRunResult> {
  const helpRequest = normalizeHelpRequest(argv);
  if (helpRequest) {
    return renderHelpResult(cli, helpRequest);
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

  const parsed = await parseCommandArgs(match.command.metadata, match.argv, jsonMode);
  if (parsed.result) {
    return parsed.result;
  }

  try {
    const result = await match.command.handler({
      command: match.command.metadata,
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
  try {
    const parsed = await Parser.parse([...argv], {
      args: createOclifArgs(command.arguments ?? []),
      flags: createOclifFlags(command.flags ?? []),
      strict: true
    });
    return {
      args: parsed.args,
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

function renderCommandResult(command: string, result: RuntimeCommandResult, jsonMode: boolean): CliRunResult {
  const exitCode = result.exitCode ?? 0;
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

  if (jsonMode && result.jsonStdout !== undefined) {
    return {
      exitCode,
      stdout: validateJsonStdout(result.jsonStdout),
      stderr: joinOutput([result.stderr, result.human]),
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
  return argvRequestsJson(argv);
}

function argvRequestsJson(argv: readonly string[]): boolean {
  const positionalSeparatorIndex = argv.indexOf("--");
  const flagArgv = positionalSeparatorIndex === -1 ? argv : argv.slice(0, positionalSeparatorIndex);
  return flagArgv.some(
    (token, index) => token === "--json" || token === "--output=json" || (token === "--output" && flagArgv[index + 1] === "json")
  );
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
      stdout: renderHelp(cli.registry, helpRequest, { bin: cli.bin, description: cli.description }),
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
    input[argument.name] = {
      input: [],
      name: argument.name,
      description: argument.description,
      required: argument.required === true,
      parse: async (value: string) => value
    };
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

  if (flag.type === "boolean") {
    return {
      ...common,
      ...aliases,
      allowNo: false,
      parse: async (value: boolean) => value,
      type: "boolean"
    };
  }

  const options = flag.options && flag.options.length > 0 ? { options: [...flag.options] } : {};
  return {
    ...common,
    ...aliases,
    ...options,
    input: [],
    multiple: flag.multiple === true,
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
): { readonly command: RuntimeCommand; readonly argv: readonly string[] } | undefined {
  const commandByName = new Map(cli.commands.map((command) => [command.metadata.name, command]));
  const commandByAlias = new Map(cli.commands.flatMap((command) => (command.metadata.aliases ?? []).map((alias) => [alias, command])));
  const commandNames = [...commandByName.keys()].sort((left, right) => right.split(" ").length - left.split(" ").length || compareText(left, right));
  for (const commandName of commandNames) {
    const tokens = commandName.split(" ");
    if (tokens.every((token, index) => argv[index] === token)) {
      const command = commandByName.get(commandName);
      if (command) {
        return { command, argv: argv.slice(tokens.length) };
      }
    }
  }

  const [firstToken] = argv;
  if (firstToken) {
    const aliasMatch = commandByAlias.get(firstToken);
    if (aliasMatch) {
      return { command: aliasMatch, argv: argv.slice(1) };
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

function ensureCommandHandlers(registry: CommandRegistry, commands: readonly RuntimeCommand[]): void {
  const commandNames = new Set(commands.map((command) => command.metadata.name));
  const missingHandlers = listCommands(registry).filter((command) => !commandNames.has(command.name));
  if (missingHandlers.length > 0) {
    throw new TypeError(`Missing runtime handlers for commands: ${missingHandlers.map((command) => command.name).join(", ")}.`);
  }
}

function findUnknownFlag(command: CommandMetadata, argv: readonly string[]): string | undefined {
  const knownFlags = new Set((command.flags ?? []).flatMap((flag) => [flag.name, ...(flag.aliases ?? [])]));
  for (const token of argv) {
    if (token === "--") {
      return undefined;
    }
    if (!token.startsWith("--")) {
      continue;
    }
    const [name] = token.slice(2).split("=", 1);
    if (name && !knownFlags.has(name)) {
      return `--${name}`;
    }
  }
  return undefined;
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
