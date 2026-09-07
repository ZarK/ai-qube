import type { Config } from '../config/index.js';
import { getCriterionIdentity, type CriterionIdentity } from '../checklist.js';
import type { LocalReviewLaneId } from '../local_review_evidence.js';
import type { IssueChecklistSummary } from './issue_checklist.js';
import { activeLocalReviewFocusesForConfig, LANE_HEURISTIC_DIGESTS, pathsTouchPatterns } from '../review_focus.js';
import { formatImplementerLearningsLines, selectImplementerLearnings, type ImplementerLearningsSection } from '../implementer_learnings.js';
import { selectRiskCards } from '../risk_cards/index.js';
import { readCriterionProof } from './criterion_proof.js';

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

export interface SelfCheckRequirementMapping {
  status: 'mapped' | 'incomplete' | 'unmapped';
  reason: string;
  citedPaths: string[];
}

export interface SelfCheckRequirement {
  issueNumber: number;
  index: number;
  text: string;
  checked: boolean;
  identity: CriterionIdentity;
  mapping: SelfCheckRequirementMapping;
}

export interface ImplementerSelfCheck {
  instruction: string;
  requirements: SelfCheckRequirement[];
  lanes: SelfCheckLane[];
  riskCards: SelfCheckCard[];
  repoLearnings: ImplementerLearningsSection;
}

export const SELF_CHECK_INSTRUCTION = 'For each requirement line, lane digest, risk card, and repo-configured learning below, either confirm the implementation already covers it or fix it now; do not spawn reviewers with known gaps.';

function mapRequirement(identity: CriterionIdentity, prBody: string | undefined): SelfCheckRequirementMapping {
  if (!prBody || prBody.trim() === '') {
    return { status: 'unmapped', reason: 'No pull request body with a criterion-to-proof map was available; fill the map before spawning reviewers.', citedPaths: [] };
  }
  const parsed = readCriterionProof(prBody, identity);
  if (!parsed.entry) return { status: 'unmapped', reason: parsed.errors.join(' '), citedPaths: [] };
  if (parsed.errors.length > 0) return { status: 'incomplete', reason: parsed.errors.join(' '), citedPaths: parsed.entry.citedPaths };
  return { status: 'mapped', reason: 'The criterion-to-proof mapping fields are complete. Citations prepare review context and do not prove completion.', citedPaths: parsed.entry.citedPaths };
}

export function buildRequirementSelfCheck(input: { issueChecklists: readonly IssueChecklistSummary[]; prBody?: string; repoRoot?: string }): SelfCheckRequirement[] {
  const requirements: SelfCheckRequirement[] = [];
  for (const summary of input.issueChecklists) {
    for (const item of summary.checklist.items) {
      const identity = getCriterionIdentity(summary.issue.number, item);
      requirements.push({
        issueNumber: summary.issue.number,
        index: item.index,
        text: item.text,
        checked: item.checked,
        identity,
        mapping: mapRequirement(identity, input.prBody),
      });
    }
  }
  const rank = (requirement: SelfCheckRequirement): number => requirement.mapping.status === 'mapped' ? 1 : 0;
  return requirements.sort((first, second) => rank(first) - rank(second));
}

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

export function buildImplementerSelfCheck(input: { config: Config; changedPaths: readonly string[]; issueChecklists?: readonly IssueChecklistSummary[]; prBody?: string; repoRoot?: string }): ImplementerSelfCheck {
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
  const repoLearnings = selectImplementerLearnings({ repoRoot: input.repoRoot, paths: input.changedPaths });
  const requirements = buildRequirementSelfCheck({ issueChecklists: input.issueChecklists ?? [], prBody: input.prBody, repoRoot: input.repoRoot });
  return { instruction: SELF_CHECK_INSTRUCTION, requirements, lanes, riskCards, repoLearnings };
}

export function formatImplementerSelfCheck(selfCheck: ImplementerSelfCheck): string[] {
  const lines: string[] = [];
  lines.push('Implementer self-check (before spawning reviewers):');
  lines.push(`  ${selfCheck.instruction}`);
  if (selfCheck.requirements.length > 0) {
    lines.push('  Linked issue requirements (incomplete or unmapped first):');
    for (const requirement of selfCheck.requirements) {
      lines.push(`  - [${requirement.mapping.status}] #${requirement.identity.issueNumber} criterion ${requirement.identity.index}: ${requirement.identity.text}`);
      lines.push(`    ${requirement.mapping.reason}`);
    }
  }
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
  lines.push(...formatImplementerLearningsLines(selfCheck.repoLearnings));
  return lines;
}
