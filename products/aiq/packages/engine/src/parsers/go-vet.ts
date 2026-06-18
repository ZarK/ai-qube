import type { Diagnostic } from "../contracts.js";
import {
  deduplicateDiagnostics,
  readString,
} from "./utils.js";
import { parseGoPosition } from "./go.js";

export function parseGoVetDiagnostics(stderr: string, stdout: string, cwd: string): Diagnostic[] {
  const candidates = [stderr, stdout, `${stderr}\n${stdout}`]
    .map((value) => value.trim())
    .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);

  for (const candidate of candidates) {
    const diagnostics = deduplicateDiagnostics(
      parseGoVetJsonValues(candidate).flatMap((value) => collectGoVetDiagnostics(value, cwd)),
    );
    if (diagnostics.length > 0 || candidate === "{}") {
      return diagnostics;
    }
  }

  return [];
}

function parseGoVetJsonValues(candidate: string): unknown[] {
  try {
    return [JSON.parse(candidate)];
  } catch {
    const documents = splitConcatenatedJsonDocuments(candidate).flatMap((document) => {
      try {
        return [JSON.parse(document)];
      } catch {
        return [];
      }
    });
    if (documents.length > 0) {
      return documents;
    }

    return candidate
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  }
}

function splitConcatenatedJsonDocuments(candidate: string): string[] {
  const documents: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < candidate.length; index += 1) {
    const character = candidate[index];
    if (character === undefined) {
      continue;
    }

    if (start === -1) {
      if (/\s/u.test(character)) {
        continue;
      }
      start = index;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (character === "\\") {
        escaped = true;
        continue;
      }

      if (character === '"') {
        inString = false;
      }

      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === "{" || character === "[") {
      depth += 1;
      continue;
    }

    if (character === "}" || character === "]") {
      depth -= 1;

      if (depth === 0 && start !== -1) {
        documents.push(candidate.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return documents;
}

export function collectGoVetDiagnostics(
  value: unknown,
  cwd: string,
  code: string | undefined = undefined,
): Diagnostic[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectGoVetDiagnostics(entry, cwd, code));
  }

  if (typeof value !== "object" || value === null) {
    return [];
  }

  const record = value as Record<string, unknown>;
  const diagnostics: Diagnostic[] = [];
  const position = parseGoPosition(
    readString(record, "posn") ?? readString(record, "position"),
    cwd,
  );
  const message = readString(record, "message");
  if (position !== undefined && message !== undefined) {
    diagnostics.push({
      ...(code === undefined ? {} : { code }),
      file: position.file,
      message,
      ...(position.range === undefined ? {} : { range: position.range }),
      severity: "error",
      source: "go-vet",
    });
  }

  for (const [key, nestedValue] of Object.entries(record)) {
    if (
      key === "message" ||
      key === "posn" ||
      key === "position" ||
      key === "suggestedFixes" ||
      key === "suggested_fixes"
    ) {
      continue;
    }

    diagnostics.push(
      ...collectGoVetDiagnostics(nestedValue, cwd, /^[A-Za-z0-9_-]+$/u.test(key) ? key : code),
    );
  }

  return diagnostics;
}
