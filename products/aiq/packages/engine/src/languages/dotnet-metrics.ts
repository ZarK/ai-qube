import { stat } from "node:fs/promises";

import type { DotNetRunnerRuntime } from "./contracts.js";
import type { DotNetProject } from "./dotnet.js";

export type DotNetMetricsFileMetrics = {
  blockCount: number;
  maintainability: { rank: string; score: number };
  maxComplexity: { rank: string; score: number };
  raw: { sloc: number };
};

export type DotNetMetricsProjectMetrics = {
  args: string[];
  durationMs: number;
  exitCode: number | undefined;
  files: Record<string, DotNetMetricsFileMetrics>;
  finishedAt: string;
  startedAt: string;
};

export async function getDotNetMetricsProjectMetrics(
  project: DotNetProject,
  runtime: DotNetRunnerRuntime,
): Promise<{ cacheHit: boolean; metrics: DotNetMetricsProjectMetrics }> {
  const manifestKey = createDotNetMetricsManifestKey(project);
  const cacheKey = await createDotNetMetricsCacheKey(project, manifestKey);
  const cached = await runtime.getCachedValue("metrics:dotnet", manifestKey, cacheKey, () =>
    runDotNetMetricsProjectTask(project, runtime),
  );

  return {
    cacheHit: cached.cacheHit,
    metrics: cached.value,
  };
}

function createDotNetMetricsManifestKey(project: DotNetProject): string {
  return `${project.targetPath}:${[...project.files].sort().join("|")}`;
}

async function createDotNetMetricsCacheKey(
  project: DotNetProject,
  manifestKey = createDotNetMetricsManifestKey(project),
): Promise<string> {
  const fileEntries = await Promise.all(
    [...project.files]
      .sort((left, right) => left.localeCompare(right))
      .map(async (file) => {
        const fileStats = await stat(file);
        return `${file}@${fileStats.size}:${fileStats.mtimeMs}`;
      }),
  );

  return `${manifestKey}:${fileEntries.join("|")}`;
}

async function runDotNetMetricsProjectTask(
  project: DotNetProject,
  runtime: DotNetRunnerRuntime,
): Promise<DotNetMetricsProjectMetrics> {
  if (runtime.signal?.aborted) {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    runtime.throwIfAbortError(abortError);
  }

  const startedAt = new Date();
  const files = await Promise.all(
    project.files.map(
      async (file) =>
        [file, await readDotNetFileMetrics(await runtime.readFileText(file))] as const,
    ),
  );
  const finishedAt = new Date();

  return {
    args: ["scan", ...project.files],
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    exitCode: 0,
    files: Object.fromEntries(files),
    finishedAt: finishedAt.toISOString(),
    startedAt: startedAt.toISOString(),
  };
}

async function readDotNetFileMetrics(source: string): Promise<DotNetMetricsFileMetrics> {
  const stripped = stripDotNetComments(source);
  const codeLines = stripped
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const sloc = codeLines.length;
  const methodCount = countMatches(
    stripped,
    /^[ \t]*(?:\[[^\]]+\]\s*)*(?:(?:public|private|protected|internal|static|sealed|virtual|override|async|extern|unsafe|new|partial)\s+)*(?:[A-Za-z_][\w<>,?.\[\]]*\s+)+[A-Za-z_][\w]*\s*\([^;{}]*\)\s*(?:where\b[^\{]+)?\{/gmu,
  );
  const decisionCount =
    countMatches(stripped, /\bif\b/gu) +
    countMatches(stripped, /\bfor\b/gu) +
    countMatches(stripped, /\bforeach\b/gu) +
    countMatches(stripped, /\bwhile\b/gu) +
    countMatches(stripped, /\bcase\b/gu) +
    countMatches(stripped, /\bcatch\b/gu) +
    countMatches(stripped, /&&/gu) +
    countMatches(stripped, /\|\|/gu) +
    countDotNetTernaryOperators(stripped);
  const blockCount = methodCount;
  const maxComplexityScore =
    methodCount === 0 ? 0 : Math.max(1, Math.ceil((decisionCount + methodCount) / methodCount));
  const maintainabilityScore = clampNumber(
    100 - Math.log(sloc + 1) * 12 - maxComplexityScore * 5 - Math.max(0, methodCount - 1) * 1.5,
    0,
    100,
  );

  return {
    blockCount,
    maintainability: {
      rank: rankMaintainabilityScore(maintainabilityScore),
      score: maintainabilityScore,
    },
    maxComplexity: {
      rank: rankComplexityScore(maxComplexityScore),
      score: maxComplexityScore,
    },
    raw: { sloc },
  };
}

function stripDotNetComments(source: string): string {
  let result = "";
  let index = 0;
  let inBlockComment = false;
  let inString = false;
  let inVerbatimString = false;
  let inChar = false;

  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];
    if (inBlockComment) {
      if (current === "*" && next === "/") {
        inBlockComment = false;
        index += 2;
        continue;
      }
      if (current === "\n") {
        result += "\n";
      }
      index += 1;
      continue;
    }
    if (inString) {
      result += current ?? "";
      if (current === "\\") {
        result += next ?? "";
        index += 2;
        continue;
      }
      if (current === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }
    if (inVerbatimString) {
      result += current ?? "";
      if (current === '"' && next === '"') {
        result += next;
        index += 2;
        continue;
      }
      if (current === '"') {
        inVerbatimString = false;
      }
      index += 1;
      continue;
    }
    if (inChar) {
      result += current ?? "";
      if (current === "\\") {
        result += next ?? "";
        index += 2;
        continue;
      }
      if (current === "'") {
        inChar = false;
      }
      index += 1;
      continue;
    }
    if (current === "@" && next === '"') {
      result += '@"';
      inVerbatimString = true;
      index += 2;
      continue;
    }
    if (current === '"') {
      inString = true;
      result += current;
      index += 1;
      continue;
    }
    if (current === "'") {
      inChar = true;
      result += current;
      index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      inBlockComment = true;
      index += 2;
      continue;
    }
    if (current === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    result += current ?? "";
    index += 1;
  }

  return result;
}

function countDotNetTernaryOperators(source: string): number {
  let count = 0;
  let index = 0;
  let inString = false;
  let inVerbatimString = false;
  let inChar = false;

  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];
    if (inString) {
      if (current === "\\") {
        index += 2;
        continue;
      }
      if (current === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }
    if (inVerbatimString) {
      if (current === '"' && next === '"') {
        index += 2;
        continue;
      }
      if (current === '"') {
        inVerbatimString = false;
      }
      index += 1;
      continue;
    }
    if (inChar) {
      if (current === "\\") {
        index += 2;
        continue;
      }
      if (current === "'") {
        inChar = false;
      }
      index += 1;
      continue;
    }
    if (current === "@" && next === '"') {
      inVerbatimString = true;
      index += 2;
      continue;
    }
    if (current === '"') {
      inString = true;
      index += 1;
      continue;
    }
    if (current === "'") {
      inChar = true;
      index += 1;
      continue;
    }
    if (
      current === "?" &&
      next !== "?" &&
      next !== "." &&
      next !== "[" &&
      hasDotNetTernaryBranch(source, index)
    ) {
      count += 1;
    }
    index += 1;
  }

  return count;
}

function hasDotNetTernaryBranch(source: string, questionMarkIndex: number): boolean {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let index = questionMarkIndex + 1;
  let inString = false;
  let inVerbatimString = false;
  let inChar = false;

  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];
    if (inString) {
      if (current === "\\") {
        index += 2;
        continue;
      }
      if (current === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }
    if (inVerbatimString) {
      if (current === '"' && next === '"') {
        index += 2;
        continue;
      }
      if (current === '"') {
        inVerbatimString = false;
      }
      index += 1;
      continue;
    }
    if (inChar) {
      if (current === "\\") {
        index += 2;
        continue;
      }
      if (current === "'") {
        inChar = false;
      }
      index += 1;
      continue;
    }
    if (current === "@" && next === '"') {
      inVerbatimString = true;
      index += 2;
      continue;
    }
    if (current === '"') {
      inString = true;
      index += 1;
      continue;
    }
    if (current === "'") {
      inChar = true;
      index += 1;
      continue;
    }
    if (current === "(") {
      parenDepth += 1;
      index += 1;
      continue;
    }
    if (current === ")") {
      if (parenDepth === 0) return false;
      parenDepth -= 1;
      index += 1;
      continue;
    }
    if (current === "[") {
      bracketDepth += 1;
      index += 1;
      continue;
    }
    if (current === "]") {
      if (bracketDepth === 0) return false;
      bracketDepth -= 1;
      index += 1;
      continue;
    }
    if (current === "{") {
      braceDepth += 1;
      index += 1;
      continue;
    }
    if (current === "}") {
      if (braceDepth === 0) return false;
      braceDepth -= 1;
      index += 1;
      continue;
    }
    if (current === ":" && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) return true;
    if (
      (current === ";" || current === ",") &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0
    )
      return false;
    index += 1;
  }

  return false;
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function rankComplexityScore(score: number): string {
  if (score <= 5) return "A";
  if (score <= 10) return "B";
  if (score <= 20) return "C";
  if (score <= 30) return "D";
  return "E";
}

function rankMaintainabilityScore(score: number): string {
  if (score >= 80) return "A";
  if (score >= 60) return "B";
  if (score >= 40) return "C";
  if (score >= 20) return "D";
  return "E";
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

