import type {
  ArgumentMetadata,
  CommandMetadata,
  DefinitionMetadata,
  ExampleMetadata,
  FlagMetadata,
  MetadataExtensions,
  TopicMetadata
} from "./types.js";

const validNamePattern = /^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*$/;
const validFlagNamePattern = /^[a-z][a-z0-9-]*$/;
const validAliasPattern = /^[a-zA-Z][a-zA-Z0-9-]*$/;

export function defineExample<const Example extends ExampleMetadata>(example: Example): Readonly<Example> {
  requireDescription(example.description, "example.description");
  requireNonEmpty(example.command, "example.command");
  return Object.freeze(example);
}

export function defineArgument<const Argument extends ArgumentMetadata>(argument: Argument): Readonly<Argument> {
  requireIdentifier(argument.name, "argument.name");
  requireDescription(argument.description, "argument.description");
  return Object.freeze(argument);
}

export function defineFlag<const Flag extends FlagMetadata>(flag: Flag): Readonly<Flag> {
  requireFlagName(flag.name, "flag.name");
  requireDescription(flag.description, "flag.description");
  for (const alias of flag.aliases ?? []) {
    requireAlias(alias, `flag.aliases[${alias}]`);
  }
  if (flag.type === "option" && (!flag.options || flag.options.length === 0)) {
    throw new TypeError(`flag.options must include at least one value when flag.type is "option".`);
  }
  return Object.freeze(flag);
}

export function defineTopic<const Topic extends TopicMetadata>(topic: Topic): Readonly<Topic> {
  if (topic.kind !== "topic") {
    throw new TypeError(`topic.kind must be "topic".`);
  }
  requireCommandName(topic.name, "topic.name");
  requireDescription(topic.description, "topic.description");
  for (const alias of topic.aliases ?? []) {
    requireAlias(alias, `topic.aliases[${alias}]`);
  }
  return Object.freeze(topic);
}

export function defineCommand<const Command extends CommandMetadata>(command: Command): Readonly<Command> {
  if (command.kind !== "command") {
    throw new TypeError(`command.kind must be "command".`);
  }
  requireCommandName(command.name, "command.name");
  requireDescription(command.description, "command.description");
  for (const alias of command.aliases ?? []) {
    requireAlias(alias, `command.aliases[${alias}]`);
  }
  validateMutatingCommand(command);
  return Object.freeze(command);
}

export function defineMetadata(metadata: CommandMetadata): Readonly<CommandMetadata>;
export function defineMetadata(metadata: TopicMetadata): Readonly<TopicMetadata>;
export function defineMetadata(metadata: DefinitionMetadata): Readonly<DefinitionMetadata>;
export function defineMetadata(metadata: DefinitionMetadata): Readonly<DefinitionMetadata> {
  return metadata.kind === "command" ? defineCommand(metadata) : defineTopic(metadata);
}

export function defineExtensions<const Extensions extends MetadataExtensions>(extensions: Extensions): Readonly<Extensions> {
  return Object.freeze(extensions);
}

function validateMutatingCommand(command: CommandMetadata): void {
  const categories = command.mutation?.categories ?? [];
  if (categories.length === 0) {
    return;
  }
  if (!command.interactions?.dryRun) {
    throw new TypeError(`command.interactions.dryRun is required when command.mutation.categories is not empty.`);
  }
  if (!command.interactions.dryRun.supported) {
    requireDescription(command.interactions.dryRun.reason, "command.interactions.dryRun.reason");
  }
}

function requireCommandName(value: string, field: string): void {
  requireNonEmpty(value, field);
  if (!validNamePattern.test(value)) {
    throw new TypeError(`${field} must use lowercase words separated by single spaces or hyphens.`);
  }
}

function requireFlagName(value: string, field: string): void {
  requireNonEmpty(value, field);
  if (!validFlagNamePattern.test(value)) {
    throw new TypeError(`${field} must use a lowercase flag name without leading dashes.`);
  }
}

function requireIdentifier(value: string, field: string): void {
  requireNonEmpty(value, field);
  if (!validFlagNamePattern.test(value)) {
    throw new TypeError(`${field} must use a lowercase identifier with optional hyphens.`);
  }
}

function requireAlias(value: string, field: string): void {
  requireNonEmpty(value, field);
  if (!validAliasPattern.test(value)) {
    throw new TypeError(`${field} must use an alias without leading dashes or spaces.`);
  }
}

function requireDescription(value: string, field: string): void {
  requireNonEmpty(value, field);
  if (value.trim().length < 3) {
    throw new TypeError(`${field} must be descriptive.`);
  }
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${field} must not be empty.`);
  }
}
