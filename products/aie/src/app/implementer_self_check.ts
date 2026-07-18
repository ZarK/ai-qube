import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Config } from '../config/index.js';
import type { LocalReviewLaneId } from '../local_review_evidence.js';
import type { IssueChecklistSummary } from './issue_checklist.js';
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

export interface SelfCheckRequirementProof {
  status: 'proven' | 'unproven' | 'unmapped';
  reason: string;
  citedPaths: string[];
}

export interface SelfCheckRequirement {
  issueNumber: number;
  index: number;
  text: string;
  checked: boolean;
  proof: SelfCheckRequirementProof;
}

export interface ImplementerSelfCheck {
  instruction: string;
  requirements: SelfCheckRequirement[];
  lanes: SelfCheckLane[];
  riskCards: SelfCheckCard[];
}

export const SELF_CHECK_INSTRUCTION = 'For each requirement line, lane digest, and risk card below, either confirm the implementation already covers it or fix it now; do not spawn reviewers with known gaps.';

const REQUIREMENT_STOPWORDS = new Set(['about', 'after', 'against', 'before', 'between', 'cannot', 'could', 'current', 'every', 'first', 'gates', 'never', 'other', 'should', 'still', 'their', 'there', 'these', 'those', 'through', 'under', 'when', 'where', 'which', 'while', 'with', 'without', 'would']);

function requirementKeywords(text: string): string[] {
  return [...new Set(text.toLowerCase().replace(/[`*_]/g, '').split(/[^a-z0-9-]+/)
    .filter(word => word.length >= 5 && !REQUIREMENT_STOPWORDS.has(word)))];
}

function citedPathsFromSection(section: string): string[] {
  return [...new Set([...section.matchAll(/`([^`\n]+)`/g)]
    .map(match => match[1].trim())
    .filter(value => /^[\w@./-]+\.[a-z]{2,4}$/i.test(value) && value.includes('/')))];
}

function criterionSection(prBody: string, requirementText: string): string | null {
  const normalized = requirementText.replace(/\s+/g, ' ').trim();
  const sections = prBody.split(/^###\s+/m).slice(1).map(section => ({
    section,
    heading: (section.split('\n', 1)[0] ?? '').replace(/^Criterion\s+\d+:\s*/i, '').replace(/\s+/g, ' ').trim(),
  }));
  // Prefer an exact heading match; fall back to full-text containment so minor
  // punctuation drift does not orphan a requirement, never a truncated prefix.
  const exact = sections.find(entry => entry.heading === normalized);
  if (exact) return exact.section;
  const containing = sections.find(entry => entry.heading.includes(normalized) || normalized.includes(entry.heading) && entry.heading.length > 20);
  return containing?.section ?? null;
}

function proveRequirement(requirementText: string, prBody: string | undefined, repoRoot: string | undefined): SelfCheckRequirementProof {
  if (!prBody || prBody.trim() === '') {
    return { status: 'unmapped', reason: 'No pull request body with a criterion-to-proof map was available; fill the map before spawning reviewers.', citedPaths: [] };
  }
  const section = criterionSection(prBody, requirementText);
  if (!section) {
    return { status: 'unmapped', reason: 'The pull request body has no criterion-to-proof entry for this requirement; add one before spawning reviewers.', citedPaths: [] };
  }
  const citedPaths = citedPathsFromSection(section);
  if (citedPaths.length === 0) {
    return { status: 'unproven', reason: 'The criterion-to-proof entry cites no repository file paths.', citedPaths };
  }
  if (!repoRoot) {
    return { status: 'unproven', reason: 'Cited paths could not be verified without a repository root.', citedPaths };
  }
  // Citations must stay repository-relative; absolute or parent-escaping paths can
  // never count as proof of in-repository behavior.
  const escaping = citedPaths.filter(path => isAbsolute(path) || path.split('/').includes('..'));
  if (escaping.length > 0) {
    return { status: 'unproven', reason: `Cited path(s) are not repository-relative: ${escaping.join(', ')}.`, citedPaths };
  }
  const missing = citedPaths.filter(path => !existsSync(join(repoRoot, path)));
  if (missing.length > 0) {
    return { status: 'unproven', reason: `Cited proof path(s) do not exist: ${missing.join(', ')}.`, citedPaths };
  }
  const testPaths = citedPaths.filter(path => /(^|\/)test(s)?\//.test(path) || /\.test\./.test(path));
  if (testPaths.length === 0) {
    return { status: 'unproven', reason: 'The criterion-to-proof entry cites no test file; name the test whose assertions fail if this requirement regresses.', citedPaths };
  }
  const keywords = requirementKeywords(requirementText);
  if (keywords.length === 0) {
    return { status: 'unproven', reason: 'The requirement carries no distinctive behavior terms to verify mechanically; confirm the cited test covers it before spawning reviewers.', citedPaths };
  }
  const requiredMatches = Math.min(2, keywords.length);
  const matched = testPaths.some(path => {
    try {
      // Cap the read so a pathological citation cannot stall the dry-run.
      const content = readFileSync(join(repoRoot, path), 'utf8').slice(0, 512 * 1024).toLowerCase();
      return keywords.filter(keyword => content.includes(keyword)).length >= requiredMatches;
    } catch {
      return false;
    }
  });
  if (!matched) {
    return { status: 'unproven', reason: `Cited test file(s) do not reference this requirement's key behavior terms (${keywords.slice(0, 5).join(', ')}); the citation looks unrelated.`, citedPaths };
  }
  // Heuristic proof: the citation exists and plausibly covers the requirement's
  // behavior terms; semantic correctness remains the review lanes' job.
  return { status: 'proven', reason: 'Cited proof files exist and the cited test references the requirement behavior.', citedPaths };
}

export function buildRequirementSelfCheck(input: { issueChecklists: readonly IssueChecklistSummary[]; prBody?: string; repoRoot?: string }): SelfCheckRequirement[] {
  const requirements: SelfCheckRequirement[] = [];
  for (const summary of input.issueChecklists) {
    for (const item of summary.checklist.items) {
      requirements.push({
        issueNumber: summary.issue.number,
        index: item.index,
        text: item.text,
        checked: item.checked,
        proof: proveRequirement(item.text, input.prBody, input.repoRoot),
      });
    }
  }
  const rank = (requirement: SelfCheckRequirement): number => requirement.proof.status === 'proven' ? 1 : 0;
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
  const requirements = buildRequirementSelfCheck({ issueChecklists: input.issueChecklists ?? [], prBody: input.prBody, repoRoot: input.repoRoot });
  return { instruction: SELF_CHECK_INSTRUCTION, requirements, lanes, riskCards };
}

export function formatImplementerSelfCheck(selfCheck: ImplementerSelfCheck): string[] {
  const lines: string[] = [];
  lines.push('Implementer self-check (before spawning reviewers):');
  lines.push(`  ${selfCheck.instruction}`);
  if (selfCheck.requirements.length > 0) {
    lines.push('  Linked issue requirements (unproven first):');
    for (const requirement of selfCheck.requirements) {
      lines.push(`  - [${requirement.proof.status}] #${requirement.issueNumber} criterion ${requirement.index}: ${requirement.text}`);
      lines.push(`    ${requirement.proof.reason}`);
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
  return lines;
}
