import type { CommandMetadata, TopicMetadata } from '@tjalve/qube-cli/metadata';
import { createCommandRegistry, type CommandRegistry } from '@tjalve/qube-cli/registry';
import { IMPLEMENTED_COMMANDS } from './command_catalog.js';
import type { ExecutorCommandExtensions } from './command_definition.js';

export const EXECUTOR_COMMANDS: readonly CommandMetadata<ExecutorCommandExtensions>[] = IMPLEMENTED_COMMANDS;
export const EXECUTOR_TOPICS: readonly TopicMetadata[] = [];
export const EXECUTOR_COMMAND_REGISTRY: CommandRegistry = createCommandRegistry({
  topics: EXECUTOR_TOPICS,
  commands: EXECUTOR_COMMANDS,
});
