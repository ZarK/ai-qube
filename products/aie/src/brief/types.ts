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

export interface BriefLayoutProject {
  name: string;
  path: string;
  role: string;
}

export interface BriefLayout {
  owningProjects: BriefLayoutProject[];
  omittedProjects: number;
  boundaryRules: string[];
  doNotEditPaths: string[];
  omittedDoNotEditPaths: number;
  derived: boolean;
}

export interface BriefRepoLearning {
  id: string;
  title: string;
  implementerFace: string;
  recordedAt: string;
  trust: 'repo-doc';
  source: 'repo-configured';
}

export interface BriefRepoLearnings {
  status: 'ok' | 'missing' | 'invalid';
  summary: string;
  trust: 'repo-doc';
  source: 'repo-configured';
  fragmentId: 'repo-configured/review-learnings';
  sha256: string | null;
  entries: BriefRepoLearning[];
  omitted: number;
}

export interface ImplementationBrief {
  obligations: BriefObligation[];
  omittedObligations: number;
  matrix: BriefMatrix | null;
  layout: BriefLayout | null;
  riskCards: BriefRiskCard[];
  repoLearnings: BriefRepoLearnings;
  expectedLanes: BriefLane[];
  negativeCases: string[];
  omittedNegativeCases: number;
  ambiguities: string[];
  omittedAmbiguities: number;
  expectedPaths: string[];
  minimal: boolean;
}
