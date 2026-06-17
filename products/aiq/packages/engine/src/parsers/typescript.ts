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

    const match =
      /^(.*?)(?:\((\d+),(\d+)\)|:(\d+):(\d+))(?:\s-\s|:\s*|\s+)(error|warning|info)\s(TS\d+):\s(.+)$/u.exec(
        trimmed,
      );
    if (match !== null) {
      if (current !== undefined) {
        diagnostics.push(current);
      }

      const filePath = match[1];
      const startLineValue = match[2] ?? match[4];
      const startColumnValue = match[3] ?? match[5];
      const code = match[7];
      const message = match[8];
      if (
        filePath === undefined ||
        startLineValue === undefined ||
        startColumnValue === undefined ||
        code === undefined ||
        message === undefined
      ) {
        continue;
      }

      const file = path.resolve(cwd, filePath);
      const startLine = Number(startLineValue);
      const startColumn = Number(startColumnValue);
      current = {
        code,
        file,
        message,
        range: {
          startColumn,
          startLine,
        },
        severity: normalizeSeverity(match[6]),
        source: "tsc",
      };
      continue;
    }

    if (current !== undefined && !/^Found \d+ error/u.test(trimmed)) {
      current.message = `${current.message}\n${trimmed}`;
    }
  }

  if (current !== undefined) {
    diagnostics.push(current);
  }

  return diagnostics;
}
