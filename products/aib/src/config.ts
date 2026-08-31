import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  AGENT_HOST_IDS,
  resolveLayeredFields,
  type AgentHostId,
  type LayeredConfigField,
  type LayeredConfigSource,
} from "@tjalve/qube-core";

export type AibAgentHost = AgentHostId;
export type AibPrivacyMode = "local-first" | "network-allowed" | "restricted";
export type AibProviderKind = "github" | "gitlab" | "linear" | "jira" | "local" | "none";

export interface AibConfig {
  readonly version: 1;
  readonly project?: {
    readonly name?: string;
    readonly privacy?: AibPrivacyMode;
  };
  readonly providers?: {
    readonly work?: AibProviderKind;
    readonly review?: AibProviderKind;
  };
  readonly agent?: {
    readonly host?: AibAgentHost;
    readonly questionBudget?: number;
    readonly surfaces?: readonly AibAgentHost[];
  };
  readonly discovery?: {
    readonly referencePaths?: readonly string[];
    readonly inspectCurrentRepo?: boolean;
    readonly inspectDocs?: boolean;
    readonly inspectSiblingRepos?: boolean;
  };
  readonly paths?: {
    readonly stateDir?: string;
    readonly docsDir?: string;
    readonly specPath?: string;
    readonly milestonesDir?: string;
    readonly issuesDir?: string;
  };
  readonly safety?: {
    readonly dryRunRequired?: boolean;
    readonly allowNetwork?: boolean;
    readonly packageAgeDays?: number;
  };
}

export interface LoadedAibConfig {
  readonly path?: string;
  readonly config: AibConfig;
  readonly fieldSources: Readonly<Record<string, LayeredConfigSource>>;
  readonly layers: {
    readonly explicit: AibConfig | null;
    readonly machineLocal: AibConfig | null;
    readonly repository: AibConfig | null;
    readonly userGlobal: AibConfig | null;
    readonly paths: {
      readonly explicit?: string;
      readonly machineLocal: string;
      readonly repository: string;
      readonly userGlobal: string;
    };
  };
}

export const AIB_REPOSITORY_CONFIG_FILENAME = "aib.config.json";
export const AIB_MACHINE_CONFIG_FILENAME = "aib.config.local.json";
export const AIB_USER_CONFIG_PATH = ".qube/aib/config.json";

export class AibConfigLayerError extends TypeError {
  readonly scope: "explicit" | "machine-local" | "repository" | "user-global" | "effective";
  readonly path: string;
  readonly field: string;
  readonly reason: string;
  readonly nextAction: string;

  constructor(input: {
    scope: AibConfigLayerError["scope"];
    path: string;
    field?: string;
    reason: string;
  }) {
    const field = input.field ?? ".";
    const nextAction = `Fix ${input.path} at ${field}, then rerun the command.`;
    super(`Invalid ${input.scope} Bootstrap config at ${input.path}:${field}. Reason: ${input.reason} Next action: ${nextAction}`);
    this.name = "AibConfigLayerError";
    this.scope = input.scope;
    this.path = input.path;
    this.field = field;
    this.reason = input.reason;
    this.nextAction = nextAction;
  }
}

export const defaultAibConfig: AibConfig = Object.freeze({
  version: 1,
  agent: {
    questionBudget: 3
  },
  paths: {
    stateDir: ".qube/aib",
    docsDir: "docs",
    specPath: "docs/spec.md",
    milestonesDir: "docs/milestones",
    issuesDir: "docs/issues"
  },
  safety: {
    dryRunRequired: true,
    allowNetwork: false,
    packageAgeDays: 7
  }
});

export function loadAibConfig(
  configPath: string | undefined,
  options: { readonly startDir?: string; readonly homeDirectory?: string } = {},
): LoadedAibConfig {
  const startDir = resolve(options.startDir ?? ".");
  const repositoryPath = join(startDir, AIB_REPOSITORY_CONFIG_FILENAME);
  const machineLocalPath = join(startDir, AIB_MACHINE_CONFIG_FILENAME);
  const userGlobalPath = join(resolve(options.homeDirectory ?? defaultHomeDirectory()), ...AIB_USER_CONFIG_PATH.split("/"));
  const explicitPath = configPath ? resolve(configPath) : undefined;
  const repository = explicitPath === repositoryPath ? null : readLayer(repositoryPath, "repository");
  const layers = {
    explicit: explicitPath ? readLayer(explicitPath, "explicit", true) : null,
    machineLocal: readLayer(machineLocalPath, "machine-local"),
    repository,
    userGlobal: readLayer(userGlobalPath, "user-global"),
  } as const;
  const partials = [layers.userGlobal, layers.repository, layers.machineLocal, layers.explicit].filter((layer): layer is AibConfig => layer !== null);
  const merged = mergeAibConfigLayers(partials);
  let config: AibConfig;
  try {
    config = parseAibConfig(merged);
  } catch (error) {
    const parsed = parseFieldError(error);
    throw new AibConfigLayerError({ scope: "effective", path: explicitPath ?? repositoryPath, ...parsed });
  }
  const activeFields = AIB_CONFIG_FIELDS.filter(field => field.read(config) !== undefined);
  const resolved = resolveLayeredFields({
    fields: activeFields,
    layers: [
      { source: "explicit", config: layers.explicit },
      { source: "machine-local", config: layers.machineLocal },
      { source: "repository", config: layers.repository },
      { source: "user-global", config: layers.userGlobal },
      { source: "default", config: defaultAibConfig },
    ],
  });
  return {
    ...(explicitPath ? { path: explicitPath } : layers.repository ? { path: repositoryPath } : {}),
    config,
    fieldSources: resolved.sources,
    layers: {
      ...layers,
      paths: {
        ...(explicitPath ? { explicit: explicitPath } : {}),
        machineLocal: machineLocalPath,
        repository: repositoryPath,
        userGlobal: userGlobalPath,
      },
    },
  };
}

export function parseAibConfig(value: unknown): AibConfig {
  if (!isRecord(value)) {
    throw new TypeError("aib.config.json must be a JSON object.");
  }
  if (value.version !== 1) {
    throw new TypeError("aib.config.json version must be 1.");
  }

  rejectUnknownKeys(value, ["version", "project", "providers", "agent", "discovery", "paths", "safety"], "");

  const project = optionalRecord(value.project, "project");
  const providers = optionalRecord(value.providers, "providers");
  const agent = optionalRecord(value.agent, "agent");
  const discovery = optionalRecord(value.discovery, "discovery");
  const paths = optionalRecord(value.paths, "paths");
  const safety = optionalRecord(value.safety, "safety");

  return {
    version: 1,
    ...(project ? { project: parseProject(project) } : {}),
    ...(providers ? { providers: parseProviders(providers) } : {}),
    ...(agent ? { agent: parseAgent(agent) } : {}),
    ...(discovery ? { discovery: parseDiscovery(discovery) } : {}),
    ...(paths ? { paths: parsePaths(paths) } : {}),
    ...(safety ? { safety: parseSafety(safety) } : {})
  };
}

export function mergeAibConfig(config: AibConfig): AibConfig {
  return {
    version: 1,
    project: config.project,
    providers: config.providers,
    agent: {
      ...defaultAibConfig.agent,
      ...config.agent
    },
    discovery: config.discovery,
    paths: {
      ...defaultAibConfig.paths,
      ...config.paths
    },
    safety: {
      ...defaultAibConfig.safety,
      ...config.safety
    }
  };
}

function parseProject(value: Readonly<Record<string, unknown>>): NonNullable<AibConfig["project"]> {
  rejectUnknownKeys(value, ["name", "privacy"], "project");
  const project: Record<string, string> = {};
  if (value.name !== undefined) project.name = requireString(value.name, "project.name");
  if (value.privacy !== undefined) project.privacy = requireOneOf(value.privacy, "project.privacy", ["local-first", "network-allowed", "restricted"]);
  return project;
}

function parseProviders(value: Readonly<Record<string, unknown>>): NonNullable<AibConfig["providers"]> {
  rejectUnknownKeys(value, ["work", "review"], "providers");
  const providers: Record<string, AibProviderKind> = {};
  if (value.work !== undefined) providers.work = requireOneOf(value.work, "providers.work", ["github", "gitlab", "linear", "jira", "local", "none"]);
  if (value.review !== undefined) providers.review = requireOneOf(value.review, "providers.review", ["github", "local", "none"]);
  return providers;
}

function parseAgent(value: Readonly<Record<string, unknown>>): NonNullable<AibConfig["agent"]> {
  rejectUnknownKeys(value, ["host", "questionBudget", "surfaces"], "agent");
  const agent: Record<string, string | number | readonly AibAgentHost[]> = {};
  if (value.host !== undefined) agent.host = requireOneOf(value.host, "agent.host", AGENT_HOST_IDS);
  if (value.questionBudget !== undefined) {
    const budget = value.questionBudget;
    if (typeof budget !== "number" || !Number.isInteger(budget) || budget < 1 || budget > 8) {
      throw new TypeError("agent.questionBudget must be an integer between 1 and 8.");
    }
    agent.questionBudget = budget;
  }
  if (value.surfaces !== undefined) {
    if (!Array.isArray(value.surfaces) || value.surfaces.length === 0) {
      throw new TypeError("agent.surfaces must be a non-empty array when provided.");
    }
    agent.surfaces = value.surfaces.map((item, index) => requireOneOf(item, `agent.surfaces[${index}]`, AGENT_HOST_IDS));
  }
  return agent;
}

function parseDiscovery(value: Readonly<Record<string, unknown>>): NonNullable<AibConfig["discovery"]> {
  rejectUnknownKeys(value, ["referencePaths", "inspectCurrentRepo", "inspectDocs", "inspectSiblingRepos"], "discovery");
  const discovery: {
    referencePaths?: readonly string[];
    inspectCurrentRepo?: boolean;
    inspectDocs?: boolean;
    inspectSiblingRepos?: boolean;
  } = {};
  if (value.referencePaths !== undefined) {
    if (!Array.isArray(value.referencePaths)) {
      throw new TypeError("discovery.referencePaths must be an array when provided.");
    }
    discovery.referencePaths = value.referencePaths.map((item, index) => requireString(item, `discovery.referencePaths[${index}]`));
  }
  if (value.inspectCurrentRepo !== undefined) discovery.inspectCurrentRepo = requireBoolean(value.inspectCurrentRepo, "discovery.inspectCurrentRepo");
  if (value.inspectDocs !== undefined) discovery.inspectDocs = requireBoolean(value.inspectDocs, "discovery.inspectDocs");
  if (value.inspectSiblingRepos !== undefined) discovery.inspectSiblingRepos = requireBoolean(value.inspectSiblingRepos, "discovery.inspectSiblingRepos");
  return discovery;
}

function parsePaths(value: Readonly<Record<string, unknown>>): NonNullable<AibConfig["paths"]> {
  rejectUnknownKeys(value, ["stateDir", "docsDir", "specPath", "milestonesDir", "issuesDir"], "paths");
  const paths: Record<string, string> = {};
  if (value.stateDir !== undefined) paths.stateDir = requireString(value.stateDir, "paths.stateDir");
  if (value.docsDir !== undefined) paths.docsDir = requireString(value.docsDir, "paths.docsDir");
  if (value.specPath !== undefined) paths.specPath = requireString(value.specPath, "paths.specPath");
  if (value.milestonesDir !== undefined) paths.milestonesDir = requireString(value.milestonesDir, "paths.milestonesDir");
  if (value.issuesDir !== undefined) paths.issuesDir = requireString(value.issuesDir, "paths.issuesDir");
  return paths;
}

function parseSafety(value: Readonly<Record<string, unknown>>): NonNullable<AibConfig["safety"]> {
  rejectUnknownKeys(value, ["dryRunRequired", "allowNetwork", "packageAgeDays"], "safety");
  const safety: Record<string, boolean | number> = {};
  if (value.dryRunRequired !== undefined) safety.dryRunRequired = requireBoolean(value.dryRunRequired, "safety.dryRunRequired");
  if (value.allowNetwork !== undefined) safety.allowNetwork = requireBoolean(value.allowNetwork, "safety.allowNetwork");
  if (value.packageAgeDays !== undefined) {
    const days = value.packageAgeDays;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 0) {
      throw new TypeError("safety.packageAgeDays must be a non-negative integer.");
    }
    safety.packageAgeDays = days;
  }
  return safety;
}

function optionalRecord(value: unknown, field: string): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new TypeError(`${field} must be an object when provided.`);
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${field} must be a boolean.`);
  }
  return value;
}

function requireOneOf<const Values extends readonly string[]>(value: unknown, field: string, values: Values): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new TypeError(`${field} must be one of: ${values.join(", ")}.`);
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const AIB_CONFIG_FIELDS = Object.freeze([
  field("project.name"), field("project.privacy"),
  field("providers.work"), field("providers.review"),
  field("agent.host"), field("agent.questionBudget"), field("agent.surfaces"),
  field("discovery.referencePaths"), field("discovery.inspectCurrentRepo"), field("discovery.inspectDocs"), field("discovery.inspectSiblingRepos"),
  field("paths.stateDir"), field("paths.docsDir"), field("paths.specPath"), field("paths.milestonesDir"), field("paths.issuesDir"),
  field("safety.dryRunRequired"), field("safety.allowNetwork"), field("safety.packageAgeDays"),
] as const);

function field(id: string): LayeredConfigField<AibConfig, string> {
  return { id, read: config => readPath(config, id.split(".")) };
}

function readPath(value: unknown, path: readonly string[]): unknown | undefined {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current) || !(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}

function defaultHomeDirectory(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? homedir();
}

function readLayer(
  path: string,
  scope: "explicit" | "machine-local" | "repository" | "user-global",
  required = false,
): AibConfig | null {
  if (!existsSync(path)) {
    if (required) throw new AibConfigLayerError({ scope, path, reason: "The selected config file does not exist." });
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parseAibConfig(parsed);
  } catch (error) {
    if (error instanceof AibConfigLayerError) throw error;
    const parsed = parseFieldError(error);
    throw new AibConfigLayerError({ scope, path, ...parsed });
  }
}

function parseFieldError(error: unknown): { field?: string; reason: string } {
  const reason = error instanceof Error ? error.message : String(error);
  const match = /^([A-Za-z][A-Za-z0-9.[\]]*)\s/.exec(reason);
  return { ...(match ? { field: match[1] } : {}), reason };
}

function mergeAibConfigLayers(layers: readonly AibConfig[]): AibConfig {
  let result: AibConfig = defaultAibConfig;
  for (const layer of layers) {
    result = {
      version: 1,
      project: mergeSection(result.project, layer.project),
      providers: mergeSection(result.providers, layer.providers),
      agent: mergeSection(result.agent, layer.agent),
      discovery: mergeSection(result.discovery, layer.discovery),
      paths: mergeSection(result.paths, layer.paths),
      safety: mergeSection(result.safety, layer.safety),
    };
  }
  return result;
}

function mergeSection<Value extends object>(lower: Value | undefined, higher: Value | undefined): Value | undefined {
  if (!lower && !higher) return undefined;
  return { ...lower, ...higher } as Value;
}

function rejectUnknownKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      const field = path ? `${path}.${key}` : key;
      throw new TypeError(`${field} is not supported in the current Bootstrap config shape.`);
    }
  }
}
