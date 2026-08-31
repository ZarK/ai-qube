import type { AiuConfig, AiuHost } from "./config.js";
import {
  acquireAiuContinuationLock,
  appendAiuContinuationLog,
  buildAiuContinuationState,
  calculateAiuNativeLoopCount,
  continuationPromptIsDuplicate,
  continuationPromptOwnedByOtherSession,
  continuationPromptTargetsSameItem,
  continuationTargetsSession,
  inspectAiuContinuationState,
  markAiuContinuationConsumed,
  markAiuContinuationEmitted,
  persistedLastPromptAt,
  releaseAiuContinuationLock,
  resolveAiuContinuationPaths,
  writeAiuContinuationState,
  type AiuContinuationLockHandle,
  type AiuContinuationLogEntry,
  type AiuContinuationPaths,
  type AiuContinuationState,
} from "./continuation_store.js";
import type { AiuContinuationDecision } from "./decision.js";
import type { AiuContinuationPrompt } from "./prompt.js";

export interface AiuContinuationSafetyInput {
  readonly repoRoot: string;
  readonly config: AiuConfig;
  readonly hostId: AiuHost;
  readonly eventType: string;
  readonly observedAt: string;
  readonly sessionId?: string;
  readonly targetSessionId?: string;
  readonly nativeDelivery: boolean;
  readonly recursionActive?: boolean;
  readonly consumeEvidence?: boolean;
}

export interface AiuContinuationSafetyTransaction {
  readonly input: AiuContinuationSafetyInput;
  readonly paths: AiuContinuationPaths;
  readonly lock: AiuContinuationLockHandle;
  readonly staleLockRecovered: boolean;
  state: AiuContinuationState | undefined;
}

export type AiuContinuationSafetyStart =
  | Readonly<{ ok: true; transaction: AiuContinuationSafetyTransaction }>
  | Readonly<{ ok: false; reason: string; paths: AiuContinuationPaths }>;

export type AiuContinuationReservation =
  | Readonly<{ ok: true; state: AiuContinuationState }>
  | Readonly<{ ok: false; reason: string }>;

export function startAiuContinuationSafety(input: AiuContinuationSafetyInput): AiuContinuationSafetyStart {
  const paths = resolveAiuContinuationPaths(input.repoRoot, input.config);
  if (input.nativeDelivery && !input.sessionId) {
    safeAppend(paths, lifecycleLog(input, "continuation-suppressed", ["missing-session-identity"]));
    return Object.freeze({ ok: false as const, reason: "missing-session-identity", paths });
  }

  let lock;
  try {
    lock = acquireAiuContinuationLock({
      paths,
      observedAt: input.observedAt,
      eventType: input.eventType,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      staleAfterMs: Math.max(input.config.timeouts.hostMs * 2, 30_000),
    });
  } catch {
    safeAppend(paths, lifecycleLog(input, "continuation-suppressed", ["continuation-lock-unavailable"]));
    return Object.freeze({ ok: false as const, reason: "continuation-lock-unavailable", paths });
  }

  if (!lock.acquired) {
    safeAppend(paths, lifecycleLog(input, "lock-contended", ["lock-held"]));
    return Object.freeze({ ok: false as const, reason: "lock-held", paths });
  }

  try {
    const inspected = inspectAiuContinuationState(paths);
    if (inspected.status === "invalid") {
      safeAppend(paths, lifecycleLog(input, "continuation-suppressed", ["continuation-state-invalid"]));
      releaseAiuContinuationLock(paths, lock);
      return Object.freeze({ ok: false as const, reason: "continuation-state-invalid", paths });
    }

    let state = inspected.status === "ready" ? inspected.state : undefined;
    if (state?.deliveryState === "reserved") {
      safeAppend(paths, lifecycleLog(input, "reservation-recovered", [], state));
    }
    if (canConsumePriorEmission(input, state)) {
      state = markAiuContinuationConsumed(state!, input.observedAt);
      try {
        writeAiuContinuationState(paths, state);
      } catch {
        safeAppend(paths, lifecycleLog(input, "continuation-suppressed", ["continuation-state-write-failed"]));
        releaseAiuContinuationLock(paths, lock);
        return Object.freeze({ ok: false as const, reason: "continuation-state-write-failed", paths });
      }
      safeAppend(paths, lifecycleLog(input, "delivery-consumed", [], state));
    }

    if (lock.staleRecovered) {
      safeAppend(paths, lifecycleLog(input, "stale-lock-recovered", []));
    }
    return Object.freeze({
      ok: true as const,
      transaction: {
        input,
        paths,
        lock,
        staleLockRecovered: lock.staleRecovered,
        state,
      },
    });
  } catch {
    try {
      releaseAiuContinuationLock(paths, lock);
    } catch {
      // The exclusive owner id still prevents this path from deleting another process's lock.
    }
    return Object.freeze({ ok: false as const, reason: "continuation-state-unavailable", paths });
  }
}

export function continuationSafetyCooldownActive(transaction: AiuContinuationSafetyTransaction): boolean {
  const lastPromptAt = persistedLastPromptAt(transaction.state);
  if (!lastPromptAt) return false;
  const previous = Date.parse(lastPromptAt);
  const current = Date.parse(transaction.input.observedAt);
  return Number.isFinite(previous)
    && Number.isFinite(current)
    && current - previous < transaction.input.config.cooldowns.promptMs;
}

export function continuationSafetyImmediateSuppressions(transaction: AiuContinuationSafetyTransaction): readonly string[] {
  if (transaction.input.recursionActive === true) return Object.freeze(["stop-hook-already-active"]);
  if (continuationPromptOwnedByOtherSession(transaction.state, transaction.input.sessionId)) {
    return Object.freeze(["prompt-owned-by-other-session"]);
  }
  if (continuationSafetyCooldownActive(transaction)) return Object.freeze(["wait-cooldown-active"]);
  return Object.freeze([]);
}

export function reserveAiuContinuation(
  transaction: AiuContinuationSafetyTransaction,
  decision: AiuContinuationDecision,
  prompt: AiuContinuationPrompt,
): AiuContinuationReservation {
  const input = transaction.input;
  const sessionTarget = input.targetSessionId ?? input.sessionId;
  const state = transaction.state;
  const suppressions = [
    ...(continuationPromptOwnedByOtherSession(state, input.sessionId) ? ["prompt-owned-by-other-session"] : []),
    ...(continuationPromptIsDuplicate(state, prompt) ? ["duplicate-prompt-fingerprint"] : []),
    ...(continuationPromptTargetsSameItem(state, prompt) ? ["duplicate-prompt-target"] : []),
    ...(continuationTargetsSession(state, sessionTarget) ? ["duplicate-session-target"] : []),
  ];
  const nextLoopCount = calculateAiuNativeLoopCount(state, {
    ...(input.sessionId ? { ownerSessionId: input.sessionId } : {}),
    ...(sessionTarget ? { targetSessionId: sessionTarget } : {}),
    decision,
    nativeDelivery: input.nativeDelivery,
  });
  if (input.nativeDelivery && nextLoopCount > input.config.continuation.nativeLoopLimit) {
    suppressions.push("native-loop-limit-exhausted");
  }
  if (suppressions.length > 0) {
    safeAppend(transaction.paths, lifecycleLog(input, "continuation-suppressed", suppressions, state));
    return Object.freeze({ ok: false as const, reason: suppressions[0]! });
  }

  const reserved = buildAiuContinuationState({
    observedAt: input.observedAt,
    hostId: input.hostId,
    eventType: input.eventType,
    ...(input.sessionId ? { ownerSessionId: input.sessionId } : {}),
    ...(sessionTarget ? { targetSessionId: sessionTarget } : {}),
    decision,
    prompt,
    ...(state ? { previous: state } : {}),
    nativeDelivery: input.nativeDelivery,
  });
  try {
    writeAiuContinuationState(transaction.paths, reserved);
  } catch {
    safeAppend(transaction.paths, lifecycleLog(input, "continuation-suppressed", ["continuation-state-write-failed"], state));
    return Object.freeze({ ok: false as const, reason: "continuation-state-write-failed" });
  }
  transaction.state = reserved;
  safeAppend(transaction.paths, lifecycleLog(input, "delivery-reserved", [], reserved));
  return Object.freeze({ ok: true as const, state: reserved });
}

export function markAiuContinuationDeliveryEmitted(transaction: AiuContinuationSafetyTransaction): AiuContinuationReservation {
  const state = transaction.state;
  if (!state || state.deliveryState !== "reserved") {
    return Object.freeze({ ok: false as const, reason: "continuation-reservation-missing" });
  }
  const emitted = markAiuContinuationEmitted(state, transaction.input.observedAt);
  try {
    writeAiuContinuationState(transaction.paths, emitted);
  } catch {
    safeAppend(transaction.paths, lifecycleLog(transaction.input, "continuation-suppressed", ["continuation-state-write-failed"], state));
    return Object.freeze({ ok: false as const, reason: "continuation-state-write-failed" });
  }
  transaction.state = emitted;
  safeAppend(transaction.paths, lifecycleLog(transaction.input, "delivery-emitted", [], emitted));
  return Object.freeze({ ok: true as const, state: emitted });
}

export function appendAiuContinuationSafetyLog(
  transaction: AiuContinuationSafetyTransaction,
  entry: AiuContinuationLogEntry,
): boolean {
  return safeAppend(transaction.paths, entry);
}

export function releaseAiuContinuationSafety(transaction: AiuContinuationSafetyTransaction): void {
  try {
    releaseAiuContinuationLock(transaction.paths, transaction.lock);
  } catch {
    safeAppend(transaction.paths, lifecycleLog(transaction.input, "continuation-suppressed", ["continuation-lock-release-failed"], transaction.state));
  }
}

function canConsumePriorEmission(
  input: AiuContinuationSafetyInput,
  state: AiuContinuationState | undefined,
): boolean {
  if (!state || state.deliveryState !== "emitted" || input.consumeEvidence !== true || input.recursionActive === true) return false;
  const expectedSession = state.targetSessionId ?? state.ownerSessionId;
  const observedSession = input.targetSessionId ?? input.sessionId;
  if (!expectedSession || expectedSession !== observedSession) return false;
  const emittedAt = Date.parse(state.updatedAt);
  const evidenceAt = Date.parse(input.observedAt);
  return Number.isFinite(emittedAt) && Number.isFinite(evidenceAt) && evidenceAt > emittedAt;
}

function lifecycleLog(
  input: AiuContinuationSafetyInput,
  event: string,
  suppressions: readonly string[],
  state?: AiuContinuationState,
): AiuContinuationLogEntry {
  return {
    event,
    observedAt: input.observedAt,
    eventType: input.eventType,
    hostId: input.hostId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.targetSessionId ? { targetSessionId: input.targetSessionId } : {}),
    ...(state ? { deliveryState: state.deliveryState, nativeLoopCount: state.nativeLoopCount } : {}),
    ...(suppressions.length > 0 ? { suppressions } : {}),
  };
}

function safeAppend(paths: AiuContinuationPaths, entry: AiuContinuationLogEntry): boolean {
  try {
    appendAiuContinuationLog(paths, entry);
    return true;
  } catch {
    return false;
  }
}
