import { execFileSync } from 'node:child_process';

export interface FindingLocationLike {
  readonly path: string;
  readonly line?: number;
  readonly endLine?: number;
}

/** Number of lines in text, where a trailing newline does not add a line. */
export function countTextLines(content: string): number {
  if (content === '') return 0;
  const breaks = content.match(/\r\n|\r|\n/g)?.length ?? 0;
  return /(?:\r\n|\r|\n)$/.test(content) ? breaks : breaks + 1;
}

/**
 * Reason a located finding cannot cite code at the reviewed head, or null
 * when the citation is valid. A null line count means the file is missing
 * at the head; an undefined line count means the head could not be read
 * and the citation is not judged.
 */
export function missingAtHeadReason(lineCount: number | null | undefined, location: FindingLocationLike): string | null {
  if (lineCount === undefined) return null;
  const anchor = location.line !== undefined ? `${location.path}:${location.line}` : location.path;
  if (lineCount === null) return `${anchor} does not exist at the reviewed head`;
  if (location.line !== undefined && location.line > lineCount) {
    return `${anchor} is past the end of ${location.path}, which has ${lineCount} line(s) at the reviewed head`;
  }
  if (location.endLine !== undefined && location.endLine > lineCount) {
    return `${location.path}:${location.endLine} is past the end of ${location.path}, which has ${lineCount} line(s) at the reviewed head`;
  }
  if (location.line !== undefined && location.endLine !== undefined && location.endLine < location.line) {
    return `${location.path}:${location.line}-${location.endLine} ends before it starts at the reviewed head`;
  }
  return null;
}

function safeHeadPath(path: string): string | null {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized === '' || normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) return null;
  if (normalized.split('/').includes('..')) return null;
  return normalized;
}

/**
 * Line counter for files as committed at `headSha`, read from git objects
 * so publication checks the reviewed head even when the checkout sits on
 * another revision. Returns null for a missing or unsafe path and
 * undefined when the head itself cannot be read from git.
 */
export function createHeadLineCounter(repoRoot: string, headSha: string): (path: string) => number | null | undefined {
  let headReadable: boolean | null = null;
  const cache = new Map<string, number | null>();
  return (path: string): number | null | undefined => {
    const normalized = safeHeadPath(path);
    if (normalized === null) return null;
    if (headReadable === null) {
      try {
        execFileSync('git', ['-C', repoRoot, 'rev-parse', '--verify', `${headSha}^{commit}`], { encoding: 'utf8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        headReadable = true;
      } catch {
        headReadable = false;
      }
    }
    if (!headReadable) return undefined;
    const cached = cache.get(normalized);
    if (cached !== undefined) return cached;
    let count: number | null;
    try {
      const content = execFileSync('git', ['-C', repoRoot, 'show', `${headSha}:${normalized}`], { encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      count = countTextLines(content);
    } catch {
      count = null;
    }
    cache.set(normalized, count);
    return count;
  };
}
