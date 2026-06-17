import { Dirent } from 'fs';
import { chmod, readdir, readFile, rm } from 'fs/promises';
import { basename, join, relative } from 'path';
import { Config, getDefaults, loadConfigFile, ValidationError } from '../config/index.js';
import { collectInstructionUpdates, MigrationInstructionUpdate, PlannedWrite, selectedInstructionPaths } from '../instruction_migration.js';
import { cleanupRemovalFor, explicitCleanupItem, PlannedMigrationWrite, PlannedRemoval, selectedLegacyPaths, wrapperWriteFor } from '../legacy_file_migration.js';
import { getKnownLegacyScript, hasLegacyInstructionReference, legacyCommandMappings, LegacyCommandMapping, LEGACY_HELPER_REFERENCE_PATTERN } from '../legacy.js';
import { writeFileSafely } from '../managed_file.js';
import { getRepoRoot } from '../repo/index.js';
export { formatMigrationPlan } from '../migration_format.js';

export type MigrationCategory = 'shell-helper' | 'project-command' | 'instruction-block' | 'workflow-doc';
export type MigrationConfidence = 'high' | 'medium' | 'review-required';
export type MigrationAction = 'remove' | 'replace' | 'preserve' | 'skip';
export type MigrationMode = 'audit-plan' | 'apply-plan' | 'apply-result';

export interface MigrationInventoryItem {
  id: string;
  category: MigrationCategory;
  path: string;
  confidence: MigrationConfidence;
  fingerprints: string[];
  proposedAction: MigrationAction;
  reason: string;
  requiresConfirmation: boolean;
}

export interface MigrationConflict {
  path: string;
  reason: string;
  nextAction: string;
}

export interface MigrationConfirmation {
  path: string;
  reason: string;
  requiredFor: MigrationAction;
}

export interface MigrationPreservationPlan {
  priorityLabels: string[];
  statusLabels: string[];
  componentLabels: string[];
  blockerMetadata: 'preserve';
  sequenceMetadata: 'preserve';
  milestoneAssignments: 'preserve';
  milestoneOrdering: Config['milestoneOrdering'];
  activeIssueState: 'preserve';
  branchState: 'preserve';
  gitHistory: 'preserve';
  githubState: 'preserve';
}

export interface MigrationPlan {
  ok: boolean;
  command: 'migrate legacy';
  dryRun: boolean;
  apply: boolean;
  forced: boolean;
  cleanup: boolean;
  installWrappers: boolean;
  repoRoot: string | null;
  mode: MigrationMode;
  inventory: MigrationInventoryItem[];
  plannedFileChanges: MigrationInventoryItem[];
  instructionUpdates: MigrationInstructionUpdate[];
  wrapperInstalls: MigrationInventoryItem[];
  cleanupCandidates: MigrationInventoryItem[];
  skippedFiles: MigrationInventoryItem[];
  completedChanges: string[];
  conflicts: MigrationConflict[];
  warnings: string[];
  confirmations: MigrationConfirmation[];
  preservation: MigrationPreservationPlan;
  configErrors: ValidationError[];
  nextCommand: string;
}

export interface MigrationOptions {
  cwd?: string;
  dryRun?: boolean;
  apply?: boolean;
  force?: boolean;
  instructionPaths?: string[];
  legacyPaths?: string[];
  cleanup?: boolean;
  installWrappers?: boolean;
}

export interface MigrationMap {
  ok: true;
  command: 'migrate map';
  mappings: LegacyCommandMapping[];
  nextCommand: string;
}

interface MigrationPlanBuild {
  plan: MigrationPlan;
  writes: PlannedMigrationWrite[];
  removals: PlannedRemoval[];
}

const LEGACY_TEXT_PATTERNS: { pattern: RegExp; fingerprint: string }[] = [
  { pattern: LEGACY_HELPER_REFERENCE_PATTERN, fingerprint: 'legacy helper command reference' },
  { pattern: /legacy issue workflow/i, fingerprint: 'legacy issue workflow marker' },
  { pattern: /legacy workflow helper/i, fingerprint: 'legacy workflow helper marker' },
];

function sortByPath<T extends { path: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => left.path.localeCompare(right.path));
}

function portablePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function isMigrationInventoryItem(item: MigrationInventoryItem | null): item is MigrationInventoryItem {
  return item !== null;
}

function relativePath(repoRoot: string, path: string): string {
  const value = relative(repoRoot, path);
  return value === '' ? '.' : portablePath(value);
}

async function readTextIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function listEntries(repoRoot: string, directory: string): Promise<Dirent[]> {
  try {
    const entries = await readdir(join(repoRoot, directory), { withFileTypes: true });
    return [...entries].sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

async function listFiles(repoRoot: string, directory: string, recursive: boolean): Promise<string[]> {
  const entries = await listEntries(repoRoot, directory);
  const files = entries
    .filter(entry => entry.isFile())
    .map(entry => directory === '.' ? entry.name : portablePath(join(directory, entry.name)));
  if (!recursive) return files.sort();
  const nested = await Promise.all(entries
    .filter(entry => entry.isDirectory())
    .map(entry => listFiles(repoRoot, directory === '.' ? entry.name : portablePath(join(directory, entry.name)), true)));
  return [...files, ...nested.flat()].sort();
}

function fingerprintsFor(content: string): string[] {
  return LEGACY_TEXT_PATTERNS.filter(entry => entry.pattern.test(content)).map(entry => entry.fingerprint);
}

function buildShellItem(path: string): MigrationInventoryItem | null {
  const name = basename(path);
  const known = getKnownLegacyScript(path);
  if (known) {
    return {
      id: `shell-${path}`,
      category: 'shell-helper',
      path,
      confidence: 'high',
      fingerprints: [known.fingerprint, `legacy helper group: ${known.category}`],
      proposedAction: 'remove',
      reason: 'Known legacy helper can be removed later when cleanup is explicitly requested; this command only reports the plan.',
      requiresConfirmation: true,
    };
  }
  if (/^gh-[\w-]+\.sh$/i.test(name)) {
    return {
      id: `shell-${path}`,
      category: 'shell-helper',
      path,
      confidence: 'review-required',
      fingerprints: ['helper-like gh-*.sh filename'],
      proposedAction: 'preserve',
      reason: 'Helper-like script is not a known legacy helper fingerprint, so Executor preserves it for human review.',
      requiresConfirmation: true,
    };
  }
  return null;
}

async function collectShellHelpers(repoRoot: string): Promise<MigrationInventoryItem[]> {
  const paths = [...await listFiles(repoRoot, '.', false), ...await listFiles(repoRoot, 'scripts', true)];
  return sortByPath(paths.map(buildShellItem).filter((item): item is MigrationInventoryItem => item !== null));
}

async function collectProjectCommands(repoRoot: string): Promise<MigrationInventoryItem[]> {
  const paths = (await listFiles(repoRoot, join('.opencode', 'commands'), false)).filter(path => path.endsWith('.md'));
  const items: (MigrationInventoryItem | null)[] = await Promise.all(paths.map(async path => {
    const content = await readTextIfPresent(join(repoRoot, path));
    const fingerprints = content && hasLegacyInstructionReference(content) ? fingerprintsFor(content) : [];
    if (fingerprints.length === 0) return null;
    return {
      id: `project-command-${path}`,
      category: 'project-command' as const,
      path,
      confidence: 'medium' as const,
      fingerprints,
      proposedAction: 'replace' as const,
      reason: 'Project command references legacy helper behavior and can be replaced by package-backed Executor command projection when replacement is explicitly requested.',
      requiresConfirmation: true,
    };
  }));
  return sortByPath(items.filter(isMigrationInventoryItem));
}

async function collectInstructionBlocks(repoRoot: string): Promise<MigrationInventoryItem[]> {
  const items: (MigrationInventoryItem | null)[] = await Promise.all(['AGENTS.md', 'CLAUDE.md'].map(async path => {
    const content = await readTextIfPresent(join(repoRoot, path));
    if (!content) return null;
    const fingerprints = hasLegacyInstructionReference(content) ? fingerprintsFor(content) : [];
    if (fingerprints.length === 0) return null;
    return {
      id: `instruction-${path}`,
      category: 'instruction-block' as const,
      path,
      confidence: 'medium' as const,
      fingerprints,
      proposedAction: 'replace' as const,
      reason: 'Instruction file contains legacy helper references; this command reports the replacement plan without rewriting user-authored content.',
      requiresConfirmation: true,
    };
  }));
  return sortByPath(items.filter(isMigrationInventoryItem));
}

async function collectWorkflowDocs(repoRoot: string): Promise<MigrationInventoryItem[]> {
  const candidates = (await listFiles(repoRoot, 'docs', false)).filter(path => /workflow|gh-workflow/i.test(path) && path.endsWith('.md'));
  const items: (MigrationInventoryItem | null)[] = await Promise.all(candidates.map(async path => {
    const content = await readTextIfPresent(join(repoRoot, path));
    const fingerprints = content && hasLegacyInstructionReference(content) ? fingerprintsFor(content) : [];
    if (fingerprints.length === 0 && !/gh-workflow\.md$/i.test(path)) return null;
    return {
      id: `workflow-doc-${path}`,
      category: 'workflow-doc' as const,
      path,
      confidence: fingerprints.length > 0 ? 'medium' as const : 'review-required' as const,
      fingerprints: fingerprints.length > 0 ? fingerprints : ['workflow documentation filename'],
      proposedAction: fingerprints.length > 0 ? 'replace' as const : 'preserve' as const,
      reason: fingerprints.length > 0
        ? 'Workflow documentation describes legacy helper behavior and should be replaced by Executor command guidance when replacement is explicitly requested.'
        : 'Workflow documentation filename looks relevant but content is not a known legacy fingerprint, so Executor preserves it for review.',
      requiresConfirmation: true,
    };
  }));
  return sortByPath(items.filter(isMigrationInventoryItem));
}

function preservationPlan(config: Config): MigrationPreservationPlan {
  return {
    priorityLabels: [...config.priorityLabels],
    statusLabels: [...config.statusLabels],
    componentLabels: [...config.componentLabels],
    blockerMetadata: 'preserve',
    sequenceMetadata: 'preserve',
    milestoneAssignments: 'preserve',
    milestoneOrdering: { ...config.milestoneOrdering, order: [...config.milestoneOrdering.order] },
    activeIssueState: 'preserve',
    branchState: 'preserve',
    gitHistory: 'preserve',
    githubState: 'preserve',
  };
}

function conflictsFor(inventory: MigrationInventoryItem[], instructionUpdates: MigrationInstructionUpdate[], pathConflicts: MigrationConflict[]): MigrationConflict[] {
  const inventoryConflicts = inventory.filter(item => item.confidence === 'review-required' || item.category === 'instruction-block').map(item => ({
    path: item.path,
    reason: item.confidence === 'review-required'
      ? 'Executor cannot prove this path is safe to rewrite or remove from fingerprints alone.'
      : 'Instruction files may contain user-authored guidance and require explicit confirmation before replacement.',
    nextAction: 'Review the path and request cleanup or replacement only after confirming the exact target.',
  }));
  const updateConflicts = instructionUpdates.filter(update => update.status === 'blocked').map(update => ({
    path: update.path,
    reason: update.reason,
    nextAction: update.forceRequired ? 'Rerun with --instruction for the exact file and --force after reviewing the planned replacements.' : 'Resolve the selected path before applying migration.',
  }));
  return sortByPath([...inventoryConflicts, ...updateConflicts, ...pathConflicts]);
}

function cleanupConflicts(cleanupCandidates: MigrationInventoryItem[], cleanupRequested: boolean, forced: boolean): MigrationConflict[] {
  if (!cleanupRequested || forced) return [];
  return cleanupCandidates.filter(item => item.confidence !== 'high').map(item => ({
    path: item.path,
    reason: 'Cleanup path is not a known legacy helper fingerprint.',
    nextAction: 'Remove this path from cleanup selection or rerun with --force after reviewing the exact file.',
  }));
}

function confirmationsFor(inventory: MigrationInventoryItem[]): MigrationConfirmation[] {
  return sortByPath(inventory.filter(item => item.requiresConfirmation).map(item => ({
    path: item.path,
    reason: item.reason,
    requiredFor: item.proposedAction,
  })));
}

function warningsFor(inventory: MigrationInventoryItem[], configErrors: ValidationError[], instructionUpdates: MigrationInstructionUpdate[], mode: MigrationMode, cleanup: boolean, installWrappers: boolean): string[] {
  const warnings: string[] = [];
  const reviewRequired = inventory.filter(item => item.confidence === 'review-required');
  if (reviewRequired.length > 0) warnings.push(`Preserving review-required paths until explicitly confirmed: ${reviewRequired.map(item => item.path).join(', ')}.`);
  const instructions = inventory.filter(item => item.category === 'instruction-block');
  if (instructions.length > 0 && mode !== 'apply-result') warnings.push(`Instruction files are reported only; no legacy references were rewritten: ${instructions.map(item => item.path).join(', ')}.`);
  const blockedUpdates = instructionUpdates.filter(update => update.status === 'blocked');
  if (blockedUpdates.length > 0) warnings.push(`Instruction migration is blocked for: ${blockedUpdates.map(update => update.path).join(', ')}.`);
  if (cleanup && installWrappers) warnings.push('Compatibility wrappers are planned, so cleanup preserves wrapper target paths instead of removing them.');
  if (configErrors.length > 0) warnings.push('Trusted config could not be fully loaded, so preservation defaults are reported with config errors.');
  if (inventory.length === 0) warnings.push('No legacy Executor helper fingerprints were detected.');
  return warnings;
}

function mergeCleanupCandidates(baseCandidates: MigrationInventoryItem[], selectedPaths: string[]): MigrationInventoryItem[] {
  const candidates = new Map(baseCandidates.map(item => [item.path, item]));
  for (const path of selectedPaths) {
    if (candidates.has(path)) continue;
    candidates.set(path, explicitCleanupItem(path, getKnownLegacyScript(path)));
  }
  return sortByPath([...candidates.values()]);
}

function wrapperInstallItem(item: MigrationInventoryItem): MigrationInventoryItem {
  const script = getKnownLegacyScript(item.path);
  return {
    ...item,
    proposedAction: 'replace',
    reason: `Compatibility wrapper will delegate to ${script?.replacementCommand ?? 'the matching Executor command'} when wrapper installation is explicitly applied.`,
  };
}

async function prepareMigration(options: MigrationOptions = {}): Promise<MigrationPlanBuild> {
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = getRepoRoot(cwd);
  const loaded = await loadConfigFile(cwd);
  const config = loaded.ok && loaded.config ? loaded.config : getDefaults();
  const configErrors = loaded.ok ? [] : loaded.errors;
  const dryRun = options.dryRun ?? false;
  const apply = options.apply ?? false;
  const forced = options.force ?? false;
  const cleanup = options.cleanup ?? false;
  const installWrappers = options.installWrappers ?? false;
  const selected = repoRoot ? selectedInstructionPaths(repoRoot, options.instructionPaths) : { paths: [], conflicts: [] };
  const selectedLegacy = repoRoot ? selectedLegacyPaths(repoRoot, options.legacyPaths) : { paths: [], conflicts: [] };

  const inventory = repoRoot ? sortByPath([
    ...await collectShellHelpers(repoRoot),
    ...await collectProjectCommands(repoRoot),
    ...await collectInstructionBlocks(repoRoot),
    ...await collectWorkflowDocs(repoRoot),
  ]) : [];

  const instructionPlan = repoRoot ? await collectInstructionUpdates({ repoRoot, config, force: forced, selectedPaths: selected.paths }) : { updates: [], writes: [] };
  const plannedFileChanges = sortByPath(inventory.filter(item => item.proposedAction === 'replace'));
  const baseCleanupCandidates = sortByPath(inventory.filter(item => item.proposedAction === 'remove'));
  const wrapperInstalls = installWrappers ? sortByPath(inventory.filter(item => item.category === 'shell-helper' && item.confidence === 'high').map(wrapperInstallItem)) : [];
  const wrapperPaths = new Set(wrapperInstalls.map(item => item.path));
  const cleanupCandidates = cleanup
    ? mergeCleanupCandidates(baseCleanupCandidates, selectedLegacy.paths).filter(item => !wrapperPaths.has(item.path))
    : baseCleanupCandidates;
  const skippedFiles = sortByPath(inventory.filter(item => item.proposedAction === 'preserve' || item.proposedAction === 'skip'));
  const blockedInstructionUpdates = instructionPlan.updates.some(update => update.status === 'blocked');
  const mode: MigrationMode = apply ? dryRun ? 'apply-plan' : 'apply-result' : 'audit-plan';
  const cleanupBlocks = cleanupConflicts(cleanupCandidates, cleanup, forced);
  const conflicts = conflictsFor(inventory, instructionPlan.updates, [...selected.conflicts, ...selectedLegacy.conflicts, ...cleanupBlocks]);
  const warnings = warningsFor(inventory, configErrors, instructionPlan.updates, mode, cleanup, installWrappers);
  if (!repoRoot) warnings.unshift('Not inside a git repository; migration inventory requires a repository root.');
  const blockedCleanup = cleanupBlocks.length > 0 || selectedLegacy.conflicts.length > 0;
  const nextCommand = blockedInstructionUpdates
    ? 'Review blocked instruction paths, then rerun with explicit --instruction and --force when safe.'
    : blockedCleanup
      ? 'Review blocked cleanup paths, then rerun with exact --path values and --force only when safe.'
      : installWrappers && !apply
        ? 'Run `aie migrate legacy --install-wrappers --apply --dry-run` to review compatibility wrapper writes before applying them.'
        : cleanup && !apply
          ? 'Run `aie migrate legacy --cleanup --apply --dry-run` to review cleanup before removing files.'
          : instructionPlan.updates.some(update => update.status === 'planned') && !apply
            ? 'Run `aie migrate legacy --apply --dry-run` to review instruction updates before writing files.'
            : inventory.length > 0 ? 'Review the plan before requesting explicit cleanup or replacement.' : 'No legacy migration action is needed.';
  const writes: PlannedMigrationWrite[] = [
    ...instructionPlan.writes.map((write: PlannedWrite) => ({ ...write, executable: false })),
    ...(repoRoot && installWrappers ? wrapperInstalls.map(item => wrapperWriteFor(repoRoot, item)).filter((write): write is PlannedMigrationWrite => write !== null) : []),
  ];
  const removals = repoRoot && cleanup ? cleanupCandidates.map(item => cleanupRemovalFor(repoRoot, item)).filter((removal): removal is PlannedRemoval => removal !== null) : [];

  return {
    plan: {
      ok: repoRoot !== null && configErrors.length === 0 && !blockedInstructionUpdates && selected.conflicts.length === 0 && !blockedCleanup,
      command: 'migrate legacy',
      dryRun,
      apply,
      forced,
      cleanup,
      installWrappers,
      repoRoot,
      mode,
      inventory,
      plannedFileChanges,
      instructionUpdates: instructionPlan.updates,
      wrapperInstalls,
      cleanupCandidates,
      skippedFiles,
      completedChanges: [],
      conflicts,
      warnings,
      confirmations: confirmationsFor(inventory),
      preservation: preservationPlan(config),
      configErrors,
      nextCommand,
    },
    writes,
    removals,
  };
}

export async function buildMigrationPlan(options: MigrationOptions = {}): Promise<MigrationPlan> {
  return (await prepareMigration(options)).plan;
}

export async function runMigration(options: MigrationOptions = {}): Promise<MigrationPlan> {
  const built = await prepareMigration(options);
  const plan = built.plan;
  if (!plan.ok || !plan.apply || plan.dryRun) return plan;
  const completedChanges: string[] = [];
  const instructionUpdates = plan.instructionUpdates.map(update => ({ ...update }));
  const conflicts = [...plan.conflicts];
  for (const write of built.writes) {
    const relativeWritePath = plan.repoRoot ? relativePath(plan.repoRoot, write.path) : write.path;
    const update = instructionUpdates.find(item => item.path === relativeWritePath);
    try {
      await writeFileSafely(write.path, write.content);
      if (update) update.status = 'completed';
      completedChanges.push(write.executable ? `installed wrapper ${relativeWritePath}` : `updated ${relativeWritePath}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (update) {
        update.status = 'failed';
        update.reason = `Write failed: ${message}`;
      }
      conflicts.push({ path: relativeWritePath, reason: `Write failed: ${message}`, nextAction: 'Fix the write failure and rerun migration.' });
      continue;
    }
    if (!write.executable) continue;
    try {
      await chmod(write.path, 0o755);
      completedChanges.push(`made executable ${relativeWritePath}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      conflicts.push({ path: relativeWritePath, reason: `Executable mode update failed: ${message}`, nextAction: 'Fix the file mode failure and rerun wrapper installation.' });
    }
  }
  for (const removal of built.removals) {
    const relativeRemovalPath = plan.repoRoot ? relativePath(plan.repoRoot, removal.path) : removal.path;
    try {
      await rm(removal.path, { force: false });
      completedChanges.push(`removed ${relativeRemovalPath}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      conflicts.push({ path: relativeRemovalPath, reason: `Removal failed: ${message}`, nextAction: 'Fix the removal failure and rerun cleanup.' });
    }
  }
  const failed = instructionUpdates.filter(update => update.status === 'failed');
  const failedChanges = conflicts.length > plan.conflicts.length;
  return {
    ...plan,
    ok: failed.length === 0 && !failedChanges,
    instructionUpdates,
    completedChanges,
    conflicts,
    nextCommand: failed.length === 0 && !failedChanges ? 'Review the local diff, then run the relevant verification before committing.' : 'Fix failed migration file operations before continuing migration.',
  };
}

export function buildMigrationMap(): MigrationMap {
  return { ok: true, command: 'migrate map', mappings: legacyCommandMappings(), nextCommand: 'Run `aie migrate legacy --dry-run` in a repository to inspect detected legacy paths.' };
}

export function formatMigrationMap(map: MigrationMap): string {
  const lines = ['Legacy command map'];
  for (const mapping of map.mappings) {
    lines.push(`- ${mapping.legacyCategory}: ${mapping.executorCommands.join(', ')} — ${mapping.description}`);
  }
  lines.push('', `Next action: ${map.nextCommand}`);
  return lines.join('\n');
}
