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

/**
 * Deterministically select at most maxCards risk cards from issue text and paths.
 * Ranking: higher keyword+path score first, then lower rank, then id ascending.
 */
export function selectRiskCards(input: RiskCardSelectionInput = {}): readonly RiskCard[] {
  const maxCards = input.maxCards ?? DEFAULT_MAX_RISK_CARDS;
  if (!Number.isInteger(maxCards) || maxCards < 0) {
    throw new Error(`maxCards must be a non-negative integer; got ${String(input.maxCards)}.`);
  }
  if (maxCards === 0) return [];

  const issueText = input.issueText ?? "";
  const paths = input.paths ?? [];
  const scored = loadRiskCardCatalog()
    .map(card => {
      const keywords = keywordHits(issueText, card.issueKeywords);
      const pathHit = pathsTouchPatterns(paths, card.pathGlobs) ? 1 : 0;
      const score = keywords + pathHit * 2;
      return { card, score };
    })
    .filter(entry => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.card.rank !== right.card.rank) return left.card.rank - right.card.rank;
      return left.card.id.localeCompare(right.card.id);
    });

  return scored.slice(0, maxCards).map(entry => entry.card);
}
