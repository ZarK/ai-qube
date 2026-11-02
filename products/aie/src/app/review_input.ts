import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Checkout-relative folder that holds per-file diffs a lane can Read. */
export const REVIEW_INPUT_DIRECTORY = '.qube/aie/review-input';

export interface ReviewInputFile {
  /** Repository-relative path of the changed file (posix separators). */
  path: string;
  added: number;
  removed: number;
  /** Checkout-relative path of the readable diff file (posix separators). */
  diffPath: string;
}

export interface ParsedDiffFile {
  path: string;
  added: number;
  removed: number;
  diff: string;
}

function unquoteGitPath(value: string): string {
  if (!value.startsWith('"')) return value;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === 'string') return parsed;
  } catch { /* Fall through to the manual unescape. */ }
  return value.slice(1, -1).replace(/\\(.)/g, '$1');
}

function stripDiffPrefix(value: string): string {
  return value.startsWith('a/') || value.startsWith('b/') ? value.slice(2) : value;
}

function diffFilePath(line: string): string | null {
  const match = /^diff --git ("(?:\\.|[^"])*"|a\/\S+) ("(?:\\.|[^"])*"|b\/\S+)$/.exec(line);
  if (match) return stripDiffPrefix(unquoteGitPath(match[2]));
  const fallback = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
  return fallback ? fallback[2] : null;
}

function headerFilePath(line: string): string | null {
  const match = /^\+\+\+ ("(?:\\.|[^"])*"|b\/\S+)$/.exec(line);
  return match ? stripDiffPrefix(unquoteGitPath(match[1])) : null;
}

/**
 * Prefix every diff body line with its destination line number so a lane
 * without shell can cite lines that exist at the head. Added and context
 * lines carry their destination number; removed lines carry `-`.
 */
export function annotateDiffWithLineNumbers(diff: string): string {
  const lines = diff.split('\n');
  const output: string[] = [];
  let destination = 0;
  let inHunk = false;
  for (const line of lines) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      destination = Number(hunk[1]);
      inHunk = true;
      output.push(line);
      continue;
    }
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      output.push(line);
      continue;
    }
    if (!inHunk || line.startsWith('\\')) {
      output.push(line);
      continue;
    }
    if (line.startsWith('-')) {
      output.push(`- ${line}`);
      continue;
    }
    if (line.startsWith('+') || line.startsWith(' ')) {
      output.push(`${destination} ${line}`);
      destination += 1;
      continue;
    }
    output.push(line);
  }
  return output.join('\n');
}

/** Split a unified diff into one annotated entry per changed file. */
export function parseDiffByFile(diff: string): ParsedDiffFile[] {
  const files: ParsedDiffFile[] = [];
  let current: { path: string; headerPath: string | null; lines: string[] } | null = null;
  const flush = (): void => {
    if (!current) return;
    let added = 0;
    let removed = 0;
    let inHunk = false;
    for (const line of current.lines) {
      if (line.startsWith('@@ ')) {
        inHunk = true;
        continue;
      }
      if (!inHunk) continue;
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
    }
    files.push({
      path: current.path !== 'unknown' ? current.path : current.headerPath ?? current.path,
      added,
      removed,
      diff: annotateDiffWithLineNumbers(current.lines.join('\n')),
    });
    current = null;
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      current = { path: diffFilePath(line) ?? 'unknown', headerPath: null, lines: [line] };
      continue;
    }
    if (current) {
      if (current.headerPath === null && line.startsWith('+++ ')) current.headerPath = headerFilePath(line);
      current.lines.push(line);
    }
  }
  flush();
  return files.filter(file => file.path !== 'unknown' || file.added + file.removed > 0);
}

function diffFileName(index: number): string {
  return `${String(index).padStart(4, '0')}.diff`;
}

/**
 * Write one readable diff file per changed file under
 * `.qube/aie/review-input/<invocationId>/` inside the checkout. That folder
 * is readable by every isolated route: it is not under `.git/**` and not
 * under `.qube/aie/reviews/**`, which routes deny.
 */
export function writeReviewInputFiles(repoRoot: string, invocationId: string, diff: string): ReviewInputFile[] {
  const parsed = parseDiffByFile(diff);
  if (parsed.length === 0) return [];
  const directory = join(repoRoot, ...REVIEW_INPUT_DIRECTORY.split('/'), invocationId);
  mkdirSync(directory, { recursive: true });
  return parsed.map((file, index) => {
    const name = diffFileName(index);
    writeFileSync(join(directory, name), file.diff.endsWith('\n') ? file.diff : `${file.diff}\n`, 'utf8');
    return {
      path: file.path,
      added: file.added,
      removed: file.removed,
      diffPath: `${REVIEW_INPUT_DIRECTORY}/${invocationId}/${name}`,
    };
  });
}

/**
 * Compute `git diff <merge-base>...<head>` for the reviewed range. Returns
 * null when git cannot resolve the range (for example a test fixture with
 * no real commits); callers then proceed without review-input files.
 */
export async function computeReviewDiff(repoRoot: string, baseRef: string, headSha: string): Promise<string | null> {
  try {
    const mergeBase = (await execFileAsync('git', ['-C', repoRoot, 'merge-base', baseRef, headSha], {
      encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    })).stdout.trim();
    if (mergeBase === '') return null;
    const diff = await execFileAsync('git', ['-C', repoRoot, 'diff', `${mergeBase}...${headSha}`], {
      encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    });
    return diff.stdout;
  } catch {
    return null;
  }
}

/** Render the bounded prompt section listing review-input files. */
export function reviewInputPromptLines(files: readonly ReviewInputFile[]): string[] {
  if (files.length === 0) return [];
  return [
    'Review input diff files (one per changed file; each line is prefixed with its destination line number):',
    ...files.map(file => `- ${file.path} (+${file.added} -${file.removed}) -> ${file.diffPath}`),
    'Read each diff file you need with Read before judging it. Record every diff file you read in surfaces using its exact diff path. Any changed file whose diff file is not recorded in surfaces is treated as not inspected: the lane becomes inconclusive, names those files as not inspected, and the gate will say to split the pull request. If you cannot read every diff file within your turn limit, return status inconclusive and name the unread files in summary and completeness instead of guessing.',
  ];
}

/** Changed files whose diff file was not recorded as read in surfaces. */
export function unreadReviewInputFiles(files: readonly ReviewInputFile[], surfaces: readonly string[]): string[] {
  const read = new Set(surfaces.map(surface => surface.replace(/\\/g, '/')));
  return files
    .filter(file => !read.has(file.diffPath) && !read.has(file.path))
    .map(file => file.path);
}
