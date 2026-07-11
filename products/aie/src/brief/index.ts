export type {
  BriefLane,
  BriefMatrix,
  BriefMatrixDimension,
  BriefObligation,
  BriefRiskCard,
  ImplementationBrief,
  VerificationKind,
} from './types.js';

export { buildImplementationBrief, extractExpectedPaths } from './build.js';
export { formatBriefLines } from './render.js';
