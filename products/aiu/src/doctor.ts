import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { redactStructuredValue, redactText } from "@tjalve/qube-cli/redaction";
import { grokBuildStopHookFile } from "@tjalve/qube-adapter-grok-build";

import { getAiuPackageAssetPaths, getAiuPackageRoot } from "./assets.js";
import {
  type AiuConfigLoadResult,
  type AiuContinuationMode,
  type AiuHost,
  AIU_HOSTS,
  loadAiuConfig,
} from "./config.js";
import {
  createAiuTrustedStateFingerprint,
  readAiuHostActivation,
  resolveAiuContinuationPaths,
  resolveAiuHostActivationPath,
} from "./continuation_store.js";
import { inspectGrokFolderTrust } from "./grok_trust.js";
import { resolveTrustedCommandExecutable } from "./trusted_adapter.js";
import {
  evaluateAiuHostRuntimePolicy,
  getAiuHostCapabilityProfile,
  getAiuHostCapabilityProfiles,
  type AiuHostPromptDelivery,
  type AiuHostSupportLevel,
} from "./host_policy.js";
import { runAiuWhipCommand, type AiuWhipReport } from "./whip.js";

export type AiuHealthStatus = "ok" | "warning" | "error";

export interface AiuInspectionOptions {
  readonly cwd?: string;
  readonly configPath?: string;
}

export interface AiuResolvedPaths {
  readonly packageRoot: string;
  readonly pluginWrapperRelativePath: string;
  readonly package: {
    readonly root: string;
    readonly packageJson: string;
    readonly main?: string;
    readonly types?: string;
    readonly bin: readonly AiuPackageBinPath[];
  };
  readonly config: {
    readonly repoRoot: string;
    readonly selectedPath: string;
    readonly found: boolean;
  };
  readonly state: {
    readonly stateDir: string;
    readonly lockDir: string;
    readonly logDir: string;
  };
  readonly hosts: readonly AiuHostPathSet[];
  readonly trustedCommands: readonly AiuTrustedCommandPath[];
}

export interface AiuPackageBinPath {
  readonly name: string;
  readonly path: string;
}

export interface AiuHostPathSet {
  readonly host: AiuHost;
  readonly enabled: boolean;
  readonly files: readonly AiuHostFilePath[];
}

export interface AiuHostFilePath {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly description: string;
}

export interface AiuTrustedCommandPath {
  readonly sourceId: string;
  readonly executable: string;
  readonly cwd?: string;
  readonly resolvedPath?: string;
  readonly found: boolean;
}

export interface AiuDoctorReport {
  readonly status: AiuHealthStatus;
  readonly summary: {
    readonly ok: number;
    readonly warning: number;
    readonly error: number;
  };
  readonly nodeVersion: string;
  readonly package: {
    readonly name?: string;
    readonly version?: string;
    readonly root: string;
  };
  readonly config: {
    readonly selectedPath: string;
    readonly found: boolean;
    readonly valid: boolean;
    readonly defaultsUsed: boolean;
  };
  readonly paths: AiuResolvedPaths;
  readonly hostProbes: readonly AiuHostContinuationProbe[];
  readonly checks: readonly AiuDoctorCheck[];
}

export type AiuHostProbeState = "active" | "disabled" | "unavailable" | "unverified";

export interface AiuHostContinuationProbe {
  readonly host: AiuHost;
  readonly support: AiuHostSupportLevel;
  readonly probeSupport: AiuHostSupportLevel;
  readonly configured: boolean;
  readonly state: AiuHostProbeState;
  readonly delivery: AiuHostPromptDelivery;
  readonly effectiveDelivery: AiuHostPromptDelivery;
  readonly currentIssueRecovery: boolean;
  readonly activationPath: string;
  readonly observedAt?: string;
  readonly reason: string;
  readonly nextAction: string;
}

export interface AiuDoctorCheck {
  readonly id: string;
  readonly category: "node" | "package" | "repository" | "config" | "host" | "state" | "trusted-command";
  readonly status: AiuHealthStatus;
  readonly kind: string;
  readonly message: string;
  readonly path?: string;
  readonly suggestedNextAction: string;
}

interface PackageJson {
  readonly name?: string;
  readonly version?: string;
  readonly main?: string;
  readonly types?: string;
  readonly bin?: string | Readonly<Record<string, string>>;
}

const HOST_POLICY_DIAGNOSTIC_KINDS = new Set([
  "host-capability-disabled",
  "host-capability-experimental",
  "host-capability-unsupported",
  "host-mode-supported",
  "host-stop-hook-blocking-unsafe",
]);

export function getAiuResolvedPaths(options: AiuInspectionOptions = {}): AiuResolvedPaths {
  return redactRecord(buildAiuResolvedPaths(options) as unknown as Readonly<Record<string, unknown>>) as unknown as AiuResolvedPaths;
}

function buildAiuResolvedPaths(options: AiuInspectionOptions = {}, preloadedConfig?: AiuConfigLoadResult): AiuResolvedPaths {
  const configLoad = preloadedConfig ?? loadAiuConfig(resolveConfigOptions(options));
  const packageRoot = getAiuPackageRoot();
  const packageJson = readPackageJson(packageRoot);
  const assetPaths = getAiuPackageAssetPaths();
  const hosts = getAiuHostCapabilityProfiles(AIU_HOSTS).map((profile) => ({
    host: profile.tool,
    enabled: configLoad.config.hosts.enabled.includes(profile.tool),
    files: profile.managedFiles.map((file) => ({
      relativePath: portablePath(file.relativePath),
      absolutePath: path.join(configLoad.repoRoot, file.relativePath),
      description: file.description,
    })),
  }));

  return {
    packageRoot: assetPaths.packageRoot,
    pluginWrapperRelativePath: assetPaths.pluginWrapperRelativePath,
    package: {
      root: packageRoot,
      packageJson: path.join(packageRoot, "package.json"),
      ...(packageJson.main ? { main: path.join(packageRoot, packageJson.main) } : {}),
      ...(packageJson.types ? { types: path.join(packageRoot, packageJson.types) } : {}),
      bin: readPackageBins(packageRoot, packageJson),
    },
    config: {
      repoRoot: configLoad.repoRoot,
      selectedPath: configLoad.selectedPath,
      found: configLoad.found,
    },
    state: {
      stateDir: path.resolve(configLoad.repoRoot, configLoad.config.paths.stateDir),
      lockDir: path.resolve(configLoad.repoRoot, configLoad.config.paths.lockDir),
      logDir: path.resolve(configLoad.repoRoot, configLoad.config.paths.logDir),
    },
    hosts,
    trustedCommands: resolveTrustedCommandPaths(configLoad),
  };
}

export function runAiuDoctor(options: AiuInspectionOptions = {}): AiuDoctorReport {
  const configLoad = loadAiuConfig(resolveConfigOptions(options));
  const paths = buildAiuResolvedPaths(options, configLoad);
  const packageJson = readPackageJson(paths.package.root);
  const hostProbes = probeAiuHostContinuations(configLoad);
  const checks = [
    checkNodeVersion(),
    ...checkPackage(paths, packageJson),
    checkRepository(configLoad),
    ...checkConfig(configLoad),
    ...checkStatusRuntimePolicy(configLoad),
    ...checkIdleModeDiagnostics(configLoad, paths),
    ...checkHostRuntimePolicy(configLoad),
    ...checkStatePaths(paths),
    ...checkHostFiles(configLoad),
    ...checkHostEntrypoints(configLoad),
    ...checkGrokProjectHookTrust(configLoad),
    ...checkHostContinuationProbes(hostProbes),
    ...checkTrustedCommands(paths),
    ...checkTrustedCommandCompatibility(configLoad),
  ];
  const summary = summarizeChecks(checks);

  return redactRecord({
    status: statusFromSummary(summary),
    summary,
    nodeVersion: process.version,
    package: {
      name: packageJson.name,
      version: packageJson.version,
      root: paths.package.root,
    },
    config: {
      selectedPath: configLoad.selectedPath,
      found: configLoad.found,
      valid: configLoad.ok,
      defaultsUsed: configLoad.defaultsUsed,
    },
    paths,
    hostProbes,
    checks,
  }) as unknown as AiuDoctorReport;
}

export function formatAiuDoctorReport(report: AiuDoctorReport): string {
  const lines = [
    `status: ${report.status}`,
    `nodeVersion: ${report.nodeVersion}`,
    `packageRoot: ${report.package.root}`,
    `config: ${report.config.selectedPath}`,
    `configFound: ${String(report.config.found)}`,
    `configValid: ${String(report.config.valid)}`,
    "",
    "Host continuation probes:",
    ...report.hostProbes.map((probe) => `- ${probe.host}: ${probe.state}. ${probe.reason}`),
    "",
    "Checks:",
    ...report.checks.map((check) => {
      const location = check.path ? ` (${check.path})` : "";
      return `- ${check.status.toUpperCase()} ${check.kind}${location}: ${check.message}`;
    }),
  ];
  return `${lines.join("\n")}\n`;
}

export function formatAiuPaths(paths: AiuResolvedPaths): string {
  const hostLines = paths.hosts.flatMap((host) => host.files.map((file) => `- ${host.host}${host.enabled ? " enabled" : " disabled"}: ${file.absolutePath}`));
  const commandLines = paths.trustedCommands.map((command) => `- ${command.sourceId}: ${command.resolvedPath ?? command.executable}${command.found ? "" : " (missing)"}`);
  return `${[
    `packageRoot: ${paths.packageRoot}`,
    `pluginWrapperRelativePath: ${paths.pluginWrapperRelativePath}`,
    `packageJson: ${paths.package.packageJson}`,
    `configPath: ${paths.config.selectedPath}`,
    `stateDir: ${paths.state.stateDir}`,
    `lockDir: ${paths.state.lockDir}`,
    `logDir: ${paths.state.logDir}`,
    "",
    "Host files:",
    ...(hostLines.length > 0 ? hostLines : ["- none"]),
    "",
    "Trusted commands:",
    ...(commandLines.length > 0 ? commandLines : ["- none"]),
  ].join("\n")}\n`;
}

function resolveConfigOptions(options: AiuInspectionOptions) {
  return options.configPath ? { cwd: options.cwd, configPath: options.configPath } : { cwd: options.cwd };
}

function checkNodeVersion(): AiuDoctorCheck {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (major >= 24) {
    return check("node-version", "node", "ok", "node-version-supported", `Node ${process.version} satisfies >=24.0.0.`, undefined, "Continue using the installed Node runtime.");
  }
  return check("node-version", "node", "error", "node-version-unsupported", `Node ${process.version} does not satisfy >=24.0.0.`, undefined, "Use Node.js 24 or newer before running Umpire.");
}

function checkPackage(paths: AiuResolvedPaths, packageJson: PackageJson): readonly AiuDoctorCheck[] {
  const checks: AiuDoctorCheck[] = [];
  checks.push(pathExistsCheck("package-json", "package", "package-json-missing", "package-json-present", paths.package.packageJson, "Package metadata is readable.", "Build or reinstall the package so package.json is available."));
  if (packageJson.name !== "@tjalve/aiu") {
    checks.push(check("package-name", "package", "error", "package-name-invalid", "Package metadata name is not @tjalve/aiu.", paths.package.packageJson, "Reinstall the expected @tjalve/aiu package."));
  } else {
    checks.push(check("package-name", "package", "ok", "package-name-valid", "Package metadata name is @tjalve/aiu.", paths.package.packageJson, "Continue using this package."));
  }
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    checks.push(check("package-version", "package", "error", "package-version-missing", "Package metadata does not expose a version.", paths.package.packageJson, "Rebuild or reinstall the package."));
  } else {
    checks.push(check("package-version", "package", "ok", "package-version-present", `Package version is ${packageJson.version}.`, paths.package.packageJson, "Continue using this package version."));
  }
  for (const bin of paths.package.bin) {
    checks.push(pathExistsCheck(`package-bin-${bin.name}`, "package", "package-bin-missing", "package-bin-present", bin.path, `Package bin ${bin.name} is present.`, "Run the build or reinstall the package."));
  }
  if (paths.package.main) {
    checks.push(pathExistsCheck("package-main", "package", "package-main-missing", "package-main-present", paths.package.main, "Package main entrypoint is present.", "Run the build or reinstall the package."));
  }
  if (paths.package.types) {
    checks.push(pathExistsCheck("package-types", "package", "package-types-missing", "package-types-present", paths.package.types, "Package type declarations are present.", "Run the build or reinstall the package."));
  }
  return checks;
}

function checkRepository(configLoad: AiuConfigLoadResult): AiuDoctorCheck {
  if (existsSync(path.join(configLoad.repoRoot, ".git"))) {
    return check("repository-root", "repository", "ok", "repository-root-found", "Repository root was discovered.", configLoad.repoRoot, "Continue using this repository root.");
  }
  return check("repository-root", "repository", "warning", "repository-root-not-found", "No .git directory was found while resolving the repository root.", configLoad.repoRoot, "Run aiu from a repository checkout or pass an explicit config path.");
}

function checkConfig(configLoad: AiuConfigLoadResult): readonly AiuDoctorCheck[] {
  const checks: AiuDoctorCheck[] = [];
  const selectedConfigPath = displayConfigPath(configLoad.repoRoot, configLoad.selectedPath);
  checks.push(
    configLoad.found
      ? check("config-present", "config", "ok", "config-present", `${selectedConfigPath} was found.`, configLoad.selectedPath, "Continue using this config file.")
      : check("config-present", "config", "warning", "config-missing", `${selectedConfigPath} was not found; conservative defaults are in use.`, configLoad.selectedPath, "Run aiu init --dry-run --json, then aiu init when the plan is acceptable."),
  );
  checks.push(
    configLoad.ok
      ? check("config-valid", "config", "ok", "config-valid", "Config validation passed.", configLoad.selectedPath, "Continue using this config.")
      : check("config-valid", "config", "error", "config-invalid", "Config validation reported errors.", configLoad.selectedPath, "Fix config diagnostics before relying on Umpire decisions."),
  );
  for (const diagnostic of configLoad.diagnostics.filter((item) => !HOST_POLICY_DIAGNOSTIC_KINDS.has(item.kind))) {
    checks.push(check(`config-${diagnostic.kind}-${diagnostic.path}`, "config", diagnostic.severity === "error" ? "error" : "warning", diagnostic.kind, diagnostic.message, diagnostic.path, diagnostic.suggestedNextAction));
  }
  return checks;
}

function checkStatusRuntimePolicy(configLoad: AiuConfigLoadResult): readonly AiuDoctorCheck[] {
  const checks: AiuDoctorCheck[] = [
    check("status-runtime-fixture-free", "config", "ok", "status-runtime-fixture-free", "Status runtime uses configured trusted state commands and does not require live provider credentials or host runtimes.", configLoad.selectedPath, "Keep tests on deterministic fixtures or local command stubs."),
  ];
  if (configLoad.config.continuation.stopOnUnknownState && configLoad.config.continuation.stopOnUnsafeState) {
    checks.push(check("status-stale-state-policy", "config", "ok", "stale-state-policy-strict", "Continuation policy stops on unknown or unsafe trusted state.", configLoad.selectedPath, "Continue using strict trusted-state policy."));
  } else {
    checks.push(check("status-stale-state-policy", "config", "warning", "stale-state-policy-relaxed", "Continuation policy allows unknown or unsafe trusted state.", configLoad.selectedPath, "Enable strict continuation policy before relying on autonomous status decisions."));
  }
  return checks;
}

function checkIdleModeDiagnostics(configLoad: AiuConfigLoadResult, paths: AiuResolvedPaths): readonly AiuDoctorCheck[] {
  return [
    ...checkModeReadiness("planning", configLoad.config.planning.enabled, paths, configLoad.selectedPath),
    ...checkModeReadiness("quality", configLoad.config.quality.enabled, paths, configLoad.selectedPath),
    ...checkWhipReadiness(configLoad),
  ];
}

function checkModeReadiness(mode: "planning" | "quality", enabled: boolean, paths: AiuResolvedPaths, configPath: string): readonly AiuDoctorCheck[] {
  const checks: AiuDoctorCheck[] = [];
  checks.push(enabled
    ? check(`${mode}-mode-enabled`, "config", "ok", `${mode}-mode-enabled`, `${mode} idle mode is enabled.`, configPath, `Configure a trusted ${mode} state command before relying on ${mode} continuation.`)
    : check(`${mode}-mode-disabled`, "config", "ok", `${mode}-mode-disabled`, `${mode} idle mode is disabled.`, configPath, `Set ${mode}.enabled to true only after trusted ${mode} state is configured.`));
  if (!enabled) {
    return checks;
  }

  const commands = paths.trustedCommands.filter((command) => command.sourceId === mode);
  if (commands.length === 0) {
    checks.push(check(`${mode}-trusted-command-configured`, "trusted-command", "warning", `${mode}-trusted-command-missing`, `No configured trusted state command is named for ${mode} state.`, configPath, `Add a deterministic trustedStateCommands entry for ${mode} state or disable ${mode}.enabled.`));
    return checks;
  }
  for (const command of commands) {
    checks.push(command.found
      ? check(`${mode}-trusted-command-${command.sourceId}`, "trusted-command", "ok", `${mode}-trusted-command-found`, `Trusted ${mode} command ${command.sourceId} executable is available.`, command.resolvedPath ?? command.executable, `Continue using this trusted ${mode} command descriptor.`)
      : check(`${mode}-trusted-command-${command.sourceId}`, "trusted-command", "error", `${mode}-trusted-command-missing`, `Trusted ${mode} command ${command.sourceId} executable is not available.`, command.executable, `Install the executable, update the trusted command argv descriptor, or disable ${mode}.enabled.`));
  }
  return checks;
}

function checkWhipReadiness(configLoad: AiuConfigLoadResult): readonly AiuDoctorCheck[] {
  if (!configLoad.config.whip.enabled) {
    return [
      check("whip-mode-disabled", "config", "ok", "whip-mode-disabled", "Whip idle mode is disabled.", configLoad.selectedPath, "Existing whip state is preserved; enable whip only when idle tasks are desired."),
    ];
  }
  const report = runAiuWhipCommand({
    action: "status",
    repoRoot: configLoad.repoRoot,
    config: configLoad.config,
  });
  const checks: AiuDoctorCheck[] = [
    report.stateOk
      ? check("whip-state-valid", "state", "ok", "whip-state-valid", "Whip state is readable and schema-valid.", report.statePath, "Continue using this whip state path.")
      : check("whip-state-valid", "state", "error", "whip-state-malformed", "Whip state is malformed.", report.statePath, "Fix or remove the malformed whip state file before relying on idle whip prompts."),
  ];
  if (report.staleOwnership.length > 0) {
    checks.push(check("whip-stale-ownership", "state", "warning", "whip-stale-ownership", `Whip state has ${report.staleOwnership.length} stale prompted task owner(s).`, report.statePath, "Inspect aiu whip status and explicitly cancel, complete, or reassign stale prompted tasks."));
  } else {
    checks.push(check("whip-stale-ownership", "state", "ok", "whip-ownership-current", "No stale whip task ownership was found.", report.statePath, "Continue using explicit whip task transitions."));
  }
  const orphaned = findOrphanedWhipOwnership(report);
  if (orphaned.length > 0) {
    checks.push(check("whip-orphaned-ownership", "state", "warning", "whip-orphaned-ownership", `Whip state has ${orphaned.length} prompted task owner(s) without a selected session.`, report.statePath, "Inspect aiu whip status and clear or complete orphaned prompted tasks explicitly."));
  } else {
    checks.push(check("whip-orphaned-ownership", "state", "ok", "whip-ownership-linked", "No orphaned whip task ownership was found.", report.statePath, "Continue using explicit whip task ownership."));
  }
  return checks;
}

function findOrphanedWhipOwnership(report: AiuWhipReport): readonly string[] {
  return report.tasks
    .filter((task) => task.status === "prompted" && Boolean(task.ownerSessionId) && !task.selectedSessionId)
    .map((task) => task.id);
}

function checkHostRuntimePolicy(configLoad: AiuConfigLoadResult): readonly AiuDoctorCheck[] {
  const report = evaluateAiuHostRuntimePolicy(configLoad.config.hosts, configLoad.config.continuation.modes);
  const checks: AiuDoctorCheck[] = [];
  if (report.enabledHosts.length === 0) {
    checks.push(
      check("host-runtime-none", "host", "warning", "host-runtime-disabled", "No host integrations are enabled.", configLoad.selectedPath, "Run aiu init --dry-run --json for the host you intend to use."),
    );
  }
  const modeChecks = report.modeChecks.map((item) =>
      check(
        `host-policy-${item.host}-${item.mode}`,
        "host",
        item.status,
        item.kind,
        item.message,
        configLoad.selectedPath,
        item.suggestedNextAction,
      ),
    );
  const stopHookChecks = (Object.entries(configLoad.config.hosts.stopHookBlocking) as Array<[AiuHost, boolean]>).flatMap(([host, blocking]) => {
    const profile = report.profiles.find((item) => item.tool === host);
    if (!blocking || profile?.stopHook.blocksByDefault === true) {
      return [];
    }
    return [
      check(`host-stop-hook-blocking-${host}`, "host", "error", "host-stop-hook-blocking-unsafe", `${host} stop-hook blocking is not supported by the current runtime profile.`, configLoad.selectedPath, `Set hosts.stopHookBlocking.${host} to false until M3 stop-hook blocking is fully wired.`),
    ];
  });
  return [...checks, ...modeChecks, ...stopHookChecks];
}

function checkStatePaths(paths: AiuResolvedPaths): readonly AiuDoctorCheck[] {
  return Object.entries(paths.state).map(([name, target]) => checkWritableDirectoryPath(`state-${name}`, target, name));
}

function checkHostFiles(configLoad: AiuConfigLoadResult): readonly AiuDoctorCheck[] {
  return getAiuHostCapabilityProfiles(configLoad.config.hosts.enabled).flatMap((profile) =>
    profile.managedFiles.map((file) => {
      const absolutePath = path.join(configLoad.repoRoot, file.relativePath);
      if (!existsSync(absolutePath)) {
        return check(`host-${profile.tool}-${file.relativePath}`, "host", "warning", "host-file-missing", `${profile.tool} managed host file is not installed.`, absolutePath, `Run aiu init --tool ${profile.tool} after reviewing the dry-run plan.`);
      }
      try {
        const existing = readFileSync(absolutePath, "utf8");
        if (normalizeText(existing) === normalizeText(file.content)) {
          return check(`host-${profile.tool}-${file.relativePath}`, "host", "ok", "host-file-managed", `${profile.tool} managed host file matches package content.`, absolutePath, "Continue using the managed host file.");
        }
        return check(`host-${profile.tool}-${file.relativePath}`, "host", "warning", "host-file-unmanaged", `${profile.tool} host file exists but differs from package-managed content.`, absolutePath, "Review the file and rerun aiu init --force only if replacement is intentional.");
      } catch (error) {
        return check(`host-${profile.tool}-${file.relativePath}`, "host", "error", "host-file-unreadable", `${profile.tool} host file could not be read: ${error instanceof Error ? error.message : String(error)}`, absolutePath, "Fix file permissions before relying on host integration.");
      }
    }),
  );
}

function checkHostEntrypoints(configLoad: AiuConfigLoadResult): readonly AiuDoctorCheck[] {
  return getAiuHostCapabilityProfiles(configLoad.config.hosts.enabled).flatMap((profile) =>
    profile.managedFiles.flatMap((file) => {
      const expectedMarker = packageBackedEntrypointMarker(profile.tool, file.relativePath);
      if (!expectedMarker) {
        return [];
      }
      const absolutePath = path.join(configLoad.repoRoot, file.relativePath);
      if (!existsSync(absolutePath)) {
        return [];
      }
      try {
        const existing = readFileSync(absolutePath, "utf8");
        if (existing.includes(expectedMarker)) {
          return [
            check(`host-entrypoint-${profile.tool}-${file.relativePath}`, "host", "ok", "host-entrypoint-package-backed", `${profile.tool} host entrypoint delegates to the package-backed runtime.`, absolutePath, "Continue using the package-managed host entrypoint."),
          ];
        }
        return [
          check(`host-entrypoint-${profile.tool}-${file.relativePath}`, "host", "warning", "host-entrypoint-unmanaged", `${profile.tool} host entrypoint does not delegate to the package-backed runtime.`, absolutePath, "Replace copied helper logic with the package-managed entrypoint from aiu init."),
        ];
      } catch (error) {
        return [
          check(`host-entrypoint-${profile.tool}-${file.relativePath}`, "host", "error", "host-entrypoint-unreadable", `${profile.tool} host entrypoint could not be read: ${error instanceof Error ? error.message : String(error)}`, absolutePath, "Fix file permissions before relying on host integration."),
        ];
      }
    }),
  );
}

function packageBackedEntrypointMarker(host: AiuHost, relativePath: string): string | undefined {
  if (host === "opencode" && relativePath.endsWith(path.join(".opencode", "plugins", "ai-umpire-continuation.ts"))) {
    return "@tjalve/aiu/opencode";
  }
  if (host === "codex" && relativePath.endsWith("hooks.json")) {
    return `pnpm exec aiu hook-stop --tool ${host}`;
  }
  if (host === "claude-code" && relativePath.endsWith(path.join(".claude", "settings.json"))) {
    return `pnpm exec aiu hook-stop --tool ${host}`;
  }
  const grokHookPath = grokBuildStopHookFile.relativePath;
  if (host === "grok-build" && relativePath.replaceAll("\\", "/").endsWith(grokHookPath)) {
    return `pnpm exec aiu hook-stop --tool ${host}`;
  }
  return undefined;
}

function checkGrokProjectHookTrust(configLoad: AiuConfigLoadResult): readonly AiuDoctorCheck[] {
  if (!configLoad.config.hosts.enabled.includes("grok-build")) {
    return [];
  }
  const relativePath = grokBuildStopHookFile.relativePath;
  const absolutePath = path.join(configLoad.repoRoot, relativePath);
  if (!existsSync(absolutePath)) {
    return [];
  }
  const trust = inspectGrokFolderTrust(configLoad.repoRoot);
  if (trust.trusted) {
    return [
      check("grok-hook-trusted", "host", "ok", "grok-hook-trusted", "Grok Build project Stop hook is present and the folder is trusted.", trust.trustFile, "Continue using the trusted project hook."),
    ];
  }
  return [
    check("grok-hook-untrusted", "host", "warning", "grok-hook-untrusted", "Grok Build project Stop hook is present but the folder is not trusted. Untrusted project hooks do not run.", trust.trustFile, "Run /hooks-trust in Grok Build, or start with --trust, then rerun aiu doctor --json."),
  ];
}

function probeAiuHostContinuations(configLoad: AiuConfigLoadResult): readonly AiuHostContinuationProbe[] {
  const continuationPaths = resolveAiuContinuationPaths(configLoad.repoRoot, configLoad.config);
  const runtimePolicy = evaluateAiuHostRuntimePolicy(configLoad.config.hosts, configLoad.config.continuation.modes);
  return Object.freeze(AIU_HOSTS.map((host) => {
    const profile = getAiuHostCapabilityProfile(host);
    const configured = configLoad.config.hosts.enabled.includes(host);
    const delivery = profile.capabilities.promptDelivery.delivery ?? "none";
    const activationPath = resolveAiuHostActivationPath(continuationPaths, host);
    const base = {
      host,
      support: profile.supportLevel,
      probeSupport: profile.probe.support,
      configured,
      delivery,
      activationPath,
    } as const;

    if (!configured) {
      return hostProbe(base, "disabled", "none", false, `${host} continuation is not enabled in this repository.`, `Run aiu init --tool ${host} if this harness should use Umpire continuation.`);
    }
    if (profile.supportLevel === "unsupported" || profile.probe.support === "unsupported" || !profile.currentIssueRecovery || delivery === "none") {
      return hostProbe(base, "unavailable", "none", false, `${host} does not provide current-issue recovery through its canonical host profile.`, "Use a harness with supported Umpire continuation.");
    }
    if (!configLoad.ok) {
      return hostProbe(base, "unavailable", "none", false, `${host} continuation cannot run because the Umpire config is invalid.`, "Fix the reported config errors, then rerun aiu doctor --json.");
    }

    const configuredModes = configLoad.config.hosts.modes[host] ?? configLoad.config.continuation.modes;
    const recoveryModes = new Set<AiuContinuationMode>(configuredModes.filter((mode) => mode === "continue" || mode === "repair"));
    if (recoveryModes.size === 0) {
      return hostProbe(base, "disabled", "none", false, `${host} is configured to stop without current-issue recovery.`, `Add continue or repair to hosts.modes.${host} to enable current-issue recovery.`);
    }
    const policyError = runtimePolicy.errors.find((item) => item.host === host && recoveryModes.has(item.mode));
    if (policyError) {
      return hostProbe(base, "unavailable", "none", false, policyError.message, policyError.suggestedNextAction);
    }
    if (!managedHostFilesAreCurrent(configLoad.repoRoot, profile.managedFiles)) {
      return hostProbe(base, "unavailable", "none", false, `${host} managed integration files are missing or differ from the package content.`, `Review the file diagnostics, then run aiu init --tool ${host}.`);
    }
    if (host === "grok-build" && !inspectGrokFolderTrust(configLoad.repoRoot).trusted) {
      return hostProbe(base, "unverified", "none", false, "Grok Build has not trusted the managed project Stop hook.", "Run /hooks-trust in Grok Build, trigger one Stop event, then rerun aiu doctor --json.");
    }

    const trustedCommands = resolveTrustedCommandPaths(configLoad);
    if (trustedCommands.length === 0) {
      return hostProbe(base, "unavailable", "none", false, `${host} has no trusted state command for current-issue recovery.`, "Run aiu init for this repository, then rerun aiu doctor --json.");
    }
    const missingCommand = trustedCommands.find((command) => !command.found);
    if (missingCommand) {
      return hostProbe(base, "unavailable", "none", false, `${host} cannot run trusted state command ${missingCommand.sourceId} because ${missingCommand.executable} is unavailable.`, "Install the executable or update the trusted command argv descriptor, then rerun aiu doctor --json.");
    }

    const activation = readAiuHostActivation(continuationPaths, host);
    if (!activation || activation.delivery !== delivery) {
      const trustSteps = profile.trustSteps.join(" ");
      const nextAction = trustSteps
        ? `${trustSteps} Then start a new ${host} session, let the managed integration handle one event, and rerun aiu doctor --json.`
        : `Start a new ${host} session, let the managed integration handle one event, and rerun aiu doctor --json.`;
      return hostProbe(base, "unverified", "none", false, `${host} managed files are ready, but this integration has not been observed running.`, nextAction);
    }
    const trustedStateFingerprint = createAiuTrustedStateFingerprint(configLoad.config.trustedStateCommands);
    if (activation.trustedStateFingerprint !== trustedStateFingerprint) {
      return hostProbe(base, "unverified", "none", false, `${host} has not verified the current trusted state command configuration.`, `Start a new ${host} session, let the managed integration handle one event, and rerun aiu doctor --json.`);
    }

    return hostProbe(
      base,
      "active",
      delivery,
      true,
      `${host} continuation was observed through the managed ${activation.event === "stop-hook" ? "Stop hook" : "plugin"}.`,
      "No action is required.",
      activation.observedAt,
    );
  }));
}

function managedHostFilesAreCurrent(repoRoot: string, files: readonly { readonly relativePath: string; readonly content: string }[]): boolean {
  return files.length > 0 && files.every((file) => {
    try {
      return normalizeText(readFileSync(path.join(repoRoot, file.relativePath), "utf8")) === normalizeText(file.content);
    } catch {
      return false;
    }
  });
}

function hostProbe(
  base: Pick<AiuHostContinuationProbe, "host" | "support" | "probeSupport" | "configured" | "delivery" | "activationPath">,
  state: AiuHostProbeState,
  effectiveDelivery: AiuHostPromptDelivery,
  currentIssueRecovery: boolean,
  reason: string,
  nextAction: string,
  observedAt?: string,
): AiuHostContinuationProbe {
  return Object.freeze({
    ...base,
    state,
    effectiveDelivery,
    currentIssueRecovery,
    ...(observedAt ? { observedAt } : {}),
    reason,
    nextAction,
  });
}

function checkHostContinuationProbes(probes: readonly AiuHostContinuationProbe[]): readonly AiuDoctorCheck[] {
  return probes.filter((probe) => probe.configured).map((probe) => {
    const status: AiuHealthStatus = probe.state === "active" || probe.state === "disabled"
      ? "ok"
      : probe.state === "unverified"
        ? "warning"
        : "error";
    return check(
      `host-continuation-${probe.host}`,
      "host",
      status,
      `host-continuation-${probe.state}`,
      probe.reason,
      probe.activationPath,
      probe.nextAction,
    );
  });
}

function checkTrustedCommands(paths: AiuResolvedPaths): readonly AiuDoctorCheck[] {
  return paths.trustedCommands.map((command) => {
    if (command.found) {
      return check(`trusted-command-${command.sourceId}`, "trusted-command", "ok", "trusted-command-found", `Trusted command ${command.sourceId} executable is available.`, command.resolvedPath ?? command.executable, "Continue using this trusted command descriptor.");
    }
    return check(`trusted-command-${command.sourceId}`, "trusted-command", "error", "trusted-command-missing", `Trusted command ${command.sourceId} executable is not available.`, command.executable, "Install the executable or update the trusted command argv descriptor.");
  });
}

function checkTrustedCommandCompatibility(configLoad: AiuConfigLoadResult): readonly AiuDoctorCheck[] {
  return Object.entries(configLoad.config.trustedStateCommands).map(([sourceId, descriptor]) => {
    return check(`trusted-command-compatible-${sourceId}`, "trusted-command", "ok", "trusted-command-compatible", `Trusted command ${sourceId} normalized descriptor is adapter-compatible.`, configLoad.selectedPath, "Continue using this trusted state adapter descriptor.");
  });
}

function checkWritableDirectoryPath(id: string, targetPath: string, name: string): AiuDoctorCheck {
  try {
    if (existsSync(targetPath)) {
      const stat = statSync(targetPath);
      if (!stat.isDirectory()) {
        return check(id, "state", "error", "state-path-not-directory", `${name} resolves to a file, not a directory.`, targetPath, "Choose a directory path for Umpire state.");
      }
      accessSync(targetPath, constants.W_OK | constants.X_OK);
      return check(id, "state", "ok", "state-path-writable", `${name} is writable.`, targetPath, "Continue using this state path.");
    }
    accessSync(findExistingDirectoryAncestor(targetPath), constants.W_OK | constants.X_OK);
    return check(id, "state", "ok", "state-path-creatable", `${name} can be created by Umpire when needed.`, targetPath, "Continue using this state path.");
  } catch (error) {
    return check(id, "state", "error", "state-path-not-writable", `${name} is not writable or cannot be created: ${error instanceof Error ? error.message : String(error)}`, targetPath, "Choose a writable repository-local path or fix directory permissions.");
  }
}

function resolveTrustedCommandPaths(configLoad: AiuConfigLoadResult): readonly AiuTrustedCommandPath[] {
  return Object.entries(configLoad.config.trustedStateCommands).map(([sourceId, descriptor]) => {
    const executable = descriptor.argv[0];
    const cwd = descriptor.cwd ? path.resolve(configLoad.repoRoot, descriptor.cwd) : configLoad.repoRoot;
    const resolvedPath = resolveTrustedCommandExecutable(executable, cwd);
    return {
      sourceId,
      executable,
      ...(descriptor.cwd ? { cwd } : {}),
      ...(resolvedPath ? { resolvedPath } : {}),
      found: resolvedPath !== undefined,
    };
  });
}

function pathExistsCheck(
  id: string,
  category: AiuDoctorCheck["category"],
  missingKind: string,
  presentKind: string,
  targetPath: string,
  presentMessage: string,
  missingNextAction: string,
): AiuDoctorCheck {
  if (existsSync(targetPath)) {
    return check(id, category, "ok", presentKind, presentMessage, targetPath, "Continue using this path.");
  }
  return check(id, category, "error", missingKind, `${targetPath} does not exist.`, targetPath, missingNextAction);
}

function readPackageJson(packageRoot: string): PackageJson {
  try {
    return JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as PackageJson;
  } catch {
    return {};
  }
}

function readPackageBins(packageRoot: string, packageJson: PackageJson): readonly AiuPackageBinPath[] {
  if (typeof packageJson.bin === "string") {
    return [{ name: "aiu", path: path.join(packageRoot, packageJson.bin) }];
  }
  if (packageJson.bin && typeof packageJson.bin === "object") {
    return Object.entries(packageJson.bin).map(([name, binPath]) => ({ name, path: path.join(packageRoot, binPath) }));
  }
  return [];
}

function summarizeChecks(checks: readonly AiuDoctorCheck[]): AiuDoctorReport["summary"] {
  return Object.freeze({
    ok: checks.filter((checkItem) => checkItem.status === "ok").length,
    warning: checks.filter((checkItem) => checkItem.status === "warning").length,
    error: checks.filter((checkItem) => checkItem.status === "error").length,
  });
}

function statusFromSummary(summary: AiuDoctorReport["summary"]): AiuHealthStatus {
  if (summary.error > 0) return "error";
  if (summary.warning > 0) return "warning";
  return "ok";
}

function check(
  id: string,
  category: AiuDoctorCheck["category"],
  status: AiuHealthStatus,
  kind: string,
  message: string,
  targetPath: string | undefined,
  suggestedNextAction: string,
): AiuDoctorCheck {
  return Object.freeze({
    id: redactText(id),
    category,
    status,
    kind,
    message: redactText(message),
    ...(targetPath ? { path: redactText(targetPath) } : {}),
    suggestedNextAction: redactText(suggestedNextAction),
  });
}

function redactRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return redactStructuredValue(value);
}

function findExistingDirectoryAncestor(targetPath: string): string {
  let current = targetPath;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return parent;
    }
    current = parent;
  }
  const stat = statSync(current);
  if (!stat.isDirectory()) {
    throw new Error(`Existing ancestor is not a directory: ${current}`);
  }
  return current;
}

function canAccess(targetPath: string, mode: number): boolean {
  try {
    accessSync(targetPath, mode);
    return true;
  } catch {
    return false;
  }
}

function isExecutableFile(targetPath: string): boolean {
  try {
    const stat = statSync(targetPath);
    if (!stat.isFile()) {
      return false;
    }
    if (process.platform !== "win32") {
      return canAccess(targetPath, constants.X_OK);
    }
    const executableExtensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .map((extension) => extension.trim().toUpperCase())
      .filter((extension) => extension.length > 0);
    return executableExtensions.includes(path.extname(targetPath).toUpperCase());
  } catch {
    return false;
  }
}

function portablePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function displayConfigPath(repoRoot: string, selectedPath: string): string {
  const relativePath = path.relative(repoRoot, selectedPath);
  if (relativePath.length === 0 || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return portablePath(selectedPath);
  }
  return portablePath(relativePath);
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n");
}
