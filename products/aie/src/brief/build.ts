import type { Config } from '../config/index.js';
import { parseWorkChecklistItems } from '../core/work_item.js';
import { activeLocalReviewFocusesForConfig } from '../review_focus.js';
import type { LocalReviewLaneId } from '../local_review_evidence.js';
import { implementerFaceHasTestObligation, selectRiskCards } from '../risk_cards/index.js';
import type { BriefLane, BriefMatrix, BriefMatrixDimension, BriefObligation, ImplementationBrief, VerificationKind } from './types.js';

const MAX_OBLIGATIONS = 30;
const MAX_MATRIX_ROWS = 24;
const MAX_NEGATIVE_CASES = 20;
const MAX_AMBIGUITIES = 20;
const MAX_EXPECTED_PATHS = 40;
const MAX_ITEM_CHARS = 240;

interface MatrixDimensionSpec {
  name: string;
  mention: RegExp;
  values: readonly string[];
  requiresMention: boolean;
}

// Values must be distinctive tokens; dimensions whose values are common English words
// (lifecycle states) additionally require the dimension itself to be named in the issue.
const MATRIX_DIMENSIONS: readonly MatrixDimensionSpec[] = [
  { name: 'provider', mention: /\bproviders?\b/i, values: ['github', 'gitlab', 'linear', 'jira'], requiresMention: false },
  { name: 'host', mention: /\bhosts?\b/i, values: ['codex', 'claude code', 'opencode'], requiresMention: false },
  { name: 'auth mode', mention: /\bauth(?:entication)?[ -]modes?\b/i, values: ['oauth', 'api key', 'ssh', 'device code'], requiresMention: false },
  { name: 'config mode', mention: /\bconfig(?:uration)?[ -](?:modes?|profiles?|sources?)\b/i, values: ['local-focused', 'local-standard', 'remote-compatible'], requiresMention: false },
  { name: 'lifecycle state', mention: /\blifecycle[ -]states?\b/i, values: ['started', 'resumed', 'blocked', 'empty', 'invalid'], requiresMention: true },
  { name: 'platform', mention: /\bplatforms?\b/i, values: ['windows', 'macos', 'linux'], requiresMention: false },
];

const LANE_HEURISTICS: Record<LocalReviewLaneId, string> = {
  'task-record-compliance': 'Durable task records match the work actually performed.',
  'issue-compliance': 'Every acceptance criterion is observably satisfied at the PR head with no false-success path.',
  'code-quality': 'Correct, maintainable code with no dead, duplicated, or speculative logic.',
  'security': 'Untrusted input handling, path traversal, injection, and trust-boundary violations.',
  'performance': 'Unbounded work, needless recomputation, and scaling hazards.',
  'data-database': 'Schema, migration, and data-integrity correctness.',
  'concurrency-resource': 'Races, deadlocks, leaked resources, and cross-process interference.',
  'error-observability': 'Loud failures with actionable messages and no swallowed errors.',
  'tests-quality': 'Tests validate the production contract, not the implementation mirror.',
  'api-contract-compatibility': 'Public contracts stay compatible or change intentionally.',
  'docs-instructions': 'Shipped docs and rendered instructions match real behavior.',
  'ui-ux-accessibility': 'Visual correctness, usability, and accessibility of user-facing UI.',
  'release-ci-supply-chain': 'CI, packaging, and dependency changes stay pinned and intentional.',
  'manual-qa': 'Hands-on verification of the running product.',
  'final-gate': 'All configured gates and reviews are complete at the current head.',
};

const FAILURE_WORDS = /\b(?:fail|fails|failed|failing|failure|failures|reject|rejects|rejected|rejecting|invalid|malformed|unsupported|error|errors|never|omitted|omission|truncat\w*)\b/i;
const OUTCOME_WORDS = /\b(?:loud|loudly|throw|throws|exit code|error message|reject(?:s|ed)? with|returns?|renders?|markers?|reports?|lists?|exposes?)\b/i;

function capText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_ITEM_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_ITEM_CHARS)} [truncated]`;
}

function matchesToken(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9_])${escaped}(?:$|[^a-z0-9_])`, 'i').test(text);
}

function verificationKind(criterion: string): VerificationKind {
  if (/\b(?:integration|end-to-end|e2e)\b/i.test(criterion)) return 'integration';
  if (/\b(?:manual|manually|screenshot|screenshots|browser|visual|visually|observation|observed)\b/i.test(criterion)) return 'manual-observation';
  if (/\b(?:artifact|artifacts|evidence|issue comment|pr body|docs|documentation)\b/i.test(criterion)) return 'artifact-review';
  if (/\b(?:unit|tests?|tested|fixtures?|asserts?|asserted)\b/i.test(criterion)) return 'unit';
  return 'unspecified';
}

export function extractExpectedPaths(issueText: string): string[] {
  const found = new Set<string>();
  for (const match of issueText.matchAll(/`([^`\n]+)`/g)) {
    const token = match[1].trim().replace(/\\/g, '/').replace(/^\.\//, '');
    // Globs quoted in issue text are patterns, not expected paths.
    if (token.includes('/') && !/[\s*?]/.test(token)) found.add(token);
  }
  for (const match of issueText.matchAll(/\b[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\b/g)) {
    found.add(match[0].replace(/^\.\//, ''));
  }
  return [...found].sort().slice(0, MAX_EXPECTED_PATHS).map(path => capText(path));
}

function buildMatrix(issueText: string): { matrix: BriefMatrix | null; unboundedDimensions: string[] } {
  const selected: BriefMatrixDimension[] = [];
  const unboundedDimensions: string[] = [];
  for (const dimension of MATRIX_DIMENSIONS) {
    const mentioned = dimension.mention.test(issueText);
    const values = dimension.values.filter(value => matchesToken(issueText, value));
    if (values.length >= 2 && (!dimension.requiresMention || mentioned)) {
      selected.push({ name: dimension.name, values });
    } else if (mentioned && values.length <= 1) {
      unboundedDimensions.push(dimension.name);
    }
  }
  if (selected.length === 0) return { matrix: null, unboundedDimensions };

  let rows: string[][] = [[]];
  for (const dimension of selected) {
    rows = rows.flatMap(row => dimension.values.map(value => [...row, value]));
  }
  const omittedRows = Math.max(0, rows.length - MAX_MATRIX_ROWS);
  return { matrix: { dimensions: selected, rows: rows.slice(0, MAX_MATRIX_ROWS), omittedRows }, unboundedDimensions };
}

function splitSentences(text: string): string[] {
  return text.trim().split(/(?<=[.!?])\s+/).map(part => part.trim()).filter(part => part.length > 0);
}

export function buildImplementationBrief(input: { title: string; body: string; config: Config }): ImplementationBrief {
  const issueText = `${input.title}\n${input.body}`;
  const criteria = parseWorkChecklistItems(input.body).map(item => item.text);
  const obligations: BriefObligation[] = criteria
    .slice(0, MAX_OBLIGATIONS)
    .map(criterion => ({ criterion: capText(criterion), kind: verificationKind(criterion) }));
  const omittedObligations = Math.max(0, criteria.length - MAX_OBLIGATIONS);

  const expectedPaths = extractExpectedPaths(issueText);
  const { matrix, unboundedDimensions } = buildMatrix(issueText);

  const cards = selectRiskCards({ issueText, paths: expectedPaths });
  const riskCards = cards.map(card => ({ id: card.id, title: card.title, implementerFace: card.implementerFace.trim() }));

  const expectedLanes: BriefLane[] = activeLocalReviewFocusesForConfig(input.config, expectedPaths)
    .map(lane => ({ lane, heuristic: LANE_HEURISTICS[lane] }));

  const negativeSet = new Set<string>();
  for (const card of cards) {
    for (const sentence of splitSentences(card.implementerFace)) {
      if (implementerFaceHasTestObligation(sentence)) negativeSet.add(capText(sentence));
    }
  }
  for (const obligation of obligations) {
    if (FAILURE_WORDS.test(obligation.criterion)) {
      negativeSet.add(capText(`Write a negative test for: "${obligation.criterion}"`));
    }
  }
  const allNegativeCases = [...negativeSet];
  const negativeCases = allNegativeCases.slice(0, MAX_NEGATIVE_CASES);
  const omittedNegativeCases = allNegativeCases.length - negativeCases.length;

  const allAmbiguities: string[] = [];
  for (const obligation of obligations) {
    if (obligation.kind === 'unspecified') {
      allAmbiguities.push(capText(`No stated verification kind; decide how to verify: "${obligation.criterion}"`));
    }
    if (FAILURE_WORDS.test(obligation.criterion) && !OUTCOME_WORDS.test(obligation.criterion)) {
      allAmbiguities.push(capText(`Failure behavior is not specified; decide the observable outcome for: "${obligation.criterion}"`));
    }
  }
  for (const dimension of unboundedDimensions) {
    allAmbiguities.push(`The issue mentions ${dimension}s without bounding them; enumerate the required ${dimension} values before coding.`);
  }
  const ambiguities = allAmbiguities.slice(0, MAX_AMBIGUITIES);
  const omittedAmbiguities = allAmbiguities.length - ambiguities.length;

  return {
    obligations,
    omittedObligations,
    matrix,
    riskCards,
    expectedLanes,
    negativeCases,
    omittedNegativeCases,
    ambiguities,
    omittedAmbiguities,
    expectedPaths,
    minimal: obligations.length === 0 && matrix === null && riskCards.length === 0,
  };
}
