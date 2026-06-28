import type { Config } from './config/index.js';
import type { ReviewLanePolicy } from './core/policy.js';
import { type LocalReviewLaneId, type LocalReviewProfile, requiredLocalReviewLanes } from './local_review_evidence.js';

const DEFAULT_MAX_ACTIVE_FOCUSES = 5;

const FOCUS_LANE_IDS = new Set<LocalReviewLaneId>([
  'task-record-compliance',
  'issue-compliance',
  'code-quality',
  'security',
  'performance',
  'data-database',
  'concurrency-resource',
  'error-observability',
  'tests-quality',
  'api-contract-compatibility',
  'docs-instructions',
  'ui-ux-accessibility',
  'release-ci-supply-chain',
  'manual-qa',
  'final-gate',
]);

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function simpleGlobMatch(path: string, pattern: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedPattern = normalizePath(pattern);
  if (normalizedPattern === '**' || normalizedPattern === '**/*') return true;
  let regex = '';
  for (let index = 0; index < normalizedPattern.length;) {
    const char = normalizedPattern[index];
    if (normalizedPattern.startsWith('**/', index)) {
      regex += '(?:.*/)?';
      index += 3;
      continue;
    }
    if (normalizedPattern.startsWith('**', index)) {
      regex += '.*';
      index += 2;
      continue;
    }
    if (char === '*') regex += '[^/]*';
    else if (char === '?') regex += '[^/]';
    else regex += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    index += 1;
  }
  return new RegExp(`^${regex}$`).test(normalizedPath);
}

function pathMatchesAny(changedPaths: readonly string[], patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false;
  return changedPaths.some(path => patterns.some(pattern => simpleGlobMatch(path, pattern)));
}

function readFocusId(lane: ReviewLanePolicy): LocalReviewLaneId | null {
  return FOCUS_LANE_IDS.has(lane.id as LocalReviewLaneId) ? lane.id as LocalReviewLaneId : null;
}

function laneActivated(lane: ReviewLanePolicy, changedPaths: readonly string[]): boolean {
  if (lane.required === 'always') return true;
  if (lane.required === 'when-matched') return pathMatchesAny(changedPaths, lane.match);
  return false;
}

export function activeLocalReviewFocuses(input: {
  profile: LocalReviewProfile;
  lanes: readonly ReviewLanePolicy[];
  changedPaths?: readonly string[];
  maxActive?: number;
}): readonly LocalReviewLaneId[] {
  const changedPaths = input.changedPaths ?? [];
  const maxActive = input.maxActive ?? DEFAULT_MAX_ACTIVE_FOCUSES;
  if (input.lanes.length > 0) {
    const entries = input.lanes
      .map(lane => ({ lane, id: readFocusId(lane) }))
      .filter((entry): entry is { lane: ReviewLanePolicy; id: LocalReviewLaneId } => entry.id !== null);
    const always = [...new Set(entries.filter(entry => entry.lane.required === 'always').map(entry => entry.id))];
    const matched = [...new Set(entries
      .filter(entry => entry.lane.required === 'when-matched' && laneActivated(entry.lane, changedPaths))
      .map(entry => entry.id)
      .filter(id => !always.includes(id)))];
    if (always.length > 0 || matched.length > 0) {
      const matchedRoom = Math.max(0, maxActive - always.length);
      return [...always, ...matched.slice(0, matchedRoom)];
    }
  }
  return requiredLocalReviewLanes(input.profile);
}

export function activeLocalReviewFocusesForConfig(config: Config, changedPaths?: readonly string[]): readonly LocalReviewLaneId[] {
  const profile = config.reviewProfile === 'remote-compatible' ? 'local-standard' : config.reviewProfile;
  return activeLocalReviewFocuses({
    profile,
    lanes: config.reviewLanes,
    changedPaths,
  });
}
