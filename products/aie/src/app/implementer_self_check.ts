import type { Config } from '../config/index.js';
import type { LocalReviewLaneId } from '../local_review_evidence.js';
import { activeLocalReviewFocusesForConfig, LANE_HEURISTIC_DIGESTS, pathsTouchPatterns } from '../review_focus.js';
import { selectRiskCards } from '../risk_cards/index.js';

export interface SelfCheckLane {
  lane: LocalReviewLaneId;
  digest: string;
  activated: boolean;
  reason: string;
}

export interface SelfCheckCard {
  id: string;
  title: string;
  implementerFace: string;
}

export interface ImplementerSelfCheck {
  instruction: string;
  lanes: SelfCheckLane[];
  riskCards: SelfCheckCard[];
}

export const SELF_CHECK_INSTRUCTION = 'For each lane digest and risk card below, either confirm the implementation already covers it or fix it now; do not spawn reviewers with known gaps.';

function laneReason(input: { required: string; activated: boolean; matched: boolean }): string {
  if (input.activated) {
    return input.required === 'always' ? 'required for every head' : 'changed paths matched its patterns';
  }
  if (input.required === 'when-matched') {
    return input.matched
      ? 'did not activate: matched changed paths but was displaced by the active-focus cap'
      : 'did not activate: no changed paths matched its patterns';
  }
  return 'did not activate: not required for this head';
}

export function buildImplementerSelfCheck(input: { config: Config; changedPaths: readonly string[] }): ImplementerSelfCheck {
  const activeLanes = new Set(activeLocalReviewFocusesForConfig(input.config, input.changedPaths));
  const lanes: SelfCheckLane[] = [];
  const seen = new Set<string>();
  for (const lane of input.config.reviewLanes) {
    const laneId = lane.id as LocalReviewLaneId;
    if (!(laneId in LANE_HEURISTIC_DIGESTS) || seen.has(laneId)) continue;
    seen.add(laneId);
    const activated = activeLanes.has(laneId);
    const matched = lane.match.length > 0 && pathsTouchPatterns(input.changedPaths, lane.match);
    lanes.push({ lane: laneId, digest: LANE_HEURISTIC_DIGESTS[laneId], activated, reason: laneReason({ required: lane.required, activated, matched }) });
  }
  for (const laneId of activeLanes) {
    if (seen.has(laneId)) continue;
    seen.add(laneId);
    lanes.push({ lane: laneId, digest: LANE_HEURISTIC_DIGESTS[laneId], activated: true, reason: 'required by the review profile' });
  }
  // Path-only selection: the section is presented as diff-derived, so untrusted issue or
  // PR text must have no input surface here. Issue-text activation is the start/view brief's job.
  const riskCards = selectRiskCards({ paths: input.changedPaths })
    .map(card => ({ id: card.id, title: card.title, implementerFace: card.implementerFace.trim() }));
  return { instruction: SELF_CHECK_INSTRUCTION, lanes, riskCards };
}

export function formatImplementerSelfCheck(selfCheck: ImplementerSelfCheck): string[] {
  const lines: string[] = [];
  lines.push('Implementer self-check (before spawning reviewers):');
  lines.push(`  ${selfCheck.instruction}`);
  lines.push('  Planned lanes:');
  for (const lane of selfCheck.lanes) {
    lines.push(`  - ${lane.lane} (${lane.activated ? 'activated' : 'inactive'}; ${lane.reason}): ${lane.digest}`);
  }
  if (selfCheck.riskCards.length === 0) {
    lines.push('  Changed-path risk cards: none activated.');
  } else {
    lines.push('  Changed-path risk cards:');
    for (const card of selfCheck.riskCards) {
      lines.push(`  - ${card.id}: ${card.title}`);
      lines.push(`    ${card.implementerFace}`);
    }
  }
  return lines;
}
