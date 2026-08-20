import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { getAgentHostProfiles } from "@tjalve/aie";
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
export type ToolkitCliStatus = "pass" | "missing" | "unauthenticated" | "unverified" | "not-required";

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

export interface QubeInitRecord {
  readonly version: 1;
  readonly hosts: readonly string[];
  readonly workProviders: readonly string[];
  readonly ciProviders: readonly string[];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return null;
  return value.map((item) => item.trim()).filter((item) => item.length > 0);
}

export function parseInitRecord(value: unknown): QubeInitRecord | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const hosts = readStringArray(value.hosts);
  const workProviders = readStringArray(value.workProviders);
  const ciProviders = readStringArray(value.ciProviders);
  const mcp = isRecord(value.mcp) ? value.mcp : null;
  if (!hosts || !workProviders || !ciProviders || !mcp || typeof mcp.optIn !== "boolean") return null;
  return Object.freeze({
    version: 1,
    hosts: Object.freeze(hosts),
    workProviders: Object.freeze(workProviders),
    ciProviders: Object.freeze(ciProviders),
    mcp: Object.freeze({ optIn: mcp.optIn }),
  });
}

export function createInitRecord(input: {
  readonly hosts: readonly string[];
  readonly workProviders: readonly string[];
  readonly ciProviders: readonly string[];
  readonly mcpOptIn: boolean;
}): QubeInitRecord {
  return Object.freeze({
    version: 1,
    hosts: Object.freeze([...input.hosts]),
    workProviders: Object.freeze([...input.workProviders]),
    ciProviders: Object.freeze([...input.ciProviders]),
    mcp: Object.freeze({ optIn: input.mcpOptIn }),
  });
}

export function initRecordPath(cwd: string): string {
  return path.join(cwd, ...QUBE_INIT_RECORD_PATH.split("/"));
}

export function readInitRecord(cwd: string): QubeInitRecord | null {
  const filePath = initRecordPath(cwd);
  try {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) return null;
    return parseInitRecord(JSON.parse(readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

export function writeInitRecord(cwd: string, record: QubeInitRecord): string {
  const filePath = initRecordPath(cwd);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return filePath;
}

export function providerMcpConfigPresent(cwd: string): boolean {
  return PROVIDER_MCP_CONFIG_PATHS.some((relativePath) => {
    const filePath = path.join(cwd, ...relativePath.split("/"));
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

function probeGh(env: NodeJS.ProcessEnv | undefined, offline: boolean, required: boolean): ToolkitCliDependency {
  if (!required) {
    return Object.freeze({
      id: "gh",
      required: false,
      present: false,
      authenticated: false,
      status: "not-required",
      nextAction: "GitHub CLI is not required for the selected providers.",
    });
  }
  if (offline) {
    return Object.freeze({
      id: "gh",
      required: true,
      present: false,
      authenticated: false,
      status: "unverified",
      nextAction: "Offline doctor mode skips GitHub CLI presence and login checks.",
    });
  }
  const result = spawnSync("gh", ["auth", "status"], {
    env,
    encoding: "utf8",
    timeout: 8_000,
    windowsHide: true,
  });
  if (result.error || result.status === null) {
    return Object.freeze({
      id: "gh",
      required: true,
      present: false,
      authenticated: false,
      status: "missing",
      nextAction: "Install GitHub CLI (gh) and run `gh auth login`.",
    });
  }
  if (result.status !== 0) {
    return Object.freeze({
      id: "gh",
      required: true,
      present: true,
      authenticated: false,
      status: "unauthenticated",
      nextAction: "Run `gh auth login` to authenticate GitHub CLI.",
    });
  }
  return Object.freeze({
    id: "gh",
    required: true,
    present: true,
    authenticated: true,
    status: "pass",
    nextAction: "GitHub CLI is present and authenticated.",
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
  if (cli.some((item) => item.required && (item.status === "missing" || item.status === "unauthenticated"))) return "partial";
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
  const record = options.record === undefined ? readInitRecord(options.cwd) : options.record;
  const mcpConfigured = providerMcpConfigPresent(options.cwd);
  if (!record) {
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
    return manifest ? probeManifest(options.cwd, manifest) : probeUnknownHost(host);
  }));
  const githubSelected = usesGithub(record.workProviders, record.ciProviders);
  const cliDependencies = Object.freeze([
    probeGh(options.env, options.offline === true, githubSelected),
  ]);
  const status = rollupStatus(hosts, cliDependencies, true);
  const recommendations: string[] = [];
  for (const host of hosts) {
    if (host.status === "missing") {
      recommendations.push(`${host.reason} Run \`qube init . --host ${host.host}\` to install the missing files.`);
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
  });
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
