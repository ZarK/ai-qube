import type { ReviewFinding } from '@tjalve/qube-core';
import { COMPREHENSIVE_LOCAL_REVIEW_LANES, type LocalReviewLaneId } from './local_review_evidence.js';

export interface SynthesisLaneInput {
  readonly laneId: LocalReviewLaneId;
  readonly findings: readonly ReviewFinding[];
}

export interface SynthesisPlanOptions {
  /**
   * Paths changed by this PR head. Undefined or empty disables only the
   * off-diff advisory filter, never dedupe or the nit cap: a PR head always
   * changes at least one path, so an empty set means the observation failed
   * and withholding on it would suppress real findings.
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
  const changedPaths = options.changedPaths && options.changedPaths.length > 0 ? new Set(options.changedPaths.map(normalizeComparablePath)) : null;

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

  return lanes.map(lane => {
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
    return {
      laneId: lane.laneId,
      published,
      withheldDuplicates: withheldDuplicatesByLane.get(lane.laneId) ?? 0,
      withheldOffDiff: withheldOffDiffByLane.get(lane.laneId) ?? 0,
      withheldByCap,
    };
  });
}
