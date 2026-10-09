import { readFile } from "node:fs/promises";
import path from "node:path";

import { countSourceLines } from "./source-lines.js";

export interface LizardMetricsFileMetrics {
  blocks: Array<{
    complexity: number;
    file: string;
    name: string;
    nloc: number;
    parameterCount: number;
    startLine: number;
  }>;
  blockCount: number;
  maintainability: {
    rank: string;
    score: number;
  };
  maxComplexity: {
    rank: string;
    score: number;
  };
  raw: {
    sloc: number;
  };
}

export async function parseLizardMetrics(
  output: string,
  cwd: string,
  selectedFiles: readonly string[],
): Promise<Record<string, LizardMetricsFileMetrics>> {
  const rows = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => parseCsvLine(line));
  const rowMetrics = new Map<string, LizardMetricsFileMetrics["blocks"]>();
  const selectedPaths = new Set(selectedFiles.map((file) => path.resolve(file)));

  for (const row of rows) {
    const block = readLizardBlock(row, cwd);
    const file = block.file;
    if (!selectedPaths.has(file)) {
      throw new Error(`Lizard returned metrics for an unselected file: ${file}`);
    }
    const existingRows = rowMetrics.get(file);
    if (existingRows === undefined) {
      rowMetrics.set(file, [block]);
      continue;
    }
    existingRows.push(block);
  }

  const files = await Promise.all(
    selectedFiles.map(async (file) => {
      const source = await readFile(file, "utf8");
      const fileSloc = countSourceLines(source, file);
      const blocks = rowMetrics.get(file) ?? [];
      const maxComplexity = blocks.reduce((max, block) => Math.max(max, block.complexity), 0);
      const maintainabilityScore = clampNumber(
        100 -
          Math.log(fileSloc + 1) * 12 -
          Math.max(1, maxComplexity) * 5 -
          Math.max(0, blocks.length - 1) * 1.5,
        0,
        100,
      );

      return [
        file,
        {
          blockCount: blocks.length,
          blocks,
          maintainability: {
            rank: rankMaintainabilityScore(maintainabilityScore),
            score: maintainabilityScore,
          },
          maxComplexity: {
            rank: rankComplexityScore(maxComplexity),
            score: maxComplexity,
          },
          raw: { sloc: fileSloc },
        } satisfies LizardMetricsFileMetrics,
      ] as const;
    }),
  );

  return Object.fromEntries(files);
}

function readLizardBlock(row: string[], cwd: string): LizardMetricsFileMetrics["blocks"][number] {
  if (row.length !== 11) throw new Error("Malformed Lizard metrics row: expected 11 CSV fields.");
  const file = row[6];
  const name = row[7];
  if (!file?.trim() || !name?.trim())
    throw new Error("Lizard metrics require a file and function name.");
  readLizardInteger(row[2], "token count", 0);
  readLizardInteger(row[4], "length", 0);
  const startLine = readLizardInteger(row[9], "start line", 1);
  const endLine = readLizardInteger(row[10], "end line", 1);
  if (endLine < startLine) throw new Error("Lizard end line must not precede the start line.");
  return {
    complexity: readLizardInteger(row[1], "complexity", 1),
    file: path.resolve(cwd, file),
    name,
    nloc: readLizardInteger(row[0], "NLOC", 0),
    parameterCount: readLizardInteger(row[3], "parameter count", 0),
    startLine,
  };
}

function readLizardInteger(value: string | undefined, field: string, minimum: number): number {
  const number = Number(value);
  if (
    value === undefined ||
    !/^\d+$/u.test(value) ||
    !Number.isSafeInteger(number) ||
    number < minimum
  ) {
    throw new Error(`Malformed Lizard ${field}: ${value ?? "missing"}`);
  }
  return number;
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }
    current += char ?? "";
  }
  values.push(current);
  if (inQuotes) throw new Error("Malformed Lizard CSV output: unterminated quoted field.");
  return values;
}

function rankComplexityScore(score: number): string {
  if (score <= 5) {
    return "A";
  }
  if (score <= 10) {
    return "B";
  }
  if (score <= 20) {
    return "C";
  }
  if (score <= 30) {
    return "D";
  }
  return "E";
}

function rankMaintainabilityScore(score: number): string {
  if (score >= 80) {
    return "A";
  }
  if (score >= 60) {
    return "B";
  }
  if (score >= 40) {
    return "C";
  }
  if (score >= 20) {
    return "D";
  }
  return "E";
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
