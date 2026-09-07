import {
  CONTINUATION_ADAPTER_VERSION,
  CONTINUATION_DECLARATION_VERSION,
  defineContinuationAdapter,
  defineContinuationDeclaration,
  probeContinuationSurface,
  type ContinuationAssetMerge,
  type ContinuationAssetValidation,
} from "@tjalve/qube-core";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const CURSOR_STOP_LOOP_LIMIT = 3;
export const CURSOR_CONTINUATION_MINIMUM_VERSION = "2026.08.11";

const hooksAsset = Object.freeze({
  id: "project-stop-hook",
  relativePath: ".cursor/hooks.json",
  description: "Cursor AI Umpire project Stop hook.",
  ownership: "shared" as const,
  role: "entrypoint" as const,
});

export const cursorContinuationDeclaration = defineContinuationDeclaration({
  version: CONTINUATION_DECLARATION_VERSION,
  hostId: "cursor",
  nativeSurfaces: Object.freeze([Object.freeze({
    id: "stop-hook",
    minimumVersion: CURSOR_CONTINUATION_MINIMUM_VERSION,
    maximumVersionExclusive: null,
  })]),
  triggerEvents: Object.freeze(["stop"]),
  delivery: Object.freeze({ method: "stdout-json", sessionScope: "current-session" }),
  umpireModes: Object.freeze(["continue", "repair", "stop"]),
  trust: Object.freeze({ repositoryRequired: true, description: "Cursor must trust the project Stop hook." }),
  managedAssets: Object.freeze([hooksAsset]),
  activationEvidence: Object.freeze({ event: "stop-hook", delivery: "stdout", requiresSessionId: true }),
  currentIssueRecovery: true,
});

export function buildCursorVerifyInvocation(input: {
  readonly root: string;
  readonly prompt: string;
  readonly model?: string;
  readonly platform?: string;
}): { readonly args: readonly string[] } {
  const safetyArgs = (input.platform ?? process.platform) === "win32"
    ? []
    : ["--sandbox", "enabled"];
  return Object.freeze({
    args: Object.freeze([
      "--disable-auto-update",
      ...safetyArgs,
      "--model", requireVerifyModel(input.model),
      "--workspace", input.root,
      input.prompt,
    ]),
  });
}

export interface CursorVerificationObservation {
  readonly conversationId: string;
  readonly generationId: string;
  readonly cursorVersion: string;
  readonly status: "completed";
  readonly loopCount: number;
  readonly observedAt: string;
  readonly assistantMessages: readonly string[];
}

export function resolveCursorVerificationTranscriptRoot(workspaceRoot: string, cursorDataRoot = process.env.CURSOR_DATA_DIR?.trim() || path.join(homedir(), ".cursor")): string {
  const projectKey = workspaceRoot.replace(/[^a-zA-Z0-9]/gu, "-").replace(/-+/gu, "-").replace(/^-+|-+$/gu, "");
  return path.join(cursorDataRoot, "projects", projectKey, "agent-transcripts");
}

export function cursorVerificationObserverScript(input: { readonly workspaceRoot: string; readonly cursorDataRoot?: string }): string {
  const workspace = JSON.stringify(path.resolve(input.workspaceRoot));
  const dataRoot = JSON.stringify(path.resolve(input.cursorDataRoot ?? (process.env.CURSOR_DATA_DIR?.trim() || path.join(homedir(), ".cursor"))));
  return `'use strict';\nconst fs=require('node:fs'),p=require('node:path');\nconst MAX=1024*1024,deadline=Date.now()+2000,input=fs.readFileSync(0,'utf8').trim(),workspace=${workspace},dataRoot=${dataRoot};\nlet value;try{value=JSON.parse(input)}catch{process.stdout.write('{}');process.exit(0)}\nconst rawId=typeof value.conversation_id==='string'?value.conversation_id:'',id=encodeURIComponent(rawId).replace(/%/g,'_').slice(0,200);\nconst roots=Array.isArray(value.workspace_roots)?value.workspace_roots.filter(v=>typeof v==='string').slice(0,8):[],nativeRoot=roots.find(v=>p.resolve(v).toLowerCase()===workspace.toLowerCase())||'';\nconst project=nativeRoot.replace(/[^a-zA-Z0-9]/g,'-').replace(/-+/g,'-').replace(/^-+|-+$/g,''),transcriptRoot=p.join(dataRoot,'projects',project,'agent-transcripts');\nconst supplied=typeof value.transcript_path==='string'?p.resolve(value.transcript_path):'',expected=id?p.resolve(transcriptRoot,id,id+'.jsonl'):'';\nconst valid=nativeRoot&&supplied&&expected&&supplied.toLowerCase()===expected.toLowerCase(),required=Number.isInteger(value.loop_count)&&value.loop_count>=0?value.loop_count+1:Infinity;\nlet evidence='';while(valid&&Date.now()<deadline&&!evidence){try{const realRoot=fs.realpathSync(transcriptRoot),real=fs.realpathSync(expected),relative=p.relative(realRoot,real);if(!fs.lstatSync(expected).isSymbolicLink()&&!relative.startsWith('..')&&!p.isAbsolute(relative)){const size=fs.statSync(real).size;if(size<=MAX){const candidate=fs.readFileSync(real,'utf8'),lines=candidate.split(/\\r?\\n/).filter(Boolean).map(line=>{try{return JSON.parse(line)}catch{return null}}),assistants=lines.filter(line=>line&&line.role==='assistant').length;if(lines.every(Boolean)&&assistants>=required)evidence=candidate}}}catch{}if(!evidence)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25)}\nconst text=v=>typeof v==='string'?v.slice(0,4096):'';\nconst observation={conversation_id:text(rawId),generation_id:text(value.generation_id),cursor_version:text(value.cursor_version),hook_event_name:text(value.hook_event_name),status:text(value.status),loop_count:Number.isInteger(value.loop_count)?value.loop_count:null,workspace_roots:roots.map(v=>v.slice(0,4096)),transcript_path:valid?expected:'',transcript:evidence,observed_at:new Date().toISOString()};\ntry{fs.appendFileSync(p.join(__dirname,'verify-cursor-observations.jsonl'),JSON.stringify(observation)+'\\n',{encoding:'utf8',mode:0o600})}catch{}\nprocess.stdout.write('{}');\n`;
}

export function inspectCursorVerificationObservations(input: {
  readonly observationPath: string;
  readonly workspaceRoot: string;
  readonly startedAt: number;
  readonly expectedVersion: string;
  readonly transcriptRoot?: string;
}): readonly CursorVerificationObservation[] {
  const content = readBoundedRegularFile(input.observationPath, input.workspaceRoot);
  if (content === undefined) return Object.freeze([]);
  const observations: CursorVerificationObservation[] = [];
  for (const line of content.split(/\r?\n/u).filter(Boolean)) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (!isRecord(value) || value.hook_event_name !== "stop" || value.status !== "completed"
      || typeof value.conversation_id !== "string" || !value.conversation_id.trim()
      || typeof value.generation_id !== "string" || !value.generation_id.trim()
      || value.cursor_version !== input.expectedVersion || !Number.isInteger(value.loop_count)
      || Number(value.loop_count) < 0 || typeof value.observed_at !== "string"
      || !Number.isFinite(Date.parse(value.observed_at)) || Date.parse(value.observed_at) < input.startedAt || !Array.isArray(value.workspace_roots)
      || !value.workspace_roots.some((root) => typeof root === "string" && samePath(root, input.workspaceRoot))
      || typeof value.transcript_path !== "string" || typeof value.transcript !== "string") continue;
    const nativeWorkspace = value.workspace_roots.find((root): root is string => typeof root === "string" && samePath(root, input.workspaceRoot))!;
    const transcriptRoot = input.transcriptRoot ?? resolveCursorVerificationTranscriptRoot(nativeWorkspace);
    const encodedConversation = encodeURIComponent(value.conversation_id).replaceAll("%", "_").slice(0, 200);
    const expectedTranscript = path.join(transcriptRoot, encodedConversation, `${encodedConversation}.jsonl`);
    if (!samePath(value.transcript_path, expectedTranscript)) continue;
    const transcript = readBoundedRegularFile(value.transcript_path, transcriptRoot, expectedTranscript);
    if (transcript === undefined || !transcript.startsWith(value.transcript)) continue;
    const assistantMessages = parseAssistantMessages(value.transcript);
    if (assistantMessages === undefined) continue;
    observations.push(Object.freeze({
      conversationId: value.conversation_id,
      generationId: value.generation_id,
      cursorVersion: value.cursor_version,
      status: "completed",
      loopCount: Number(value.loop_count),
      observedAt: value.observed_at,
      assistantMessages,
    }));
  }
  return Object.freeze(observations);
}

export const cursorContinuationAdapter = defineContinuationAdapter({
  version: CONTINUATION_ADAPTER_VERSION,
  declaration: cursorContinuationDeclaration,
  renderManagedAssets(context) {
    const command = `${context.commandPrefix ?? "aiu"} hook-stop --tool cursor`;
    const entry = managedStopEntry(command);
    return Object.freeze([Object.freeze({
      ...hooksAsset,
      command,
      content: stableJson({ version: 1, hooks: { stop: [entry] } }),
    })]);
  },
  validateManagedAsset(assetId, existing, desired) {
    return validateCursorAsset(assetId, existing, desired);
  },
  mergeManagedAsset(assetId, existing, desired) {
    if (assetId !== hooksAsset.id) return failedUnknownAsset(assetId);
    const current = validateCursorAsset(assetId, existing, desired);
    if (current.state === "malformed" || current.state === "duplicate" || current.state === "conflicting") {
      return Object.freeze({ ok: false, reason: current.reason, validation: current });
    }
    if (current.state === "current") {
      return Object.freeze({ ok: true, content: existing, changed: false, validation: current });
    }
    const parsed = parseJsonObject(existing);
    if (!parsed.ok) return failedMalformed("Existing Cursor hooks file is not a JSON object. QUBE will not replace the shared file.");
    if (parsed.value.version !== undefined && parsed.value.version !== 1) {
      return failedMalformed("Existing Cursor hooks file does not use version 1. QUBE will not replace the shared file.");
    }
    if (parsed.value.hooks !== undefined && !isRecord(parsed.value.hooks)) {
      return failedMalformed("Existing Cursor hooks value is not a JSON object. QUBE will not replace the shared file.");
    }
    const hooks = isRecord(parsed.value.hooks) ? parsed.value.hooks : {};
    if (hooks.stop !== undefined && !Array.isArray(hooks.stop)) {
      return failedMalformed("Existing Cursor stop hooks value is not an array. QUBE will not replace the shared file.");
    }
    const desiredValue = parseJsonObject(desired.content);
    const desiredHooks = desiredValue.ok && isRecord(desiredValue.value.hooks) && Array.isArray(desiredValue.value.hooks.stop)
      ? desiredValue.value.hooks.stop
      : [];
    const desiredEntry = desiredHooks.find(isOwnedStopHook);
    if (!isRecord(desiredEntry)) return failedMalformed("Desired Cursor Stop hook is missing.");
    const stopHooks = [...(hooks.stop ?? [])];
    const content = stableJson({
      ...parsed.value,
      version: 1,
      hooks: { ...hooks, stop: [...stopHooks, desiredEntry] },
    });
    return Object.freeze({ ok: true, content, changed: stableJson(parsed.value) !== content, validation: current });
  },
  decodeEvent(input) {
    if (!isRecord(input)) return malformed("Cursor Stop input must be a JSON object.");
    const error = validateCursorPayload(input);
    if (error) return malformed(error);
    const status = input.status as "completed" | "aborted" | "error";
    return Object.freeze({
      ok: true,
      event: Object.freeze({
        event: "stop",
        sessionId: String(input.conversation_id),
        generationId: String(input.generation_id),
        harnessVersion: String(input.cursor_version),
        workspaceRoots: Object.freeze([...(input.workspace_roots as string[])]),
        hostStatus: status,
        nativeLoopCount: Number(input.loop_count),
        sessionEnd: status !== "completed",
      }),
    });
  },
  encodeResponse(input) {
    if (input.decision === "allow") return Object.freeze({ ok: true, response: Object.freeze({}) });
    if (input.decision !== "block" || !input.prompt?.trim()) {
      return Object.freeze({ ok: false, error: "Cursor Stop continuation requires a non-empty follow-up message." });
    }
    return Object.freeze({ ok: true, response: Object.freeze({ followup_message: input.prompt }) });
  },
  probe(input) {
    const compatibility = probeContinuationSurface(cursorContinuationDeclaration, input);
    if (compatibility.status === "blocked" || !input.repoRoot) return compatibility;
    return Object.freeze({
      status: "blocked" as const,
      code: "cursor-hook-trust-unverified",
      reason: "Cursor project-hook trust cannot be inspected without changing harness-owned state. Compatible consumed lifecycle evidence is required.",
      path: input.repoRoot,
      nextAction: "Review and trust the Cursor project hook outside QUBE, then run aiu verify --tool cursor --model <model> --json.",
      severity: "warning" as const,
    });
  },
});

function validateCursorAsset(
  assetId: string,
  existing: string | undefined,
  desired: { readonly content: string },
): ContinuationAssetValidation {
  if (assetId !== hooksAsset.id) return unknownAsset(assetId);
  if (existing === undefined) return validation("missing", "Managed Cursor Stop hook is missing.");
  const parsed = parseJsonObject(existing);
  if (!parsed.ok) return validation("malformed", "Existing Cursor hooks file is not a JSON object. QUBE will not replace it.");
  if (parsed.value.version !== undefined && parsed.value.version !== 1) return validation("malformed", "Existing Cursor hooks file does not use version 1.");
  if (parsed.value.hooks === undefined) return validation("missing", "Managed Cursor Stop hook is missing.");
  if (!isRecord(parsed.value.hooks)) return validation("malformed", "Existing Cursor hooks value is not a JSON object.");
  if (parsed.value.hooks.stop === undefined) return validation("missing", "Managed Cursor Stop hook is missing.");
  if (!Array.isArray(parsed.value.hooks.stop) || parsed.value.hooks.stop.some((entry) => !isRecord(entry))) {
    return validation("malformed", "Existing Cursor stop hooks value must be an array of JSON objects.");
  }
  const owned = parsed.value.hooks.stop.filter(isOwnedStopHook);
  if (owned.length === 0) return validation("missing", "Managed Cursor Stop hook is missing.");
  if (owned.length > 1) return validation("duplicate", "Cursor hooks contain duplicate managed Stop entries.");
  const desiredValue = parseJsonObject(desired.content);
  const desiredOwned = desiredValue.ok && isRecord(desiredValue.value.hooks) && Array.isArray(desiredValue.value.hooks.stop)
    ? desiredValue.value.hooks.stop.filter(isOwnedStopHook)
    : [];
  if (desiredOwned.length !== 1) return validation("malformed", "Desired Cursor Stop hook is malformed.");
  return jsonEquals(owned[0], desiredOwned[0])
    ? validation("current", "The managed Cursor Stop hook is canonical.")
    : validation("conflicting", "The managed Cursor Stop hook conflicts with package content.");
}

function validateCursorPayload(input: Record<string, unknown>): string | undefined {
  for (const key of ["conversation_id", "generation_id", "hook_event_name", "cursor_version"] as const) {
    if (typeof input[key] !== "string" || input[key].trim().length === 0) return `${key} must be a non-empty string.`;
  }
  if (input.hook_event_name !== "stop") return "Unsupported hook event; expected stop.";
  if (input.status !== "completed" && input.status !== "aborted" && input.status !== "error") {
    return "status must be completed, aborted, or error.";
  }
  if (!Number.isInteger(input.loop_count) || Number(input.loop_count) < 0) return "loop_count must be a non-negative integer.";
  if (!Array.isArray(input.workspace_roots) || input.workspace_roots.length === 0 || input.workspace_roots.some((root) => typeof root !== "string" || root.trim().length === 0)) {
    return "workspace_roots must contain at least one non-empty path.";
  }
  return undefined;
}

function requireVerifyModel(model: string | undefined): string {
  if (!model?.trim()) throw new Error("Cursor verification requires an explicit model.");
  return model;
}

function readBoundedRegularFile(candidate: string, root: string, expected?: string): string | undefined {
  try {
    const resolvedRoot = realpathSync(root);
    const resolved = path.resolve(candidate);
    if (expected && !samePath(resolved, expected)) return undefined;
    const relative = path.relative(resolvedRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative) || lstatSync(resolved).isSymbolicLink()) return undefined;
    const real = realpathSync(resolved);
    const realRelative = path.relative(resolvedRoot, real);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) return undefined;
    const stat = statSync(real);
    if (!stat.isFile() || stat.size > 1024 * 1024) return undefined;
    return readFileSync(real, "utf8");
  } catch {
    return undefined;
  }
}

function parseAssistantMessages(transcript: string): readonly string[] | undefined {
  const lines = transcript.split(/\r?\n/u).filter(Boolean);
  if (lines.length < 2 || lines.length > 64) return undefined;
  const values: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const value = JSON.parse(line) as unknown;
      if (!isRecord(value)) return undefined;
      values.push(value);
    } catch {
      return undefined;
    }
  }
  if (!values.some((value) => value.role === "user")
    || !values.some((value) => value.role === "assistant")) return undefined;
  const messages: string[] = [];
  for (const value of values) {
    if (value.role !== "assistant" || !isRecord(value.message) || !Array.isArray(value.message.content)) continue;
    const text = value.message.content
      .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text" && typeof part.text === "string")
      .map((part) => String(part.text))
      .join("");
    if (text) messages.push(text);
  }
  return messages.length > 0 ? Object.freeze(messages) : undefined;
}

function samePath(left: string, right: string): boolean {
  try { return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase(); } catch { return false; }
}

function managedStopEntry(command: string): Readonly<Record<string, unknown>> {
  return Object.freeze({ command, loop_limit: CURSOR_STOP_LOOP_LIMIT });
}

function isOwnedStopHook(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || typeof value.command !== "string") return false;
  const command = value.command.replaceAll("\\", "/");
  return /(?:\baiu(?:\.(?:cmd|exe))?|@tjalve\/aiu\/bin\/run)["']?\s+hook-stop\b/iu.test(command);
}

function malformed(error: string) { return Object.freeze({ ok: false as const, code: "malformed-event" as const, error }); }
function validation(state: ContinuationAssetValidation["state"], reason: string): ContinuationAssetValidation { return Object.freeze({ state, reason }); }
function unknownAsset(assetId: string): ContinuationAssetValidation { return validation("malformed", `Unknown Cursor continuation asset: ${assetId}.`); }
function failedUnknownAsset(assetId: string): ContinuationAssetMerge { const result = unknownAsset(assetId); return Object.freeze({ ok: false, reason: result.reason, validation: result }); }
function failedMalformed(reason: string): ContinuationAssetMerge { const result = validation("malformed", reason); return Object.freeze({ ok: false, reason, validation: result }); }
function jsonEquals(left: unknown, right: unknown): boolean { return stableJson(left) === stableJson(right); }
function parseJsonObject(content: string): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false } { try { const value = JSON.parse(content) as unknown; return isRecord(value) ? { ok: true, value } : { ok: false }; } catch { return { ok: false }; } }
function stableJson(value: unknown): string { return `${JSON.stringify(sortJson(value), null, 2)}\n`; }
function sortJson(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortJson); if (!isRecord(value)) return value; return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sortJson(entry)])); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
