import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { getAgentHostProfileSync } from "@tjalve/aie";
import { AGENT_HOST_IDS, type AgentHostId } from "@tjalve/qube-core";

import { initRecordPath, readInitRecord } from "./host_toolkit.js";
import { selectedAdapterInstallSpecs } from "./install_packages.js";
import { packageName, packageVersion } from "./package.js";

export type InstallStepStatus = "satisfied" | "stale" | "missing";

export interface InstallStateSelections {
  readonly scope: "local" | "global";
  readonly packageManager: "npm" | "pnpm";
  readonly hosts: readonly string[];
  readonly workProviders: readonly string[];
  readonly ciProviders: readonly string[];
  readonly reviewMode: "external" | "host" | "isolated";
  readonly uiAuditEvidenceRoot: string;
  readonly creditWarning: boolean;
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

export function hostSetupTargets(hosts: readonly string[]): readonly string[] {
  const targets = new Set<string>();
  for (const host of hosts) {
    if (!(AGENT_HOST_IDS as readonly string[]).includes(host)) continue;
    const profile = getAgentHostProfileSync(host as AgentHostId);
    targets.add(profile.instructionTarget.path);
    targets.add(profile.makeItSo.path);
  }
  return [...targets];
}

function normalizeForChecksum(body: string): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n").map(line => line.replace(/[ \t]+$/, ""));
  return `${lines.join("\n").trimEnd()}\n`;
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
  const expected = createHash("sha256").update(normalizeForChecksum(`${body}\n`)).digest("hex");
  return expected === checksumMatch[1] ? "satisfied" : "stale";
}

function installedPackageVersion(root: string, name: string): string | null {
  const path = join(root, "node_modules", ...name.split("/"), "package.json");
  if (!existsSync(path)) return null;
  try {
    if (lstatSync(path).isSymbolicLink()) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) && typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

function globalRoot(packageManager: "npm" | "pnpm"): string | null {
  try {
    const result = spawnSync(packageManager, ["root", "-g"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    const root = result.stdout?.trim();
    return result.status === 0 && root ? root : null;
  } catch {
    return null;
  }
}

function probeGlobalPackageInstall(selections: InstallStateSelections): InstallStepState {
  const root = globalRoot(selections.packageManager);
  if (!root || installedPackageVersion(root, packageName) !== packageVersion) {
    return { stage: "package-install", status: "missing", reason: `${packageName}@${packageVersion} is not installed globally with ${selections.packageManager}.` };
  }
  for (const spec of selectedAdapterInstallSpecs(selections)) {
    if (installedPackageVersion(root, spec.name) !== spec.version) {
      return { stage: "package-install", status: "missing", reason: `Selected adapter ${spec.name}@${spec.version} is not installed globally.` };
    }
  }
  return { stage: "package-install", status: "satisfied", reason: "The selected QUBE and adapter packages are installed globally at the expected versions." };
}

function probePackageInstall(cwd: string, selections: InstallStateSelections): InstallStepState {
  if (selections.scope === "global") return probeGlobalPackageInstall(selections);
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
  const installed = installedPackageVersion(cwd, packageName);
  if (installed !== packageVersion) {
    return { stage: "package-install", status: "missing", reason: `${packageName}@${packageVersion} is declared but not installed in node_modules.` };
  }
  for (const spec of selectedAdapterInstallSpecs(selections)) {
    const declaredAdapter = declaredPackageVersion(parsed, spec.name);
    const installedAdapter = installedPackageVersion(cwd, spec.name);
    if (declaredAdapter !== spec.version || installedAdapter !== spec.version) {
      return { stage: "package-install", status: "missing", reason: `Selected adapter ${spec.name} is not installed at ${spec.version}.` };
    }
  }
  return { stage: "package-install", status: "satisfied", reason: "The selected QUBE and adapter packages are installed at the expected versions." };
}

function probeWorkspaceInit(cwd: string, selections: InstallStateSelections): InstallStepState {
  const recordPath = initRecordPath(cwd);
  const repoRoot = dirname(dirname(recordPath));
  const record = readInitRecord(cwd);
  if (!record) {
    return { stage: "workspace-init", status: "missing", reason: "The effective configuration is invalid or does not provide the required repository setup values." };
  }
  const activeWorkProviders = selections.workProviders[0] ? [selections.workProviders[0]] : [];
  const activeCiProviders = selections.ciProviders[0] ? [selections.ciProviders[0]] : [];
  if (!sameStrings(record.hosts, selections.hosts)) {
    return { stage: "workspace-init", status: "stale", reason: "The configured Agent harnesses do not match the selected harnesses." };
  }
  if (!sameStrings(record.workProviders, activeWorkProviders)) {
    return { stage: "workspace-init", status: "stale", reason: "The configured Issue tracker does not match the first selected work provider." };
  }
  if (!sameStrings(record.ciProviders, activeCiProviders)) {
    return { stage: "workspace-init", status: "stale", reason: "The configured Automated checks provider does not match the first selected CI provider." };
  }
  if (record.review.mode !== selections.reviewMode) {
    return { stage: "workspace-init", status: "stale", reason: "The configured Review source does not match the selected Review source." };
  }

  const targets = hostSetupTargets(selections.hosts);
  let stale = false;
  for (const target of targets) {
    const path = resolveContained(repoRoot, target);
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
  return { stage: "workspace-init", status: "satisfied", reason: "Repository choices and selected Agent harness instructions are current." };
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function probeProviderSetup(cwd: string, selections: InstallStateSelections): InstallStepState {
  const needsGithubLabels = selections.workProviders[0] === "github" || selections.ciProviders[0] === "github";
  if (!needsGithubLabels) {
    return { stage: "provider-setup", status: "satisfied", reason: "No provider setup command is required for the current selections." };
  }
  if (!readInitRecord(cwd)) {
    return { stage: "provider-setup", status: "missing", reason: "GitHub labels setup still needs a valid effective configuration." };
  }
  return { stage: "provider-setup", status: "satisfied", reason: "Effective configuration is present; live GitHub label drift is owned by doctor, not the local install delta." };
}

export function probeInstallState(cwd: string, selections: InstallStateSelections): readonly InstallStepState[] {
  const packageInstall = probePackageInstall(cwd, selections);
  const workspaceInit = probeWorkspaceInit(cwd, selections);
  const providerSetup = probeProviderSetup(cwd, selections);
  const earlierSatisfied = packageInstall.status === "satisfied" && workspaceInit.status === "satisfied";
  const verify: InstallStepState = earlierSatisfied
    ? { stage: "verify", status: "satisfied", reason: "Earlier install steps are already satisfied; doctor is not required on this plan." }
    : { stage: "verify", status: "missing", reason: "Doctor still needs to verify the remaining setup delta." };
  return Object.freeze([packageInstall, workspaceInit, providerSetup, verify]);
}
