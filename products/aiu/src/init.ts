import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  AIU_CONFIG_FILENAME,
  AIU_HOSTS,
  type AiuConfig,
  type AiuHost,
  type AiuPostIssueScope,
  getDefaultAiuConfig,
  loadAiuConfig,
} from "./config.js";
import {
  getAiuHostCapabilityProfiles,
  getDefaultHostCapabilityOverrides,
  getDefaultHostModes,
  getDefaultStopHookBlocking,
  type AiuHostCapabilityProfile,
  type AiuManagedHostFile,
} from "./host_policy.js";

export const AIU_INIT_TOOLS = [
  "none",
  "opencode",
  "codex",
  "claude-code",
  "grok-build",
  "opencode,codex",
  "opencode,claude-code",
  "opencode,grok-build",
  "codex,claude-code",
  "codex,grok-build",
  "claude-code,grok-build",
  "opencode,codex,claude-code",
  "opencode,codex,grok-build",
  "opencode,claude-code,grok-build",
  "codex,claude-code,grok-build",
  "opencode,codex,claude-code,grok-build",
  "all",
] as const;

export type AiuInitTool = (typeof AIU_INIT_TOOLS)[number];
export type AiuInitFileOperation = "create" | "update" | "skip" | "conflict";

export interface AiuInitOptions {
  readonly cwd?: string;
  readonly tool?: AiuInitTool;
  readonly postIssueScope?: AiuPostIssueScope;
  readonly dryRun?: boolean;
  readonly force?: boolean;
}

export type { AiuHostCapabilityProfile, AiuManagedHostFile } from "./host_policy.js";

export interface AiuInitPlan {
  readonly ok: boolean;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly repoRoot: string;
  readonly configPath: string;
  readonly postIssueScope: AiuPostIssueScope;
  readonly tools: readonly AiuHost[];
  readonly hostProfiles: readonly AiuHostCapabilityProfile[];
  readonly files: readonly AiuInitFileAction[];
  readonly config: AiuInitConfigAction;
  readonly conflicts: readonly AiuInitConflict[];
  readonly requiredTrustSteps: readonly string[];
  readonly recommendedNextCommand: string;
}

interface AiuInitRootIdentity {
  readonly canonicalPath: string;
  readonly device: number;
  readonly inode: number;
}

const initRootIdentities = new WeakMap<AiuInitPlan, AiuInitRootIdentity>();

export interface AiuInitFileAction {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly description: string;
  readonly ownership: AiuManagedHostFile["ownership"];
  readonly operation: AiuInitFileOperation;
  readonly reason: string;
  readonly content: string;
}

export interface AiuInitConfigAction {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly operation: AiuInitFileOperation;
  readonly reason: string;
  readonly content: string;
  readonly hosts: readonly AiuHost[];
  readonly trustedStateCommands: readonly string[];
}

export interface AiuInitConflict {
  readonly relativePath: string;
  readonly reason: string;
  readonly suggestedNextAction: string;
}

export function planAiuInit(options: AiuInitOptions = {}): AiuInitPlan {
  const configLoad = loadAiuConfig({ cwd: options.cwd });
  const repoRoot = configLoad.repoRoot;
  const rootIdentity = captureInitRootIdentity(repoRoot);
  const tool = options.tool ?? "all";
  const tools = expandInitTools(tool);
  const postIssueScope = options.postIssueScope ?? configLoad.config.postIssueScope;
  const dryRun = options.dryRun === true;
  const force = options.force === true;
  const hostProfiles = getAiuHostCapabilityProfiles(tools);
  const files = hostProfiles.flatMap((profile) => profile.managedFiles.map((file) => planFile(repoRoot, file, force)));
  const config = planConfig(repoRoot, configLoad.selectedPath, configLoad.config, tools, postIssueScope);
  const configError = !configLoad.ok
    ? configLoad.diagnostics.find((diagnostic) => diagnostic.severity === "error")
    : undefined;
  const customScopeMissingTasks = postIssueScope === "custom" && configLoad.config.whip.tasks.length === 0;
  const conflicts = [
    ...files.filter((file) => file.operation === "conflict").map((file) => ({
      relativePath: file.relativePath,
      reason: file.reason,
      suggestedNextAction: file.ownership === "shared"
        ? `Fix ${file.relativePath} so it contains the expected JSON structure. QUBE does not replace shared files.`
        : `Review ${file.relativePath}, then rerun with --force if replacing it is intentional.`,
    })),
    ...(config.operation === "conflict"
      ? [
          {
            relativePath: config.relativePath,
            reason: config.reason,
            suggestedNextAction: `Fix ${AIU_CONFIG_FILENAME}, then run aiu init again. QUBE does not replace malformed config.`,
          },
        ]
      : []),
    ...(configError
      ? [{
          relativePath: config.relativePath,
          reason: configError.message,
          suggestedNextAction: configError.suggestedNextAction,
        }]
      : []),
    ...(customScopeMissingTasks && configError?.kind !== "custom-post-issue-tasks-required"
      ? [{
          relativePath: config.relativePath,
          reason: "Custom post-issue scope requires at least one configured Umpire task.",
          suggestedNextAction: `Add one or more tasks under whip.tasks in ${AIU_CONFIG_FILENAME}, or select ready or standard scope.`,
        }]
      : []),
  ];

  const plan = Object.freeze({
    ok: conflicts.length === 0,
    dryRun,
    force,
    repoRoot,
    configPath: configLoad.selectedPath,
    postIssueScope,
    tools: Object.freeze(tools),
    hostProfiles: Object.freeze(hostProfiles),
    files: Object.freeze(files),
    config,
    conflicts: Object.freeze(conflicts),
    requiredTrustSteps: Object.freeze([...new Set(hostProfiles.flatMap((profile) => profile.trustSteps))]),
    recommendedNextCommand: "aiu config --json",
  });
  initRootIdentities.set(plan, rootIdentity);
  return plan;
}

export function applyAiuInitPlan(plan: AiuInitPlan): AiuInitPlan {
  if (plan.dryRun || !plan.ok) {
    return plan;
  }

  const rootIdentity = initRootIdentities.get(plan);
  if (rootIdentity === undefined) {
    return initRootConflictPlan(plan, "Init plan does not have a trusted repository root identity.");
  }

  const initialRootError = validateInitRoot(plan.repoRoot, rootIdentity);
  if (initialRootError !== undefined) {
    return initRootConflictPlan(plan, initialRootError);
  }

  const refreshed = planAiuInit({
    cwd: plan.repoRoot,
    tool: toolForPlan(plan.tools),
    postIssueScope: plan.postIssueScope,
    force: plan.force,
  });
  if (!refreshed.ok) {
    return refreshed;
  }
  const refreshedRootIdentity = initRootIdentities.get(refreshed);
  const refreshedRootError = refreshedRootIdentity === undefined
    ? "Refreshed init plan does not have a trusted repository root identity."
    : compareInitRootIdentity(rootIdentity, refreshedRootIdentity)
      ?? validateInitRoot(plan.repoRoot, rootIdentity);
  if (refreshedRootError !== undefined) {
    return initRootConflictPlan(refreshed, refreshedRootError);
  }

  const validated = validateInitDestinations(refreshed);
  if (!validated.ok) {
    return validated;
  }

  const finalRootError = validateInitRoot(plan.repoRoot, rootIdentity);
  if (finalRootError !== undefined) {
    return initRootConflictPlan(validated, finalRootError);
  }

  for (const file of [...validated.files, validated.config]) {
    if (file.operation === "create" || file.operation === "update") {
      try {
        mkdirSync(path.dirname(file.absolutePath), { recursive: true });
        writeFileSync(file.absolutePath, file.content, {
          encoding: "utf8",
          flag: file.operation === "create" ? "wx" : "w",
        });
      } catch (error) {
        return initWriteConflictPlan(
          validated,
          file.absolutePath,
          `Managed destination could not be written: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return validated;
}

function captureInitRootIdentity(repoRoot: string): AiuInitRootIdentity {
  const status = lstatSync(repoRoot);
  return Object.freeze({
    canonicalPath: realpathSync.native(repoRoot),
    device: status.dev,
    inode: status.ino,
  });
}

function validateInitRoot(repoRoot: string, expected: AiuInitRootIdentity): string | undefined {
  let status: ReturnType<typeof lstatSync>;
  let canonicalPath: string;
  try {
    status = lstatSync(repoRoot);
    canonicalPath = realpathSync.native(repoRoot);
  } catch (error) {
    return `Repository root could not be inspected after init planning: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (status.isSymbolicLink()) {
    return "Repository root must not be a symbolic link or directory junction.";
  }
  if (!status.isDirectory()) {
    return "Repository root is no longer a directory.";
  }
  return compareInitRootIdentity(expected, {
    canonicalPath,
    device: status.dev,
    inode: status.ino,
  });
}

function compareInitRootIdentity(expected: AiuInitRootIdentity, current: AiuInitRootIdentity): string | undefined {
  if (path.relative(expected.canonicalPath, current.canonicalPath) !== ""
    || expected.device !== current.device
    || expected.inode !== current.inode) {
    return "Repository root changed after init planning.";
  }
  return undefined;
}

function initRootConflictPlan(plan: AiuInitPlan, reason: string): AiuInitPlan {
  return Object.freeze({
    ...plan,
    ok: false,
    conflicts: Object.freeze([
      ...plan.conflicts,
      Object.freeze({
        relativePath: ".",
        reason,
        suggestedNextAction: "Restore the original repository directory, then create a new init plan.",
      }),
    ]),
  });
}

function initWriteConflictPlan(plan: AiuInitPlan, absolutePath: string, reason: string): AiuInitPlan {
  const relativePath = path.relative(plan.repoRoot, absolutePath);
  const files = plan.files.map((file) => path.relative(file.absolutePath, absolutePath) === ""
    ? Object.freeze({ ...file, operation: "conflict" as const, reason })
    : file);
  const config = path.relative(plan.config.absolutePath, absolutePath) === ""
    ? Object.freeze({ ...plan.config, operation: "conflict" as const, reason })
    : plan.config;
  return Object.freeze({
    ...plan,
    ok: false,
    files: Object.freeze(files),
    config,
    conflicts: Object.freeze([...plan.conflicts, initPathConflict(relativePath, reason)]),
  });
}

function validateInitDestinations(plan: AiuInitPlan): AiuInitPlan {
  const pathConflicts: AiuInitConflict[] = [];
  const files = plan.files.map((file) => {
    const reason = validateInitDestination(plan.repoRoot, file.absolutePath);
    if (reason === undefined) {
      return file;
    }
    pathConflicts.push(initPathConflict(file.relativePath, reason));
    return Object.freeze({ ...file, operation: "conflict" as const, reason });
  });
  const configReason = validateInitDestination(plan.repoRoot, plan.config.absolutePath);
  const config = configReason === undefined
    ? plan.config
    : Object.freeze({ ...plan.config, operation: "conflict" as const, reason: configReason });
  if (configReason !== undefined) {
    pathConflicts.push(initPathConflict(plan.config.relativePath, configReason));
  }
  if (pathConflicts.length === 0) {
    return plan;
  }
  return Object.freeze({
    ...plan,
    ok: false,
    files: Object.freeze(files),
    config,
    conflicts: Object.freeze([...plan.conflicts, ...pathConflicts]),
  });
}

function validateInitDestination(repoRoot: string, absolutePath: string): string | undefined {
  const relativePath = path.relative(repoRoot, absolutePath);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    return "Managed destination must resolve to a file inside the repository.";
  }

  let currentPath = repoRoot;
  const segments = relativePath.split(path.sep).filter((segment) => segment.length > 0);
  for (const [index, segment] of segments.entries()) {
    currentPath = path.join(currentPath, segment);
    let status: ReturnType<typeof lstatSync>;
    try {
      status = lstatSync(currentPath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        break;
      }
      return `Managed destination could not be inspected: ${error instanceof Error ? error.message : String(error)}`;
    }
    const displayPath = path.relative(repoRoot, currentPath).replace(/\\/gu, "/");
    if (status.isSymbolicLink()) {
      return `Managed destination must not traverse symbolic links or directory junctions (${displayPath}).`;
    }
    const isDestination = index === segments.length - 1;
    if (!isDestination && !status.isDirectory()) {
      return `Managed destination parent is not a directory (${displayPath}).`;
    }
    if (isDestination && !status.isFile()) {
      return `Managed destination must be a regular file (${displayPath}).`;
    }
  }
  return undefined;
}

function initPathConflict(relativePath: string, reason: string): AiuInitConflict {
  return Object.freeze({
    relativePath,
    reason,
    suggestedNextAction: `Replace linked or invalid segments in ${relativePath} with repository-owned directories and a regular file, then run aiu init again.`,
  });
}

export function formatInitPlan(plan: AiuInitPlan): string {
  const sections = [
    `repoRoot: ${plan.repoRoot}`,
    `mode: ${plan.dryRun ? "dry-run" : "apply"}`,
    `tools: ${plan.tools.join(", ") || "none"}`,
    `postIssueScope: ${plan.postIssueScope}`,
    "",
    formatFileGroup("Created", plan, "create"),
    formatFileGroup("Updated", plan, "update"),
    formatFileGroup("Skipped", plan, "skip"),
    formatFileGroup("Conflicts", plan, "conflict"),
    "Config changes:",
    `- ${plan.config.relativePath}: hosts=${plan.config.hosts.join(", ") || "none"}; trustedStateCommands=${plan.config.trustedStateCommands.join(", ") || "none"}`,
    "",
    "Required trust steps:",
    ...plan.requiredTrustSteps.map((step) => `- ${step}`),
    "",
    `Recommended next command: ${plan.recommendedNextCommand}`,
  ];

  return `${sections.join("\n")}\n`;
}

function expandInitTools(tool: AiuInitTool): readonly AiuHost[] {
  if (tool === "none") return Object.freeze([]);
  if (tool === "all") return AIU_HOSTS;
  const selected = new Set<AiuHost>(tool.split(",") as AiuHost[]);
  return Object.freeze(AIU_HOSTS.filter((host) => selected.has(host)));
}

function toolForPlan(tools: readonly AiuHost[]): AiuInitTool {
  if (tools.length === 0) return "none";
  return (tools.length === AIU_HOSTS.length ? "all" : tools.join(",")) as AiuInitTool;
}

function planFile(repoRoot: string, file: AiuManagedHostFile, force: boolean): AiuInitFileAction {
  const absolutePath = path.join(repoRoot, file.relativePath);
  const existing = readExistingText(absolutePath);
  const planned = file.ownership === "shared"
    ? planSharedJsonWrite(existing, file)
    : { ...classifyTextWrite(existing, file.content, force), content: file.content };
  return Object.freeze({
    relativePath: file.relativePath,
    absolutePath,
    description: file.description,
    ownership: file.ownership,
    operation: planned.operation,
    reason: planned.reason,
    content: planned.content,
  });
}

function planConfig(
  repoRoot: string,
  configPath: string,
  loadedConfig: AiuConfig,
  tools: readonly AiuHost[],
  postIssueScope: AiuPostIssueScope,
): AiuInitConfigAction {
  const relativePath = path.relative(repoRoot, configPath) || AIU_CONFIG_FILENAME;
  const existing = readExistingText(configPath);
  const existingRaw = existing.exists && existing.content !== undefined ? parseJsonObject(existing.content) : { ok: true, value: {} };
  const mergedConfig = mergeConfig(loadedConfig, existingRaw.ok ? existingRaw.value : {}, tools, postIssueScope);
  const content = stableJson(mergedConfig);
  const planned = classifyConfigWrite(existing, existingRaw, content);

  return Object.freeze({
    relativePath,
    absolutePath: configPath,
    operation: planned.operation,
    reason: planned.reason,
    content,
    hosts: Object.freeze(readMergedHosts(mergedConfig)),
    trustedStateCommands: Object.freeze(readMergedTrustedStateCommandNames(mergedConfig)),
  });
}

function mergeConfig(
  config: AiuConfig,
  raw: Record<string, unknown>,
  tools: readonly AiuHost[],
  postIssueScope: AiuPostIssueScope,
): Record<string, unknown> {
  const defaults = getDefaultAiuConfig();
  const enabled = [...tools];
  const capabilities = {
    ...config.hosts.capabilities,
    ...Object.fromEntries(
      tools.map((tool) => [
        tool,
        {
          ...getDefaultHostCapabilityOverrides(tool),
          ...(config.hosts.capabilities[tool] ?? {}),
        },
      ]),
    ),
  };
  const modes = {
    ...config.hosts.modes,
    ...Object.fromEntries(
      tools.map((tool) => [tool, config.hosts.modes[tool] ?? getDefaultHostModes(tool)]),
    ),
  };
  const stopHookBlocking = {
    ...config.hosts.stopHookBlocking,
    ...Object.fromEntries(
      tools.map((tool) => [tool, config.hosts.stopHookBlocking[tool] ?? getDefaultStopHookBlocking(tool)]),
    ),
  };

  return {
    ...raw,
    version: 1,
    postIssueScope,
    hosts: {
      ...(isRecord(raw.hosts) ? raw.hosts : {}),
      enabled,
      capabilities,
      modes,
      stopHookBlocking,
    },
    trustedStateCommands: {
      ...config.trustedStateCommands,
      work: config.trustedStateCommands.work ?? {
        argv: ["aie", "status", "--json"],
        timeoutMs: defaults.timeouts.commandMs,
        maxOutputBytes: 1_048_576,
      },
    },
    continuation: {
      ...config.continuation,
      modes: config.continuation.modes,
      stopOnUnknownState: true,
      stopOnUnsafeState: true,
      stopOnSupplyChainApprovalBlock: true,
      allowProviderMutation: false,
      allowBackgroundScheduling: false,
      trustUnstructuredProse: false,
    },
    timeouts: config.timeouts,
    cooldowns: config.cooldowns,
    paths: config.paths,
    supplyChain: {
      ...config.supplyChain,
      stopOnApprovalRequired: true,
    },
    planning: {
      ...(isRecord(raw.planning) ? raw.planning : {}),
      enabled: false,
    },
    quality: {
      ...(isRecord(raw.quality) ? raw.quality : {}),
      enabled: postIssueScope === "standard",
    },
    whip: {
      ...(isRecord(raw.whip) ? raw.whip : {}),
      enabled: postIssueScope !== "ready",
      usePackageDefaults: postIssueScope === "standard",
      tasks: config.whip.tasks,
      statePath: config.whip.statePath,
    },
  };
}

interface ExistingText {
  readonly exists: boolean;
  readonly content?: string;
  readonly error?: string;
}

interface PlannedFileWrite {
  readonly operation: AiuInitFileOperation;
  readonly reason: string;
  readonly content: string;
}

type SharedHostFile = Extract<AiuManagedHostFile, { readonly ownership: "shared" }>;

function readExistingText(absolutePath: string): ExistingText {
  if (!existsSync(absolutePath)) {
    return { exists: false };
  }
  try {
    return { exists: true, content: readFileSync(absolutePath, "utf8") };
  } catch (error) {
    return {
      exists: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function planSharedJsonWrite(existing: ExistingText, file: SharedHostFile): PlannedFileWrite {
  if (!existing.exists) {
    return { operation: "create", reason: reasonForOperation("create"), content: file.content };
  }
  if (existing.error !== undefined) {
    return { operation: "conflict", reason: `Existing shared file could not be read: ${existing.error}`, content: file.content };
  }

  const existingJson = parseJsonObject(existing.content ?? "");
  if (!existingJson.ok) {
    return {
      operation: "conflict",
      reason: "Existing shared file is not a JSON object. QUBE will not replace it.",
      content: file.content,
    };
  }

  const desiredJson = parseJsonObject(file.content);
  if (!desiredJson.ok) {
    throw new Error(`Managed shared-file content is not a JSON object: ${file.relativePath}`);
  }

  const merged = mergeSharedJson(file.managedEntry, existingJson.value, desiredJson.value);
  if (!merged.ok) {
    return { operation: "conflict", reason: merged.reason, content: file.content };
  }

  const content = stableJson(merged.value);
  if (stableJson(existingJson.value) === content) {
    return {
      operation: "skip",
      reason: "QUBE-owned entries already match; unrelated JSON entries are unchanged.",
      content,
    };
  }
  return {
    operation: "update",
    reason: "QUBE-owned entries will be updated; unrelated JSON entries will be preserved.",
    content,
  };
}

function mergeSharedJson(
  managedEntry: SharedHostFile["managedEntry"],
  existing: Record<string, unknown>,
  desired: Record<string, unknown>,
): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly reason: string } {
  if (managedEntry === "codex-marketplace-plugin") {
    return mergeCodexMarketplace(existing, desired);
  }
  return mergeClaudeSettings(existing, desired);
}

function mergeCodexMarketplace(
  existing: Record<string, unknown>,
  desired: Record<string, unknown>,
): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly reason: string } {
  if (existing.plugins !== undefined && !Array.isArray(existing.plugins)) {
    return { ok: false, reason: "Existing Codex marketplace plugins value is not an array. QUBE will not replace the shared file." };
  }
  if (!Array.isArray(desired.plugins)) {
    throw new Error("Managed Codex marketplace content does not contain a plugins array.");
  }

  const managedPlugin = desired.plugins.find(isAiuMarketplacePlugin);
  if (managedPlugin === undefined) {
    throw new Error("Managed Codex marketplace content does not contain the AI Umpire plugin entry.");
  }

  const existingPlugins = existing.plugins ?? [];
  const plugins: unknown[] = [];
  let managedIndex: number | undefined;
  for (const plugin of existingPlugins) {
    if (isAiuMarketplacePlugin(plugin)) {
      managedIndex ??= plugins.length;
      continue;
    }
    plugins.push(plugin);
  }
  plugins.splice(managedIndex ?? plugins.length, 0, managedPlugin);

  return {
    ok: true,
    value: {
      ...desired,
      ...existing,
      plugins,
    },
  };
}

function mergeClaudeSettings(
  existing: Record<string, unknown>,
  desired: Record<string, unknown>,
): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly reason: string } {
  if (existing.hooks !== undefined && !isRecord(existing.hooks)) {
    return { ok: false, reason: "Existing Claude Code hooks value is not a JSON object. QUBE will not replace the shared file." };
  }
  const desiredHooks = isRecord(desired.hooks) ? desired.hooks : undefined;
  const desiredStop = desiredHooks?.Stop;
  if (!Array.isArray(desiredStop)) {
    throw new Error("Managed Claude Code settings do not contain a Stop hook array.");
  }
  const managedGroup = desiredStop.find(hasAiuClaudeStopHook);
  if (managedGroup === undefined) {
    throw new Error("Managed Claude Code settings do not contain the AI Umpire Stop hook.");
  }

  const existingHooks = isRecord(existing.hooks) ? existing.hooks : {};
  if (existingHooks.Stop !== undefined && !Array.isArray(existingHooks.Stop)) {
    return { ok: false, reason: "Existing Claude Code Stop hooks value is not an array. QUBE will not replace the shared file." };
  }

  const stopGroups: unknown[] = [];
  let managedIndex: number | undefined;
  for (const group of existingHooks.Stop ?? []) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) {
      stopGroups.push(group);
      continue;
    }
    const hooks = group.hooks.filter((hook) => !isAiuClaudeStopHook(hook));
    if (hooks.length === group.hooks.length) {
      stopGroups.push(group);
      continue;
    }
    managedIndex ??= stopGroups.length;
    if (hooks.length > 0) {
      stopGroups.push({ ...group, hooks });
    }
  }
  stopGroups.splice(managedIndex ?? stopGroups.length, 0, managedGroup);

  return {
    ok: true,
    value: {
      ...existing,
      hooks: {
        ...existingHooks,
        Stop: stopGroups,
      },
    },
  };
}

function isAiuMarketplacePlugin(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.name === "ai-umpire") return true;
  return isRecord(value.source) && value.source.path === "./plugins/ai-umpire";
}

function hasAiuClaudeStopHook(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.hooks) && value.hooks.some(isAiuClaudeStopHook);
}

function isAiuClaudeStopHook(value: unknown): boolean {
  return isRecord(value) && value.command === "pnpm exec aiu hook-stop --tool claude-code";
}

function classifyTextWrite(existing: ExistingText, desired: string, force: boolean): { readonly operation: AiuInitFileOperation; readonly reason: string } {
  if (!existing.exists) {
    return { operation: "create", reason: reasonForOperation("create") };
  }
  if (existing.error !== undefined) {
    return { operation: "conflict", reason: `Existing path could not be read: ${existing.error}` };
  }
  if (normalizeText(existing.content ?? "") === normalizeText(desired)) {
    return { operation: "skip", reason: reasonForOperation("skip") };
  }
  const operation = force ? "update" : "conflict";
  return { operation, reason: reasonForOperation(operation) };
}

function classifyConfigWrite(
  existing: ExistingText,
  existingRaw: ReturnType<typeof parseJsonObject>,
  desired: string,
): { readonly operation: AiuInitFileOperation; readonly reason: string } {
  if (!existing.exists) {
    return { operation: "create", reason: reasonForOperation("create") };
  }
  if (existing.error !== undefined) {
    return { operation: "conflict", reason: `Existing config could not be read: ${existing.error}` };
  }
  if (!existingRaw.ok) {
    return { operation: "conflict", reason: "Existing config is not valid JSON." };
  }
  if (stableJson(existingRaw.value) === desired) {
    return { operation: "skip", reason: reasonForOperation("skip") };
  }
  return { operation: "update", reason: "Managed config fields will be updated; unrelated settings will be preserved." };
}

function reasonForOperation(operation: AiuInitFileOperation): string {
  if (operation === "create") return "Managed file does not exist yet.";
  if (operation === "update") return "Existing managed file differs and --force was provided.";
  if (operation === "skip") return "Existing managed file already matches the planned content.";
  return "Existing file differs; preserving it unless --force is provided.";
}

function formatFileGroup(title: string, plan: AiuInitPlan, operation: AiuInitFileOperation): string {
  const files = [...plan.files, plan.config].filter((file) => file.operation === operation);
  return [`${title}:`, ...(files.length === 0 ? ["- none"] : files.map((file) => `- ${file.relativePath}: ${file.reason}`)), ""].join("\n");
}

function parseJsonObject(raw: string): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false } {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? { ok: true, value: parsed } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function readMergedHosts(config: Record<string, unknown>): readonly AiuHost[] {
  const hosts = isRecord(config.hosts) && Array.isArray(config.hosts.enabled) ? config.hosts.enabled : [];
  return hosts.filter((host): host is AiuHost => typeof host === "string" && ["opencode", "codex", "claude-code", "grok-build"].includes(host));
}

function readMergedTrustedStateCommandNames(config: Record<string, unknown>): readonly string[] {
  return isRecord(config.trustedStateCommands) ? Object.keys(config.trustedStateCommands).sort() : [];
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sortJson(entry)]));
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
