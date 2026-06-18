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
  let state = createJsonDocumentScanState();

  for (let index = 0; index < candidate.length; index += 1) {
    const character = candidate[index];
    if (character === undefined) {
      continue;
    }

    state = readJsonDocumentScanStep(candidate, index, character, state, documents);
  }

  return documents;
}

type JsonDocumentScanState = {
  depth: number;
  escaped: boolean;
  inString: boolean;
  start: number;
};

function createJsonDocumentScanState(): JsonDocumentScanState {
  return { depth: 0, escaped: false, inString: false, start: -1 };
}

function readJsonDocumentScanStep(
  candidate: string,
  index: number,
  character: string,
  state: JsonDocumentScanState,
  documents: string[],
): JsonDocumentScanState {
  const startedState = readJsonDocumentStart(character, index, state);
  if (startedState.start === -1) {
    return startedState;
  }
  if (startedState.inString) {
    return readJsonStringScanStep(character, startedState);
  }

  return readJsonStructureScanStep(candidate, index, character, startedState, documents);
}

function readJsonDocumentStart(
  character: string,
  index: number,
  state: JsonDocumentScanState,
): JsonDocumentScanState {
  if (state.start !== -1 || !/\S/u.test(character)) {
    return state;
  }
  return { ...state, start: index };
}

function readJsonStringScanStep(
  character: string,
  state: JsonDocumentScanState,
): JsonDocumentScanState {
  if (state.escaped) {
    return { ...state, escaped: false };
  }
  if (character === "\\") {
    return { ...state, escaped: true };
  }
  return character === '"' ? { ...state, inString: false } : state;
}

function readJsonStructureScanStep(
  candidate: string,
  index: number,
  character: string,
  state: JsonDocumentScanState,
  documents: string[],
): JsonDocumentScanState {
  if (character === '"') {
    return { ...state, inString: true };
  }
  if (character === "{" || character === "[") {
    return { ...state, depth: state.depth + 1 };
  }
  if (character !== "}" && character !== "]") {
    return state;
  }

  const nextState = { ...state, depth: state.depth - 1 };
  if (nextState.depth !== 0 || nextState.start === -1) {
    return nextState;
  }

  documents.push(candidate.slice(nextState.start, index + 1));
  return { ...nextState, start: -1 };
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
  const diagnostics = readDirectGoVetDiagnostic(record, cwd, code);

  for (const [key, nestedValue] of Object.entries(record)) {
    if (isIgnoredGoVetNestedKey(key)) {
      continue;
    }

    diagnostics.push(
      ...collectGoVetDiagnostics(nestedValue, cwd, /^[A-Za-z0-9_-]+$/u.test(key) ? key : code),
    );
  }

  return diagnostics;
}

function readDirectGoVetDiagnostic(
  record: Record<string, unknown>,
  cwd: string,
  code: string | undefined,
): Diagnostic[] {
  const position = parseGoPosition(
    readString(record, "posn") ?? readString(record, "position"),
    cwd,
  );
  const message = readString(record, "message");
  if (position === undefined || message === undefined) {
    return [];
  }

  return [
    {
      ...(code === undefined ? {} : { code }),
      file: position.file,
      message,
      ...(position.range === undefined ? {} : { range: position.range }),
      severity: "error",
      source: "go-vet",
    },
  ];
}

function isIgnoredGoVetNestedKey(key: string): boolean {
  return [
    "message",
    "posn",
    "position",
    "suggestedFixes",
    "suggested_fixes",
  ].includes(key);
}
