export type MetadataExtensions = Readonly<Record<string, unknown>>;

export type BuiltInMutationCategory =
  | "local-files"
  | "local-config"
  | "external-service"
  | "dependency"
  | "release";

export type MutationCategory = BuiltInMutationCategory | (string & {});

export type BuiltInSupplyChainSensitiveKind =
  | "dependency"
  | "package-manager"
  | "generator"
  | "ci-workflow"
  | "release"
  | "ide-tooling"
  | "mcp-server"
  | "ai-agent-tool";

export type SupplyChainSensitiveKind = BuiltInSupplyChainSensitiveKind | (string & {});

export type OutputFormat = "human" | "json" | (string & {});

export type FlagValueType = "boolean" | "string" | "integer" | "number" | "option";

export type ExitCodeCategory =
  | "success"
  | "usage"
  | "validation"
  | "external"
  | "safety"
  | "unexpected"
  | (string & {});

export interface ExampleMetadata<Extensions extends MetadataExtensions = MetadataExtensions> {
  readonly description: string;
  readonly command: string;
  readonly extensions?: Extensions;
}

export interface ArgumentMetadata<Extensions extends MetadataExtensions = MetadataExtensions> {
  readonly name: string;
  readonly description: string;
  readonly required?: boolean;
  readonly multiple?: boolean;
  readonly defaultValue?: unknown;
  readonly extensions?: Extensions;
}

export interface FlagMetadata<Extensions extends MetadataExtensions = MetadataExtensions> {
  readonly name: string;
  readonly description: string;
  readonly type: FlagValueType;
  readonly aliases?: readonly string[];
  readonly required?: boolean;
  readonly multiple?: boolean;
  readonly defaultValue?: unknown;
  readonly options?: readonly string[];
  readonly extensions?: Extensions;
}

export interface OutputSupport<Extensions extends MetadataExtensions = MetadataExtensions> {
  readonly formats: readonly OutputFormat[];
  readonly defaultFormat?: OutputFormat;
  readonly extensions?: Extensions;
}

export interface DryRunSupported {
  readonly supported: true;
}

export interface DryRunUnsupported {
  readonly supported: false;
  readonly reason: string;
}

export type DryRunSupport = DryRunSupported | DryRunUnsupported;

export interface InteractionSupport<Extensions extends MetadataExtensions = MetadataExtensions> {
  readonly json?: boolean;
  readonly dryRun?: DryRunSupport;
  readonly noColor?: boolean;
  readonly nonInteractive?: boolean;
  readonly ttyPrompt?: boolean;
  readonly extensions?: Extensions;
}

export interface MutationMetadata<Extensions extends MetadataExtensions = MetadataExtensions> {
  readonly categories: readonly MutationCategory[];
  readonly extensions?: Extensions;
}

export interface SupplyChainMetadata<Extensions extends MetadataExtensions = MetadataExtensions> {
  readonly sensitive: boolean;
  readonly reason?: string;
  readonly kinds?: readonly SupplyChainSensitiveKind[];
  readonly extensions?: Extensions;
}

export interface ExternalServiceMetadata<Extensions extends MetadataExtensions = MetadataExtensions> {
  readonly name: string;
  readonly description: string;
  readonly optional?: boolean;
  readonly extensions?: Extensions;
}

export interface ErrorKindMetadata<Extensions extends MetadataExtensions = MetadataExtensions> {
  readonly kind: string;
  readonly description: string;
  readonly exitCode?: number;
  readonly extensions?: Extensions;
}

export interface ExitCodeMetadata<Extensions extends MetadataExtensions = MetadataExtensions> {
  readonly code: number;
  readonly category: ExitCodeCategory;
  readonly description: string;
  readonly extensions?: Extensions;
}

export interface TopicMetadata<Extensions extends MetadataExtensions = MetadataExtensions> {
  readonly kind: "topic";
  readonly name: string;
  readonly description: string;
  readonly aliases?: readonly string[];
  readonly extensions?: Extensions;
}

export interface CommandMetadata<Extensions extends MetadataExtensions = MetadataExtensions> {
  readonly kind: "command";
  readonly name: string;
  readonly description: string;
  readonly aliases?: readonly string[];
  readonly arguments?: readonly ArgumentMetadata[];
  readonly flags?: readonly FlagMetadata[];
  readonly examples?: readonly ExampleMetadata[];
  readonly output?: OutputSupport;
  readonly interactions?: InteractionSupport;
  readonly mutation?: MutationMetadata;
  readonly supplyChain?: SupplyChainMetadata;
  readonly externalServices?: readonly ExternalServiceMetadata[];
  readonly errors?: readonly ErrorKindMetadata[];
  readonly exitCodes?: readonly ExitCodeMetadata[];
  readonly extensions?: Extensions;
}

export type DefinitionMetadata = CommandMetadata | TopicMetadata;
