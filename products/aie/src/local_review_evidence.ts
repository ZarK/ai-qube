import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from './gh.js';

export type LocalReviewStatus = 'passed' | 'failed' | 'needs-work' | 'pending' | 'missing' | 'stale' | 'unavailable' | 'malformed' | 'inconclusive';
export type LocalReviewProfile = 'remote-compatible' | 'local-standard' | 'local-comprehensive' | 'local-shadow';
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
}

export interface LocalReviewLane {
  id: LocalReviewLaneId;
  status: LocalReviewStatus;
  severity: LocalReviewSeverity;
  recommendation: LocalReviewRecommendation;
  summary: string;
  blockers: string[];
  artifacts: string[];
  commands: string[];
  surfaces: string[];
  contextReviewed: LocalReviewContextReviewed[];
  promptStack: LocalReviewPromptStackItem[];
  toolsUsed: string[];
  runnerProvenance: LocalReviewRunnerProvenance | null;
}

export interface LocalReviewEvidence {
  issueNumber: number | null;
  prNumber: number;
  headSha: string;
  profile: LocalReviewProfile;
  adapter: 'local-command' | 'local-host' | 'manual-evidence';
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
}

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
  if (value === 'remote-compatible' || value === 'local-standard' || value === 'local-comprehensive' || value === 'local-shadow') return value;
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
  };
}

export function requiredLocalReviewLanes(profile: LocalReviewProfile): readonly LocalReviewLaneId[] {
  if (profile === 'local-comprehensive' || profile === 'local-shadow') return COMPREHENSIVE_LOCAL_REVIEW_LANES;
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
      artifacts: artifactArray(entry.artifacts),
      commands: stringArray(entry.commands),
      surfaces: stringArray(entry.surfaces),
      contextReviewed: readContextReviewed(entry.contextReviewed),
      promptStack: readPromptStack(entry.promptStack),
      toolsUsed: stringArray(entry.toolsUsed),
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
  if (lane.severity === 'none') return false;
  if (severityRank(lane.severity) < severityRank(threshold)) return false;
  return lane.recommendation === 'request-changes' || lane.blockers.length > 0;
}

function thresholdBlockers(lanes: readonly LocalReviewLane[], threshold: LocalReviewSeverity): string[] {
  return lanes
    .filter(lane => laneExceedsThreshold(lane, threshold))
    .map(lane => `${lane.id} recorded ${lane.severity} severity at or above the ${threshold} threshold.`);
}

function evidenceContractBlockers(lanes: readonly LocalReviewLane[], profile: LocalReviewProfile, promptStack: readonly LocalReviewPromptStackItem[]): string[] {
  const blockers: string[] = [];
  if (requiredLocalReviewLanes(profile).length > 0 && promptStack.length === 0) {
    blockers.push(`Local review evidence for ${profile} must include a non-empty top-level promptStack.`);
  }
  const lanesById = new Map(lanes.map(lane => [lane.id, lane]));
  for (const laneId of requiredLocalReviewLanes(profile)) {
    const lane = lanesById.get(laneId);
    if (!lane || lane.status !== 'passed') continue;
    if (lane.artifacts.length === 0) blockers.push(`${laneId} passed without artifact references.`);
    if (lane.promptStack.length === 0) blockers.push(`${laneId} passed without promptStack coverage.`);
  }
  const finalGate = lanesById.get('final-gate');
  if (requiredLocalReviewLanes(profile).includes('final-gate') && finalGate) {
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
  if (!trusted) return [`${input.laneId} local-host evidence was not bound to a trusted host provenance record.`];
  const blockers: string[] = [];
  if (!input.evidenceSha256) blockers.push(`${input.laneId} local-host evidence could not be bound to a canonical evidence digest.`);
  if (input.evidenceSha256 && trusted.evidenceSha256 !== input.evidenceSha256) blockers.push(`${input.laneId} local-host evidence digest does not match the trusted host provenance record.`);
  if (trusted.host !== input.provenance.host) blockers.push(`${input.laneId} local-host provenance host does not match the trusted host record.`);
  if (trusted.promptStackHash !== input.provenance.promptStackHash) blockers.push(`${input.laneId} local-host provenance prompt stack hash does not match the trusted host record.`);
  if (trusted.taskId !== input.provenance.taskId || trusted.sessionId !== input.provenance.sessionId || trusted.threadId !== input.provenance.threadId) blockers.push(`${input.laneId} local-host provenance task, session, or thread id does not match the trusted host record.`);
  if (!trusted.taskId && !trusted.sessionId && !trusted.threadId) blockers.push(`${input.laneId} trusted host provenance did not record a separate task, session, or thread id.`);
  return blockers;
}

function provenanceBlockers(lanes: readonly LocalReviewLane[], profile: LocalReviewProfile, adapter: LocalReviewEvidence['adapter'], shadow: boolean, headSha: string, issueNumber: number, prNumber: number, repoRoot: string, expectedPromptStackHashes?: Readonly<Record<string, string>>, evidenceHashes?: ReadonlyMap<LocalReviewLaneId, string>): string[] {
  if (shadow || requiredLocalReviewLanes(profile).length === 0) return [];
  if (adapter === 'manual-evidence') return [];
  const blockers: string[] = [];
  const lanesById = new Map(lanes.map(lane => [lane.id, lane]));
  for (const laneId of requiredLocalReviewLanes(profile)) {
    const lane = lanesById.get(laneId);
    if (!lane || lane.status !== 'passed') continue;
    const provenance = lane.runnerProvenance;
    if (!provenance) {
      blockers.push(`${laneId} passed without independent reviewer runner provenance.`);
      continue;
    }
    if (provenance.runnerKind !== adapter) blockers.push(`${laneId} runner provenance kind ${provenance.runnerKind} does not match evidence adapter ${adapter}.`);
    if (!provenance.freshContext) blockers.push(`${laneId} did not record fresh independent reviewer context.`);
    if (provenance.promptOnly) blockers.push(`${laneId} was prompt-only output and cannot satisfy a required local review gate.`);
    if (provenance.headSha !== headSha) blockers.push(`${laneId} runner provenance did not record the current PR head SHA.`);
    if (!provenance.taskId && !provenance.sessionId && !provenance.threadId) blockers.push(`${laneId} runner provenance did not record a separate task, session, or thread id.`);
    if (!provenance.promptStackHash) {
      blockers.push(`${laneId} runner provenance did not record a prompt stack hash.`);
    } else {
      const expectedPromptStackHash = explicitExpectedPromptHash({ issueNumber, laneId, expectedPromptStackHashes });
      if (expectedPromptStackHash && provenance.promptStackHash !== expectedPromptStackHash) {
        blockers.push(`${laneId} runner provenance prompt stack hash does not match the current QUBE prompt stack.`);
      }
    }
    blockers.push(...trustedLocalHostBlockers({ repoRoot, issueNumber, prNumber, headSha, laneId, provenance, evidenceSha256: evidenceHashes?.get(laneId) ?? null }));
  }
  return blockers;
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function laneStatus(lanes: readonly LocalReviewLane[], profile: LocalReviewProfile, threshold: LocalReviewSeverity): LocalReviewStatus {
  for (const lane of lanes) if (lane.status === 'malformed') return 'malformed';
  for (const lane of lanes) if (lane.status === 'unavailable') return 'unavailable';
  for (const lane of lanes) if (lane.status === 'failed') return 'failed';
  for (const lane of lanes) if (laneExceedsThreshold(lane, threshold)) return 'failed';
  for (const lane of lanes) if (lane.status === 'needs-work') return 'needs-work';
  for (const lane of lanes) if (lane.status === 'inconclusive') return 'inconclusive';
  for (const lane of lanes) if (lane.status === 'stale') return 'stale';
  for (const lane of lanes) if (lane.status === 'pending') return 'pending';
  const byId = new Map(lanes.map(lane => [lane.id, lane]));
  for (const laneId of requiredLocalReviewLanes(profile)) {
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
    const runnerBlockers = provenanceBlockers(lanes, profile, adapter, shadow, headSha, issueNumber, prNumber, repoRoot, expectedPromptStackHashes, evidenceHashes);
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
        artifacts: artifactArray(parsed.artifacts),
        commands: stringArray(parsed.commands),
        surfaces: stringArray(parsed.surfaces),
        contextReviewed: readContextReviewed(parsed.contextReviewed),
        promptStack: readPromptStack(parsed.promptStack),
        toolsUsed: stringArray(parsed.toolsUsed),
        runnerProvenance: readRunnerProvenance(parsed.runnerProvenance),
      },
    };
  } catch {
    return null;
  }
}

function parseLaneEvidenceSet(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, reviewers: readonly string[], profile: LocalReviewProfile, severityThreshold: LocalReviewSeverity, shadow: boolean, expectedPromptStackHashes?: Readonly<Record<string, string>>): LocalReviewEvidence | null {
  const directory = laneEvidenceDirectory(repoRoot, issueNumber, prNumber, headSha);
  if (!existsSync(directory)) return null;
  const requiredLanes = requiredLocalReviewLanes(profile);
  const lanes: LocalReviewLane[] = [];
  const missing: string[] = [];
  const adapters: LocalReviewEvidence['adapter'][] = [];
  const evidenceHashes = new Map<LocalReviewLaneId, string>();
  try {
    for (const laneId of requiredLanes) {
      const path = laneEvidencePath(repoRoot, issueNumber, prNumber, headSha, laneId);
      if (!existsSync(path)) {
        missing.push(laneId);
        continue;
      }
      const parsed = parseLaneEvidence(path, issueNumber, prNumber, headSha);
      if (!parsed || parsed.lane.id !== laneId) return malformedEvidence(issueNumber, prNumber, headSha, path, `Local review lane evidence for ${laneId} could not be parsed, is malformed, or its issue, PR, or headSha metadata does not match this gate.`, reviewers, profile);
      lanes.push(parsed.lane);
      adapters.push(parsed.adapter);
      evidenceHashes.set(laneId, parsed.evidenceSha256);
    }
  } catch {
    return malformedEvidence(issueNumber, prNumber, headSha, directory, 'Local review lane evidence JSON could not be parsed.', reviewers, profile);
  }
  if (lanes.length === 0) return null;
  if (missing.length > 0) {
    const evidence = missingEvidence(issueNumber, prNumber, headSha, directory, reviewers, profile);
    return { ...evidence, summary: `Local review evidence is missing required lane files: ${missing.join(', ')}.`, blockers: missing.map(lane => `Missing local review evidence for ${lane}.`) };
  }
  const finalGate = lanes.find(lane => lane.id === 'final-gate');
  const contextReviewed = lanes.flatMap(lane => lane.contextReviewed);
  const promptStack = lanes.flatMap(lane => lane.promptStack);
  const missingContext = missingRequiredContext(lanes, profile);
  const contextBlockers = missingContext.map(kind => `Local review evidence did not record current ${kind} context for the ${profile} profile.`);
  const contractBlockers = evidenceContractBlockers(lanes, profile, promptStack);
  const adapter = adapters.includes('manual-evidence') ? 'manual-evidence' : adapters.includes('local-command') ? 'local-command' : 'local-host';
  const runnerBlockers = provenanceBlockers(lanes, profile, adapter, shadow, headSha, issueNumber, prNumber, repoRoot, expectedPromptStackHashes, evidenceHashes);
  const computedLaneStatus = laneStatus(lanes, profile, severityThreshold);
  const rawStatus = computedLaneStatus === 'passed' && contractBlockers.length > 0 ? 'failed' : computedLaneStatus === 'passed' && runnerBlockers.length > 0 ? 'inconclusive' : computedLaneStatus;
  const status = statusWithAdapter(rawStatus, adapter, shadow);
  const blockers = [...lanes.flatMap(lane => lane.blockers), ...thresholdBlockers(lanes, severityThreshold), ...contractBlockers, ...runnerBlockers, ...adapterBlockers(adapter, status, shadow), ...contextBlockers].filter((value, index, values) => values.indexOf(value) === index);
  return {
    issueNumber,
    prNumber,
    headSha: redact(headSha),
    profile,
    adapter,
    status,
    path: redact(directory),
    reviewer: fallbackReviewer(reviewers),
    summary: finalGate?.summary ?? 'Local review lane evidence was loaded.',
    blockers,
    lanes,
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
    const runnerBlockers = provenanceBlockers(lanes, profile, adapter, shadow, headSha, issueNumber, prNumber, repoRoot, undefined, evidenceHashes);
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

function findStaleEvidence(repoRoot: string, issueNumber: number, prNumber: number): string | null {
  const laneRoot = join(repoRoot, '.qube', 'aie', 'reviews', String(issueNumber), String(prNumber));
  if (existsSync(laneRoot)) {
    try {
      const directories = readdirSync(laneRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
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

function gateNextAction(status: LocalReviewStatus, prNumber: number): string {
  const rerunCommand = prNumber > 0 ? `\`aie pr gate ${prNumber}\`` : '`aie pr gate <pr>`';
  if (status === 'passed') return prNumber > 0
    ? `Local review evidence is current for PR #${prNumber}; inspect PR state, checks, issue checklist, and any feedback before merge.`
    : 'Local review evidence is recorded; inspect PR state, checks, issue checklist, and any feedback before merge.';
  if (status === 'stale') return `Rerun local review lanes for the current PR head, refresh local evidence, then rerun ${rerunCommand}.`;
  if (status === 'failed' || status === 'needs-work') return 'Address local review blockers, rerun affected checks, refresh local evidence, and rerun the PR gate.';
  if (status === 'inconclusive') return 'Refresh local review evidence with required AGENTS, issue, issue comments, milestone, functional requirement, linked issue, PR, and review-thread context before merge.';
  if (status === 'unavailable' || status === 'malformed') return 'Fix local review evidence format or runner availability, then rerun the PR gate.';
  return `Record local review evidence for all required lanes, then rerun ${rerunCommand}.`;
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
}): LocalReviewGate {
  const reviewers = input.reviewers.map(redact);
  const profile = effectiveProfile(input.profile ?? 'remote-compatible', input.required, input.shadow ?? false);
  const severityThreshold = input.severityThreshold ?? 'high';
  const requiredLanes = [...requiredLocalReviewLanes(profile)];
  const mode = input.shadow ? 'shadow' : input.required ? 'required' : 'disabled';
  if (!input.required && !input.shadow) return { required: false, mode, profile, reviewers, requiredLanes, evidence: [], status: 'passed', summary: 'Local review evidence is not required by the selected review adapter.', nextAction: 'No local review evidence action is required.' };
  if (input.issueNumbers.length === 0) {
    const evidence = [missingEvidence(null, input.prNumber, input.headSha, null, input.reviewers, profile)];
    return { required: input.required, mode, profile, reviewers, requiredLanes, evidence, status: 'missing', summary: evidence[0].summary, nextAction: gateNextAction('missing', input.prNumber) };
  }
  const evidence = input.issueNumbers.map(issueNumber => {
    const currentPath = laneEvidenceDirectory(input.repoRoot, issueNumber, input.prNumber, input.headSha);
    const legacyPath = evidencePath(input.repoRoot, issueNumber, input.prNumber, input.headSha);
    const laneEvidence = parseLaneEvidenceSet(input.repoRoot, issueNumber, input.prNumber, input.headSha, input.reviewers, profile, severityThreshold, input.shadow ?? false, input.expectedPromptStackHashes);
    if (laneEvidence) return laneEvidence;
    if (existsSync(legacyPath)) return parseEvidence(legacyPath, input.repoRoot, issueNumber, input.prNumber, input.headSha, input.reviewers, profile, severityThreshold, input.shadow ?? false, input.expectedPromptStackHashes);
    const stalePath = findStaleEvidence(input.repoRoot, issueNumber, input.prNumber);
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
    nextAction: gateNextAction(status, input.prNumber),
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
