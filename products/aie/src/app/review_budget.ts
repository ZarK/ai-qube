import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ReviewInputScope } from './review_input.js';

const execFileAsync = promisify(execFile);

/** Size of the review input that one lane run inspects. */
export interface ReviewInputSize {
  /** Changed files in scope: the full diff, or only the delta files on a delta round. */
  files: number;
  /** Added plus removed lines of those files; null when git could not count them. */
  changedLines: number | null;
  coverageAreas: number;
}

/**
 * Turn budget and timeout of one lane run. The configured route values are
 * minimums; the budget grows with the review input and has no upper cap.
 */
export interface ReviewBudget extends ReviewInputSize {
  maxTurns: number;
  timeoutSeconds: number;
  minimumTurns: number;
  minimumTimeoutSeconds: number;
}

// Turn rule: a fixed share for orientation and the final result, two turns
// per coverage area, one turn for every two files and one for every 400
// changed lines. Hosts batch several reads in one turn, so this leaves room
// to read every file in scope.
const BASE_TURNS = 8;
const TURNS_PER_AREA = 2;
const FILES_PER_TURN = 2;
const LINES_PER_TURN = 400;
// Timeout rule: 25 seconds per file and one second per 25 changed lines on
// top of a fixed two minutes. Recorded lane runs read about one file every
// 11 seconds, so the clock does not cut a run that has turns left.
const BASE_SECONDS = 120;
const SECONDS_PER_FILE = 25;
const LINES_PER_SECOND = 25;

export function calculateReviewBudget(minimum: { maxTurns: number; timeoutSeconds: number }, size: ReviewInputSize): ReviewBudget {
  const files = Math.max(0, size.files);
  const changedLines = size.changedLines === null ? null : Math.max(0, size.changedLines);
  const coverageAreas = Math.max(1, size.coverageAreas);
  const lines = changedLines ?? 0;
  const turns = BASE_TURNS + TURNS_PER_AREA * coverageAreas + Math.ceil(files / FILES_PER_TURN) + Math.ceil(lines / LINES_PER_TURN);
  const seconds = BASE_SECONDS + SECONDS_PER_FILE * files + Math.ceil(lines / LINES_PER_SECOND);
  return {
    maxTurns: Math.max(minimum.maxTurns, turns),
    timeoutSeconds: Math.max(minimum.timeoutSeconds, seconds),
    files,
    changedLines,
    coverageAreas,
    minimumTurns: minimum.maxTurns,
    minimumTimeoutSeconds: minimum.timeoutSeconds,
  };
}

function numstatLines(output: string): Map<string, number> {
  const lines = new Map<string, number>();
  for (const row of output.split('\n')) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(row.trimEnd());
    if (!match) continue;
    // Binary files report "-" and count as one changed file with no lines.
    const added = match[1] === '-' ? 0 : Number(match[1]);
    const removed = match[2] === '-' ? 0 : Number(match[2]);
    lines.set(match[3], (lines.get(match[3]) ?? 0) + added + removed);
  }
  return lines;
}

/**
 * Measure the review input of a lane scope with `git diff --numstat`: the
 * full range from the merge base, or on a delta round only the delta files
 * since the approved head. When git cannot count the range, the file count
 * comes from the scope paths and the changed line count is null.
 */
export async function measureReviewInput(input: {
  repoRoot: string;
  baseRef: string;
  headSha: string;
  scope: ReviewInputScope;
  changedPaths: readonly string[];
  coverageAreas: number;
}): Promise<ReviewInputSize> {
  const delta = input.scope.scope === 'delta' && input.scope.baseHeadSha !== null;
  const scopePaths = delta ? [...new Set(input.scope.deltaPaths)] : [...new Set(input.changedPaths)];
  const range = delta ? [input.scope.baseHeadSha as string, input.headSha] : [`${input.baseRef}...${input.headSha}`];
  try {
    if (range.some(part => part.trim() === '' || part.startsWith('-'))) throw new Error('unsafe range');
    const result = await execFileAsync('git', ['-C', input.repoRoot, 'diff', '--numstat', '--no-renames', ...range], {
      encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    });
    const counted = numstatLines(result.stdout);
    const paths = delta ? scopePaths.filter(path => counted.has(path)) : [...counted.keys()];
    // A delta path that no longer differs still counts as a file to confirm.
    const files = delta ? scopePaths.length : paths.length;
    const changedLines = paths.reduce((sum, path) => sum + (counted.get(path) ?? 0), 0);
    return { files, changedLines, coverageAreas: input.coverageAreas };
  } catch {
    return { files: scopePaths.length, changedLines: null, coverageAreas: input.coverageAreas };
  }
}

/** Render the prompt sentence that states the budget of this run. */
export function reviewBudgetPromptLine(budget: ReviewBudget): string {
  const lines = budget.changedLines === null ? '' : ` and ${budget.changedLines} changed lines`;
  return `Your budget for this review input is ${budget.maxTurns} turns and ${budget.timeoutSeconds} seconds, calculated from ${budget.files} changed files${lines} in scope and ${budget.coverageAreas} coverage area(s). The budget is sized to read every file in scope: read the change before you judge it, batch read-only inspection, never create scratch files or use shell redirection, and keep the final turn for the required JSON result.`;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Read a recorded budget; any malformed field makes the whole record absent. */
export function readReviewBudget(value: unknown): ReviewBudget | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const fields = ['maxTurns', 'timeoutSeconds', 'files', 'coverageAreas', 'minimumTurns', 'minimumTimeoutSeconds'] as const;
  if (!fields.every(field => nonNegativeInteger(record[field]))) return null;
  if (record.changedLines !== null && !nonNegativeInteger(record.changedLines)) return null;
  return {
    maxTurns: record.maxTurns as number,
    timeoutSeconds: record.timeoutSeconds as number,
    files: record.files as number,
    changedLines: record.changedLines as number | null,
    coverageAreas: record.coverageAreas as number,
    minimumTurns: record.minimumTurns as number,
    minimumTimeoutSeconds: record.minimumTimeoutSeconds as number,
  };
}
