import type { Config } from '../config/index.js';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { ReviewFinding } from '@tjalve/qube-core';
import { gitDeltaPathsSync, localReviewEvidenceSha256, recommendationStatusRule, trustedLocalHostProvenancePath, validRecommendationStatus, type CarryForwardScope, type LocalReviewLaneId, type LocalReviewStatus } from '../local_review_evidence.js';
import { carryForwardDeltaTouched, defaultCarryForwardContext } from '../review_focus.js';
import { createReviewForgeProvider } from '../providers/review_forge_adapters.js';
import type { ReviewForgeLaneReviewPublishResult, ReviewForgeLocalReviewRecommendation, ReviewForgeProvider, ReviewForgeSnapshot } from '../providers/review_forge_provider.js';
import type { PrGateExec } from './pr_gate.js';

export interface PrReviewPublishOptions {
  prNumber: number;
  lane: LocalReviewLaneId;
  issueNumber?: number;
  headSha?: string;
  dryRun?: boolean;
  repoRoot?: string;
  exec?: PrGateExec;
  carryForwardPublish?: 'note' | 'none';
  carryForwardScope?: CarryForwardScope;
}

export interface PrReviewPublishResult {
  ok: true;
  command: 'pr review publish';
  prNumber: number;
  lane: LocalReviewLaneId;
  publish: ReviewForgeLaneReviewPublishResult;
}

const snapshotCacheByHead = new Map<string, Promise<ReviewForgeSnapshot>>();
const SNAPSHOT_CACHE_LOCK_POLL_MS = 100;
const SNAPSHOT_CACHE_LOCK_TIMEOUT_MS = 60_000;

function snapshotCacheKey(prNumber: number, headSha: string, cachePath?: string): string {
  return `${cachePath ?? 'memory'}:${prNumber}:${headSha}`;
}

function snapshotCachePath(repoRoot: string, issueNumber: number, prNumber: number, headSha: string): string {
  const safeHead = headSha.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
  return join(repoRoot, '.qube', 'aie', 'reviews', String(issueNumber), String(prNumber), safeHead, 'fallback-snapshot-cache.json');
}

function cachedSnapshotFromFile(path: string, prNumber: number, headSha: string): ReviewForgeSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.pr) || !isRecord(parsed.item) || !Array.isArray(parsed.closingIssueNumbers)) return null;
  if (parsed.pr.number !== prNumber || parsed.pr.headRefOid !== headSha) return null;
  return parsed as unknown as ReviewForgeSnapshot;
}

function writeSnapshotCache(path: string, snapshot: ReviewForgeSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, JSON.stringify(snapshot), 'utf8');
  renameSync(tempPath, path);
}

function snapshotCacheLockPath(cachePath: string): string {
  return `${cachePath}.lock`;
}

function tryAcquireSnapshotCacheLock(lockPath: string): boolean {
  try {
    mkdirSync(lockPath);
    return true;
  } catch (error: unknown) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : '';
    if (code === 'EEXIST') return false;
    throw error;
  }
}

function releaseSnapshotCacheLock(lockPath: string): void {
  rmSync(lockPath, { recursive: true, force: true });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function loadSnapshotWithFileCache(provider: ReviewForgeProvider, prNumber: number, headSha: string, cachePath: string): Promise<ReviewForgeSnapshot> {
  const cachedFile = cachedSnapshotFromFile(cachePath, prNumber, headSha);
  if (cachedFile) return cachedFile;
  const lockPath = snapshotCacheLockPath(cachePath);
  const deadline = Date.now() + SNAPSHOT_CACHE_LOCK_TIMEOUT_MS;
  while (true) {
    if (tryAcquireSnapshotCacheLock(lockPath)) {
      try {
        const cachedAfterLock = cachedSnapshotFromFile(cachePath, prNumber, headSha);
        if (cachedAfterLock) return cachedAfterLock;
        const snapshot = await provider.loadPullRequestReview(prNumber);
        if (snapshot.pr.headRefOid !== headSha) {
          throw new Error(`publish lane review failed. Likely cause: pull request #${prNumber} head changed from ${headSha} to ${snapshot.pr.headRefOid}. Next action: rerun pr gate for the current PR head.`);
        }
        writeSnapshotCache(cachePath, snapshot);
        return snapshot;
      } finally {
        releaseSnapshotCacheLock(lockPath);
      }
    }
    const cachedWhileWaiting = cachedSnapshotFromFile(cachePath, prNumber, headSha);
    if (cachedWhileWaiting) return cachedWhileWaiting;
    if (Date.now() >= deadline) {
      throw new Error(`publish lane review failed. Likely cause: fallback snapshot cache for pull request #${prNumber} head ${headSha} stayed locked. Next action: remove stale cache lock ${relativeEvidencePath(process.cwd(), lockPath) ?? lockPath}, rerun pr gate for the current PR head, then retry lane publish.`);
    }
    await sleep(SNAPSHOT_CACHE_LOCK_POLL_MS);
  }
}

async function loadCachedSnapshot(provider: ReviewForgeProvider, prNumber: number, headSha: string, cachePath?: string): Promise<ReviewForgeSnapshot> {
  const key = snapshotCacheKey(prNumber, headSha, cachePath);
  const cached = snapshotCacheByHead.get(key);
  if (cached) return cached;
  const loaded = (cachePath ? loadSnapshotWithFileCache(provider, prNumber, headSha, cachePath) : provider.loadPullRequestReview(prNumber).then(snapshot => {
    if (snapshot.pr.headRefOid !== headSha) {
      snapshotCacheByHead.delete(key);
      throw new Error(`publish lane review failed. Likely cause: pull request #${prNumber} head changed from ${headSha} to ${snapshot.pr.headRefOid}. Next action: rerun pr gate for the current PR head.`);
    }
    return snapshot;
  })).catch(error => {
    snapshotCacheByHead.delete(key);
    throw error;
  });
  snapshotCacheByHead.set(key, loaded);
  return loaded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
}

function readRecommendation(value: unknown): ReviewForgeLocalReviewRecommendation {
  if (value === 'approve' || value === 'request-changes' || value === 'pending' || value === 'inconclusive') return value;
  if (value === 'passed') return 'approve';
  if (value === 'failed' || value === 'needs-work') return 'request-changes';
  return 'inconclusive';
}

function laneEvidencePath(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, lane: LocalReviewLaneId): string {
  const safeHead = headSha.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
  return join(repoRoot, '.qube', 'aie', 'reviews', String(issueNumber), String(prNumber), safeHead, `${lane}.json`);
}

function relativeEvidencePath(repoRoot: string, path: string): string | null {
  if (!isAbsolute(path)) return path.replace(/\\/g, '/');
  const relativePath = relative(repoRoot, path);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) return null;
  return relativePath.replace(/\\/g, '/');
}

function laneEvidenceFailure(path: string, detail: string): Error {
  return new Error(`required local review lane evidence is missing or invalid at ${relativeEvidencePath(process.cwd(), path) ?? path}: ${detail}`);
}

function loadLaneEvidence(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, lane: LocalReviewLaneId): { path: string; raw: Record<string, unknown> } {
  const path = laneEvidencePath(repoRoot, issueNumber, prNumber, headSha, lane);
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(parsed)) throw laneEvidenceFailure(path, 'JSON root must be an object.');
    return { path, raw: parsed };
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('required local review lane evidence')) throw error;
    throw laneEvidenceFailure(path, error instanceof Error ? error.message : String(error));
  }
}

function assertArrayField(evidence: Record<string, unknown>, field: string, path: string): void {
  const value = evidence[field];
  if (!Array.isArray(value) || value.length === 0) throw laneEvidenceFailure(path, `${field} must be a non-empty array.`);
}

function validStatus(value: unknown): value is string {
  return value === 'passed' || value === 'failed' || value === 'needs-work' || value === 'pending' || value === 'missing' || value === 'stale' || value === 'unavailable' || value === 'malformed' || value === 'inconclusive';
}

function readStructuredFindings(value: unknown, path: string): ReviewFinding[] {
  if (!Array.isArray(value)) return [];
  const findings: ReviewFinding[] = [];
  for (const [index, item] of value.entries()) {
    const label = `findings[${index}]`;
    if (!isRecord(item)) throw laneEvidenceFailure(path, `${label} must be an object.`);
    if (typeof item.message !== 'string' || item.message.trim() === '') throw laneEvidenceFailure(path, `${label}.message must be a non-empty string.`);
    if (item.location !== undefined && !isRecord(item.location)) throw laneEvidenceFailure(path, `${label}.location must be an object when present.`);
    if (isRecord(item.location) && (typeof item.location.path !== 'string' || item.location.path.trim() === '')) throw laneEvidenceFailure(path, `${label}.location.path must be a non-empty string.`);
    if (isRecord(item.location) && item.location.line !== undefined && !(typeof item.location.line === 'number' && Number.isSafeInteger(item.location.line) && item.location.line > 0)) throw laneEvidenceFailure(path, `${label}.location.line must be a positive integer when present.`);
    if (isRecord(item.location) && item.location.endLine !== undefined && !(typeof item.location.endLine === 'number' && Number.isSafeInteger(item.location.endLine) && item.location.endLine > 0)) throw laneEvidenceFailure(path, `${label}.location.endLine must be a positive integer when present.`);
    if (item.severity !== undefined && item.severity !== 'blocking' && item.severity !== 'advisory') throw laneEvidenceFailure(path, `${label}.severity must be blocking or advisory when present.`);
    const location = isRecord(item.location) && typeof item.location.path === 'string' && item.location.path.trim() !== ''
      ? {
          path: item.location.path.trim(),
          ...(typeof item.location.line === 'number' && Number.isSafeInteger(item.location.line) && item.location.line > 0 ? { line: item.location.line } : {}),
          ...(typeof item.location.endLine === 'number' && Number.isSafeInteger(item.location.endLine) && item.location.endLine > 0 ? { endLine: item.location.endLine } : {}),
          side: item.location.side === 'source' ? 'source' as const : 'destination' as const,
        }
      : undefined;
    findings.push({
      id: typeof item.id === 'string' && item.id.trim() !== '' ? item.id.trim() : `finding-${findings.length + 1}`,
      severity: item.severity === 'blocking' ? 'blocking' : 'advisory',
      ...(location ? { location } : {}),
      message: item.message.trim(),
      ...(typeof item.suggestion === 'string' && item.suggestion.trim() !== '' ? { suggestion: item.suggestion.trim() } : {}),
    });
  }
  return findings;
}

function validateTrustedHostProvenance(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, lane: LocalReviewLaneId, evidence: Record<string, unknown>, evidencePath: string, provenance: Record<string, unknown>): void {
  const path = trustedLocalHostProvenancePath(repoRoot, issueNumber, prNumber, headSha, lane);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error: unknown) {
    throw laneEvidenceFailure(evidencePath, `trusted local-host provenance is missing or unreadable at ${relativeEvidencePath(repoRoot, path) ?? path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw laneEvidenceFailure(evidencePath, 'trusted local-host provenance JSON root must be an object.');
  if (parsed.version !== 1 || parsed.issueNumber !== issueNumber || parsed.prNumber !== prNumber || parsed.headSha !== headSha || parsed.lane !== lane) {
    throw laneEvidenceFailure(evidencePath, 'trusted local-host provenance metadata does not match the lane evidence.');
  }
  if (parsed.runnerKind !== 'local-host' || parsed.freshContext !== true || parsed.promptOnly === true) {
    throw laneEvidenceFailure(evidencePath, 'trusted local-host provenance must record fresh non-prompt-only local-host execution.');
  }
  if (typeof parsed.promptStackHash !== 'string' || parsed.promptStackHash.trim() === '' || parsed.promptStackHash !== provenance.promptStackHash) {
    throw laneEvidenceFailure(evidencePath, 'trusted local-host provenance prompt stack hash does not match lane evidence.');
  }
  if (typeof parsed.evidenceSha256 !== 'string' || parsed.evidenceSha256 !== localReviewEvidenceSha256(evidence)) {
    throw laneEvidenceFailure(evidencePath, 'trusted local-host provenance evidence digest does not match lane evidence.');
  }
  for (const field of ['host', 'model', 'effort', 'isolation', 'invocationId'] as const) {
    if ((parsed[field] ?? null) !== (provenance[field] ?? null)) throw laneEvidenceFailure(evidencePath, `trusted local-host provenance ${field} does not match lane evidence.`);
  }
}

function validateLaneEvidence(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, lane: LocalReviewLaneId): { evidence: Record<string, unknown>; path: string; status: string; summary: string; blockers: string[]; findings: Array<ReviewFinding | string>; completeness: string; profile: string; host: string; recommendation: ReviewForgeLocalReviewRecommendation } {
  const { path, raw } = loadLaneEvidence(repoRoot, issueNumber, prNumber, headSha, lane);
  if ((raw.version ?? raw.schemaVersion) !== 1) throw laneEvidenceFailure(path, 'version must be 1.');
  if ((raw.issueNumber ?? raw.issue) !== issueNumber || (raw.prNumber ?? raw.pr) !== prNumber || raw.headSha !== headSha || (raw.lane ?? raw.id) !== lane) {
    throw laneEvidenceFailure(path, 'issue, PR, head, or lane metadata does not match the publish target.');
  }
  if (!validStatus(raw.status)) throw laneEvidenceFailure(path, 'status must be a known local review status.');
  const summary = stringField(raw, 'summary');
  if (summary === '') throw laneEvidenceFailure(path, 'summary must be a non-empty string.');
  const profile = stringField(raw, 'profile');
  if (profile === '') throw laneEvidenceFailure(path, 'profile must be a non-empty string.');
  assertArrayField(raw, 'artifacts', path);
  assertArrayField(raw, 'contextReviewed', path);
  assertArrayField(raw, 'promptStack', path);
  if (!Array.isArray(raw.preconditions)) throw laneEvidenceFailure(path, 'preconditions must be an array of observed gate-level facts (empty when none were observed).');
  const adapter = raw.adapter;
  if (adapter !== 'local-command' && adapter !== 'local-host') throw laneEvidenceFailure(path, 'adapter must be local-command or local-host.');
  const provenance = raw.runnerProvenance;
  if (!isRecord(provenance)) throw laneEvidenceFailure(path, 'runnerProvenance must be present.');
  if (provenance.runnerKind !== adapter) throw laneEvidenceFailure(path, 'runnerProvenance runnerKind must match the evidence adapter.');
  if (provenance.freshContext !== true) throw laneEvidenceFailure(path, 'runnerProvenance must record fresh independent reviewer context.');
  if (provenance.promptOnly === true) throw laneEvidenceFailure(path, 'prompt-only review output cannot be published as provider-visible lane feedback.');
  const carriedForwardHead = isRecord(raw.carriedForward) && typeof raw.carriedForward.fromHeadSha === 'string' && raw.carriedForward.fromHeadSha.trim() !== '' ? raw.carriedForward.fromHeadSha.trim() : null;
  if (carriedForwardHead) {
    if (provenance.headSha !== carriedForwardHead) throw laneEvidenceFailure(path, 'carried-forward runnerProvenance must reference the prior head it claims.');
  } else if (provenance.headSha !== headSha) {
    throw laneEvidenceFailure(path, 'runnerProvenance headSha must match the publish target.');
  }
  if (typeof provenance.promptStackHash !== 'string' || provenance.promptStackHash.trim() === '') throw laneEvidenceFailure(path, 'runnerProvenance must record a prompt stack hash.');
  if (typeof provenance.taskId !== 'string' && typeof provenance.sessionId !== 'string' && typeof provenance.threadId !== 'string') {
    throw laneEvidenceFailure(path, 'runnerProvenance must record a separate task, session, or thread id.');
  }
  if (adapter === 'local-host') {
    if (carriedForwardHead) {
      const prior = loadLaneEvidence(repoRoot, issueNumber, prNumber, carriedForwardHead, lane);
      if (prior.raw.status !== 'passed' || readRecommendation(prior.raw.recommendation ?? prior.raw.status) !== 'approve') {
        throw laneEvidenceFailure(path, 'carried-forward evidence must reference an approved prior-head lane record.');
      }
      validateTrustedHostProvenance(repoRoot, issueNumber, prNumber, carriedForwardHead, lane, prior.raw, path, provenance);
    } else {
      validateTrustedHostProvenance(repoRoot, issueNumber, prNumber, headSha, lane, raw, path, provenance);
    }
  }
  const blockers = Array.isArray(raw.blockers) ? raw.blockers.filter((item): item is string => typeof item === 'string') : [];
  const structuredFindings = readStructuredFindings(raw.findings, path);
  if (blockers.length > 0 && structuredFindings.length === 0) {
    throw laneEvidenceFailure(path, 'blocking lane evidence must include structured findings[] entries for provider-visible review publishing.');
  }
  const completeness = stringField(raw, 'completeness');
  if (completeness === '') {
    throw laneEvidenceFailure(path, 'completeness must be a non-empty self-check stating what was inspected and what was not.');
  }
  const recommendation = readRecommendation(raw.recommendation ?? raw.status);
  if (!validRecommendationStatus(recommendation, raw.status as LocalReviewStatus)) {
    throw laneEvidenceFailure(path, `recommendation ${recommendation} is not valid with status ${raw.status}; ${recommendationStatusRule()}.`);
  }
  if (structuredFindings.some(finding => finding.severity === 'blocking')
    && (raw.status === 'passed' || recommendation !== 'request-changes')) {
    throw laneEvidenceFailure(path, `recorded blocking structured findings but claimed status ${raw.status} with recommendation ${recommendation}.`);
  }
  return {
    evidence: raw,
    path,
    status: raw.status,
    summary,
    blockers,
    findings: structuredFindings,
    completeness,
    profile,
    host: stringField(provenance, 'host') || 'local-review',
    recommendation,
  };
}

export async function runPrReviewPublishWithProvider(provider: ReviewForgeProvider, options: PrReviewPublishOptions): Promise<PrReviewPublishResult> {
  const repoRoot = options.repoRoot ?? process.cwd();
  const loadedSnapshot = options.headSha && options.issueNumber
    ? null
    : provider.loadPullRequestReviewTarget
      ? null
      : await provider.loadPullRequestReview(options.prNumber);
  const target = options.headSha && options.issueNumber
    ? null
    : provider.loadPullRequestReviewTarget
      ? await provider.loadPullRequestReviewTarget(options.prNumber)
      : loadedSnapshot;
  const headSha = options.headSha ?? target?.pr.headRefOid ?? '';
  const issueNumber = options.issueNumber ?? target?.closingIssueNumbers[0] ?? 0;
  if (issueNumber <= 0) {
    throw new Error('publish lane review failed. Likely cause: no linked issue number was available. Next action: pass --issue or link a closing issue on the pull request.');
  }
  const evidence = validateLaneEvidence(repoRoot, issueNumber, options.prNumber, headSha, options.lane);
  const carriedForward = isRecord(evidence.evidence.carriedForward) && typeof evidence.evidence.carriedForward.fromHeadSha === 'string' ? evidence.evidence.carriedForward.fromHeadSha.trim() : null;
  if (carriedForward) {
    if (options.carryForwardPublish === 'none') {
      return {
        ok: true,
        command: 'pr review publish',
        prNumber: options.prNumber,
        lane: options.lane,
        publish: { status: 'skipped', runId: null, marker: null, body: null, url: null, failure: null, nextAction: `Carried-forward lane publishing is disabled by policy; local carried evidence for ${options.lane} satisfies the gate.` },
      };
    }
    const deltaPaths = gitDeltaPathsSync(repoRoot, carriedForward, headSha);
    if (deltaPaths === null) {
      throw new Error(`publish lane review failed. Likely cause: the carried-forward delta from ${carriedForward} could not be verified with git. Next action: rerun the lane review for the current head instead of carrying it forward.`);
    }
    if (carryForwardDeltaTouched(deltaPaths, options.carryForwardScope?.laneMatchPatterns[options.lane] ?? [], options.carryForwardScope?.contextPatterns ?? [], options.carryForwardScope?.laneContextModes?.[options.lane] ?? defaultCarryForwardContext(options.lane))) {
      throw new Error(`publish lane review failed. Likely cause: the head delta touches the ${options.lane} lane scope or review context, so carried-forward evidence is invalid. Next action: rerun the lane review for the current head.`);
    }
  }
  const publishInput = {
    dryRun: options.dryRun ?? false,
    prNumber: options.prNumber,
    headSha,
    lane: options.lane,
    profile: evidence.profile,
    status: evidence.status,
    recommendation: evidence.recommendation,
    host: evidence.host,
    issueNumber,
    summary: evidence.summary,
    findings: evidence.findings,
    completeness: evidence.completeness,
    evidencePath: relativeEvidencePath(repoRoot, evidence.path),
  };
  const publish = provider.publishLaneReviewFeedbackForPullRequest
    ? await provider.publishLaneReviewFeedbackForPullRequest(publishInput)
    : await provider.publishLaneReviewFeedback((loadedSnapshot?.pr.headRefOid === headSha ? loadedSnapshot : await loadCachedSnapshot(provider, options.prNumber, headSha, snapshotCachePath(repoRoot, issueNumber, options.prNumber, headSha))).item, publishInput);
  return { ok: true, command: 'pr review publish', prNumber: options.prNumber, lane: options.lane, publish };
}

export async function runPrReviewPublishService(config: Config, options: PrReviewPublishOptions): Promise<PrReviewPublishResult> {
  const repoRoot = options.repoRoot ?? process.cwd();
  const provider = await createReviewForgeProvider(config.providers.review.kind, { exec: options.exec, cwd: repoRoot, reviewAgents: config.reviewAgents, publisher: config.providers.review.publisher ?? null, ...config.providers.connections[config.providers.review.kind], ...config.providers.review.connection });
  return runPrReviewPublishWithProvider(provider, { ...options, repoRoot, carryForwardPublish: options.carryForwardPublish ?? config.reviewCarryForwardPublish });
}

export function formatPrReviewPublish(result: PrReviewPublishResult): string {
  return `PR review publish for #${result.prNumber} lane ${result.lane}: ${result.publish.status}. ${result.publish.nextAction}`;
}
