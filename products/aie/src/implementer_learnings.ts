import { createHash } from 'node:crypto';
import { pathsTouchPatterns } from './risk_cards/glob.js';
import {
  loadReviewLearnings,
  REVIEW_LEARNINGS_RELATIVE_PATH,
  type ReviewLearningEntry,
} from './review_learnings.js';

export const IMPLEMENTER_LEARNINGS_CAP = 5;
export const IMPLEMENTER_LEARNINGS_FRAGMENT_ID = 'repo-configured/review-learnings';

export interface ImplementerLearning {
  id: string;
  title: string;
  implementerFace: string;
  recordedAt: string;
  trust: 'repo-doc';
  source: 'repo-configured';
}

export interface ImplementerLearningsSection {
  status: 'ok' | 'missing' | 'invalid';
  summary: string;
  trust: 'repo-doc';
  source: 'repo-configured';
  fragmentId: typeof IMPLEMENTER_LEARNINGS_FRAGMENT_ID;
  sha256: string | null;
  entries: ImplementerLearning[];
  omitted: number;
}

export interface ImplementerLearningsSelectionInput {
  repoRoot?: string;
  paths?: readonly string[];
  maxEntries?: number;
}

function emptySection(
  status: ImplementerLearningsSection['status'],
  summary: string,
): ImplementerLearningsSection {
  return {
    status,
    summary,
    trust: 'repo-doc',
    source: 'repo-configured',
    fragmentId: IMPLEMENTER_LEARNINGS_FRAGMENT_ID,
    sha256: null,
    entries: [],
    omitted: 0,
  };
}

function matchesScope(entry: ReviewLearningEntry, paths: readonly string[]): boolean {
  if (entry.paths.length === 0) return true;
  return pathsTouchPatterns(paths, entry.paths);
}

function toImplementerLearning(entry: ReviewLearningEntry): ImplementerLearning {
  const face = entry.guidance.trim() !== '' ? entry.guidance.trim() : entry.message.trim();
  return {
    id: entry.id,
    title: entry.message.trim(),
    implementerFace: face,
    recordedAt: entry.recordedAt,
    trust: 'repo-doc',
    source: 'repo-configured',
  };
}

function digestEntries(entries: readonly ImplementerLearning[]): string {
  return createHash('sha256').update(JSON.stringify(entries.map(entry => ({
    id: entry.id,
    title: entry.title,
    implementerFace: entry.implementerFace,
    recordedAt: entry.recordedAt,
  })))).digest('hex');
}

export function selectImplementerLearnings(input: ImplementerLearningsSelectionInput = {}): ImplementerLearningsSection {
  const maxEntries = input.maxEntries ?? IMPLEMENTER_LEARNINGS_CAP;
  if (!Number.isInteger(maxEntries) || maxEntries < 0) {
    throw new Error(`maxEntries must be a non-negative integer; got ${String(input.maxEntries)}.`);
  }
  if (!input.repoRoot || input.repoRoot.trim() === '') {
    return emptySection('missing', 'No Executor learnings file was found; no repo-configured implementer guidance is available.');
  }

  let file;
  try {
    file = loadReviewLearnings(input.repoRoot);
  } catch {
    return emptySection('invalid', 'Executor learnings file is invalid; no repo-configured implementer guidance was injected.');
  }
  if (!file) {
    return emptySection('missing', 'No Executor learnings file was found; no repo-configured implementer guidance is available.');
  }

  const scopePaths = input.paths ?? [];
  const accepted = file.entries
    .filter(entry => entry.disposition === 'accepted')
    .filter(entry => matchesScope(entry, scopePaths))
    .sort((left, right) => {
      const byTime = Date.parse(right.recordedAt) - Date.parse(left.recordedAt);
      if (byTime !== 0) return byTime;
      return left.id.localeCompare(right.id);
    });
  const selected = accepted.slice(0, maxEntries).map(toImplementerLearning);
  const omitted = Math.max(0, accepted.length - selected.length);
  if (selected.length === 0) {
    return {
      ...emptySection('ok', 'No accepted learnings match this issue scope.'),
      omitted,
    };
  }
  return {
    status: 'ok',
    summary: omitted === 0
      ? `Injected ${selected.length} accepted repo-configured learning(s).`
      : `Injected ${selected.length} accepted repo-configured learning(s); ${omitted} older matching entries omitted.`,
    trust: 'repo-doc',
    source: 'repo-configured',
    fragmentId: IMPLEMENTER_LEARNINGS_FRAGMENT_ID,
    sha256: digestEntries(selected),
    entries: selected,
    omitted,
  };
}

export function formatImplementerLearningsLines(section: ImplementerLearningsSection, indent = '  '): string[] {
  const heading = `${indent}Repo-configured learnings (repo-doc; not built-in policy):`;
  if (section.status === 'invalid') {
    return [`${heading} file is invalid; no entries were injected.`];
  }
  if (section.status === 'missing' || section.entries.length === 0) {
    return [`${heading} none matching.`];
  }
  const lines = [heading];
  for (const entry of section.entries) {
    lines.push(`${indent}  - ${entry.id}: ${entry.title}`);
    if (entry.implementerFace !== entry.title) {
      lines.push(`${indent}    ${entry.implementerFace}`);
    }
  }
  if (section.omitted > 0) {
    lines.push(`${indent}  (+${section.omitted} older matching entries omitted)`);
  }
  return lines;
}

export { REVIEW_LEARNINGS_RELATIVE_PATH };
