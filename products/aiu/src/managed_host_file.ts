import type { AiuManagedHostFile } from "./host_policy.js";

export const MANAGED_HOST_FILE_STATES = ["current", "missing", "duplicate", "malformed", "conflicting"] as const;

export type ManagedHostFileState = (typeof MANAGED_HOST_FILE_STATES)[number];

export interface ManagedHostFileValidation {
  readonly state: ManagedHostFileState;
  readonly reason: string;
}

export type SharedManagedHostFile = Extract<AiuManagedHostFile, { readonly ownership: "shared" }>;

export type ManagedHostFileMerge =
  | {
      readonly ok: true;
      readonly content: string;
      readonly changed: boolean;
      readonly validation: ManagedHostFileValidation;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly validation: ManagedHostFileValidation;
    };

export function validateManagedHostFile(existing: string | undefined, file: AiuManagedHostFile): ManagedHostFileValidation {
  if (existing === undefined) {
    return validation("missing", "Managed host file is missing.");
  }
  if (file.ownership === "dedicated") {
    return normalizeText(existing) === normalizeText(file.content)
      ? validation("current", "Dedicated managed file matches package content.")
      : validation("conflicting", "Dedicated managed file differs from package content.");
  }

  const existingJson = parseJsonObject(existing);
  if (!existingJson.ok) {
    return validation("malformed", "Existing shared file is not a JSON object. QUBE will not replace it.");
  }
  const desiredJson = requiredManagedJson(file);
  return validateSharedJson(file.managedEntry, existingJson.value, desiredJson);
}

export function mergeManagedHostFile(existing: string, file: SharedManagedHostFile): ManagedHostFileMerge {
  const current = validateManagedHostFile(existing, file);
  if (current.state === "malformed") {
    return { ok: false, reason: current.reason, validation: current };
  }

  const existingJson = parseJsonObject(existing);
  if (!existingJson.ok) {
    return { ok: false, reason: current.reason, validation: current };
  }
  if (current.state === "current") {
    return {
      ok: true,
      content: stableJson(existingJson.value),
      changed: false,
      validation: current,
    };
  }
  const desiredJson = requiredManagedJson(file);
  const merged = mergeSharedJson(file.managedEntry, existingJson.value, desiredJson);
  if (!merged.ok) {
    return { ok: false, reason: merged.reason, validation: validation("malformed", merged.reason) };
  }
  const content = stableJson(merged.value);
  return {
    ok: true,
    content,
    changed: stableJson(existingJson.value) !== content,
    validation: current,
  };
}

function validateSharedJson(
  managedEntry: SharedManagedHostFile["managedEntry"],
  existing: Record<string, unknown>,
  desired: Record<string, unknown>,
): ManagedHostFileValidation {
  if (managedEntry === "opencode-package-dependency") {
    const dependencies = existing.dependencies;
    if (dependencies === undefined) return validation("missing", "The managed OpenCode package dependency is missing.");
    if (!isRecord(dependencies)) return validation("malformed", "Existing OpenCode dependencies value is not a JSON object. QUBE will not replace the shared file.");
    const expected = expectedOpenCodeVersion(desired);
    const actual = dependencies["@tjalve/aiu"];
    if (actual === undefined) return validation("missing", "The managed OpenCode package dependency is missing.");
    return actual === expected
      ? validation("current", "The managed OpenCode package dependency is canonical.")
      : validation("conflicting", "The managed OpenCode package dependency has a conflicting version.");
  }

  if (managedEntry === "codex-marketplace-plugin") {
    if (existing.plugins === undefined) return validation("missing", "The managed Codex marketplace plugin is missing.");
    if (!Array.isArray(existing.plugins) || existing.plugins.some((plugin) => !isRecord(plugin))) {
      return validation("malformed", "Existing Codex marketplace plugins value is not an array of JSON objects. QUBE will not replace the shared file.");
    }
    const expected = expectedCodexPlugin(desired);
    const managed = existing.plugins.filter(isOwnedCodexPlugin);
    if (managed.length === 0) return validation("missing", "The managed Codex marketplace plugin is missing.");
    if (managed.length > 1) return validation("duplicate", "The Codex marketplace contains duplicate managed plugin entries.");
    return jsonEquals(managed[0], expected)
      ? validation("current", "The managed Codex marketplace plugin is canonical.")
      : validation("conflicting", "The managed Codex marketplace plugin conflicts with package content.");
  }

  if (existing.hooks === undefined) return validation("missing", "The managed Claude Code Stop hook is missing.");
  if (!isRecord(existing.hooks)) return validation("malformed", "Existing Claude Code hooks value is not a JSON object. QUBE will not replace the shared file.");
  if (existing.hooks.Stop === undefined) return validation("missing", "The managed Claude Code Stop hook is missing.");
  if (!Array.isArray(existing.hooks.Stop)) return validation("malformed", "Existing Claude Code Stop hooks value is not an array. QUBE will not replace the shared file.");

  const managedHooks: Record<string, unknown>[] = [];
  for (const group of existing.hooks.Stop) {
    if (!isRecord(group) || !Array.isArray(group.hooks) || group.hooks.some((hook) => !isRecord(hook))) {
      return validation("malformed", "Claude Code Stop hook groups and hooks must use JSON object and array shapes.");
    }
    managedHooks.push(...group.hooks.filter(isOwnedClaudeStopHook));
  }
  if (managedHooks.length === 0) return validation("missing", "The managed Claude Code Stop hook is missing.");
  if (managedHooks.length > 1) return validation("duplicate", "Claude Code settings contain duplicate managed Stop hooks.");
  return jsonEquals(managedHooks[0], expectedClaudeStopHook(desired))
    ? validation("current", "The managed Claude Code Stop hook is canonical.")
    : validation("conflicting", "The managed Claude Code Stop hook conflicts with package content.");
}

function mergeSharedJson(
  managedEntry: SharedManagedHostFile["managedEntry"],
  existing: Record<string, unknown>,
  desired: Record<string, unknown>,
): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly reason: string } {
  if (managedEntry === "opencode-package-dependency") {
    if (existing.dependencies !== undefined && !isRecord(existing.dependencies)) {
      return { ok: false, reason: "Existing OpenCode dependencies value is not a JSON object. QUBE will not replace the shared file." };
    }
    return {
      ok: true,
      value: {
        ...desired,
        ...existing,
        dependencies: {
          ...(isRecord(existing.dependencies) ? existing.dependencies : {}),
          "@tjalve/aiu": expectedOpenCodeVersion(desired),
        },
      },
    };
  }

  if (managedEntry === "codex-marketplace-plugin") {
    if (existing.plugins !== undefined && (!Array.isArray(existing.plugins) || existing.plugins.some((plugin) => !isRecord(plugin)))) {
      return { ok: false, reason: "Existing Codex marketplace plugins value is not an array of JSON objects. QUBE will not replace the shared file." };
    }
    const plugins: unknown[] = [];
    let managedIndex: number | undefined;
    for (const plugin of existing.plugins ?? []) {
      if (isOwnedCodexPlugin(plugin)) {
        managedIndex ??= plugins.length;
        continue;
      }
      plugins.push(plugin);
    }
    plugins.splice(managedIndex ?? plugins.length, 0, expectedCodexPlugin(desired));
    return { ok: true, value: { ...existing, plugins } };
  }

  if (existing.hooks !== undefined && !isRecord(existing.hooks)) {
    return { ok: false, reason: "Existing Claude Code hooks value is not a JSON object. QUBE will not replace the shared file." };
  }
  const existingHooks = isRecord(existing.hooks) ? existing.hooks : {};
  if (existingHooks.Stop !== undefined && !Array.isArray(existingHooks.Stop)) {
    return { ok: false, reason: "Existing Claude Code Stop hooks value is not an array. QUBE will not replace the shared file." };
  }

  const stopGroups: unknown[] = [];
  let managedIndex: number | undefined;
  for (const group of existingHooks.Stop ?? []) {
    if (!isRecord(group) || !Array.isArray(group.hooks) || group.hooks.some((hook) => !isRecord(hook))) {
      return { ok: false, reason: "Existing Claude Code Stop hook groups and hooks must use JSON object and array shapes. QUBE will not replace the shared file." };
    }
    const hooks = group.hooks.filter((hook) => !isOwnedClaudeStopHook(hook));
    if (hooks.length === group.hooks.length) {
      stopGroups.push(group);
      continue;
    }
    managedIndex ??= stopGroups.length;
    if (hooks.length > 0) stopGroups.push({ ...group, hooks });
  }
  stopGroups.splice(managedIndex ?? stopGroups.length, 0, expectedClaudeStopGroup(desired));
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

function requiredManagedJson(file: SharedManagedHostFile): Record<string, unknown> {
  const parsed = parseJsonObject(file.content);
  if (!parsed.ok) throw new Error(`Managed shared-file content is not a JSON object: ${file.relativePath}`);
  return parsed.value;
}

function expectedOpenCodeVersion(desired: Record<string, unknown>): string {
  const dependencies = isRecord(desired.dependencies) ? desired.dependencies : undefined;
  const version = dependencies?.["@tjalve/aiu"];
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("Managed OpenCode package content does not contain an exact @tjalve/aiu dependency.");
  }
  return version;
}

function expectedCodexPlugin(desired: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(desired.plugins)) {
    throw new Error("Managed Codex marketplace content does not contain a plugins array.");
  }
  const plugin = desired.plugins.find(isOwnedCodexPlugin);
  if (!isRecord(plugin)) {
    throw new Error("Managed Codex marketplace content does not contain the AI Umpire plugin entry.");
  }
  return plugin;
}

function expectedClaudeStopGroup(desired: Record<string, unknown>): Record<string, unknown> {
  const hooks = isRecord(desired.hooks) ? desired.hooks : undefined;
  if (!Array.isArray(hooks?.Stop)) {
    throw new Error("Managed Claude Code settings do not contain a Stop hook array.");
  }
  const group = hooks.Stop.find((entry) => isRecord(entry) && Array.isArray(entry.hooks) && entry.hooks.some(isOwnedClaudeStopHook));
  if (!isRecord(group)) {
    throw new Error("Managed Claude Code settings do not contain the AI Umpire Stop hook.");
  }
  return group;
}

function expectedClaudeStopHook(desired: Record<string, unknown>): Record<string, unknown> {
  const group = expectedClaudeStopGroup(desired);
  const hook = Array.isArray(group.hooks) ? group.hooks.find(isOwnedClaudeStopHook) : undefined;
  if (!isRecord(hook)) {
    throw new Error("Managed Claude Code settings do not contain the AI Umpire Stop hook.");
  }
  return hook;
}

function isOwnedCodexPlugin(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (value.name === "ai-umpire") return true;
  return isRecord(value.source) && value.source.path === "./plugins/ai-umpire";
}

function isOwnedClaudeStopHook(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || typeof value.command !== "string") return false;
  return /(?:^|\s)aiu\s+hook-stop(?:\s|$)/.test(value.command);
}

function parseJsonObject(content: string): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false } {
  try {
    const value = JSON.parse(content) as unknown;
    return isRecord(value) ? { ok: true, value } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function validation(state: ManagedHostFileState, reason: string): ManagedHostFileValidation {
  return Object.freeze({ state, reason });
}

function jsonEquals(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right));
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sortJson(entry)]));
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
