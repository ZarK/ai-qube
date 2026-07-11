import { loadRiskCardCatalog } from "./catalog.js";
import { pathsTouchPatterns } from "./glob.js";
import type { RiskCard, RiskCardSelectionInput } from "./types.js";

export const DEFAULT_MAX_RISK_CARDS = 5;

function keywordHits(issueText: string, keywords: readonly string[]): number {
  if (!issueText || keywords.length === 0) return 0;
  const haystack = issueText.toLowerCase();
  let hits = 0;
  for (const keyword of keywords) {
    if (haystack.includes(keyword.toLowerCase())) hits += 1;
  }
  return hits;
}

function cardActivates(card: RiskCard, issueText: string, paths: readonly string[]): boolean {
  return keywordHits(issueText, card.issueKeywords) > 0 || pathsTouchPatterns(paths, card.pathGlobs);
}

/**
 * Deterministically select at most maxCards risk cards from issue text and paths.
 * Activation: path glob OR issue keyword match.
 * Cap order: lower rank first, then id ascending.
 */
export function selectRiskCards(input: RiskCardSelectionInput = {}): readonly RiskCard[] {
  const maxCards = input.maxCards ?? DEFAULT_MAX_RISK_CARDS;
  if (!Number.isInteger(maxCards) || maxCards < 0) {
    throw new Error(`maxCards must be a non-negative integer; got ${String(input.maxCards)}.`);
  }
  if (maxCards === 0) return [];

  const issueText = input.issueText ?? "";
  const paths = input.paths ?? [];
  return loadRiskCardCatalog()
    .filter(card => cardActivates(card, issueText, paths))
    .sort((left, right) => {
      if (left.rank !== right.rank) return left.rank - right.rank;
      return left.id.localeCompare(right.id);
    })
    .slice(0, maxCards);
}
