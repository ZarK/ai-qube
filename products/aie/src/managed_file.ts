import { createHash, randomUUID } from 'crypto';
import { mkdir, open, readFile, rename, rm } from 'fs/promises';
import { dirname } from 'path';
import { readAiePackageVersion } from './review_mode.js';

export const MANAGED_SECTION_VERSION = 1;
export const MANAGED_START = '<!-- BEGIN EXECUTOR MANAGED SECTION -->';
export const MANAGED_END = '<!-- END EXECUTOR MANAGED SECTION -->';
export type ManagedCommentStyle = 'html' | 'hash';

interface ManagedMarkers {
  start: string;
  end: string;
  version: string;
  tool: (value: string) => string;
  checksum: (value: string) => string;
  versionPattern: RegExp;
  toolPattern: RegExp;
  checksumPattern: RegExp;
}

const MANAGED_MARKERS: Record<ManagedCommentStyle, ManagedMarkers> = {
  html: {
    start: MANAGED_START,
    end: MANAGED_END,
    version: `<!-- executor-managed-version: ${MANAGED_SECTION_VERSION} -->`,
    tool: value => `<!-- executor-managed-tool: ${value} -->`,
    checksum: value => `<!-- executor-managed-checksum: ${value} -->`,
    versionPattern: /<!--\s*executor-managed-version:\s*\d+\s*-->/,
    toolPattern: /<!--\s*executor-managed-tool:\s*([^\s]+)\s*-->/,
    checksumPattern: /<!--\s*executor-managed-checksum:\s*([a-f0-9]+)\s*-->/,
  },
  hash: {
    start: '# BEGIN EXECUTOR MANAGED SECTION',
    end: '# END EXECUTOR MANAGED SECTION',
    version: `# executor-managed-version: ${MANAGED_SECTION_VERSION}`,
    tool: value => `# executor-managed-tool: ${value}`,
    checksum: value => `# executor-managed-checksum: ${value}`,
    versionPattern: /#\s*executor-managed-version:\s*\d+/,
    toolPattern: /#\s*executor-managed-tool:\s*([^\s]+)/,
    checksumPattern: /#\s*executor-managed-checksum:\s*([a-f0-9]+)/,
  },
};

export interface ManagedUpdateOptions {
  existingContent: string | null;
  generatedBody: string;
  allowAppend: boolean;
  force: boolean;
  commentStyle?: ManagedCommentStyle;
  conflictPatterns?: RegExp[];
  conflictReason?: string;
}

export interface ManagedUpdateResult {
  ok: boolean;
  operation: 'create' | 'append' | 'replace-managed' | 'replace-file' | 'unchanged' | 'blocked';
  content: string | null;
  managedFound: boolean;
  conflict: boolean;
  reason: string;
  diff: string | null;
}

export interface ManagedSectionHealth {
  managedFound: boolean;
  checksumValid: boolean;
}

interface ParsedSection {
  start: number;
  end: number;
  block: string;
  body: string;
  checksum: string | null;
}

function checksum(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function normalizeBody(body: string): string {
  return `${body.replace(/\r\n/g, '\n').trimEnd()}\n`;
}

// Checksum input normalization: line endings and per-line trailing whitespace never count as edits.
function normalizeForChecksum(body: string): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n').map(line => line.replace(/[ \t]+$/, ''));
  return `${lines.join('\n').trimEnd()}\n`;
}

function managedChecksumMatches(stored: string | null, body: string): boolean {
  if (stored === null) return false;
  return stored === checksum(normalizeForChecksum(body));
}

const CONFLICT_DIFF_LINE_LIMIT = 60;

function renderManagedConflictDiff(currentBody: string, renderedBody: string): string {
  const currentLines = normalizeForChecksum(currentBody).trimEnd().split('\n');
  const renderedLines = normalizeForChecksum(renderedBody).trimEnd().split('\n');
  const rows = currentLines.length;
  const cols = renderedLines.length;
  const lcs: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let col = cols - 1; col >= 0; col -= 1) {
      lcs[row][col] = currentLines[row] === renderedLines[col]
        ? lcs[row + 1][col + 1] + 1
        : Math.max(lcs[row + 1][col], lcs[row][col + 1]);
    }
  }
  const diffLines: string[] = [];
  let row = 0;
  let col = 0;
  while (row < rows && col < cols) {
    if (currentLines[row] === renderedLines[col]) {
      row += 1;
      col += 1;
    } else if (lcs[row + 1][col] >= lcs[row][col + 1]) {
      diffLines.push(`- ${currentLines[row]}`);
      row += 1;
    } else {
      diffLines.push(`+ ${renderedLines[col]}`);
      col += 1;
    }
  }
  while (row < rows) diffLines.push(`- ${currentLines[row++]}`);
  while (col < cols) diffLines.push(`+ ${renderedLines[col++]}`);
  if (diffLines.length > CONFLICT_DIFF_LINE_LIMIT) {
    const omitted = diffLines.length - CONFLICT_DIFF_LINE_LIMIT;
    return `${diffLines.slice(0, CONFLICT_DIFF_LINE_LIMIT).join('\n')}\n… ${omitted} more differing line(s) omitted.`;
  }
  return diffLines.join('\n');
}

export function renderManagedSection(generatedBody: string, commentStyle: ManagedCommentStyle = 'html'): string {
  const body = normalizeBody(generatedBody);
  const markers = MANAGED_MARKERS[commentStyle];
  return [
    markers.start,
    markers.version,
    markers.tool(readAiePackageVersion()),
    markers.checksum(checksum(normalizeForChecksum(body))),
    body.trimEnd(),
    markers.end,
    '',
  ].join('\n');
}

export function readManagedToolVersion(content: string): string | null {
  for (const markers of Object.values(MANAGED_MARKERS)) {
    const match = content.match(markers.toolPattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

function parseManagedSection(content: string): ParsedSection | null {
  const candidates = Object.values(MANAGED_MARKERS)
    .map(markers => ({ markers, start: content.indexOf(markers.start) }))
    .filter(candidate => candidate.start >= 0)
    .sort((left, right) => left.start - right.start);
  const candidate = candidates[0];
  if (!candidate) return null;
  const { markers, start } = candidate;
  const endMarkerStart = content.indexOf(markers.end, start + markers.start.length);
  if (endMarkerStart < 0) return null;
  let end = endMarkerStart + markers.end.length;
  if (content.slice(end, end + 2) === '\r\n') end += 2;
  else if (content[end] === '\n') end += 1;
  const block = content.slice(start, end);
  const inner = content.slice(start + markers.start.length, endMarkerStart);
  const checksumMatch = inner.match(markers.checksumPattern);
  const body = normalizeBody(inner
    .replace(markers.versionPattern, '')
    .replace(markers.toolPattern, '')
    .replace(markers.checksumPattern, '')
    .replace(/^\s*\n/, '')
    .trimEnd());
  return { start, end, block, body, checksum: checksumMatch ? checksumMatch[1] : null };
}

export function hasManagedSection(content: string): boolean {
  return parseManagedSection(content) !== null;
}

export function getManagedSectionHealth(content: string): ManagedSectionHealth {
  const parsed = parseManagedSection(content);
  if (!parsed) return { managedFound: false, checksumValid: false };
  return { managedFound: true, checksumValid: managedChecksumMatches(parsed.checksum, parsed.body) };
}

function hasUnmanagedConflict(content: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(content));
}

function appendSection(content: string, section: string): string {
  if (content.trim() === '') return section;
  if (/(\r?\n){2}$/.test(content)) return `${content}${section}`;
  if (/\r?\n$/.test(content)) return `${content}\n${section}`;
  return `${content}\n\n${section}`;
}

export function planManagedUpdate(options: ManagedUpdateOptions): ManagedUpdateResult {
  const section = renderManagedSection(options.generatedBody, options.commentStyle ?? 'html');
  if (options.existingContent === null) {
    return { ok: true, operation: 'create', content: section, managedFound: false, conflict: false, reason: 'File does not exist and will be created.', diff: null };
  }

  const parsed = parseManagedSection(options.existingContent);
  if (parsed) {
    const checksumMatches = managedChecksumMatches(parsed.checksum, parsed.body);
    if (!checksumMatches && !options.force) {
      return {
        ok: false,
        operation: 'blocked',
        content: null,
        managedFound: true,
        conflict: true,
        reason: 'Managed section was edited outside Executor. Review the diff between the current managed section and the rendered content, then rerun with --force to replace the managed section.',
        diff: renderManagedConflictDiff(parsed.body, normalizeBody(options.generatedBody)),
      };
    }
    if (checksumMatches && parsed.body === normalizeBody(options.generatedBody)) {
      return { ok: true, operation: 'unchanged', content: options.existingContent, managedFound: true, conflict: false, reason: 'Managed section is already current.', diff: null };
    }
    const content = `${options.existingContent.slice(0, parsed.start)}${section}${options.existingContent.slice(parsed.end)}`;
    if (content === options.existingContent) {
      return { ok: true, operation: 'unchanged', content: options.existingContent, managedFound: true, conflict: false, reason: 'Managed section is already current.', diff: null };
    }
    return { ok: true, operation: 'replace-managed', content, managedFound: true, conflict: !checksumMatches, reason: 'Existing managed section will be updated.', diff: null };
  }

  const conflict = hasUnmanagedConflict(options.existingContent, options.conflictPatterns ?? []);
  if (conflict && !options.force) {
    return {
      ok: false,
      operation: 'blocked',
      content: null,
      managedFound: false,
      conflict: true,
      reason: options.conflictReason ?? 'Existing unmanaged Executor-like content was found. Rerun with --force to add the managed section intentionally.',
      diff: null,
    };
  }
  if (options.allowAppend) {
    const content = appendSection(options.existingContent, section);
    return { ok: true, operation: 'append', content, managedFound: false, conflict, reason: 'Managed section will be appended while preserving existing content.', diff: null };
  }
  if (!options.force) {
    return {
      ok: false,
      operation: 'blocked',
      content: null,
      managedFound: false,
      conflict: true,
      reason: 'Existing file is not managed by Executor. Rerun with --force to replace it.',
      diff: null,
    };
  }
  return { ok: true, operation: 'replace-file', content: section, managedFound: false, conflict: true, reason: 'Existing unmanaged file will be replaced because --force is set.', diff: null };
}

export async function readTextIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err: unknown) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : undefined;
    if (code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeFileSafely(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(tempPath, 'w', 0o666);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, path);
  } catch (err: unknown) {
    await rm(tempPath, { force: true });
    throw err;
  }
}
