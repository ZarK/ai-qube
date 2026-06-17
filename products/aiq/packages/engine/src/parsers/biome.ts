import type { Diagnostic, DiagnosticRange } from "../contracts.js";
import {
  normalizeSeverity,
  readNestedString,
  readNestedValue,
  readNumber,
  readOptionalCode,
  readRecordArray,
  readString,
  resolveDiagnosticFile,
} from "./utils.js";

export function parseBiomeDiagnostics(stdout: string, cwd: string): Diagnostic[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  const diagnostics = readRecordArray(parsed, "diagnostics");
  return diagnostics.flatMap((diagnostic) => {
    const file = resolveDiagnosticFile(
      readNestedString(diagnostic, ["location", "path", "file"]),
      cwd,
    );
    if (file === undefined) {
      return [];
    }

    const sourceCode = readNestedString(diagnostic, ["location", "sourceCode"]);
    const range = resolveBiomeRange(readNestedValue(diagnostic, ["location", "span"]), sourceCode);
    const aiqDiagnostic: Diagnostic = {
      file,
      message: readBiomeMessage(diagnostic),
      severity: normalizeSeverity(readString(diagnostic, "severity")),
      source: "biome",
    };
    const code = readOptionalCode(readString(diagnostic, "category"));
    if (code !== undefined) {
      aiqDiagnostic.code = code;
    }
    if (range !== undefined) {
      aiqDiagnostic.range = range;
    }

    return [aiqDiagnostic];
  });
}

export function readBiomeMessage(diagnostic: Record<string, unknown>): string {
  const description = readString(diagnostic, "description");
  if (description !== undefined && description.trim().length > 0) {
    return description;
  }

  const flattened = flattenText(readNestedValue(diagnostic, ["message"])).trim();
  return flattened.length > 0 ? flattened : "Biome reported a diagnostic.";
}

export function flattenText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => flattenText(item)).join("");
  }

  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const direct = [record.content, record.text, record.value].map(flattenText).join("");
    if (direct.length > 0) {
      return direct;
    }

    return Object.values(record)
      .map((item) => flattenText(item))
      .join("");
  }

  return "";
}

export function resolveBiomeRange(
  span: unknown,
  sourceCode: string | undefined,
): DiagnosticRange | undefined {
  if (sourceCode === undefined) {
    return undefined;
  }

  const offsets = readOffsetRange(span);
  if (offsets === undefined) {
    return undefined;
  }

  const start = offsetToPosition(sourceCode, offsets.start);
  const end = offsetToPosition(sourceCode, offsets.end);

  return {
    endColumn: end.column,
    endLine: end.line,
    startColumn: start.column,
    startLine: start.line,
  };
}

export function readOffsetRange(value: unknown): { end: number; start: number } | undefined {
  if (Array.isArray(value) && value.length >= 2) {
    const start = readNumber(value[0]);
    const end = readNumber(value[1]);
    if (start !== undefined && end !== undefined) {
      return { end, start };
    }
  }

  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const start = readNumber(record.start ?? record.startOffset ?? record.offset);
  const end = readNumber(record.end ?? record.endOffset);
  if (start === undefined || end === undefined) {
    return undefined;
  }

  return { end, start };
}

export function offsetToPosition(source: string, offset: number): { column: number; line: number } {
  const boundedOffset = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  let column = 1;

  for (let index = 0; index < boundedOffset; index += 1) {
    if (source[index] === "\n") {
      line += 1;
      column = 1;
      continue;
    }

    column += 1;
  }

  return { column, line };
}
