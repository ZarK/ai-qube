import type { Config } from '../config/index.js';
import type { ReviewModelHostId } from '../core/policy.js';
import { localReviewEvidenceSha256, readLocalReviewGate } from '../local_review_evidence.js';
import { formatRiskCardReviewerFragment, selectRiskCards } from '../risk_cards/index.js';
import { laneConfiguredFragments, resolveModelReviewPlan } from './local_review_runner.js';
import { configuredReviewModelHost, stableLanePromptHash } from './local_review_runner_support.js';
import { isRecord, readCriterionInputs } from './criterion_inputs.js';

const LANE = 'issue-compliance' as const;

export function verifyPromptedReview(input: {
  record: Record<string, unknown>;
  repoRoot: string;
  issueNumber: number;
  pr: { number: number; headSha: string } | null;
  issueText?: string;
  changedPaths?: readonly string[];
  config: Config | null;
}): string[] {
  const proof = input.record.proof;
  if (!isRecord(proof) || !input.pr || !isRecord(proof.review) || proof.review.lane !== LANE) {
    return ['Prompted criterion proof requires an existing current-PR issue-compliance review; no new reviewer is automatically requested.'];
  }
  if (!input.config || input.issueText === undefined || input.changedPaths === undefined) {
    return ['Prompted criterion proof requires the current repository configuration, issue text, and changed-path snapshot.'];
  }
  const stack = proof.promptStack;
  if (!Array.isArray(stack) || stack.length === 0 || !stack.every(fragment => isRecord(fragment) && typeof fragment.id === 'string' && fragment.id.trim() && typeof fragment.sha256 === 'string' && /^[a-f0-9]{64}$/.test(fragment.sha256))) {
    return ['Prompted proof requires the exact executed prompt stack IDs and SHA-256 digests.'];
  }
  const evidencePath = `.qube/aie/reviews/${input.issueNumber}/${input.pr.number}/${input.pr.headSha}/${LANE}.json`;
  const route = resolveModelReviewPlan(input.config, LANE);
  const host = (route?.host ?? configuredReviewModelHost(input.config)) as ReviewModelHostId;
  const riskCardFragments = selectRiskCards({ issueText: input.issueText, paths: input.changedPaths }).map(formatRiskCardReviewerFragment);
  const expectedPromptStackHash = stableLanePromptHash({
    host,
    lane: LANE,
    issueNumbers: [input.issueNumber],
    prNumber: input.pr.number,
    headSha: input.pr.headSha,
    evidencePaths: [evidencePath],
    riskCardFragments,
    repoRoot: input.repoRoot,
    configuredFragments: laneConfiguredFragments(input.config, LANE),
  });
  const gate = readLocalReviewGate({
    repoRoot: input.repoRoot,
    issueNumbers: [input.issueNumber],
    prNumber: input.pr.number,
    headSha: input.pr.headSha,
    reviewers: input.config.localReviewAgents,
    required: true,
    profile: input.config.reviewProfile,
    severityThreshold: input.config.reviewSeverityThreshold,
    expectedPromptStackHashes: { [`${input.issueNumber}:${LANE}`]: expectedPromptStackHash },
    activeFocuses: [LANE],
  });
  if (gate.status !== 'passed') return [`Required prompt execution provenance is unverifiable: ${gate.summary}`];
  const lane = gate.evidence.flatMap(evidence => evidence.lanes).find(candidate => candidate.id === LANE);
  if (!lane || lane.runnerProvenance?.runnerKind !== 'local-host' || !lane.runnerProvenance.freshContext || lane.runnerProvenance.promptOnly) {
    return ['Prompted proof requires a trusted executed review, not a manual or prompt-only result.'];
  }
  if (localReviewEvidenceSha256(stack) !== localReviewEvidenceSha256(lane.promptStack.map(fragment => ({ id: fragment.id, sha256: fragment.sha256 })))) {
    return ['Prompt stack does not match the trusted review execution.'];
  }
  if (proof.review.headSha !== input.pr.headSha || proof.review.prNumber !== input.pr.number) return ['Prompted proof reference must match the current PR and head.'];
  if (typeof proof.review.evidenceSha256 !== 'string') return ['Prompted proof needs the SHA-256 of its executed review evidence.'];
  return readCriterionInputs([{ kind: 'review', path: evidencePath, sha256: proof.review.evidenceSha256 }], input.repoRoot, 'Executed review').errors;
}
