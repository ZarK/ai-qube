import { lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  buildCursorVerifyInvocation,
  cursorVerificationObserverScript,
  inspectCursorVerificationObservations,
  resolveCursorVerificationTranscriptRoot,
  type CursorVerificationObservation,
} from "@tjalve/qube-adapter-cursor";

import { readAiuContinuationState, resolveAiuContinuationPaths } from "./continuation_store.js";
import { runInteractiveProcess } from "./interactive_process.js";
import type { AiuPreparedVerification, AiuVerificationDiscovery, AiuVerificationScenario } from "./verify.js";

const OBSERVER_NAME = "verify-cursor-observer.cjs";
const OBSERVATIONS_NAME = "verify-cursor-observations.jsonl";

export function installCursorVerificationObserver(workspace: AiuPreparedVerification): void {
  const scriptPath = path.join(workspace.root, ".qube", "aiu", OBSERVER_NAME);
  const hooksPath = path.join(workspace.root, ".cursor", "hooks.json");
  writeFileSync(scriptPath, cursorVerificationObserverScript({ workspaceRoot: workspace.root }), "utf8");
  const hooks = JSON.parse(readFileSync(hooksPath, "utf8")) as unknown;
  if (!isRecord(hooks) || !isRecord(hooks.hooks) || !Array.isArray(hooks.hooks.stop)
    || !hooks.hooks.stop.some((entry) => isRecord(entry) && typeof entry.command === "string" && /hook-stop\s+--tool\s+cursor/u.test(entry.command))) {
    throw new Error("The managed Cursor Stop hook is missing from the verification workspace.");
  }
  const observer = { command: `${quoteCommand(process.execPath)} ${quoteCommand(scriptPath)}`, loop_limit: 3 };
  writeFileSync(hooksPath, `${JSON.stringify({ ...hooks, hooks: { ...hooks.hooks, stop: [...hooks.hooks.stop, observer] } }, null, 2)}\n`, "utf8");
}

export async function runCursorVerificationScenario(input: {
  readonly discovery: AiuVerificationDiscovery;
  readonly workspace: AiuPreparedVerification;
  readonly kind: "continue" | "allow";
  readonly timeoutMs: number;
  readonly token: string;
}): Promise<AiuVerificationScenario> {
  const observationsPath = path.join(input.workspace.root, ".qube", "aiu", OBSERVATIONS_NAME);
  if (!cursorWorkspaceTrustReady(input.workspace.root)) return failure(input.kind, "trust-prerequisite-unmet", false);
  rmSync(observationsPath, { force: true });
  const startedAt = Date.now();
  const initial = `AIU_VERIFY_INITIAL:${input.token}`;
  const next = `AIU_VERIFY_NEXT:${input.token}`;
  const prompt = `Reply exactly with ${initial}, then end your turn. If a follow-up arrives later, reply exactly with ${next}, then end your turn. Do not use tools. Do not print ${next} during the first turn.`;
  const invocation = buildCursorVerifyInvocation({ root: input.workspace.root, prompt, model: input.discovery.model ?? undefined });
  let candidateAt: number | undefined;
  const result = await runInteractiveProcess({
    command: input.discovery.executablePath,
    args: invocation.args,
    cwd: input.workspace.root,
    timeoutMs: input.timeoutMs,
    inspect: () => {
      const observations = inspectCursorVerificationObservations({
        observationPath: observationsPath,
        workspaceRoot: input.workspace.root,
        startedAt,
        expectedVersion: input.discovery.harnessVersion,
      });
      const evaluated = evaluateCursorVerificationLifecycle(input, observations, initial, next, false, startedAt);
      if (!evaluated) { candidateAt = undefined; return undefined; }
      if (evaluated.status !== "passed") return evaluated;
      candidateAt ??= Date.now();
      return Date.now() - candidateAt >= 200 ? evaluated : undefined;
    },
  });
  if (result.status === "observed") return result.observation!;
  if (result.status === "timeout") {
    const observations = inspectCursorVerificationObservations({ observationPath: observationsPath, workspaceRoot: input.workspace.root, startedAt, expectedVersion: input.discovery.harnessVersion });
    return evaluateCursorVerificationLifecycle(input, observations, initial, next, true, startedAt)
      ?? failure(input.kind, "native-timeout", true);
  }
  if (result.signal) return failure(input.kind, "user-aborted", true, "aborted");
  return failure(input.kind, "native-response-invalid", true, "failed", `Cursor exited before a valid completed Stop observation${result.errorCode ? ` (${result.errorCode})` : ""}.`);
}

export function evaluateCursorVerificationLifecycle(
  input: Parameters<typeof runCursorVerificationScenario>[0],
  observations: readonly CursorVerificationObservation[],
  initial: string,
  next: string,
  final = false,
  startedAt = 0,
): AiuVerificationScenario | undefined {
  if (observations.length === 0) return undefined;
  const first = observations[0]!;
  if (first.loopCount !== 0 || first.assistantMessages[0] !== initial) {
    return failure(input.kind, "native-response-invalid", true);
  }
  const paths = resolveAiuContinuationPaths(input.workspace.root, input.workspace.config);
  const state = readAiuContinuationState(paths);
  if (input.kind === "allow") {
    if (observations.length !== 1 || state || first.assistantMessages.length !== 1) return failure("allow", "allow-path-continued", true);
    if (!managedAllowObserved(paths.logPath, first.conversationId, startedAt)) return final ? failure("allow", "native-timeout", true) : undefined;
    return passed("allow", first.conversationId, false);
  }
  if (observations.length < 2) return undefined;
  if (observations.length !== 2) return failure("continue", "native-response-invalid", true, "failed", "Cursor emitted more than one managed follow-up.");
  const second = observations[1]!;
  if (second.loopCount !== 1 || second.conversationId !== first.conversationId || second.generationId === first.generationId
    || second.assistantMessages.at(-1) !== next) {
    return failure("continue", "native-response-invalid", true);
  }
  if (state?.deliveryState !== "consumed" || state.nativeLoopCount !== 1
    || state.ownerSessionId !== first.conversationId || (state.targetSessionId && state.targetSessionId !== first.conversationId)) {
    return final ? failure("continue", "continuation-not-consumed", true, "failed", undefined, state?.deliveryState ?? "none", first.conversationId) : undefined;
  }
  return passed("continue", first.conversationId, true);
}

function passed(kind: "allow" | "continue", sessionId: string, continued: boolean): AiuVerificationScenario {
  return Object.freeze({ kind, status: "passed", reasonCode: "verification-passed", nativeInvocationObserved: true, responseConsumed: continued, nextTurnObserved: continued, continuationCount: continued ? 1 : 0, sessionId });
}

function failure(
  kind: "allow" | "continue",
  reasonCode: AiuVerificationScenario["reasonCode"],
  nativeInvocationObserved: boolean,
  status: "failed" | "aborted" = "failed",
  diagnostic?: string,
  observedDeliveryState?: "none" | "reserved" | "emitted" | "consumed",
  sessionId?: string,
): AiuVerificationScenario {
  return Object.freeze({ kind, status, reasonCode, nativeInvocationObserved, responseConsumed: false, nextTurnObserved: false, continuationCount: 0, ...(diagnostic ? { diagnostic } : {}), ...(observedDeliveryState ? { observedDeliveryState } : {}), ...(sessionId ? { sessionId } : {}) });
}

function quoteCommand(value: string): string { return `"${value.replaceAll('"', '\\"')}"`; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

function cursorWorkspaceTrustReady(workspaceRoot: string): boolean {
  const marker = path.join(path.dirname(resolveCursorVerificationTranscriptRoot(workspaceRoot)), ".workspace-trusted");
  try { return lstatSync(marker).isFile() && !lstatSync(marker).isSymbolicLink(); } catch { return false; }
}

function managedAllowObserved(logPath: string, sessionId: string, startedAt: number): boolean {
  try {
    return readFileSync(logPath, "utf8").split(/\r?\n/u).filter(Boolean).some((line) => {
      const value = JSON.parse(line) as unknown;
      return isRecord(value) && value.event === "decision" && value.hostId === "cursor" && value.eventType === "stop"
        && value.sessionId === sessionId && value.decisionKind === "stop" && typeof value.observedAt === "string"
        && Number.isFinite(Date.parse(value.observedAt)) && Date.parse(value.observedAt) >= startedAt;
    });
  } catch { return false; }
}
