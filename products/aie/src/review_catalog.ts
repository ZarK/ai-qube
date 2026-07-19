export const ECONOMY_REVIEW_CATALOG = [
  {
    name: 'qube-review-explorer',
    descriptorId: 'explorer',
    purpose: 'Read and summarize large repository or provider texts (issue bodies, milestone docs, long comment threads) for a review lane.',
    whenSufficient: 'Use when a lane needs the content of a large text, not the raw text itself.',
  },
  {
    name: 'qube-review-digest',
    descriptorId: 'explorer',
    purpose: 'Condense diffs, test output, and evidence files into focused digests for a review lane.',
    whenSufficient: 'Use when a lane needs the shape of a large diff or log, not every line.',
  },
  {
    name: 'qube-review-librarian',
    descriptorId: 'librarian',
    purpose: 'Locate files, symbols, and prior review evidence across the repository and the local review store.',
    whenSufficient: 'Use when a lane needs to find where something lives before reading it.',
  },
] as const;

export type EconomyReviewCatalogAgent = (typeof ECONOMY_REVIEW_CATALOG)[number];

export function economyCatalogAgent(name: string): EconomyReviewCatalogAgent {
  const agent = ECONOMY_REVIEW_CATALOG.find(item => item.name === name);
  if (!agent) throw new Error(`Unknown economy review catalog agent name "${name}".`);
  return agent;
}
