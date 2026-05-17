import { createHash, randomUUID } from 'crypto';
import { mkdir, open, readFile, rename, rm } from 'fs/promises';
import { dirname } from 'path';

export const MANAGED_SECTION_VERSION = 1;
export const MANAGED_START = '<!-- BEGIN EXECUTOR MANAGED SECTION -->';
export const MANAGED_END = '<!-- END EXECUTOR MANAGED SECTION -->';

export interface ManagedUpdateOptions {
  existingContent: string | null;
  generatedBody: string;
  allowAppend: boolean;
  force: boolean;
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

export function renderManagedSection(generatedBody: string): string {
  const body = normalizeBody(generatedBody);
  return [
    MANAGED_START,
    `<!-- executor-managed-version: ${MANAGED_SECTION_VERSION} -->`,
    `<!-- executor-managed-checksum: ${checksum(body)} -->`,
    body.trimEnd(),
    MANAGED_END,
    '',
  ].join('\n');
}

function parseManagedSection(content: string): ParsedSection | null {
  const start = content.indexOf(MANAGED_START);
  if (start < 0) return null;
  const endMarkerStart = content.indexOf(MANAGED_END, start + MANAGED_START.length);
  if (endMarkerStart < 0) return null;
  let end = endMarkerStart + MANAGED_END.length;
  if (content.slice(end, end + 2) === '\r\n') end += 2;
  else if (content[end] === '\n') end += 1;
  const block = content.slice(start, end);
  const inner = content.slice(start + MANAGED_START.length, endMarkerStart);
  const checksumMatch = inner.match(/<!--\s*executor-managed-checksum:\s*([a-f0-9]+)\s*-->/);
  const body = normalizeBody(inner
    .replace(/<!--\s*executor-managed-version:\s*\d+\s*-->/, '')
    .replace(/<!--\s*executor-managed-checksum:\s*[a-f0-9]+\s*-->/, '')
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
  return { managedFound: true, checksumValid: parsed.checksum !== null && parsed.checksum === checksum(parsed.body) };
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
  const section = renderManagedSection(options.generatedBody);
  if (options.existingContent === null) {
    return { ok: true, operation: 'create', content: section, managedFound: false, conflict: false, reason: 'File does not exist and will be created.' };
  }

  const parsed = parseManagedSection(options.existingContent);
  if (parsed) {
    const checksumMatches = parsed.checksum !== null && parsed.checksum === checksum(parsed.body);
    if (!checksumMatches && !options.force) {
      return {
        ok: false,
        operation: 'blocked',
        content: null,
        managedFound: true,
        conflict: true,
        reason: 'Managed section was edited outside Executor. Rerun with --force to replace the managed section.',
      };
    }
    if (checksumMatches && parsed.body === normalizeBody(options.generatedBody)) {
      return { ok: true, operation: 'unchanged', content: options.existingContent, managedFound: true, conflict: false, reason: 'Managed section is already current.' };
    }
    const content = `${options.existingContent.slice(0, parsed.start)}${section}${options.existingContent.slice(parsed.end)}`;
    if (content === options.existingContent) {
      return { ok: true, operation: 'unchanged', content: options.existingContent, managedFound: true, conflict: false, reason: 'Managed section is already current.' };
    }
    return { ok: true, operation: 'replace-managed', content, managedFound: true, conflict: !checksumMatches, reason: 'Existing managed section will be updated.' };
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
    };
  }
  if (options.allowAppend) {
    const content = appendSection(options.existingContent, section);
    return { ok: true, operation: 'append', content, managedFound: false, conflict, reason: 'Managed section will be appended while preserving existing content.' };
  }
  if (!options.force) {
    return {
      ok: false,
      operation: 'blocked',
      content: null,
      managedFound: false,
      conflict: true,
      reason: 'Existing file is not managed by Executor. Rerun with --force to replace it.',
    };
  }
  return { ok: true, operation: 'replace-file', content: section, managedFound: false, conflict: true, reason: 'Existing unmanaged file will be replaced because --force is set.' };
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
