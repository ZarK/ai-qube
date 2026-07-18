import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReviewFinding } from '@tjalve/qube-core';
import { carryForwardDeltaTouched, defaultCarryForwardContext, type CarryForwardContextMode } from './review_focus.js';
import { acceptedProviderLane } from './provider_lane_evidence.js';
import type { ProviderLaneReuse, TrustedProviderLane } from './provider_lane_evidence.js';
import { redact } from './redact.js';

export type LocalReviewStatus = 'passed' | 'failed' | 'needs-work' | 'pending' | 'missing' | 'stale' | 'unavailable' | 'malformed' | 'inconclusive';
export type LocalReviewProfile = 'remote-compatible' | 'local-standard' | 'local-focused' | 'local-comprehensive' | 'local-shadow';
export type LocalReviewSeverity = 'none' | 'low' | 'medium' | 'high' | 'critical';
export type LocalReviewRecommendation = 'approve' | 'request-changes' | 'pending' | 'inconclusive';
export type LocalReviewContextKind = 'agents' | 'issue-body' | 'issue-comment' | 'milestone' | 'functional-requirement' | 'linked-issue' | 'pr-body' | 'pr-comment' | 'review-thread' | 'doc' | 'diff' | 'ci' | 'manual-qa';
export type LocalReviewTrust = 'policy' | 'trusted-provider' | 'repo-doc' | 'untrusted-task-input' | 'local-evidence';
export type LocalReviewFreshness = 'current' | 'stale' | 'unknown' | 'missing' | 'unavailable' | 'not-configured';

export type LocalReviewLaneId =
  | 'task-record-compliance'
  | 'issue-compliance'
  | 'code-quality'
  | 'security'
  | 'performance'
  | 'data-database'
  | 'concurrency-resource'
  | 'error-observability'
  | 'tests-quality'
  | 'api-contract-compatibility'
  | 'docs-instructions'
  | 'ui-ux-accessibility'
  | 'release-ci-supply-chain'
  | 'manual-qa'
  | 'final-gate';

export interface LocalReviewContextReviewed {
  kind: LocalReviewContextKind;
  source: string;
  trust: LocalReviewTrust;
  freshness: LocalReviewFreshness;
}

export interface LocalReviewPromptStackItem {
  id: string;
  source: 'builtin' | 'repo-configured' | 'command-supplied' | 'evidence';
  sourceCategory?: string;
  path: string | null;
  sha256: string | null;
  trust: LocalReviewTrust;
}

export interface LocalReviewRunnerProvenance {
  runnerKind: 'local-command' | 'local-host' | 'manual-evidence' | 'prompt-only';
  host: string;
  freshContext: boolean;
  promptOnly: boolean;
  taskId: string | null;
  sessionId: string | null;
  threadId: string | null;
  promptStackHash: string | null;
  headSha: string;
  providerPublishStatus: string | null;
  model: string | null;
  effort: string | null;
  isolation: 'read-only' | null;
  invocationId: string | null;
  routeSource: 'configured' | 'fallback' | null;
}

export interface LocalReviewLane {
  id: LocalReviewLaneId;
  status: LocalReviewStatus;
  severity: LocalReviewSeverity;
  recommendation: LocalReviewRecommendation;
  summary: string;
  blockers: string[];
  findings: ReviewFinding[];
  artifacts: string[];
  commands: string[];
  surfaces: string[];
  contextReviewed: LocalReviewContextReviewed[];
  promptStack: LocalReviewPromptStackItem[];
  toolsUsed: string[];
  completeness: string;
  preconditions: string[] | null;
  carriedForward: LocalReviewCarriedForward | null;
  runnerProvenance: LocalReviewRunnerProvenance | null;
  origin?: 'local' | 'trusted-provider';
}

export interface LocalReviewCarriedForward {
  fromHeadSha: string;
  priorRunId: string | null;
  deltaSummary: string;
}

export interface CarryForwardScope {
  laneMatchPatterns: Readonly<Record<string, readonly string[]>>;
  contextPatterns: readonly string[];
  laneContextModes?: Readonly<Record<string, CarryForwardContextMode>>;
}

export interface LocalReviewEvidence {
  issueNumber: number | null;
  prNumber: number;
  headSha: string;
  profile: LocalReviewProfile;
  adapter: 'local-command' | 'local-host' | 'manual-evidence' | 'trusted-provider';
  status: LocalReviewStatus;
  path: string | null;
  reviewer: {
    id: string;
    name: string;
    adapterKind: 'local';
  };
  summary: string;
  blockers: string[];
  lanes: LocalReviewLane[];
  contextReviewed: LocalReviewContextReviewed[];
  promptStack: LocalReviewPromptStackItem[];
  runnerProvenance: LocalReviewRunnerProvenance | null;
  recordedAt: string | null;
  stale: boolean;
}

export interface LocalReviewGate {
  required: boolean;
  mode: 'disabled' | 'required' | 'shadow';
  profile: LocalReviewProfile;
  reviewers: string[];
  requiredLanes: LocalReviewLaneId[];
  evidence: LocalReviewEvidence[];
  status: LocalReviewStatus;
  summary: string;
  nextAction: string;
  providerReuse?: ProviderLaneReuse;
}

interface TrustedLocalHostProvenance {
  version: 1;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  lane: LocalReviewLaneId;
  evidenceSha256: string;
  runnerKind: 'local-host';
  host: string;
  freshContext: boolean;
  promptOnly: boolean;
  taskId: string | null;
  sessionId: string | null;
  threadId: string | null;
  promptStackHash: string;
  recordedAt: string;
  model: string | null;
  effort: string | null;
  isolation: 'read-only' | null;
  invocationId: string | null;
  routeSource: 'configured' | 'fallback' | null;
}

interface LocalReviewPublishEvidence {
  version: 1;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  provider: string;
  status: string;
}

export const CORE_REVIEW_FOCUSES: readonly LocalReviewLaneId[] = [
  'issue-compliance',
  'code-quality',
  'performance',
];

export const REQUIRED_LOCAL_REVIEW_LANES: readonly LocalReviewLaneId[] = [
  'task-record-compliance',
  'issue-compliance',
  'code-quality',
  'tests-quality',
  'manual-qa',
  'final-gate',
];

export const COMPREHENSIVE_LOCAL_REVIEW_LANES: readonly LocalReviewLaneId[] = [
  'task-record-compliance',
  'issue-compliance',
  'code-quality',
  'security',
  'performance',
  'data-database',
  'concurrency-resource',
  'error-observability',
  'tests-quality',
  'api-contract-compatibility',
  'docs-instructions',
  'ui-ux-accessibility',
  'release-ci-supply-chain',
  'manual-qa',
  'final-gate',
];

const REQUIRED_TASK_CONTEXT: readonly LocalReviewContextKind[] = [
  'agents',
  'issue-body',
  'issue-comment',
  'milestone',
  'functional-requirement',
  'linked-issue',
  'pr-body',
  'pr-comment',
  'review-thread',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? redact(value.trim()) : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map(redact) : [];
}

function readFindingSeverity(value: unknown): ReviewFinding['severity'] {
  return value === 'blocking' ? 'blocking' : 'advisory';
}

function readFindings(value: unknown): ReviewFinding[] {
  if (!Array.isArray(value)) return [];
  const findings: ReviewFinding[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const message = typeof entry.message === 'string' && entry.message.trim() !== '' ? redact(entry.message.trim()) : '';
    if (message === '') continue;
    const location = isRecord(entry.location) && typeof entry.location.path === 'string' && entry.location.path.trim() !== ''
      ? {
          path: redact(entry.location.path.trim()),
          ...(typeof entry.location.line === 'number' && Number.isSafeInteger(entry.location.line) && entry.location.line > 0 ? { line: entry.location.line } : {}),
          ...(typeof entry.location.endLine === 'number' && Number.isSafeInteger(entry.location.endLine) && entry.location.endLine > 0 ? { endLine: entry.location.endLine } : {}),
          side: entry.location.side === 'source' ? 'source' as const : 'destination' as const,
        }
      : undefined;
    findings.push({
      id: typeof entry.id === 'string' && entry.id.trim() !== '' ? redact(entry.id.trim()) : `finding-${findings.length + 1}`,
      severity: readFindingSeverity(entry.severity),
      ...(location ? { location } : {}),
      message,
      ...(typeof entry.suggestion === 'string' && entry.suggestion.trim() !== '' ? { suggestion: redact(entry.suggestion.trim()) } : {}),
    });
  }
  return findings;
}

function artifactArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const artifacts: string[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const kind = stringValue(item.kind, 'artifact');
    const path = typeof item.path === 'string' && item.path.trim() !== '' ? redact(item.path.trim()) : '';
    const sha = typeof item.sha256 === 'string' && item.sha256.trim() !== '' ? `#${redact(item.sha256.trim())}` : '';
    artifacts.push(path === '' ? kind : `${kind}:${path}${sha}`);
  }
  return artifacts;
}

function readSeverity(value: unknown): LocalReviewSeverity {
  if (value === 'none' || value === 'low' || value === 'medium' || value === 'high' || value === 'critical') return value;
  return 'none';
}

function readCarriedForward(value: unknown): LocalReviewCarriedForward | null {
  if (!isRecord(value)) return null;
  if (typeof value.fromHeadSha !== 'string' || value.fromHeadSha.trim() === '') return null;
  return {
    fromHeadSha: redact(value.fromHeadSha.trim()),
    priorRunId: typeof value.priorRunId === 'string' && value.priorRunId.trim() !== '' ? redact(value.priorRunId.trim()) : null,
    deltaSummary: typeof value.deltaSummary === 'string' ? redact(value.deltaSummary.trim()) : '',
  };
}

function readRecommendation(value: unknown, status: LocalReviewStatus): LocalReviewRecommendation {
  if (value === 'approve' || value === 'request-changes' || value === 'pending' || value === 'inconclusive') return value;
  if (status === 'passed') return 'approve';
  if (status === 'failed' || status === 'needs-work') return 'request-changes';
  if (status === 'inconclusive' || status === 'unavailable' || status === 'malformed') return 'inconclusive';
  return 'pending';
}

function readStatus(value: unknown): LocalReviewStatus {
  if (value === 'passed' || value === 'failed' || value === 'needs-work' || value === 'pending' || value === 'missing' || value === 'stale' || value === 'unavailable' || value === 'inconclusive') return value;
  return 'malformed';
}

const RECOMMENDATION_STATUS_PAIRS: Readonly<Record<LocalReviewRecommendation, readonly LocalReviewStatus[]>> = {
  approve: ['passed'],
  'request-changes': ['failed', 'needs-work'],
  pending: ['pending', 'missing', 'stale'],
  inconclusive: ['inconclusive', 'unavailable', 'malformed'],
};

export function validRecommendationStatus(recommendation: LocalReviewRecommendation, status: LocalReviewStatus): boolean {
  return RECOMMENDATION_STATUS_PAIRS[recommendation].includes(status);
}

export function recommendationStatusRule(): string {
  return Object.entries(RECOMMENDATION_STATUS_PAIRS).map(([recommendation, statuses]) => `${recommendation} requires status ${statuses.join(' or ')}`).join('; ');
}

function readLaneId(value: unknown): LocalReviewLaneId | null {
  if (
    value === 'task-record-compliance' ||
    value === 'issue-compliance' ||
    value === 'code-quality' ||
    value === 'security' ||
    value === 'performance' ||
    value === 'data-database' ||
    value === 'concurrency-resource' ||
    value === 'error-observability' ||
    value === 'tests-quality' ||
    value === 'api-contract-compatibility' ||
    value === 'docs-instructions' ||
    value === 'ui-ux-accessibility' ||
    value === 'release-ci-supply-chain' ||
    value === 'manual-qa' ||
    value === 'final-gate'
  ) return value;
  if (value === 'security-maintainability') return 'security';
  if (value === 'qa') return 'manual-qa';
  return null;
}

function readProfile(value: unknown, fallback: LocalReviewProfile): LocalReviewProfile {
  if (value === 'remote-compatible' || value === 'local-standard' || value === 'local-focused' || value === 'local-comprehensive' || value === 'local-shadow') return value;
  return fallback;
}

function readContextKind(value: unknown): LocalReviewContextKind | null {
  if (
    value === 'agents' ||
    value === 'issue-body' ||
    value === 'issue-comment' ||
    value === 'milestone' ||
    value === 'functional-requirement' ||
    value === 'linked-issue' ||
    value === 'pr-body' ||
    value === 'pr-comment' ||
    value === 'review-thread' ||
    value === 'doc' ||
    value === 'diff' ||
    value === 'ci' ||
    value === 'manual-qa'
  ) return value;
  return null;
}

function readTrust(value: unknown): LocalReviewTrust {
  if (value === 'policy' || value === 'trusted-provider' || value === 'repo-doc' || value === 'untrusted-task-input' || value === 'local-evidence') return value;
  return 'local-evidence';
}

function readFreshness(value: unknown): LocalReviewFreshness {
  if (value === 'current' || value === 'stale' || value === 'unknown' || value === 'missing' || value === 'unavailable' || value === 'not-configured') return value;
  return 'unknown';
}

function readContextReviewed(value: unknown): LocalReviewContextReviewed[] {
  if (!Array.isArray(value)) return [];
  const contexts: LocalReviewContextReviewed[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const kind = readContextKind(entry.kind);
    if (!kind) continue;
    contexts.push({
      kind,
      source: stringValue(entry.source, kind),
      trust: readTrust(entry.trust),
      freshness: readFreshness(entry.freshness),
    });
  }
  return contexts;
}

function readPromptStack(value: unknown): LocalReviewPromptStackItem[] {
  if (!Array.isArray(value)) return [];
  const stack: LocalReviewPromptStackItem[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      const id = entry.trim();
      if (id === '') continue;
      stack.push({
        id: redact(id),
        source: 'evidence',
        path: null,
        sha256: null,
        trust: 'local-evidence',
      });
      continue;
    }
    if (!isRecord(entry)) continue;
    const source = entry.source === 'builtin' || entry.source === 'repo-configured' || entry.source === 'command-supplied' || entry.source === 'evidence' ? entry.source : 'evidence';
    stack.push({
      id: stringValue(entry.id, 'unknown-prompt-fragment'),
      source,
      sourceCategory: typeof entry.sourceCategory === 'string' && entry.sourceCategory.trim() !== '' ? redact(entry.sourceCategory.trim()) : undefined,
      path: typeof entry.path === 'string' && entry.path.trim() !== '' ? redact(entry.path.trim()) : null,
      sha256: typeof entry.sha256 === 'string' && entry.sha256.trim() !== '' ? redact(entry.sha256.trim()) : null,
      trust: readTrust(entry.trust),
    });
  }
  return stack;
}

function readNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? redact(value.trim()) : null;
}

function readRunnerKind(value: unknown): LocalReviewRunnerProvenance['runnerKind'] {
  if (value === 'local-command' || value === 'local-host' || value === 'manual-evidence' || value === 'prompt-only') return value;
  return 'manual-evidence';
}

function readRunnerProvenance(value: unknown): LocalReviewRunnerProvenance | null {
  if (!isRecord(value)) return null;
  return {
    runnerKind: readRunnerKind(value.runnerKind),
    host: stringValue(value.host, 'unknown-host'),
    freshContext: value.freshContext === true,
    promptOnly: value.promptOnly === true,
    taskId: readNullableString(value.taskId),
    sessionId: readNullableString(value.sessionId),
    threadId: readNullableString(value.threadId),
    promptStackHash: readNullableString(value.promptStackHash),
    headSha: stringValue(value.headSha, 'unknown-head'),
    providerPublishStatus: readNullableString(value.providerPublishStatus),
    model: readNullableString(value.model),
    effort: readNullableString(value.effort),
    isolation: value.isolation === 'read-only' ? 'read-only' : null,
    invocationId: readNullableString(value.invocationId),
    routeSource: value.routeSource === 'configured' || value.routeSource === 'fallback' ? value.routeSource : null,
  };
}

export function requiredLocalReviewLanes(profile: LocalReviewProfile): readonly LocalReviewLaneId[] {
  if (profile === 'local-comprehensive' || profile === 'local-shadow') return COMPREHENSIVE_LOCAL_REVIEW_LANES;
  if (profile === 'local-focused') return CORE_REVIEW_FOCUSES;
  if (profile === 'local-standard') return REQUIRED_LOCAL_REVIEW_LANES;
  return [];
}

function effectiveProfile(profile: LocalReviewProfile, required: boolean, shadow: boolean): LocalReviewProfile {
  if (shadow) return 'local-shadow';
  if (required && profile === 'remote-compatible') return 'local-standard';
  return profile;
}

function safeSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function evidencePath(repoRoot: string, issueNumber: number, prNumber: number, headSha: string): string {
  return join(repoRoot, '.qube', 'aie', 'pr-reviews', `issue-${issueNumber}`, `pr-${prNumber}`, `${safeSegment(headSha)}.json`);
}

function evidenceDirectory(repoRoot: string, issueNumber: number, prNumber: number): string {
  return join(repoRoot, '.qube', 'aie', 'pr-reviews', `issue-${issueNumber}`, `pr-${prNumber}`);
}

function laneEvidenceDirectory(repoRoot: string, issueNumber: number, prNumber: number, headSha: string): string {
  return join(repoRoot, '.qube', 'aie', 'reviews', String(issueNumber), String(prNumber), safeSegment(headSha));
}

function laneEvidencePath(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, lane: LocalReviewLaneId): string {
  return join(laneEvidenceDirectory(repoRoot, issueNumber, prNumber, headSha), `${lane}.json`);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// One contract statement feeds both the lane spawn prompts and the publish
// validator so the required artifact forms can never drift between them.
export const LANE_ARTIFACT_REQUIREMENT = 'Terminal lane results (passed, failed, needs-work) must include at least one artifact reference. Accepted artifact shapes: {"kind":"...","path":"...","sha256":...} where kind names the inspected surface, path is an existing repository-relative file path (or begins with "command:" for kind "command" observations), and sha256 is the lowercase SHA-256 digest of that file or null.';

export function laneArtifactViolation(lane: string, status: string, artifacts: unknown, repoRoot?: string): string | null {
  if (!Array.isArray(artifacts)) return `${lane} artifacts must be an array.`;
  for (const entry of artifacts) {
    if (!isRecord(entry) || typeof entry.kind !== 'string' || entry.kind.trim() === '' || typeof entry.path !== 'string' || entry.path.trim() === '') {
      return `${lane} artifacts contains an entry without a non-empty kind and path.`;
    }
    const path = entry.path;
    if (entry.kind === 'command') {
      if (!path.startsWith('command:')) return `${lane} artifacts contains a command entry whose path does not begin with "command:".`;
    } else if (path.startsWith('command:')) {
      return `${lane} artifacts contains a "command:" path under kind ${entry.kind}; command observations must use kind "command".`;
    } else {
      const segments = path.replace(/\\/g, '/').split('/');
      if (/^([a-zA-Z]:|\/|\\)/.test(path) || segments.includes('..')) {
        return `${lane} artifacts contains a non-repository-relative or traversal path: ${path}.`;
      }
      if (repoRoot && !existsSync(join(repoRoot, path))) {
        return `${lane} artifacts references a file that does not exist in the repository: ${path}.`;
      }
      if (entry.sha256 !== null && entry.sha256 !== undefined) {
        if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
          return `${lane} artifacts contains an invalid sha256 for ${path}; use the lowercase SHA-256 digest of the file or null.`;
        }
        if (repoRoot) {
          try {
            const digest = createHash('sha256').update(readFileSync(join(repoRoot, path))).digest('hex');
            if (digest !== entry.sha256) return `${lane} artifacts sha256 does not match the current content of ${path}.`;
          } catch {
            return `${lane} artifacts references a file that could not be read for digest verification: ${path}.`;
          }
        }
      }
    }
  }
  const terminal = status === 'passed' || status === 'failed' || status === 'needs-work';
  if (terminal && artifacts.length === 0) {
    return `${lane} ${status} evidence has an empty artifacts array; a ${status} lane must cite at least one inspected artifact.`;
  }
  return null;
}

export function localReviewEvidenceSha256(value: unknown): string {
  return hash(canonicalJson(value));
}

export function trustedLocalHostProvenancePath(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, lane: LocalReviewLaneId): string {
  return join(repoRoot, '.git', 'qube', 'aie', 'host-provenance', String(issueNumber), String(prNumber), safeSegment(headSha), `${lane}.json`);
}

function fallbackReviewer(reviewers: readonly string[]): LocalReviewEvidence['reviewer'] {
  const first = reviewers.map(name => name.trim()).find(name => name !== '') ?? 'local-reviewer';
  return { id: safeSegment(first), name: redact(first), adapterKind: 'local' };
}

function malformedEvidence(issueNumber: number | null, prNumber: number, headSha: string, path: string | null, summary: string, reviewers: readonly string[], profile: LocalReviewProfile): LocalReviewEvidence {
  return {
    issueNumber,
    prNumber,
    headSha: redact(headSha),
    profile,
    adapter: 'manual-evidence',
    status: 'malformed',
    path: path ? redact(path) : null,
    reviewer: fallbackReviewer(reviewers),
    summary,
    blockers: [summary],
    lanes: [],
    contextReviewed: [],
    promptStack: [],
    runnerProvenance: null,
    recordedAt: null,
    stale: false,
  };
}

function missingEvidence(issueNumber: number | null, prNumber: number, headSha: string, path: string | null, reviewers: readonly string[], profile: LocalReviewProfile): LocalReviewEvidence {
  return {
    issueNumber,
    prNumber,
    headSha: redact(headSha),
    profile,
    adapter: 'manual-evidence',
    status: 'missing',
    path: path ? redact(path) : null,
    reviewer: fallbackReviewer(reviewers),
    summary: issueNumber === null
      ? 'Local review evidence requires a linked issue number before it can satisfy the PR gate.'
      : 'No local review evidence is recorded for this issue, pull request, and PR head.',
    blockers: [],
    lanes: [],
    contextReviewed: [],
    promptStack: [],
    runnerProvenance: null,
    recordedAt: null,
    stale: false,
  };
}

function staleEvidence(issueNumber: number, prNumber: number, headSha: string, path: string, reviewers: readonly string[], profile: LocalReviewProfile): LocalReviewEvidence {
  return {
    issueNumber,
    prNumber,
    headSha: redact(headSha),
    profile,
    adapter: 'manual-evidence',
    status: 'stale',
    path: redact(path),
    reviewer: fallbackReviewer(reviewers),
    summary: 'Local review evidence exists for an older PR head. Rerun local review lanes for the current head.',
    blockers: [],
    lanes: [],
    contextReviewed: [],
    promptStack: [],
    runnerProvenance: null,
    recordedAt: null,
    stale: true,
  };
}

function readLanes(value: unknown, fallbackProvenance: LocalReviewRunnerProvenance | null = null): LocalReviewLane[] | null {
  if (!Array.isArray(value)) return null;
  const lanes: LocalReviewLane[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const id = readLaneId(entry.id);
    if (!id) return null;
    const status = readStatus(entry.status);
    lanes.push({
      id,
      status,
      severity: readSeverity(entry.severity),
      recommendation: readRecommendation(entry.recommendation, status),
      summary: stringValue(entry.summary, `${id} local review lane did not provide a summary.`),
      blockers: stringArray(entry.blockers),
      findings: readFindings(entry.findings),
      artifacts: artifactArray(entry.artifacts),
      commands: stringArray(entry.commands),
      surfaces: stringArray(entry.surfaces),
      contextReviewed: readContextReviewed(entry.contextReviewed),
      promptStack: readPromptStack(entry.promptStack),
      toolsUsed: stringArray(entry.toolsUsed),
      completeness: typeof entry.completeness === 'string' ? redact(entry.completeness.trim()) : '',
      preconditions: Array.isArray(entry.preconditions) ? stringArray(entry.preconditions) : null,
      carriedForward: readCarriedForward(entry.carriedForward),
      runnerProvenance: readRunnerProvenance(entry.runnerProvenance) ?? fallbackProvenance,
    });
  }
  return lanes;
}

function missingRequiredContext(lanes: readonly LocalReviewLane[], profile: LocalReviewProfile): LocalReviewContextKind[] {
  if (profile !== 'local-comprehensive' && profile !== 'local-shadow') return [];
  const reviewed = new Set(lanes.flatMap(lane => lane.contextReviewed).filter(context => context.freshness === 'current').map(context => context.kind));
  return REQUIRED_TASK_CONTEXT.filter(kind => !reviewed.has(kind));
}

function severityRank(severity: LocalReviewSeverity): number {
  return {
    none: 0,
    low: 1,
    medium: 2,
    high: 3,
    critical: 4,
  }[severity];
}

function laneExceedsThreshold(lane: LocalReviewLane, threshold: LocalReviewSeverity): boolean {
  if (lane.findings.some(finding => finding.severity === 'blocking')) return true;
  if (lane.severity === 'none') return false;
  if (severityRank(lane.severity) < severityRank(threshold)) return false;
  return lane.recommendation === 'request-changes' || lane.blockers.length > 0;
}

function thresholdBlockers(lanes: readonly LocalReviewLane[], threshold: LocalReviewSeverity): string[] {
  return lanes
    .filter(lane => laneExceedsThreshold(lane, threshold))
    .map(lane => lane.findings.some(finding => finding.severity === 'blocking')
      ? `${lane.id} recorded blocking structured findings.`
      : `${lane.id} recorded ${lane.severity} severity at or above the ${threshold} threshold.`);
}

function evidenceContractBlockers(lanes: readonly LocalReviewLane[], profile: LocalReviewProfile, promptStack: readonly LocalReviewPromptStackItem[], requiredLanes: readonly LocalReviewLaneId[] = requiredLocalReviewLanes(profile)): string[] {
  const blockers: string[] = [];
  if (requiredLanes.length > 0 && promptStack.length === 0) {
    blockers.push(`Local review evidence for ${profile} must include a non-empty top-level promptStack.`);
  }
  const lanesById = new Map(lanes.map(lane => [lane.id, lane]));
  for (const lane of lanes) {
    if (!validRecommendationStatus(lane.recommendation, lane.status)) {
      blockers.push(`${lane.id} recommendation ${lane.recommendation} is not valid with status ${lane.status}; ${recommendationStatusRule()}.`);
    }
    if (lane.findings.some(finding => finding.severity === 'blocking')
      && (lane.status === 'passed' || lane.recommendation !== 'request-changes')) {
      blockers.push(`${lane.id} recorded blocking structured findings but claimed status ${lane.status} with recommendation ${lane.recommendation}.`);
    }
  }
  for (const laneId of requiredLanes) {
    const lane = lanesById.get(laneId);
    if (!lane || lane.status !== 'passed') continue;
    if (lane.artifacts.length === 0) blockers.push(`${laneId} passed without artifact references.`);
    if (lane.promptStack.length === 0) blockers.push(`${laneId} passed without promptStack coverage.`);
    if (lane.preconditions === null) blockers.push(`${laneId} passed without a preconditions record.`);
  }
  const finalGate = lanesById.get('final-gate');
  if (requiredLanes.includes('final-gate') && finalGate) {
    if (finalGate.status !== 'passed' || finalGate.recommendation !== 'approve') {
      blockers.push('final-gate must pass with recommendation approve before local review evidence can satisfy the gate.');
    }
  }
  return blockers;
}

function promptHashKey(issueNumber: number, laneId: LocalReviewLaneId): string {
  return `${issueNumber}:${laneId}`;
}

function explicitExpectedPromptHash(input: { issueNumber: number; laneId: LocalReviewLaneId; expectedPromptStackHashes?: Readonly<Record<string, string>> }): string | null {
  return input.expectedPromptStackHashes?.[promptHashKey(input.issueNumber, input.laneId)]
    ?? input.expectedPromptStackHashes?.[input.laneId]
    ?? null;
}

function readTrustedLocalHostProvenance(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, laneId: LocalReviewLaneId): TrustedLocalHostProvenance | null {
  const path = trustedLocalHostProvenancePath(repoRoot, issueNumber, prNumber, headSha, laneId);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(parsed) || parsed.version !== 1) return null;
    if (parsed.issueNumber !== issueNumber || parsed.prNumber !== prNumber || parsed.headSha !== headSha || parsed.lane !== laneId) return null;
    if (parsed.runnerKind !== 'local-host' || typeof parsed.host !== 'string' || parsed.host.trim() === '') return null;
    if (typeof parsed.evidenceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.evidenceSha256)) return null;
    if (parsed.freshContext !== true || parsed.promptOnly === true || typeof parsed.promptStackHash !== 'string' || parsed.promptStackHash.trim() === '') return null;
    return {
      version: 1,
      issueNumber,
      prNumber,
      headSha,
      lane: laneId,
      evidenceSha256: parsed.evidenceSha256,
      runnerKind: 'local-host',
      host: parsed.host,
      freshContext: parsed.freshContext,
      promptOnly: parsed.promptOnly === true,
      taskId: readNullableString(parsed.taskId),
      sessionId: readNullableString(parsed.sessionId),
      threadId: readNullableString(parsed.threadId),
      promptStackHash: parsed.promptStackHash,
      recordedAt: typeof parsed.recordedAt === 'string' ? parsed.recordedAt : '',
      model: readNullableString(parsed.model),
      effort: readNullableString(parsed.effort),
      isolation: parsed.isolation === 'read-only' ? 'read-only' : null,
      invocationId: readNullableString(parsed.invocationId),
      routeSource: parsed.routeSource === 'configured' || parsed.routeSource === 'fallback' ? parsed.routeSource : null,
    };
  } catch {
    return null;
  }
}

function trustedLocalHostBlockers(input: {
  repoRoot: string;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  laneId: LocalReviewLaneId;
  provenance: LocalReviewRunnerProvenance;
  evidenceSha256: string | null;
}): string[] {
  if (input.provenance.runnerKind !== 'local-host') return [];
  const trusted = readTrustedLocalHostProvenance(input.repoRoot, input.issueNumber, input.prNumber, input.headSha, input.laneId);
  if (!trusted) return [`${input.laneId} local-host evidence was not bound to a host provenance record.`];
  const blockers: string[] = [];
  if (!input.evidenceSha256) blockers.push(`${input.laneId} local-host evidence could not be bound to a canonical evidence digest.`);
  if (input.evidenceSha256 && trusted.evidenceSha256 !== input.evidenceSha256) blockers.push(`${input.laneId} local-host evidence digest does not match the host provenance record.`);
  if (trusted.host !== input.provenance.host) blockers.push(`${input.laneId} local-host provenance host does not match the host record.`);
  if (trusted.promptStackHash !== input.provenance.promptStackHash) blockers.push(`${input.laneId} local-host provenance prompt stack hash does not match the host record.`);
  if (trusted.taskId !== input.provenance.taskId || trusted.sessionId !== input.provenance.sessionId || trusted.threadId !== input.provenance.threadId) blockers.push(`${input.laneId} local-host provenance task, session, or thread id does not match the host record.`);
  if (trusted.model !== input.provenance.model || trusted.effort !== input.provenance.effort || trusted.isolation !== input.provenance.isolation || trusted.invocationId !== input.provenance.invocationId) blockers.push(`${input.laneId} routed model provenance does not match the trusted host record.`);
  if (!trusted.taskId && !trusted.sessionId && !trusted.threadId) blockers.push(`${input.laneId} host provenance did not record a separate task, session, or thread id.`);
  return blockers;
}

type LaneAdapterMap = ReadonlyMap<LocalReviewLaneId, LocalReviewEvidence['adapter']>;

function adapterMap(lanes: readonly LocalReviewLane[], adapter: LocalReviewEvidence['adapter']): LaneAdapterMap {
  return new Map(lanes.map(lane => [lane.id, adapter]));
}

export function gitDeltaPathsSync(repoRoot: string, fromHeadSha: string, toHeadSha: string): string[] | null {
  try {
    const output = execFileSync('git', ['-C', repoRoot, 'diff', '--name-only', `${fromHeadSha}..${toHeadSha}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return output.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '');
  } catch {
    return null;
  }
}

function provenanceBlockers(lanes: readonly LocalReviewLane[], profile: LocalReviewProfile, adapters: LaneAdapterMap, shadow: boolean, headSha: string, issueNumber: number, prNumber: number, repoRoot: string, expectedPromptStackHashes?: Readonly<Record<string, string>>, evidenceHashes?: ReadonlyMap<LocalReviewLaneId, string>, requiredLanes: readonly LocalReviewLaneId[] = requiredLocalReviewLanes(profile), carryForwardScope?: CarryForwardScope): string[] {
  if (shadow || requiredLanes.length === 0) return [];
  const blockers: string[] = [];
  const lanesById = new Map(lanes.map(lane => [lane.id, lane]));
  for (const laneId of requiredLanes) {
    const lane = lanesById.get(laneId);
    if (!lane) continue;
    const adapter = adapters.get(laneId) ?? 'manual-evidence';
    if (adapter === 'manual-evidence') continue;
    const provenance = lane.runnerProvenance;
    if (!provenance) {
      if (lane.status === 'passed') blockers.push(`${laneId} passed without independent reviewer runner provenance.`);
      continue;
    }
    if (provenance.runnerKind !== adapter) blockers.push(`${laneId} runner provenance kind ${provenance.runnerKind} does not match evidence adapter ${adapter}.`);
    if (!provenance.freshContext) blockers.push(`${laneId} did not record fresh independent reviewer context.`);
    if (provenance.promptOnly) blockers.push(`${laneId} was prompt-only output and cannot satisfy a required local review gate.`);
    if (!provenance.taskId && !provenance.sessionId && !provenance.threadId) blockers.push(`${laneId} runner provenance did not record a separate task, session, or thread id.`);
    if (!provenance.promptStackHash) {
      blockers.push(`${laneId} runner provenance did not record a prompt stack hash.`);
    } else if (!lane.carriedForward) {
      const expectedPromptStackHash = explicitExpectedPromptHash({ issueNumber, laneId, expectedPromptStackHashes });
      if (expectedPromptStackHash && provenance.promptStackHash !== expectedPromptStackHash) {
        blockers.push(`${laneId} runner provenance prompt stack hash does not match the current QUBE prompt stack.`);
      }
    }
    if (lane.carriedForward) {
      if (provenance.headSha !== lane.carriedForward.fromHeadSha) blockers.push(`${laneId} carried-forward provenance does not reference the prior head it claims.`);
      const prior = readApprovedLaneEvidenceAt(repoRoot, issueNumber, prNumber, lane.carriedForward.fromHeadSha, laneId);
      if (!prior) {
        blockers.push(`${laneId} carried-forward evidence does not reference an approved prior-head lane record.`);
      } else {
        blockers.push(...trustedLocalHostBlockers({ repoRoot, issueNumber, prNumber, headSha: lane.carriedForward.fromHeadSha, laneId, provenance, evidenceSha256: prior.evidenceSha256 }));
      }
      const deltaPaths = gitDeltaPathsSync(repoRoot, lane.carriedForward.fromHeadSha, headSha);
      if (deltaPaths === null) {
        blockers.push(`${laneId} carried-forward delta from ${lane.carriedForward.fromHeadSha} could not be verified with git.`);
      } else if (carryForwardDeltaTouched(deltaPaths, carryForwardScope?.laneMatchPatterns[laneId] ?? [], carryForwardScope?.contextPatterns ?? [], carryForwardScope?.laneContextModes?.[laneId] ?? defaultCarryForwardContext(laneId))) {
        blockers.push(`${laneId} carried-forward evidence is invalid because the head delta touches the lane scope or review context.`);
      }
    } else {
      if (provenance.headSha !== headSha) blockers.push(`${laneId} runner provenance did not record the current PR head SHA.`);
      blockers.push(...trustedLocalHostBlockers({ repoRoot, issueNumber, prNumber, headSha, laneId, provenance, evidenceSha256: evidenceHashes?.get(laneId) ?? null }));
    }
  }
  return blockers;
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function laneStatus(lanes: readonly LocalReviewLane[], profile: LocalReviewProfile, threshold: LocalReviewSeverity, requiredLanes: readonly LocalReviewLaneId[] = requiredLocalReviewLanes(profile)): LocalReviewStatus {
  for (const lane of lanes) if (lane.status === 'malformed') return 'malformed';
  for (const lane of lanes) if (lane.status === 'unavailable') return 'unavailable';
  for (const lane of lanes) if (lane.status === 'failed') return 'failed';
  for (const lane of lanes) if (laneExceedsThreshold(lane, threshold)) return 'failed';
  for (const lane of lanes) if (lane.status === 'needs-work') return 'needs-work';
  for (const lane of lanes) if (lane.status === 'inconclusive') return 'inconclusive';
  for (const lane of lanes) if (lane.status === 'stale') return 'stale';
  for (const lane of lanes) if (lane.status === 'pending') return 'pending';
  const byId = new Map(lanes.map(lane => [lane.id, lane]));
  for (const laneId of requiredLanes) {
    if (!byId.has(laneId)) return 'missing';
    if (byId.get(laneId)?.status !== 'passed') return 'pending';
  }
  if (missingRequiredContext(lanes, profile).length > 0) return 'inconclusive';
  return 'passed';
}

function reviewerFrom(value: unknown, reviewers: readonly string[]): LocalReviewEvidence['reviewer'] {
  if (!isRecord(value)) return fallbackReviewer(reviewers);
  const id = stringValue(value.id, '');
  const name = stringValue(value.name, id || 'local-reviewer');
  return { id: safeSegment(id || name), name, adapterKind: 'local' };
}

function readAdapter(value: unknown): LocalReviewEvidence['adapter'] {
  if (value === 'local-command' || value === 'local-host' || value === 'manual-evidence') return value;
  return 'manual-evidence';
}

function statusWithAdapter(status: LocalReviewStatus, adapter: LocalReviewEvidence['adapter'], shadow: boolean): LocalReviewStatus {
  if (shadow) return status;
  if (adapter === 'manual-evidence' && status === 'passed') return 'inconclusive';
  return status;
}

function adapterBlockers(adapter: LocalReviewEvidence['adapter'], status: LocalReviewStatus, shadow: boolean): string[] {
  if (shadow || adapter !== 'manual-evidence' || status !== 'inconclusive') return [];
  return ['Manual local review evidence is unverified and cannot satisfy a required local review gate without local-command or local-host provenance.'];
}

function evidenceSchemaVersion(parsed: Record<string, unknown>): unknown {
  return parsed.version ?? parsed.schemaVersion;
}

function parseEvidence(path: string, repoRoot: string, issueNumber: number, prNumber: number, headSha: string, reviewers: readonly string[], profile: LocalReviewProfile, severityThreshold: LocalReviewSeverity, shadow: boolean, expectedPromptStackHashes?: Readonly<Record<string, string>>): LocalReviewEvidence {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(parsed)) return malformedEvidence(issueNumber, prNumber, headSha, path, 'Local review evidence JSON must be an object.', reviewers, profile);
    if (evidenceSchemaVersion(parsed) !== 1) return malformedEvidence(issueNumber, prNumber, headSha, path, 'Local review evidence version must be 1.', reviewers, profile);
    if (parsed.issueNumber !== issueNumber || parsed.prNumber !== prNumber) return malformedEvidence(issueNumber, prNumber, headSha, path, 'Local review evidence issue or PR metadata does not match this gate.', reviewers, profile);
    if (typeof parsed.headSha !== 'string' || parsed.headSha.trim() === '') return malformedEvidence(issueNumber, prNumber, headSha, path, 'Local review evidence headSha metadata must be a non-empty string for this gate.', reviewers, profile);
    if (parsed.headSha !== headSha) return staleEvidence(issueNumber, prNumber, headSha, path, reviewers, profile);
    const adapter = readAdapter(parsed.adapter);
    const runnerProvenance = readRunnerProvenance(parsed.runnerProvenance);
    const lanes = readLanes(parsed.lanes, runnerProvenance);
    if (!lanes) return malformedEvidence(issueNumber, prNumber, headSha, path, 'Local review evidence must include a lanes array with known lane ids.', reviewers, profile);
    const evidenceHash = localReviewEvidenceSha256(parsed);
    const evidenceHashes = new Map(lanes.map(lane => [lane.id, evidenceHash]));
    const contextReviewed = readContextReviewed(parsed.contextReviewed);
    const promptStack = readPromptStack(parsed.promptStack);
    const missingContext = missingRequiredContext(lanes, profile);
    const contextBlockers = missingContext.map(kind => `Local review evidence did not record current ${kind} context for the ${profile} profile.`);
    const contractBlockers = evidenceContractBlockers(lanes, profile, promptStack);
    const runnerBlockers = provenanceBlockers(lanes, profile, adapterMap(lanes, adapter), shadow, headSha, issueNumber, prNumber, repoRoot, expectedPromptStackHashes, evidenceHashes);
    const computedLaneStatus = laneStatus(lanes, profile, severityThreshold);
    const rawStatus = computedLaneStatus === 'passed' && contractBlockers.length > 0 ? 'failed' : computedLaneStatus === 'passed' && runnerBlockers.length > 0 ? 'inconclusive' : computedLaneStatus;
    const status = statusWithAdapter(rawStatus, adapter, shadow);
    const blockers = [...stringArray(parsed.blockers), ...lanes.flatMap(lane => lane.blockers), ...thresholdBlockers(lanes, severityThreshold), ...contractBlockers, ...runnerBlockers, ...adapterBlockers(adapter, status, shadow)].filter((value, index, values) => values.indexOf(value) === index);
    return {
      issueNumber,
      prNumber,
      headSha: redact(headSha),
      profile,
      adapter,
      status,
      path: redact(path),
      reviewer: reviewerFrom(parsed.reviewer, reviewers),
      summary: stringValue(parsed.summary, status === 'passed' ? 'All required local review lanes passed.' : status === 'inconclusive' ? `Local review evidence is inconclusive because required task context was not reviewed: ${missingContext.join(', ')}.` : 'Local review evidence requires attention.'),
      blockers: [...blockers, ...contextBlockers],
      lanes,
      contextReviewed,
      promptStack,
      runnerProvenance,
      recordedAt: typeof parsed.recordedAt === 'string' ? redact(parsed.recordedAt) : null,
      stale: status === 'stale',
    };
  } catch {
    return malformedEvidence(issueNumber, prNumber, headSha, path, 'Local review evidence JSON could not be parsed.', reviewers, profile);
  }
}

function parseLaneEvidence(path: string, issueNumber: number, prNumber: number, headSha: string): { lane: LocalReviewLane; adapter: LocalReviewEvidence['adapter']; evidenceSha256: string } | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(parsed) || evidenceSchemaVersion(parsed) !== 1) return null;
    const parsedIssueNumber = parsed.issueNumber ?? parsed.issue;
    const parsedPrNumber = parsed.prNumber ?? parsed.pr;
    if (parsedIssueNumber !== issueNumber || parsedPrNumber !== prNumber || parsed.headSha !== headSha) return null;
    const id = readLaneId(parsed.lane ?? parsed.id);
    if (!id) return null;
    const status = readStatus(parsed.status);
    return {
      adapter: readAdapter(parsed.adapter),
      evidenceSha256: localReviewEvidenceSha256(parsed),
      lane: {
        id,
        status,
        severity: readSeverity(parsed.severity),
        recommendation: readRecommendation(parsed.recommendation, status),
        summary: stringValue(parsed.summary, `${id} local review lane did not provide a summary.`),
        blockers: stringArray(parsed.blockers),
        findings: readFindings(parsed.findings),
        artifacts: artifactArray(parsed.artifacts),
        commands: stringArray(parsed.commands),
        surfaces: stringArray(parsed.surfaces),
        contextReviewed: readContextReviewed(parsed.contextReviewed),
        promptStack: readPromptStack(parsed.promptStack),
        toolsUsed: stringArray(parsed.toolsUsed),
        completeness: typeof parsed.completeness === 'string' ? redact(parsed.completeness.trim()) : '',
        preconditions: Array.isArray(parsed.preconditions) ? stringArray(parsed.preconditions) : null,
        carriedForward: readCarriedForward(parsed.carriedForward),
        runnerProvenance: readRunnerProvenance(parsed.runnerProvenance),
      },
    };
  } catch {
    return null;
  }
}

export function readApprovedLaneEvidenceAt(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, laneId: LocalReviewLaneId): { evidenceSha256: string } | null {
  const path = join(repoRoot, '.qube', 'aie', 'reviews', String(issueNumber), String(prNumber), safeSegment(headSha), `${laneId}.json`);
  if (!existsSync(path)) return null;
  const parsed = parseLaneEvidence(path, issueNumber, prNumber, headSha);
  if (!parsed) return null;
  if (parsed.lane.id !== laneId || parsed.lane.status !== 'passed' || parsed.lane.recommendation !== 'approve') return null;
  if (parsed.lane.carriedForward) return null;
  return { evidenceSha256: parsed.evidenceSha256 };
}

function readLocalReviewPublishEvidence(directory: string, issueNumber: number, prNumber: number, headSha: string): LocalReviewPublishEvidence | null {
  const path = join(directory, 'publish.json');
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(parsed) || parsed.version !== 1) return null;
    if (parsed.issueNumber !== issueNumber || parsed.prNumber !== prNumber || parsed.headSha !== headSha) return null;
    if (typeof parsed.provider !== 'string' || parsed.provider.trim() === '') return null;
    if (typeof parsed.status !== 'string' || parsed.status.trim() === '') return null;
    return {
      version: 1,
      issueNumber,
      prNumber,
      headSha,
      provider: parsed.provider,
      status: parsed.status,
    };
  } catch {
    return null;
  }
}

export function readCurrentHeadLaneEvidence(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, lane: LocalReviewLaneId): LocalReviewLane | null {
  const path = laneEvidencePath(repoRoot, issueNumber, prNumber, headSha, lane);
  if (!existsSync(path)) return null;
  try {
    const parsed = parseLaneEvidence(path, issueNumber, prNumber, headSha);
    if (!parsed || parsed.lane.id !== lane) return null;
    return parsed.lane;
  } catch {
    return null;
  }
}

function withProviderPublishStatus(lane: LocalReviewLane, status: string | null): LocalReviewLane {
  if (!status || !lane.runnerProvenance) return lane;
  return {
    ...lane,
    runnerProvenance: {
      ...lane.runnerProvenance,
      providerPublishStatus: status,
    },
  };
}

function providerReuseLane(record: TrustedProviderLane): LocalReviewLane {
  return {
    id: record.lane,
    status: 'passed',
    severity: 'none',
    recommendation: 'approve',
    summary: `Trusted provider current-head review reused: ${record.summary}`,
    blockers: [],
    findings: [],
    artifacts: [],
    commands: [],
    surfaces: [],
    contextReviewed: [],
    promptStack: [],
    toolsUsed: [],
    completeness: 'Reused the trusted provider-visible lane review for the exact current head; full findings, severities, prompt stack, and runner provenance remain provider-side.',
    preconditions: null,
    carriedForward: null,
    runnerProvenance: null,
    origin: 'trusted-provider',
  };
}

function parseLaneEvidenceSet(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, reviewers: readonly string[], profile: LocalReviewProfile, severityThreshold: LocalReviewSeverity, shadow: boolean, expectedPromptStackHashes?: Readonly<Record<string, string>>, requiredLanesInput?: readonly LocalReviewLaneId[], carryForwardScope?: CarryForwardScope, providerReuse?: ProviderLaneReuse): LocalReviewEvidence | null {
  const directory = laneEvidenceDirectory(repoRoot, issueNumber, prNumber, headSha);
  const directoryExists = existsSync(directory);
  if (!directoryExists && (providerReuse?.accepted.length ?? 0) === 0) return null;
  const requiredLanes = requiredLanesInput ?? requiredLocalReviewLanes(profile);
  const localLanes: LocalReviewLane[] = [];
  const providerLanes: LocalReviewLane[] = [];
  const missing: string[] = [];
  const adapters: LocalReviewEvidence['adapter'][] = [];
  const laneAdapters = new Map<LocalReviewLaneId, LocalReviewEvidence['adapter']>();
  const evidenceHashes = new Map<LocalReviewLaneId, string>();
  try {
    for (const laneId of requiredLanes) {
      const path = laneEvidencePath(repoRoot, issueNumber, prNumber, headSha, laneId);
      if (directoryExists && existsSync(path)) {
        const parsed = parseLaneEvidence(path, issueNumber, prNumber, headSha);
        if (!parsed || parsed.lane.id !== laneId) return malformedEvidence(issueNumber, prNumber, headSha, path, `Local review lane evidence for ${laneId} could not be parsed, is malformed, or its issue, PR, or headSha metadata does not match this gate.`, reviewers, profile);
        localLanes.push({ ...parsed.lane, origin: 'local' });
        adapters.push(parsed.adapter);
        laneAdapters.set(laneId, parsed.adapter);
        evidenceHashes.set(laneId, parsed.evidenceSha256);
        continue;
      }
      const providerRecord = acceptedProviderLane(providerReuse, laneId, issueNumber);
      if (providerRecord) {
        providerLanes.push(providerReuseLane(providerRecord));
        continue;
      }
      missing.push(laneId);
    }
  } catch {
    return malformedEvidence(issueNumber, prNumber, headSha, directory, 'Local review lane evidence JSON could not be parsed.', reviewers, profile);
  }
  if (localLanes.length === 0 && providerLanes.length === 0) return null;
  const publishStatus = directoryExists ? readLocalReviewPublishEvidence(directory, issueNumber, prNumber, headSha)?.status ?? null : null;
  const localLanesWithPublishStatus = localLanes.map(lane => withProviderPublishStatus(lane, publishStatus));
  const lanesWithPublishStatus = [...localLanesWithPublishStatus, ...providerLanes];
  if (missing.length > 0) {
    const evidence = missingEvidence(issueNumber, prNumber, headSha, directory, reviewers, profile);
    const missingRejections = (providerReuse?.rejected ?? []).filter(entry => missing.includes(entry.lane) && (entry.issueNumber === null || entry.issueNumber === issueNumber)).map(entry => entry.reason);
    const coveredNote = lanesWithPublishStatus.length > 0 ? ` Covered lanes remain valid: ${lanesWithPublishStatus.map(lane => `${lane.id} (${lane.origin ?? 'local'})`).join(', ')}.` : '';
    return { ...evidence, lanes: lanesWithPublishStatus, summary: `Local review evidence is missing required lane files: ${missing.join(', ')}.${coveredNote}`, blockers: [...missing.map(lane => `Missing local review evidence for ${lane}.`), ...missingRejections] };
  }
  const finalGate = lanesWithPublishStatus.find(lane => lane.id === 'final-gate');
  const contextReviewed = lanesWithPublishStatus.flatMap(lane => lane.contextReviewed);
  const promptStack = lanesWithPublishStatus.flatMap(lane => lane.promptStack);
  const missingContext = missingRequiredContext(lanesWithPublishStatus, profile);
  const contextBlockers = missingContext.map(kind => `Local review evidence did not record current ${kind} context for the ${profile} profile.`);
  const locallyCoveredLanes = requiredLanes.filter(laneId => laneAdapters.has(laneId));
  const contractBlockers = localLanesWithPublishStatus.length > 0 ? evidenceContractBlockers(localLanesWithPublishStatus, profile, promptStack, locallyCoveredLanes) : [];
  const adapter = adapters.includes('manual-evidence') ? 'manual-evidence' : adapters.includes('local-command') ? 'local-command' : localLanes.length === 0 && providerLanes.length > 0 ? 'trusted-provider' : 'local-host';
  const runnerBlockers = localLanesWithPublishStatus.length > 0 ? provenanceBlockers(localLanesWithPublishStatus, profile, laneAdapters, shadow, headSha, issueNumber, prNumber, repoRoot, expectedPromptStackHashes, evidenceHashes, locallyCoveredLanes, carryForwardScope) : [];
  const computedLaneStatus = laneStatus(lanesWithPublishStatus, profile, severityThreshold, requiredLanes);
  const rawStatus = computedLaneStatus === 'passed' && contractBlockers.length > 0 ? 'failed' : computedLaneStatus === 'passed' && runnerBlockers.length > 0 ? 'inconclusive' : computedLaneStatus;
  const status = statusWithAdapter(rawStatus, adapter, shadow);
  const blockers = [...lanesWithPublishStatus.flatMap(lane => lane.blockers), ...thresholdBlockers(lanesWithPublishStatus, severityThreshold), ...contractBlockers, ...runnerBlockers, ...adapterBlockers(adapter, status, shadow), ...contextBlockers].filter((value, index, values) => values.indexOf(value) === index);
  return {
    issueNumber,
    prNumber,
    headSha: redact(headSha),
    profile,
    adapter,
    status,
    path: redact(directory),
    reviewer: fallbackReviewer(reviewers),
    summary: `${finalGate?.summary ?? 'Local review lane evidence was loaded.'}${adapter === 'local-host' && localLanes.length > 0 ? ' Local-host provenance is same-user host evidence, not a cryptographic attestation against same-user repo code.' : ''}${providerLanes.length > 0 ? ` Reused trusted provider current-head reviews for: ${providerLanes.map(lane => lane.id).join(', ')}.` : ''}`,
    blockers,
    lanes: lanesWithPublishStatus,
    contextReviewed,
    promptStack,
    runnerProvenance: null,
    recordedAt: null,
    stale: false,
  };
}

function parseIssueEvidence(path: string, repoRoot: string, issueNumber: number, reviewers: readonly string[], profile: LocalReviewProfile, severityThreshold: LocalReviewSeverity, shadow: boolean): LocalReviewEvidence {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(parsed)) return malformedEvidence(issueNumber, 0, 'unknown', path, 'Local review evidence JSON must be an object.', reviewers, profile);
    if (evidenceSchemaVersion(parsed) !== 1) return malformedEvidence(issueNumber, 0, 'unknown', path, 'Local review evidence version must be 1.', reviewers, profile);
    if (parsed.issueNumber !== issueNumber) return malformedEvidence(issueNumber, 0, 'unknown', path, 'Local review evidence issue metadata does not match this gate.', reviewers, profile);
    const prNumber = typeof parsed.prNumber === 'number' && Number.isSafeInteger(parsed.prNumber) && parsed.prNumber > 0 ? parsed.prNumber : 0;
    const headSha = typeof parsed.headSha === 'string' && parsed.headSha.trim() !== '' ? parsed.headSha : 'unknown';
    const adapter = readAdapter(parsed.adapter);
    const runnerProvenance = readRunnerProvenance(parsed.runnerProvenance);
    const lanes = readLanes(parsed.lanes, runnerProvenance);
    if (!lanes) return malformedEvidence(issueNumber, prNumber, headSha, path, 'Local review evidence must include a lanes array with known lane ids.', reviewers, profile);
    const evidenceHash = localReviewEvidenceSha256(parsed);
    const evidenceHashes = new Map(lanes.map(lane => [lane.id, evidenceHash]));
    const contextReviewed = readContextReviewed(parsed.contextReviewed);
    const promptStack = readPromptStack(parsed.promptStack);
    const missingContext = missingRequiredContext(lanes, profile);
    const contextBlockers = missingContext.map(kind => `Local review evidence did not record current ${kind} context for the ${profile} profile.`);
    const contractBlockers = evidenceContractBlockers(lanes, profile, promptStack);
    const runnerBlockers = provenanceBlockers(lanes, profile, adapterMap(lanes, adapter), shadow, headSha, issueNumber, prNumber, repoRoot, undefined, evidenceHashes);
    const computedLaneStatus = laneStatus(lanes, profile, severityThreshold);
    const rawStatus = computedLaneStatus === 'passed' && contractBlockers.length > 0 ? 'failed' : computedLaneStatus === 'passed' && runnerBlockers.length > 0 ? 'inconclusive' : computedLaneStatus;
    const status = statusWithAdapter(rawStatus, adapter, shadow);
    const blockers = [...stringArray(parsed.blockers), ...lanes.flatMap(lane => lane.blockers), ...thresholdBlockers(lanes, severityThreshold), ...contractBlockers, ...runnerBlockers, ...adapterBlockers(adapter, status, shadow)].filter((value, index, values) => values.indexOf(value) === index);
    return {
      issueNumber,
      prNumber,
      headSha: redact(headSha),
      profile,
      adapter,
      status,
      path: redact(path),
      reviewer: reviewerFrom(parsed.reviewer, reviewers),
      summary: stringValue(parsed.summary, status === 'passed' ? 'All required local review lanes passed.' : status === 'inconclusive' ? `Local review evidence is inconclusive because required task context was not reviewed: ${missingContext.join(', ')}.` : 'Local review evidence requires attention.'),
      blockers: [...blockers, ...contextBlockers],
      lanes,
      contextReviewed,
      promptStack,
      runnerProvenance,
      recordedAt: typeof parsed.recordedAt === 'string' ? redact(parsed.recordedAt) : null,
      stale: status === 'stale',
    };
  } catch {
    return malformedEvidence(issueNumber, 0, 'unknown', path, 'Local review evidence JSON could not be parsed.', reviewers, profile);
  }
}

function directoryHasLaneEvidence(path: string): boolean {
  try {
    const laneFiles = new Set(COMPREHENSIVE_LOCAL_REVIEW_LANES.map(lane => `${lane}.json`));
    return readdirSync(path, { withFileTypes: true })
      .some(entry => entry.isFile() && laneFiles.has(entry.name));
  } catch {
    return false;
  }
}

function findStaleEvidence(repoRoot: string, issueNumber: number, prNumber: number, headSha: string): string | null {
  const laneRoot = join(repoRoot, '.qube', 'aie', 'reviews', String(issueNumber), String(prNumber));
  if (existsSync(laneRoot)) {
    try {
      const directories = readdirSync(laneRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .filter(name => name !== safeSegment(headSha) && directoryHasLaneEvidence(join(laneRoot, name)))
        .sort();
      const newest = directories.at(-1);
      if (newest) return join(laneRoot, newest);
    } catch {
      return null;
    }
  }
  const directory = evidenceDirectory(repoRoot, issueNumber, prNumber);
  if (!existsSync(directory)) return null;
  try {
    const files = readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => entry.name)
      .sort();
    return files.length === 0 ? null : join(directory, files[files.length - 1]);
  } catch {
    return null;
  }
}

type IssueEvidenceReference =
  | { kind: 'aggregate'; path: string }
  | { kind: 'lane-set'; path: string; prNumber: number; headSha: string };

function findIssueEvidence(repoRoot: string, issueNumber: number): IssueEvidenceReference[] {
  const references: IssueEvidenceReference[] = [];
  const laneRoot = join(repoRoot, '.qube', 'aie', 'reviews', String(issueNumber));
  if (existsSync(laneRoot)) {
    try {
      const prDirectories = readdirSync(laneRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && /^[0-9]+$/.test(entry.name))
        .map(entry => ({ prNumber: Number.parseInt(entry.name, 10), path: join(laneRoot, entry.name) }));
      for (const prDirectory of prDirectories) {
        try {
          const headDirectories = readdirSync(prDirectory.path, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name);
          for (const headSha of headDirectories) references.push({ kind: 'lane-set', prNumber: prDirectory.prNumber, headSha, path: join(prDirectory.path, headSha) });
        } catch {
          continue;
        }
      }
    } catch {
      // Fall through to legacy aggregate evidence discovery.
    }
  }
  const directory = join(repoRoot, '.qube', 'aie', 'pr-reviews', `issue-${issueNumber}`);
  if (!existsSync(directory)) return references.sort((left, right) => left.path.localeCompare(right.path));
  try {
    const prDirectories = readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith('pr-'))
      .map(entry => join(directory, entry.name));
    references.push(...prDirectories.flatMap(prDirectory => {
      try {
        return readdirSync(prDirectory, { withFileTypes: true })
          .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
          .map(entry => ({ kind: 'aggregate' as const, path: join(prDirectory, entry.name) }));
      } catch {
        return [];
      }
    }));
    return references.sort((left, right) => left.path.localeCompare(right.path));
  } catch {
    return references.sort((left, right) => left.path.localeCompare(right.path));
  }
}

function statusPriority(status: LocalReviewStatus): number {
  return {
    malformed: 7,
    unavailable: 6,
    failed: 5,
    'needs-work': 4,
    inconclusive: 4,
    stale: 3,
    pending: 2,
    missing: 1,
    passed: 0,
  }[status];
}

function gateStatus(evidence: readonly LocalReviewEvidence[]): LocalReviewStatus {
  return evidence.reduce<LocalReviewStatus>((current, item) => statusPriority(item.status) > statusPriority(current) ? item.status : current, 'passed');
}

function gateNextAction(status: LocalReviewStatus, prNumber: number, providerFirst = false): string {
  const rerunCommand = prNumber > 0 ? `\`aie pr gate ${prNumber}\`` : '`aie pr gate <pr>`';
  if (status === 'passed') return prNumber > 0
    ? `Local review evidence is recorded for PR #${prNumber}; inspect PR state, PR comments, reviews, checks, issue checklist, and any feedback before merge.`
    : 'Local review evidence is recorded; inspect PR state, PR comments, reviews, checks, issue checklist, and any feedback before merge.';
  if (providerFirst && (status === 'missing' || status === 'pending')) {
    return `Run fresh-context review subagents for each active focus, publish provider-visible feedback on the pull request, then rerun ${rerunCommand}. Inspect PR comments and reviews on GitHub; local audit files are optional.`;
  }
  if (status === 'stale') return `Rerun local review focuses for the current PR head, publish updated provider-visible feedback, then rerun ${rerunCommand}.`;
  if (status === 'failed' || status === 'needs-work') return 'Address provider-visible review feedback: read the aggregated cross-lane batch with `aie pr batch <pr>`, apply all blocking fixes in one commit, push, and rerun the PR gate for one re-review round.';
  if (status === 'inconclusive') return 'Refresh provider-visible local review feedback with required issue, PR, diff, checks, and instruction context before merge.';
  if (status === 'unavailable' || status === 'malformed') return 'Fix local review runner availability or provider publishing, then rerun the PR gate.';
  return `Complete local review focuses and publish provider-visible feedback on the pull request, then rerun ${rerunCommand}.`;
}

export function readLocalReviewGate(input: {
  repoRoot: string;
  issueNumbers: readonly number[];
  prNumber: number;
  headSha: string;
  reviewers: readonly string[];
  required: boolean;
  profile?: LocalReviewProfile;
  severityThreshold?: LocalReviewSeverity;
  shadow?: boolean;
  expectedPromptStackHashes?: Readonly<Record<string, string>>;
  activeFocuses?: readonly LocalReviewLaneId[];
  providerFirst?: boolean;
  carryForwardScope?: CarryForwardScope;
  providerLaneReuse?: ProviderLaneReuse;
}): LocalReviewGate {
  const reviewers = input.reviewers.map(redact);
  const profile = effectiveProfile(input.profile ?? 'remote-compatible', input.required, input.shadow ?? false);
  const severityThreshold = input.severityThreshold ?? 'high';
  const requiredLanes = [...(input.activeFocuses ?? requiredLocalReviewLanes(profile))];
  const mode = input.shadow ? 'shadow' : input.required ? 'required' : 'disabled';
  if (!input.required && !input.shadow) return { required: false, mode, profile, reviewers, requiredLanes, evidence: [], status: 'passed', summary: 'Local review evidence is not required by the selected review adapter.', nextAction: 'No local review evidence action is required.' };
  if (input.issueNumbers.length === 0) {
    const evidence = [missingEvidence(null, input.prNumber, input.headSha, null, input.reviewers, profile)];
    return { required: input.required, mode, profile, reviewers, requiredLanes, evidence, status: 'missing', summary: evidence[0].summary, nextAction: gateNextAction('missing', input.prNumber) };
  }
  const evidence = input.issueNumbers.map(issueNumber => {
    const currentPath = laneEvidenceDirectory(input.repoRoot, issueNumber, input.prNumber, input.headSha);
    const legacyPath = evidencePath(input.repoRoot, issueNumber, input.prNumber, input.headSha);
    const laneEvidence = parseLaneEvidenceSet(input.repoRoot, issueNumber, input.prNumber, input.headSha, input.reviewers, profile, severityThreshold, input.shadow ?? false, input.expectedPromptStackHashes, requiredLanes, input.carryForwardScope, input.providerLaneReuse);
    if (laneEvidence) return laneEvidence;
    if (existsSync(legacyPath)) return parseEvidence(legacyPath, input.repoRoot, issueNumber, input.prNumber, input.headSha, input.reviewers, profile, severityThreshold, input.shadow ?? false, input.expectedPromptStackHashes);
    const stalePath = findStaleEvidence(input.repoRoot, issueNumber, input.prNumber, input.headSha);
    if (stalePath) return staleEvidence(issueNumber, input.prNumber, input.headSha, stalePath, input.reviewers, profile);
    return missingEvidence(issueNumber, input.prNumber, input.headSha, currentPath, input.reviewers, profile);
  });
  const status = gateStatus(evidence);
  return {
    required: input.required,
    mode,
    profile,
    reviewers,
    requiredLanes,
    evidence,
    status,
    summary: `${mode === 'shadow' ? 'Shadow local review evidence' : 'Local review evidence'} for ${profile}: ${evidence.map(item => `#${item.issueNumber ?? 'unknown'}: ${item.status} - ${item.summary}`).join(' ')}`,
    nextAction: gateNextAction(status, input.prNumber, input.providerFirst ?? false),
    providerReuse: input.providerLaneReuse,
  };
}

export interface FixBatchFinding {
  laneId: LocalReviewLaneId;
  lanes: LocalReviewLaneId[];
  findingId: string;
  contentHash: string;
  severity: 'blocking' | 'advisory';
  message: string;
  location: { path: string; line: number | null } | null;
  suggestion: string | null;
  classification: 'new' | 'persisting';
}

export interface FixBatch {
  headSha: string;
  priorHeadSha: string | null;
  findings: FixBatchFinding[];
  resolved: Array<{ laneId: LocalReviewLaneId; contentHash: string; severity: 'blocking' | 'advisory'; message: string }>;
  summary: string;
}

function findingContentHash(laneId: LocalReviewLaneId, finding: ReviewFinding): string {
  return hash(JSON.stringify({
    lane: laneId,
    severity: finding.severity,
    message: finding.message,
    path: finding.location?.path ?? null,
  })).slice(0, 16);
}

function headDirectoryTimestamp(repoRoot: string, issueNumber: number, prNumber: number, headDir: string): string | null {
  const directory = join(repoRoot, '.qube', 'aie', 'reviews', String(issueNumber), String(prNumber), headDir);
  let maxRecordedAt: string | null = null;
  for (const laneId of COMPREHENSIVE_LOCAL_REVIEW_LANES) {
    const path = join(directory, `${laneId}.json`);
    if (!existsSync(path)) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!isRecord(parsed)) continue;
      const recordedAt = typeof parsed.recordedAt === 'string' ? parsed.recordedAt : null;
      if (recordedAt !== null && (maxRecordedAt === null || recordedAt > maxRecordedAt)) maxRecordedAt = recordedAt;
    } catch {
      continue;
    }
  }
  return maxRecordedAt;
}

function findPriorHeadSha(repoRoot: string, issueNumbers: readonly number[], prNumber: number, headSha: string): string | null {
  const currentHeadDir = safeSegment(headSha);
  let priorHeadSha: string | null = null;
  let newestTimestamp: string | null = null;
  for (const issueNumber of issueNumbers) {
    const prRoot = join(repoRoot, '.qube', 'aie', 'reviews', String(issueNumber), String(prNumber));
    try {
      const headDirs = readdirSync(prRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && entry.name !== currentHeadDir)
        .map(entry => entry.name);
      for (const headDir of headDirs) {
        const timestamp = headDirectoryTimestamp(repoRoot, issueNumber, prNumber, headDir);
        if (timestamp === null) continue;
        if (newestTimestamp === null || timestamp > newestTimestamp) {
          newestTimestamp = timestamp;
          priorHeadSha = headDir;
        }
      }
    } catch {
      continue;
    }
  }
  return priorHeadSha;
}

function readPriorFindings(repoRoot: string, issueNumbers: readonly number[], prNumber: number, priorHeadSha: string): Array<{ issueNumber: number; laneId: LocalReviewLaneId; finding: ReviewFinding; contentHash: string }> {
  const priorFindings: Array<{ issueNumber: number; laneId: LocalReviewLaneId; finding: ReviewFinding; contentHash: string }> = [];
  for (const issueNumber of issueNumbers) {
    const directory = join(repoRoot, '.qube', 'aie', 'reviews', String(issueNumber), String(prNumber), priorHeadSha);
    for (const laneId of COMPREHENSIVE_LOCAL_REVIEW_LANES) {
      const path = join(directory, `${laneId}.json`);
      if (!existsSync(path)) continue;
      const parsed = parseLaneEvidence(path, issueNumber, prNumber, priorHeadSha);
      if (!parsed || parsed.lane.id !== laneId) continue;
      for (const finding of parsed.lane.findings) {
        priorFindings.push({ issueNumber, laneId, finding, contentHash: findingContentHash(laneId, finding) });
      }
    }
  }
  return priorFindings;
}

function toFixBatchFinding(laneId: LocalReviewLaneId, finding: ReviewFinding, contentHash: string, classification: 'new' | 'persisting'): FixBatchFinding {
  return {
    laneId,
    lanes: [laneId],
    findingId: finding.id,
    contentHash,
    severity: finding.severity,
    message: finding.message,
    location: finding.location?.path ? { path: finding.location.path, line: finding.location.line ?? null } : null,
    suggestion: finding.suggestion ?? null,
    classification,
  };
}

function rankFixBatchFindings(left: FixBatchFinding, right: FixBatchFinding): number {
  const leftSeverity = left.severity === 'blocking' ? 0 : 1;
  const rightSeverity = right.severity === 'blocking' ? 0 : 1;
  if (leftSeverity !== rightSeverity) return leftSeverity - rightSeverity;
  const leftClassification = left.classification === 'persisting' ? 0 : 1;
  const rightClassification = right.classification === 'persisting' ? 0 : 1;
  if (leftClassification !== rightClassification) return leftClassification - rightClassification;
  if (left.laneId !== right.laneId) return left.laneId.localeCompare(right.laneId);
  if (left.message !== right.message) return left.message.localeCompare(right.message);
  return (left.location?.line ?? 0) - (right.location?.line ?? 0);
}

export function buildFixBatch(repoRoot: string, issueNumbers: readonly number[], prNumber: number, headSha: string, evidence: readonly LocalReviewEvidence[]): FixBatch {
  const currentByHash = new Map<string, FixBatchFinding>();
  for (const entry of evidence) {
    for (const lane of entry.lanes) {
      for (const finding of lane.findings) {
        const contentHash = findingContentHash(lane.id, finding);
        const batchKey = `${contentHash}|${finding.location?.line ?? 'no-line'}|${finding.id}`;
        if (currentByHash.has(batchKey)) continue;
        currentByHash.set(batchKey, toFixBatchFinding(lane.id, finding, contentHash, 'new'));
      }
    }
  }
  const completedIssueNumbers = new Set(evidence
    .filter(entry => entry.status === 'passed' || entry.status === 'failed' || entry.status === 'needs-work')
    .map(entry => entry.issueNumber)
    .filter((issueNumber): issueNumber is number => issueNumber !== null));
  const currentEvidenceLoaded = completedIssueNumbers.size > 0;
  const priorHeadSha = findPriorHeadSha(repoRoot, issueNumbers, prNumber, headSha);
  const priorFindings = priorHeadSha === null ? [] : readPriorFindings(repoRoot, issueNumbers, prNumber, priorHeadSha);
  const priorRemaining = new Map<string, number>();
  for (const entry of priorFindings) priorRemaining.set(entry.contentHash, (priorRemaining.get(entry.contentHash) ?? 0) + 1);
  const orderedCurrent = [...currentByHash.values()].sort((left, right) => {
    if (left.laneId !== right.laneId) return left.laneId.localeCompare(right.laneId);
    if (left.message !== right.message) return left.message.localeCompare(right.message);
    return (left.location?.line ?? 0) - (right.location?.line ?? 0);
  });
  const findings = orderedCurrent.map(finding => {
    const remaining = priorRemaining.get(finding.contentHash) ?? 0;
    if (remaining > 0) {
      priorRemaining.set(finding.contentHash, remaining - 1);
      return { ...finding, classification: 'persisting' as const };
    }
    return { ...finding, classification: 'new' as const };
  }).sort(rankFixBatchFindings);
  // Cross-lane merge: identical defects reported by several lanes collapse to one
  // batch entry carrying every reporting lane, so the implementer fixes each defect
  // once. Per-lane content hashes stay the classification and resolution keys.
  const mergedByIdentity = new Map<string, FixBatchFinding>();
  for (const finding of findings) {
    const identity = JSON.stringify({ severity: finding.severity, message: finding.message, location: finding.location, suggestion: finding.suggestion });
    const existing = mergedByIdentity.get(identity);
    if (!existing) {
      mergedByIdentity.set(identity, finding);
      continue;
    }
    if (!existing.lanes.includes(finding.laneId)) existing.lanes = [...existing.lanes, finding.laneId].sort();
    if (finding.classification === 'persisting') existing.classification = 'persisting';
  }
  const mergedFindings = [...mergedByIdentity.values()].sort(rankFixBatchFindings);
  const resolved = currentEvidenceLoaded
    ? priorFindings
      .filter(entry => {
        if (!completedIssueNumbers.has(entry.issueNumber)) return false;
        const remaining = priorRemaining.get(entry.contentHash) ?? 0;
        if (remaining <= 0) return false;
        priorRemaining.set(entry.contentHash, remaining - 1);
        return true;
      })
      .map(entry => ({
        laneId: entry.laneId,
        contentHash: entry.contentHash,
        severity: entry.finding.severity,
        message: entry.finding.message,
      }))
      .sort((left, right) => {
        if (left.laneId !== right.laneId) return left.laneId.localeCompare(right.laneId);
        return left.message.localeCompare(right.message);
      })
    : [];
  const blockingCount = mergedFindings.filter(finding => finding.severity === 'blocking').length;
  const advisoryCount = mergedFindings.filter(finding => finding.severity === 'advisory').length;
  const newCount = mergedFindings.filter(finding => finding.classification === 'new').length;
  const persistingCount = mergedFindings.filter(finding => finding.classification === 'persisting').length;
  const priorLabel = priorHeadSha ?? 'no prior head';
  const resolvedLabel = currentEvidenceLoaded
    ? `${resolved.length} resolved since ${priorLabel}.`
    : 'resolved state is indeterminate because current-head lane evidence is missing or stale.';
  const summary = `${mergedFindings.length} open finding(s): ${blockingCount} blocking, ${advisoryCount} advisory (${newCount} new, ${persistingCount} persisting); ${resolvedLabel}`;
  return {
    headSha,
    priorHeadSha,
    findings: mergedFindings,
    resolved,
    summary,
  };
}

export function readLocalIssueReviewGate(input: {
  repoRoot: string;
  issueNumber: number;
  reviewers: readonly string[];
  required: boolean;
  profile?: LocalReviewProfile;
  severityThreshold?: LocalReviewSeverity;
  shadow?: boolean;
}): LocalReviewGate {
  const reviewers = input.reviewers.map(redact);
  const profile = effectiveProfile(input.profile ?? 'remote-compatible', input.required, input.shadow ?? false);
  const severityThreshold = input.severityThreshold ?? 'high';
  const requiredLanes = [...requiredLocalReviewLanes(profile)];
  const mode = input.shadow ? 'shadow' : input.required ? 'required' : 'disabled';
  if (!input.required && !input.shadow) return { required: false, mode, profile, reviewers, requiredLanes, evidence: [], status: 'passed', summary: 'Local review evidence is not required by the selected review adapter.', nextAction: 'No local review evidence action is required.' };
  const evidencePaths = findIssueEvidence(input.repoRoot, input.issueNumber);
  const evidence = evidencePaths.length === 0
    ? [missingEvidence(input.issueNumber, 0, 'unknown', null, input.reviewers, profile)]
    : evidencePaths.map(reference => reference.kind === 'lane-set'
      ? parseLaneEvidenceSet(input.repoRoot, input.issueNumber, reference.prNumber, reference.headSha, input.reviewers, profile, severityThreshold, input.shadow ?? false)
        ?? malformedEvidence(input.issueNumber, reference.prNumber, reference.headSha, reference.path, 'Local review lane evidence set could not be parsed for this issue gate.', input.reviewers, profile)
      : parseIssueEvidence(reference.path, input.repoRoot, input.issueNumber, input.reviewers, profile, severityThreshold, input.shadow ?? false));
  const status = gateStatus(evidence);
  return {
    required: input.required,
    mode,
    profile,
    reviewers,
    requiredLanes,
    evidence,
    status,
    summary: `${mode === 'shadow' ? 'Shadow local review evidence' : 'Local review evidence'} for ${profile}: ${evidence.map(item => `#${item.issueNumber ?? 'unknown'} PR #${item.prNumber || 'unknown'}: ${item.status} - ${item.summary}`).join(' ')}`,
    nextAction: gateNextAction(status, evidence.find(item => item.prNumber > 0)?.prNumber ?? 0),
  };
}
