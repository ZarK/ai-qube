import type { CommandMetadata } from '@tjalve/qube-cli/metadata';
import { listCommands } from '@tjalve/qube-cli/registry';
import type { ExecutorCommandExtensions } from './command_definition.js';
import { EXECUTOR_COMMAND_REGISTRY } from './command_registry.js';

export type CommandMutationTarget = 'github' | 'git' | 'local-files' | 'local-process';

export interface CommandSchema {
  name: string;
  description: string;
  args: string[];
  argDetails: CommandArgSchema[];
  flags: string[];
  flagDetails: CommandFlagSchema[];
  mutates: boolean;
  mutationTargets: CommandMutationTarget[];
  supportsJson: boolean;
  supportsDryRun: boolean;
  supportsCheckOnly: boolean;
  externalServices: string[];
  stableErrorKinds: string[];
  exitCodes: number[];
  stageValues: string[];
  reviewAgentValues: string[];
  migrationModeValues: string[];
  migrationActionValues: string[];
  migrationConfidenceValues: string[];
  helpForms: string[];
  examples: string[];
}

export interface CommandArgSchema {
  name: string;
  description: string;
  required: boolean;
}

export type CommandFlagType = 'boolean' | 'string' | 'integer';

export interface CommandFlagSchema {
  name: string;
  type: CommandFlagType;
  description: string;
  options?: string[];
  default?: string | number | boolean;
  multiple?: boolean;
}

function findCommandMetadata(commandName: string): CommandMetadata<ExecutorCommandExtensions> {
  const command = listCommands(EXECUTOR_COMMAND_REGISTRY).find(metadata => metadata.name === commandName) as CommandMetadata<ExecutorCommandExtensions> | undefined;
  if (!command) {
    throw new Error(
      `Failed to resolve command metadata for "${commandName}". Likely cause: the command name is not implemented or is misspelled. Next action: check getImplementedCommands() for available commands or add the command to IMPLEMENTED_COMMANDS.`,
    );
  }
  return command;
}

function toCommandSchema(command: CommandMetadata<ExecutorCommandExtensions>): CommandSchema {
  const flagDetails = command.flags?.flatMap(toLegacyFlagDetails) ?? [];
  const flags = flagDetails.map(flag => flag.name);
  return {
    name: command.name,
    description: command.description,
    args: (command.arguments ?? []).map(argument => argument.name),
    argDetails: (command.arguments ?? []).map(argument => ({
      name: argument.name,
      description: argument.description,
      required: argument.required === true,
    })),
    flags,
    flagDetails,
    mutationTargets: [...(command.mutation?.categories ?? [])] as CommandMutationTarget[],
    examples: (command.examples ?? []).map(example => example.command),
    mutates: (command.mutation?.categories.length ?? 0) > 0,
    supportsJson: command.interactions?.json === true,
    supportsDryRun: command.interactions?.dryRun?.supported === true,
    supportsCheckOnly: command.extensions?.supportsCheckOnly ?? false,
    externalServices: (command.externalServices ?? []).map(service => service.name),
    stableErrorKinds: (command.errors ?? []).map(error => error.kind),
    exitCodes: (command.exitCodes ?? []).map(exitCode => exitCode.code),
    stageValues: [...(command.extensions?.stageValues ?? [])],
    reviewAgentValues: [...(command.extensions?.reviewAgentValues ?? [])],
    migrationModeValues: [...(command.extensions?.migrationModeValues ?? [])],
    migrationActionValues: [...(command.extensions?.migrationActionValues ?? [])],
    migrationConfidenceValues: [...(command.extensions?.migrationConfidenceValues ?? [])],
    helpForms: getHelpForms(command.name),
  };
}

function toLegacyFlagDetails(flag: NonNullable<CommandMetadata['flags']>[number]): CommandFlagSchema[] {
  const legacyNames = getLegacyFlagNames(flag);
  if (legacyNames) {
    return legacyNames.map(name => toLegacyFlagDetail(flag, name, flag.description));
  }

  const base = toLegacyFlagDetail(flag, flag.name, flag.description);
  const details = [base];
  if (flag.negatable === true) {
    details.push(toLegacyFlagDetail(flag, `no-${flag.name}`, `Disable ${flag.description.charAt(0).toLowerCase()}${flag.description.slice(1)}`));
  }
  for (const alias of flag.aliases ?? []) {
    details.push(toLegacyFlagDetail(flag, alias, flag.description));
    if (flag.negatable === true) {
      details.push(toLegacyFlagDetail(flag, `no-${alias}`, `Disable ${flag.description.charAt(0).toLowerCase()}${flag.description.slice(1)}`));
    }
  }
  return details;
}

function getLegacyFlagNames(flag: NonNullable<CommandMetadata['flags']>[number]): string[] | undefined {
  const legacyForms = flag.extensions?.legacyForms;
  if (!Array.isArray(legacyForms) || legacyForms.some(form => typeof form !== 'string')) {
    return undefined;
  }
  return legacyForms;
}

function toLegacyFlagDetail(flag: NonNullable<CommandMetadata['flags']>[number], name: string, description: string): CommandFlagSchema {
  const type = flag.type === 'option' ? 'string' : flag.type;
  return {
    name: `--${name}`,
    type: type === 'number' ? 'integer' : type,
    description,
    ...(flag.options ? { options: [...flag.options] } : {}),
    ...(Object.hasOwn(flag, 'defaultValue') ? { default: flag.defaultValue as string | number | boolean } : {}),
    ...(flag.multiple === true ? { multiple: true } : {}),
  };
}

export function getHelpForms(commandName: string): string[] {
  const parts = commandName.split(' ');
  return [
    `aie ${commandName} --help`,
    `aie help ${commandName}`,
    `aie ${[...parts, 'help'].join(' ')}`,
  ];
}

export function getImplementedCommands(): CommandSchema[] {
  return listCommands(EXECUTOR_COMMAND_REGISTRY).map(command => toCommandSchema(command as CommandMetadata<ExecutorCommandExtensions>));
}

export function getCommandMetadata(commandName: string): CommandSchema {
  return toCommandSchema(findCommandMetadata(commandName));
}

export function commandDescription(commandName: string): string {
  return findCommandMetadata(commandName).description;
}

export function commandExamples(commandName: string): string[] {
  return (findCommandMetadata(commandName).examples ?? []).map(example => example.command);
}

export function isHelpToken(token: string | undefined): boolean {
  return token === 'help' || token === '--help' || token === '-h';
}
