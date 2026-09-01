import { createHash } from "node:crypto";
import { constants, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, closeSync } from "node:fs";
import path from "node:path";

import type { AiuConfig, AiuHost } from "./config.js";
import type { AiuContinuationDecision, AiuDecisionSelectedItem, AiuDecisionSourceSummary } from "./decision.js";
import type { AiuContinuationPrompt } from "./prompt.js";

export interface AiuContinuationPaths {
  readonly stateDir: string;
  readonly lockDir: string;
  readonly logDir: string;
  readonly statePath: string;
  readonly lockPath: string;
  readonly logPath: string;
}

export interface AiuHostActivation {
  readonly schemaVersion: 2;
  readonly contractVersion: 1;
  readonly host: AiuHost;
  readonly delivery: "host" | "stdout";
  readonly event: "plugin-event" | "stop-hook";
  readonly eventState: "consumed";
  readonly harnessVersion: string;
  readonly surface: string;
  readonly packedArtifactDigest: string;
  readonly managedAssetDigest: string;
  readonly relevantConfigDigest: string;
  readonly trustedStateFingerprint: string;
  readonly sessionId?: string;
  readonly observedAt: string;
}

export interface AiuContinuationState {
  readonly schemaVersion: 2;
  readonly deliveryState: "reserved" | "emitted" | "consumed";
  readonly hostId: AiuHost;
  readonly eventType: string;
  readonly ownerSessionId?: string;
  readonly targetSessionId?: string;
  readonly selectedItem?: AiuDecisionSelectedItem;
  readonly mode: AiuContinuationDecision["selectedMode"];
  readonly decisionKind: AiuContinuationDecision["kind"];
  readonly reasonCodes: readonly string[];
  readonly lastPromptFingerprint?: string;
  readonly pendingPromptFingerprint?: string;
  readonly lastPromptAt?: string;
  readonly pendingPromptAt?: string;
  readonly nativeLoopCount: number;
  readonly updatedAt: string;
  readonly sourceSummaries: readonly AiuDecisionSourceSummary[];
}

export interface AiuContinuationLock {
  readonly schemaVersion: 1;
  readonly ownerId: string;
  readonly eventType: string;
  readonly sessionId?: string;
  readonly acquiredAt: string;
}

export interface AiuContinuationLockHandle {
  readonly acquired: true;
  readonly ownerId: string;
  readonly staleRecovered: boolean;
  readonly staleLock?: AiuContinuationLock;
}

export interface AiuContinuationLockBlocked {
  readonly acquired: false;
  readonly reason: "lock-held";
  readonly lock?: AiuContinuationLock;
}

export type AiuContinuationLockResult = AiuContinuationLockHandle | AiuContinuationLockBlocked;

export interface AiuContinuationLogEntry {
  readonly event: string;
  readonly observedAt: string;
  readonly eventType?: string;
  readonly hostId?: string;
  readonly sessionId?: string;
  readonly selectedSessionId?: string;
  readonly decisionId?: string;
  readonly decisionKind?: string;
  readonly mode?: string;
  readonly promptKind?: string;
  readonly selectedItem?: AiuDecisionSelectedItem;
  readonly reasonCodes?: readonly string[];
  readonly promptFingerprint?: string;
  readonly targetSessionId?: string;
  readonly deliveryState?: AiuContinuationState["deliveryState"];
  readonly nativeLoopCount?: number;
  readonly sourceSummaries?: readonly AiuDecisionSourceSummary[];
  readonly adapterErrors?: readonly string[];
  readonly suppressions?: readonly string[];
  readonly elapsedMs?: number;
  readonly message?: string;
}

const STATE_FILENAME = "continuation.json";
const LOCK_FILENAME = "continuation.lock";
const LOG_FILENAME = "continuation.jsonl";
const HOST_ACTIVATION_DIRECTORY = "host-activation";
const MAX_LOG_BYTES = 64 * 1024;
const MAX_LOG_ENTRY_BYTES = 8 * 1024;

export function resolveAiuContinuationPaths(repoRoot: string, config: Pick<AiuConfig, "paths">): AiuContinuationPaths {
  const stateDir = path.resolve(repoRoot, config.paths.stateDir);
  const lockDir = path.resolve(repoRoot, config.paths.lockDir);
  const logDir = path.resolve(repoRoot, config.paths.logDir);
  return Object.freeze({
    stateDir,
    lockDir,
    logDir,
    statePath: path.join(stateDir, STATE_FILENAME),
    lockPath: path.join(lockDir, LOCK_FILENAME),
    logPath: path.join(logDir, LOG_FILENAME),
  });
}

export function readAiuContinuationState(paths: Pick<AiuContinuationPaths, "statePath">): AiuContinuationState | undefined {
  const result = inspectAiuContinuationState(paths);
  return result.status === "ready" ? result.state : undefined;
}

export type AiuContinuationStateRead =
  | Readonly<{ status: "ready"; state: AiuContinuationState }>
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "invalid"; reason: string }>;

export function inspectAiuContinuationState(paths: Pick<AiuContinuationPaths, "statePath">): AiuContinuationStateRead {
  try {
    const parsed = JSON.parse(readFileSync(paths.statePath, "utf8")) as unknown;
    const state = normalizeContinuationState(parsed);
    return state
      ? Object.freeze({ status: "ready" as const, state })
      : Object.freeze({ status: "invalid" as const, reason: "Continuation state does not match schema version 2." });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return Object.freeze({ status: "missing" as const });
    }
    return Object.freeze({
      status: "invalid" as const,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export function writeAiuContinuationState(paths: Pick<AiuContinuationPaths, "stateDir" | "statePath">, state: AiuContinuationState): void {
  mkdirSync(paths.stateDir, { recursive: true });
  const tempPath = `${paths.statePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tempPath, paths.statePath);
}

export function resolveAiuHostActivationPath(
  paths: Pick<AiuContinuationPaths, "stateDir">,
  host: AiuHost,
): string {
  return path.join(paths.stateDir, HOST_ACTIVATION_DIRECTORY, `${host}.json`);
}

export function readAiuHostActivation(
  paths: Pick<AiuContinuationPaths, "stateDir">,
  host: AiuHost,
): AiuHostActivation | undefined {
  try {
    const parsed = JSON.parse(readFileSync(resolveAiuHostActivationPath(paths, host), "utf8")) as unknown;
    return normalizeHostActivation(parsed, host);
  } catch {
    return undefined;
  }
}

export function writeAiuHostActivation(
  paths: Pick<AiuContinuationPaths, "stateDir">,
  activation: AiuHostActivation,
): void {
  const activationPath = resolveAiuHostActivationPath(paths, activation.host);
  const activationDirectory = path.dirname(activationPath);
  mkdirSync(activationDirectory, { recursive: true });
  const tempPath = `${activationPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(activation, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tempPath, activationPath);
}

export function createAiuTrustedStateFingerprint(commands: AiuConfig["trustedStateCommands"]): string {
  const normalized = Object.entries(commands)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sourceId, descriptor]) => ({
      sourceId,
      argv: [...descriptor.argv],
      cwd: descriptor.cwd ?? null,
      timeoutMs: descriptor.timeoutMs ?? null,
      maxOutputBytes: descriptor.maxOutputBytes ?? null,
    }));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function buildAiuContinuationState(input: {
  readonly observedAt: string;
  readonly hostId: AiuHost;
  readonly eventType: string;
  readonly ownerSessionId?: string;
  readonly targetSessionId?: string;
  readonly decision: AiuContinuationDecision;
  readonly prompt: AiuContinuationPrompt;
  readonly previous?: AiuContinuationState;
  readonly nativeDelivery?: boolean;
}): AiuContinuationState {
  const nativeLoopCount = calculateAiuNativeLoopCount(input.previous, input);
  return Object.freeze({
    schemaVersion: 2 as const,
    deliveryState: "reserved" as const,
    hostId: input.hostId,
    eventType: input.eventType,
    ...(input.ownerSessionId ? { ownerSessionId: input.ownerSessionId } : {}),
    ...(input.targetSessionId ? { targetSessionId: input.targetSessionId } : {}),
    ...(input.decision.selectedItem ? { selectedItem: Object.freeze({ ...input.decision.selectedItem }) } : {}),
    mode: input.decision.selectedMode,
    decisionKind: input.decision.kind,
    reasonCodes: Object.freeze([...input.decision.reasonCodes]),
    ...(input.previous?.lastPromptFingerprint ? { lastPromptFingerprint: input.previous.lastPromptFingerprint } : {}),
    pendingPromptFingerprint: input.prompt.fingerprint,
    ...(input.previous?.lastPromptAt ? { lastPromptAt: input.previous.lastPromptAt } : {}),
    pendingPromptAt: input.observedAt,
    nativeLoopCount,
    updatedAt: input.observedAt,
    sourceSummaries: Object.freeze(input.decision.sourceSummaries.map((source) => Object.freeze({ ...source }))),
  });
}

export function markAiuContinuationEmitted(state: AiuContinuationState, observedAt: string): AiuContinuationState {
  return Object.freeze({
    ...state,
    deliveryState: "emitted" as const,
    ...(state.pendingPromptFingerprint ? { lastPromptFingerprint: state.pendingPromptFingerprint } : {}),
    ...(state.pendingPromptAt ? { lastPromptAt: state.pendingPromptAt } : {}),
    updatedAt: observedAt,
  });
}

export function markAiuContinuationConsumed(state: AiuContinuationState, observedAt: string): AiuContinuationState {
  const {
    pendingPromptFingerprint: _pendingPromptFingerprint,
    pendingPromptAt: _pendingPromptAt,
    ...persisted
  } = state;
  return Object.freeze({
    ...persisted,
    deliveryState: "consumed" as const,
    updatedAt: observedAt,
  });
}

export function acquireAiuContinuationLock(input: {
  readonly paths: Pick<AiuContinuationPaths, "lockDir" | "lockPath">;
  readonly observedAt: string;
  readonly eventType: string;
  readonly sessionId?: string;
  readonly staleAfterMs: number;
}): AiuContinuationLockResult {
  mkdirSync(input.paths.lockDir, { recursive: true });
  const ownerId = decisionId([input.eventType, input.sessionId ?? "", input.observedAt]);
  const lock: AiuContinuationLock = Object.freeze({
    schemaVersion: 1 as const,
    ownerId,
    eventType: input.eventType,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    acquiredAt: input.observedAt,
  });

  const first = tryCreateLock(input.paths.lockPath, lock);
  if (first.created) {
    return Object.freeze({ acquired: true as const, ownerId, staleRecovered: false });
  }

  const existing = readAiuContinuationLock(input.paths.lockPath);
  if (existing && isLockStale(existing, input.observedAt, input.staleAfterMs)) {
    const recoveredLock = recoverStaleLock(input.paths.lockPath, existing);
    if (!recoveredLock.recovered) {
      return Object.freeze({ acquired: false as const, reason: "lock-held" as const, ...(recoveredLock.lock ? { lock: recoveredLock.lock } : {}) });
    }
    const recovered = tryCreateLock(input.paths.lockPath, lock);
    if (recovered.created) {
      return Object.freeze({ acquired: true as const, ownerId, staleRecovered: true, staleLock: existing });
    }
  }

  return Object.freeze({ acquired: false as const, reason: "lock-held" as const, ...(existing ? { lock: existing } : {}) });
}

export function releaseAiuContinuationLock(paths: Pick<AiuContinuationPaths, "lockPath">, handle: AiuContinuationLockHandle): void {
  const existing = readAiuContinuationLock(paths.lockPath);
  if (existing?.ownerId === handle.ownerId) {
    rmSync(paths.lockPath, { force: true });
  }
}

export function appendAiuContinuationLog(paths: Pick<AiuContinuationPaths, "logDir" | "logPath">, entry: AiuContinuationLogEntry): void {
  mkdirSync(paths.logDir, { recursive: true });
  const line = `${boundLogEntry(entry)}\n`;
  rotateLogIfNeeded(paths.logPath, Buffer.byteLength(line, "utf8"));
  writeFileSync(paths.logPath, line, { encoding: "utf8", flag: "a", mode: 0o600 });
}

export function continuationPromptIsDuplicate(state: AiuContinuationState | undefined, prompt: AiuContinuationPrompt): boolean {
  return state?.lastPromptFingerprint === prompt.fingerprint
    || (state?.deliveryState === "emitted" && state.pendingPromptFingerprint === prompt.fingerprint);
}

export function continuationPromptOwnedByOtherSession(state: AiuContinuationState | undefined, sessionId: string | undefined): boolean {
  return Boolean(state
    && state.deliveryState === "emitted"
    && state.pendingPromptFingerprint
    && state.ownerSessionId
    && sessionId
    && state.ownerSessionId !== sessionId);
}

export function continuationPromptTargetsSameItem(state: AiuContinuationState | undefined, prompt: AiuContinuationPrompt): boolean {
  const hasDeliveredPrompt = Boolean(state?.lastPromptFingerprint
    || (state?.deliveryState === "emitted" && state.pendingPromptFingerprint));
  if (!hasDeliveredPrompt || !state?.selectedItem || !prompt.selectedItem) {
    return false;
  }
  return state.decisionKind === prompt.decisionKind
    && state.selectedItem.kind === prompt.selectedItem.kind
    && state.selectedItem.id === prompt.selectedItem.id
    && state.selectedItem.sourceId === prompt.selectedItem.sourceId;
}

export function continuationTargetsSession(
  state: AiuContinuationState | undefined,
  targetSessionId: string | undefined,
): boolean {
  return Boolean(state
    && state.deliveryState === "emitted"
    && state.pendingPromptFingerprint
    && targetSessionId
    && (state.targetSessionId ?? state.ownerSessionId) === targetSessionId);
}

export function persistedLastPromptAt(state: AiuContinuationState | undefined): string | undefined {
  return state?.lastPromptAt ?? (state?.deliveryState === "emitted" ? state.pendingPromptAt : undefined);
}

export function calculateAiuNativeLoopCount(
  previous: AiuContinuationState | undefined,
  input: {
    readonly ownerSessionId?: string;
    readonly targetSessionId?: string;
    readonly decision: AiuContinuationDecision;
    readonly nativeDelivery?: boolean;
  },
): number {
  if (input.nativeDelivery !== true) return 0;
  return continuesNativeLoop(previous, input) ? previous!.nativeLoopCount + 1 : 1;
}

export function createAiuDecisionId(input: {
  readonly observedAt: string;
  readonly eventType: string;
  readonly sessionId?: string;
  readonly promptFingerprint?: string;
  readonly reasonCodes?: readonly string[];
}): string {
  return decisionId([input.observedAt, input.eventType, input.sessionId ?? "", input.promptFingerprint ?? "", ...(input.reasonCodes ?? [])]);
}

function normalizeHostActivation(value: unknown, expectedHost: AiuHost): AiuHostActivation | undefined {
  if (!isRecord(value)
    || value.schemaVersion !== 2
    || value.contractVersion !== 1
    || value.host !== expectedHost
    || (value.delivery !== "host" && value.delivery !== "stdout")
    || (value.event !== "plugin-event" && value.event !== "stop-hook")
    || value.eventState !== "consumed"
    || typeof value.harnessVersion !== "string"
    || value.harnessVersion.trim().length === 0
    || typeof value.surface !== "string"
    || value.surface.trim().length === 0
    || !validDigest(value.packedArtifactDigest)
    || !validDigest(value.managedAssetDigest)
    || !validDigest(value.relevantConfigDigest)
    || typeof value.trustedStateFingerprint !== "string"
    || !/^[a-f0-9]{64}$/.test(value.trustedStateFingerprint)
    || (value.sessionId !== undefined && (typeof value.sessionId !== "string" || value.sessionId.trim().length === 0))
    || typeof value.observedAt !== "string"
    || !Number.isFinite(Date.parse(value.observedAt))) {
    return undefined;
  }
  return Object.freeze({
    schemaVersion: 2 as const,
    contractVersion: 1 as const,
    host: expectedHost,
    delivery: value.delivery,
    event: value.event,
    eventState: "consumed" as const,
    harnessVersion: value.harnessVersion,
    surface: value.surface,
    packedArtifactDigest: value.packedArtifactDigest,
    managedAssetDigest: value.managedAssetDigest,
    relevantConfigDigest: value.relevantConfigDigest,
    trustedStateFingerprint: value.trustedStateFingerprint,
    ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
    observedAt: value.observedAt,
  });
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function tryCreateLock(lockPath: string, lock: AiuContinuationLock): { readonly created: true } | { readonly created: false; readonly reason: "exists" } {
  let fd: number | undefined;
  try {
    fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(fd, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
    return { created: true };
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      return { created: false, reason: "exists" };
    }
    throw error;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function recoverStaleLock(lockPath: string, expected: AiuContinuationLock): { readonly recovered: true } | { readonly recovered: false; readonly lock?: AiuContinuationLock } {
  const latest = readAiuContinuationLock(lockPath);
  if (!sameLock(latest, expected)) {
    return Object.freeze({ recovered: false as const, ...(latest ? { lock: latest } : {}) });
  }

  const stalePath = `${lockPath}.${expected.ownerId}.stale`;
  rmSync(stalePath, { force: true });
  try {
    renameSync(lockPath, stalePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return Object.freeze({ recovered: false as const });
    }
    throw error;
  }

  const moved = readAiuContinuationLock(stalePath);
  if (!sameLock(moved, expected)) {
    try {
      renameSync(stalePath, lockPath);
    } catch {
      // Best effort: if restore fails, acquisition below will still use exclusive create.
    }
    return Object.freeze({ recovered: false as const, ...(moved ? { lock: moved } : {}) });
  }
  rmSync(stalePath, { force: true });
  return Object.freeze({ recovered: true as const });
}

function readAiuContinuationLock(lockPath: string): AiuContinuationLock | undefined {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as unknown;
    return normalizeContinuationLock(parsed);
  } catch {
    return undefined;
  }
}

function isLockStale(lock: AiuContinuationLock, observedAt: string, staleAfterMs: number): boolean {
  const acquired = Date.parse(lock.acquiredAt);
  const now = Date.parse(observedAt);
  return Number.isFinite(acquired) && Number.isFinite(now) && now - acquired >= staleAfterMs;
}

function sameLock(left: AiuContinuationLock | undefined, right: AiuContinuationLock | undefined): boolean {
  return Boolean(left && right
    && left.ownerId === right.ownerId
    && left.eventType === right.eventType
    && left.sessionId === right.sessionId
    && left.acquiredAt === right.acquiredAt);
}

function rotateLogIfNeeded(logPath: string, incomingBytes: number): void {
  if (!existsSync(logPath)) return;
  const size = statSync(logPath).size;
  if (size + incomingBytes <= MAX_LOG_BYTES) return;
  rmSync(`${logPath}.1`, { force: true });
  renameSync(logPath, `${logPath}.1`);
}

function boundLogEntry(entry: AiuContinuationLogEntry): string {
  const line = JSON.stringify(redactJson(entry));
  if (Buffer.byteLength(line, "utf8") <= MAX_LOG_ENTRY_BYTES) {
    return line;
  }
  return JSON.stringify({
    event: entry.event,
    observedAt: entry.observedAt,
    truncated: true,
    originalBytes: Buffer.byteLength(line, "utf8"),
    message: "Log entry exceeded the per-entry byte cap.",
  });
}

function normalizeContinuationState(value: unknown): AiuContinuationState | undefined {
  if (!isRecord(value)
    || value.schemaVersion !== 2
    || (value.deliveryState !== "reserved" && value.deliveryState !== "emitted" && value.deliveryState !== "consumed")
    || !isAiuHost(value.hostId)
    || typeof value.eventType !== "string"
    || typeof value.nativeLoopCount !== "number"
    || !Number.isSafeInteger(value.nativeLoopCount)
    || value.nativeLoopCount < 0
    || typeof value.updatedAt !== "string"
    || !Number.isFinite(Date.parse(value.updatedAt))
    || !validOptionalFingerprint(value.lastPromptFingerprint)
    || !validOptionalFingerprint(value.pendingPromptFingerprint)
    || !validOptionalTimestamp(value.lastPromptAt)
    || !validOptionalTimestamp(value.pendingPromptAt)
    || ((value.deliveryState === "reserved" || value.deliveryState === "emitted")
      && (typeof value.pendingPromptFingerprint !== "string" || typeof value.pendingPromptAt !== "string"))
    || (value.deliveryState === "consumed" && (value.pendingPromptFingerprint !== undefined || value.pendingPromptAt !== undefined))) return undefined;
  return Object.freeze({
    schemaVersion: 2 as const,
    deliveryState: value.deliveryState,
    hostId: value.hostId,
    eventType: value.eventType,
    ...(typeof value.ownerSessionId === "string" ? { ownerSessionId: value.ownerSessionId } : {}),
    ...(typeof value.targetSessionId === "string" ? { targetSessionId: value.targetSessionId } : {}),
    ...(isRecord(value.selectedItem) ? { selectedItem: Object.freeze({ ...value.selectedItem }) as unknown as AiuDecisionSelectedItem } : {}),
    mode: typeof value.mode === "string" ? value.mode as AiuContinuationDecision["selectedMode"] : "stop",
    decisionKind: typeof value.decisionKind === "string" ? value.decisionKind as AiuContinuationDecision["kind"] : "stop",
    reasonCodes: Object.freeze(Array.isArray(value.reasonCodes) ? value.reasonCodes.filter((item): item is string => typeof item === "string") : []),
    ...(typeof value.lastPromptFingerprint === "string" ? { lastPromptFingerprint: value.lastPromptFingerprint } : {}),
    ...(typeof value.pendingPromptFingerprint === "string" ? { pendingPromptFingerprint: value.pendingPromptFingerprint } : {}),
    ...(typeof value.lastPromptAt === "string" ? { lastPromptAt: value.lastPromptAt } : {}),
    ...(typeof value.pendingPromptAt === "string" ? { pendingPromptAt: value.pendingPromptAt } : {}),
    nativeLoopCount: value.nativeLoopCount,
    updatedAt: value.updatedAt,
    sourceSummaries: Object.freeze(Array.isArray(value.sourceSummaries) ? value.sourceSummaries.filter(isRecord).map((item) => Object.freeze({ ...item }) as unknown as AiuDecisionSourceSummary) : []),
  });
}

function validOptionalFingerprint(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && /^[a-f0-9]{64}$/u.test(value));
}

function validOptionalTimestamp(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

function isAiuHost(value: unknown): value is AiuHost {
  return value === "opencode" || value === "codex" || value === "claude-code" || value === "grok-build";
}

function continuesNativeLoop(
  previous: AiuContinuationState | undefined,
  input: {
    readonly ownerSessionId?: string;
    readonly targetSessionId?: string;
    readonly decision: AiuContinuationDecision;
  },
): boolean {
  if (!previous || previous.deliveryState === "reserved" || previous.nativeLoopCount <= 0) return false;
  const previousSession = previous.targetSessionId ?? previous.ownerSessionId;
  const nextSession = input.targetSessionId ?? input.ownerSessionId;
  if (!previousSession || previousSession !== nextSession) return false;
  const previousItem = previous.selectedItem;
  const nextItem = input.decision.selectedItem;
  if (!previousItem || !nextItem) return previousItem === nextItem;
  return previousItem.kind === nextItem.kind
    && previousItem.id === nextItem.id
    && previousItem.sourceId === nextItem.sourceId;
}

function normalizeContinuationLock(value: unknown): AiuContinuationLock | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.ownerId !== "string" || typeof value.eventType !== "string" || typeof value.acquiredAt !== "string") return undefined;
  return Object.freeze({
    schemaVersion: 1 as const,
    ownerId: value.ownerId,
    eventType: value.eventType,
    ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
    acquiredAt: value.acquiredAt,
  });
}

function redactJson(value: unknown): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactJson);
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, redactJson(nested)]));
  }
  return value;
}

function redactText(value: string): string {
  return value
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, "[redacted-token]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[redacted-token]")
    .replace(/\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._~+/=-]{16,}@/g, "[redacted-credential]@")
    .replace(/\b(token|api[_-]?key|secret|password)=([^\s"'`]+)/gi, "$1=[redacted]");
}

function decisionId(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
