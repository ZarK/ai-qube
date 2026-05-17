import { isAbsolute, join, relative, resolve } from 'path';
import { getKnownLegacyScript, KnownLegacyScript } from './legacy';
import type { MigrationConflict, MigrationInventoryItem } from './migrate';

export interface PlannedMigrationWrite {
  path: string;
  content: string;
  executable: boolean;
}

export interface PlannedRemoval {
  path: string;
}

export function selectedLegacyPaths(repoRoot: string, inputPaths: string[] | undefined): { paths: string[]; conflicts: MigrationConflict[] } {
  const paths = new Set<string>();
  const conflicts: MigrationConflict[] = [];
  for (const inputPath of inputPaths ?? []) {
    const normalizedInput = inputPath.trim();
    if (normalizedInput === '') continue;
    const absolutePath = isAbsolute(normalizedInput) ? normalizedInput : resolve(repoRoot, normalizedInput);
    const relativeSelectedPath = relative(repoRoot, absolutePath);
    if (relativeSelectedPath === '' || relativeSelectedPath.startsWith('..') || isAbsolute(relativeSelectedPath)) {
      conflicts.push({
        path: normalizedInput,
        reason: 'Selected legacy path is outside the repository root.',
        nextAction: 'Select a legacy helper path inside the repository before applying migration.',
      });
      continue;
    }
    paths.add(relativeSelectedPath);
  }
  return { paths: [...paths].sort(), conflicts };
}

function shellWords(command: string): string[] {
  return command.split(/\s+/).filter(word => word !== '' && !/^<[^>]+>$/.test(word));
}

function quoteShellWord(word: string): string {
  return `'${word.replace(/'/g, `'"'"'`)}'`;
}

export function renderCompatibilityWrapper(script: KnownLegacyScript): string {
  const command = shellWords(script.replacementCommand).map(quoteShellWord).join(' ');
  return [
    '#!/usr/bin/env sh',
    '# executor-compat-wrapper-version: 1',
    `# executor-compat-wrapper-command: ${script.replacementCommand}`,
    'set -eu',
    `printf '%s\n' 'Executor compatibility wrapper: ${script.filename} delegates to ${script.replacementCommand}. Update legacy references, then remove this shim.' >&2`,
    `exec ${command} "$@"`,
    '',
  ].join('\n');
}

export function wrapperWriteFor(repoRoot: string, item: MigrationInventoryItem): PlannedMigrationWrite | null {
  if (item.category !== 'shell-helper' || item.confidence !== 'high') return null;
  const script = getKnownLegacyScript(item.path);
  if (!script) return null;
  return { path: join(repoRoot, item.path), content: renderCompatibilityWrapper(script), executable: true };
}

export function cleanupRemovalFor(repoRoot: string, item: MigrationInventoryItem): PlannedRemoval | null {
  if (item.proposedAction !== 'remove') return null;
  return { path: join(repoRoot, item.path) };
}

export function explicitCleanupItem(path: string, known: KnownLegacyScript | null): MigrationInventoryItem {
  return {
    id: `cleanup-${path}`,
    category: 'shell-helper',
    path,
    confidence: known ? 'high' : 'review-required',
    fingerprints: known ? [known.fingerprint, `legacy helper group: ${known.category}`] : ['explicit cleanup path'],
    proposedAction: 'remove',
    reason: known
      ? 'Explicitly selected known legacy helper can be removed when cleanup is applied.'
      : 'Explicitly selected path is not a known legacy helper fingerprint and requires --force before cleanup.',
    requiresConfirmation: true,
  };
}
