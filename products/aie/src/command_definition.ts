import { defineCommand, defineFlag, type CommandMetadata, type FlagMetadata, type MetadataExtensions } from '@tjalve/qube-cli/metadata';
import type { CommandFlagSchema, CommandMutationTarget } from './command_metadata.js';

export interface ExecutorCommandExtensions extends MetadataExtensions {
  readonly helpForms?: readonly string[];
  readonly supportsCheckOnly?: boolean;
  readonly stageValues?: readonly string[];
  readonly reviewAgentValues?: readonly string[];
  readonly migrationModeValues?: readonly string[];
  readonly migrationActionValues?: readonly string[];
  readonly migrationConfidenceValues?: readonly string[];
}

interface ExecutorFlagExtensions extends MetadataExtensions {
  readonly legacyForms?: readonly string[];
}

export interface ExecutorCommandDefinition {
  name: string;
  description: string;
  args: string[];
  flags: string[];
  flagDetails?: CommandFlagSchema[];
  mutationTargets: CommandMutationTarget[];
  supportsJson: boolean;
  supportsDryRun: boolean;
  supportsCheckOnly?: boolean;
  externalServices?: string[];
  stableErrorKinds?: string[];
  exitCodes?: number[];
  stageValues?: string[];
  reviewAgentValues?: string[];
  migrationModeValues?: string[];
  migrationActionValues?: string[];
  migrationConfidenceValues?: string[];
  examples: string[];
}

const FLAG_SHORT_NAMES: Readonly<Record<string, string>> = {
  json: 'j',
  'dry-run': 'd',
};

const LEGACY_NEGATED_ONLY_FLAGS: ReadonlySet<string> = new Set(['--no-assign', '--no-comment']);

function stripLongFlagPrefix(flag: string): string {
  return flag.startsWith('--') ? flag.slice(2) : flag;
}

function toNegatableFlagName(flag: string): string {
  const name = stripLongFlagPrefix(flag);
  return name.startsWith('no-') ? name.slice(3) : name;
}

function hasPositiveAndNegativeFlags(flags: readonly string[], flag: string): boolean {
  const name = stripLongFlagPrefix(flag);
  if (name.startsWith('no-')) {
    return flags.includes(`--${name.slice(3)}`);
  }
  return flags.includes(`--no-${name}`);
}

function isNegativeFlag(flag: string): boolean {
  return stripLongFlagPrefix(flag).startsWith('no-');
}

function findFlagDetails(command: ExecutorCommandDefinition, flag: string): CommandFlagSchema | undefined {
  const name = stripLongFlagPrefix(flag);
  const negatableName = toNegatableFlagName(flag);
  return command.flagDetails?.find(detail => stripLongFlagPrefix(detail.name) === name || stripLongFlagPrefix(detail.name) === negatableName);
}

function inferFlagType(flag: string): CommandFlagSchema['type'] {
  return flag === '--from' || flag === '--stage' ? 'string' : 'boolean';
}

function toFlagMetadata(command: ExecutorCommandDefinition, flag: string): FlagMetadata<ExecutorFlagExtensions> {
  const details = findFlagDetails(command, flag);
  const legacyNegatedOnly = LEGACY_NEGATED_ONLY_FLAGS.has(flag);
  const name = hasPositiveAndNegativeFlags(command.flags, flag) || legacyNegatedOnly ? toNegatableFlagName(flag) : stripLongFlagPrefix(flag);
  const type = details?.type ?? inferFlagType(flag);
  const base = {
    name,
    description: details?.description ?? `See \`aie ${command.name} --help\` for ${flag}.`,
    type: type === 'string' && details?.options ? 'option' : type,
    ...(FLAG_SHORT_NAMES[name] ? { short: FLAG_SHORT_NAMES[name] } : {}),
    ...(hasPositiveAndNegativeFlags(command.flags, flag) || legacyNegatedOnly ? { negatable: true } : {}),
    ...(legacyNegatedOnly ? { extensions: { legacyForms: [stripLongFlagPrefix(flag)] } } : {}),
    ...(details?.multiple === true ? { multiple: true } : {}),
    ...(details?.options ? { options: [...details.options] } : {}),
    ...(details && Object.hasOwn(details, 'default') ? { defaultValue: details.default } : {}),
  } satisfies FlagMetadata<ExecutorFlagExtensions>;
  return defineFlag(base);
}

function toArgumentMetadata(commandName: string, argument: string) {
  const descriptions: Record<string, Record<string, string>> = {
    init: { target: 'Repository path to initialize, usually .' },
    start: { issue: 'Issue selector: next, a bare number such as 93, or shell-safe #93' },
    switch: { issue: 'Target issue number, for example 93 or #93' },
    complete: { issue: 'Issue number to complete, for example 93 or #93' },
    'checklist update': { issue: 'Issue number whose checklist should be updated, for example 93 or #93' },
    'checklist verify': { issue: 'Issue number whose checklist criterion should be verified, for example 93 or #93' },
    'audit ui': { issue: 'Issue number for the manual UI audit plan, for example 93 or #93' },
    'review gate': { issue: 'Issue number for the review gate, for example 93 or #93' },
    'pr view': { pr: 'Pull request number for concise PR state, for example 12 or #12' },
    'pr body': { issue: 'Issue number the pull request closes, for example 93 or #93' },
    'pr gate': { pr: 'Pull request number for the PR review gate, for example 12 or #12' },
    'run start': {
      command: 'App command executable after --, for example npm in `aie run start -- npm run dev`',
      ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`commandArg${index + 1}`, 'Optional app command argument captured after --'])),
    },
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
    'checklist update',
    'checklist verify',
    'deps blockers',
    'deps blocking',
    'deps chain',
    'run start',
    'view',
  ]);
  const defaultDescriptions: Record<string, string> = {
    issue: 'Issue number, for example 93 or #93',
    pr: 'Pull request number, for example 12 or #12',
    target: 'Target path or selector for the command',
  };
  const required = commandName === 'run start' ? argument === 'command' : requiredArgCommands.has(commandName);
  return {
    name: argument,
    description: descriptions[commandName]?.[argument] ?? defaultDescriptions[argument] ?? `Argument ${argument} for aie ${commandName}`,
    required,
  };
}

function toCommandMetadata(command: ExecutorCommandDefinition, commonErrorKinds: readonly string[]): CommandMetadata<ExecutorCommandExtensions> {
  const flags = command.flags.filter(flag => !isNegativeFlag(flag) || !hasPositiveAndNegativeFlags(command.flags, flag)).map(flag => toFlagMetadata(command, flag));
  return defineCommand({
    kind: 'command',
    name: command.name,
    description: command.description,
    arguments: command.args.map(argument => toArgumentMetadata(command.name, argument)),
    flags,
    examples: command.examples.map(example => ({ description: example, command: example })),
    output: {
      formats: command.supportsJson ? ['human', 'json'] : ['human'],
      defaultFormat: 'human',
    },
    interactions: {
      json: command.supportsJson,
      dryRun: command.supportsDryRun ? { supported: true } : { supported: false, reason: 'Command does not support dry-run mode.' },
      noColor: false,
      nonInteractive: true,
      ttyPrompt: false,
    },
    mutation: command.mutationTargets.length > 0 ? { categories: command.mutationTargets } : undefined,
    externalServices: (command.externalServices ?? []).map(service => ({
      name: service,
      description: `Uses ${service}.`,
      optional: true,
    })),
    errors: (command.stableErrorKinds ?? commonErrorKinds).map(kind => ({
      kind,
      description: `Stable ${kind} error.`,
    })),
    exitCodes: (command.exitCodes ?? [0, 1]).map(code => ({
      code,
      category: code === 0 ? 'success' : 'unexpected',
      description: code === 0 ? 'Command completed successfully.' : 'Command failed.',
    })),
    extensions: {
      helpForms: [
        `aie ${command.name} --help`,
        `aie help ${command.name}`,
        `aie ${[...command.name.split(' '), 'help'].join(' ')}`,
      ],
      ...(command.supportsCheckOnly === true ? { supportsCheckOnly: true } : {}),
      ...(command.stageValues ? { stageValues: [...command.stageValues] } : {}),
      ...(command.reviewAgentValues ? { reviewAgentValues: [...command.reviewAgentValues] } : {}),
      ...(command.migrationModeValues ? { migrationModeValues: [...command.migrationModeValues] } : {}),
      ...(command.migrationActionValues ? { migrationActionValues: [...command.migrationActionValues] } : {}),
      ...(command.migrationConfidenceValues ? { migrationConfidenceValues: [...command.migrationConfidenceValues] } : {}),
    },
  });
}

export function defineExecutorCommands(commands: readonly ExecutorCommandDefinition[], commonErrorKinds: readonly string[]): readonly CommandMetadata<ExecutorCommandExtensions>[] {
  return commands.map(command => toCommandMetadata(command, commonErrorKinds));
}
