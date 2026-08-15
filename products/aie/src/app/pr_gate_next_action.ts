export interface PrGateNextActionState {
  shipReady: boolean;
  twoRoundMergeMet: boolean;
  hostRequestRecorded: boolean;
  inconclusiveLanes: readonly string[];
  prNumber: number;
  fallback: string;
}

export function computePrGateNextAction(state: PrGateNextActionState): string {
  if (state.shipReady || state.twoRoundMergeMet) return 'Merge this pull request.';
  if (state.inconclusiveLanes.length > 0) {
    const lane = state.inconclusiveLanes[0];
    return `Run \`aie pr lane rerun ${state.prNumber} ${lane}\` once, then rerun \`aie pr gate ${state.prNumber}\`.`;
  }
  if (state.hostRequestRecorded && /^Post the configured /.test(state.fallback)) {
    return `Reviewer request is already recorded for this head. Inspect lane results, then rerun \`aie pr gate ${state.prNumber}\`.`;
  }
  return state.fallback;
}

export function twoRoundMergeConditionMet(input: {
  completedRoundCount: number;
  unresolvedBlockers: number;
  requiredChecksGreen: boolean;
  unresolvedThreads: number;
}): boolean {
  return input.completedRoundCount >= 2
    && input.unresolvedBlockers === 0
    && input.requiredChecksGreen
    && input.unresolvedThreads === 0;
}
