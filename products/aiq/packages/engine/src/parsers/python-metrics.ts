export function parsePythonMetrics(output: string): Record<string, PythonMetricsFileMetrics> {
  const trimmed = output.trim();
  if (trimmed.length === 0) throw new Error("Radon produced no JSON metrics output.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`Failed to parse radon JSON output: ${readOutputSnippet(trimmed)}`);
  }
  const report = readRecord(parsed, "output");
  const results: Record<string, PythonMetricsFileMetrics> = {};
  for (const [file, value] of Object.entries(report)) {
    try {
      results[file] = readPythonMetricsFile(value);
    } catch (error) {
      throw new Error(
        `Malformed Radon metrics for ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return results;
}

function readPythonMetricsFile(value: unknown): PythonMetricsFileMetrics {
  const record = readRecord(value, "file");
  const mi = readRecord(record.mi, "mi");
  const raw = readRecord(record.raw, "raw");
  const readability =
    record.readability === undefined ? undefined : readRecord(record.readability, "readability");
  return {
    cc: readPythonComplexityEntries(record.cc),
    mi: {
      rank: readMetricRank(mi),
      score: readMetricNumber(mi, "score"),
    },
    raw: {
      blank: readMetricCount(raw, "blank"),
      comments: readMetricCount(raw, "comments"),
      lloc: readMetricCount(raw, "lloc"),
      loc: readMetricCount(raw, "loc"),
      multi: readMetricCount(raw, "multi"),
      singleComments: readMetricCount(raw, "singleComments"),
      sloc: readMetricCount(raw, "sloc"),
    },
    ...(readability === undefined
      ? {}
      : { readability: { score: readMetricNumber(readability, "score") } }),
  };
}

function readMetricNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${key} must be a finite non-negative number.`);
  }
  return value;
}

function readMetricCount(record: Record<string, unknown>, key: string): number {
  const value = readMetricNumber(record, key);
  if (!Number.isSafeInteger(value)) throw new Error(`${key} must be an integer.`);
  return value;
}

function readMetricRank(record: Record<string, unknown>): string {
  const value = readMetricString(record, "rank");
  if (!/^[A-F]$/u.test(value)) throw new Error("rank must be from A to F.");
  return value;
}

function readMetricString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value;
}

function readPythonComplexityEntries(value: unknown): PythonMetricsFileMetrics["cc"] {
  if (!Array.isArray(value)) throw new Error("cc must be an array.");
  return value.map((entry) => {
    const block = readRecord(entry, "complexity block");
    return {
      complexity: readMetricCount(block, "complexity"),
      endline: readMetricCount(block, "endline"),
      lineno: readMetricCount(block, "lineno"),
      name: readMetricString(block, "name"),
      rank: readMetricRank(block),
      type: readMetricString(block, "type"),
    };
  });
}

function readRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Radon ${field} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
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
