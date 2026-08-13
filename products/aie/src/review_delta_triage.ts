import { carryForwardDeltaTouched, defaultCarryForwardContext, type CarryForwardContextMode } from './review_focus.js';
import type { LocalReviewLaneId } from './local_review_evidence.js';

export type DeltaTriageVerdict = 'relevant' | 'not-relevant' | 'unsure';

export interface DeltaTriageLaneResult {
  lane: LocalReviewLaneId;
  verdict: DeltaTriageVerdict;
  modelTier: 'economy';
  reason: string;
  escalate: boolean;
}

export function classifyApprovedLaneDelta(input: {
  lane: LocalReviewLaneId;
  deltaPaths: readonly string[] | null;
  matchPatterns: readonly string[];
  contextPatterns: readonly string[];
  contextMode?: CarryForwardContextMode;
}): DeltaTriageLaneResult {
  if (input.deltaPaths === null) {
    return {
      lane: input.lane,
      verdict: 'unsure',
      modelTier: 'economy',
      reason: 'The git delta between the prior approved head and the current head could not be computed.',
      escalate: true,
    };
  }
  const touched = carryForwardDeltaTouched(
    input.deltaPaths,
    input.matchPatterns,
    input.contextPatterns,
    input.contextMode ?? defaultCarryForwardContext(input.lane),
  );
  if (!touched) {
    return {
      lane: input.lane,
      verdict: 'not-relevant',
      modelTier: 'economy',
      reason: 'The delta since the prior approved head does not touch this lane scope.',
      escalate: false,
    };
  }
  return {
    lane: input.lane,
    verdict: 'relevant',
    modelTier: 'economy',
    reason: 'The delta since the prior approved head touches this lane scope.',
    escalate: true,
  };
}
