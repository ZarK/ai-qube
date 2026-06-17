import type { Parser as SqlParserClass } from "node-sql-parser";
import type { Diagnostic } from "../contracts.js";
import { readNumber } from "./utils.js";

const sqlDialectCandidates = ["mysql", "postgresql", "sqlite", "transactsql"] as const;
export type SqlDialect = (typeof sqlDialectCandidates)[number];

export interface SqlParserError extends Error {
  location?: {
    start?: { column?: number; line?: number; offset?: number };
    end?: { column?: number; line?: number; offset?: number };
  };
}

export function resolveSqlDialect(
  parser: SqlParserClass,
  source: string,
  diagnosticSource = "node-sql-parser",
  file = process.cwd(),
): { dialect: SqlDialect } | { diagnostic: Diagnostic } {
  let bestError: SqlParserError | undefined;

  for (const dialect of sqlDialectCandidates) {
    try {
      parser.astify(source, {
        database: dialect,
        parseOptions: { includeLocations: true },
      });
      return { dialect };
    } catch (error) {
      const parseError = normalizeSqlParserError(error);
      if (
        bestError === undefined ||
        readSqlParserErrorOffset(parseError) >= readSqlParserErrorOffset(bestError)
      ) {
        bestError = parseError;
      }
    }
  }

  return {
    diagnostic: createSqlParseDiagnostic(file, bestError, diagnosticSource),
  };
}

export function normalizeSqlParserError(error: unknown): SqlParserError {
  return error instanceof Error ? (error as SqlParserError) : new Error(String(error));
}

export function readSqlParserErrorOffset(error: SqlParserError): number {
  return readNumber(error.location?.start?.offset) ?? -1;
}

export function createSqlParseDiagnostic(
  file: string,
  error: SqlParserError | undefined,
  source: string,
): Diagnostic {
  const baseMessage = error?.message?.trim();
  const diagnostic: Diagnostic = {
    file,
    message:
      baseMessage !== undefined && baseMessage.length > 0
        ? `${baseMessage}\nTried SQL dialects: ${sqlDialectCandidates.join(", ")}.`
        : `Failed to parse SQL. Tried dialects: ${sqlDialectCandidates.join(", ")}.`,
    severity: "error",
    source,
  };

  const startLine = readNumber(error?.location?.start?.line);
  const startColumn = readNumber(error?.location?.start?.column);
  const endLine = readNumber(error?.location?.end?.line);
  const endColumn = readNumber(error?.location?.end?.column);
  if (startLine !== undefined && startColumn !== undefined) {
    diagnostic.range = {
      ...(endColumn === undefined ? {} : { endColumn }),
      ...(endLine === undefined ? {} : { endLine }),
      startColumn,
      startLine,
    };
  }

  return diagnostic;
}
