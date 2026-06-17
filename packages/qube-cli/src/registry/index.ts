import type {
  CommandMetadata,
  DefinitionMetadata,
  FlagValueType,
  TopicMetadata
} from "../metadata/index.js";

const canonicalFlagNamePattern = /^[a-z][a-z0-9-]*$/;
const shortFlagPattern = /^[a-zA-Z]$/;

export interface CommandRegistry {
  readonly topics: readonly TopicMetadata[];
  readonly commands: readonly CommandMetadata[];
}

export interface CommandRegistryDefinitionGroups {
  readonly topics?: readonly TopicMetadata[];
  readonly commands?: readonly CommandMetadata[];
}

export type CommandRegistryInput = readonly DefinitionMetadata[] | CommandRegistryDefinitionGroups;

export interface CommandRegistryValidationIssue {
  readonly path: string;
  readonly message: string;
}

export class CommandRegistryValidationError extends TypeError {
  readonly issues: readonly CommandRegistryValidationIssue[];

  constructor(issues: readonly CommandRegistryValidationIssue[]) {
    super(formatValidationMessage(issues));
    this.name = "CommandRegistryValidationError";
    this.issues = Object.freeze([...issues]);
  }
}

export function createCommandRegistry(input: CommandRegistryInput): Readonly<CommandRegistry> {
  const registry = normalizeRegistryInput(input);
  validateCommandRegistry(registry);
  return registry;
}

export function validateCommandRegistry(registry: CommandRegistry): void {
  const issues: CommandRegistryValidationIssue[] = [];

  validateDefinitions(registry.topics, "topics", issues);
  validateDefinitions(registry.commands, "commands", issues);
  validateDefinitionNames(registry, issues);
  validateAliases(registry, issues);

  registry.commands.forEach((command, commandIndex) => {
    validateCommand(command, `commands[${commandIndex}]`, issues);
  });

  if (issues.length > 0) {
    throw new CommandRegistryValidationError(issues);
  }
}

export function findCommand(registry: CommandRegistry, nameOrAlias: string): CommandMetadata | undefined {
  return registry.commands.find(
    (command) => command.name === nameOrAlias || (command.aliases ?? []).includes(nameOrAlias)
  );
}

export function findTopic(registry: CommandRegistry, nameOrAlias: string): TopicMetadata | undefined {
  return registry.topics.find((topic) => topic.name === nameOrAlias || (topic.aliases ?? []).includes(nameOrAlias));
}

export function listCommands(registry: CommandRegistry): readonly CommandMetadata[] {
  return registry.commands;
}

export function listTopics(registry: CommandRegistry): readonly TopicMetadata[] {
  return registry.topics;
}

function normalizeRegistryInput(input: CommandRegistryInput): Readonly<CommandRegistry> {
  const topics: TopicMetadata[] = [];
  const commands: CommandMetadata[] = [];

  if (isDefinitionArray(input)) {
    for (const definition of input) {
      appendDefinition(definition, topics, commands);
    }
  } else {
    topics.push(...(input.topics ?? []));
    commands.push(...(input.commands ?? []));
  }

  topics.sort(compareByName);
  commands.sort(compareByName);

  return Object.freeze({
    topics: Object.freeze(topics),
    commands: Object.freeze(commands)
  });
}

function isDefinitionArray(input: CommandRegistryInput): input is readonly DefinitionMetadata[] {
  return Array.isArray(input);
}

function appendDefinition(definition: DefinitionMetadata, topics: TopicMetadata[], commands: CommandMetadata[]): void {
  if (definition.kind === "topic") {
    topics.push(definition);
    return;
  }
  commands.push(definition);
}

function compareByName(left: { readonly name: string }, right: { readonly name: string }): number {
  if (left.name === right.name) {
    return 0;
  }
  return left.name < right.name ? -1 : 1;
}

function validateDefinitions(
  definitions: readonly DefinitionMetadata[],
  collectionName: "topics" | "commands",
  issues: CommandRegistryValidationIssue[]
): void {
  definitions.forEach((definition, index) => {
    const path = `${collectionName}[${index}]`;
    requireDescription(definition.description, `${path}.description`, issues);
    if (definition.kind !== (collectionName === "topics" ? "topic" : "command")) {
      addIssue(issues, `${path}.kind`, `Expected ${collectionName === "topics" ? "topic" : "command"} metadata.`);
    }
  });
}

function validateDefinitionNames(registry: CommandRegistry, issues: CommandRegistryValidationIssue[]): void {
  const seenTopicNames = new Map<string, string>();
  const seenCommandNames = new Map<string, string>();
  const seenDefinitionNames = new Map<string, string>();

  registry.topics.forEach((topic, index) => {
    const path = `topics[${index}].name`;
    trackUnique(topic.name, path, "topic name", seenTopicNames, issues);
    trackUnique(topic.name, path, "definition name", seenDefinitionNames, issues);
  });

  registry.commands.forEach((command, index) => {
    const path = `commands[${index}].name`;
    trackUnique(command.name, path, "command name", seenCommandNames, issues);
    trackUnique(command.name, path, "definition name", seenDefinitionNames, issues);
  });
}

function validateAliases(registry: CommandRegistry, issues: CommandRegistryValidationIssue[]): void {
  const names = new Map<string, string>();
  const aliases = new Map<string, string>();

  registry.topics.forEach((topic, index) => {
    names.set(topic.name, `topics[${index}].name`);
  });
  registry.commands.forEach((command, index) => {
    names.set(command.name, `commands[${index}].name`);
  });

  registry.topics.forEach((topic, index) => {
    validateAliasList(topic.aliases ?? [], `topics[${index}].aliases`, names, aliases, issues);
  });
  registry.commands.forEach((command, index) => {
    validateAliasList(command.aliases ?? [], `commands[${index}].aliases`, names, aliases, issues);
  });
}

function validateAliasList(
  aliasesToValidate: readonly string[],
  path: string,
  names: ReadonlyMap<string, string>,
  aliases: Map<string, string>,
  issues: CommandRegistryValidationIssue[]
): void {
  aliasesToValidate.forEach((alias, index) => {
    const aliasPath = `${path}[${index}]`;
    const namePath = names.get(alias);
    if (namePath) {
      addIssue(issues, aliasPath, `Alias "${alias}" conflicts with ${namePath}.`);
    }
    trackUnique(alias, aliasPath, "alias", aliases, issues);
  });
}

function validateCommand(command: CommandMetadata, path: string, issues: CommandRegistryValidationIssue[]): void {
  validateArguments(command.arguments ?? [], `${path}.arguments`, issues);
  validateFlags(command.flags ?? [], `${path}.flags`, issues);
  validateExamples(command.examples ?? [], `${path}.examples`, issues);
  validateDescribedItems(command.externalServices ?? [], `${path}.externalServices`, "service name", issues);
  validateDescribedItems(command.errors ?? [], `${path}.errors`, "error kind", issues);
  validateDescribedItems(command.exitCodes ?? [], `${path}.exitCodes`, "exit code", issues);
  validateOutput(command, path, issues);
  validateMutation(command, path, issues);
  validateSupplyChain(command, path, issues);
}

function validateArguments(
  args: readonly { readonly name: string; readonly description: string }[],
  path: string,
  issues: CommandRegistryValidationIssue[]
): void {
  const names = new Map<string, string>();
  args.forEach((argument, index) => {
    const argumentPath = `${path}[${index}]`;
    trackUnique(argument.name, `${argumentPath}.name`, "argument name", names, issues);
    requireDescription(argument.description, `${argumentPath}.description`, issues);
  });
}

function validateFlags(
  flags: readonly {
    readonly name: string;
    readonly description: string;
    readonly type: FlagValueType;
    readonly short?: string;
    readonly aliases?: readonly string[];
    readonly negatable?: boolean;
    readonly options?: readonly string[];
  }[],
  path: string,
  issues: CommandRegistryValidationIssue[]
): void {
  const names = new Map<string, string>();
  const shorts = new Map<string, string>();
  const aliases = new Map<string, string>();

  flags.forEach((flag, index) => {
    const flagPath = `${path}[${index}]`;
    trackUnique(flag.name, `${flagPath}.name`, "flag name", names, issues);
  });

  flags.forEach((flag, index) => {
    const flagPath = `${path}[${index}]`;
    requireDescription(flag.description, `${flagPath}.description`, issues);
    validateCanonicalFlagName(flag.name, `${flagPath}.name`, issues);
    validateShortFlag(flag.short, `${flagPath}.short`, issues);
    if (typeof flag.short === "string" && flag.short.trim().length > 0) {
      trackUnique(flag.short, `${flagPath}.short`, "short flag alias", shorts, issues);
    }
    if (!isSupportedFlagType(flag.type)) {
      addIssue(issues, `${flagPath}.type`, `Unsupported flag type "${String(flag.type)}".`);
    }
    if (flag.negatable === true && flag.type !== "boolean") {
      addIssue(issues, `${flagPath}.negatable`, `Negatable flags must use boolean type.`);
    }
    if (flag.type === "option" && (flag.options ?? []).length === 0) {
      addIssue(issues, `${flagPath}.options`, `Option flags must define at least one option.`);
    }
    validateAliasList(flag.aliases ?? [], `${flagPath}.aliases`, names, aliases, issues);
  });
}

function validateExamples(
  examples: readonly { readonly description: string; readonly command: string }[],
  path: string,
  issues: CommandRegistryValidationIssue[]
): void {
  if (examples.length === 0) {
    addIssue(issues, path, `Command metadata must include at least one example.`);
    return;
  }
  examples.forEach((example, index) => {
    const examplePath = `${path}[${index}]`;
    requireDescription(example.description, `${examplePath}.description`, issues);
    requireNonEmpty(example.command, `${examplePath}.command`, issues);
  });
}

function validateDescribedItems(
  items: readonly { readonly name?: string; readonly kind?: string; readonly code?: number; readonly description: string }[],
  path: string,
  label: string,
  issues: CommandRegistryValidationIssue[]
): void {
  const names = new Map<string, string>();
  items.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    const identifier = typeof item.code === "number" ? String(item.code) : item.name ?? item.kind;
    if (identifier) {
      trackUnique(identifier, `${itemPath}.${label === "exit code" ? "code" : label === "error kind" ? "kind" : "name"}`, label, names, issues);
    }
    requireDescription(item.description, `${itemPath}.description`, issues);
  });
}

function validateOutput(command: CommandMetadata, path: string, issues: CommandRegistryValidationIssue[]): void {
  if (!command.output?.defaultFormat) {
    return;
  }
  if (!command.output.formats.includes(command.output.defaultFormat)) {
    addIssue(issues, `${path}.output.defaultFormat`, `Default output format must be listed in output.formats.`);
  }
}

function validateMutation(command: CommandMetadata, path: string, issues: CommandRegistryValidationIssue[]): void {
  const categories = command.mutation?.categories ?? [];
  if (command.mutation && categories.length === 0) {
    addIssue(issues, `${path}.mutation.categories`, `Mutation metadata must include at least one category.`);
  }
  if (categories.length === 0) {
    return;
  }
  if (!command.interactions?.dryRun) {
    addIssue(issues, `${path}.interactions.dryRun`, `Mutating commands must declare dry-run support or a documented exception.`);
    return;
  }
  if (!command.interactions.dryRun.supported) {
    requireDescription(command.interactions.dryRun.reason, `${path}.interactions.dryRun.reason`, issues);
  }
}

function validateSupplyChain(command: CommandMetadata, path: string, issues: CommandRegistryValidationIssue[]): void {
  if (command.supplyChain?.sensitive !== true) {
    return;
  }
  requireDescription(command.supplyChain.reason ?? "", `${path}.supplyChain.reason`, issues);
  if (!command.supplyChain.kinds || command.supplyChain.kinds.length === 0) {
    addIssue(issues, `${path}.supplyChain.kinds`, `Supply-chain-sensitive commands must list at least one sensitive kind.`);
  }
}

function isSupportedFlagType(value: unknown): value is FlagValueType {
  return value === "boolean" || value === "string" || value === "integer" || value === "number" || value === "option";
}

function validateCanonicalFlagName(value: string, path: string, issues: CommandRegistryValidationIssue[]): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    return;
  }
  if (!canonicalFlagNamePattern.test(value)) {
    addIssue(issues, path, `Flag names are canonical keys and must not include leading dashes.`);
  }
}

function validateShortFlag(value: string | undefined, path: string, issues: CommandRegistryValidationIssue[]): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    addIssue(issues, path, `Short flag aliases must not be empty.`);
    return;
  }
  if (!shortFlagPattern.test(value)) {
    addIssue(issues, path, `Short flag aliases must be exactly one letter without leading dashes.`);
  }
}

function trackUnique(
  value: string,
  path: string,
  label: string,
  seen: Map<string, string>,
  issues: CommandRegistryValidationIssue[]
): void {
  if (typeof value !== "string") {
    addIssue(issues, path, `${label} must be a string.`);
    return;
  }
  const normalizedValue = value.trim();
  if (normalizedValue.length === 0) {
    addIssue(issues, path, `Empty ${label} is not allowed.`);
    return;
  }
  const previousPath = seen.get(normalizedValue);
  if (previousPath) {
    addIssue(issues, path, `Duplicate ${label} "${normalizedValue}"; first defined at ${previousPath}.`);
    return;
  }
  seen.set(normalizedValue, path);
}

function requireDescription(value: string, path: string, issues: CommandRegistryValidationIssue[]): void {
  requireNonEmpty(value, path, issues);
  if (typeof value === "string" && value.trim().length > 0 && value.trim().length < 3) {
    addIssue(issues, path, `Description must be descriptive.`);
  }
}

function requireNonEmpty(value: string, path: string, issues: CommandRegistryValidationIssue[]): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    addIssue(issues, path, `Value must not be empty.`);
  }
}

function addIssue(issues: CommandRegistryValidationIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

function formatValidationMessage(issues: readonly CommandRegistryValidationIssue[]): string {
  const details = issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
  return `Command registry validation failed: ${details}`;
}
