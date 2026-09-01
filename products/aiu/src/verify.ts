import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomInt, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveExecutable } from "@tjalve/qube-core";

import { getAiuPackageRoot } from "./assets.js";
import { type AiuConfig, type AiuHost, loadAiuConfig } from "./config.js";
import { getAiuContinuationAdapter, getAiuRuntimeHostProfile } from "./continuation_adapters.js";
import {
  createAiuTrustedStateFingerprint,
  readAiuContinuationState,
  resolveAiuContinuationPaths,
  writeAiuHostActivation,
  type AiuHostActivation,
} from "./continuation_store.js";
import { getAiuHostCapabilityProfile } from "./host_policy.js";
import { getAiuPackageVersion } from "./package_metadata.js";

export const AIU_VERIFICATION_SCHEMA_VERSION = 1 as const;
export const AIU_VERIFICATION_CONTRACT_VERSION = 1 as const;

export type AiuVerificationStatus = "passed" | "blocked" | "failed" | "aborted";
export type AiuVerificationReasonCode =
  | "verification-passed"
  | "missing-executable"
  | "unsupported-version"
  | "authentication-missing"
  | "trust-prerequisite-unmet"
  | "model-unavailable"
  | "packed-artifact-required"
  | "workspace-setup-failed"
  | "native-response-invalid"
  | "native-timeout"
  | "user-aborted"
  | "continuation-not-consumed"
  | "next-turn-not-observed"
  | "allow-path-continued"
  | "evidence-write-failed";

export interface AiuVerificationDiscovery {
  readonly executablePath: string;
  readonly executableIdentity: string;
  readonly harnessVersion: string;
  readonly surface: string;
  readonly authentication: "ready";
  readonly repositoryTrust: "required" | "not-required";
  readonly model: string | null;
}

export interface AiuVerificationScenario {
  readonly kind: "continue" | "allow";
  readonly status: "passed" | "failed" | "aborted";
  readonly reasonCode: AiuVerificationReasonCode;
  readonly nativeInvocationObserved: boolean;
  readonly responseConsumed: boolean;
  readonly nextTurnObserved: boolean;
  readonly continuationCount: number;
  readonly observedDeliveryState?: "none" | "reserved" | "emitted" | "consumed";
  readonly diagnostic?: string;
  readonly sessionId?: string;
}

export interface AiuVerificationWorkspaceSummary {
  readonly disposable: true;
  readonly packed: true;
  readonly packedArtifactDigest: string;
  readonly managedAssetDigest: string;
  readonly relevantConfigDigest: string;
  readonly trustedStateFingerprint: string;
}

export interface AiuVerificationReport {
  readonly schemaVersion: typeof AIU_VERIFICATION_SCHEMA_VERSION;
  readonly contractVersion: typeof AIU_VERIFICATION_CONTRACT_VERSION;
  readonly tool: AiuHost;
  readonly status: AiuVerificationStatus;
  readonly reasonCode: AiuVerificationReasonCode;
  readonly warning: string;
  readonly observedAt: string;
  readonly discovery?: AiuVerificationDiscovery;
  readonly workspace?: AiuVerificationWorkspaceSummary;
  readonly scenarios: readonly AiuVerificationScenario[];
  readonly evidencePath?: string;
  readonly nextAction: string;
}

export interface AiuVerifyOptions {
  readonly tool: AiuHost;
  readonly cwd?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly observedAt?: string;
  readonly onWarning?: (warning: string) => void;
  readonly runtime?: AiuVerificationRuntime;
}

export interface AiuPreparedVerification {
  readonly root: string;
  readonly aiuEntry: string;
  readonly modePath: string;
  readonly markerPath: string;
  readonly tokenPath: string;
  readonly commandPath: string;
  readonly packedArtifactDigest: string;
  readonly managedAssetDigest: string;
  readonly relevantConfigDigest: string;
  readonly trustedStateFingerprint: string;
  readonly config: AiuConfig;
}

export interface AiuVerificationRuntime {
  discover(input: { readonly tool: AiuHost; readonly cwd: string; readonly model?: string }): AiuVerificationDiscovery | AiuVerificationBlocked;
  prepare(input: { readonly tool: AiuHost; readonly cwd: string; readonly discovery: AiuVerificationDiscovery }): AiuPreparedVerification | AiuVerificationBlocked;
  runScenario(input: {
    readonly tool: AiuHost;
    readonly discovery: AiuVerificationDiscovery;
    readonly workspace: AiuPreparedVerification;
    readonly kind: "continue" | "allow";
    readonly timeoutMs: number;
  }): AiuVerificationScenario;
  cleanup(workspace: AiuPreparedVerification): void;
}

interface AiuVerificationBlocked {
  readonly status: "blocked" | "failed" | "aborted";
  readonly reasonCode: AiuVerificationReasonCode;
  readonly nextAction: string;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const OUTPUT_LIMIT = 4 * 1024 * 1024;
const FREE_OPENCODE_MODEL = /(?:^opencode\/.*free$|[-/:]free(?:[-/:]|$))/iu;

export async function runAiuVerify(options: AiuVerifyOptions): Promise<AiuVerificationReport> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const observedAt = options.observedAt ?? new Date().toISOString();
  const warning = `Verification launches ${options.tool} in a disposable repository and can use a model or incur cost. QUBE will not install, authenticate, or trust the harness.`;
  options.onWarning?.(warning);
  const runtime = options.runtime ?? defaultAiuVerificationRuntime;
  const discovery = runtime.discover({ tool: options.tool, cwd, ...(options.model ? { model: options.model } : {}) });
  if (isBlocked(discovery)) return reportFromBlock(options.tool, observedAt, warning, discovery);

  const prepared = runtime.prepare({ tool: options.tool, cwd, discovery });
  if (isBlocked(prepared)) return reportFromBlock(options.tool, observedAt, warning, prepared, discovery);
  try {
    const allow = runtime.runScenario({ tool: options.tool, discovery, workspace: prepared, kind: "allow", timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    if (allow.status !== "passed") return reportFromScenario(options.tool, observedAt, warning, discovery, prepared, [allow], allow);
    const continuation = runtime.runScenario({ tool: options.tool, discovery, workspace: prepared, kind: "continue", timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    if (continuation.status !== "passed") return reportFromScenario(options.tool, observedAt, warning, discovery, prepared, [allow, continuation], continuation);

    const configLoad = loadAiuConfig({ cwd });
    const evidence = buildActivationEvidence(options.tool, discovery, prepared, continuation, observedAt);
    try {
      writeAiuHostActivation(resolveAiuContinuationPaths(configLoad.repoRoot, configLoad.config), evidence);
    } catch {
      return reportFromBlock(options.tool, observedAt, warning, {
        status: "failed",
        reasonCode: "evidence-write-failed",
        nextAction: "Fix the configured Umpire state path, then rerun the explicit verification command.",
      }, discovery, prepared, [allow, continuation]);
    }
    return Object.freeze({
      schemaVersion: AIU_VERIFICATION_SCHEMA_VERSION,
      contractVersion: AIU_VERIFICATION_CONTRACT_VERSION,
      tool: options.tool,
      status: "passed",
      reasonCode: "verification-passed",
      warning,
      observedAt,
      discovery,
      workspace: workspaceSummary(prepared),
      scenarios: Object.freeze([allow, continuation]),
      evidencePath: path.resolve(resolveAiuContinuationPaths(configLoad.repoRoot, configLoad.config).stateDir, "host-activation", `${options.tool}.json`),
      nextAction: "Rerun aiu doctor --json to inspect compatible consumed continuation evidence.",
    });
  } finally {
    runtime.cleanup(prepared);
  }
}

export function createAiuRelevantConfigDigest(config: AiuConfig, host: AiuHost): string {
  return digestJson({
    host,
    enabled: config.hosts.enabled.includes(host),
    capabilities: config.hosts.capabilities[host] ?? {},
    modes: config.hosts.modes[host] ?? config.continuation.modes,
    stopHookBlocking: config.hosts.stopHookBlocking[host] ?? false,
    continuation: config.continuation,
    timeouts: config.timeouts,
    cooldowns: config.cooldowns,
    paths: config.paths,
  });
}

export function createAiuManagedAssetDigest(host: AiuHost, repoRoot?: string): string {
  const files = getAiuHostCapabilityProfile(host, repoRoot).managedFiles;
  return digestJson(files.map((file) => ({
    id: file.id,
    relativePath: file.relativePath.split(path.sep).join("/"),
    role: file.role,
    ownership: file.ownership,
    content: normalizeText(file.content),
  })));
}

export function activationMatchesCurrentConfiguration(input: {
  readonly activation: AiuHostActivation;
  readonly config: AiuConfig;
  readonly repoRoot: string;
  readonly harnessVersion?: string;
}): boolean {
  const adapter = getAiuContinuationAdapter(input.activation.host);
  const surface = adapter.declaration.nativeSurfaces[0]?.id;
  return input.activation.contractVersion === AIU_VERIFICATION_CONTRACT_VERSION
    && input.activation.eventState === "consumed"
    && input.activation.surface === surface
    && input.activation.managedAssetDigest === createAiuManagedAssetDigest(input.activation.host, input.repoRoot)
    && input.activation.relevantConfigDigest === createAiuRelevantConfigDigest(input.config, input.activation.host)
    && input.activation.trustedStateFingerprint === createAiuTrustedStateFingerprint(input.config.trustedStateCommands)
    && (input.harnessVersion === undefined || input.activation.harnessVersion === input.harnessVersion);
}

export function readAiuHarnessVersion(host: AiuHost, cwd = process.cwd()): string | undefined {
  const profile = getAiuRuntimeHostProfile(host);
  const candidates = process.platform === "win32"
    ? [...profile.executables.windowsNames, ...profile.executables.names]
    : [...profile.executables.names];
  const executable = candidates.map((name) => resolveExecutable(name)).find((candidate) => candidate.status === "found" && candidate.resolvedPath);
  if (!executable?.resolvedPath) return undefined;
  const result = runCommand(executable.resolvedPath, ["--version"], cwd, 10_000);
  return result.status === 0 ? parseVersion(`${result.stdout}\n${result.stderr}`) : undefined;
}

const defaultAiuVerificationRuntime: AiuVerificationRuntime = Object.freeze({
  discover: discoverHost,
  prepare: prepareWorkspace,
  runScenario: runNativeScenario,
  cleanup(workspace: AiuPreparedVerification) {
    try {
      rmSync(workspace.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // A failed cleanup must not replace the native verification result.
    }
  },
});

function discoverHost(input: { readonly tool: AiuHost; readonly cwd: string; readonly model?: string }): AiuVerificationDiscovery | AiuVerificationBlocked {
  const profile = getAiuRuntimeHostProfile(input.tool);
  const candidates = process.platform === "win32"
    ? [...profile.executables.windowsNames, ...profile.executables.names]
    : [...profile.executables.names];
  const executable = candidates.map((name) => resolveExecutable(name)).find((candidate) => candidate.status === "found" && candidate.resolvedPath);
  if (!executable?.resolvedPath) return blocked("missing-executable", `Install ${profile.displayName} outside QUBE and expose its CLI on PATH.`);
  const versionRun = runCommand(executable.resolvedPath, ["--version"], input.cwd, 10_000);
  const harnessVersion = parseVersion(`${versionRun.stdout}\n${versionRun.stderr}`);
  if (versionRun.status !== 0 || !harnessVersion) return blocked("unsupported-version", `Run ${profile.displayName} --version and install a version that matches the adapter contract.`);
  const adapter = getAiuContinuationAdapter(input.tool);
  const surface = adapter.declaration.nativeSurfaces[0]!.id;
  const compatible = adapter.probe({ surface, version: harnessVersion });
  if (compatible.status !== "ready") return blocked("unsupported-version", compatible.reason);
  const auth = authProbe(input.tool, executable.resolvedPath, input.cwd);
  if (!auth.ready) return blocked("authentication-missing", auth.nextAction);
  const selectedModel = selectModel(input.tool, executable.resolvedPath, input.cwd, input.model);
  if (isBlocked(selectedModel)) return selectedModel;
  return Object.freeze({
    executablePath: executable.resolvedPath,
    executableIdentity: path.basename(executable.resolvedPath),
    harnessVersion,
    surface,
    authentication: "ready" as const,
    repositoryTrust: adapter.declaration.trust.repositoryRequired ? "required" as const : "not-required" as const,
    model: selectedModel.model,
  });
}

function prepareWorkspace(input: { readonly tool: AiuHost; readonly cwd: string; readonly discovery: AiuVerificationDiscovery }): AiuPreparedVerification | AiuVerificationBlocked {
  const root = mkdtempSync(path.join(tmpdir(), "aiu-verify-"));
  try {
    mkdirSync(path.join(root, "artifacts"), { recursive: true });
    const git = runCommand("git", ["init", "--initial-branch", "main"], root, 20_000);
    if (git.status !== 0) throw new Error("git init failed");
    writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ name: "aiu-native-verification", private: true }, null, 2)}\n`, "utf8");
    const npm = resolveExecutable("npm");
    if (!npm.resolvedPath) throw new Error("npm is unavailable");
    const packageRoots = [getAiuPackageRoot(), ...resolveRuntimePackageRoots(getAiuPackageRoot())];
    const artifacts = packageRoots.map((packageRoot) => packRuntimePackage(npm.resolvedPath!, packageRoot, root));
    const packedArtifactDigest = digestJson(artifacts.map((artifact) => ({ name: artifact.name, digest: artifact.digest })));
    const installed = runCommand(npm.resolvedPath, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "--save-exact", ...artifacts.map((artifact) => artifact.tarballPath)], root, 180_000);
    if (installed.status !== 0) throw new Error(`packed AIU installation failed: ${commandFailureSummary(installed)}`);
    const aiuEntry = assertInside(root, path.join(root, "node_modules", "@tjalve", "aiu", "bin", "run"));
    if (!existsSync(aiuEntry)) throw new Error("packed AIU CLI entrypoint is missing");
    const init = runCommand(process.execPath, [aiuEntry, "init", "--tool", input.tool, "--post-issue-scope", "ready"], root, 60_000);
    if (init.status !== 0) throw new Error("packed AIU init failed");
    if (input.tool === "opencode") {
      const opencodeRoot = assertInside(root, path.join(root, ".opencode"));
      const pluginInstall = runCommand(npm.resolvedPath, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "--save-exact", ...artifacts.map((artifact) => artifact.tarballPath)], opencodeRoot, 180_000);
      if (pluginInstall.status !== 0) throw new Error(`packed OpenCode plugin installation failed: ${commandFailureSummary(pluginInstall)}`);
    }
    const configPath = assertInside(root, path.join(root, ".qube", "aiu", "config.json"));
    const config = loadAiuConfig({ cwd: root }).config;
    const modePath = assertInside(root, path.join(root, ".qube", "aiu", "verify-mode.txt"));
    const markerPath = assertInside(root, path.join(root, ".qube", "aiu", "verify-next-turn.json"));
    const tokenPath = assertInside(root, path.join(root, ".qube", "aiu", "verify-token.txt"));
    const stateScriptPath = assertInside(root, path.join(root, ".qube", "aiu", "verify-state.cjs"));
    const markerScriptPath = assertInside(root, path.join(root, ".qube", "aiu", "verify-next-turn.cjs"));
    writeFileSync(stateScriptPath, verificationStateScript(), "utf8");
    writeFileSync(markerScriptPath, verificationMarkerScript(), "utf8");
    const verifiedConfig: AiuConfig = Object.freeze({
      ...config,
      hosts: Object.freeze({
        ...config.hosts,
        enabled: Object.freeze([input.tool]),
        stopHookBlocking: Object.freeze({ ...config.hosts.stopHookBlocking, [input.tool]: true }),
        modes: Object.freeze({ ...config.hosts.modes, [input.tool]: Object.freeze(["continue", "stop"] as const) }),
      }),
      trustedStateCommands: Object.freeze({
        verification: Object.freeze({ argv: Object.freeze([process.execPath, stateScriptPath] as const), cwd: root }),
      }),
      continuation: Object.freeze({ ...config.continuation, nativeLoopLimit: 1 }),
      cooldowns: Object.freeze({ promptMs: 1 }),
    });
    writeFileSync(configPath, `${JSON.stringify(verifiedConfig, null, 2)}\n`, "utf8");
    const commandDir = assertInside(root, path.join(root, ".opencode", "commands"));
    mkdirSync(commandDir, { recursive: true });
    const commandPath = assertInside(root, path.join(commandDir, "make-it-so.md"));
    writeFileSync(commandPath, verificationCommand("setup"), "utf8");
    if (input.tool === "opencode") {
      const pluginPath = assertInside(root, path.join(root, ".opencode", "plugins", "ai-umpire-continuation.ts"));
      const configProbe = runCommand(input.discovery.executablePath, ["debug", "config"], root, 20_000, undefined, isolatedOpenCodeEnvironment(root));
      if (configProbe.status !== 0 || !configProbe.stdout.replaceAll("\\", "/").includes(pluginPath.replaceAll("\\", "/"))) {
        throw new Error(`OpenCode did not resolve the packed project plugin: ${commandFailureSummary(configProbe)}`);
      }
    }
    const sourceConfig = loadAiuConfig({ cwd: input.cwd }).config;
    return Object.freeze({
      root,
      aiuEntry,
      modePath,
      markerPath,
      tokenPath,
      commandPath,
      packedArtifactDigest,
      managedAssetDigest: createAiuManagedAssetDigest(input.tool, input.cwd),
      relevantConfigDigest: createAiuRelevantConfigDigest(sourceConfig, input.tool),
      trustedStateFingerprint: createAiuTrustedStateFingerprint(sourceConfig.trustedStateCommands),
      config: verifiedConfig,
    });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    const reason = error instanceof Error ? error.message : "Disposable workspace setup failed";
    return blocked("workspace-setup-failed", `${reason}. Inspect npm pack and exact package installation, then rerun verification. Lifecycle scripts remain disabled.`);
  }
}

function runNativeScenario(input: {
  readonly tool: AiuHost;
  readonly discovery: AiuVerificationDiscovery;
  readonly workspace: AiuPreparedVerification;
  readonly kind: "continue" | "allow";
  readonly timeoutMs: number;
}): AiuVerificationScenario {
  writeFileSync(input.workspace.modePath, `${input.kind}\n`, "utf8");
  rmSync(input.workspace.markerPath, { force: true });
  const paths = resolveAiuContinuationPaths(input.workspace.root, input.workspace.config);
  rmSync(paths.statePath, { force: true });
  rmSync(paths.lockPath, { force: true });
  const token = randomUUID();
  writeFileSync(input.workspace.tokenPath, `${token}\n`, "utf8");
  if (input.tool === "opencode") writeFileSync(input.workspace.commandPath, verificationCommand(token), "utf8");
  if (input.tool === "opencode") return runOpenCodeScenario(input, paths, token);
  const invocation = harnessInvocation(input.tool, input.discovery, input.workspace.root, token);
  const result = runCommand(input.discovery.executablePath, invocation.args, input.workspace.root, input.timeoutMs, invocation.stdin);
  if (result.errorCode === "ETIMEDOUT") return failedScenario(input.kind, "native-timeout");
  if (result.signal) return failedScenario(input.kind, "user-aborted", "aborted");
  if (result.status !== 0) {
    const diagnostic = `${result.stdout}\n${result.stderr}`.toLowerCase();
    if (/trust|approve|permission/.test(diagnostic)) return failedScenario(input.kind, "trust-prerequisite-unmet");
    return failedScenario(input.kind, "native-response-invalid");
  }
  const state = readAiuContinuationState(paths);
  const marker = readMarker(input.workspace.markerPath, token);
  if (input.kind === "allow") {
    if (state || marker) return Object.freeze({ ...failedScenario("allow", "allow-path-continued"), nativeInvocationObserved: true, continuationCount: state ? 1 : 0 });
    return Object.freeze({ kind: "allow", status: "passed", reasonCode: "verification-passed", nativeInvocationObserved: true, responseConsumed: false, nextTurnObserved: false, continuationCount: 0 });
  }
  if (state?.deliveryState !== "consumed") return Object.freeze({ ...failedScenario("continue", "continuation-not-consumed"), nativeInvocationObserved: true, continuationCount: state ? 1 : 0, observedDeliveryState: state?.deliveryState ?? "none", diagnostic: managedLifecycleDiagnostic(paths, result), ...(state?.ownerSessionId ? { sessionId: state.ownerSessionId } : {}) });
  if (!marker) return Object.freeze({ ...failedScenario("continue", "next-turn-not-observed"), nativeInvocationObserved: true, responseConsumed: true, continuationCount: 1, ...(state.ownerSessionId ? { sessionId: state.ownerSessionId } : {}) });
  return Object.freeze({ kind: "continue", status: "passed", reasonCode: "verification-passed", nativeInvocationObserved: true, responseConsumed: true, nextTurnObserved: true, continuationCount: 1, ...(state.ownerSessionId ? { sessionId: state.ownerSessionId } : {}) });
}

function runOpenCodeScenario(
  input: {
    readonly tool: AiuHost;
    readonly discovery: AiuVerificationDiscovery;
    readonly workspace: AiuPreparedVerification;
    readonly kind: "continue" | "allow";
    readonly timeoutMs: number;
  },
  paths: ReturnType<typeof resolveAiuContinuationPaths>,
  token: string,
): AiuVerificationScenario {
  rmSync(paths.logPath, { force: true });
  const environment = isolatedOpenCodeEnvironment(input.workspace.root);
  const startedAt = Date.now();
  const server = startOpenCodeServer(input.discovery.executablePath, input.workspace.root, environment, Math.min(input.timeoutMs, 20_000));
  if (!server) return failedScenario(input.kind, "native-response-invalid");
  try {
    const remainingForRun = input.timeoutMs - (Date.now() - startedAt);
    if (remainingForRun <= 0) return failedScenario(input.kind, "native-timeout");
    const invocation = harnessInvocation(input.tool, input.discovery, input.workspace.root, token, server.url);
    const result = runCommand(input.discovery.executablePath, invocation.args, input.workspace.root, remainingForRun, invocation.stdin, environment);
    const nativeOutput = `${result.stdout}\n${result.stderr}`;
    if (result.errorCode === "ETIMEDOUT") return failedScenario(input.kind, "native-timeout");
    if (result.signal) return failedScenario(input.kind, "user-aborted", "aborted");
    if (result.status !== 0) {
      const diagnostic = nativeOutput.toLowerCase();
      if (/trust|approve|permission/.test(diagnostic)) return failedScenario(input.kind, "trust-prerequisite-unmet");
      return failedScenario(input.kind, "native-response-invalid");
    }

    let state = readAiuContinuationState(paths);
    let marker = nativeOutput.includes(`AIU_VERIFY_NEXT:${token}`);
    let lifecycleObserved = managedLifecycleObserved(paths);
    let sessionEvidenceDiagnostic = "Session export was not attempted.";
    let nextSessionExportAt = 0;
    while (Date.now() - startedAt < input.timeoutMs) {
      if (input.kind === "allow") {
        if (state || marker) return Object.freeze({ ...failedScenario("allow", "allow-path-continued"), nativeInvocationObserved: true, continuationCount: state ? 1 : 0 });
        if (lifecycleObserved) return Object.freeze({ kind: "allow", status: "passed", reasonCode: "verification-passed", nativeInvocationObserved: true, responseConsumed: false, nextTurnObserved: false, continuationCount: 0 });
      } else if (state?.deliveryState === "consumed") {
        if (!marker && state.ownerSessionId && Date.now() >= nextSessionExportAt) {
          const exported = exportSessionEvidence(input, state.ownerSessionId, token, environment);
          marker = exported.observed;
          sessionEvidenceDiagnostic = exported.diagnostic;
          nextSessionExportAt = Date.now() + 1_000;
        }
        if (marker) return Object.freeze({ kind: "continue", status: "passed", reasonCode: "verification-passed", nativeInvocationObserved: true, responseConsumed: true, nextTurnObserved: true, continuationCount: 1, ...(state.ownerSessionId ? { sessionId: state.ownerSessionId } : {}) });
      }
      sleepSync(100);
      state = readAiuContinuationState(paths);
      lifecycleObserved = lifecycleObserved || managedLifecycleObserved(paths);
    }

    if (input.kind === "allow") return Object.freeze({ ...failedScenario("allow", "native-timeout"), nativeInvocationObserved: true, diagnostic: managedLifecycleDiagnostic(paths, result) });
    if (state?.deliveryState !== "consumed") return Object.freeze({ ...failedScenario("continue", "continuation-not-consumed"), nativeInvocationObserved: true, continuationCount: state ? 1 : 0, observedDeliveryState: state?.deliveryState ?? "none", diagnostic: managedLifecycleDiagnostic(paths, result), ...(state?.ownerSessionId ? { sessionId: state.ownerSessionId } : {}) });
    return Object.freeze({ ...failedScenario("continue", "next-turn-not-observed"), nativeInvocationObserved: true, responseConsumed: true, continuationCount: 1, diagnostic: `${managedLifecycleDiagnostic(paths, result)} ${sessionEvidenceDiagnostic}`.slice(0, 1000), ...(state.ownerSessionId ? { sessionId: state.ownerSessionId } : {}) });
  } finally {
    stopProcessTree(server.process);
  }
}

function harnessInvocation(tool: AiuHost, discovery: AiuVerificationDiscovery, root: string, token: string, attachUrl?: string): { readonly args: string[]; readonly stdin?: string } {
  const prompt = `Reply with AIU_VERIFY_INITIAL:${token}, then end your turn. If the managed continuation asks you to run a command, run it exactly once.`;
  if (tool === "opencode") return { args: ["run", ...(attachUrl ? ["--attach", attachUrl] : []), "--dir", root, "--format", "json", "--print-logs", "--log-level", "INFO", ...(discovery.model ? ["--model", discovery.model] : []), prompt] };
  if (tool === "codex") return { args: ["exec", "--cd", root, "--json", "--ephemeral", ...(discovery.model ? ["--model", discovery.model] : []), prompt] };
  if (tool === "claude-code") return { args: ["--print", "--output-format", "stream-json", "--verbose", "--permission-mode", "dontAsk", ...(discovery.model ? ["--model", discovery.model] : []), prompt] };
  return { args: ["--cwd", root, "--single", prompt, "--output-format", "streaming-json", "--permission-mode", "dontAsk", "--no-subagents", "--disable-web-search", ...(discovery.model ? ["--model", discovery.model] : [])] };
}

function startOpenCodeServer(executable: string, root: string, environment: Readonly<Record<string, string>>, timeoutMs: number): { readonly process: ChildProcess; readonly url: string } | undefined {
  const serverLogPath = assertInside(root, path.join(root, ".qube", "aiu", "verify-opencode-server.log"));
  rmSync(serverLogPath, { force: true });
  const port = randomInt(49_152, 65_536);
  const invocation = commandInvocation(executable, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "INFO"]);
  const logHandle = openSync(serverLogPath, "a");
  let child: ChildProcess;
  try {
    child = spawn(invocation.command, invocation.args, {
      cwd: root,
      env: { ...process.env, ...environment },
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", logHandle, logHandle],
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
  } catch {
    closeSync(logHandle);
    return undefined;
  }
  closeSync(logHandle);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const match = /opencode server listening on (https?:\/\/[^\s]+)/u.exec(readFileSync(serverLogPath, "utf8"));
      if (match?.[1]) return Object.freeze({ process: child, url: match[1] });
    } catch {
      // The server log can appear after the process starts.
    }
    sleepSync(100);
  }
  stopProcessTree(child);
  return undefined;
}

function exportSessionEvidence(
  input: { readonly discovery: AiuVerificationDiscovery; readonly workspace: AiuPreparedVerification },
  sessionId: string,
  token: string,
  environment: Readonly<Record<string, string>>,
): { readonly observed: boolean; readonly diagnostic: string } {
  const exported = runCommand(input.discovery.executablePath, ["export", sessionId], input.workspace.root, 10_000, undefined, environment);
  const observed = exported.status === 0 && exported.stdout.includes(`AIU_VERIFY_NEXT:${token}`);
  return Object.freeze({
    observed,
    diagnostic: observed
      ? "The native session export contains the verification nonce."
      : `Session export did not contain the verification nonce: ${commandFailureSummary(exported)}`,
  });
}

function managedLifecycleObserved(paths: ReturnType<typeof resolveAiuContinuationPaths>): boolean {
  try {
    return readFileSync(paths.logPath, "utf8").split(/\r?\n/u).some((line) => /"event":"decision"/u.test(line) && /"eventType":"session\.(?:idle|status)"/u.test(line));
  } catch {
    return false;
  }
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function stopProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, shell: false, timeout: 10_000 });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch { /* The process already stopped. */ }
  }
}

function isolatedOpenCodeEnvironment(root: string): Readonly<Record<string, string>> {
  const isolatedHome = assertInside(root, path.join(root, ".verification-home"));
  const configHome = assertInside(root, path.join(root, ".verification-config"));
  mkdirSync(isolatedHome, { recursive: true });
  mkdirSync(configHome, { recursive: true });
  return Object.freeze({ HOME: isolatedHome, USERPROFILE: isolatedHome, XDG_CONFIG_HOME: configHome });
}

function authProbe(tool: AiuHost, executable: string, cwd: string): { readonly ready: boolean; readonly nextAction: string } {
  const args = tool === "opencode" ? ["auth", "list"] : tool === "codex" ? ["login", "status"] : tool === "claude-code" ? ["auth", "status"] : ["models"];
  const result = runCommand(executable, args, cwd, 20_000);
  return result.status === 0 && `${result.stdout}${result.stderr}`.trim().length > 0
    ? { ready: true, nextAction: "No action is required." }
    : { ready: false, nextAction: `Authenticate ${tool} outside QUBE, then rerun verification.` };
}

function selectModel(tool: AiuHost, executable: string, cwd: string, requested: string | undefined): { readonly model: string | null } | AiuVerificationBlocked {
  if (tool !== "opencode") return { model: requested ?? null };
  const catalog = runCommand(executable, ["models"], cwd, 20_000);
  if (catalog.status !== 0) return blocked("authentication-missing", "Run opencode models and fix provider authentication before verification.");
  const models = catalog.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (requested) return models.includes(requested) ? { model: requested } : blocked("model-unavailable", `Choose a model listed by opencode models; ${requested} is unavailable.`);
  const free = models.find((model) => FREE_OPENCODE_MODEL.test(model));
  return free ? { model: free } : blocked("model-unavailable", "Pass --model with an explicitly approved OpenCode model; no listed free model was found.");
}

function buildActivationEvidence(tool: AiuHost, discovery: AiuVerificationDiscovery, workspace: AiuPreparedVerification, scenario: AiuVerificationScenario, observedAt: string): AiuHostActivation {
  const declared = getAiuContinuationAdapter(tool).declaration.activationEvidence;
  return Object.freeze({
    schemaVersion: 2,
    contractVersion: AIU_VERIFICATION_CONTRACT_VERSION,
    host: tool,
    delivery: declared.delivery,
    event: declared.event,
    eventState: "consumed",
    harnessVersion: discovery.harnessVersion,
    surface: discovery.surface,
    packedArtifactDigest: workspace.packedArtifactDigest,
    managedAssetDigest: workspace.managedAssetDigest,
    relevantConfigDigest: workspace.relevantConfigDigest,
    trustedStateFingerprint: workspace.trustedStateFingerprint,
    ...(scenario.sessionId ? { sessionId: scenario.sessionId } : {}),
    observedAt,
  });
}

function verificationStateScript(): string {
  return `const fs=require("node:fs"),p=require("node:path");const now=new Date().toISOString();const mode=fs.readFileSync(p.join(__dirname,"verify-mode.txt"),"utf8").trim();const active=mode==="continue";process.stdout.write(JSON.stringify({schemaVersion:1,sourceId:"verification",observedAt:now,trustLevel:"trusted",capabilities:{work:"supported"},freshness:{kind:"fresh",observedAt:now},value:{kind:"work-queue",status:"pass",activeItems:active?[{kind:"work-item",status:"pass",id:"verify",title:"Run the verification next-turn command",lifecycle:"active",priority:"high",blockers:[],nextAction:{id:"verify-next-turn",argv:[process.execPath,p.join(__dirname,"verify-next-turn.cjs")]}}]:[],readyItems:[],blockedItems:[],unknownItems:[]}}));\n`;
}

function verificationMarkerScript(): string {
  return `const fs=require("node:fs"),p=require("node:path");const token=fs.readFileSync(p.join(__dirname,"verify-token.txt"),"utf8").trim();fs.writeFileSync(p.join(__dirname,"verify-next-turn.json"),JSON.stringify({token,observedAt:new Date().toISOString()}));\n`;
}

function verificationCommand(token: string): string {
  return `---\ndescription: Continue the bounded AIU native lifecycle verification.\n---\nReply exactly with AIU_VERIFY_NEXT:${token}, then end the turn. Do not use tools.\n`;
}

function readMarker(markerPath: string, token: string): boolean {
  try {
    const value = JSON.parse(readFileSync(markerPath, "utf8")) as unknown;
    return value !== null
      && typeof value === "object"
      && (value as { token?: unknown }).token === token
      && typeof (value as { observedAt?: unknown }).observedAt === "string";
  } catch {
    return false;
  }
}

function reportFromBlock(tool: AiuHost, observedAt: string, warning: string, failure: AiuVerificationBlocked, discovery?: AiuVerificationDiscovery, workspace?: AiuPreparedVerification, scenarios: readonly AiuVerificationScenario[] = []): AiuVerificationReport {
  return Object.freeze({ schemaVersion: 1, contractVersion: 1, tool, status: failure.status, reasonCode: failure.reasonCode, warning, observedAt, ...(discovery ? { discovery } : {}), ...(workspace ? { workspace: workspaceSummary(workspace) } : {}), scenarios: Object.freeze([...scenarios]), nextAction: failure.nextAction });
}

function reportFromScenario(tool: AiuHost, observedAt: string, warning: string, discovery: AiuVerificationDiscovery, workspace: AiuPreparedVerification, scenarios: readonly AiuVerificationScenario[], failure: AiuVerificationScenario): AiuVerificationReport {
  const status = failure.status === "aborted"
    ? "aborted"
    : failure.reasonCode === "trust-prerequisite-unmet"
      ? "blocked"
      : "failed";
  return reportFromBlock(tool, observedAt, warning, { status, reasonCode: failure.reasonCode, nextAction: scenarioNextAction(failure, tool) }, discovery, workspace, scenarios);
}

function scenarioNextAction(scenario: AiuVerificationScenario, tool: AiuHost): string {
  const reason = scenario.reasonCode;
  if (reason === "trust-prerequisite-unmet") return `Approve the disposable ${tool} project through the harness trust surface, then rerun verification. QUBE will not change trust state.`;
  if (reason === "native-timeout") return `Inspect ${tool} responsiveness and rerun with a bounded --timeout after resolving the delay.`;
  if (reason === "user-aborted") return "Rerun the explicit verification command when you want to complete the bounded model-backed check.";
  if (reason === "continuation-not-consumed") return `Inspect the ${tool} native lifecycle; the managed response remained ${scenario.observedDeliveryState ?? "unobserved"} and did not produce compatible consumed evidence.${scenario.diagnostic ? ` Native diagnostic: ${scenario.diagnostic}` : ""}`;
  return `Inspect the ${tool} native lifecycle output and managed integration logs; hook invocation alone is not accepted as proof.`;
}

function workspaceSummary(workspace: AiuPreparedVerification): AiuVerificationWorkspaceSummary {
  return Object.freeze({ disposable: true, packed: true, packedArtifactDigest: workspace.packedArtifactDigest, managedAssetDigest: workspace.managedAssetDigest, relevantConfigDigest: workspace.relevantConfigDigest, trustedStateFingerprint: workspace.trustedStateFingerprint });
}

function blocked(reasonCode: AiuVerificationReasonCode, nextAction: string): AiuVerificationBlocked {
  return Object.freeze({ status: "blocked", reasonCode, nextAction });
}

function failedScenario(kind: "continue" | "allow", reasonCode: AiuVerificationReasonCode, status: "failed" | "aborted" = "failed"): AiuVerificationScenario {
  return Object.freeze({ kind, status, reasonCode, nativeInvocationObserved: false, responseConsumed: false, nextTurnObserved: false, continuationCount: 0 });
}

function isBlocked(value: unknown): value is AiuVerificationBlocked {
  return value !== null && typeof value === "object" && "status" in value && ((value as { status: unknown }).status === "blocked" || (value as { status: unknown }).status === "failed" || (value as { status: unknown }).status === "aborted");
}

function parseVersion(output: string): string | undefined {
  return /(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/u.exec(output.trim())?.[1];
}

function parsePackedFilename(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return Array.isArray(parsed) && parsed[0] && typeof parsed[0] === "object" && typeof (parsed[0] as { filename?: unknown }).filename === "string" ? (parsed[0] as { filename: string }).filename : undefined;
  } catch {
    return undefined;
  }
}

function packRuntimePackage(npmExecutable: string, packageRoot: string, workspaceRoot: string): { readonly name: string; readonly tarballPath: string; readonly digest: string } {
  const manifest = readPackageManifest(packageRoot);
  const stagedRoot = stageRuntimePackage(packageRoot, workspaceRoot, manifest);
  const packed = runCommand(npmExecutable, ["pack", stagedRoot, "--ignore-scripts", "--json", "--pack-destination", path.join(workspaceRoot, "artifacts")], workspaceRoot, 120_000);
  if (packed.status !== 0) throw new Error(`npm pack failed for ${manifest.name}`);
  const tarballName = parsePackedFilename(packed.stdout);
  if (!tarballName) throw new Error(`npm pack did not report a tarball for ${manifest.name}`);
  const tarballPath = assertInside(workspaceRoot, path.join(workspaceRoot, "artifacts", tarballName));
  return Object.freeze({ name: manifest.name, tarballPath, digest: digestBytes(readFileSync(tarballPath)) });
}

function stageRuntimePackage(packageRoot: string, workspaceRoot: string, manifest: RuntimePackageManifest): string {
  const stagedRoot = assertInside(workspaceRoot, path.join(workspaceRoot, "artifacts", "staged", manifest.name.replaceAll("/", "-")));
  mkdirSync(stagedRoot, { recursive: true });
  const includedPaths = new Set([...(manifest.files ?? []), "README.md", "LICENSE", "LICENSE.md"]);
  for (const relativePath of includedPaths) {
    const source = path.join(packageRoot, relativePath);
    if (!existsSync(source)) continue;
    const destination = assertInside(stagedRoot, path.join(stagedRoot, relativePath));
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true });
  }
  const dependencies = manifest.dependencies === undefined
    ? undefined
    : Object.fromEntries(Object.entries(manifest.dependencies).map(([name, version]) => [
      name,
      version.startsWith("workspace:") ? readPackageManifest(resolveRuntimePackageRoot(name)).version : version,
    ]));
  writeFileSync(path.join(stagedRoot, "package.json"), `${JSON.stringify({ ...manifest, ...(dependencies ? { dependencies } : {}) }, null, 2)}\n`, "utf8");
  return stagedRoot;
}

function resolveRuntimePackageRoots(packageRoot: string): readonly string[] {
  const manifest = readPackageManifest(packageRoot);
  return Object.keys(manifest.dependencies ?? {})
    .filter((name) => name.startsWith("@tjalve/"))
    .sort()
    .map(resolveRuntimePackageRoot);
}

function resolveRuntimePackageRoot(packageName: string): string {
  let current = path.dirname(fileURLToPath(import.meta.resolve(packageName)));
  while (true) {
    const manifestPath = path.join(current, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = readPackageManifest(current);
      if (manifest.name === packageName) return current;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`Cannot resolve package root for ${packageName}`);
    current = parent;
  }
}

interface RuntimePackageManifest extends Readonly<Record<string, unknown>> {
  readonly name: string;
  readonly version: string;
  readonly files?: readonly string[];
  readonly dependencies?: Readonly<Record<string, string>>;
}

function readPackageManifest(packageRoot: string): RuntimePackageManifest {
  const parsed = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as unknown;
  if (parsed === null || typeof parsed !== "object" || typeof (parsed as { name?: unknown }).name !== "string" || typeof (parsed as { version?: unknown }).version !== "string") {
    throw new Error(`Invalid package manifest at ${packageRoot}`);
  }
  const dependencies = (parsed as { dependencies?: unknown }).dependencies;
  if (dependencies !== undefined && (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies))) {
    throw new Error(`Invalid package dependencies at ${packageRoot}`);
  }
  const files = (parsed as { files?: unknown }).files;
  if (files !== undefined && (!Array.isArray(files) || files.some((entry) => typeof entry !== "string"))) {
    throw new Error(`Invalid package files at ${packageRoot}`);
  }
  return parsed as RuntimePackageManifest;
}

function runCommand(executable: string, args: readonly string[], cwd: string, timeout: number, stdin?: string, environment?: Readonly<Record<string, string>>): { readonly status: number | null; readonly signal: NodeJS.Signals | null; readonly stdout: string; readonly stderr: string; readonly errorCode?: string } {
  const invocation = commandInvocation(executable, args);
  const result = spawnSync(invocation.command, invocation.args, { cwd, encoding: "utf8", input: stdin, timeout, maxBuffer: OUTPUT_LIMIT, windowsHide: true, shell: false, ...(environment ? { env: { ...process.env, ...environment } } : {}), ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
  if (process.platform === "win32" && result.error && "code" in result.error && result.error.code === "ETIMEDOUT" && typeof result.pid === "number") {
    spawnSync("taskkill.exe", ["/pid", String(result.pid), "/T", "/F"], { windowsHide: true, shell: false, timeout: 10_000 });
  }
  return { status: result.status, signal: result.signal, stdout: result.stdout ?? "", stderr: result.stderr ?? "", ...(result.error && "code" in result.error ? { errorCode: String(result.error.code) } : {}) };
}

function commandInvocation(executable: string, args: readonly string[]): { readonly command: string; readonly args: readonly string[]; readonly windowsVerbatimArguments: boolean } {
  const windowsShim = process.platform === "win32" && [".cmd", ".bat"].includes(path.extname(executable).toLowerCase());
  return windowsShim
    ? Object.freeze({ command: process.env.ComSpec ?? "cmd.exe", args: Object.freeze(["/d", "/s", "/c", `"${[quoteCmd(executable), ...args.map(quoteCmd)].join(" ")}"`]), windowsVerbatimArguments: true })
    : Object.freeze({ command: executable, args: Object.freeze([...args]), windowsVerbatimArguments: false });
}

function commandFailureSummary(result: { readonly status: number | null; readonly stdout: string; readonly stderr: string }): string {
  const lines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^npm error A complete log of this run can be found in:/iu.test(line))
    .slice(-6)
    .join(" ")
    .replace(/(token|password|secret|authorization)=\S+/giu, "$1=<redacted>");
  return lines.slice(0, 1000) || `exit ${result.status ?? "unknown"}`;
}

function nativeIntegrationDiagnostic(result: { readonly status: number | null; readonly stdout: string; readonly stderr: string }): string {
  const relevant = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /(?:plugin|@tjalve\/aiu|error|fail)/iu.test(line))
    .slice(-8)
    .join(" ");
  return (relevant || commandFailureSummary(result)).slice(0, 1000);
}

function managedLifecycleDiagnostic(paths: ReturnType<typeof resolveAiuContinuationPaths>, result: { readonly status: number | null; readonly stdout: string; readonly stderr: string }): string {
  let managed = "";
  try {
    managed = readFileSync(paths.logPath, "utf8").split(/\r?\n/u).filter(Boolean).slice(-4).join(" ");
  } catch {
    managed = "No managed integration log was written.";
  }
  return `${managed} ${nativeIntegrationDiagnostic(result)}`.slice(0, 1000);
}

function quoteCmd(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function assertInside(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return resolved;
  throw new Error("Verification path escapes the disposable repository.");
}

export function assertVerificationPath(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes("..")) throw new Error("Verification paths must be repository-relative.");
  const candidate = assertInside(root, path.join(root, relativePath));
  if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) throw new Error("Verification paths cannot be symbolic links.");
  if (existsSync(candidate)) {
    const realRoot = realpathSync(root);
    const real = realpathSync(candidate);
    assertInside(realRoot, real);
  }
  return candidate;
}

function digestJson(value: unknown): string {
  return digestBytes(Buffer.from(JSON.stringify(value), "utf8"));
}

function digestBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/gu, "\n").trimEnd();
}
