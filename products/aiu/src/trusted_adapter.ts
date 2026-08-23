import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";
import { redactText } from "@tjalve/qube-cli/redaction";

import type { AiuTrustedStateCommandDescriptor } from "./config.js";
import {
  AIU_STATE_CAPABILITY_SUPPORT,
  AIU_STATE_FRESHNESS_KINDS,
  AIU_STATE_VALUE_KINDS,
  AIU_QUALITY_TARGET_KINDS,
  AIU_TRUSTED_STATE_KINDS,
  AIU_TRUSTED_STATE_SCHEMA_VERSION,
  AIU_TRUST_LEVELS,
  createAiuTrustedStateEnvelope,
  type AiuStateCapabilitySupport,
  type AiuStateFreshness,
  type AiuStateFreshnessKind,
  type AiuStateValueKind,
  type AiuContinuationPolicyState,
  type AiuPlanningAction,
  type AiuPlanningArtifact,
  type AiuPlanningDecision,
  type AiuPlanningProvider,
  type AiuPlanningQuestion,
  type AiuPlanningState,
  type AiuPlanningStopCondition,
  type AiuQualityFinding,
  type AiuQualitySelectedTarget,
  type AiuQualityStage,
  type AiuQualityState,
  type AiuQualityTargetKind,
  type AiuReviewState,
  type AiuTrustLevel,
  type AiuTrustedStateCommandRef,
  type AiuTrustedStateEnvelope,
  type AiuTrustedStatePayload,
  type AiuWorkItemState,
  type AiuWorkQueueState,
} from "./state.js";

export const AIU_TRUSTED_COMMAND_DEFAULT_TIMEOUT_MS = 30_000;
export const AIU_TRUSTED_COMMAND_DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
export const AIU_TRUSTED_COMMAND_DEFAULT_KILL_GRACE_MS = 1_000;

export const AIU_TRUSTED_ADAPTER_ERROR_CODES = [
  "trusted-command-spawn-failed",
  "trusted-command-timeout",
  "trusted-command-non-zero-exit",
  "trusted-command-output-limit",
  "trusted-command-malformed-json",
  "trusted-command-unknown-schema",
  "trusted-command-unsupported-capability",
  "trusted-command-stale-state",
  "trusted-command-invalid-state",
] as const;

export type AiuTrustedAdapterErrorCode = (typeof AIU_TRUSTED_ADAPTER_ERROR_CODES)[number];

export interface AiuTrustedCommandExecutionRecord {
  readonly sourceId: string;
  readonly command: AiuTrustedStateCommandRef;
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stderrSummary: string;
  readonly elapsedMs: number;
  readonly timedOut: boolean;
  readonly outputLimitExceeded: boolean;
  readonly parsedSchemaVersion?: number;
}

export interface AiuTrustedAdapterError {
  readonly code: AiuTrustedAdapterErrorCode;
  readonly message: string;
  readonly path?: string;
}

export type AiuTrustedCommandExecutionResult =
  | {
      readonly ok: true;
      readonly record: AiuTrustedCommandExecutionRecord;
      readonly stdout: string;
    }
  | {
      readonly ok: false;
      readonly record: AiuTrustedCommandExecutionRecord;
      readonly error: AiuTrustedAdapterError;
    };

export type AiuTrustedStateAdapterResult =
  | {
      readonly ok: true;
      readonly record: AiuTrustedCommandExecutionRecord;
      readonly states: readonly AiuTrustedStateEnvelope[];
    }
  | {
      readonly ok: false;
      readonly record: AiuTrustedCommandExecutionRecord;
      readonly error: AiuTrustedAdapterError;
    };

export interface AiuTrustedCommandExecutionOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly killGraceMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly observedAt?: string;
}

export interface AiuTrustedStateParseInput {
  readonly sourceId: string;
  readonly command: AiuTrustedStateCommandRef;
  readonly stdout: string;
  readonly observedAt?: string;
  readonly record?: AiuTrustedCommandExecutionRecord;
}

export async function runAiuTrustedStateAdapter(
  sourceId: string,
  descriptor: AiuTrustedStateCommandDescriptor,
  options: AiuTrustedCommandExecutionOptions = {},
): Promise<AiuTrustedStateAdapterResult> {
  const execution = await executeAiuTrustedCommand(sourceId, descriptor, options);
  if (!execution.ok) {
    return execution;
  }

  return parseAiuTrustedStateJson({
    sourceId,
    command: execution.record.command,
    stdout: execution.stdout,
    observedAt: options.observedAt,
    record: execution.record,
  });
}

export function toAiuTrustedStateCommandRef(sourceId: string, descriptor: AiuTrustedStateCommandDescriptor): AiuTrustedStateCommandRef {
  return Object.freeze({
    id: sourceId,
    argv: Object.freeze([...descriptor.argv]) as readonly [string, ...string[]],
    ...(descriptor.cwd ? { cwd: descriptor.cwd } : {}),
    ...(descriptor.timeoutMs ? { timeoutMs: descriptor.timeoutMs } : {}),
    ...(descriptor.maxOutputBytes ? { maxOutputBytes: descriptor.maxOutputBytes } : {}),
  });
}

export function executeAiuTrustedCommand(
  sourceId: string,
  descriptor: AiuTrustedStateCommandDescriptor,
  options: AiuTrustedCommandExecutionOptions = {},
): Promise<AiuTrustedCommandExecutionResult> {
  const command = toAiuTrustedStateCommandRef(sourceId, descriptor);
  const timeoutMs = normalizePositiveInteger(options.timeoutMs ?? descriptor.timeoutMs, AIU_TRUSTED_COMMAND_DEFAULT_TIMEOUT_MS);
  const maxOutputBytes = normalizePositiveInteger(options.maxOutputBytes ?? descriptor.maxOutputBytes, AIU_TRUSTED_COMMAND_DEFAULT_MAX_OUTPUT_BYTES);
  const killGraceMs = normalizePositiveInteger(options.killGraceMs, AIU_TRUSTED_COMMAND_DEFAULT_KILL_GRACE_MS);
  const startedAt = Date.now();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputBytes = 0;
  let timedOut = false;
  let outputLimitExceeded = false;
  let settled = false;
  let forceKill: NodeJS.Timeout | undefined;

  return new Promise((resolve) => {
    const [commandName, ...commandArgs] = descriptor.argv;
    const resolved = resolveTrustedCommandExecutable(commandName, descriptor.cwd ?? options.cwd) ?? commandName;
    const useWindowsCmd = process.platform === "win32" && /\.(cmd|bat)$/iu.test(resolved);
    const executable = useWindowsCmd ? (process.env.ComSpec ?? "cmd.exe") : resolved;
    const args = useWindowsCmd ? ["/d", "/s", "/c", resolved, ...commandArgs] : commandArgs;
    const child = spawn(executable, args, {
      cwd: descriptor.cwd ?? options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      requestTermination({
        code: "trusted-command-timeout",
        message: `Trusted command ${sourceId} timed out after ${timeoutMs}ms.`,
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      collectBoundedChunk(stdoutChunks, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      collectBoundedChunk(stderrChunks, chunk);
    });
    child.on("error", (error) => {
      finish({
        code: "trusted-command-spawn-failed",
        message: redactText(error.message),
      });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      const record = buildRecord(exitCode, signal);
      if (timedOut) {
        finishWithRecord(record, {
          code: "trusted-command-timeout",
          message: `Trusted command ${sourceId} timed out after ${timeoutMs}ms.`,
        });
        return;
      }
      if (outputLimitExceeded) {
        finishWithRecord(record, {
          code: "trusted-command-output-limit",
          message: `Trusted command ${sourceId} exceeded ${maxOutputBytes} output bytes.`,
        });
        return;
      }
      if (exitCode !== 0) {
        finishWithRecord(record, {
          code: "trusted-command-non-zero-exit",
          message: `Trusted command ${sourceId} exited with code ${String(exitCode)}.`,
        });
        return;
      }
      settled = true;
      resolve(Object.freeze({
        ok: true as const,
        record,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      }));
    });

    function collectBoundedChunk(target: Buffer[], chunk: Buffer): void {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        outputLimitExceeded = true;
        const remaining = Math.max(0, maxOutputBytes - (outputBytes - chunk.length));
        if (remaining > 0) {
          target.push(chunk.subarray(0, remaining));
        }
        requestTermination({
          code: "trusted-command-output-limit",
          message: `Trusted command ${sourceId} exceeded ${maxOutputBytes} output bytes.`,
        });
        return;
      }
      target.push(chunk);
    }

    function requestTermination(error: AiuTrustedAdapterError): void {
      if (settled) return;
      child.kill("SIGTERM");
      forceKill ??= setTimeout(() => {
        child.kill("SIGKILL");
        finishWithRecord(buildRecord(null, "SIGKILL"), error);
      }, killGraceMs);
    }

    function finish(error: AiuTrustedAdapterError): void {
      clearTimeout(timeout);
      finishWithRecord(buildRecord(null, null), error);
    }

    function finishWithRecord(record: AiuTrustedCommandExecutionRecord, error: AiuTrustedAdapterError): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      resolve(Object.freeze({
        ok: false as const,
        record,
        error: Object.freeze(error),
      }));
    }

    function buildRecord(exitCode: number | null, signal: NodeJS.Signals | null): AiuTrustedCommandExecutionRecord {
      return Object.freeze({
        sourceId,
        command,
        ...(descriptor.cwd ?? options.cwd ? { cwd: descriptor.cwd ?? options.cwd } : {}),
        timeoutMs,
        maxOutputBytes,
        exitCode,
        signal,
        stdoutBytes,
        stderrBytes,
        stderrSummary: summarizeStderr(stderrChunks),
        elapsedMs: Math.max(0, Date.now() - startedAt),
        timedOut,
        outputLimitExceeded,
      });
    }
  });
}

export function parseAiuTrustedStateJson(input: AiuTrustedStateParseInput): AiuTrustedStateAdapterResult {
  let raw: unknown;
  try {
    raw = JSON.parse(input.stdout) as unknown;
  } catch (error) {
    return parseFailure(input, "trusted-command-malformed-json", `Trusted command ${input.sourceId} did not emit valid JSON: ${redactText(error instanceof Error ? error.message : String(error))}`);
  }
  const parsedSchemaVersion = readSchemaVersion(raw);
  if (parsedSchemaVersion !== AIU_TRUSTED_STATE_SCHEMA_VERSION) {
    return parseFailure(input, "trusted-command-unknown-schema", `Trusted command ${input.sourceId} emitted unsupported schema version ${String(parsedSchemaVersion)}.`, "$.schemaVersion", parsedSchemaVersion);
  }

  const entries = isRecord(raw) && Array.isArray(raw.states) ? raw.states : [raw];
  const states: AiuTrustedStateEnvelope[] = [];
  for (const [index, entry] of entries.entries()) {
    const normalized = normalizeTrustedStateEntry(entry, input, `$.states[${index}]`);
    if (!normalized.ok) {
      return { ...normalized, record: attachParsedSchema(input.record, parsedSchemaVersion) };
    }
    states.push(normalized.state);
  }

  return Object.freeze({
    ok: true as const,
    record: attachParsedSchema(input.record, parsedSchemaVersion),
    states: Object.freeze(states),
  });
}

function normalizeTrustedStateEntry(
  entry: unknown,
  input: AiuTrustedStateParseInput,
  path: string,
): { readonly ok: true; readonly state: AiuTrustedStateEnvelope } | { readonly ok: false; readonly error: AiuTrustedAdapterError; readonly record: AiuTrustedCommandExecutionRecord } {
  if (!isRecord(entry)) {
    return parseFailure(input, "trusted-command-invalid-state", "Trusted state entry must be an object.", path);
  }

  const envelopeInput = isRecord(entry.value) ? entry : { ...entry, value: withoutEnvelopeFields(entry) };
  const value = envelopeInput.value;
  if (!isRecord(value) || !isTrustedStateKind(value.kind) || !isStateValueKind(value.status)) {
    return parseFailure(input, "trusted-command-invalid-state", "Trusted state value must include a supported kind and status.", `${path}.value`);
  }
  if (envelopeInput.trustLevel !== undefined && !isTrustLevel(envelopeInput.trustLevel)) {
    return parseFailure(input, "trusted-command-invalid-state", "Trusted state trustLevel must be trusted, advisory, or untrusted.", `${path}.trustLevel`);
  }
  if (envelopeInput.freshness !== undefined && (!isRecord(envelopeInput.freshness) || !isFreshnessKind(envelopeInput.freshness.kind))) {
    return parseFailure(input, "trusted-command-invalid-state", "Trusted state freshness must include a supported kind.", `${path}.freshness`);
  }
  const normalizedValue = normalizeTrustedStateValue(value);
  const capabilities = normalizeCapabilities(envelopeInput.capabilities);
  if (Object.values(capabilities).some((support) => support === "unsupported")) {
    return parseFailure(input, "trusted-command-unsupported-capability", "Trusted state reports an unsupported required capability.", `${path}.capabilities`);
  }
  const freshness = normalizeFreshness(envelopeInput.freshness, readString(envelopeInput.observedAt) ?? input.observedAt);
  if (freshness.kind === "stale" || value.status === "stale") {
    return parseFailure(input, "trusted-command-stale-state", "Trusted state is stale and cannot be treated as success.", path);
  }

  return {
    ok: true as const,
    state: createAiuTrustedStateEnvelope({
      sourceId: readString(envelopeInput.sourceId) ?? input.sourceId,
      command: input.command,
      observedAt: readString(envelopeInput.observedAt) ?? input.observedAt ?? new Date(0).toISOString(),
      trustLevel: readTrustLevel(envelopeInput.trustLevel),
      capabilities,
      freshness,
      value: normalizedValue,
      unknownFields: readStringArray(envelopeInput.unknownFields),
      diagnostics: [],
    }),
  };
}

function normalizeTrustedStateValue(value: Record<string, unknown>): AiuTrustedStatePayload {
  if (value.kind === "work-queue") {
    return normalizeWorkQueueState(value);
  }
  if (value.kind === "work-item") {
    return normalizeWorkItemState(value);
  }
  if (value.kind === "review") {
    return normalizeReviewState(value);
  }
  if (value.kind === "continuation-policy") {
    return normalizeContinuationPolicyState(value);
  }
  if (value.kind === "planning") {
    return normalizePlanningState(value);
  }
  if (value.kind === "quality") {
    return normalizeQualityState(value);
  }
  return value as unknown as AiuTrustedStatePayload;
}

function normalizeWorkQueueState(value: Record<string, unknown>): AiuWorkQueueState {
  const summary = readString(value.summary);
  return Object.freeze({
    kind: "work-queue",
    status: value.status as AiuStateValueKind,
    ...(summary ? { summary } : {}),
    activeItems: normalizeWorkItems(value.activeItems),
    readyItems: normalizeWorkItems(value.readyItems),
    blockedItems: normalizeWorkItems(value.blockedItems),
    unknownItems: normalizeWorkItems(value.unknownItems),
  });
}

function normalizeWorkItems(value: unknown): readonly AiuWorkItemState[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.flatMap((item) => isRecord(item) && readString(item.id) ? [normalizeWorkItemState(item)] : []));
}

function normalizeWorkItemState(value: Record<string, unknown>): AiuWorkItemState {
  const title = readString(value.title);
  const summary = readString(value.summary);
  const nextAction = normalizeCommandRef(value.nextAction);
  return Object.freeze({
    kind: "work-item",
    status: isStateValueKind(value.status) ? value.status : "unknown",
    ...(summary ? { summary } : {}),
    id: readString(value.id) ?? "unknown",
    ...(title ? { title } : {}),
    lifecycle: isWorkItemLifecycle(value.lifecycle) ? value.lifecycle : "unknown",
    ...(isWorkItemPriority(value.priority) ? { priority: value.priority } : {}),
    blockers: Object.freeze(readStringArray(value.blockers)),
    ...(nextAction ? { nextAction } : {}),
  });
}

function normalizeReviewState(value: Record<string, unknown>): AiuReviewState {
  const targetId = readString(value.targetId);
  const summary = readString(value.summary);
  const nextAction = normalizeCommandRef(value.nextAction);
  const unresolvedFeedbackCount = readNonNegativeInteger(value.unresolvedFeedbackCount);
  return Object.freeze({
    kind: "review",
    status: isStateValueKind(value.status) ? value.status : "unknown",
    ...(summary ? { summary } : {}),
    ...(targetId ? { targetId } : {}),
    reviewStatus: isReviewStatus(value.reviewStatus) ? value.reviewStatus : "unknown",
    ...(unresolvedFeedbackCount !== undefined ? { unresolvedFeedbackCount } : {}),
    ...(nextAction ? { nextAction } : {}),
  });
}

function normalizeContinuationPolicyState(value: Record<string, unknown>): AiuContinuationPolicyState {
  const summary = readString(value.summary);
  const modes = readStringArray(value.allowedModes).filter((mode) => ["continue", "repair", "wait", "stop"].includes(mode)) as AiuContinuationPolicyState["allowedModes"];
  const allowedModes: AiuContinuationPolicyState["allowedModes"] = modes.length > 0 ? Object.freeze([...modes]) : Object.freeze(["stop"]);
  return Object.freeze({
    kind: "continuation-policy",
    status: isStateValueKind(value.status) ? value.status : "unknown",
    ...(summary ? { summary } : {}),
    allowedModes,
    stopOnUnknownState: readBooleanUnknownUnsupported(value.stopOnUnknownState, true),
    stopOnStaleState: readBooleanUnknownUnsupported(value.stopOnStaleState, true),
    stopOnSupplyChainApprovalBlock: readBooleanUnknownUnsupported(value.stopOnSupplyChainApprovalBlock, true),
    allowProviderMutation: readBooleanUnknownUnsupported(value.allowProviderMutation, false),
    allowBackgroundScheduling: readBooleanUnknownUnsupported(value.allowBackgroundScheduling, false),
  });
}

function normalizePlanningState(value: Record<string, unknown>): AiuPlanningState {
  const summary = readString(value.summary);
  const currentPhase = readString(value.currentPhase);
  const nextAction = normalizePlanningAction(value.nextAction);
  const stopCondition = normalizePlanningStopCondition(value.stopCondition);
  const supplyChainApprovalRequired = readBooleanUnknown(value.supplyChainApprovalRequired);
  return Object.freeze({
    kind: "planning",
    status: value.status as AiuStateValueKind,
    ...(summary ? { summary } : {}),
    needsPlanning: readBooleanUnknownUnsupported(value.needsPlanning, false),
    humanInputRequired: readBooleanUnknown(value.humanInputRequired) ?? "unknown",
    ...(currentPhase ? { currentPhase } : {}),
    decisions: normalizePlanningDecisions(value.decisions),
    unresolvedQuestions: normalizePlanningQuestions(value.unresolvedQuestions),
    draftPaths: Object.freeze(readStringArray(value.draftPaths)),
    artifacts: normalizePlanningArtifacts(value.artifacts),
    providers: normalizePlanningProviders(value.providers),
    ...(nextAction ? { nextAction } : {}),
    ...(stopCondition ? { stopCondition } : {}),
    ...(supplyChainApprovalRequired !== undefined ? { supplyChainApprovalRequired } : {}),
    ...(Array.isArray(value.reasonCodes) ? { reasonCodes: readStringArray(value.reasonCodes) as AiuPlanningState["reasonCodes"] } : {}),
  });
}

function normalizePlanningDecisions(value: unknown): readonly AiuPlanningDecision[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.flatMap((item): AiuPlanningDecision[] => {
    if (!isRecord(item) || !readString(item.id)) return [];
    const title = readString(item.title);
    const summary = readString(item.summary);
    const source = readString(item.source);
    return [Object.freeze({
      id: readString(item.id) as string,
      ...(title ? { title } : {}),
      status: item.status === "decided" || item.status === "pending" || item.status === "unknown" ? item.status : "unknown",
      ...(summary ? { summary } : {}),
      ...(source ? { source } : {}),
    })];
  }));
}

function normalizePlanningQuestions(value: unknown): readonly AiuPlanningQuestion[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.flatMap((item): AiuPlanningQuestion[] => {
    if (!isRecord(item) || !readString(item.id)) return [];
    const title = readString(item.title);
    const summary = readString(item.summary);
    const requiresHuman = readBooleanUnknown(item.requiresHuman);
    return [Object.freeze({
      id: readString(item.id) as string,
      ...(title ? { title } : {}),
      ...(summary ? { summary } : {}),
      ...(isPlanningQuestionCategory(item.category) ? { category: item.category } : {}),
      status: isStateValueKind(item.status) ? item.status : "unknown",
      ...(requiresHuman !== undefined ? { requiresHuman } : {}),
      affectedPaths: Object.freeze(readStringArray(item.affectedPaths)),
    })];
  }));
}

function normalizePlanningArtifacts(value: unknown): readonly AiuPlanningArtifact[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.flatMap((item): AiuPlanningArtifact[] => {
    if (!isRecord(item) || !readString(item.path)) return [];
    const kind = readString(item.kind);
    const summary = readString(item.summary);
    return [Object.freeze({
      path: readString(item.path) as string,
      ...(kind ? { kind } : {}),
      status: isStateValueKind(item.status) ? item.status : "unknown",
      ...(summary ? { summary } : {}),
    })];
  }));
}

function normalizePlanningProviders(value: unknown): readonly AiuPlanningProvider[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.flatMap((item): AiuPlanningProvider[] => {
    if (!isRecord(item) || !readString(item.id)) return [];
    const kind = readString(item.kind);
    const summary = readString(item.summary);
    return [Object.freeze({
      id: readString(item.id) as string,
      ...(kind ? { kind } : {}),
      status: isStateValueKind(item.status) ? item.status : "unknown",
      ...(summary ? { summary } : {}),
    })];
  }));
}

function normalizePlanningAction(value: unknown): AiuPlanningAction | undefined {
  if (!isRecord(value) || !readString(value.id)) return undefined;
  const title = readString(value.title);
  const kind = readString(value.kind);
  const command = normalizeCommandRef(value.command);
  const expectedEvidence = readString(value.expectedEvidence);
  return Object.freeze({
    id: readString(value.id) as string,
    ...(title ? { title } : {}),
    ...(kind ? { kind } : {}),
    status: isStateValueKind(value.status) ? value.status : "unknown",
    ...(command ? { command } : {}),
    artifactChecks: Object.freeze(readStringArray(value.artifactChecks)),
    draftPaths: Object.freeze(readStringArray(value.draftPaths)),
    ...(expectedEvidence ? { expectedEvidence } : {}),
  });
}

function normalizePlanningStopCondition(value: unknown): AiuPlanningStopCondition | undefined {
  if (!isRecord(value) || !readString(value.id)) return undefined;
  const title = readString(value.title);
  const requiresHuman = readBooleanUnknown(value.requiresHuman);
  return Object.freeze({
    id: readString(value.id) as string,
    ...(title ? { title } : {}),
    category: isPlanningStopCategory(value.category) ? value.category : "unknown",
    status: isStateValueKind(value.status) ? value.status : "unknown",
    ...(requiresHuman !== undefined ? { requiresHuman } : {}),
    affectedPaths: Object.freeze(readStringArray(value.affectedPaths)),
  });
}

function normalizeQualityState(value: Record<string, unknown>): AiuQualityState {
  const stages = normalizeQualityStages(value.stages);
  const findings = normalizeQualityFindings(value.findings);
  const selectedTarget = normalizeQualitySelectedTarget(value.selectedTarget);
  const summary = readString(value.summary);
  const nextCommand = normalizeCommandRef(value.nextCommand);
  const rerunCommand = normalizeCommandRef(value.rerunCommand);
  const humanApprovalRequired = readBooleanUnknown(value.humanApprovalRequired);
  const supplyChainApprovalRequired = readBooleanUnknown(value.supplyChainApprovalRequired);
  return Object.freeze({
    kind: "quality",
    status: value.status as AiuStateValueKind,
    ...(summary ? { summary } : {}),
    ready: readBooleanUnknownUnsupported(value.ready, false),
    lastRunStatus: isStateValueKind(value.lastRunStatus) ? value.lastRunStatus : value.status as AiuStateValueKind,
    stages,
    findings,
    failingChecks: Object.freeze(readStringArray(value.failingChecks)),
    affectedPaths: Object.freeze(readStringArray(value.affectedPaths)),
    ...(nextCommand ? { nextCommand } : {}),
    ...(rerunCommand ? { rerunCommand } : {}),
    ...(selectedTarget ? { selectedTarget } : {}),
    ...(humanApprovalRequired !== undefined ? { humanApprovalRequired } : {}),
    ...(supplyChainApprovalRequired !== undefined ? { supplyChainApprovalRequired } : {}),
    ...(Array.isArray(value.reasonCodes) ? { reasonCodes: readStringArray(value.reasonCodes) as AiuQualityState["reasonCodes"] } : {}),
  });
}

function normalizeQualityStages(value: unknown): readonly AiuQualityStage[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.flatMap((item): AiuQualityStage[] => {
    if (!isRecord(item) || !readString(item.id)) return [];
    const id = readString(item.id) as string;
    const title = readString(item.title);
    const command = normalizeCommandRef(item.command);
    const rerunCommand = normalizeCommandRef(item.rerunCommand);
    return [Object.freeze({
      id,
      ...(title ? { title } : {}),
      status: isStateValueKind(item.status) ? item.status : "unknown",
      affectedPaths: Object.freeze(readStringArray(item.affectedPaths)),
      ...(command ? { command } : {}),
      ...(rerunCommand ? { rerunCommand } : {}),
    })];
  }));
}

function normalizeQualityFindings(value: unknown): readonly AiuQualityFinding[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.flatMap((item): AiuQualityFinding[] => {
    if (!isRecord(item) || !readString(item.id)) return [];
    const id = readString(item.id) as string;
    const title = readString(item.title);
    const stageId = readString(item.stageId);
    const command = normalizeCommandRef(item.command);
    const rerunCommand = normalizeCommandRef(item.rerunCommand);
    const humanApprovalRequired = readBooleanUnknown(item.humanApprovalRequired);
    const supplyChainApprovalRequired = readBooleanUnknown(item.supplyChainApprovalRequired);
    return [Object.freeze({
      id,
      ...(title ? { title } : {}),
      ...(stageId ? { stageId } : {}),
      status: isStateValueKind(item.status) ? item.status : "unknown",
      ...(isQualitySeverity(item.severity) ? { severity: item.severity } : {}),
      affectedPaths: Object.freeze(readStringArray(item.affectedPaths)),
      ...(command ? { command } : {}),
      ...(rerunCommand ? { rerunCommand } : {}),
      ...(humanApprovalRequired !== undefined ? { humanApprovalRequired } : {}),
      ...(supplyChainApprovalRequired !== undefined ? { supplyChainApprovalRequired } : {}),
    })];
  }));
}

function normalizeQualitySelectedTarget(value: unknown): AiuQualitySelectedTarget | undefined {
  if (!isRecord(value) || !isQualityTargetKind(value.kind) || !readString(value.id)) return undefined;
  const id = readString(value.id) as string;
  const title = readString(value.title);
  const stageId = readString(value.stageId);
  const command = normalizeCommandRef(value.command);
  const rerunCommand = normalizeCommandRef(value.rerunCommand);
  const expectedEvidence = readString(value.expectedEvidence);
  return Object.freeze({
    kind: value.kind,
    id,
    ...(title ? { title } : {}),
    ...(stageId ? { stageId } : {}),
    status: isStateValueKind(value.status) ? value.status : "unknown",
    affectedPaths: Object.freeze(readStringArray(value.affectedPaths)),
    ...(command ? { command } : {}),
    ...(rerunCommand ? { rerunCommand } : {}),
    ...(expectedEvidence ? { expectedEvidence } : {}),
  });
}

function normalizeCommandRef(value: unknown): AiuTrustedStateCommandRef | undefined {
  if (!isRecord(value) || !readString(value.id) || !Array.isArray(value.argv) || value.argv.length === 0 || !value.argv.every((item) => typeof item === "string" && item.length > 0)) {
    return undefined;
  }
  const timeoutMs = readPositiveInteger(value.timeoutMs);
  const maxOutputBytes = readPositiveInteger(value.maxOutputBytes);
  return Object.freeze({
    id: readString(value.id) as string,
    argv: Object.freeze([...value.argv]) as readonly [string, ...string[]],
    ...(readString(value.cwd) ? { cwd: readString(value.cwd) } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
  });
}

function parseFailure(
  input: AiuTrustedStateParseInput,
  code: AiuTrustedAdapterErrorCode,
  message: string,
  path?: string,
  parsedSchemaVersion?: number,
): { readonly ok: false; readonly record: AiuTrustedCommandExecutionRecord; readonly error: AiuTrustedAdapterError } {
  return Object.freeze({
    ok: false as const,
    record: attachParsedSchema(input.record, parsedSchemaVersion),
    error: Object.freeze({
      code,
      message: redactText(message),
      ...(path ? { path } : {}),
    }),
  });
}

function attachParsedSchema(record: AiuTrustedCommandExecutionRecord | undefined, parsedSchemaVersion: number | undefined): AiuTrustedCommandExecutionRecord {
  const base = record ?? {
    sourceId: "parse",
    command: Object.freeze({ id: "parse", argv: Object.freeze(["parse"]) as readonly [string, ...string[]] }),
    timeoutMs: 0,
    maxOutputBytes: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
    stderrSummary: "",
    elapsedMs: 0,
    timedOut: false,
    outputLimitExceeded: false,
  };
  return Object.freeze({
    ...base,
    ...(parsedSchemaVersion !== undefined ? { parsedSchemaVersion } : {}),
  });
}

function readSchemaVersion(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.schemaVersion === "number" ? value.schemaVersion : undefined;
}

function normalizeCapabilities(value: unknown): Readonly<Record<string, AiuStateCapabilitySupport>> {
  if (!isRecord(value)) return Object.freeze({});
  const capabilities: Record<string, AiuStateCapabilitySupport> = {};
  for (const [key, support] of Object.entries(value)) {
    if (isCapabilitySupport(support)) {
      capabilities[key] = support;
    }
  }
  return Object.freeze(capabilities);
}

function normalizeFreshness(value: unknown, observedAt: string | undefined): AiuStateFreshness {
  if (!isRecord(value) || !isFreshnessKind(value.kind)) {
    return Object.freeze({
      kind: "fresh",
      observedAt: observedAt ?? new Date(0).toISOString(),
    });
  }
  return Object.freeze({
    kind: value.kind,
    observedAt: readString(value.observedAt) ?? observedAt ?? new Date(0).toISOString(),
    ...(typeof value.ageMs === "number" ? { ageMs: value.ageMs } : {}),
    ...(typeof value.staleAfterMs === "number" ? { staleAfterMs: value.staleAfterMs } : {}),
  });
}

function withoutEnvelopeFields(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!["schemaVersion", "sourceId", "command", "observedAt", "trustLevel", "capabilities", "freshness", "unknownFields", "diagnostics"].includes(key)) {
      output[key] = item;
    }
  }
  return Object.freeze(output);
}

function summarizeStderr(chunks: readonly Buffer[]): string {
  return redactText(Buffer.concat(chunks).toString("utf8").slice(0, 2_000));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? Object.freeze(value.filter((item): item is string => typeof item === "string")) : Object.freeze([]);
}

function readBooleanUnknown(value: unknown): boolean | "unknown" | undefined {
  return typeof value === "boolean" || value === "unknown" ? value : undefined;
}

function readBooleanUnknownUnsupported(value: unknown, fallback: boolean): boolean | "unknown" | "unsupported" {
  return typeof value === "boolean" || value === "unknown" || value === "unsupported" ? value : fallback;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readTrustLevel(value: unknown): AiuTrustLevel {
  return isTrustLevel(value) ? value : "trusted";
}

function isTrustedStateKind(value: unknown): boolean {
  return AIU_TRUSTED_STATE_KINDS.some((item) => item === value);
}

function isStateValueKind(value: unknown): value is AiuStateValueKind {
  return AIU_STATE_VALUE_KINDS.some((item) => item === value);
}

function isFreshnessKind(value: unknown): value is AiuStateFreshnessKind {
  return AIU_STATE_FRESHNESS_KINDS.some((item) => item === value);
}

function isTrustLevel(value: unknown): value is AiuTrustLevel {
  return AIU_TRUST_LEVELS.some((item) => item === value);
}

function isCapabilitySupport(value: unknown): value is AiuStateCapabilitySupport {
  return AIU_STATE_CAPABILITY_SUPPORT.some((item) => item === value);
}

function isQualityTargetKind(value: unknown): value is AiuQualityTargetKind {
  return AIU_QUALITY_TARGET_KINDS.some((item) => item === value);
}

function isQualitySeverity(value: unknown): value is AiuQualityFinding["severity"] {
  return value === "low" || value === "medium" || value === "high" || value === "critical" || value === "unknown";
}

function isWorkItemLifecycle(value: unknown): value is AiuWorkItemState["lifecycle"] {
  return ["active", "ready", "blocked", "closed", "unknown", "unsupported"].includes(String(value));
}

function isWorkItemPriority(value: unknown): value is NonNullable<AiuWorkItemState["priority"]> {
  return ["low", "normal", "high", "critical"].includes(String(value));
}

function isReviewStatus(value: unknown): value is AiuReviewState["reviewStatus"] {
  return ["none", "active", "approved", "changes-requested", "blocked", "unknown", "unsupported"].includes(String(value));
}

function isPlanningQuestionCategory(value: unknown): value is NonNullable<AiuPlanningQuestion["category"]> {
  return value === "product-decision" || value === "provider-schema" || value === "work-item-mapping" || value === "artifact-inconsistency" || value === "supply-chain" || value === "unknown";
}

function isPlanningStopCategory(value: unknown): value is AiuPlanningStopCondition["category"] {
  return value === "human-question" || value === "ambiguous-mapping" || value === "artifact-inconsistency" || value === "supply-chain-approval" || value === "unknown";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function resolveTrustedCommandExecutable(executable: string, cwd?: string): string | undefined {
  if (isAbsolute(executable)) {
    return isWindowsAwareExecutable(executable) ? executable : undefined;
  }
  const names = windowsCommandNames(executable);
  if (executable.includes("/") || executable.includes("\\")) {
    const base = cwd ?? process.cwd();
    return names.map((name) => join(base, name)).find((candidate) => isWindowsAwareExecutable(candidate));
  }
  return (process.env.PATH ?? "").split(delimiter).filter(Boolean).flatMap((entry) => names.map((name) => join(entry, name))).find((candidate) => isWindowsAwareExecutable(candidate));
}

function windowsCommandNames(executable: string): readonly string[] {
  if (process.platform !== "win32" || extname(executable) !== "") return [executable];
  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0);
  return [executable, ...extensions.map((extension) => `${executable}${extension}`)];
}

function isWindowsAwareExecutable(targetPath: string): boolean {
  try {
    const stat = statSync(targetPath);
    if (!stat.isFile()) return false;
    if (process.platform !== "win32") return true;
    const executableExtensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .map((extension) => extension.trim().toUpperCase())
      .filter((extension) => extension.length > 0);
    return executableExtensions.includes(extname(targetPath).toUpperCase());
  } catch {
    return false;
  }
}
