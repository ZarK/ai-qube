import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { getAgentHostProfileSync } from "@tjalve/aie";
import { AGENT_HOST_IDS, type AgentHostId } from "@tjalve/qube-core";

import { initRecordPath, parseInitRecord } from "./host_toolkit.js";
import { readQubeInitConfig } from "./init_config.js";
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
  if (!existsSync(recordPath)) {
    return { stage: "workspace-init", status: "missing", reason: "No .qube/init.json repository setup record is present." };
  }
  const recordResult = readQubeInitConfig(recordPath);
  const record = recordResult.status === "valid" ? parseInitRecord(recordResult.config) : null;
  if (!record) {
    return { stage: "workspace-init", status: "missing", reason: ".qube/init.json is unreadable, unsafe, or incomplete." };
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

  const configPath = resolveContained(repoRoot, ".qube/aie/config.json");
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
  const providers = isRecord(parsed.providers) ? parsed.providers : null;
  const work = providers && isRecord(providers.work) ? providers.work : null;
  const ci = providers && isRecord(providers.ci) ? providers.ci : null;
  const reviewProvider = providers && isRecord(providers.review) ? providers.review : null;
  const policy = isRecord(parsed.policy) ? parsed.policy : null;
  const audit = policy && isRecord(policy.audit) ? policy.audit : null;
  const instructions = policy && isRecord(policy.instructions) ? policy.instructions : null;
  const reviews = policy && isRecord(policy.reviews) ? policy.reviews : null;
  if (!work || !ci || !reviewProvider || !audit || !instructions || !reviews) {
    return { stage: "workspace-init", status: "missing", reason: ".qube/aie/config.json does not contain the current provider, Review, audit, and instruction policy." };
  }
  if (work.kind !== selections.workProviders[0]) {
    return { stage: "workspace-init", status: "stale", reason: "Executor is not configured for the first selected Issue tracker." };
  }
  if (ci.kind !== selections.ciProviders[0]) {
    return { stage: "workspace-init", status: "stale", reason: "Executor is not configured for the first selected Automated checks provider." };
  }
  const expectedReviewProvider = selections.workProviders[0] === "gitlab" ? "gitlab" : "github";
  if (reviewProvider.kind !== expectedReviewProvider || reviews.mode !== selections.reviewMode) {
    return { stage: "workspace-init", status: "stale", reason: "Executor Review setup does not match the selected provider and Review source." };
  }
  if (audit.evidenceRoot !== selections.uiAuditEvidenceRoot) {
    return { stage: "workspace-init", status: "stale", reason: "The configured UI audit evidence directory does not match the selected directory." };
  }
  if (instructions.noCreditWarning !== selections.creditWarning) {
    return { stage: "workspace-init", status: "stale", reason: "The configured attribution warning policy does not match the selected policy." };
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
  const repoRoot = dirname(dirname(initRecordPath(cwd)));
  const configPath = resolveContained(repoRoot, ".qube/aie/config.json");
  if (!existsSync(configPath)) {
    return { stage: "provider-setup", status: "missing", reason: "GitHub labels setup still needs a configured workspace." };
  }
  return { stage: "provider-setup", status: "satisfied", reason: "Workspace config is present; live GitHub label drift is owned by doctor, not the local install delta." };
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
