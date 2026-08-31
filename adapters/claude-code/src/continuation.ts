import {
  CONTINUATION_ADAPTER_VERSION,
  CONTINUATION_DECLARATION_VERSION,
  defineContinuationAdapter,
  defineContinuationDeclaration,
  probeContinuationSurface,
  type ContinuationAssetMerge,
  type ContinuationAssetValidation,
} from "@tjalve/qube-core";

const settingsAsset = Object.freeze({ id: "settings-stop-hook", relativePath: ".claude/settings.json", description: "Claude Code AI Umpire project Stop hook.", ownership: "shared" as const, role: "entrypoint" as const });

export const claudeCodeContinuationDeclaration = defineContinuationDeclaration({
  version: CONTINUATION_DECLARATION_VERSION,
  hostId: "claude-code",
  nativeSurfaces: Object.freeze([Object.freeze({ id: "stop-hook", minimumVersion: null, maximumVersionExclusive: null })]),
  triggerEvents: Object.freeze(["Stop"]),
  delivery: Object.freeze({ method: "stdout-json", sessionScope: "current-session" }),
  umpireModes: Object.freeze(["continue", "repair", "stop"]),
  trust: Object.freeze({ repositoryRequired: true, description: "Claude Code must trust the project Stop hook." }),
  managedAssets: Object.freeze([settingsAsset]),
  activationEvidence: Object.freeze({ event: "stop-hook", delivery: "stdout", requiresSessionId: true }),
  currentIssueRecovery: true,
});

export const claudeCodeContinuationAdapter = defineContinuationAdapter({
  version: CONTINUATION_ADAPTER_VERSION,
  declaration: claudeCodeContinuationDeclaration,
  renderManagedAssets(context) {
    const command = `${context.commandPrefix ?? "aiu"} hook-stop --tool claude-code`;
    return Object.freeze([Object.freeze({ ...settingsAsset, command, content: stableJson({ hooks: { Stop: [ownedStopGroup(context.commandPrefix)] } }) })]);
  },
  validateManagedAsset: validateClaudeAsset,
  mergeManagedAsset(assetId, existing, desired) {
    if (assetId !== settingsAsset.id) return failedUnknownAsset(assetId);
    const current = validateClaudeAsset(assetId, existing, desired);
    if (current.state === "malformed") return Object.freeze({ ok: false, reason: current.reason, validation: current });
    const parsed = parseJsonObject(existing);
    if (!parsed.ok) return Object.freeze({ ok: false, reason: current.reason, validation: current });
    if (parsed.value.hooks !== undefined && !isRecord(parsed.value.hooks)) return failedMalformed("Existing Claude Code hooks value is not a JSON object. QUBE will not replace the shared file.");
    const existingHooks = isRecord(parsed.value.hooks) ? parsed.value.hooks : {};
    if (existingHooks.Stop !== undefined && !Array.isArray(existingHooks.Stop)) return failedMalformed("Existing Claude Code Stop hooks value is not an array. QUBE will not replace the shared file.");
    const stopGroups: unknown[] = [];
    let managedIndex: number | undefined;
    for (const group of existingHooks.Stop ?? []) {
      if (!isRecord(group) || !Array.isArray(group.hooks) || group.hooks.some((hook) => !isRecord(hook))) return failedMalformed("Claude Code Stop hook groups and hooks must use JSON object and array shapes. QUBE will not replace the shared file.");
      const hooks = group.hooks.filter((hook) => !isOwnedStopHook(hook));
      if (hooks.length === group.hooks.length) { stopGroups.push(group); continue; }
      managedIndex ??= stopGroups.length;
      if (hooks.length > 0) stopGroups.push({ ...group, hooks });
    }
    const desiredValue = parseJsonObject(desired.content);
    const desiredGroups = desiredValue.ok && isRecord(desiredValue.value.hooks) && Array.isArray(desiredValue.value.hooks.Stop)
      ? desiredValue.value.hooks.Stop
      : [];
    const desiredManagedGroup = desiredGroups.find((group) => isRecord(group) && Array.isArray(group.hooks) && group.hooks.some(isOwnedStopHook));
    if (!desiredManagedGroup) return failedMalformed("Desired Claude Code Stop hook is missing.");
    stopGroups.splice(managedIndex ?? stopGroups.length, 0, desiredManagedGroup);
    const content = stableJson({ ...parsed.value, hooks: { ...existingHooks, Stop: stopGroups } });
    return Object.freeze({ ok: true, content, changed: stableJson(parsed.value) !== content, validation: current });
  },
  decodeEvent(input) {
    if (!isRecord(input)) return malformed("Claude Code Stop input must be a JSON object.");
    const error = validateClaudePayload(input);
    if (error) return malformed(error);
    return Object.freeze({ ok: true, event: Object.freeze({ event: "Stop", cwd: String(input.cwd), sessionId: String(input.session_id), stopHookActive: input.stop_hook_active === true }) });
  },
  encodeResponse(input) {
    if (input.decision === "allow") return Object.freeze({ ok: true, response: Object.freeze({}) });
    if (input.decision !== "block" || !input.prompt?.trim()) return Object.freeze({ ok: false, error: "Claude Code Stop blocking requires a non-empty continuation prompt." });
    return Object.freeze({ ok: true, response: Object.freeze({ decision: "block", reason: input.prompt }) });
  },
  probe(input) { return probeContinuationSurface(claudeCodeContinuationDeclaration, input); },
});

function validateClaudeAsset(assetId: string, existing: string | undefined, desired: { readonly content: string }): ContinuationAssetValidation {
    if (assetId !== settingsAsset.id) return unknownAsset(assetId);
    if (existing === undefined) return validation("missing", "Managed host file is missing.");
    const parsed = parseJsonObject(existing);
    if (!parsed.ok) return validation("malformed", "Existing shared file is not a JSON object. QUBE will not replace it.");
    if (parsed.value.hooks === undefined) return validation("missing", "The managed Claude Code Stop hook is missing.");
    if (!isRecord(parsed.value.hooks)) return validation("malformed", "Existing Claude Code hooks value is not a JSON object. QUBE will not replace the shared file.");
    if (parsed.value.hooks.Stop === undefined) return validation("missing", "The managed Claude Code Stop hook is missing.");
    if (!Array.isArray(parsed.value.hooks.Stop)) return validation("malformed", "Existing Claude Code Stop hooks value is not an array. QUBE will not replace the shared file.");
    const hooks = collectOwnedHooks(parsed.value.hooks.Stop);
    if (!hooks.ok) return validation("malformed", hooks.error);
    if (hooks.values.length === 0) return validation("missing", "The managed Claude Code Stop hook is missing.");
    if (hooks.values.length > 1) return validation("duplicate", "Claude Code settings contain duplicate managed Stop hooks.");
    const desiredValue = parseJsonObject(desired.content);
    const desiredHooks = desiredValue.ok && isRecord(desiredValue.value.hooks) && Array.isArray(desiredValue.value.hooks.Stop)
      ? collectOwnedHooks(desiredValue.value.hooks.Stop)
      : { ok: false as const, error: "Desired Claude Code Stop hook is malformed." };
    if (!desiredHooks.ok || desiredHooks.values.length !== 1) return validation("malformed", desiredHooks.ok ? "Desired Claude Code Stop hook is missing." : desiredHooks.error);
    return jsonEquals(hooks.values[0], desiredHooks.values[0])
      ? validation("current", "The managed Claude Code Stop hook is canonical.")
      : validation("conflicting", "The managed Claude Code Stop hook conflicts with package content.");
}

function validateClaudePayload(input: Record<string, unknown>): string | undefined {
  for (const key of ["cwd", "hook_event_name", "session_id", "turn_id", "permission_mode", "model"] as const) {
    if (typeof input[key] !== "string" || input[key].length === 0) return `${key} must be a non-empty string.`;
  }
  if (input.hook_event_name !== "Stop") return "Unsupported hook event; expected Stop.";
  if (typeof input.stop_hook_active !== "boolean") return "stop_hook_active must be a boolean.";
  if (!isOptionalNullableString(input.transcript_path)) return "transcript_path must be a string or null.";
  if (!isOptionalNullableString(input.last_assistant_message)) return "last_assistant_message must be a string or null.";
  return undefined;
}

function ownedStopHook(commandPrefix?: string): Record<string, unknown> { return { command: `${commandPrefix ?? "aiu"} hook-stop --tool claude-code`, type: "command" }; }
function ownedStopGroup(commandPrefix?: string): Record<string, unknown> { return { hooks: [ownedStopHook(commandPrefix)] }; }
function isOwnedStopHook(value: unknown): value is Record<string, unknown> { return isRecord(value) && typeof value.command === "string" && /\baiu(?:\.(?:cmd|exe))?["']?\s+hook-stop\b/i.test(value.command); }
function collectOwnedHooks(groups: unknown[]): { readonly ok: true; readonly values: Record<string, unknown>[] } | { readonly ok: false; readonly error: string } { const values: Record<string, unknown>[] = []; for (const group of groups) { if (!isRecord(group) || !Array.isArray(group.hooks) || group.hooks.some((hook) => !isRecord(hook))) return { ok: false, error: "Claude Code Stop hook groups and hooks must use JSON object and array shapes." }; values.push(...group.hooks.filter(isOwnedStopHook)); } return { ok: true, values }; }
function malformed(error: string) { return Object.freeze({ ok: false as const, code: "malformed-event" as const, error }); }
function validation(state: ContinuationAssetValidation["state"], reason: string): ContinuationAssetValidation { return Object.freeze({ state, reason }); }
function unknownAsset(assetId: string): ContinuationAssetValidation { return validation("malformed", `Unknown Claude Code continuation asset: ${assetId}.`); }
function failedUnknownAsset(assetId: string): ContinuationAssetMerge { const result = unknownAsset(assetId); return Object.freeze({ ok: false, reason: result.reason, validation: result }); }
function failedMalformed(reason: string): ContinuationAssetMerge { const result = validation("malformed", reason); return Object.freeze({ ok: false, reason, validation: result }); }
function isOptionalNullableString(value: unknown): boolean { return value === undefined || value === null || typeof value === "string"; }
function jsonEquals(left: unknown, right: unknown): boolean { return stableJson(left) === stableJson(right); }
function parseJsonObject(content: string): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false } { try { const value = JSON.parse(content) as unknown; return isRecord(value) ? { ok: true, value } : { ok: false }; } catch { return { ok: false }; } }
function stableJson(value: unknown): string { return `${JSON.stringify(sortJson(value), null, 2)}\n`; }
function sortJson(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortJson); if (!isRecord(value)) return value; return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sortJson(entry)])); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
