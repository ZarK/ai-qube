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

const UNFINISHED_STATUS = String.raw`placeholder|pending|inspecting|in progress|incomplete|unfinished|not (?:yet )?complet(?:e|ed)|not (?:yet )?(?:been )?inspected|not inspected|not started|still inspecting|still in progress`;

/**
 * Progress wording in a result that claims to be finished. The text counts
 * as unfinished when it is only a status, or when its first sentence makes
 * the review itself the subject of an unfinished predicate. Unlike interim
 * snapshot detection, a "because" clause does not excuse that claim; later
 * sentences and status words that describe the inspected code do not turn
 * a finished result into a progress report.
 */
export function isUnfinishedReviewText(text: string): boolean {
  if (isPlaceholderReviewText(text)) return true;
  const wholeText = text.trim().replace(/[.!?]+$/, '');
  const wholeStatus = [
    new RegExp(String.raw`^(?:the\s+)?(?:delta\s+)?(?:review|inspection|completeness)\s+(?:is\s+)?(?:still\s+)?(?:${UNFINISHED_STATUS})$`, 'i'),
    new RegExp(String.raw`^(?:i am\s+)?(?:${UNFINISHED_STATUS})$`, 'i'),
    new RegExp(String.raw`^(?:${UNFINISHED_STATUS})\s+(?:review|inspection|completeness)$`, 'i'),
    /^(?:still\s+)?inspecting\s+(?:the\s+)?[\w-]+(?:\s+[\w-]+){0,2}$/i,
    /^(?:the\s+)?(?:review|inspection) continues$/i,
  ];
  if (wholeStatus.some(pattern => pattern.test(wholeText))) return true;
  const firstSentence = wholeText.split(/[.!?;]/, 1)[0] ?? '';
  if (wholeStatus.some(pattern => pattern.test(firstSentence))) return true;
  const firstSentencePatterns = [
    /(?:review|inspection|completeness)\s+(?:is|was|remains)\s+(?:still\s+)?(?:in progress|not (?:yet )?complet(?:e|ed)|incomplete|pending|unfinished)\b/i,
    /(?:review|inspection|completeness)\s+(?:still\s+)?(?:in progress|inspecting)\b/i,
    /(?:review|inspection)\s+not\s+(?:yet\s+)?(?:complet(?:e|ed)|started)\b/i,
    /(?:review|inspection) continues\b/i,
    /^still inspecting\b/i,
    /^(?:starting|beginning) (?:the )?(?:read-only )?(?:review|inspection)\b/i,
  ];
  return firstSentencePatterns.some(pattern => pattern.test(firstSentence));
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
