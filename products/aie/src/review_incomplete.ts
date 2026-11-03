/** A placeholder or non-substantive progress text cannot describe a finished review. */
export function isPlaceholderReviewText(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, ' ').toLowerCase();
  return /^placeholder(?:\s+(?:text|result|review|summary|output|response))?[.!]?$/.test(normalized);
}

export function isProgressOnlyReviewText(text: string): boolean {
  const progressOnly = [
    /\b(?:in progress|pending|incomplete|not (?:yet )?complet(?:e|ed)|not yet (?:been )?inspected|inspecting)\b/i,
    /\b(?:review|inspection) continues\b/i,
    /^(?:starting|beginning) (?:the )?(?:read-only )?(?:review|inspection)[.!]?$/i,
    /^(?:review )?not started[.!]?$/i,
    /^not inspected[.!]?$/i,
  ];
  const substantiveReason = /\b(?:because|blocked|unavailable|unable|failed|error|cannot|can't|could not|missing)\b/i;
  return !substantiveReason.test(text) && progressOnly.some(pattern => pattern.test(text.trim()));
}

/**
 * Progress wording in a result that claims to be finished. Unlike interim
 * snapshot detection, a "because" clause does not excuse a sentence that
 * says the review itself is unfinished; a finished result may still use
 * words like "incomplete" for the code it inspected.
 */
export function isUnfinishedReviewText(text: string): boolean {
  if (isPlaceholderReviewText(text)) return true;
  const statusForm = /^(?:not yet (?:been )?inspected|still inspecting|inspecting|pending|not inspected|not started|review not started)$/i;
  const sentenceStart = [
    /^(?:the\s+)?(?:[\w-]+\s+){0,3}?(?:review|inspection|completeness)\b[^.!?]*\b(?:in progress|not (?:yet )?complet(?:e|ed)|incomplete|pending|continues)\b/i,
    /^(?:review|inspection)?\s*(?:is\s+)?(?:still\s+)?(?:in progress|not (?:yet )?complet(?:e|ed))\b/i,
    /^still inspecting\b/i,
    /^(?:starting|beginning) (?:the )?(?:read-only )?(?:review|inspection)\b/i,
  ];
  const sentences = text.split(/[.!?]+/).map(sentence => sentence.trim()).filter(sentence => sentence !== '');
  return sentences.some(sentence => statusForm.test(sentence) || sentenceStart.some(pattern => pattern.test(sentence)));
}

export interface IncompleteReviewResult {
  field: 'summary' | 'completeness' | 'contextReviewed' | 'toolsUsed';
  detail: string;
}

export interface ReviewResultCompletenessShape {
  summary: string;
  completeness: string;
  contextReviewed: readonly { source: string }[];
  toolsUsed: readonly string[];
  commands: readonly string[];
  findings: readonly unknown[];
}

/**
 * Names why a result that claims a finished review is in fact incomplete:
 * placeholder or progress wording, a context source that is still pending,
 * or findings reported with no tool or command behind them. Returns null
 * for a result that carries its own inspection evidence.
 */
export function incompleteReviewResult(result: ReviewResultCompletenessShape): IncompleteReviewResult | null {
  if (isUnfinishedReviewText(result.summary)) {
    return { field: 'summary', detail: 'summary is placeholder or progress text, not a finished review' };
  }
  if (isUnfinishedReviewText(result.completeness)) {
    return { field: 'completeness', detail: 'completeness is placeholder or progress text, not a finished review' };
  }
  if (result.contextReviewed.some(entry => entry.source.trim().toLowerCase() === 'pending')) {
    return { field: 'contextReviewed', detail: 'a contextReviewed source is still pending' };
  }
  if (result.toolsUsed.length === 0 && result.commands.length === 0 && result.findings.length > 0) {
    return { field: 'toolsUsed', detail: 'findings are reported with no tools and no commands behind them' };
  }
  return null;
}
