import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

import { getAgentHostProfileSync, getAgentHostProfiles } from "@tjalve/aie";
import { evaluateGitHubReadiness, type GitHubReadiness, type GitHubRole } from "@tjalve/qube-adapter-github";
import {
  AGENT_HOST_IDS,
  defineAgentHostProfile,
  type AgentHostCapability,
  type AgentHostCapabilitySupport,
  type AgentHostContinuationDelivery,
  type AgentHostId,
  type AgentHostProfile,
  type AgentHostTrustAction,
} from "@tjalve/qube-core";
import {
  mergeQubeInitConfigs,
  parseQubeInitConfig,
  readQubeInitConfig,
  repoQubeConfigPath,
  resolveQubeInitConfig,
  userQubeConfigPath,
  writeQubeInitConfig,
  type QubeInitConfig,
  type RequiredQubeInitConfig,
  type QubeReviewMode,
  type QubeReviewPublisher,
  type QubeUmpireScope,
} from "./init_config.js";

export const QUBE_INIT_RECORD_PATH = ".qube/init.json";

export const MCP_BYPASS_CAVEAT =
  "Host MCP servers can bypass QUBE policy, evidence, and queue rules. Keep provider access on qube commands unless you opt in for exploratory reading with scoped read-only credentials.";

export const PROVIDER_MCP_CONFIG_PATHS = Object.freeze([
  ".mcp.json",
  path.posix.join(".claude", "mcp.json"),
  path.posix.join(".codex", "mcp.json"),
  path.posix.join(".cursor", "mcp.json"),
]);

export type ToolkitHostId = AgentHostId;
export type ToolkitAssetKind = "instruction" | "subagent" | "command" | "skill" | "hook" | "cli-dependency";
export type ToolkitHostStatus = "complete" | "missing" | "partial" | "unknown";
export type ToolkitCliStatus = "pass" | "missing" | "unauthenticated" | "needs-action" | "unverified" | "not-required";

export function defaultReviewSelection(hosts: readonly string[]): {
  readonly mode: QubeReviewMode;
  readonly harness?: string;
} {
  const primary = hosts[0];
  const isolatedHarness = hosts.find(host => (
    host !== primary && isToolkitHostId(host) && getAgentHostProfileSync(host).review.isolated.support !== "unsupported"
  ));
  if (isolatedHarness) return Object.freeze({ mode: "isolated", harness: isolatedHarness });
  if (primary && isToolkitHostId(primary) && getAgentHostProfileSync(primary).review.local.support !== "unsupported") {
    return Object.freeze({ mode: "host", harness: primary });
  }
  return Object.freeze({ mode: "external" });
}

export interface ToolkitAsset {
  readonly id: string;
  readonly kind: ToolkitAssetKind;
  readonly path?: string;
  readonly command?: string;
  readonly required: boolean;
  readonly source: "aie" | "aiu" | "cli";
  readonly description: string;
}

export interface ToolkitCapability {
  readonly support: AgentHostCapabilitySupport;
  readonly description: string;
  readonly nextAction?: string;
}

export interface ToolkitReviewCapabilities {
  readonly local: ToolkitCapability & { readonly freshContext: boolean; readonly readOnly: boolean };
  readonly isolated: ToolkitCapability & { readonly freshContext: boolean; readonly readOnly: boolean };
}

export interface ToolkitExecutables {
  readonly names: readonly string[];
  readonly windowsNames: readonly string[];
}

export interface ToolkitContinuationCapability extends ToolkitCapability {
  readonly delivery: AgentHostContinuationDelivery;
  readonly effectiveDelivery: AgentHostContinuationDelivery;
  readonly state: "active" | "disabled" | "unverified" | "unavailable";
  readonly currentIssueRecovery: boolean;
}

export interface ToolkitUmpireCapabilities {
  readonly continuation: ToolkitContinuationCapability;
  readonly probe: ToolkitCapability & { readonly command: readonly string[] };
}

export interface ToolkitTrustCapability {
  readonly required: boolean;
  readonly description: string;
  readonly actions: readonly AgentHostTrustAction[];
}

export interface ToolkitHostCapabilities {
  readonly taskList: ToolkitCapability & { readonly tools: readonly string[] };
  readonly subagents: ToolkitCapability;
  readonly review: ToolkitReviewCapabilities;
  readonly modelDiscovery: ToolkitCapability;
  readonly umpire: ToolkitUmpireCapabilities;
  readonly trust: ToolkitTrustCapability;
}

export interface HostToolkitManifest {
  readonly host: ToolkitHostId;
  readonly displayName: string;
  readonly executables: ToolkitExecutables;
  readonly assets: readonly ToolkitAsset[];
  readonly capabilities: ToolkitHostCapabilities;
}

export interface HostToolkitComposition {
  readonly status: "planned";
  readonly selected: readonly string[];
  readonly manifests: readonly HostToolkitManifest[];
  readonly mcp: ToolkitMcpState;
}

export interface ToolkitMcpState {
  readonly optIn: boolean;
  readonly configured: boolean;
  readonly caveat: string;
}

export interface QubeInitRecord extends QubeInitConfig {
  readonly version: 1;
  readonly hosts: readonly string[];
  readonly workProviders: readonly string[];
  readonly ciProviders: readonly string[];
  readonly continuousShipping: boolean;
  readonly umpire: { readonly scope: QubeUmpireScope };
  readonly quality: { readonly stages: readonly string[] };
  readonly review: {
    readonly mode: QubeReviewMode;
    readonly harness?: string;
    readonly externalReviewers?: readonly string[];
    readonly publisher: QubeReviewPublisher;
    readonly models?: readonly string[];
  };
  readonly mcp: { readonly optIn: boolean };
}

export interface ToolkitCliDependency {
  readonly id: "gh";
  readonly required: boolean;
  readonly present: boolean;
  readonly authenticated: boolean;
  readonly status: ToolkitCliStatus;
  readonly nextAction: string;
}

export interface HostToolkitProbe {
  readonly host: string;
  readonly displayName: string;
  readonly status: ToolkitHostStatus;
  readonly present: readonly string[];
  readonly missing: readonly string[];
  readonly reason: string;
  readonly capabilities?: ToolkitHostCapabilities;
}

export interface HostToolkitReport {
  readonly status: ToolkitHostStatus;
  readonly selected: readonly string[];
  readonly hosts: readonly HostToolkitProbe[];
  readonly cliDependencies: readonly ToolkitCliDependency[];
  readonly mcp: ToolkitMcpState;
  readonly recommendations: readonly string[];
  readonly githubReadiness: GitHubReadiness;
}

export interface ComposeHostToolkitOptions {
  readonly workProviders?: readonly string[];
  readonly ciProviders?: readonly string[];
  readonly mcpOptIn?: boolean;
}

export interface ProbeHostToolkitOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly offline?: boolean;
  readonly record?: QubeInitRecord | null;
  readonly githubReadiness?: GitHubReadiness;
}

const KNOWN_HOSTS: readonly ToolkitHostId[] = AGENT_HOST_IDS;

function asset(
  id: string,
  kind: ToolkitAssetKind,
  source: ToolkitAsset["source"],
  description: string,
  extra: { path?: string; command?: string; required?: boolean } = {},
): ToolkitAsset {
  return Object.freeze({
    id,
    kind,
    source,
    description,
    required: extra.required !== false,
    ...(extra.path ? { path: extra.path } : {}),
    ...(extra.command ? { command: extra.command } : {}),
  });
}

function capabilitySummary(capability: AgentHostCapability): ToolkitCapability {
  return Object.freeze({
    support: capability.support,
    description: capability.description,
    ...(capability.nextAction ? { nextAction: capability.nextAction } : {}),
  });
}

function hostCapabilities(profile: AgentHostProfile): ToolkitHostCapabilities {
  const umpireProbe = profile.umpire.probe.support === "unsupported"
    ? Object.freeze({ ...capabilitySummary(profile.umpire.probe), command: Object.freeze([]) })
    : Object.freeze({ ...capabilitySummary(profile.umpire.probe), command: Object.freeze([...profile.umpire.probe.command]) });
  const continuationState = profile.umpire.continuation.support === "unsupported" ? "unavailable" : "unverified";
  return Object.freeze({
    taskList: Object.freeze({
      ...capabilitySummary(profile.taskList),
      tools: Object.freeze([...profile.taskList.tools]),
    }),
    subagents: capabilitySummary(profile.subagents),
    review: Object.freeze({
      local: Object.freeze({
        ...capabilitySummary(profile.review.local),
        freshContext: profile.review.local.freshContext,
        readOnly: profile.review.local.readOnly,
      }),
      isolated: Object.freeze({
        ...capabilitySummary(profile.review.isolated),
        freshContext: profile.review.isolated.freshContext,
        readOnly: profile.review.isolated.readOnly,
      }),
    }),
    modelDiscovery: capabilitySummary(profile.modelDiscovery),
    umpire: Object.freeze({
      continuation: Object.freeze({
        ...capabilitySummary(profile.umpire.continuation),
        delivery: profile.umpire.continuation.delivery,
        effectiveDelivery: "none",
        state: continuationState,
        currentIssueRecovery: false,
      }),
      probe: umpireProbe,
    }),
    trust: Object.freeze({
      required: profile.trust.required,
      description: profile.trust.description,
      actions: Object.freeze([...profile.trust.actions]),
    }),
  });
}

function assetsForProfile(profile: AgentHostProfile): readonly ToolkitAsset[] {
  const assets: ToolkitAsset[] = [
    asset(profile.instructionTarget.id, "instruction", "aie", profile.instructionTarget.description, {
      path: profile.instructionTarget.path,
    }),
    asset(profile.makeItSo.id, profile.makeItSo.kind, "aie", profile.makeItSo.description, {
      path: profile.makeItSo.path,
      command: profile.makeItSo.invocation,
    }),
  ];
  for (const target of profile.review.local.agents) {
    assets.push(asset(target.id, "subagent", "aie", target.description, { path: target.path, required: false }));
  }
  const continuationRequired = profile.umpire.continuation.support !== "unsupported"
    && profile.umpire.continuation.currentIssueRecovery;
  for (const action of profile.trust.actions) {
    if (action.kind !== "review-files") continue;
    action.paths.forEach((assetPath, index) => {
      assets.push(asset(`${action.id}-${index + 1}`, "hook", "aiu", action.description, {
        path: assetPath,
        required: continuationRequired,
      }));
    });
  }
  const seenPaths = new Set<string>();
  return Object.freeze(assets.filter((item) => {
    if (!item.path || !seenPaths.has(item.path)) {
      if (item.path) seenPaths.add(item.path);
      return true;
    }
    return false;
  }));
}

export function composeHostToolkitManifest(profile: AgentHostProfile): HostToolkitManifest {
  const canonicalProfile = defineAgentHostProfile(profile);
  return Object.freeze({
    host: canonicalProfile.id,
    displayName: canonicalProfile.displayName,
    executables: Object.freeze({
      names: Object.freeze([...canonicalProfile.executables.names]),
      windowsNames: Object.freeze([...canonicalProfile.executables.windowsNames]),
    }),
    assets: assetsForProfile(canonicalProfile),
    capabilities: hostCapabilities(canonicalProfile),
  });
}

function isToolkitHostId(value: string): value is ToolkitHostId {
  return (KNOWN_HOSTS as readonly string[]).includes(value);
}

function usesGithub(workProviders: readonly string[], ciProviders: readonly string[]): boolean {
  return workProviders.includes("github") || ciProviders.includes("github");
}

export async function composeHostToolkitManifests(
  hosts: readonly string[],
  options: ComposeHostToolkitOptions = {},
): Promise<HostToolkitComposition> {
  const selected = Object.freeze([...hosts]);
  const selectedHostIds = selected.filter(isToolkitHostId);
  const profiles = await getAgentHostProfiles([...selectedHostIds]);
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  const manifests = Object.freeze(
    selectedHostIds.map((host) => composeHostToolkitManifest(profilesById.get(host)!)),
  );
  return Object.freeze({
    status: "planned",
    selected,
    manifests,
    mcp: Object.freeze({
      optIn: options.mcpOptIn === true,
      configured: false,
      caveat: MCP_BYPASS_CAVEAT,
    }),
  });
}

export function parseInitRecord(value: unknown): QubeInitRecord | null {
  try {
    return completeInitRecord(parseQubeInitConfig(value));
  } catch {
    return null;
  }
}

export function createInitRecord(input: {
  readonly hosts: readonly string[];
  readonly workProviders: readonly string[];
  readonly ciProviders: readonly string[];
  readonly mcpOptIn: boolean;
  readonly continuousShipping?: boolean;
  readonly umpireScope?: QubeUmpireScope;
  readonly qualityStages?: readonly string[];
  readonly reviewMode?: QubeReviewMode;
  readonly reviewHarness?: string;
  readonly externalReviewers?: readonly string[];
  readonly reviewPublisher?: QubeReviewPublisher;
  readonly reviewModels?: readonly string[];
}): QubeInitRecord {
  if (input.hosts.length === 0) throw new TypeError("QUBE init record requires at least one agent harness.");
  const defaultReview = defaultReviewSelection(input.hosts);
  const reviewMode = input.reviewMode ?? defaultReview.mode;
  const reviewHarness = input.reviewHarness
    ?? (reviewMode === "host" ? input.hosts[0] : reviewMode === "isolated" ? defaultReview.harness : undefined);
  const record = completeInitRecord(Object.freeze({
    version: 1,
    hosts: Object.freeze([...input.hosts]),
    workProviders: Object.freeze([...input.workProviders]),
    ciProviders: Object.freeze([...input.ciProviders]),
    continuousShipping: input.continuousShipping ?? true,
    umpire: Object.freeze({ scope: input.umpireScope ?? "ready" }),
    quality: Object.freeze({ stages: Object.freeze([...(input.qualityStages ?? ["unit"])]) }),
    review: Object.freeze({
      mode: reviewMode,
      ...(reviewHarness ? { harness: reviewHarness } : {}),
      ...(input.externalReviewers && input.externalReviewers.length > 0
        ? { externalReviewers: Object.freeze([...input.externalReviewers]) }
        : {}),
      publisher: input.reviewPublisher ?? "user",
      ...(input.reviewModels && input.reviewModels.length > 0
        ? { models: Object.freeze([...input.reviewModels]) }
        : {}),
    }),
    mcp: Object.freeze({ optIn: input.mcpOptIn }),
  }));
  if (!record) throw new TypeError("QUBE init record is incomplete.");
  return record;
}

export function initRecordPath(cwd: string): string {
  return path.join(resolveRepositoryRoot(cwd), ...QUBE_INIT_RECORD_PATH.split("/"));
}

export function readInitRecord(cwd: string, env: NodeJS.ProcessEnv = process.env): QubeInitRecord | null {
  const repoRoot = resolveRepositoryRoot(cwd);
  const repo = readQubeInitConfig(repoQubeConfigPath(repoRoot));
  if (repo.status === "invalid") return null;
  const homeDirectory = env.USERPROFILE ?? env.HOME ?? homedir();
  const global = readQubeInitConfig(userQubeConfigPath(homeDirectory));
  if (global.status === "invalid") return null;
  if (repo.status === "missing" && global.status === "missing") return null;
  const merged = mergeQubeInitConfigs(global.config, repo.config);
  const hosts = merged.hosts && merged.hosts.length > 0 ? merged.hosts : Object.freeze(["codex"]);
  const review = defaultReviewSelection(hosts);
  const defaults: RequiredQubeInitConfig = Object.freeze({
    version: 1,
    hosts,
    workProviders: Object.freeze(["github"]),
    ciProviders: Object.freeze(["github"]),
    continuousShipping: true,
    umpire: Object.freeze({ scope: "ready" }),
    quality: Object.freeze({ stages: Object.freeze(["unit"]) }),
    review: Object.freeze({ mode: review.mode, ...(review.harness ? { harness: review.harness } : {}), publisher: "user" }),
    mcp: Object.freeze({ optIn: false }),
  });
  const resolved = resolveQubeInitConfig({
    globalConfig: global.config,
    repoConfig: repo.config,
    defaults,
  });
  return completeInitRecord(resolved.config);
}

export function writeInitRecord(cwd: string, record: QubeInitRecord): string {
  const filePath = initRecordPath(cwd);
  writeQubeInitConfig(filePath, record);
  return filePath;
}

function completeInitRecord(config: QubeInitConfig): QubeInitRecord | null {
  if (
    !config.hosts ||
    config.hosts.length === 0 ||
    !config.workProviders ||
    !config.ciProviders ||
    config.continuousShipping === undefined ||
    !config.umpire?.scope ||
    !config.quality?.stages ||
    !config.review?.mode ||
    !config.review.publisher ||
    config.mcp?.optIn === undefined
  ) return null;
  const primary = config.hosts[0];
  const reviewHarness = config.review.harness;
  if (config.review.mode === "host" && (!primary || reviewHarness !== primary)) return null;
  if (config.review.mode === "isolated" && (!reviewHarness || reviewHarness === primary || !config.hosts.includes(reviewHarness))) return null;
  if (config.review.mode === "external" && reviewHarness) return null;
  return Object.freeze({
    version: 1,
    hosts: Object.freeze([...config.hosts]),
    workProviders: Object.freeze([...config.workProviders]),
    ciProviders: Object.freeze([...config.ciProviders]),
    continuousShipping: config.continuousShipping,
    umpire: Object.freeze({ scope: config.umpire.scope }),
    quality: Object.freeze({ stages: Object.freeze([...config.quality.stages]) }),
    review: Object.freeze({
      mode: config.review.mode,
      ...(config.review.harness ? { harness: config.review.harness } : {}),
      ...(config.review.externalReviewers ? { externalReviewers: Object.freeze([...config.review.externalReviewers]) } : {}),
      publisher: config.review.publisher,
      ...(config.review.models ? { models: Object.freeze([...config.review.models]) } : {}),
    }),
    mcp: Object.freeze({ optIn: config.mcp.optIn }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function providerMcpConfigPresent(cwd: string): boolean {
  const repoRoot = resolveRepositoryRoot(cwd);
  return PROVIDER_MCP_CONFIG_PATHS.some((relativePath) => {
    const filePath = path.join(repoRoot, ...relativePath.split("/"));
    try {
      return existsSync(filePath) && statSync(filePath).isFile();
    } catch {
      return false;
    }
  });
}

function filePresent(cwd: string, relativePath: string): boolean {
  const filePath = path.join(cwd, ...relativePath.split("/"));
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function ghDependency(readiness: GitHubReadiness): ToolkitCliDependency {
  const required = readiness.status !== "not-required";
  const status: ToolkitCliStatus = readiness.status === "not-required"
    ? "not-required"
    : readiness.reasonCode === "missing-cli"
      ? "missing"
      : readiness.status === "unverified"
        ? "unverified"
        : readiness.status === "needs-action"
          ? readiness.reasonCode === "unauthenticated" || readiness.reasonCode === "credential-invalid" ? "unauthenticated" : "needs-action"
          : "pass";
  return Object.freeze({
    id: "gh",
    required,
    present: readiness.reasonCode !== "missing-cli" && readiness.status !== "not-required",
    authenticated: readiness.status === "ready" || readiness.status === "unverified",
    status,
    nextAction: readiness.nextAction ?? readiness.summary,
  });
}

function probeManifest(cwd: string, manifest: HostToolkitManifest): HostToolkitProbe {
  const required = manifest.assets.filter((item) => item.required && item.path);
  const present: string[] = [];
  const missing: string[] = [];
  for (const item of required) {
    if (!item.path) continue;
    if (filePresent(cwd, item.path)) present.push(item.path);
    else missing.push(item.path);
  }
  if (required.length === 0) {
    return Object.freeze({
      host: manifest.host,
      displayName: manifest.displayName,
      status: "complete",
      present: Object.freeze(present),
      missing: Object.freeze(missing),
      reason: `${manifest.displayName} has no required host toolkit files.`,
      capabilities: manifest.capabilities,
    });
  }
  if (missing.length === 0) {
    return Object.freeze({
      host: manifest.host,
      displayName: manifest.displayName,
      status: "complete",
      present: Object.freeze(present),
      missing: Object.freeze(missing),
      reason: `${manifest.displayName} required toolkit files are present.`,
      capabilities: manifest.capabilities,
    });
  }
  return Object.freeze({
    host: manifest.host,
    displayName: manifest.displayName,
    status: "missing",
    present: Object.freeze(present),
    missing: Object.freeze(missing),
    reason: `${manifest.displayName} is missing required toolkit files: ${missing.join(", ")}.`,
    capabilities: manifest.capabilities,
  });
}

function rollupStatus(hosts: readonly HostToolkitProbe[], cli: readonly ToolkitCliDependency[], hasRecord: boolean): ToolkitHostStatus {
  if (!hasRecord) return "unknown";
  if (hosts.length === 0 || hosts.some((host) => host.status === "missing")) return "missing";
  if (cli.some((item) => item.required && (item.status === "missing" || item.status === "unauthenticated" || item.status === "needs-action"))) return "partial";
  if (hosts.every((host) => host.status === "complete")) return "complete";
  return "partial";
}

function probeUnknownHost(host: string): HostToolkitProbe {
  return Object.freeze({
    host,
    displayName: host,
    status: "missing",
    present: Object.freeze([]),
    missing: Object.freeze([host]),
    reason: `Host "${host}" is not a supported toolkit host.`,
  });
}

export async function probeHostToolkits(options: ProbeHostToolkitOptions): Promise<HostToolkitReport> {
  const repoRoot = resolveRepositoryRoot(options.cwd);
  const record = options.record === undefined ? readInitRecord(repoRoot, options.env) : options.record;
  const mcpConfigured = providerMcpConfigPresent(repoRoot);
  if (!record) {
    const githubReadiness = options.githubReadiness ?? await evaluateGitHubReadiness({ roles: [], cwd: repoRoot, env: options.env, offline: options.offline });
    return Object.freeze({
      status: "unknown",
      selected: Object.freeze([]),
      hosts: Object.freeze([]),
      cliDependencies: Object.freeze([]),
      mcp: Object.freeze({
        optIn: false,
        configured: mcpConfigured,
        caveat: MCP_BYPASS_CAVEAT,
      }),
      recommendations: Object.freeze(["No host toolkit record was found. Run `qube init` to select hosts and compose toolkit files."]),
      githubReadiness,
    });
  }

  const composition = await composeHostToolkitManifests(record.hosts, {
    workProviders: record.workProviders,
    ciProviders: record.ciProviders,
    mcpOptIn: record.mcp.optIn,
  });
  const manifestsByHost = new Map(composition.manifests.map((manifest) => [manifest.host, manifest]));
  const hosts = Object.freeze(record.hosts.map((host) => {
    if (!isToolkitHostId(host)) return probeUnknownHost(host);
    const manifest = manifestsByHost.get(host);
    return manifest ? probeManifest(repoRoot, manifest) : probeUnknownHost(host);
  }));
  const fallbackRoles: GitHubRole[] = [
    ...(record.workProviders.includes("github") ? ["work" as const] : []),
    ...(record.ciProviders.includes("github") ? ["ci" as const] : []),
  ];
  const githubReadiness = options.githubReadiness ?? await evaluateGitHubReadiness({
    roles: fallbackRoles,
    cwd: repoRoot,
    env: options.env,
    offline: options.offline,
  });
  const cliDependencies = Object.freeze([
    ghDependency(githubReadiness),
  ]);
  const status = rollupStatus(hosts, cliDependencies, true);
  const recommendations: string[] = [];
  for (const host of hosts) {
    if (host.status === "missing") {
      recommendations.push(`${host.reason} Run \`qube init\` to apply the effective setup.`);
    }
  }
  for (const cli of cliDependencies) {
    if (cli.required && cli.status !== "pass" && cli.status !== "unverified" && cli.status !== "not-required") {
      recommendations.push(cli.nextAction);
    }
  }
  if (mcpConfigured && !record.mcp.optIn) {
    recommendations.push("Provider MCP config is present without an explicit `qube init --mcp` opt-in. Remove the MCP config or rerun init with `--mcp` after you accept the bypass risk.");
  }
  return Object.freeze({
    status,
    selected: Object.freeze([...record.hosts]),
    hosts,
    cliDependencies,
    mcp: Object.freeze({
      optIn: record.mcp.optIn,
      configured: mcpConfigured,
      caveat: MCP_BYPASS_CAVEAT,
    }),
    recommendations: Object.freeze(recommendations),
    githubReadiness,
  });
}

function resolveRepositoryRoot(cwd: string): string {
  const resolved = path.resolve(cwd);
  const probe = spawnSync("git", ["-C", resolved, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const topLevel = probe.status === 0 ? probe.stdout.trim() : "";
  return topLevel === "" ? resolved : path.resolve(topLevel);
}

export function formatHostToolkits(report: HostToolkitReport): string {
  const lines = [`Host toolkits: ${report.status}`];
  if (report.selected.length > 0) {
    lines.push(`Selected hosts: ${report.selected.join(", ")}`);
  }
  if (report.hosts.length === 0) {
    lines.push("- no selected host toolkit record");
  }
  for (const host of report.hosts) {
    const detail = host.missing.length > 0 ? ` missing ${host.missing.join(", ")}` : "";
    lines.push(`- ${host.host}: ${host.status}${detail}`);
    if (host.capabilities) lines.push(`  ${formatToolkitCapabilities(host.capabilities)}`);
  }
  for (const cli of report.cliDependencies) {
    lines.push(`- cli ${cli.id}: ${cli.status}`);
  }
  const github = report.githubReadiness;
  lines.push(`GitHub connection: ${github.status} (${github.reasonCode}); roles=${github.roles.join(", ") || "none"}`);
  lines.push(`- Host: ${github.host ?? "not resolved"}; repository: ${github.repository ?? "not resolved"}; account: ${github.accountLogin ?? "none"}`);
  lines.push(`- Credential: ${github.credentialSource.kind}${github.credentialSource.name ? ` (${github.credentialSource.name})` : ""}`);
  for (const capability of github.capabilities) lines.push(`  - ${capability.capability}: ${capability.status} (${capability.reasonCode})`);
  if (github.nextAction) lines.push(`- Next: ${github.nextAction}`);
  lines.push(`Provider MCP: ${report.mcp.optIn ? "opt-in recorded" : "off"}; configured=${report.mcp.configured ? "yes" : "no"}`);
  lines.push(report.mcp.caveat);
  for (const recommendation of report.recommendations) {
    lines.push(`- ${recommendation}`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatPlannedHostToolkits(composition: HostToolkitComposition): string {
  const lines = ["Host toolkits:"];
  for (const manifest of composition.manifests) {
    const instruction = manifest.assets.find((item) => item.kind === "instruction");
    const makeItSo = manifest.assets.find((item) => item.command);
    lines.push(`- ${manifest.host}: instructions ${instruction?.path ?? "unavailable"}; Make It So ${makeItSo?.command ?? "unavailable"}`);
    lines.push(`  ${formatToolkitCapabilities(manifest.capabilities)}`);
  }
  lines.push(`Provider MCP: ${composition.mcp.optIn ? "opt-in recorded" : "off"}; configured=no`);
  lines.push(composition.mcp.caveat);
  return `${lines.join("\n")}\n`;
}

interface UmpireHostProbe {
  readonly host?: unknown;
  readonly state?: unknown;
  readonly effectiveDelivery?: unknown;
  readonly currentIssueRecovery?: unknown;
  readonly reason?: unknown;
  readonly nextAction?: unknown;
}

export function applyUmpireHostProbes(report: HostToolkitReport, doctorReport: unknown): HostToolkitReport {
  const rawProbes = isRecord(doctorReport) && Array.isArray(doctorReport.hostProbes)
    ? doctorReport.hostProbes.filter(isRecord) as UmpireHostProbe[]
    : [];
  const probes = new Map(rawProbes
    .filter((probe): probe is UmpireHostProbe & { host: string } => typeof probe.host === "string")
    .map((probe) => [probe.host, probe]));
  const hosts = report.hosts.map((host) => {
    if (!host.capabilities) return host;
    const probe = probes.get(host.host);
    const declared = host.capabilities.umpire.continuation;
    const state = probe && (probe.state === "active" || probe.state === "disabled" || probe.state === "unverified" || probe.state === "unavailable")
      ? probe.state
      : declared.support === "unsupported"
        ? "unavailable"
        : "unverified";
    const effectiveDelivery = state === "active" && (probe?.effectiveDelivery === "host" || probe?.effectiveDelivery === "stdout")
      ? probe.effectiveDelivery
      : "none";
    const currentIssueRecovery = state === "active" && probe?.currentIssueRecovery === true;
    const description = typeof probe?.reason === "string" && probe.reason.trim() !== ""
      ? probe.reason
      : declared.description;
    const nextAction = typeof probe?.nextAction === "string" && probe.nextAction.trim() !== ""
      ? probe.nextAction
      : declared.nextAction;
    return Object.freeze({
      ...host,
      capabilities: Object.freeze({
        ...host.capabilities,
        umpire: Object.freeze({
          ...host.capabilities.umpire,
          continuation: Object.freeze({
            ...declared,
            description,
            ...(nextAction ? { nextAction } : {}),
            state,
            effectiveDelivery,
            currentIssueRecovery,
          }),
        }),
      }),
    });
  });
  return Object.freeze({ ...report, hosts: Object.freeze(hosts) });
}

function formatToolkitCapabilities(capabilities: ToolkitHostCapabilities): string {
  const continuation = capabilities.umpire.continuation;
  const recovery = continuation.currentIssueRecovery ? ", current-issue recovery" : "";
  return [
    `task list ${capabilities.taskList.support}`,
    `subagents ${capabilities.subagents.support}`,
    `local review ${capabilities.review.local.support}`,
    `isolated review ${capabilities.review.isolated.support}`,
    `live models ${capabilities.modelDiscovery.support}`,
    `Umpire ${continuation.state}${recovery}`,
    `trust ${capabilities.trust.required ? "required" : "not required"}`,
  ].join("; ");
}
