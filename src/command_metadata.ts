import { COMMON_ERROR_KINDS, CommandMetadataInput, IMPLEMENTED_COMMANDS } from './command_catalog.js';

export type CommandMutationTarget = 'github' | 'git' | 'local-files';

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

function findCommandMetadata(commandName: string): CommandMetadataInput {
  const command = IMPLEMENTED_COMMANDS.find(metadata => metadata.name === commandName);
  if (!command) {
    throw new Error(
      `Failed to resolve command metadata for "${commandName}". Likely cause: the command name is not implemented or is misspelled. Next action: check getImplementedCommands() for available commands or add the command to IMPLEMENTED_COMMANDS.`,
    );
  }
  return command;
}

function toCommandSchema(command: CommandMetadataInput): CommandSchema {
  return {
    ...command,
    args: [...command.args],
    argDetails: command.args.map(argument => inferArgDetails(command.name, argument)),
    flags: [...command.flags],
    flagDetails: command.flagDetails ? command.flagDetails.map(flag => ({ ...flag, options: flag.options ? [...flag.options] : undefined })) : command.flags.map(flag => inferFlagDetails(command.name, flag)),
    mutationTargets: [...command.mutationTargets],
    examples: [...command.examples],
    mutates: command.mutationTargets.length > 0,
    supportsCheckOnly: command.supportsCheckOnly ?? false,
    externalServices: [...(command.externalServices ?? [])],
    stableErrorKinds: [...(command.stableErrorKinds ?? COMMON_ERROR_KINDS)],
    exitCodes: [...(command.exitCodes ?? [0, 1])],
    stageValues: [...(command.stageValues ?? [])],
    reviewAgentValues: [...(command.reviewAgentValues ?? [])],
    migrationModeValues: [...(command.migrationModeValues ?? [])],
    migrationActionValues: [...(command.migrationActionValues ?? [])],
    migrationConfidenceValues: [...(command.migrationConfidenceValues ?? [])],
    helpForms: getHelpForms(command.name),
  };
}

function inferArgDetails(commandName: string, argument: string): CommandArgSchema {
  const descriptions: Record<string, Record<string, string>> = {
    init: { target: 'Repository path to initialize, usually .' },
    start: { issue: 'Issue selector: next, a bare number such as 93, or shell-safe #93' },
    switch: { issue: 'Target issue number, for example 93 or #93' },
    complete: { issue: 'Issue number to complete, for example 93 or #93' },
    'audit ui': { issue: 'Issue number for the manual UI audit plan, for example 93 or #93' },
    'review gate': { issue: 'Issue number for the review gate, for example 93 or #93' },
    'pr view': { pr: 'Pull request number for concise PR state, for example 12 or #12' },
    'pr body': { issue: 'Issue number the pull request closes, for example 93 or #93' },
    'pr gate': { pr: 'Pull request number for the PR review gate, for example 12 or #12' },
    'branch suggest': { issue: 'Issue number used to suggest a branch name, for example 93 or #93' },
    'branch check': { issue: 'Issue number used to verify the current branch, for example 93 or #93' },
    'branch create': { issue: 'Issue number used to create the policy-compliant branch, for example 93 or #93' },
  };
  const requiredArgCommands = new Set([
    'switch',
    'complete',
    'init',
    'audit ui',
    'review gate',
    'pr view',
    'pr body',
    'pr gate',
    'branch suggest',
    'branch check',
    'branch create',
    'deps blockers',
    'deps blocking',
    'deps chain',
    'view',
  ]);
  const defaultDescriptions: Record<string, string> = {
    issue: 'Issue number, for example 93 or #93',
    pr: 'Pull request number, for example 12 or #12',
    target: 'Target path or selector for the command',
  };
  return {
    name: argument,
    description: descriptions[commandName]?.[argument] ?? defaultDescriptions[argument] ?? `Argument ${argument} for aie ${commandName}`,
    required: requiredArgCommands.has(commandName),
  };
}

function inferFlagDetails(commandName: string, flag: string): CommandFlagSchema {
  const descriptions: Record<string, string> = {
    '--json': 'Emit machine-readable JSON output',
    '--dry-run': 'Plan changes without mutating',
    '--check-only': 'Verify readiness without mutating',
    '--force': 'Override safe blockers intentionally',
    '--yes': 'Confirm non-interactive local changes',
    '--no-assign': 'Do not assign the issue when starting work',
    '--no-comment': 'Do not comment on the issue when starting work',
    '--from': 'Source issue number to pause before switching',
    '--help': 'Show command help',
  };
  const type: CommandFlagType = flag === '--from' ? 'string' : 'boolean';
  if (!(flag in descriptions)) {
    throw new Error(`Failed to infer flag metadata for "${flag}" on "${commandName}". Likely cause: the flag needs explicit schema metadata. Next action: add flagDetails for this command or extend inferFlagDetails().`);
  }
  return { name: flag, type, description: descriptions[flag] ?? `See \`aie ${commandName} --help\` for ${flag}.` };
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
  return IMPLEMENTED_COMMANDS.map(toCommandSchema);
}

export function getCommandMetadata(commandName: string): CommandSchema {
  return toCommandSchema(findCommandMetadata(commandName));
}

export function commandDescription(commandName: string): string {
  return findCommandMetadata(commandName).description;
}

export function commandExamples(commandName: string): string[] {
  return [...findCommandMetadata(commandName).examples];
}

export function isHelpToken(token: string | undefined): boolean {
  return token === 'help' || token === '--help' || token === '-h';
}
