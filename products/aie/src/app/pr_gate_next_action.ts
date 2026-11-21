export interface PrGateNextActionState {
  shipReady: boolean;
  twoRoundMergeMet: boolean;
  hostRequestRecorded: boolean;
  inconclusiveLanes: readonly string[];
  /** Lanes whose runner failed before a verdict (for example on max turns), when any. */
  rerunLanes?: readonly string[];
  /** Changed files a lane reported as not inspected, when any. */
  notInspectedFiles?: readonly string[];
  prNumber: number;
  fallback: string;
}

/** The one split-PR next action shared by `aie pr gate` and the local review gate. */
export function splitPullRequestNextAction(prNumber: number, notInspectedFiles: readonly string[]): string {
  const rerunCommand = prNumber > 0 ? `\`aie pr gate ${prNumber}\`` : '`aie pr gate <pr>`';
  return `Split the pull request into smaller pull requests so every changed file can be inspected. Files not inspected: ${notInspectedFiles.join(', ')}. Then rerun ${rerunCommand}.`;
}

export function computePrGateNextAction(state: PrGateNextActionState): string {
  if (state.shipReady || state.twoRoundMergeMet) return 'Merge this pull request.';
  if (state.notInspectedFiles && state.notInspectedFiles.length > 0) return splitPullRequestNextAction(state.prNumber, state.notInspectedFiles);
  if (state.inconclusiveLanes.length > 0) {
    const lane = state.inconclusiveLanes[0];
    return `Run \`aie pr lane rerun ${state.prNumber} ${lane}\` once, then rerun \`aie pr gate ${state.prNumber}\`.`;
  }
  if (state.rerunLanes && state.rerunLanes.length > 0) {
    const lane = state.rerunLanes[0];
    return `Run \`aie pr lane rerun ${state.prNumber} ${lane}\` once, then rerun \`aie pr gate ${state.prNumber}\`. If the lane stops again, make the change smaller or split the pull request.`;
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
