import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type AibAgentHost = "codex" | "opencode" | "claude-code" | "gemini" | "other";
export type AibPrivacyMode = "local-first" | "network-allowed" | "restricted";
export type AibProviderKind = "github" | "local" | "none";

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
}

export const defaultAibConfig: AibConfig = Object.freeze({
  version: 1,
  agent: {
    questionBudget: 3
  },
  paths: {
    stateDir: ".bootstrap",
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

export function loadAibConfig(configPath: string | undefined): LoadedAibConfig {
  if (!configPath) {
    return { config: defaultAibConfig };
  }

  const resolvedPath = resolve(configPath);
  const parsed = JSON.parse(readFileSync(resolvedPath, "utf8")) as unknown;
  const config = parseAibConfig(parsed);
  return {
    path: resolvedPath,
    config: mergeAibConfig(config)
  };
}

export function parseAibConfig(value: unknown): AibConfig {
  if (!isRecord(value)) {
    throw new TypeError("aib.config.json must be a JSON object.");
  }
  if (value.version !== 1) {
    throw new TypeError("aib.config.json version must be 1.");
  }

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
  const project: Record<string, string> = {};
  if (value.name !== undefined) project.name = requireString(value.name, "project.name");
  if (value.privacy !== undefined) project.privacy = requireOneOf(value.privacy, "project.privacy", ["local-first", "network-allowed", "restricted"]);
  return project;
}

function parseProviders(value: Readonly<Record<string, unknown>>): NonNullable<AibConfig["providers"]> {
  const providers: Record<string, AibProviderKind> = {};
  if (value.work !== undefined) providers.work = requireOneOf(value.work, "providers.work", ["github", "local", "none"]);
  if (value.review !== undefined) providers.review = requireOneOf(value.review, "providers.review", ["github", "local", "none"]);
  return providers;
}

function parseAgent(value: Readonly<Record<string, unknown>>): NonNullable<AibConfig["agent"]> {
  const agent: Record<string, string | number | readonly AibAgentHost[]> = {};
  if (value.host !== undefined) agent.host = requireOneOf(value.host, "agent.host", ["codex", "opencode", "claude-code", "gemini", "other"]);
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
    agent.surfaces = value.surfaces.map((item, index) => requireOneOf(item, `agent.surfaces[${index}]`, ["codex", "opencode", "claude-code", "gemini", "other"]));
  }
  return agent;
}

function parseDiscovery(value: Readonly<Record<string, unknown>>): NonNullable<AibConfig["discovery"]> {
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
  const paths: Record<string, string> = {};
  if (value.stateDir !== undefined) paths.stateDir = requireString(value.stateDir, "paths.stateDir");
  if (value.docsDir !== undefined) paths.docsDir = requireString(value.docsDir, "paths.docsDir");
  if (value.specPath !== undefined) paths.specPath = requireString(value.specPath, "paths.specPath");
  if (value.milestonesDir !== undefined) paths.milestonesDir = requireString(value.milestonesDir, "paths.milestonesDir");
  if (value.issuesDir !== undefined) paths.issuesDir = requireString(value.issuesDir, "paths.issuesDir");
  return paths;
}

function parseSafety(value: Readonly<Record<string, unknown>>): NonNullable<AibConfig["safety"]> {
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
