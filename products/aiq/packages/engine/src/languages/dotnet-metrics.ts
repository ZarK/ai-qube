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

type DotNetScanMode = "blockComment" | "char" | "code" | "string" | "verbatimString";
type CommentStripState = {
  index: number;
  mode: DotNetScanMode;
  result: string;
};
type DotNetLiteralScanState = {
  index: number;
  mode: DotNetScanMode;
};
type TernaryBranchScanState = DotNetLiteralScanState & {
  braceDepth: number;
  bracketDepth: number;
  parenDepth: number;
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
  let state: CommentStripState = { index: 0, mode: "code", result: "" };

  while (state.index < source.length) {
    state = readCommentStripStep(source, state);
  }

  return state.result;
}

function readCommentStripStep(source: string, state: CommentStripState): CommentStripState {
  switch (state.mode) {
    case "blockComment":
      return readBlockCommentStripStep(source, state);
    case "char":
    case "string":
      return readEscapedLiteralStripStep(source, state);
    case "verbatimString":
      return readVerbatimStringStripStep(source, state);
    case "code":
      return readCodeCommentStripStep(source, state);
  }
}

function readBlockCommentStripStep(source: string, state: CommentStripState): CommentStripState {
  const current = source[state.index];
  const next = source[state.index + 1];
  if (current === "*" && next === "/") {
    return { ...state, index: state.index + 2, mode: "code" };
  }

  return {
    ...state,
    index: state.index + 1,
    result: state.result + (current === "\n" ? "\n" : ""),
  };
}

function readEscapedLiteralStripStep(source: string, state: CommentStripState): CommentStripState {
  const current = source[state.index];
  const next = source[state.index + 1];
  if (current === "\\") {
    return {
      ...state,
      index: state.index + 2,
      result: state.result + (current ?? "") + (next ?? ""),
    };
  }

  return {
    ...state,
    index: state.index + 1,
    mode: current === readLiteralTerminator(state.mode) ? "code" : state.mode,
    result: state.result + (current ?? ""),
  };
}

function readVerbatimStringStripStep(source: string, state: CommentStripState): CommentStripState {
  const current = source[state.index];
  const next = source[state.index + 1];
  if (current === '"' && next === '"') {
    return {
      ...state,
      index: state.index + 2,
      result: state.result + current + next,
    };
  }

  return {
    ...state,
    index: state.index + 1,
    mode: current === '"' ? "code" : state.mode,
    result: state.result + (current ?? ""),
  };
}

function readCodeCommentStripStep(source: string, state: CommentStripState): CommentStripState {
  const current = source[state.index];
  const next = source[state.index + 1];
  const literalStart = readLiteralStartMode(current, next);
  if (literalStart !== undefined) {
    return {
      ...state,
      index: state.index + literalStart.width,
      mode: literalStart.mode,
      result: state.result + literalStart.value,
    };
  }
  if (current === "/" && next === "*") {
    return { ...state, index: state.index + 2, mode: "blockComment" };
  }
  if (current === "/" && next === "/") {
    return { ...state, index: skipDotNetLineComment(source, state.index) };
  }

  return { ...state, index: state.index + 1, result: state.result + (current ?? "") };
}

function readLiteralStartMode(
  current: string | undefined,
  next: string | undefined,
): { mode: DotNetScanMode; value: string; width: number } | undefined {
  if (current === "@" && next === '"') {
    return { mode: "verbatimString", value: '@"', width: 2 };
  }
  if (current === '"') {
    return { mode: "string", value: current, width: 1 };
  }
  if (current === "'") {
    return { mode: "char", value: current, width: 1 };
  }
  return undefined;
}

function readLiteralTerminator(mode: DotNetScanMode): string {
  return mode === "char" ? "'" : '"';
}

function skipDotNetLineComment(source: string, startIndex: number): number {
  let index = startIndex;
  while (index < source.length && source[index] !== "\n") {
    index += 1;
  }
  return index;
}

function countDotNetTernaryOperators(source: string): number {
  let count = 0;
  let state: DotNetLiteralScanState = { index: 0, mode: "code" };

  while (state.index < source.length) {
    const literalState = readDotNetLiteralScanStep(source, state);
    if (literalState !== undefined) {
      state = literalState;
      continue;
    }

    const current = source[state.index];
    const next = source[state.index + 1];
    if (
      current === "?" &&
      next !== "?" &&
      next !== "." &&
      next !== "[" &&
      hasDotNetTernaryBranch(source, state.index)
    ) {
      count += 1;
    }
    state = { ...state, index: state.index + 1 };
  }

  return count;
}

function hasDotNetTernaryBranch(source: string, questionMarkIndex: number): boolean {
  let state: TernaryBranchScanState = {
    braceDepth: 0,
    bracketDepth: 0,
    index: questionMarkIndex + 1,
    mode: "code",
    parenDepth: 0,
  };

  while (state.index < source.length) {
    const literalState = readDotNetLiteralScanStep(source, state);
    if (literalState !== undefined) {
      state = { ...state, ...literalState };
      continue;
    }

    const delimiter = readTernaryBranchDelimiter(source[state.index], state);
    if (delimiter !== undefined) {
      return delimiter;
    }
    state = readTernaryBranchDepthStep(source[state.index], state);
  }

  return false;
}

function readDotNetLiteralScanStep(
  source: string,
  state: DotNetLiteralScanState,
): DotNetLiteralScanState | undefined {
  if (state.mode === "code") {
    return readDotNetLiteralStartStep(source, state);
  }
  if (state.mode === "verbatimString") {
    return readVerbatimStringScanStep(source, state);
  }
  return readEscapedLiteralScanStep(source, state);
}

function readDotNetLiteralStartStep(
  source: string,
  state: DotNetLiteralScanState,
): DotNetLiteralScanState | undefined {
  const literalStart = readLiteralStartMode(source[state.index], source[state.index + 1]);
  return literalStart === undefined
    ? undefined
    : { index: state.index + literalStart.width, mode: literalStart.mode };
}

function readEscapedLiteralScanStep(
  source: string,
  state: DotNetLiteralScanState,
): DotNetLiteralScanState {
  const current = source[state.index];
  const nextIndex = current === "\\" ? state.index + 2 : state.index + 1;
  return {
    index: nextIndex,
    mode: current === readLiteralTerminator(state.mode) ? "code" : state.mode,
  };
}

function readVerbatimStringScanStep(
  source: string,
  state: DotNetLiteralScanState,
): DotNetLiteralScanState {
  const current = source[state.index];
  const next = source[state.index + 1];
  if (current === '"' && next === '"') {
    return { ...state, index: state.index + 2 };
  }
  return {
    index: state.index + 1,
    mode: current === '"' ? "code" : state.mode,
  };
}

function readTernaryBranchDelimiter(
  current: string | undefined,
  state: TernaryBranchScanState,
): boolean | undefined {
  if (!isAtRootTernaryDepth(state)) {
    return undefined;
  }
  if (current === ":") {
    return true;
  }
  return current === ";" || current === "," || current === ")" || current === "]" || current === "}"
    ? false
    : undefined;
}

function readTernaryBranchDepthStep(
  current: string | undefined,
  state: TernaryBranchScanState,
): TernaryBranchScanState {
  const nextState = readTernaryBranchCloseDepthStep(current, state);
  if (nextState !== undefined) {
    return nextState;
  }

  return {
    ...state,
    braceDepth: current === "{" ? state.braceDepth + 1 : state.braceDepth,
    bracketDepth: current === "[" ? state.bracketDepth + 1 : state.bracketDepth,
    index: state.index + 1,
    parenDepth: current === "(" ? state.parenDepth + 1 : state.parenDepth,
  };
}

function readTernaryBranchCloseDepthStep(
  current: string | undefined,
  state: TernaryBranchScanState,
): TernaryBranchScanState | undefined {
  if (current === ")") {
    return { ...state, index: state.index + 1, parenDepth: Math.max(0, state.parenDepth - 1) };
  }
  if (current === "]") {
    return { ...state, bracketDepth: Math.max(0, state.bracketDepth - 1), index: state.index + 1 };
  }
  if (current === "}") {
    return { ...state, braceDepth: Math.max(0, state.braceDepth - 1), index: state.index + 1 };
  }
  return undefined;
}

function isAtRootTernaryDepth(state: TernaryBranchScanState): boolean {
  return state.parenDepth === 0 && state.bracketDepth === 0 && state.braceDepth === 0;
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
