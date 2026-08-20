import { defineCommand, defineFlag, type CommandMetadata, type FlagMetadata, type MetadataExtensions } from '@tjalve/qube-cli/metadata';
import type { CommandFlagSchema, CommandMutationTarget } from './command_metadata.js';

export interface ExecutorCommandExtensions extends MetadataExtensions {
  readonly helpForms?: readonly string[];
  readonly supportsCheckOnly?: boolean;
  readonly stageValues?: readonly string[];
  readonly reviewAgentValues?: readonly string[];
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
  examples: string[];
}

const FLAG_SHORT_NAMES: Readonly<Record<string, string>> = {
  json: 'j',
  'dry-run': 'd',
};

const NEGATED_FLAGS: ReadonlySet<string> = new Set(['--no-assign', '--no-comment']);

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

function toFlagMetadata(command: ExecutorCommandDefinition, flag: string): FlagMetadata {
  const details = findFlagDetails(command, flag);
  const negatable = hasPositiveAndNegativeFlags(command.flags, flag) || NEGATED_FLAGS.has(flag);
  const name = negatable ? toNegatableFlagName(flag) : stripLongFlagPrefix(flag);
  const type = details?.type ?? inferFlagType(flag);
  const base = {
    name,
    description: details?.description ?? `See \`aie ${command.name} --help\` for ${flag}.`,
    type: type === 'string' && details?.options ? 'option' : type,
    ...(FLAG_SHORT_NAMES[name] ? { short: FLAG_SHORT_NAMES[name] } : {}),
    ...(negatable ? { negatable: true } : {}),
    ...(details?.multiple === true ? { multiple: true } : {}),
    ...(details?.options ? { options: [...details.options] } : {}),
    ...(details && Object.hasOwn(details, 'default') ? { defaultValue: details.default } : {}),
  } satisfies FlagMetadata;
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
    'pr lane rerun': {
      pr: 'Pull request number whose lane should be rerun, for example 12 or #12',
      lane: 'Review lane id to re-execute once, for example issue-compliance',
    },
    'pr batch': { pr: 'Pull request number for the cross-lane fix batch, for example 12 or #12' },
    'pr triage': { pr: 'Pull request number for advisory triage, for example 12 or #12' },
    'pr review publish': { pr: 'Pull request number for the lane review publish target, for example 12 or #12' },
    'pr review publish-summary': { pr: 'Pull request number for the round summary publish target, for example 12 or #12' },
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
    'pr lane rerun',
    'pr batch',
    'pr triage',
    'pr review publish',
    'pr review publish-summary',
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
      ttyPrompt: command.name === 'review setup github-app',
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
    exitCodes: (command.exitCodes ?? [0, 1]).map(exitCodeMetadata),
    extensions: {
      helpForms: [
        `aie ${command.name} --help`,
        `aie help ${command.name}`,
        `aie ${[...command.name.split(' '), 'help'].join(' ')}`,
      ],
      ...(command.supportsCheckOnly === true ? { supportsCheckOnly: true } : {}),
      ...(command.stageValues ? { stageValues: [...command.stageValues] } : {}),
      ...(command.reviewAgentValues ? { reviewAgentValues: [...command.reviewAgentValues] } : {}),
    },
  });
}

function exitCodeMetadata(code: number) {
  if (code === 0) return { code, category: 'success' as const, description: 'Command completed successfully.' };
  if (code === 2) return { code, category: 'usage' as const, description: 'Command usage or argument parsing failed.' };
  if (code === 3) return { code, category: 'validation' as const, description: 'Command input or configured capability validation failed.' };
  if (code === 4) return { code, category: 'external' as const, description: 'An external provider read failed.' };
  if (code === 5) return { code, category: 'safety' as const, description: 'A safety policy blocked the command.' };
  return { code, category: 'unexpected' as const, description: 'Command failed unexpectedly.' };
}

export function defineExecutorCommands(commands: readonly ExecutorCommandDefinition[], commonErrorKinds: readonly string[]): readonly CommandMetadata<ExecutorCommandExtensions>[] {
  return commands.map(command => toCommandMetadata(command, commonErrorKinds));
}
