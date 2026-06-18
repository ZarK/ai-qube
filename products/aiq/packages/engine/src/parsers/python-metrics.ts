import { readNumber, readString } from "./utils.js";

export function parsePythonMetrics(output: string): Record<string, PythonMetricsFileMetrics> {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    throw new Error("Radon produced no JSON metrics output.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`Failed to parse radon JSON output: ${readOutputSnippet(trimmed)}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Radon metrics output was not a JSON object.");
  }

  const results: Record<string, PythonMetricsFileMetrics> = {};
  for (const [file, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) {
      continue;
    }

    const record = value as Record<string, unknown>;
    const ccEntries = Array.isArray(record.cc)
      ? record.cc.flatMap((entry) => {
          if (typeof entry !== "object" || entry === null) {
            return [];
          }

          const block = entry as Record<string, unknown>;
          const complexity = readNumber(block.complexity);
          const endline = readNumber(block.endline);
          const lineno = readNumber(block.lineno);
          const name = readString(block, "name");
          const rank = readString(block, "rank");
          const type = readString(block, "type");
          if (
            complexity === undefined ||
            endline === undefined ||
            lineno === undefined ||
            name === undefined ||
            rank === undefined ||
            type === undefined
          ) {
            return [];
          }

          return [{ complexity, endline, lineno, name, rank, type }];
        })
      : [];
    const rawRecord =
      typeof record.raw === "object" && record.raw !== null
        ? (record.raw as Record<string, unknown>)
        : {};
    const miRecord =
      typeof record.mi === "object" && record.mi !== null
        ? (record.mi as Record<string, unknown>)
        : {};
    const readabilityRecord =
      typeof record.readability === "object" && record.readability !== null
        ? (record.readability as Record<string, unknown>)
        : undefined;

    results[file] = {
      cc: ccEntries,
      mi: {
        rank: readString(miRecord, "rank") ?? "A",
        score: readNumber(miRecord.score) ?? 0,
      },
      raw: {
        blank: readNumber(rawRecord.blank) ?? 0,
        comments: readNumber(rawRecord.comments) ?? 0,
        lloc: readNumber(rawRecord.lloc) ?? 0,
        loc: readNumber(rawRecord.loc) ?? 0,
        multi: readNumber(rawRecord.multi) ?? 0,
        singleComments: readNumber(rawRecord.singleComments) ?? 0,
        sloc: readNumber(rawRecord.sloc) ?? 0,
      },
      ...(readabilityRecord === undefined
        ? {}
        : {
            readability: {
              score: readNumber(readabilityRecord.score) ?? 0,
            },
          }),
    };
  }

  return results;
}

export function readOutputSnippet(output: string): string {
  const normalized = output.replace(/\s+/gu, " ").trim();
  if (normalized.length <= 160) {
    return normalized;
  }

  return `${normalized.slice(0, 157)}...`;
}

export interface PythonMetricsFileMetrics {
  cc: Array<{
    complexity: number;
    endline: number;
    lineno: number;
    name: string;
    rank: string;
    type: string;
  }>;
  mi: {
    rank: string;
    score: number;
  };
  raw: {
    blank: number;
    comments: number;
    lloc: number;
    loc: number;
    multi: number;
    singleComments: number;
    sloc: number;
  };
  readability?: {
    score: number;
  };
}
