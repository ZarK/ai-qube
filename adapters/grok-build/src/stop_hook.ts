import { posix as pathPosix } from "node:path";

export interface GrokBuildStopPayload {
  readonly cwd: string;
  readonly hook_event_name: string;
  readonly session_id: string;
  readonly stop_hook_active: boolean;
  readonly last_assistant_message: string | null;
  readonly permission_mode: string | undefined;
  readonly reason: string | undefined;
}

export type GrokBuildStopParseResult =
  | { readonly ok: true; readonly payload: GrokBuildStopPayload }
  | { readonly ok: false; readonly error: string };

export interface GrokBuildStopHookFile {
  readonly relativePath: string;
  readonly description: string;
  readonly content: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function isOptionalNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function validateGrokHookPayloadShape(parsed: Record<string, unknown>): string | undefined {
  const requiredStrings = ["cwd", "hookEventName", "sessionId"] as const;
  for (const key of requiredStrings) {
    if (typeof parsed[key] !== "string" || parsed[key].length === 0) {
      return `${key} must be a non-empty string.`;
    }
  }
  if (parsed.hookEventName !== "stop") {
    return "Unsupported hook event; expected stop.";
  }
  if (typeof parsed.stopHookActive !== "boolean") {
    return "stopHookActive must be a boolean.";
  }
  if (parsed.permissionMode !== undefined && (typeof parsed.permissionMode !== "string" || parsed.permissionMode.length === 0)) {
    return "permissionMode must be a non-empty string.";
  }
  if (parsed.reason !== undefined && (typeof parsed.reason !== "string" || parsed.reason.length === 0)) {
    return "reason must be a non-empty string.";
  }
  if (!isOptionalNullableString(parsed.lastAssistantMessage)) {
    return "lastAssistantMessage must be a string or null.";
  }
  return undefined;
}

export function parseGrokStopPayload(parsed: Record<string, unknown>): GrokBuildStopParseResult {
  if (typeof parsed.hookEventName !== "string" && typeof parsed.hook_event_name === "string") {
    return { ok: false, error: "Claude snake_case Stop input is not a valid Grok parse." };
  }
  const validationError = validateGrokHookPayloadShape(parsed);
  if (validationError) {
    return { ok: false, error: validationError };
  }
  return {
    ok: true,
    payload: Object.freeze({
      cwd: readString(parsed.cwd),
      hook_event_name: readString(parsed.hookEventName),
      session_id: readString(parsed.sessionId),
      stop_hook_active: readBoolean(parsed.stopHookActive),
      last_assistant_message: readNullableString(parsed.lastAssistantMessage),
      permission_mode: typeof parsed.permissionMode === "string" ? parsed.permissionMode : undefined,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    }),
  };
}

export function isGrokSessionEndReason(reason: string | undefined): boolean {
  return typeof reason === "string" && reason.length > 0 && reason !== "end_turn";
}

export const grokBuildStopHookFile: GrokBuildStopHookFile = Object.freeze({
  relativePath: pathPosix.join(".grok", "hooks", "ai-umpire.json"),
  description: "Grok Build AI Umpire project Stop hook.",
  content: stableJson({
    hooks: {
      Stop: [
        {
          hooks: [
            {
              command: "aiu hook-stop --tool grok-build",
              type: "command",
            },
          ],
        },
      ],
    },
  }),
});
