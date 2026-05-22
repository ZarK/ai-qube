import { readFileSync } from 'fs';
import { join } from 'path';
import { getKnownLegacyScript } from './legacy.js';
import type { MigrationInventoryItem, MigrationPlan } from './migrate/index.js';

export type MigrationCleanupStatus = 'safe' | 'blocked' | 'review-required' | 'not-needed';

export interface MigrationWrapperDiagnostics {
  installed: number;
  stale: number;
  paths: string[];
  stalePaths: string[];
}

export interface MigrationReferenceDiagnostics {
  count: number;
  paths: string[];
}

export interface MigrationReadinessDiagnostics {
  available: boolean;
  detectedPaths: number;
  plannedFileChanges: number;
  cleanupCandidates: number;
  reviewRequired: number;
  conflicts: number;
  legacyState: 'none' | 'detected';
  detectedCategories: string[];
  wrapperState: MigrationWrapperDiagnostics;
  remainingLegacyReferences: MigrationReferenceDiagnostics;
  cleanupStatus: MigrationCleanupStatus;
  recommendedCommands: string[];
  nextCommand: string;
}

function sortUniqueValues(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function dedupeValuesInOrder(values: string[]): string[] {
  return [...new Set(values)];
}

function getErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object' || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readRepoFile(repoRoot: string | null, path: string): string {
  if (!repoRoot) return '';
  try {
    return readFileSync(join(repoRoot, path), 'utf8');
  } catch (err: unknown) {
    if (getErrorCode(err) !== 'ENOENT') {
      throw new Error(`Failed reading repo file ${path} from ${repoRoot}. Likely cause: ${getErrorMessage(err)}. Next action: check file permissions, disk state, and repository path before rerunning migration diagnostics.`);
    }
    return '';
  }
}

function extractWrapperCommand(content: string): string | null {
  const match = /^# executor-compat-wrapper-command: (.+)$/m.exec(content);
  return match ? match[1].trim() : null;
}

function isCompatibilityWrapper(repoRoot: string | null, item: MigrationInventoryItem): boolean {
  if (item.category !== 'shell-helper') return false;
  if (item.confidence !== 'high') return false;
  return readRepoFile(repoRoot, item.path).includes('executor-compat-wrapper-version: 1');
}

function isStaleWrapper(repoRoot: string | null, item: MigrationInventoryItem): boolean {
  if (!isCompatibilityWrapper(repoRoot, item)) return false;
  const knownScript = getKnownLegacyScript(item.path);
  const command = extractWrapperCommand(readRepoFile(repoRoot, item.path));
  return !knownScript || command !== knownScript.replacementCommand;
}

function hasLegacyReference(item: MigrationInventoryItem): boolean {
  return item.category === 'instruction-block' || item.category === 'project-command' || item.category === 'workflow-doc';
}

function determineCleanupStatus(plan: MigrationPlan): MigrationCleanupStatus {
  if (plan.cleanupCandidates.length === 0) return 'not-needed';
  if (plan.conflicts.length > 0) return 'blocked';
  if (plan.inventory.some(item => item.confidence === 'review-required')) return 'review-required';
  return 'safe';
}

function buildRecommendedCommands(plan: MigrationPlan, staleWrapperCount: number): string[] {
  const commands = ['aie migrate legacy --dry-run'];
  if (plan.plannedFileChanges.length > 0) commands.push('aie migrate legacy --apply --dry-run');
  if (plan.cleanupCandidates.length > 0) commands.push('aie migrate legacy --cleanup --dry-run');
  if (plan.inventory.some(item => item.category === 'shell-helper' && item.confidence === 'high')) commands.push('aie migrate legacy --install-wrappers --dry-run');
  if (staleWrapperCount > 0) commands.push('aie migrate legacy --install-wrappers --dry-run');
  return dedupeValuesInOrder(commands);
}

export function buildMigrationReadinessDiagnostics(plan: MigrationPlan): MigrationReadinessDiagnostics {
  const wrapperItems = plan.inventory.filter(item => isCompatibilityWrapper(plan.repoRoot, item));
  const staleWrappers = wrapperItems.filter(item => isStaleWrapper(plan.repoRoot, item));
  const remainingReferences = plan.inventory.filter(item => hasLegacyReference(item));
  const detectedPaths = sortUniqueValues(plan.inventory.map(item => item.path));
  const wrapperPaths = sortUniqueValues(wrapperItems.map(item => item.path));
  const staleWrapperPaths = sortUniqueValues(staleWrappers.map(item => item.path));
  const remainingReferencePaths = sortUniqueValues(remainingReferences.map(item => item.path));
  const detectedCategories = sortUniqueValues(plan.inventory.map(item => item.category));
  const recommended = buildRecommendedCommands(plan, staleWrappers.length);
  return {
    available: plan.repoRoot !== null,
    detectedPaths: detectedPaths.length,
    plannedFileChanges: plan.plannedFileChanges.length,
    cleanupCandidates: plan.cleanupCandidates.length,
    reviewRequired: plan.inventory.filter(item => item.confidence === 'review-required').length,
    conflicts: plan.conflicts.length,
    legacyState: plan.inventory.length > 0 ? 'detected' : 'none',
    detectedCategories,
    wrapperState: {
      installed: wrapperPaths.length,
      stale: staleWrapperPaths.length,
      paths: wrapperPaths,
      stalePaths: staleWrapperPaths,
    },
    remainingLegacyReferences: {
      count: remainingReferencePaths.length,
      paths: remainingReferencePaths,
    },
    cleanupStatus: determineCleanupStatus(plan),
    recommendedCommands: recommended,
    nextCommand: recommended[0] ?? 'aie migrate legacy --dry-run',
  };
}
