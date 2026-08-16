import type { Config } from './config/index.js';
import type { ReviewLanePolicy, ReviewModelTierId } from './core/policy.js';
import { type CarryForwardScope, type LocalReviewLaneId, type LocalReviewProfile, requiredLocalReviewLanes } from './local_review_evidence.js';
import { pathsTouchPatterns as sharedPathsTouchPatterns, simpleGlobMatch } from './risk_cards/glob.js';

const DEFAULT_MAX_ACTIVE_FOCUSES = 6;

/** Fixed one-line digest per lane: what the lane hunts for. Shared by the start/view brief and the pr gate self-check. */
export const LANE_HEURISTIC_DIGESTS: Record<LocalReviewLaneId, string> = {
  'task-record-compliance': 'Durable task records match the work actually performed.',
  'issue-compliance': 'Every acceptance criterion is observably satisfied at the PR head with no false-success path.',
  'code-quality': 'Correct, maintainable code with no dead, duplicated, or speculative logic.',
  'security': 'Untrusted input handling, path traversal, injection, and trust-boundary violations.',
  'performance': 'Unbounded work, needless recomputation, and scaling hazards.',
  'data-database': 'Schema, migration, and data-integrity correctness.',
  'concurrency-resource': 'Races, deadlocks, leaked resources, and cross-process interference.',
  'error-observability': 'Loud failures with actionable messages and no swallowed errors.',
  'tests-quality': 'Tests validate the production contract, not the implementation mirror.',
  'api-contract-compatibility': 'Public contracts stay compatible or change intentionally.',
  'docs-instructions': 'Shipped docs and rendered instructions match real behavior.',
  'ui-ux-accessibility': 'Visual correctness, usability, and accessibility of user-facing UI.',
  'release-ci-supply-chain': 'CI, packaging, and dependency changes stay pinned and intentional.',
  'manual-qa': 'Hands-on verification of the running product.',
  'final-gate': 'All configured gates and reviews are complete at the current head.',
};

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

function pathMatchesAny(changedPaths: readonly string[], patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false;
  return changedPaths.some(path => patterns.some(pattern => simpleGlobMatch(path, pattern)));
}

export function pathsTouchPatterns(paths: readonly string[], patterns: readonly string[]): boolean {
  return sharedPathsTouchPatterns(paths, patterns);
}

export type CarryForwardContextMode = 'all' | 'config' | 'scope';

const ECONOMY_LANE_TIERS = new Set<string>(['docs-instructions', 'task-record-compliance']);

export function defaultLaneModelTier(laneId: string): ReviewModelTierId {
  return ECONOMY_LANE_TIERS.has(laneId) ? 'economy' : 'review';
}

export function resolveLaneModelTier(
  lane: { tier?: ReviewModelTierId; route?: { tier: ReviewModelTierId } | null } | undefined,
  laneId: string,
): ReviewModelTierId {
  if (lane?.route?.tier) return lane.route.tier;
  if (lane?.tier) return lane.tier;
  return defaultLaneModelTier(laneId);
}

export function defaultCarryForwardContext(laneId: string): CarryForwardContextMode {
  if (laneId === 'issue-compliance' || laneId === 'final-gate' || laneId === 'task-record-compliance') return 'all';
  if (laneId === 'security' || laneId === 'release-ci-supply-chain') return 'config';
  return 'scope';
}

export function carryForwardScopeFromConfig(config: Config): CarryForwardScope {
  return {
    laneMatchPatterns: Object.fromEntries(config.reviewLanes.map(lane => [lane.id, [...lane.match]])),
    contextPatterns: [...config.reviewContextSources.instructions, ...config.reviewContextSources.requirements],
    laneContextModes: Object.fromEntries(config.reviewLanes.map(lane => [lane.id, lane.carryForwardContext ?? defaultCarryForwardContext(lane.id)])),
  };
}

export function carryForwardDeltaTouched(deltaPaths: readonly string[], matchPatterns: readonly string[], contextPatterns: readonly string[], contextMode: CarryForwardContextMode = 'all'): boolean {
  const normalized = deltaPaths.map(path => normalizePath(path));
  const isConfigPath = (path: string): boolean => path.startsWith('.qube/') && !path.startsWith('.qube/aie/reviews/');
  const isContextPath = (path: string): boolean => {
    if (isConfigPath(path)) return true;
    const baseName = path.split('/').pop() ?? '';
    if (baseName === 'AGENTS.md' || baseName === 'CLAUDE.md') return true;
    return contextPatterns.length > 0 && pathMatchesAny([path], contextPatterns);
  };
  const contextPaths = normalized.filter(isContextPath);
  if (contextMode === 'all' && contextPaths.length > 0) return true;
  if (contextMode === 'config' && contextPaths.some(isConfigPath)) return true;
  // Scope evaluation runs on the delta minus context paths and review-evidence
  // audit files, so doc-only or evidence-only commits carry scoped lanes forward
  // while a mixed doc+source commit still re-runs them.
  const scopePaths = normalized.filter(path => !isContextPath(path) && !path.startsWith('.qube/aie/reviews/'));
  return matchPatterns.length > 0 ? pathMatchesAny(scopePaths, matchPatterns) : scopePaths.length > 0;
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
    const always = [...new Set(entries.filter(entry => entry.lane.required === 'always' && entry.lane.optOut !== true).map(entry => entry.id))];
    const matched = [...new Set(entries
      .filter(entry => entry.lane.required === 'when-matched' && entry.lane.optOut !== true && laneActivated(entry.lane, changedPaths))
      .map(entry => entry.id)
      .filter(id => !always.includes(id)))];
    if (entries.length > 0) {
      if (always.length === 0 && matched.length === 0) return [];
      const matchedRoom = Math.max(0, maxActive - always.length);
      return [...always, ...matched.slice(0, matchedRoom)];
    }
  }
  return requiredLocalReviewLanes(input.profile);
}

export function reviewLanePublicationPolicy(lanes: readonly ReviewLanePolicy[]): {
  laneSuppress: Record<string, string[]>;
  laneAdvisoryCaps: Record<string, number>;
} {
  const laneSuppress: Record<string, string[]> = {};
  const laneAdvisoryCaps: Record<string, number> = {};
  for (const lane of lanes) {
    if ((lane.suppress ?? []).length > 0) laneSuppress[lane.id] = [...lane.suppress];
    if (typeof lane.maxAdvisoryFindings === 'number') laneAdvisoryCaps[lane.id] = lane.maxAdvisoryFindings;
  }
  return { laneSuppress, laneAdvisoryCaps };
}

export function activeLocalReviewFocusesForConfig(config: Config, changedPaths?: readonly string[]): readonly LocalReviewLaneId[] {
  const profile = config.reviewProfile === 'remote-compatible' ? 'local-standard' : config.reviewProfile;
  return activeLocalReviewFocuses({
    profile,
    lanes: config.reviewLanes,
    changedPaths,
  });
}
