import { Command, Parser } from "@oclif/core";
import type { Interfaces } from "@oclif/core";

import type { ArgumentMetadata, CommandMetadata, FlagMetadata, TopicMetadata } from "../metadata/index.js";
import { defineCommand } from "../metadata/index.js";
import type { CommandRegistry } from "../registry/index.js";
import { createCommandRegistry, listCommands } from "../registry/index.js";
import { normalizeHelpRequest, renderHelp, suggestCommand, suggestFlag } from "../help/index.js";

export interface RuntimeCommandContext {
  readonly command: CommandMetadata;
  readonly args: Readonly<Record<string, unknown>>;
  readonly flags: Readonly<Record<string, unknown>>;
  readonly argv: readonly string[];
}

export interface RuntimeCommandResult {
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

export function createSchemaCommand(registry: CommandRegistry | (() => CommandRegistry), bin: string): RuntimeCommand {
  const metadata = defineCommand({
    kind: "command",
    name: "schema",
    description: "Render fixture command metadata as deterministic JSON.",
    flags: [
      {
        name: "json",
        description: "Render machine-readable JSON output.",
        type: "boolean"
      }
    ],
    examples: [
      {
        description: "Render the fixture metadata schema.",
        command: `${bin} schema --json`
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
    const resolved = resolveRegistry(registry);
    return {
      stdout: `${JSON.stringify({ bin, topics: resolved.topics, commands: resolved.commands }, null, 2)}\n`
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
    return {
      exitCode: 2,
      stdout: "",
      stderr: `Unknown command: ${attemptedCommand || "<empty>"}${suggestion ? `\nDid you mean "${suggestion.value}"?` : ""}\n`
    };
  }

  const unknownFlag = findUnknownFlag(match.command.metadata, match.argv);
  if (unknownFlag) {
    const suggestion = suggestFlag(match.command.metadata, unknownFlag);
    return {
      exitCode: 2,
      stdout: "",
      stderr: `Unknown flag: ${unknownFlag}${suggestion ? `\nDid you mean "${suggestion.value}"?` : ""}\n`
    };
  }

  try {
    const parsed = await Parser.parse([...match.argv], {
      args: createOclifArgs(match.command.metadata.arguments ?? []),
      flags: createOclifFlags(match.command.metadata.flags ?? []),
      strict: true
    });
    const result = await match.command.handler({
      command: match.command.metadata,
      args: parsed.args,
      flags: parsed.flags,
      argv: match.argv
    });
    return {
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      executedCommand: match.command.metadata.name
    };
  } catch (error) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `${error instanceof Error ? error.message : String(error)}\n`
    };
  }
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
