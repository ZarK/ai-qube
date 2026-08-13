import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import { executorCiProviders, executorHostSurfaces, executorWorkProviders } from "./components.js";
import { packageName, packageVersion } from "./package.js";

export type InstallStepStatus = "satisfied" | "stale" | "missing";

export interface InstallStateSelections {
  readonly scope: "local" | "global";
  readonly hosts: readonly string[];
  readonly workProviders: readonly string[];
  readonly ciProviders: readonly string[];
}

export interface InstallStepState {
  readonly stage: "package-install" | "workspace-init" | "provider-setup" | "verify";
  readonly status: InstallStepStatus;
  readonly reason: string;
}

const MANAGED_START = "<!-- BEGIN EXECUTOR MANAGED SECTION -->";
const MANAGED_END = "<!-- END EXECUTOR MANAGED SECTION -->";
const CHECKSUM_PATTERN = /<!--\s*executor-managed-checksum:\s*([a-f0-9]+)\s*-->/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveContained(cwd: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized === "" || normalized.includes("\0") || normalized.split("/").includes("..") || isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Refusing install-state path ${relativePath}. Use a repository-relative path.`);
  }
  const root = realpathSync(cwd);
  const resolved = join(root, ...normalized.split("/"));
  const relativeToRoot = relative(root, resolved);
  if (relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) {
    throw new Error(`Refusing install-state path outside the working directory: ${relativePath}.`);
  }
  return resolved;
}

function readJsonFile(path: string): unknown {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`Refusing to read install state through a symlink: ${path}.`);
    }
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function tryReadJsonFile(path: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: readJsonFile(path) };
  } catch {
    return { ok: false };
  }
}

function declaredPackageVersion(manifest: Record<string, unknown>, name: string): string | null {
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    const block = manifest[field];
    if (isRecord(block) && typeof block[name] === "string" && block[name].trim() !== "") {
      return block[name].trim();
    }
  }
  return null;
}

function selectedAdapterPackages(selections: InstallStateSelections): readonly string[] {
  const catalogs = [...executorHostSurfaces, ...executorWorkProviders, ...executorCiProviders];
  const ids = [...selections.hosts, ...selections.workProviders, ...selections.ciProviders];
  const names = new Set<string>();
  for (const id of ids) {
    const option = catalogs.find(entry => entry.id === id);
    if (option?.packageName && option.packageName !== packageName) names.add(option.packageName);
  }
  return [...names];
}

export function instructionTargetsForHosts(hosts: readonly string[]): readonly string[] {
  const targets = new Set<string>();
  for (const host of hosts) {
    if (host === "codex" || host === "grok-build") targets.add("AGENTS.md");
    if (host === "claude-code") targets.add("CLAUDE.md");
  }
  return [...targets];
}

function managedSectionStatus(content: string): InstallStepStatus | "absent" {
  const start = content.indexOf(MANAGED_START);
  const end = content.indexOf(MANAGED_END);
  if (start === -1 || end === -1 || end <= start) return "absent";
  const block = content.slice(start, end + MANAGED_END.length);
  const checksumMatch = CHECKSUM_PATTERN.exec(block);
  if (!checksumMatch) return "stale";
  const body = block
    .replace(MANAGED_START, "")
    .replace(MANAGED_END, "")
    .replace(/<!--\s*executor-managed-version:\s*\d+\s*-->/, "")
    .replace(CHECKSUM_PATTERN, "")
    .replace(/^\s*\n/, "")
    .trimEnd();
  const expected = createHash("sha256").update(`${body}\n`).digest("hex");
  return expected === checksumMatch[1] ? "satisfied" : "stale";
}

function probePackageInstall(cwd: string, selections: InstallStateSelections): InstallStepState {
  const manifestPath = resolveContained(cwd, "package.json");
  if (!existsSync(manifestPath)) {
    return { stage: "package-install", status: "missing", reason: "No package.json is present to declare the QUBE install." };
  }
  const parsedResult = tryReadJsonFile(manifestPath);
  if (!parsedResult.ok) {
    return { stage: "package-install", status: "missing", reason: "package.json is unreadable or is a symlink." };
  }
  const parsed = parsedResult.value;
  if (!isRecord(parsed)) {
    return { stage: "package-install", status: "missing", reason: "package.json is not a JSON object." };
  }
  if (parsed.name === packageName) {
    return { stage: "package-install", status: "missing", reason: "This working directory is the QUBE package itself, not a consumer install." };
  }
  const declared = declaredPackageVersion(parsed, packageName);
  if (declared !== packageVersion) {
    return { stage: "package-install", status: "missing", reason: `package.json does not declare ${packageName}@${packageVersion}.` };
  }
  for (const adapterName of selectedAdapterPackages(selections)) {
    if (!declaredPackageVersion(parsed, adapterName)) {
      return { stage: "package-install", status: "missing", reason: `Selected adapter ${adapterName} is not declared in package.json.` };
    }
  }
  return { stage: "package-install", status: "satisfied", reason: "The selected QUBE and adapter packages are already declared at the expected versions." };
}

function probeWorkspaceInit(cwd: string, selections: InstallStateSelections): InstallStepState {
  const configPath = resolveContained(cwd, ".qube/aie/config.json");
  if (!existsSync(configPath)) {
    return { stage: "workspace-init", status: "missing", reason: "No .qube/aie/config.json is present." };
  }
  const parsedResult = tryReadJsonFile(configPath);
  if (!parsedResult.ok) {
    return { stage: "workspace-init", status: "missing", reason: ".qube/aie/config.json is unreadable or is a symlink." };
  }
  const parsed = parsedResult.value;
  if (!isRecord(parsed) || parsed.version !== 1) {
    return { stage: "workspace-init", status: "missing", reason: ".qube/aie/config.json is missing or not a current-version config." };
  }
  const targets = instructionTargetsForHosts(selections.hosts);
  let stale = false;
  for (const target of targets) {
    const path = resolveContained(cwd, target);
    if (!existsSync(path)) {
      return { stage: "workspace-init", status: "missing", reason: `Managed instruction file ${target} is missing.` };
    }
    const status = managedSectionStatus(readFileSync(path, "utf8"));
    if (status === "absent") {
      return { stage: "workspace-init", status: "missing", reason: `${target} has no Executor managed section.` };
    }
    if (status === "stale") stale = true;
  }
  if (stale) {
    return { stage: "workspace-init", status: "stale", reason: "A managed instruction section is present but its checksum does not match the section body." };
  }
  return { stage: "workspace-init", status: "satisfied", reason: "Workspace config exists and selected host instruction sections are current." };
}

function probeProviderSetup(cwd: string, selections: InstallStateSelections): InstallStepState {
  const needsGithubLabels = selections.workProviders.includes("github") || selections.ciProviders.includes("github");
  if (!needsGithubLabels) {
    return { stage: "provider-setup", status: "satisfied", reason: "No provider setup command is required for the current selections." };
  }
  const configPath = resolveContained(cwd, ".qube/aie/config.json");
  if (!existsSync(configPath)) {
    return { stage: "provider-setup", status: "missing", reason: "GitHub labels setup still needs a configured workspace." };
  }
  return { stage: "provider-setup", status: "satisfied", reason: "Workspace config is present; GitHub labels setup is already planned as part of a configured repo." };
}

export function probeInstallState(cwd: string, selections: InstallStateSelections): readonly InstallStepState[] {
  const packageInstall = probePackageInstall(cwd, selections);
  const workspaceInit = probeWorkspaceInit(cwd, selections);
  const providerSetup = probeProviderSetup(cwd, selections);
  const earlierSatisfied = packageInstall.status === "satisfied" && workspaceInit.status === "satisfied" && providerSetup.status === "satisfied";
  const verify: InstallStepState = earlierSatisfied
    ? { stage: "verify", status: "satisfied", reason: "Earlier install steps are already satisfied; doctor is not required on this plan." }
    : { stage: "verify", status: "missing", reason: "Doctor still needs to verify the remaining setup delta." };
  return Object.freeze([packageInstall, workspaceInit, providerSetup, verify]);
}
