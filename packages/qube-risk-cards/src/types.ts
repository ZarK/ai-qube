export interface RiskCard {
  readonly id: string;
  readonly title: string;
  /** Lower rank is higher priority when more than max cards match. */
  readonly rank: number;
  readonly pathGlobs: readonly string[];
  readonly issueKeywords: readonly string[];
  readonly implementerFace: string;
  readonly reviewerFace: string;
}

export interface RiskCardSelectionInput {
  readonly issueText?: string;
  readonly paths?: readonly string[];
  readonly maxCards?: number;
}

export interface RiskCardCatalogValidation {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly cardCount: number;
}
