import { readdir } from 'fs/promises';
import { join } from 'path';
import type { Config } from '../config/index.js';
import { getDefaults } from '../config/index.js';
import { getInstructionTargetPaths } from '../agent_hosts.js';
import { categorizeLegacyPath, hasLegacyInstructionReference, type LegacyCategory } from '../legacy.js';
import { readTextIfPresent } from '../managed_file.js';
import type { LegacyChoice, LegacyState } from './types.js';

const LEGACY_CHOICES: LegacyChoice[] = ['leave-untouched', 'install-alongside', 'install-compatibility-wrappers', 'cleanup-and-replace', 'defer-to-migration'];
export const LEGACY_CHOICE_TEXT = 'leave untouched, install alongside managed Executor files, install compatibility wrappers, clean up and replace known helpers, or defer to migration';
const LEGACY_CATEGORY_ORDER: LegacyCategory[] = ['queue', 'labels', 'lifecycle', 'dependencies', 'pull-request', 'gates', 'audit', 'review', 'instructions'];

const LEGACY_CATEGORY_LABELS: Record<LegacyCategory, string> = {
  queue: 'queue helper',
  labels: 'label helper',
  lifecycle: 'issue lifecycle helper',
  dependencies: 'dependency helper',
  'pull-request': 'pull request helper',
  gates: 'gate helper',
  audit: 'audit helper',
  review: 'review helper',
  instructions: 'legacy instruction content',
};

function categorizeLegacyInstruction(content: string): LegacyCategory | null {
  return hasLegacyInstructionReference(content) ? 'instructions' : null;
}

async function listLegacyScripts(repoRoot: string, directory: string, recursive: boolean): Promise<string[]> {
  try {
    const names = await readdir(join(repoRoot, directory), { withFileTypes: true });
    const sortedNames = [...names].sort((left, right) => left.name.localeCompare(right.name));
    const files = sortedNames
      .filter(entry => entry.isFile() && /^gh-[\w-]+\.sh$/i.test(entry.name))
      .map(entry => directory === '.' ? entry.name : join(directory, entry.name))
      .sort();
    if (!recursive) return files;
    const nested = await Promise.all(sortedNames
      .filter(entry => entry.isDirectory())
      .map(entry => listLegacyScripts(repoRoot, join(directory, entry.name), true)));
    return [...files, ...nested.flat()].sort();
  } catch (err: unknown) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : undefined;
    if (code === 'ENOENT') return [];
    throw err;
  }
}

function legacyActionFor(category: LegacyCategory, config: Config): LegacyChoice {
  if (category === 'instructions') return 'defer-to-migration';
  if (config.migration.compatibilityWrappers || config.migration.legacyScripts === 'install-wrappers') return 'install-compatibility-wrappers';
  if (config.migration.cleanupKnownHelpers || config.migration.legacyScripts === 'cleanup') return 'cleanup-and-replace';
  return 'install-alongside';
}

function legacyNextCommand(action: LegacyChoice): string {
  if (action === 'install-compatibility-wrappers') return 'Run `aie migrate legacy --install-wrappers --dry-run` to review compatibility wrapper installation.';
  if (action === 'cleanup-and-replace') return 'Run `aie migrate legacy --cleanup --dry-run` to review known helper cleanup before applying it.';
  if (action === 'defer-to-migration') return 'Run `aie migrate legacy --dry-run` to review instruction replacement, wrapper, and cleanup choices.';
  if (action === 'leave-untouched') return 'Leave existing legacy files unchanged and rerun init later if managed Executor files should be installed.';
  return 'Continue init; Executor managed files install alongside existing legacy files without deleting them.';
}

function legacyActionText(action: LegacyChoice): string {
  if (action === 'install-alongside') return 'This plan installs Executor alongside and leaves existing files untouched.';
  if (action === 'install-compatibility-wrappers') return 'Configured migration policy points to compatibility wrapper installation through `aie migrate legacy`; init still leaves existing files untouched.';
  if (action === 'cleanup-and-replace') return 'Configured migration policy points to known helper cleanup through `aie migrate legacy`; init does not delete files directly.';
  if (action === 'leave-untouched') return 'Configured migration policy leaves legacy files untouched and does not add managed Executor files.';
  return 'This init plan defers instruction replacement to migration unless --force is used to add managed Executor sections intentionally.';
}

export async function detectLegacyState(repoRoot: string, config: Config = getDefaults()): Promise<LegacyState[]> {
  const byCategory = new Map<LegacyCategory, Set<string>>();
  const add = (category: LegacyCategory, path: string): void => {
    const paths = byCategory.get(category) ?? new Set<string>();
    paths.add(path);
    byCategory.set(category, paths);
  };

  for (const path of [...await listLegacyScripts(repoRoot, '.', false), ...await listLegacyScripts(repoRoot, 'scripts', true)]) {
    add(categorizeLegacyPath(path), path);
  }

  for (const path of getInstructionTargetPaths()) {
    const content = await readTextIfPresent(join(repoRoot, path));
    if (content && categorizeLegacyInstruction(content)) add('instructions', path);
  }

  return [...byCategory.entries()].sort(([left], [right]) => LEGACY_CATEGORY_ORDER.indexOf(left) - LEGACY_CATEGORY_ORDER.indexOf(right)).map(([category, paths]) => {
    const action = legacyActionFor(category, config);
    const sortedPaths = [...paths].sort();
    const reason = category === 'instructions'
      ? `Detected ${LEGACY_CATEGORY_LABELS[category]} in ${sortedPaths.join(', ')}. Choices: ${LEGACY_CHOICE_TEXT}. ${legacyActionText(action)}`
      : `Detected ${LEGACY_CATEGORY_LABELS[category]} files in ${sortedPaths.join(', ')}. Choices: ${LEGACY_CHOICE_TEXT}. ${legacyActionText(action)}`;
    return { category, paths: sortedPaths, action, choices: [...LEGACY_CHOICES], reason, nextCommand: legacyNextCommand(action) };
  });
}
