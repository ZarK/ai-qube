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

/**
 * The one next action for changed files that no lane run read, shared by
 * `aie pr gate` and the local review gate. Inside one gate run the runner
 * continues a lane over the files a run did not read, so the action is a
 * gate rerun.
 */
export function notInspectedNextAction(prNumber: number, notInspectedFiles: readonly string[]): string {
  const rerunCommand = prNumber > 0 ? `\`aie pr gate ${prNumber}\`` : '`aie pr gate <pr>`';
  return `Rerun ${rerunCommand}: the gate runs the lane again and continues it over every changed file a run does not read. Files not inspected: ${notInspectedFiles.join(', ')}.`;
}

export function computePrGateNextAction(state: PrGateNextActionState): string {
  if (state.shipReady || state.twoRoundMergeMet) return 'Merge this pull request.';
  if (state.notInspectedFiles && state.notInspectedFiles.length > 0) return notInspectedNextAction(state.prNumber, state.notInspectedFiles);
  if (state.inconclusiveLanes.length > 0) {
    const lane = state.inconclusiveLanes[0];
    return `Run \`aie pr lane rerun ${state.prNumber} ${lane}\` once, then rerun \`aie pr gate ${state.prNumber}\`.`;
  }
  if (state.rerunLanes && state.rerunLanes.length > 0) {
    const lane = state.rerunLanes[0];
    return `Run \`aie pr lane rerun ${state.prNumber} ${lane}\` once, then rerun \`aie pr gate ${state.prNumber}\`. If the lane stops again, inspect the lane failure reason before you rerun it.`;
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
