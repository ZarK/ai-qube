export type LegacyCategory = 'queue' | 'labels' | 'lifecycle' | 'dependencies' | 'pull-request' | 'gates' | 'audit' | 'review' | 'instructions';
export type LegacyCommandMappingCategory =
  | 'queue and next issue selection'
  | 'label setup and status label repair'
  | 'issue start'
  | 'issue view'
  | 'issue switch'
  | 'issue completion'
  | 'dependency inspection'
  | 'pull request review gate'
  | 'pull request body draft'
  | 'gate guidance'
  | 'manual UI audit guidance'
  | 'review-agent prompt';

export interface LegacyCommandMapping {
  id: string;
  legacyCategory: LegacyCommandMappingCategory;
  executorCommands: string[];
  description: string;
}

export interface KnownLegacyScript {
  filename: string;
  category: Exclude<LegacyCategory, 'instructions'>;
  fingerprint: string;
  replacementCommand: string;
}

const KNOWN_LEGACY_SCRIPTS: KnownLegacyScript[] = [
  { filename: 'gh-priority-order.sh', category: 'queue', fingerprint: 'known queue ordering helper filename', replacementCommand: 'aie queue' },
  { filename: 'gh-queue.sh', category: 'queue', fingerprint: 'known queue helper filename', replacementCommand: 'aie queue' },
  { filename: 'gh-next.sh', category: 'queue', fingerprint: 'known next-issue helper filename', replacementCommand: 'aie next' },
  { filename: 'gh-bootstrap-labels.sh', category: 'labels', fingerprint: 'known label setup helper filename', replacementCommand: 'aie labels setup' },
  { filename: 'gh-labels.sh', category: 'labels', fingerprint: 'known label helper filename', replacementCommand: 'aie labels setup' },
  { filename: 'gh-issue-start.sh', category: 'lifecycle', fingerprint: 'known issue start helper filename', replacementCommand: 'aie start <issue>' },
  { filename: 'gh-start.sh', category: 'lifecycle', fingerprint: 'known issue start helper filename', replacementCommand: 'aie start <issue>' },
  { filename: 'gh-issue-view.sh', category: 'lifecycle', fingerprint: 'known issue view helper filename', replacementCommand: 'aie view <issue>' },
  { filename: 'gh-view.sh', category: 'lifecycle', fingerprint: 'known issue view helper filename', replacementCommand: 'aie view <issue>' },
  { filename: 'gh-issue-switch.sh', category: 'lifecycle', fingerprint: 'known issue switch helper filename', replacementCommand: 'aie switch <issue>' },
  { filename: 'gh-switch.sh', category: 'lifecycle', fingerprint: 'known issue switch helper filename', replacementCommand: 'aie switch <issue>' },
  { filename: 'gh-issue-complete.sh', category: 'lifecycle', fingerprint: 'known issue complete helper filename', replacementCommand: 'aie complete <issue>' },
  { filename: 'gh-complete.sh', category: 'lifecycle', fingerprint: 'known issue complete helper filename', replacementCommand: 'aie complete <issue>' },
  { filename: 'gh-workflow.sh', category: 'lifecycle', fingerprint: 'known issue workflow helper filename', replacementCommand: 'aie start next' },
  { filename: 'gh-issue-deps.sh', category: 'dependencies', fingerprint: 'known dependency helper filename', replacementCommand: 'aie deps blockers <issue>' },
  { filename: 'gh-deps.sh', category: 'dependencies', fingerprint: 'known dependency helper filename', replacementCommand: 'aie deps blockers <issue>' },
  { filename: 'gh-pr-review-gate.sh', category: 'pull-request', fingerprint: 'known pull request review gate helper filename', replacementCommand: 'aie pr gate <pr>' },
  { filename: 'gh-pr-gate.sh', category: 'pull-request', fingerprint: 'known pull request gate helper filename', replacementCommand: 'aie pr gate <pr>' },
  { filename: 'gh-pr-body.sh', category: 'pull-request', fingerprint: 'known pull request body helper filename', replacementCommand: 'aie pr body <issue>' },
];

const LEGACY_COMMAND_MAPPINGS: LegacyCommandMapping[] = [
  { id: 'queue', legacyCategory: 'queue and next issue selection', executorCommands: ['aie queue', 'aie next', 'aie start next'], description: 'Inspect queue order, select the next issue, or start the next eligible issue.' },
  { id: 'labels', legacyCategory: 'label setup and status label repair', executorCommands: ['aie labels setup', 'aie deps fix'], description: 'Create Executor labels or reconcile ready and blocked issue status from live blockers.' },
  { id: 'issue-start', legacyCategory: 'issue start', executorCommands: ['aie start <issue>', 'aie start next'], description: 'Start a specific issue or the next eligible issue after repository safety checks.' },
  { id: 'issue-view', legacyCategory: 'issue view', executorCommands: ['aie view <issue>'], description: 'Show issue context, blockers, dependents, checklist, and next action.' },
  { id: 'issue-switch', legacyCategory: 'issue switch', executorCommands: ['aie switch <issue>'], description: 'Move active work between issues while keeping status labels consistent.' },
  { id: 'issue-complete', legacyCategory: 'issue completion', executorCommands: ['aie complete <issue>'], description: 'Complete post-merge issue state and unblock dependents.' },
  { id: 'dependencies', legacyCategory: 'dependency inspection', executorCommands: ['aie deps blockers <issue>', 'aie deps blocking <issue>', 'aie deps chain <issue>', 'aie deps ready', 'aie deps blocked', 'aie deps graph'], description: 'Inspect direct blockers, reverse blockers, dependency chains, ready issues, blocked issues, and dependency graphs.' },
  { id: 'pr-review', legacyCategory: 'pull request review gate', executorCommands: ['aie pr gate <pr>'], description: 'Request configured reviewers, wait when configured, and inspect review state.' },
  { id: 'pr-body', legacyCategory: 'pull request body draft', executorCommands: ['aie pr body <issue>'], description: 'Draft issue-closing pull request text with readiness details.' },
  { id: 'gates', legacyCategory: 'gate guidance', executorCommands: ['aie gates plan', 'aie gates status'], description: 'Plan configured verification gates and inspect recorded evidence without executing gates.' },
  { id: 'manual-audit', legacyCategory: 'manual UI audit guidance', executorCommands: ['aie audit ui <issue>'], description: 'Plan or prepare local manual UI audit evidence for user-facing changes.' },
  { id: 'review-agent', legacyCategory: 'review-agent prompt', executorCommands: ['aie review gate <issue>'], description: 'Render review-agent prompts and evidence expectations without invoking host-only reviewers.' },
];

const KNOWN_LEGACY_SCRIPT_BY_NAME = new Map(KNOWN_LEGACY_SCRIPTS.map(script => [script.filename, script]));

export const LEGACY_HELPER_REFERENCE_PATTERN = /\bgh-[\w-]+\.sh(?![\w.-])/i;

function legacyBasename(path: string): string {
  return path.split(/[\\/]/).at(-1)?.toLowerCase() ?? path.toLowerCase();
}

export function knownLegacyScripts(): KnownLegacyScript[] {
  return KNOWN_LEGACY_SCRIPTS.map(script => ({ ...script }));
}

export function legacyCommandMappings(): LegacyCommandMapping[] {
  return LEGACY_COMMAND_MAPPINGS.map(mapping => ({ ...mapping, executorCommands: [...mapping.executorCommands] }));
}

export function getKnownLegacyScript(path: string): KnownLegacyScript | null {
  const script = KNOWN_LEGACY_SCRIPT_BY_NAME.get(legacyBasename(path));
  return script ? { ...script } : null;
}

export function categorizeLegacyPath(path: string): Exclude<LegacyCategory, 'instructions'> {
  const normalized = legacyBasename(path);
  const known = KNOWN_LEGACY_SCRIPT_BY_NAME.get(normalized);
  if (known) return known.category;
  if (/label/.test(normalized)) return 'labels';
  if (/dep|block/.test(normalized)) return 'dependencies';
  if (/\bpr\b|pull/.test(normalized)) return 'pull-request';
  if (/gate/.test(normalized)) return 'gates';
  if (/review/.test(normalized)) return 'review';
  if (/audit|browser|screenshot/.test(normalized)) return 'audit';
  if (/start|complete|switch|view|issue|work/.test(normalized)) return 'lifecycle';
  return 'queue';
}

export function hasLegacyInstructionReference(content: string): boolean {
  return LEGACY_HELPER_REFERENCE_PATTERN.test(content) || /legacy issue workflow|legacy workflow helper/i.test(content);
}
