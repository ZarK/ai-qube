import type { ReviewFinding } from '@tjalve/qube-core';
import { COMPREHENSIVE_LOCAL_REVIEW_LANES, type LocalReviewLaneId } from './local_review_evidence.js';

export interface SynthesisLaneInput {
  readonly laneId: LocalReviewLaneId;
  readonly findings: readonly ReviewFinding[];
}

export interface SynthesisPlanOptions {
  /**
   * Paths changed by this PR head. Only `undefined` disables the off-diff
   * advisory filter (the delta was not observed); a failed observation is
   * failed closed by the caller before synthesis. An empty array is a
   * genuine observation of an empty diff, so anchored advisories cannot be
   * re-confirmed and are withheld. Dedupe and the nit cap always apply.
   */
  readonly changedPaths?: readonly string[];
  readonly nitCap: number;
}

export interface LanePublicationPlan {
  readonly laneId: LocalReviewLaneId;
  readonly published: ReviewFinding[];
  readonly withheldDuplicates: number;
  readonly withheldOffDiff: number;
  readonly withheldByCap: number;
  /**
   * True when at least one of this lane's original findings is published on
   * some lane's marker (this lane or the identity owner). A request-changes
   * lane with no visible obligation must fail publication closed, because a
   * duplicate it withheld may have been dropped off-diff or by the cap at the
   * owning lane and therefore appears on no marker at all.
   */
  readonly hasVisibleObligation: boolean;
}

interface WorkingFinding {
  readonly laneId: LocalReviewLaneId;
  readonly finding: ReviewFinding;
}

// The dedupe/cap winner order: canonical comprehensive lane order with
// final-gate forced last regardless of its position, so a gate-level
// restatement of another lane's finding never wins a cross-lane dedupe.
function canonicalLanePriority(): readonly LocalReviewLaneId[] {
  const withoutFinalGate = COMPREHENSIVE_LOCAL_REVIEW_LANES.filter(laneId => laneId !== 'final-gate');
  return [...withoutFinalGate, 'final-gate'];
}

function lanePriorityRank(order: readonly LocalReviewLaneId[], laneId: LocalReviewLaneId): number {
  const index = order.indexOf(laneId);
  return index >= 0 ? index : order.length - 1;
}

function normalizeComparablePath(path: string): string {
  return path.replace(/\\/g, '/');
}

// Identity must carry the full anchor: findings with identical wording at
// different lines, ranges, or sides are distinct and must never collapse.
function findingIdentity(finding: ReviewFinding): string {
  const location = finding.location;
  return [
    finding.severity,
    finding.message.trim(),
    location ? normalizeComparablePath(location.path) : '',
    location?.line ?? '',
    location?.endLine ?? '',
    location?.side ?? '',
  ].join('\0');
}

function confidenceRank(finding: ReviewFinding): number {
  return typeof finding.confidence === 'number' ? finding.confidence : -1;
}

export function planFindingPublication(lanes: readonly SynthesisLaneInput[], options: SynthesisPlanOptions): LanePublicationPlan[] {
  if (!Number.isSafeInteger(options.nitCap) || options.nitCap <= 0) {
    throw new Error('planFindingPublication requires nitCap to be a positive safe integer.');
  }
  const priorityOrder = canonicalLanePriority();
  // Only an unobserved delta (undefined) disables the filter; an observed
  // empty diff is a real empty set that withholds every anchored advisory.
  const changedPaths = options.changedPaths !== undefined ? new Set(options.changedPaths.map(normalizeComparablePath)) : null;

  // Cross-lane dedupe: the earliest canonical lane to report a finding
  // identity owns it; every later lane withholds its own copy. The owner
  // inherits the highest confidence any lane reported for the identity, so
  // a withheld high-confidence restatement still wins its cap slot instead
  // of vanishing behind the owner's lower score.
  const laneOrderForOwnership = [...lanes].sort((left, right) => lanePriorityRank(priorityOrder, left.laneId) - lanePriorityRank(priorityOrder, right.laneId));
  const identityOwner = new Map<string, LocalReviewLaneId>();
  const identityMaxConfidence = new Map<string, number>();
  for (const lane of laneOrderForOwnership) {
    for (const finding of lane.findings) {
      const identity = findingIdentity(finding);
      if (!identityOwner.has(identity)) identityOwner.set(identity, lane.laneId);
      if (typeof finding.confidence === 'number') {
        const known = identityMaxConfidence.get(identity);
        if (known === undefined || finding.confidence > known) identityMaxConfidence.set(identity, finding.confidence);
      }
    }
  }

  const survivingByLane = new Map<LocalReviewLaneId, WorkingFinding[]>();
  const withheldDuplicatesByLane = new Map<LocalReviewLaneId, number>();
  const withheldOffDiffByLane = new Map<LocalReviewLaneId, number>();
  for (const lane of lanes) {
    survivingByLane.set(lane.laneId, []);
    withheldDuplicatesByLane.set(lane.laneId, 0);
    withheldOffDiffByLane.set(lane.laneId, 0);
  }

  for (const lane of lanes) {
    for (const finding of lane.findings) {
      const identity = findingIdentity(finding);
      if (identityOwner.get(identity) !== lane.laneId) {
        withheldDuplicatesByLane.set(lane.laneId, (withheldDuplicatesByLane.get(lane.laneId) ?? 0) + 1);
        continue;
      }
      // An advisory is re-confirmable against the diff only through its
      // anchor: with an observed changed-path set, both off-diff anchors and
      // anchor-less advisories are withheld. Blocking findings always pass.
      const offDiff = finding.severity === 'advisory' && changedPaths !== null
        && (finding.location === undefined || !changedPaths.has(normalizeComparablePath(finding.location.path)));
      if (offDiff) {
        withheldOffDiffByLane.set(lane.laneId, (withheldOffDiffByLane.get(lane.laneId) ?? 0) + 1);
        continue;
      }
      const promotedConfidence = identityMaxConfidence.get(identity);
      const surviving = promotedConfidence !== undefined && promotedConfidence !== finding.confidence
        ? { ...finding, confidence: promotedConfidence }
        : finding;
      survivingByLane.get(lane.laneId)!.push({ laneId: lane.laneId, finding: surviving });
    }
  }

  // Global nit cap: rank every surviving advisory finding by confidence
  // descending (missing confidence ranks last), tie-broken by canonical lane
  // order then message; blocking findings are exempt and never counted.
  const advisoryCandidates: WorkingFinding[] = [];
  for (const lane of lanes) {
    for (const entry of survivingByLane.get(lane.laneId) ?? []) {
      if (entry.finding.severity === 'advisory') advisoryCandidates.push(entry);
    }
  }
  const rankedAdvisories = [...advisoryCandidates].sort((left, right) => {
    const confidenceDelta = confidenceRank(right.finding) - confidenceRank(left.finding);
    if (confidenceDelta !== 0) return confidenceDelta;
    const laneDelta = lanePriorityRank(priorityOrder, left.laneId) - lanePriorityRank(priorityOrder, right.laneId);
    if (laneDelta !== 0) return laneDelta;
    return left.finding.message.localeCompare(right.finding.message);
  });
  const keptAdvisories = new Set(rankedAdvisories.slice(0, options.nitCap));

  const publishedByLane = new Map<LocalReviewLaneId, { published: ReviewFinding[]; withheldByCap: number }>();
  for (const lane of lanes) {
    const surviving = survivingByLane.get(lane.laneId) ?? [];
    // Published order is part of the contract: blocking findings first in
    // evidence order, then capped advisories in the same confidence-ranked
    // order the cap was decided in.
    const published: ReviewFinding[] = surviving
      .filter(entry => entry.finding.severity === 'blocking')
      .map(entry => entry.finding);
    let withheldByCap = 0;
    for (const entry of rankedAdvisories) {
      if (entry.laneId !== lane.laneId) continue;
      if (keptAdvisories.has(entry)) {
        published.push(entry.finding);
      } else {
        withheldByCap += 1;
      }
    }
    publishedByLane.set(lane.laneId, { published, withheldByCap });
  }

  // An obligation is visible only if it survived to some lane's published set.
  // A duplicate that this lane withheld can still vanish entirely if the owner
  // also dropped it off-diff or by the cap, so visibility is judged against
  // the union of everything actually published, not against ownership alone.
  const publishedIdentities = new Set<string>();
  for (const plan of publishedByLane.values()) {
    for (const finding of plan.published) publishedIdentities.add(findingIdentity(finding));
  }

  return lanes.map(lane => {
    const plan = publishedByLane.get(lane.laneId)!;
    const hasVisibleObligation = lane.findings.some(finding => publishedIdentities.has(findingIdentity(finding)));
    return {
      laneId: lane.laneId,
      published: plan.published,
      withheldDuplicates: withheldDuplicatesByLane.get(lane.laneId) ?? 0,
      withheldOffDiff: withheldOffDiffByLane.get(lane.laneId) ?? 0,
      withheldByCap: plan.withheldByCap,
      hasVisibleObligation,
    };
  });
}
