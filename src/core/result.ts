import type { JsonObject } from './json_value';

export type CoreErrorKind = 'invalid-input' | 'conflict' | 'unavailable' | 'unsupported' | 'execution-failed';

export interface CoreError {
  kind: CoreErrorKind;
  operation: string;
  message: string;
  nextAction: string;
  details: JsonObject;
}

export type CoreResult<T> = { ok: true; value: T } | { ok: false; error: CoreError };

export function ok<T>(value: T): CoreResult<T> {
  return { ok: true, value };
}

export function err(input: {
  kind: CoreErrorKind;
  operation: string;
  message: string;
  nextAction: string;
  details?: JsonObject;
}): CoreResult<never> {
  return { ok: false, error: { ...input, details: input.details ?? {} } };
}
