import type {
  ArgumentMetadata,
  CommandMetadata,
  ErrorKindMetadata,
  ExampleMetadata,
  ExitCodeMetadata,
  ExternalServiceMetadata,
  FlagMetadata,
  MetadataExtensions,
  MutationCategory,
  OutputFormat,
  SupplyChainSensitiveKind,
  TopicMetadata
} from "../metadata/index.js";
import type { CommandRegistry } from "../registry/index.js";

export interface RenderSchemaOptions {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly bin: string;
  readonly extensions?: MetadataExtensions;
}

export interface CliPackageSchema {
  readonly schemaVersion: 1;
  readonly package: {
    readonly name: string;
    readonly version: string;
  };
  readonly bin: string;
  readonly topics: readonly TopicSchema[];
  readonly commands: readonly CommandSchema[];
  readonly extensions?: MetadataExtensions;
}

export interface TopicSchema {
  readonly kind: "topic";
  readonly name: string;
  readonly description: string;
  readonly aliases: readonly string[];
  readonly extensions?: MetadataExtensions;
}

export interface CommandSchema {
  readonly kind: "command";
  readonly name: string;
  readonly description: string;
  readonly aliases: readonly string[];
  readonly arguments: readonly ArgumentSchema[];
  readonly flags: readonly FlagSchema[];
  readonly examples: readonly ExampleSchema[];
  readonly output: OutputSchema;
  readonly interactions: InteractionSchema;
  readonly dryRun: DryRunSchema;
  readonly mutation: MutationSchema;
  readonly supplyChain: SupplyChainSchema;
  readonly externalServices: readonly ExternalServiceSchema[];
  readonly errors: readonly ErrorKindSchema[];
  readonly exitCodes: readonly ExitCodeSchema[];
  readonly extensions?: MetadataExtensions;
}

export interface ArgumentSchema {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  readonly multiple: boolean;
  readonly defaultValue?: unknown;
  readonly extensions?: MetadataExtensions;
}

export interface FlagSchema {
  readonly name: string;
  readonly description: string;
  readonly type: string;
  readonly aliases: readonly string[];
  readonly required: boolean;
  readonly multiple: boolean;
  readonly options: readonly string[];
  readonly defaultValue?: unknown;
  readonly extensions?: MetadataExtensions;
}

export interface ExampleSchema {
  readonly command: string;
  readonly description: string;
  readonly extensions?: MetadataExtensions;
}

export interface OutputSchema {
  readonly formats: readonly string[];
  readonly defaultFormat?: string;
  readonly extensions?: MetadataExtensions;
}

export interface InteractionSchema {
  readonly json: boolean;
  readonly noColor: boolean;
  readonly nonInteractive: boolean;
  readonly ttyPrompt: boolean;
  readonly extensions?: MetadataExtensions;
}

export interface DryRunSchema {
  readonly supported: boolean;
  readonly reason?: string;
}

export interface MutationSchema {
  readonly mutates: boolean;
  readonly categories: readonly string[];
  readonly extensions?: MetadataExtensions;
}

export interface SupplyChainSchema {
  readonly sensitive: boolean;
  readonly kinds: readonly string[];
  readonly reason?: string;
  readonly extensions?: MetadataExtensions;
}

export interface ExternalServiceSchema {
  readonly name: string;
  readonly description: string;
  readonly optional: boolean;
  readonly extensions?: MetadataExtensions;
}

export interface ErrorKindSchema {
  readonly kind: string;
  readonly description: string;
  readonly exitCode?: number;
  readonly extensions?: MetadataExtensions;
}

export interface ExitCodeSchema {
  readonly code: number;
  readonly category: string;
  readonly description: string;
  readonly extensions?: MetadataExtensions;
}

export function renderSchema(registry: CommandRegistry, options: RenderSchemaOptions): CliPackageSchema {
  const schema: CliPackageSchema = {
    schemaVersion: 1,
    package: {
      name: options.packageName,
      version: options.packageVersion
    },
    bin: options.bin,
    topics: [...registry.topics].sort(compareByName).map(renderTopic),
    commands: [...registry.commands].sort(compareByName).map(renderCommand)
  };
  return withExtensions(schema, options.extensions);
}

export function renderSchemaJson(registry: CommandRegistry, options: RenderSchemaOptions): string {
  return `${JSON.stringify(renderSchema(registry, options), null, 2)}\n`;
}

function renderTopic(topic: TopicMetadata): TopicSchema {
  return withExtensions(
    {
      kind: "topic",
      name: topic.name,
      description: topic.description,
      aliases: sortText(topic.aliases ?? [])
    },
    topic.extensions
  );
}

function renderCommand(command: CommandMetadata): CommandSchema {
  return withExtensions(
    {
      kind: "command",
      name: command.name,
      description: command.description,
      aliases: sortText(command.aliases ?? []),
      arguments: (command.arguments ?? []).map(renderArgument),
      flags: [...(command.flags ?? [])].sort(compareByName).map(renderFlag),
      examples: [...(command.examples ?? [])].sort(compareExamples).map(renderExample),
      output: renderOutput(command.output),
      interactions: renderInteractions(command),
      dryRun: renderDryRun(command),
      mutation: renderMutation(command),
      supplyChain: renderSupplyChain(command),
      externalServices: [...(command.externalServices ?? [])].sort(compareByName).map(renderExternalService),
      errors: [...(command.errors ?? [])].sort(compareErrors).map(renderError),
      exitCodes: [...(command.exitCodes ?? [])].sort(compareExitCodes).map(renderExitCode)
    },
    command.extensions
  );
}

function renderArgument(argument: ArgumentMetadata): ArgumentSchema {
  const schema = withExtensions(
    {
      name: argument.name,
      description: argument.description,
      required: argument.required === true,
      multiple: argument.multiple === true
    },
    argument.extensions
  );
  return withDefaultValue(schema, argument);
}

function renderFlag(flag: FlagMetadata): FlagSchema {
  const schema = withExtensions(
    {
      name: flag.name,
      description: flag.description,
      type: flag.type,
      aliases: sortText(flag.aliases ?? []),
      required: flag.required === true,
      multiple: flag.multiple === true,
      options: sortText(flag.options ?? [])
    },
    flag.extensions
  );
  return withDefaultValue(schema, flag);
}

function renderExample(example: ExampleMetadata): ExampleSchema {
  return withExtensions(
    {
      command: example.command,
      description: example.description
    },
    example.extensions
  );
}

function renderOutput(output: CommandMetadata["output"]): OutputSchema {
  const schema = { formats: sortText(output?.formats ?? []) };
  const withDefault = output?.defaultFormat ? { ...schema, defaultFormat: String(output.defaultFormat) } : schema;
  return withExtensions(withDefault, output?.extensions);
}

function renderInteractions(command: CommandMetadata): InteractionSchema {
  return withExtensions(
    {
      json: command.interactions?.json === true,
      noColor: command.interactions?.noColor === true,
      nonInteractive: command.interactions?.nonInteractive === true,
      ttyPrompt: command.interactions?.ttyPrompt === true
    },
    command.interactions?.extensions
  );
}

function renderDryRun(command: CommandMetadata): DryRunSchema {
  const dryRun = command.interactions?.dryRun;
  if (!dryRun) {
    return { supported: false };
  }
  if (dryRun.supported) {
    return { supported: true };
  }
  return { supported: false, reason: dryRun.reason };
}

function renderMutation(command: CommandMetadata): MutationSchema {
  const categories = sortText(command.mutation?.categories ?? []);
  return withExtensions(
    {
      mutates: categories.length > 0,
      categories
    },
    command.mutation?.extensions
  );
}

function renderSupplyChain(command: CommandMetadata): SupplyChainSchema {
  const schema = {
    sensitive: command.supplyChain?.sensitive === true,
    kinds: sortText(command.supplyChain?.kinds ?? [])
  };
  const withReason = command.supplyChain?.reason ? { ...schema, reason: command.supplyChain.reason } : schema;
  return withExtensions(withReason, command.supplyChain?.extensions);
}

function renderExternalService(service: ExternalServiceMetadata): ExternalServiceSchema {
  return withExtensions(
    {
      name: service.name,
      description: service.description,
      optional: service.optional === true
    },
    service.extensions
  );
}

function renderError(error: ErrorKindMetadata): ErrorKindSchema {
  const schema = { kind: error.kind, description: error.description };
  const withExitCode = typeof error.exitCode === "number" ? { ...schema, exitCode: error.exitCode } : schema;
  return withExtensions(withExitCode, error.extensions);
}

function renderExitCode(exitCode: ExitCodeMetadata): ExitCodeSchema {
  return withExtensions(
    {
      code: exitCode.code,
      category: exitCode.category,
      description: exitCode.description
    },
    exitCode.extensions
  );
}

function withDefaultValue<Item extends object, Metadata extends { readonly defaultValue?: unknown }>(schema: Item, metadata: Metadata): Item & { readonly defaultValue?: unknown } {
  if (!Object.hasOwn(metadata, "defaultValue") || metadata.defaultValue === undefined) {
    return schema;
  }
  return { ...schema, defaultValue: stableJsonValue(metadata.defaultValue) };
}

function withExtensions<Item extends object>(schema: Item, extensions: MetadataExtensions | undefined): Item & { readonly extensions?: MetadataExtensions } {
  const renderedExtensions = renderExtensions(extensions);
  if (!renderedExtensions) {
    return schema;
  }
  return { ...schema, extensions: renderedExtensions };
}

function renderExtensions(extensions: MetadataExtensions | undefined): MetadataExtensions | undefined {
  if (!extensions) {
    return undefined;
  }
  const rendered = stableJsonObject(extensions);
  return Object.keys(rendered).length === 0 ? undefined : rendered;
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  if (isRecord(value)) {
    return stableJsonObject(value);
  }
  return value;
}

function stableJsonObject(value: Readonly<Record<string, unknown>>): MetadataExtensions {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(compareText)) {
    const renderedValue = stableJsonValue(value[key]);
    if (renderedValue !== undefined) {
      result[key] = renderedValue;
    }
  }
  return Object.freeze(result);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortText(values: readonly (string | OutputFormat | MutationCategory | SupplyChainSensitiveKind)[]): readonly string[] {
  return values.map(String).sort(compareText);
}

function compareByName(left: { readonly name: string }, right: { readonly name: string }): number {
  return compareText(left.name, right.name);
}

function compareExamples(left: ExampleMetadata, right: ExampleMetadata): number {
  return compareText(left.command, right.command) || compareText(left.description, right.description);
}

function compareErrors(left: ErrorKindMetadata, right: ErrorKindMetadata): number {
  return compareText(left.kind, right.kind) || compareText(left.description, right.description);
}

function compareExitCodes(left: ExitCodeMetadata, right: ExitCodeMetadata): number {
  return left.code - right.code || compareText(left.category, right.category) || compareText(left.description, right.description);
}

function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
