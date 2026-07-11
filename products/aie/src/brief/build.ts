import type { RepoLayoutInspection } from '@tjalve/qube-core';
import type { Config } from '../config/index.js';
import { parseWorkChecklistItems } from '../core/work_item.js';
import { activeLocalReviewFocusesForConfig, LANE_HEURISTIC_DIGESTS } from '../review_focus.js';
import { implementerFaceHasTestObligation, selectRiskCards } from '../risk_cards/index.js';
import type { BriefLane, BriefLayout, BriefLayoutProject, BriefMatrix, BriefMatrixDimension, BriefObligation, ImplementationBrief, VerificationKind } from './types.js';

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
    // Globs, placeholder templates, and traversal tokens are not repo-relative surfaces.
    if (token.includes('/') && !/[\s*?<>]/.test(token) && !token.split('/').includes('..')) found.add(token);
  }
  // Bare tokens qualify only with a file-extension tail so slash-separated prose
  // such as "multi-provider/multi-mode" or "layout/ownership" is never treated as a path.
  for (const match of issueText.matchAll(/\b[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,6}\b/g)) {
    found.add(match[0].replace(/^\.\//, ''));
  }
  return [...found]
    .filter(path => !path.split('/').includes('..'))
    .sort()
    .slice(0, MAX_EXPECTED_PATHS)
    .map(path => capText(path));
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

const MAX_LAYOUT_PROJECTS = 8;
const MAX_DO_NOT_EDIT_PATHS = 10;

function projectRole(projectPath: string, inspectedKind: string): string {
  // Workspace-prefix roles apply only to direct children; nested projects keep their inspected kind.
  const segments = projectPath.split('/');
  if (segments.length === 2 && segments[0] === 'products') return 'product';
  if (segments.length === 2 && segments[0] === 'packages') return 'package';
  if (segments.length === 2 && segments[0] === 'adapters') return 'adapter';
  return inspectedKind;
}

function isDocumentationSurface(path: string): boolean {
  return path.startsWith('docs/') || path.endsWith('.md');
}

const ROOT_DOT_DIRECTORIES = new Set(['.github', '.qube', '.vscode', '.agents', '.codex']);

function isWorkspaceRootScoped(surfacePath: string): boolean {
  // Top-level files and known root dot-directories are root-owned surfaces; arbitrary
  // hidden directories named in issue text do not claim root ownership.
  return !surfacePath.includes('/') || ROOT_DOT_DIRECTORIES.has(surfacePath.split('/')[0]);
}

function projectContains(projectPath: string, surfacePath: string, rootOwnsUnmatched: boolean): boolean {
  // A root-level project claims arbitrary paths only in single-app layouts; in a
  // multi-project workspace it owns only workspace-root-scoped surfaces, and an
  // unmatched nested path stays unowned rather than defaulting to root.
  if (projectPath === '.' || projectPath === '') return rootOwnsUnmatched || isWorkspaceRootScoped(surfacePath);
  return surfacePath === projectPath || surfacePath.startsWith(`${projectPath}/`);
}

function meaningfulIdentifier(value: string | null): value is string {
  return value !== null && value.trim().length >= 3 && value !== '.';
}

function buildLayout(layout: RepoLayoutInspection | undefined, issueText: string, expectedPaths: readonly string[], expectsTestWork: boolean): BriefLayout | null {
  if (!layout || layout.root === null || layout.projects.length === 0) return null;

  const codeSurfaces = expectedPaths.filter(path => !isDocumentationSurface(path));
  // Documentation-only work renders no layout section, wherever the documentation lives —
  // including pathless documentation issues, unless code-work signals say otherwise.
  if (expectedPaths.length > 0 && codeSurfaces.length === 0) return null;
  if (expectedPaths.length === 0 && !expectsTestWork && /\b(?:readme|docs|documentation|wording|guide)\b/iu.test(issueText)) return null;

  const projects = layout.projects.map(project => ({ ...project, path: project.path.replace(/\\/g, '/') }));
  // A lone root project owns unmatched paths in non-workspace layouts (single-app repos,
  // including generated/vendor-heavy ones); workspace kinds keep could-not-derive instead.
  const rootOnly = projects.every(project => project.path === '.' || project.path === '');
  const rootOwnsUnmatched = layout.kind === 'single-app-service'
    || (rootOnly && layout.kind !== 'javascript-typescript-workspace' && layout.kind !== 'python-workspace-monorepo');
  const owners = new Set<string>();
  // Each expected code surface is owned by the most specific containing project.
  for (const surface of codeSurfaces) {
    const containing = projects
      .filter(project => projectContains(project.path, surface, rootOwnsUnmatched))
      .sort((left, right) => right.path.length - left.path.length);
    if (containing.length > 0) owners.add(containing[0].id);
  }
  for (const project of projects) {
    const nameMentioned = (meaningfulIdentifier(project.packageName) && matchesToken(issueText, project.packageName))
      || (meaningfulIdentifier(project.path) && matchesToken(issueText, project.path))
      || (meaningfulIdentifier(project.id) && matchesToken(issueText, project.id));
    if (nameMentioned) owners.add(project.id);
  }
  const allOwningProjects: BriefLayoutProject[] = projects
    .filter(project => owners.has(project.id))
    .map(project => ({
      name: project.packageName ?? project.id,
      path: project.path,
      role: projectRole(project.path, project.kind),
    }));
  const owningProjects = allOwningProjects.slice(0, MAX_LAYOUT_PROJECTS);
  const omittedProjects = allOwningProjects.length - owningProjects.length;

  const derived = allOwningProjects.length > 0;
  // Boundary rules derive from every owning project, including capped-out ones.
  const roles = new Set(allOwningProjects.map(project => project.role));

  const boundaryRules: string[] = [];
  if (derived) {
    const ownsCorePackage = allOwningProjects.some(project => project.role === 'package'
      && (matchesToken(project.name, 'core') || matchesToken(project.path, 'core')));
    if (ownsCorePackage) boundaryRules.push('Provider-neutral contracts live in core packages; provider-specific behavior does not belong there.');
    if (roles.has('adapter')) boundaryRules.push('Provider-specific encoding lives in the owning adapter, not in core packages or products.');
    if (roles.has('product')) boundaryRules.push('Products consume core contracts rather than duplicating them.');
    if (expectsTestWork) boundaryRules.push('Test support stays inside its own project boundaries.');
  }

  const allDoNotEditPaths = [...layout.generatedPaths, ...layout.vendorPaths]
    .map(signal => `${signal.path} (${signal.reason})`);
  const doNotEditPaths = allDoNotEditPaths.slice(0, MAX_DO_NOT_EDIT_PATHS);
  const omittedDoNotEditPaths = allDoNotEditPaths.length - doNotEditPaths.length;

  return { owningProjects, omittedProjects, boundaryRules, doNotEditPaths, omittedDoNotEditPaths, derived };
}

export function buildImplementationBrief(input: { title: string; body: string; config: Config; layout?: RepoLayoutInspection }): ImplementationBrief {
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
    .map(lane => ({ lane, heuristic: LANE_HEURISTIC_DIGESTS[lane] }));

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
    layout: buildLayout(
      input.layout,
      issueText,
      expectedPaths,
      obligations.some(obligation => obligation.kind === 'unit' || obligation.kind === 'integration')
        || expectedPaths.some(path => /(?:^|\/)tests?\//.test(path) || /\.test\./.test(path))
        || /\bregression\s+tests?\b/iu.test(issueText)
        || splitSentences(issueText).some(sentence => implementerFaceHasTestObligation(sentence)),
    ),
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
