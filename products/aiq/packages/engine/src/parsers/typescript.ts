import path from "node:path";

import type { Diagnostic } from "../contracts.js";
import { normalizeSeverity } from "./utils.js";

export function parseTscDiagnostics(output: string, cwd: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines = output.split(/\r?\n/u);
  let current: Diagnostic | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const parsed = parseTscDiagnosticLine(trimmed, cwd);
    if (parsed !== undefined) {
      if (current !== undefined) {
        diagnostics.push(current);
      }

      current = parsed;
      continue;
    }

    appendTscDiagnosticContinuation(current, trimmed);
  }

  if (current !== undefined) {
    diagnostics.push(current);
  }

  return diagnostics;
}

function parseTscDiagnosticLine(line: string, cwd: string): Diagnostic | undefined {
  const match =
    /^(.*?)(?:\((\d+),(\d+)\)|:(\d+):(\d+))(?:\s-\s|:\s*|\s+)(error|warning|info)\s(TS\d+):\s(.+)$/u.exec(
      line,
    );
  if (match === null) {
    return undefined;
  }

  const parts = readTscDiagnosticMatchParts(match);
  if (parts === undefined) {
    return undefined;
  }

  return {
    code: parts.code,
    file: path.resolve(cwd, parts.filePath),
    message: parts.message,
    range: {
      startColumn: Number(parts.startColumnValue),
      startLine: Number(parts.startLineValue),
    },
    severity: normalizeSeverity(match[6]),
    source: "tsc",
  };
}

function readTscDiagnosticMatchParts(match: RegExpExecArray):
  | {
      code: string;
      filePath: string;
      message: string;
      startColumnValue: string;
      startLineValue: string;
    }
  | undefined {
  const filePath = match[1];
  const startLineValue = match[2] ?? match[4];
  const startColumnValue = match[3] ?? match[5];
  const code = match[7];
  const message = match[8];
  return filePath === undefined ||
    startLineValue === undefined ||
    startColumnValue === undefined ||
    code === undefined ||
    message === undefined
    ? undefined
    : { code, filePath, message, startColumnValue, startLineValue };
}

function appendTscDiagnosticContinuation(current: Diagnostic | undefined, line: string): void {
  if (current !== undefined && !/^Found \d+ error/u.test(line)) {
    current.message = `${current.message}\n${line}`;
  }
}
