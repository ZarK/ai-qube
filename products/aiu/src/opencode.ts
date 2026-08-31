import { loadAiuConfig, type AiuConfig } from "./config.js";
import {
  appendAiuContinuationLog,
  createAiuTrustedStateFingerprint,
  createAiuDecisionId,
  resolveAiuContinuationPaths,
  writeAiuHostActivation,
  type AiuContinuationPaths,
  type AiuContinuationState,
} from "./continuation_store.js";
import {
  continuationSafetyCooldownActive,
  markAiuContinuationDeliveryEmitted,
  releaseAiuContinuationSafety,
  reserveAiuContinuation,
  startAiuContinuationSafety,
} from "./continuation_safety.js";
import { decideAiuContinuation, type AiuContinuationDecision } from "./decision.js";
import { renderAiuContinuationPrompt, type AiuContinuationPrompt } from "./prompt.js";
import {
  createAiuTrustedStateEnvelope,
  type AiuHostSessionState,
  type AiuTrustedStateEnvelope,
  type AiuWorkQueueState,
} from "./state.js";
import { runAiuTrustedStateAdapter } from "./trusted_adapter.js";
import { decideAiuWhipContinuation, readAiuWhipState } from "./whip.js";
import { decodeAiuContinuationEvent, getAiuContinuationAdapter } from "./continuation_adapters.js";
import type { ContinuationDecodedEvent } from "@tjalve/qube-core";

export interface AiuOpenCodeEvent {
  readonly type: string;
  readonly payload?: unknown;
}

export interface AiuOpenCodeContext {
  readonly cwd?: string;
  readonly config?: AiuConfig;
  readonly observedAt?: string;
  readonly lastPromptAt?: string;
  readonly trustedStates?: readonly AiuTrustedStateEnvelope[];
  readonly loadTrustedStates?: AiuOpenCodeTrustedStateLoader;
  readonly deliverPrompt?: AiuOpenCodePromptDeliverer;
  readonly previousResult?: AiuOpenCodeHandlerResult;
}

export interface AiuOpenCodeHandlerResult {
  readonly handled: boolean;
  readonly decision?: AiuContinuationDecision;
  readonly prompt?: AiuContinuationPrompt;
  readonly delivery?: AiuOpenCodePromptDelivery;
  readonly metadata?: AiuOpenCodeResultMetadata;
}

export interface AiuOpenCodeResultMetadata extends Readonly<Record<string, unknown>> {
  readonly eventType?: string;
  readonly sessionId?: string;
  readonly selectedSessionId?: string;
  readonly suppressions?: readonly string[];
  readonly trustedStateCount?: number;
  readonly adapterErrors?: readonly string[];
  readonly decisionId?: string;
  readonly promptFingerprint?: string;
  readonly statePath?: string;
  readonly lockPath?: string;
  readonly logPath?: string;
  readonly staleLockRecovered?: boolean;
}

export interface AiuOpenCodePromptDelivery {
  readonly delivered: boolean;
  readonly reason?: string;
  readonly targetSessionId?: string;
}

export type AiuOpenCodePromptDeliverer = (
  prompt: AiuContinuationPrompt,
  event: AiuOpenCodeEvent,
  context: AiuOpenCodeContext,
) => AiuOpenCodePromptDelivery | Promise<AiuOpenCodePromptDelivery>;

export type AiuOpenCodeTrustedStateLoader = (
  event: AiuOpenCodeEvent,
  context: AiuOpenCodeContext,
) => readonly AiuTrustedStateEnvelope[] | Promise<readonly AiuTrustedStateEnvelope[]>;

export interface AiuOpenCodeHostSessionSnapshot {
  readonly state: AiuHostSessionState;
  readonly suppressions: readonly string[];
}

export type AiuOpenCodeNext = () => Promise<AiuOpenCodeHandlerResult>;
export type AiuOpenCodeHandler = (event: AiuOpenCodeEvent, context: AiuOpenCodeContext, next: AiuOpenCodeNext) => AiuOpenCodeHandlerResult | Promise<AiuOpenCodeHandlerResult>;
type AiuOpenCodeResolvedContext = AiuOpenCodeContext & { readonly config: AiuConfig };

export interface AiuOpenCodePlugin {
  readonly name: "@tjalve/aiu/opencode";
  readonly handle: (event: AiuOpenCodeEvent, context?: AiuOpenCodeContext) => Promise<AiuOpenCodeHandlerResult>;
}

export interface AiuOpenCodePluginOptions {
  readonly before?: readonly AiuOpenCodeHandler[];
  readonly after?: readonly AiuOpenCodeHandler[];
  readonly loadTrustedStates?: AiuOpenCodeTrustedStateLoader;
  readonly deliverPrompt?: AiuOpenCodePromptDeliverer;
}

export interface AiuOpenCodeServerPluginInput {
  readonly directory?: string;
  readonly worktree?: string;
  readonly client?: AiuOpenCodeServerClient;
}

export interface AiuOpenCodeServerClient {
  readonly session?: {
    readonly command?: (input: {
      readonly path: {
        readonly id: string;
      };
      readonly body: {
        readonly command: "make-it-so";
        readonly arguments: string;
      };
      readonly query?: {
        readonly directory: string;
      };
    }) => Promise<unknown>;
  };
}

export interface AiuOpenCodeServerPluginEvent {
  readonly type: string;
  readonly payload?: unknown;
  readonly properties?: unknown;
}

export interface AiuOpenCodeServerPluginEventInput {
  readonly event: AiuOpenCodeServerPluginEvent;
}

export interface AiuOpenCodeServerPluginHooks {
  readonly event: (input: AiuOpenCodeServerPluginEventInput) => Promise<void>;
}

export type AiuOpenCodeServerPlugin = (
  input: AiuOpenCodeServerPluginInput,
  options?: unknown,
) => Promise<AiuOpenCodeServerPluginHooks>;

export function createAiuOpenCodePlugin(options: AiuOpenCodePluginOptions = {}): AiuOpenCodePlugin {
  const before = composeAiuOpenCodeHandlers(options.before ?? []);
  const after = composeAiuOpenCodeHandlers(options.after ?? []);
  return Object.freeze({
    name: "@tjalve/aiu/opencode" as const,
    handle: async (event: AiuOpenCodeEvent, context: AiuOpenCodeContext = {}) => {
      const normalizedContext = withDefaultContext({
        ...context,
        ...(options.loadTrustedStates && !context.loadTrustedStates ? { loadTrustedStates: options.loadTrustedStates } : {}),
        ...(options.deliverPrompt && !context.deliverPrompt ? { deliverPrompt: options.deliverPrompt } : {}),
      });
      const result = await before(event, normalizedContext, async () => runAiuOpenCodeContinuation(event, normalizedContext));
      return after(event, Object.freeze({ ...normalizedContext, previousResult: result }), async () => result);
    },
  });
}

export function createAiuOpenCodeServerPlugin(
  options: AiuOpenCodePluginOptions = {},
): AiuOpenCodeServerPlugin {
  return async (input) => {
    const cwd = input.directory ?? input.worktree;
    const clientDeliverer = createAiuOpenCodeClientDeliverer(input.client, cwd);
    const plugin = createAiuOpenCodePlugin({
      ...options,
      ...(options.deliverPrompt || !clientDeliverer ? {} : { deliverPrompt: clientDeliverer }),
    });
    return Object.freeze({
      event: async ({ event }: AiuOpenCodeServerPluginEventInput) => {
        await plugin.handle(
          {
            type: event.type,
            payload: event.payload ?? event.properties,
          },
          cwd === undefined ? {} : { cwd },
        );
      },
    });
  };
}

export async function runAiuOpenCodeContinuation(event: AiuOpenCodeEvent, context: AiuOpenCodeContext = {}): Promise<AiuOpenCodeHandlerResult> {
  const normalizedContext = withDefaultContext(context);
  const observedAt = normalizedContext.observedAt ?? new Date().toISOString();
  const decoded = decodeAiuContinuationEvent("opencode", { surface: "plugin-event", version: null, event });
  if (!decoded.ok) {
    return Object.freeze({
      handled: false,
      metadata: Object.freeze({
        eventType: event.type,
        suppressions: Object.freeze(["unsupported-event"]),
        trustedStateCount: 0,
      }),
    });
  }

  const host = buildAiuOpenCodeHostSession(decoded.event);
  const repoRoot = normalizedContext.cwd ?? process.cwd();
  const paths = resolveAiuContinuationPaths(repoRoot, normalizedContext.config);
  const activationSuppressions: string[] = normalizedContext.deliverPrompt === undefined ? ["host-delivery-unavailable"] : [];
  if (host.suppressions.length > 0) {
    return Object.freeze({
      handled: true,
      metadata: resultMetadata(event, host, 0, [], [...host.suppressions, ...activationSuppressions], paths),
    });
  }
  const safety = startAiuContinuationSafety({
    repoRoot,
    config: normalizedContext.config,
    hostId: "opencode",
    eventType: event.type,
    observedAt,
    ...(host.state.sessionId ? { sessionId: host.state.sessionId } : {}),
    ...(host.state.selectedSessionId ? { targetSessionId: host.state.selectedSessionId } : {}),
    nativeDelivery: false,
    consumeEvidence: true,
  });
  if (!safety.ok) {
    return Object.freeze({
      handled: true,
      metadata: resultMetadata(event, host, 0, [], [safety.reason, ...activationSuppressions], safety.paths),
    });
  }

  const transaction = safety.transaction;
  const start = Date.now();
  try {
    const persisted = transaction.state;
    const { states, adapterErrors } = await collectTrustedStates(event, normalizedContext, host.state);
    const trustedStateWasRead = states.some((state) => state.sourceId !== "opencode") && adapterErrors.length === 0;
    const whipRead = readAiuWhipState(normalizedContext.cwd ?? process.cwd(), normalizedContext.config);
    const whipDecision = decideAiuWhipContinuation({
      config: normalizedContext.config,
      state: whipRead.state,
    });
    const decision = decideAiuContinuation({
      states,
      policy: {
        modes: normalizedContext.config.hosts.modes.opencode ?? normalizedContext.config.continuation.modes,
        stopOnUnknownState: normalizedContext.config.continuation.stopOnUnknownState,
        stopOnUnsafeState: normalizedContext.config.continuation.stopOnUnsafeState,
        stopOnSupplyChainApprovalBlock: normalizedContext.config.continuation.stopOnSupplyChainApprovalBlock,
        planningEnabled: normalizedContext.config.planning.enabled,
        qualityEnabled: normalizedContext.config.quality.enabled,
        cooldownActive: normalizedContext.lastPromptAt
          ? timestampWithinCooldown(normalizedContext.lastPromptAt, observedAt, normalizedContext.config.cooldowns.promptMs)
          : continuationSafetyCooldownActive(transaction),
      },
      ...(whipDecision.enqueuesPrompt && whipDecision.task ? { whipTask: whipDecision.task } : {}),
      ...(normalizedContext.config.whip.enabled && whipRead.errors.length > 0 ? { whipStateError: { kind: "whip", sourceId: whipRead.path, status: "malformed" } } : {}),
    });
    const blockingSuppressions = [...host.suppressions, ...decisionSuppressions(decision), ...hostPolicySuppressions(normalizedContext.config, decision.kind)];
    const baseSuppressions = [...blockingSuppressions, ...activationSuppressions];
    if (blockingSuppressions.length > 0 || (decision.kind !== "continue" && decision.kind !== "repair")) {
      const logged = safeLogDecision(paths, {
        event,
        host,
        decision,
        observedAt,
        adapterErrors,
        suppressions: baseSuppressions,
        elapsedMs: Date.now() - start,
      });
      const metadataSuppressions = logged ? baseSuppressions : [...baseSuppressions, "continuation-log-write-failed"];
      return Object.freeze({
        handled: true,
        decision,
        metadata: resultMetadata(event, host, states.length, adapterErrors, metadataSuppressions, paths, persisted, {
          decisionId: createAiuDecisionId({ observedAt, eventType: event.type, sessionId: host.state.sessionId, reasonCodes: decision.reasonCodes }),
          staleLockRecovered: transaction.staleLockRecovered,
        }),
      });
    }

    const prompt = renderAiuContinuationPrompt({ decision, config: normalizedContext.config });
    const reservation = reserveAiuContinuation(transaction, decision, prompt);
    if (!reservation.ok) {
      const reportedSuppressions = [reservation.reason, ...activationSuppressions];
      const logged = safeLogDecision(paths, {
        event,
        host,
        decision,
        prompt,
        observedAt,
        adapterErrors,
        suppressions: reportedSuppressions,
        elapsedMs: Date.now() - start,
      });
      const metadataSuppressions = logged ? reportedSuppressions : [...reportedSuppressions, "continuation-log-write-failed"];
      return Object.freeze({
        handled: true,
        decision,
        prompt,
        metadata: resultMetadata(event, host, states.length, adapterErrors, metadataSuppressions, paths, persisted, {
          decisionId: createAiuDecisionId({ observedAt, eventType: event.type, sessionId: host.state.sessionId, promptFingerprint: prompt.fingerprint, reasonCodes: decision.reasonCodes }),
          promptFingerprint: prompt.fingerprint,
          staleLockRecovered: transaction.staleLockRecovered,
        }),
      });
    }

    const delivery = await deliverAiuOpenCodePrompt(prompt, event, normalizedContext);
    const suppressions = delivery.delivered ? [...baseSuppressions] : [...baseSuppressions, delivery.reason ?? "prompt-delivery-failed"];
    if (delivery.delivered) {
      const emitted = markAiuContinuationDeliveryEmitted(transaction);
      if (!emitted.ok) suppressions.push(emitted.reason);
      if (trustedStateWasRead) {
        const activationSuppression = recordOpenCodeActivation(paths, observedAt, normalizedContext.config);
        if (activationSuppression) suppressions.push(activationSuppression);
      }
    }
    const logged = safeLogDecision(paths, {
      event,
      host,
      decision,
      prompt,
      delivery,
      observedAt,
      adapterErrors,
      suppressions,
      elapsedMs: Date.now() - start,
    });
    if (!logged) {
      suppressions.push("continuation-log-write-failed");
    }
    return Object.freeze({
      handled: true,
      decision,
      prompt,
      delivery,
      metadata: resultMetadata(event, host, states.length, adapterErrors, suppressions, paths, persisted, {
        decisionId: createAiuDecisionId({ observedAt, eventType: event.type, sessionId: host.state.sessionId, promptFingerprint: prompt.fingerprint, reasonCodes: decision.reasonCodes }),
        promptFingerprint: prompt.fingerprint,
        staleLockRecovered: transaction.staleLockRecovered,
      }),
    });
  } finally {
    releaseAiuContinuationSafety(transaction);
  }
}

function recordOpenCodeActivation(
  paths: AiuContinuationPaths,
  observedAt: string,
  config: AiuConfig,
): "host-activation-write-failed" | undefined {
  try {
    writeAiuHostActivation(paths, {
      schemaVersion: 1,
      host: "opencode",
      delivery: getAiuContinuationAdapter("opencode").declaration.activationEvidence.delivery,
      event: getAiuContinuationAdapter("opencode").declaration.activationEvidence.event,
      trustedStateFingerprint: createAiuTrustedStateFingerprint(config.trustedStateCommands),
      observedAt,
    });
    return undefined;
  } catch {
    return "host-activation-write-failed";
  }
}

export function composeAiuOpenCodeHandlers(handlers: readonly AiuOpenCodeHandler[]): AiuOpenCodeHandler {
  return async (event, context, next) => {
    let index = -1;
    async function dispatch(position: number): Promise<AiuOpenCodeHandlerResult> {
      if (position <= index) {
        throw new Error("OpenCode handler next() was called more than once.");
      }
      index = position;
      const handler = handlers[position];
      return handler === undefined ? next() : handler(event, context, () => dispatch(position + 1));
    }
    return dispatch(0);
  };
}

function withDefaultContext(context: AiuOpenCodeContext): AiuOpenCodeResolvedContext {
  const config = context.config ?? loadAiuConfig({ cwd: context.cwd }).config;
  return Object.freeze({
    ...context,
    config,
  });
}

function buildAiuOpenCodeHostSession(event: ContinuationDecodedEvent): AiuOpenCodeHostSessionSnapshot {
  const suppressions = [...(event.suppressions ?? [])];
  const helperSession = suppressions.includes("helper-session") ? true : undefined;
  const userActive = suppressions.includes("user-active") ? true : undefined;
  const todoActive = suppressions.includes("todo-active") ? true : undefined;
  const canPrompt = suppressions.length === 0;
  const state: AiuHostSessionState = Object.freeze({
    kind: "host-session",
    status: "pass",
    hostId: "opencode",
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    ...(event.selectedSessionId ? { selectedSessionId: event.selectedSessionId } : {}),
    helperSession,
    userActive,
    todoActive,
    sessionStatus: canPrompt ? "idle" : "busy",
    canPrompt,
  });

  return Object.freeze({
    state,
    suppressions: Object.freeze(suppressions),
  });
}

async function collectTrustedStates(
  event: AiuOpenCodeEvent,
  context: AiuOpenCodeResolvedContext,
  hostState: AiuHostSessionState,
): Promise<{ readonly states: readonly AiuTrustedStateEnvelope[]; readonly adapterErrors: readonly string[] }> {
  const observedAt = context.observedAt ?? new Date().toISOString();
  const states: AiuTrustedStateEnvelope[] = [
    createAiuTrustedStateEnvelope({
      sourceId: "opencode",
      command: { id: "opencode", argv: ["opencode"] },
      observedAt,
      trustLevel: "trusted",
      capabilities: {
        sessionState: "supported",
        selectedSession: hostState.selectedSessionId ? "supported" : "unknown",
        userActivity: hostState.userActive === undefined ? "unknown" : "supported",
        todoRead: hostState.todoActive === undefined ? "unknown" : "supported",
      },
      freshness: { kind: "fresh", observedAt },
      value: hostState,
    }),
  ];
  const adapterErrors: string[] = [];

  if (context.trustedStates) {
    states.push(...context.trustedStates);
  }
  if (context.loadTrustedStates) {
    try {
      states.push(...await context.loadTrustedStates(event, context));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      adapterErrors.push(`opencode-loader: ${message}`);
      states.push(adapterErrorEnvelope("opencode-loader", message, observedAt));
    }
  }

  for (const [sourceId, descriptor] of Object.entries(context.config?.trustedStateCommands ?? {})) {
    const result = await runAiuTrustedStateAdapter(sourceId, descriptor, {
      cwd: context.cwd,
      timeoutMs: context.config?.timeouts.commandMs,
      observedAt,
    });
    if (result.ok) {
      states.push(...result.states);
    } else {
      adapterErrors.push(`${sourceId}: ${result.error.message}`);
      states.push(adapterErrorEnvelope(sourceId, result.error.message, observedAt));
    }
  }

  return Object.freeze({ states: Object.freeze(states), adapterErrors: Object.freeze(adapterErrors) });
}

function decisionSuppressions(decision: AiuContinuationDecision): readonly string[] {
  return decision.kind === "wait" || decision.kind === "stop" ? decision.reasonCodes : [];
}

function adapterErrorEnvelope(sourceId: string, message: string, observedAt: string): AiuTrustedStateEnvelope<AiuWorkQueueState> {
  return createAiuTrustedStateEnvelope({
    sourceId,
    command: { id: sourceId, argv: ["trusted-state-adapter"] },
    observedAt,
    trustLevel: "trusted",
    capabilities: {},
    freshness: { kind: "fresh", observedAt },
    value: {
      kind: "work-queue",
      status: "malformed",
      summary: message,
      activeItems: [],
      readyItems: [],
      blockedItems: [],
      unknownItems: [],
    },
    diagnostics: [
      {
        severity: "error",
        kind: "malformed",
        path: "$",
        message,
        reasonCode: "stop-malformed-input",
      },
    ],
  });
}

function hostPolicySuppressions(config: AiuConfig | undefined, decisionKind: AiuContinuationDecision["kind"]): readonly string[] {
  if (!config?.hosts.enabled.includes("opencode")) {
    return Object.freeze(["host-disabled"]);
  }
  const allowedModes = config.hosts.modes.opencode ?? config.continuation.modes;
  if (!allowedModes.includes(decisionKind)) {
    return Object.freeze(["host-mode-disabled"]);
  }
  const promptDelivery = config.hosts.capabilities.opencode?.promptDelivery;
  if (promptDelivery === false || promptDelivery === "none") {
    return Object.freeze(["prompt-delivery-disabled"]);
  }
  return Object.freeze([]);
}

function timestampWithinCooldown(previousAt: string, observedAt: string, cooldownMs: number): boolean {
  const previous = Date.parse(previousAt);
  const current = Date.parse(observedAt);
  return Number.isFinite(previous) && Number.isFinite(current) && current - previous < cooldownMs;
}

async function deliverAiuOpenCodePrompt(
  prompt: AiuContinuationPrompt,
  event: AiuOpenCodeEvent,
  context: AiuOpenCodeContext,
): Promise<AiuOpenCodePromptDelivery> {
  if (!context.deliverPrompt) {
    return Object.freeze({ delivered: false, reason: "no-prompt-deliverer" });
  }
  try {
    const result = await context.deliverPrompt(prompt, event, context);
    return normalizeDeliveryResult(result);
  } catch (error) {
    return Object.freeze({
      delivered: false,
      reason: `prompt-delivery-error: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

function createAiuOpenCodeClientDeliverer(
  client: AiuOpenCodeServerClient | undefined,
  cwd: string | undefined,
): AiuOpenCodePromptDeliverer | undefined {
  const command = client?.session?.command;
  if (!command) return undefined;
  return async (_prompt, event) => {
    const decoded = decodeAiuContinuationEvent("opencode", { surface: "plugin-event", version: null, event });
    if (!decoded.ok) return Object.freeze({ delivered: false, reason: decoded.code });
    const host = buildAiuOpenCodeHostSession(decoded.event).state;
    const targetSessionId = host.selectedSessionId ?? host.sessionId;
    if (!targetSessionId) {
      return Object.freeze({ delivered: false, reason: "missing-target-session" });
    }
    const encoded = getAiuContinuationAdapter("opencode").encodeResponse({ decision: "deliver", sessionId: targetSessionId, cwd });
    if (!encoded.ok || !isOpenCodeCommandRequest(encoded.response)) return Object.freeze({ delivered: false, reason: "invalid-host-response" });
    const response = await command.call(client.session, encoded.response);
    if (isRecord(response) && response.error !== undefined && response.error !== null) {
      return Object.freeze({ delivered: false, reason: "command-rejected" });
    }
    return Object.freeze({ delivered: true, targetSessionId });
  };
}

function isOpenCodeCommandRequest(value: unknown): value is Parameters<NonNullable<NonNullable<AiuOpenCodeServerClient["session"]>["command"]>>[0] {
  if (!isRecord(value) || !isRecord(value.path) || !isRecord(value.body)) return false;
  return typeof value.path.id === "string" && value.body.command === "make-it-so" && value.body.arguments === ""
    && (value.query === undefined || (isRecord(value.query) && typeof value.query.directory === "string"));
}

function normalizeDeliveryResult(result: unknown): AiuOpenCodePromptDelivery {
  const value = isRecord(result) ? result : {};
  return Object.freeze({
    delivered: value.delivered === true,
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    ...(typeof value.targetSessionId === "string" ? { targetSessionId: value.targetSessionId } : {}),
  });
}

function resultMetadata(
  event: AiuOpenCodeEvent,
  host: AiuOpenCodeHostSessionSnapshot,
  trustedStateCount: number,
  adapterErrors: readonly string[],
  suppressions: readonly string[],
  paths?: AiuContinuationPaths,
  _persisted?: AiuContinuationState,
  extras: Partial<AiuOpenCodeResultMetadata> = {},
): AiuOpenCodeResultMetadata {
  return Object.freeze({
    eventType: event.type,
    ...(host.state.sessionId ? { sessionId: host.state.sessionId } : {}),
    ...(host.state.selectedSessionId ? { selectedSessionId: host.state.selectedSessionId } : {}),
    suppressions: Object.freeze([...new Set(suppressions)]),
    trustedStateCount,
    adapterErrors: Object.freeze([...adapterErrors]),
    ...(paths ? { statePath: paths.statePath, lockPath: paths.lockPath, logPath: paths.logPath } : {}),
    ...extras,
  });
}

function safeLogDecision(paths: AiuContinuationPaths, input: {
  readonly event: AiuOpenCodeEvent;
  readonly host: AiuOpenCodeHostSessionSnapshot;
  readonly decision: AiuContinuationDecision;
  readonly prompt?: AiuContinuationPrompt;
  readonly delivery?: AiuOpenCodePromptDelivery;
  readonly observedAt: string;
  readonly adapterErrors: readonly string[];
  readonly suppressions: readonly string[];
  readonly elapsedMs: number;
}): boolean {
  return safeAppendContinuationLog(paths, {
    event: "decision",
    observedAt: input.observedAt,
    eventType: input.event.type,
    hostId: "opencode",
    ...(input.host.state.sessionId ? { sessionId: input.host.state.sessionId } : {}),
    ...(input.host.state.selectedSessionId ? { selectedSessionId: input.host.state.selectedSessionId } : {}),
    decisionId: createAiuDecisionId({
      observedAt: input.observedAt,
      eventType: input.event.type,
      sessionId: input.host.state.sessionId,
      promptFingerprint: input.prompt?.fingerprint,
      reasonCodes: input.decision.reasonCodes,
    }),
    decisionKind: input.decision.kind,
    mode: input.decision.selectedMode,
    promptKind: input.decision.promptKind,
    reasonCodes: input.decision.reasonCodes,
    ...(input.decision.selectedItem ? { selectedItem: input.decision.selectedItem } : {}),
    ...(input.prompt ? { promptFingerprint: input.prompt.fingerprint } : {}),
    ...(input.delivery?.targetSessionId ? { targetSessionId: input.delivery.targetSessionId } : {}),
    sourceSummaries: input.decision.sourceSummaries,
    adapterErrors: input.adapterErrors,
    suppressions: input.suppressions,
    elapsedMs: input.elapsedMs,
  });
}

function safeAppendContinuationLog(paths: AiuContinuationPaths, entry: Parameters<typeof appendAiuContinuationLog>[1]): boolean {
  try {
    appendAiuContinuationLog(paths, entry);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
