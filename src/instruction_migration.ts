import { isAbsolute, join, relative, resolve } from 'path';
import { Config } from './config';
import { renderAgentInstructions } from './init_content';
import { getAgentHostProfiles, getInstructionTargetPaths, hostIdsForInstructionPath } from './agent_hosts';
import { getKnownLegacyScript, hasLegacyInstructionReference } from './legacy';
import { hasManagedSection, planManagedUpdate, readTextIfPresent } from './managed_file';

export type MigrationInstructionOperation = 'replace-managed' | 'replace-references' | 'unchanged' | 'blocked';
export type MigrationInstructionStatus = 'planned' | 'completed' | 'skipped' | 'blocked' | 'failed';

export interface MigrationConflict {
  path: string;
  reason: string;
  nextAction: string;
}

export interface MigrationReferenceReplacement {
  legacyReference: string;
  executorCommand: string;
  occurrences: number;
}

export interface MigrationInstructionUpdate {
  path: string;
  operation: MigrationInstructionOperation;
  status: MigrationInstructionStatus;
  managedSection: boolean;
  selected: boolean;
  forceRequired: boolean;
  replacements: MigrationReferenceReplacement[];
  reason: string;
}

export interface PlannedWrite {
  path: string;
  content: string;
}

const LEGACY_REFERENCE_REPLACEMENT_PATTERN = /\b(?:[\w.-]+[\\/])*gh-[\w-]+\.sh(?![\w.-])/gi;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function addReplacement(replacements: Map<string, MigrationReferenceReplacement>, legacyReference: string, executorCommand: string): void {
  const key = `${legacyReference}\0${executorCommand}`;
  const existing = replacements.get(key);
  if (existing) {
    existing.occurrences += 1;
    return;
  }
  replacements.set(key, { legacyReference, executorCommand, occurrences: 1 });
}

function replaceKnownLegacyReferences(content: string): { content: string; replacements: MigrationReferenceReplacement[] } {
  const replacements = new Map<string, MigrationReferenceReplacement>();
  const updated = content.replace(LEGACY_REFERENCE_REPLACEMENT_PATTERN, legacyReference => {
    const known = getKnownLegacyScript(legacyReference);
    if (!known) return legacyReference;
    addReplacement(replacements, legacyReference, known.replacementCommand);
    return known.replacementCommand;
  });
  return { content: updated, replacements: [...replacements.values()].sort((left, right) => left.legacyReference.localeCompare(right.legacyReference)) };
}

export function selectedInstructionPaths(repoRoot: string, inputPaths: string[] | undefined): { paths: string[]; conflicts: MigrationConflict[] } {
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
        reason: 'Selected instruction path is outside the repository root.',
        nextAction: 'Select an instruction path inside the repository before applying migration.',
      });
      continue;
    }
    paths.add(relativeSelectedPath);
  }
  return { paths: [...paths].sort(), conflicts };
}

async function buildInstructionUpdate(input: {
  repoRoot: string;
  path: string;
  selected: boolean;
  force: boolean;
  config: Config;
}): Promise<{ update: MigrationInstructionUpdate; write?: PlannedWrite }> {
  const absolutePath = join(input.repoRoot, input.path);
  let existingContent: string | null;
  try {
    existingContent = await readTextIfPresent(absolutePath);
  } catch (err: unknown) {
    return {
      update: {
        path: input.path,
        operation: 'blocked',
        status: 'blocked',
        managedSection: false,
        selected: input.selected,
        forceRequired: false,
        replacements: [],
        reason: `Failed to read instruction file: ${errorMessage(err)}. Fix file permissions, then rerun migration.`,
      },
    };
  }
  if (existingContent === null) {
    return {
      update: {
        path: input.path,
        operation: 'blocked',
        status: 'blocked',
        managedSection: false,
        selected: input.selected,
        forceRequired: false,
        replacements: [],
        reason: 'Selected instruction file does not exist. Choose an existing instruction path before applying migration.',
      },
    };
  }

  const managedSection = hasManagedSection(existingContent);
  const hostIds = hostIdsForInstructionPath(input.path);
  const replaced = replaceKnownLegacyReferences(existingContent);
  if (managedSection && hostIds) {
    const update = planManagedUpdate({ existingContent, generatedBody: renderAgentInstructions(input.config, getAgentHostProfiles(hostIds)), allowAppend: true, force: input.force });
    const operation: MigrationInstructionOperation = update.operation === 'replace-managed' ? 'replace-managed' : update.operation === 'unchanged' ? 'unchanged' : 'blocked';
    const status: MigrationInstructionStatus = !update.ok ? 'blocked' : operation === 'unchanged' ? 'skipped' : 'planned';
    const instructionUpdate: MigrationInstructionUpdate = {
      path: input.path,
      operation,
      status,
      managedSection: true,
      selected: input.selected,
      forceRequired: !update.ok,
      replacements: replaced.replacements,
      reason: update.reason,
    };
    return update.ok && update.content !== null && operation !== 'unchanged'
      ? { update: instructionUpdate, write: { path: absolutePath, content: update.content } }
      : { update: instructionUpdate };
  }

  if (!input.selected) {
    return {
      update: {
        path: input.path,
        operation: 'blocked',
        status: 'blocked',
        managedSection,
        selected: false,
        forceRequired: true,
        replacements: replaced.replacements,
        reason: 'Instruction file is not managed by Executor. Select it with --instruction and rerun with --force to rewrite known legacy references.',
      },
    };
  }

  if (replaced.replacements.length === 0 || replaced.content === existingContent) {
    return {
      update: {
        path: input.path,
        operation: 'unchanged',
        status: 'skipped',
        managedSection,
        selected: true,
        forceRequired: false,
        replacements: [],
        reason: 'No known legacy helper references were found to replace.',
      },
    };
  }

  if (!input.force) {
    return {
      update: {
        path: input.path,
        operation: 'blocked',
        status: 'blocked',
        managedSection,
        selected: true,
        forceRequired: true,
        replacements: replaced.replacements,
        reason: 'Selected instruction file is unmanaged. Rerun with --force to replace known legacy helper references while preserving other content.',
      },
    };
  }

  const instructionUpdate: MigrationInstructionUpdate = {
    path: input.path,
    operation: 'replace-references',
    status: 'planned',
    managedSection,
    selected: true,
    forceRequired: false,
    replacements: replaced.replacements,
    reason: 'Known legacy helper references will be replaced with equivalent Executor commands while preserving other content.',
  };
  return { update: instructionUpdate, write: { path: absolutePath, content: replaced.content } };
}

export async function collectInstructionUpdates(input: {
  repoRoot: string;
  config: Config;
  force: boolean;
  selectedPaths: string[];
}): Promise<{ updates: MigrationInstructionUpdate[]; writes: PlannedWrite[] }> {
  const paths = new Set(input.selectedPaths);
  for (const candidatePath of getInstructionTargetPaths()) {
    try {
      const content = await readTextIfPresent(join(input.repoRoot, candidatePath));
      if (content && hasManagedSection(content) && hasLegacyInstructionReference(content)) paths.add(candidatePath);
    } catch {
      paths.add(candidatePath);
    }
  }
  const planned = await Promise.all([...paths].sort().map(path => buildInstructionUpdate({
    repoRoot: input.repoRoot,
    path,
    selected: input.selectedPaths.includes(path),
    force: input.force,
    config: input.config,
  })));
  return {
    updates: planned.map(item => item.update),
    writes: planned.flatMap(item => item.write ? [item.write] : []),
  };
}
