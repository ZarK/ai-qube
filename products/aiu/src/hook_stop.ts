import path from "node:path";
import type { ContinuationDecodedEvent } from "@tjalve/qube-core";

import type { AiuConfig, AiuHost } from "./config.js";
import { loadAiuConfig } from "./config.js";
import { createAiuTrustedStateFingerprint, resolveAiuContinuationPaths, writeAiuHostActivation } from "./continuation_store.js";
import {
  appendAiuContinuationSafetyLog,
  continuationSafetyCooldownActive,
  continuationSafetyImmediateSuppressions,
  markAiuContinuationDeliveryEmitted,
  releaseAiuContinuationSafety,
  reserveAiuContinuation,
  startAiuContinuationSafety,
  type AiuContinuationSafetyTransaction,
} from "./continuation_safety.js";
import { decideAiuContinuation, type AiuContinuationDecision } from "./decision.js";
import { renderAiuContinuationPrompt, type AiuContinuationPrompt } from "./prompt.js";
import { createAiuTrustedStateEnvelope, type AiuHostSessionState, type AiuTrustedStateEnvelope } from "./state.js";
import { runAiuTrustedStateAdapter, type AiuTrustedStateAdapterResult } from "./trusted_adapter.js";
import { decideAiuWhipContinuation, readAiuWhipState } from "./whip.js";
import { decodeAiuContinuationEvent, getAiuContinuationAdapter } from "./continuation_adapters.js";

export interface AiuHookStopOptions {
  readonly tool: Extract<AiuHost, "codex" | "claude-code" | "grok-build">;
  readonly stdin?: string;
  readonly cwd?: string;
  readonly configPath?: string;
  readonly observedAt?: string;
}

export interface AiuHookStopResult {
  readonly tool: AiuHookStopOptions["tool"];
  readonly decision: "allow" | "block";
  readonly reason: string;
  readonly inputBytes: number;
  readonly stdoutJson: AiuHookStopStdoutJson;
  readonly stderr: string;
  readonly diagnostics: readonly AiuHookStopDiagnostic[];
  readonly continuationDecision?: AiuContinuationDecision;
  readonly prompt?: AiuContinuationPrompt;
}

export type AiuHookStopStdoutJson = Readonly<Record<string, never>> | Readonly<{ decision: "block"; reason: string }>;

export interface AiuHookStopDiagnostic {
  readonly severity: "info" | "warning" | "error";
  readonly code: string;
  readonly message: string;
}

const MAX_DIAGNOSTIC_LENGTH = 240;
const MAX_DIAGNOSTIC_LINES = 8;
const HOOK_SERIALIZATION_HEADROOM_MS = 250;

export async function runAiuHookStop(options: AiuHookStopOptions): Promise<AiuHookStopResult> {
  const startedAt = Date.now();
  const stdin = options.stdin ?? "";
  const inputBytes = Buffer.byteLength(stdin, "utf8");
  const observedAt = options.observedAt ?? new Date().toISOString();
  const parsed = parseHookPayload(options.tool, stdin);
  if (!parsed.ok) {
    return allow(options, inputBytes, parsed.code, [
      diagnostic("warning", parsed.code, parsed.error),
    ]);
  }

  if (parsed.payload.sessionEnd === true) {
    return allow(options, inputBytes, "session-end-stop", [
      diagnostic("info", "session-end-stop", `${options.tool} reported a session-end Stop; continuation is not applied.`),
    ]);
  }

  const resolvedCwd = resolveTrustedHookCwd(options.cwd, parsed.payload.cwd);
  if (!resolvedCwd.ok) {
    return allow(options, inputBytes, resolvedCwd.code, [
      diagnostic("warning", resolvedCwd.code, resolvedCwd.error),
    ]);
  }
  const cwd = resolvedCwd.cwd;
  const configLoad = loadAiuConfig(options.configPath ? { cwd, configPath: options.configPath } : { cwd });
  const policyBlocker = stopHookPolicyBlocker(configLoad.config, options.tool);
  const configDiagnostics = configLoad.diagnostics
    .filter((item) => item.kind !== "host-capability-experimental")
    .map((item) => diagnostic(item.severity, item.kind, item.message));
  if (!configLoad.ok) {
    return allow(options, inputBytes, "config-invalid", configDiagnostics);
  }
  if (policyBlocker) {
    return allow(options, inputBytes, policyBlocker, [
      ...configDiagnostics,
      diagnostic("info", policyBlocker, policyBlockerMessage(policyBlocker, options.tool)),
    ]);
  }

  const hookWindowMs = Math.min(
    configLoad.config.timeouts.hookMs,
    Math.max(1, configLoad.config.timeouts.hostMs - HOOK_SERIALIZATION_HEADROOM_MS),
  );
  const deadlineAt = startedAt + hookWindowMs;
  const safety = startAiuContinuationSafety({
    repoRoot: configLoad.repoRoot,
    config: configLoad.config,
    hostId: options.tool,
    eventType: parsed.payload.event,
    observedAt,
    ...(parsed.payload.sessionId ? { sessionId: parsed.payload.sessionId, targetSessionId: parsed.payload.sessionId } : {}),
    nativeDelivery: true,
    recursionActive: parsed.payload.stopHookActive === true,
    consumeEvidence: parsed.payload.stopHookActive !== true,
  });
  if (!safety.ok) {
    return allow(options, inputBytes, safety.reason, [
      ...configDiagnostics,
      diagnostic("warning", safety.reason, "Continuation safety state could not be established; the native Stop is allowed."),
    ]);
  }

  const transaction = safety.transaction;
  try {
    const immediateSuppressions = continuationSafetyImmediateSuppressions(transaction);
    if (immediateSuppressions.length > 0) {
      const reason = immediateSuppressions[0]!;
      appendHookDecisionLog(transaction, reason, immediateSuppressions);
      return allow(options, inputBytes, reason, [
        ...configDiagnostics,
        diagnostic("info", reason, immediateSuppressionMessage(reason)),
      ]);
    }

    const commandBudget = remainingHookBudget(deadlineAt);
    if (commandBudget <= 0) {
      appendHookDecisionLog(transaction, "hook-deadline-exhausted", ["hook-deadline-exhausted"]);
      return allow(options, inputBytes, "hook-deadline-exhausted", [
        ...configDiagnostics,
        diagnostic("warning", "hook-deadline-exhausted", "The dedicated hook deadline expired before trusted state could be evaluated."),
      ]);
    }

    const adapterResults = await Promise.all(Object.entries(configLoad.config.trustedStateCommands).map(([sourceId, descriptor]) => runAiuTrustedStateAdapter(sourceId, descriptor, {
        cwd: configLoad.repoRoot,
        timeoutMs: Math.min(descriptor.timeoutMs ?? configLoad.config.timeouts.commandMs, configLoad.config.timeouts.commandMs, commandBudget),
        killGraceMs: Math.min(100, commandBudget),
        observedAt,
    })));
    if (remainingHookBudget(deadlineAt) <= 0) {
      appendHookDecisionLog(transaction, "hook-deadline-exhausted", ["hook-deadline-exhausted"]);
      return allow(options, inputBytes, "hook-deadline-exhausted", [
        ...configDiagnostics,
        diagnostic("warning", "hook-deadline-exhausted", "The dedicated hook deadline expired while trusted state was evaluated."),
      ]);
    }
    const warningDiagnostics = [
      ...configDiagnostics.filter((item) => item.severity !== "error"),
      ...adapterResults.flatMap(adapterDiagnostics),
    ];
    if (adapterResults.length === 0) {
      appendHookDecisionLog(transaction, "trusted-state-unavailable", ["trusted-state-unavailable"]);
      return allow(options, inputBytes, "trusted-state-unavailable", [
        ...warningDiagnostics,
        diagnostic("warning", "trusted-state-unavailable", "No trusted state commands are configured for stop-hook decisions."),
      ]);
    }

    const adapterFailures = adapterResults.filter((result): result is Extract<AiuTrustedStateAdapterResult, { readonly ok: false }> => !result.ok);
    if (adapterFailures.length > 0) {
      appendHookDecisionLog(transaction, "trusted-state-load-failed", ["trusted-state-load-failed"]);
      return allow(
        options,
        inputBytes,
        "trusted-state-load-failed",
        [
          ...warningDiagnostics,
          ...adapterFailures.map((result) => diagnostic("error", result.error.code, `Trusted command ${result.record.sourceId} failed with ${result.error.code}.`)),
        ],
      );
    }

    if (remainingHookBudget(deadlineAt) <= 0) {
      appendHookDecisionLog(transaction, "hook-deadline-exhausted", ["hook-deadline-exhausted"]);
      return allow(options, inputBytes, "hook-deadline-exhausted", [
        ...warningDiagnostics,
        diagnostic("warning", "hook-deadline-exhausted", "The dedicated hook deadline expired before delivery could be reserved."),
      ]);
    }

    const states = [
      ...adapterResults.flatMap((result) => result.ok ? result.states : []),
      hostSessionEnvelope(options.tool, parsed.payload, observedAt),
    ];
    const diagnostics = [
      ...warningDiagnostics,
      ...states.flatMap(stateDiagnostics),
    ];
    const whipRead = readAiuWhipState(configLoad.repoRoot, configLoad.config);
    const whipDecision = decideAiuWhipContinuation({
      config: configLoad.config,
      state: whipRead.state,
    });
    const decision = decideAiuContinuation({
      states,
      policy: {
        modes: configLoad.config.hosts.modes[options.tool] ?? configLoad.config.continuation.modes,
        stopOnUnknownState: configLoad.config.continuation.stopOnUnknownState,
        stopOnUnsafeState: configLoad.config.continuation.stopOnUnsafeState,
        stopOnSupplyChainApprovalBlock: configLoad.config.continuation.stopOnSupplyChainApprovalBlock,
        planningEnabled: configLoad.config.planning.enabled,
        qualityEnabled: configLoad.config.quality.enabled,
        supplyChainApprovalRequired: configLoad.config.supplyChain.stopOnApprovalRequired === true && hasSupplyChainApprovalBlock(states),
        cooldownActive: continuationSafetyCooldownActive(transaction),
      },
      ...(whipDecision.enqueuesPrompt && whipDecision.task ? { whipTask: whipDecision.task } : {}),
      ...(configLoad.config.whip.enabled && whipRead.errors.length > 0 ? { whipStateError: { kind: "whip", sourceId: whipRead.path, status: "malformed" } } : {}),
    });
    const prompt = renderAiuContinuationPrompt({ decision, config: configLoad.config });
    if (!isBlockingDecision(decision, prompt)) {
      appendHookDecisionLog(transaction, decision.reasonCodes[0] ?? decision.kind, decision.reasonCodes, decision, prompt);
      return allow(options, inputBytes, decision.reasonCodes[0] ?? decision.kind, diagnostics, decision, prompt);
    }

    const encoded = getAiuContinuationAdapter(options.tool).encodeResponse({ decision: "block", prompt: prompt.body, sessionId: parsed.payload.sessionId, cwd });
    if (!encoded.ok || !isHookStopStdoutJson(encoded.response)) {
      appendHookDecisionLog(transaction, "invalid-host-response", ["invalid-host-response"], decision, prompt);
      return allow(options, inputBytes, "invalid-host-response", [
        ...diagnostics,
        diagnostic("error", "invalid-host-response", encoded.ok ? "Continuation adapter produced an invalid Stop-hook response." : encoded.error),
      ], decision, prompt);
    }
    if (remainingHookBudget(deadlineAt) <= 0) {
      appendHookDecisionLog(transaction, "hook-deadline-exhausted", ["hook-deadline-exhausted"], decision, prompt);
      return allow(options, inputBytes, "hook-deadline-exhausted", [
        ...diagnostics,
        diagnostic("warning", "hook-deadline-exhausted", "The dedicated hook deadline expired before delivery could be reserved."),
      ], decision, prompt);
    }
    const reservation = reserveAiuContinuation(transaction, decision, prompt);
    if (!reservation.ok) {
      return allow(options, inputBytes, reservation.reason, [
        ...diagnostics,
        diagnostic("info", reservation.reason, "Continuation delivery was suppressed by shared safety state."),
      ], decision, prompt);
    }
    const emitted = markAiuContinuationDeliveryEmitted(transaction);
    if (!emitted.ok) {
      return allow(options, inputBytes, emitted.reason, [
        ...diagnostics,
        diagnostic("warning", emitted.reason, "Continuation delivery state could not be recorded; the native Stop is allowed."),
      ], decision, prompt);
    }
    appendHookDecisionLog(transaction, decision.reasonCodes[0] ?? decision.kind, [], decision, prompt);
    const activationDiagnostic = recordStopHookActivation(configLoad.repoRoot, configLoad.config, options.tool, observedAt);
    if (activationDiagnostic) diagnostics.push(activationDiagnostic);

    return Object.freeze({
      tool: options.tool,
      decision: "block" as const,
      reason: decision.reasonCodes[0] ?? decision.kind,
      inputBytes,
      stdoutJson: Object.freeze(encoded.response),
      stderr: formatDiagnostics(diagnostics),
      diagnostics: Object.freeze(diagnostics),
      continuationDecision: decision,
      prompt,
    });
  } finally {
    releaseAiuContinuationSafety(transaction);
  }
}

function remainingHookBudget(deadlineAt: number): number {
  return Math.max(0, deadlineAt - Date.now() - HOOK_SERIALIZATION_HEADROOM_MS);
}

function immediateSuppressionMessage(reason: string): string {
  if (reason === "stop-hook-already-active") return "Host reported that a native continuation hook is already active.";
  if (reason === "prompt-owned-by-other-session") return "Another session owns the pending continuation delivery.";
  if (reason === "wait-cooldown-active") return "The configured continuation cooldown is still active.";
  return "Shared continuation safety state suppressed delivery.";
}

function appendHookDecisionLog(
  transaction: AiuContinuationSafetyTransaction,
  reason: string,
  suppressions: readonly string[],
  decision?: AiuContinuationDecision,
  prompt?: AiuContinuationPrompt,
): void {
  appendAiuContinuationSafetyLog(transaction, {
    event: "decision",
    observedAt: transaction.input.observedAt,
    eventType: transaction.input.eventType,
    hostId: transaction.input.hostId,
    ...(transaction.input.sessionId ? { sessionId: transaction.input.sessionId } : {}),
    ...(transaction.input.targetSessionId ? { targetSessionId: transaction.input.targetSessionId } : {}),
    ...(transaction.state ? {
      deliveryState: transaction.state.deliveryState,
      nativeLoopCount: transaction.state.nativeLoopCount,
    } : {}),
    ...(decision ? {
      decisionKind: decision.kind,
      mode: decision.selectedMode,
      promptKind: decision.promptKind,
      reasonCodes: decision.reasonCodes,
      sourceSummaries: decision.sourceSummaries,
      ...(decision.selectedItem ? { selectedItem: decision.selectedItem } : {}),
    } : { reasonCodes: [reason] }),
    ...(prompt ? { promptFingerprint: prompt.fingerprint } : {}),
    ...(suppressions.length > 0 ? { suppressions } : {}),
  });
}

function recordStopHookActivation(
  repoRoot: string,
  config: AiuConfig,
  host: AiuHookStopOptions["tool"],
  observedAt: string,
): AiuHookStopDiagnostic | undefined {
  try {
    const evidence = getAiuContinuationAdapter(host).declaration.activationEvidence;
    writeAiuHostActivation(resolveAiuContinuationPaths(repoRoot, config), {
      schemaVersion: 1,
      host,
      delivery: evidence.delivery,
      event: evidence.event,
      trustedStateFingerprint: createAiuTrustedStateFingerprint(config.trustedStateCommands),
      observedAt,
    });
    return undefined;
  } catch (error) {
    return diagnostic(
      "warning",
      "host-activation-write-failed",
      `Umpire could not record ${host} Stop-hook activation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function formatHookStopJson(result: AiuHookStopResult): string {
  return `${JSON.stringify(result.stdoutJson)}\n`;
}

export async function readHookStopStdin(timeoutMs = 250): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onEnd);
      clearTimeout(timer);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      process.stdin.pause();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onData = (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      clearTimeout(timer);
      timer = setTimeout(finish, timeoutMs);
    };
    const onEnd = () => finish();
    timer = setTimeout(finish, timeoutMs);

    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onEnd);
    process.stdin.resume();
  });
}

function resolveTrustedHookCwd(
  invocationCwd: string | undefined,
  payloadCwd: string | undefined,
): { readonly ok: true; readonly cwd: string } | { readonly ok: false; readonly code: "untrusted-hook-cwd"; readonly error: string } {
  const trustedRoot = path.resolve(invocationCwd ?? process.cwd());
  if (payloadCwd === undefined || payloadCwd.length === 0) {
    return { ok: true, cwd: trustedRoot };
  }
  const requested = path.resolve(payloadCwd);
  if (!isSameOrChildPath(requested, trustedRoot)) {
    return {
      ok: false,
      code: "untrusted-hook-cwd",
      error: "Stop hook cwd is outside the invocation repository.",
    };
  }
  return { ok: true, cwd: trustedRoot };
}

function isSameOrChildPath(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizePath(candidate);
  const normalizedRoot = normalizePath(root);
  if (normalizedCandidate === normalizedRoot) {
    return true;
  }
  const prefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
  return normalizedCandidate.startsWith(prefix);
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  if (process.platform === "win32" && /^[A-Za-z]:/.test(resolved)) {
    return resolved[0].toLowerCase() + resolved.slice(1);
  }
  return resolved;
}

function parseHookPayload(
  tool: AiuHookStopOptions["tool"],
  stdin: string,
): { readonly ok: true; readonly payload: ContinuationDecodedEvent } | { readonly ok: false; readonly code: "empty-hook-input" | "malformed-hook-input"; readonly error: string } {
  const trimmed = stdin.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: "empty-hook-input", error: "Stop hook input is empty." };
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) {
      return { ok: false, code: "malformed-hook-input", error: "Stop hook input must be a JSON object." };
    }
    const adapter = getAiuContinuationAdapter(tool);
    const decoded = decodeAiuContinuationEvent(tool, { surface: adapter.declaration.nativeSurfaces[0]!.id, version: null, event: parsed });
    return decoded.ok
      ? { ok: true, payload: decoded.event }
      : { ok: false, code: "malformed-hook-input", error: decoded.error };
  } catch (error) {
    return {
      ok: false,
      code: "malformed-hook-input",
      error: `Stop hook input was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function stopHookPolicyBlocker(config: AiuConfig, tool: AiuHookStopOptions["tool"]): string | undefined {
  const capabilities = config.hosts.capabilities[tool] ?? {};
  if (!config.hosts.enabled.includes(tool)) {
    return "host-not-enabled";
  }
  if (config.hosts.stopHookBlocking[tool] !== true) {
    return "stop-hook-blocking-disabled";
  }
  if (capabilities.stopHook === false || capabilities.stopHook === "none") {
    return "stop-hook-capability-disabled";
  }
  if (capabilities.promptDelivery === false || capabilities.promptDelivery === "none") {
    return "prompt-delivery-disabled";
  }
  return undefined;
}

function policyBlockerMessage(code: string, tool: AiuHookStopOptions["tool"]): string {
  if (code === "host-not-enabled") {
    return `${tool} is not enabled in hosts.enabled.`;
  }
  if (code === "stop-hook-blocking-disabled") {
    return `${tool} stop-hook blocking is disabled by hosts.stopHookBlocking.`;
  }
  if (code === "stop-hook-capability-disabled") {
    return `${tool} stopHook capability is disabled.`;
  }
  if (code === "prompt-delivery-disabled") {
    return `${tool} promptDelivery capability is disabled.`;
  }
  return code;
}

function hostSessionEnvelope(tool: AiuHookStopOptions["tool"], payload: ContinuationDecodedEvent, observedAt: string): AiuTrustedStateEnvelope<AiuHostSessionState> {
  const active = payload.stopHookActive === true;
  return createAiuTrustedStateEnvelope({
    sourceId: `${tool}-hook`,
    command: {
      id: `${tool}-hook`,
      argv: ["aiu", "hook-stop", "--tool", tool],
    },
    observedAt,
    trustLevel: "advisory",
    capabilities: {
      sessionState: payload.sessionId ? "supported" : "unknown",
      promptDelivery: "supported",
    },
    freshness: {
      kind: "fresh",
      observedAt,
    },
    value: {
      kind: "host-session",
      status: active ? "fail" : "pass",
      hostId: tool,
      ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
      sessionStatus: active ? "busy" : "idle",
      canPrompt: active ? false : true,
      summary: `${tool} stop hook payload`,
    },
  });
}

function isBlockingDecision(decision: AiuContinuationDecision, prompt: AiuContinuationPrompt): boolean {
  return (decision.kind === "continue" || decision.kind === "repair") && prompt.body.trim().length > 0;
}

function allow(
  options: AiuHookStopOptions,
  inputBytes: number,
  reason: string,
  diagnostics: readonly AiuHookStopDiagnostic[] = [],
  continuationDecision?: AiuContinuationDecision,
  prompt?: AiuContinuationPrompt,
): AiuHookStopResult {
  return Object.freeze({
    tool: options.tool,
    decision: "allow" as const,
    reason,
    inputBytes,
    stdoutJson: Object.freeze({}),
    stderr: formatDiagnostics(diagnostics),
    diagnostics: Object.freeze(diagnostics),
    ...(continuationDecision ? { continuationDecision } : {}),
    ...(prompt ? { prompt } : {}),
  });
}

function diagnostic(severity: AiuHookStopDiagnostic["severity"], code: string, message: string): AiuHookStopDiagnostic {
  return Object.freeze({
    severity,
    code,
    message: boundDiagnostic(redactDiagnostic(message)),
  });
}

function formatDiagnostics(diagnostics: readonly AiuHookStopDiagnostic[]): string {
  if (diagnostics.length === 0) {
    return "";
  }
  const showTruncationSummary = diagnostics.length > MAX_DIAGNOSTIC_LINES;
  const shown = diagnostics.slice(0, showTruncationSummary ? MAX_DIAGNOSTIC_LINES - 1 : MAX_DIAGNOSTIC_LINES);
  const lines = shown.map((item) => `${item.severity.toUpperCase()} ${item.code}: ${item.message}`);
  if (showTruncationSummary) {
    lines.push(`INFO diagnostics-truncated: omitted ${diagnostics.length - shown.length} additional diagnostic(s).`);
  }
  return `${lines.join("\n")}\n`;
}

function boundDiagnostic(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= MAX_DIAGNOSTIC_LENGTH ? compact : `${compact.slice(0, MAX_DIAGNOSTIC_LENGTH - 3)}...`;
}

function redactDiagnostic(value: string): string {
  return value
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, "[redacted-token]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[redacted-token]")
    .replace(/\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._~+/=-]{16,}@/g, "[redacted-credential]@")
    .replace(/\b(token|api[_-]?key|secret|password)=([^\s"'`]+)/gi, "$1=[redacted]");
}

function hasSupplyChainApprovalBlock(states: readonly AiuTrustedStateEnvelope[]): boolean {
  return states.some((state) => state.value.reasonCodes?.includes("stop-supply-chain-approval"));
}

function adapterDiagnostics(result: AiuTrustedStateAdapterResult): readonly AiuHookStopDiagnostic[] {
  const stderr = result.record.stderrSummary.trim();
  return stderr.length > 0 ? [diagnostic("warning", "trusted-command-stderr", `Trusted command ${result.record.sourceId} wrote stderr; output was omitted.`)] : [];
}

function stateDiagnostics(state: AiuTrustedStateEnvelope): readonly AiuHookStopDiagnostic[] {
  return state.diagnostics.map((item) => diagnostic(item.severity, `trusted-state-${item.kind}`, `Trusted state ${state.sourceId} reported ${item.kind}; detail was omitted.`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHookStopStdoutJson(value: unknown): value is AiuHookStopStdoutJson {
  if (!isRecord(value)) return false;
  if (Object.keys(value).length === 0) return true;
  return value.decision === "block" && typeof value.reason === "string" && value.reason.trim().length > 0;
}
