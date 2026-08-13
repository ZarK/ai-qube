import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

export const QUBE_INIT_RECORD_PATH = ".qube/init.json";

export const MCP_BYPASS_CAVEAT =
  "Host MCP servers can bypass QUBE policy, evidence, and queue rules. Keep provider access on qube commands unless you opt in for exploratory reading with scoped read-only credentials.";

export const PROVIDER_MCP_CONFIG_PATHS = Object.freeze([
  ".mcp.json",
  path.posix.join(".claude", "mcp.json"),
  path.posix.join(".codex", "mcp.json"),
  path.posix.join(".cursor", "mcp.json"),
]);

export type ToolkitHostId = "generic" | "codex" | "claude-code" | "grok-build" | "opencode";
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

export interface HostToolkitManifest {
  readonly host: ToolkitHostId;
  readonly displayName: string;
  readonly assets: readonly ToolkitAsset[];
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

const HOST_DISPLAY_NAMES: Readonly<Record<ToolkitHostId, string>> = Object.freeze({
  generic: "generic",
  codex: "Codex",
  "claude-code": "Claude Code",
  "grok-build": "Grok Build",
  opencode: "OpenCode",
});

const KNOWN_HOSTS = Object.freeze(["generic", "codex", "claude-code", "grok-build", "opencode"] as const);

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

function claudeCodeAssets(): readonly ToolkitAsset[] {
  return Object.freeze([
    asset("claude-instructions", "instruction", "aie", "Always-loaded Claude Code instructions.", { path: "CLAUDE.md" }),
    asset("claude-make-it-so", "command", "aie", "Claude Code make-it-so project command.", { path: path.posix.join(".claude", "commands", "make-it-so.md") }),
    asset("claude-make-it-so-skill", "skill", "aie", "Claude Code make-it-so skill.", { path: path.posix.join(".claude", "skills", "make-it-so", "SKILL.md") }),
    asset("claude-review-focus", "subagent", "aie", "Claude Code review-focus subagent.", { path: path.posix.join(".claude", "agents", "qube-review-focus.md"), required: false }),
    asset("claude-review-explorer", "subagent", "aie", "Claude Code review-explorer subagent.", { path: path.posix.join(".claude", "agents", "qube-review-explorer.md"), required: false }),
    asset("claude-review-digest", "subagent", "aie", "Claude Code review-digest subagent.", { path: path.posix.join(".claude", "agents", "qube-review-digest.md"), required: false }),
    asset("claude-review-librarian", "subagent", "aie", "Claude Code review-librarian subagent.", { path: path.posix.join(".claude", "agents", "qube-review-librarian.md"), required: false }),
    asset("claude-stop-hook", "hook", "aiu", "Claude Code AI Umpire Stop hook.", { path: path.posix.join(".claude", "settings.json") }),
  ]);
}

function codexAssets(): readonly ToolkitAsset[] {
  return Object.freeze([
    asset("codex-instructions", "instruction", "aie", "Always-loaded Codex instructions.", { path: "AGENTS.md" }),
    asset("codex-make-it-so", "command", "aie", "Codex make-it-so project prompt.", { path: path.posix.join(".codex", "prompts", "make-it-so.md") }),
    asset("codex-review-focus", "subagent", "aie", "Codex review-focus subagent.", { path: path.posix.join(".codex", "agents", "qube-review-focus.toml"), required: false }),
    asset("codex-review-explorer", "subagent", "aie", "Codex review-explorer subagent.", { path: path.posix.join(".codex", "agents", "qube-review-explorer.toml"), required: false }),
    asset("codex-review-digest", "subagent", "aie", "Codex review-digest subagent.", { path: path.posix.join(".codex", "agents", "qube-review-digest.toml"), required: false }),
    asset("codex-review-librarian", "subagent", "aie", "Codex review-librarian subagent.", { path: path.posix.join(".codex", "agents", "qube-review-librarian.toml"), required: false }),
    asset("codex-stop-hook", "hook", "aiu", "Codex AI Umpire plugin marketplace entry.", { path: path.posix.join(".agents", "plugins", "marketplace.json") }),
  ]);
}

function opencodeAssets(): readonly ToolkitAsset[] {
  return Object.freeze([
    asset("opencode-instructions", "instruction", "aie", "Always-loaded OpenCode instructions.", { path: "AGENTS.md" }),
    asset("opencode-make-it-so", "command", "aie", "OpenCode make-it-so project command.", { path: path.posix.join(".opencode", "commands", "make-it-so.md") }),
    asset("opencode-review-focus", "subagent", "aie", "OpenCode review-focus subagent.", { path: path.posix.join(".opencode", "agent", "qube-review-focus.md"), required: false }),
    asset("opencode-review-explorer", "subagent", "aie", "OpenCode review-explorer subagent.", { path: path.posix.join(".opencode", "agent", "qube-review-explorer.md"), required: false }),
    asset("opencode-review-digest", "subagent", "aie", "OpenCode review-digest subagent.", { path: path.posix.join(".opencode", "agent", "qube-review-digest.md"), required: false }),
    asset("opencode-review-librarian", "subagent", "aie", "OpenCode review-librarian subagent.", { path: path.posix.join(".opencode", "agent", "qube-review-librarian.md"), required: false }),
    asset("opencode-plugin", "hook", "aiu", "OpenCode AI Umpire continuation plugin.", { path: path.posix.join(".opencode", "plugins", "ai-umpire-continuation.ts") }),
  ]);
}

function grokBuildAssets(): readonly ToolkitAsset[] {
  return Object.freeze([
    asset("grok-instructions", "instruction", "aie", "Always-loaded Grok Build instructions.", { path: "AGENTS.md" }),
  ]);
}

function genericAssets(): readonly ToolkitAsset[] {
  return Object.freeze([]);
}

function assetsForHost(host: ToolkitHostId): readonly ToolkitAsset[] {
  if (host === "claude-code") return claudeCodeAssets();
  if (host === "codex") return codexAssets();
  if (host === "opencode") return opencodeAssets();
  if (host === "grok-build") return grokBuildAssets();
  return genericAssets();
}

function isToolkitHostId(value: string): value is ToolkitHostId {
  return (KNOWN_HOSTS as readonly string[]).includes(value);
}

function usesGithub(workProviders: readonly string[], ciProviders: readonly string[]): boolean {
  return workProviders.includes("github") || ciProviders.includes("github");
}

export function composeHostToolkitManifests(
  hosts: readonly string[],
  options: ComposeHostToolkitOptions = {},
): HostToolkitComposition {
  const selected = Object.freeze([...hosts]);
  const manifests = Object.freeze(
    selected.filter(isToolkitHostId).map((host) => Object.freeze({
      host,
      displayName: HOST_DISPLAY_NAMES[host],
      assets: assetsForHost(host),
    })),
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
    });
  }
  return Object.freeze({
    host: manifest.host,
    displayName: manifest.displayName,
    status: "missing",
    present: Object.freeze(present),
    missing: Object.freeze(missing),
    reason: `${manifest.displayName} is missing required toolkit files: ${missing.join(", ")}.`,
  });
}

function rollupStatus(hosts: readonly HostToolkitProbe[], cli: readonly ToolkitCliDependency[], hasRecord: boolean): ToolkitHostStatus {
  if (!hasRecord) return "unknown";
  if (hosts.length === 0 || hosts.some((host) => host.status === "missing")) return "missing";
  if (cli.some((item) => item.required && (item.status === "missing" || item.status === "unauthenticated"))) return "partial";
  if (hosts.every((host) => host.status === "complete")) return "complete";
  return "partial";
}

function probeSelectedHost(cwd: string, host: string): HostToolkitProbe {
  if (!isToolkitHostId(host)) {
    return Object.freeze({
      host,
      displayName: host,
      status: "missing",
      present: Object.freeze([]),
      missing: Object.freeze([host]),
      reason: `Host "${host}" is not a supported toolkit host.`,
    });
  }
  return probeManifest(cwd, Object.freeze({
    host,
    displayName: HOST_DISPLAY_NAMES[host],
    assets: assetsForHost(host),
  }));
}

export function probeHostToolkits(options: ProbeHostToolkitOptions): HostToolkitReport {
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

  const hosts = Object.freeze(record.hosts.map((host) => probeSelectedHost(options.cwd, host)));
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
    const required = manifest.assets.filter((item) => item.required).map((item) => item.path ?? item.command ?? item.id);
    lines.push(`- ${manifest.host}: ${required.length > 0 ? required.join(", ") : "no required host files"}`);
  }
  lines.push(`Provider MCP: ${composition.mcp.optIn ? "opt-in recorded" : "off"}; configured=no`);
  lines.push(composition.mcp.caveat);
  return `${lines.join("\n")}\n`;
}
