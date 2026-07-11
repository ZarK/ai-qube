export type VerificationKind = 'unit' | 'integration' | 'manual-observation' | 'artifact-review' | 'unspecified';

export interface BriefObligation {
  criterion: string;
  kind: VerificationKind;
}

export interface BriefMatrixDimension {
  name: string;
  values: string[];
}

export interface BriefMatrix {
  dimensions: BriefMatrixDimension[];
  rows: string[][];
  omittedRows: number;
}

export interface BriefRiskCard {
  id: string;
  title: string;
  implementerFace: string;
}

export interface BriefLane {
  lane: string;
  heuristic: string;
}

export interface ImplementationBrief {
  obligations: BriefObligation[];
  omittedObligations: number;
  matrix: BriefMatrix | null;
  riskCards: BriefRiskCard[];
  expectedLanes: BriefLane[];
  negativeCases: string[];
  omittedNegativeCases: number;
  ambiguities: string[];
  omittedAmbiguities: number;
  expectedPaths: string[];
  minimal: boolean;
}
