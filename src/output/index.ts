import { type CliErrorShape } from "../errors/index.js";
import { isSensitiveKey, redactStructuredValue, redactText, redactionPlaceholder } from "../redaction/index.js";

export type JsonFields = Readonly<Record<string, unknown>>;

export interface JsonSuccessEnvelope {
  readonly ok: true;
  readonly command: string;
  readonly [key: string]: unknown;
}

export interface JsonErrorEnvelope {
  readonly ok: false;
  readonly command: string;
  readonly error: {
    readonly kind: string;
    readonly operation: string;
    readonly likelyCause: string;
    readonly suggestedNextAction: string;
    readonly category: string;
    readonly exitCode: number;
  };
}

export interface CommandResultShape {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

export function createJsonSuccessEnvelope(command: string, fields: JsonFields = {}): JsonSuccessEnvelope {
  assertNoReservedFields(fields);
  return Object.freeze({
    ok: true,
    command,
    ...stableFields(fields)
  });
}

export function createJsonErrorEnvelope(error: CliErrorShape): JsonErrorEnvelope {
  return Object.freeze({
    ok: false,
    command: error.command ?? "",
    error: Object.freeze({
      kind: error.kind,
      operation: redactText(error.operation),
      likelyCause: redactText(error.likelyCause),
      suggestedNextAction: redactText(error.suggestedNextAction),
      category: error.category,
      exitCode: error.exitCode
    })
  });
}

export function renderJsonLine(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("JSON output value must be serializable as valid JSON.");
  }
  return `${serialized}\n`;
}

export function renderJsonSuccess(command: string, fields: JsonFields = {}): string {
  return renderJsonLine(createJsonSuccessEnvelope(command, fields));
}

export function renderJsonError(error: CliErrorShape): string {
  return renderJsonLine(createJsonErrorEnvelope(error));
}

export function createJsonSuccessResult(command: string, fields: JsonFields = {}, stderr = ""): CommandResultShape {
  const result = {
    exitCode: 0,
    stdout: renderJsonSuccess(command, fields)
  };
  return stderr.length > 0 ? { ...result, stderr } : result;
}

export function createHumanResult(stdout: string, stderr = "", exitCode = 0): CommandResultShape {
  const result = { exitCode, stdout };
  return stderr.length > 0 ? { ...result, stderr } : result;
}

function assertNoReservedFields(fields: JsonFields): void {
  for (const reserved of ["ok", "command"] as const) {
    if (Object.hasOwn(fields, reserved)) {
      throw new TypeError(`JSON result fields must not define reserved field "${reserved}".`);
    }
  }
}

function stableFields(fields: JsonFields): JsonFields {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(fields).sort(compareText)) {
    const value = fields[key];
    if (value !== undefined) {
      result[key] = stableValue(value, key);
    }
  }
  return result;
}

function stableValue(value: unknown, key?: string): unknown {
  if (key && isSensitiveKey(key) && value !== undefined && value !== null) {
    return redactionPlaceholder;
  }
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => stableValue(item));
  }
  if (isRecord(value)) {
    return stableFields(redactStructuredValue(value));
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
