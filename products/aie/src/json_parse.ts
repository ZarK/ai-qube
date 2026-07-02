export class JsonOutputError extends Error {
  constructor(operation: string, details: string) {
    super(`Failed to parse ${operation}: ${details}`);
    this.name = 'JsonOutputError';
  }
}

export function parseJsonOutput<T>(stdout: string, operation: string, shapeCheck?: (value: unknown) => value is T): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new JsonOutputError(operation, `JSON parse failed: ${detail}`);
  }
  if (shapeCheck && !shapeCheck(parsed)) {
    throw new JsonOutputError(operation, 'JSON did not match expected shape');
  }
  return parsed as T;
}
