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
    const metrics = readPythonMetricsFileMetrics(value);
    if (metrics === undefined) {
      continue;
    }

    results[file] = metrics;
  }

  return results;
}

function readPythonMetricsFileMetrics(value: unknown): PythonMetricsFileMetrics | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return {
    cc: readPythonComplexityEntries(record.cc),
    mi: readPythonMaintainabilityMetrics(record.mi),
    raw: readPythonRawMetrics(record.raw),
    ...readPythonReadabilityMetrics(record.readability),
  };
}

function readPythonMaintainabilityMetrics(value: unknown): PythonMetricsFileMetrics["mi"] {
  const miRecord = readRecord(value);
  return {
    rank: readString(miRecord, "rank") ?? "A",
    score: readNumber(miRecord.score) ?? 0,
  };
}

function readPythonRawMetrics(value: unknown): PythonMetricsFileMetrics["raw"] {
  const rawRecord = readRecord(value);
  return {
    blank: readMetricNumber(rawRecord, "blank"),
    comments: readMetricNumber(rawRecord, "comments"),
    lloc: readMetricNumber(rawRecord, "lloc"),
    loc: readMetricNumber(rawRecord, "loc"),
    multi: readMetricNumber(rawRecord, "multi"),
    singleComments: readMetricNumber(rawRecord, "singleComments"),
    sloc: readMetricNumber(rawRecord, "sloc"),
  };
}

function readMetricNumber(record: Record<string, unknown>, key: string): number {
  return readNumber(record[key]) ?? 0;
}

function readPythonReadabilityMetrics(
  value: unknown,
): Pick<PythonMetricsFileMetrics, "readability"> {
  const readabilityRecord = readOptionalRecord(value);
  return readabilityRecord === undefined
    ? {}
    : { readability: { score: readNumber(readabilityRecord.score) ?? 0 } };
}

function readPythonComplexityEntries(value: unknown): PythonMetricsFileMetrics["cc"] {
  return Array.isArray(value) ? value.flatMap((entry) => readPythonComplexityEntry(entry)) : [];
}

function readPythonComplexityEntry(entry: unknown): PythonMetricsFileMetrics["cc"] {
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
  return complexity === undefined ||
    endline === undefined ||
    lineno === undefined ||
    name === undefined ||
    rank === undefined ||
    type === undefined
    ? []
    : [{ complexity, endline, lineno, name, rank, type }];
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function readOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
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
