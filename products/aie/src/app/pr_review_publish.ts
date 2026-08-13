import type { Config } from '../config/index.js';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { ReviewFinding } from '@tjalve/qube-core';
import { COMPREHENSIVE_LOCAL_REVIEW_LANES, LANE_ARTIFACT_REQUIREMENT, gitDeltaPathsSync, laneArtifactViolation, localReviewEvidenceSha256, recommendationStatusRule, trustedLocalHostProvenancePath, validRecommendationStatus, verifyTrustedStoreChain, type CarryForwardScope, type LocalReviewLaneId, type LocalReviewStatus } from '../local_review_evidence.js';
import { activeLocalReviewFocusesForConfig, carryForwardDeltaTouched, defaultCarryForwardContext, reviewLanePublicationPolicy } from '../review_focus.js';
import { reviewRoundId } from '../review_round.js';
import { createReviewForgeProvider } from '../providers/review_forge_adapters.js';
import type { ReviewForgeLaneReviewPublishResult, ReviewForgeLocalReviewRecommendation, ReviewForgeProvider, ReviewForgeSnapshot } from '../providers/review_forge_provider.js';
import { planFindingPublication, type SynthesisLaneInput } from '../review_synthesis.js';
import { verifyReviewWriteContainment, writeReviewFileGuarded } from './local_review_runner_support.js';
import type { PrGateExec } from './pr_gate.js';

// The default advisory publication cap when neither the caller nor config
// resolves an explicit value; kept in sync with the config schema default.
const DEFAULT_REVIEW_NIT_CAP = 10;

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
  expectedLanes?: readonly LocalReviewLaneId[];
  /**
   * Expected lanes whose current-head evidence is a trusted-provider reuse
   * marker with no local evidence file. Synthesis treats them as approved,
   * finding-free siblings instead of failing the mixed head closed.
   */
  providerReuseLanes?: readonly LocalReviewLaneId[];
  /**
   * Paths changed by this PR head. Undefined disables only the synthesis
   * off-diff advisory filter (the delta was not observed); an empty array is
   * a genuine observation of an empty diff and withholds anchored advisories;
   * null records a failed delta observation and fails publication closed.
   * Dedupe and the nit cap always apply.
   */
  changedPaths?: readonly string[] | null;
  /**
   * Base ref for computing the changed-path delta against the RESOLVED
   * publish head when the caller did not observe changedPaths itself; the
   * delta must never bind to a possibly stale local HEAD.
   */
  deltaBaseRef?: string;
  /** Global advisory publication cap for cross-lane synthesis; defaults to DEFAULT_REVIEW_NIT_CAP. */
  nitCap?: number;
  laneSuppress?: Readonly<Record<string, readonly string[]>>;
  laneAdvisoryCaps?: Readonly<Record<string, number>>;
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

// Cache reads apply the same trust rules as cache writes: an absent file is
// a miss, but a symlinked cache file or a relocated ancestor chain fails
// the read closed instead of feeding redirected snapshot state into
// publication decisions.
function cachedSnapshotFromFile(repoRoot: string, path: string, prNumber: number, headSha: string): ReviewForgeSnapshot | null {
  verifyTrustedStoreChain(repoRoot, ['.qube', 'aie', 'reviews'], path);
  let cacheStats;
  try {
    cacheStats = lstatSync(path);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Refusing to treat an unreadable snapshot cache as a miss: ${path}. Fix filesystem access, then rerun.`);
  }
  if (!cacheStats.isFile()) {
    throw new Error(`Refusing to read the snapshot cache through a non-regular file: ${path}. Remove the symlink or junction, then rerun.`);
  }
  verifyReviewWriteContainment(path, { repoRoot, subtree: ['.qube', 'aie', 'reviews'] });
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

// The fallback snapshot cache lives inside the review evidence subtree and
// gets the same containment and symlink guards as evidence writes: a
// symlinked descendant must not redirect the temp file or the final rename
// outside the repository.
function writeSnapshotCache(repoRoot: string, path: string, snapshot: ReviewForgeSnapshot): void {
  // Chain verification runs before directory creation so mkdir can never
  // materialize directories through an existing symlinked ancestor.
  verifyTrustedStoreChain(repoRoot, ['.qube', 'aie', 'reviews'], path);
  mkdirSync(dirname(path), { recursive: true });
  verifyReviewWriteContainment(path, { repoRoot, subtree: ['.qube', 'aie', 'reviews'] });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeReviewFileGuarded(tempPath, JSON.stringify(snapshot), { repoRoot, subtree: ['.qube', 'aie', 'reviews'] });
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`Refusing to replace a symlinked snapshot cache: ${path}. Remove the symlink, then rerun.`);
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.message.startsWith('Refusing to replace')) throw err;
    // A missing cache file is the normal first-write case.
  }
  // Revalidate the chain immediately before the rename: a concurrent junction
  // swap of a parent between the temp write and this rename must fail closed.
  verifyTrustedStoreChain(repoRoot, ['.qube', 'aie', 'reviews'], path);
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

async function loadSnapshotWithFileCache(provider: ReviewForgeProvider, prNumber: number, headSha: string, cachePath: string, repoRoot: string): Promise<ReviewForgeSnapshot> {
  const cachedFile = cachedSnapshotFromFile(repoRoot, cachePath, prNumber, headSha);
  if (cachedFile) return cachedFile;
  const lockPath = snapshotCacheLockPath(cachePath);
  const deadline = Date.now() + SNAPSHOT_CACHE_LOCK_TIMEOUT_MS;
  while (true) {
    if (tryAcquireSnapshotCacheLock(lockPath)) {
      try {
        const cachedAfterLock = cachedSnapshotFromFile(repoRoot, cachePath, prNumber, headSha);
        if (cachedAfterLock) return cachedAfterLock;
        const snapshot = await provider.loadPullRequestReview(prNumber);
        if (snapshot.pr.headRefOid !== headSha) {
          throw new Error(`publish lane review failed. Likely cause: pull request #${prNumber} head changed from ${headSha} to ${snapshot.pr.headRefOid}. Next action: rerun pr gate for the current PR head.`);
        }
        writeSnapshotCache(repoRoot, cachePath, snapshot);
        return snapshot;
      } finally {
        releaseSnapshotCacheLock(lockPath);
      }
    }
    const cachedWhileWaiting = cachedSnapshotFromFile(repoRoot, cachePath, prNumber, headSha);
    if (cachedWhileWaiting) return cachedWhileWaiting;
    if (Date.now() >= deadline) {
      throw new Error(`publish lane review failed. Likely cause: fallback snapshot cache for pull request #${prNumber} head ${headSha} stayed locked. Next action: remove stale cache lock ${relativeEvidencePath(process.cwd(), lockPath) ?? lockPath}, rerun pr gate for the current PR head, then retry lane publish.`);
    }
    await sleep(SNAPSHOT_CACHE_LOCK_POLL_MS);
  }
}

async function loadCachedSnapshot(provider: ReviewForgeProvider, prNumber: number, headSha: string, cachePath: string | undefined, repoRoot: string): Promise<ReviewForgeSnapshot> {
  const key = snapshotCacheKey(prNumber, headSha, cachePath);
  const cached = snapshotCacheByHead.get(key);
  if (cached) return cached;
  const loaded = (cachePath ? loadSnapshotWithFileCache(provider, prNumber, headSha, cachePath, repoRoot) : provider.loadPullRequestReview(prNumber).then(snapshot => {
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

// Sibling lane evidence feeds cross-lane synthesis only when it passes the
// same full current-head validation as the publishing lane (identity,
// status/recommendation consistency, artifact contract, trusted provenance).
// An unvalidated sibling must never claim ownership of a finding identity,
// because dedupe would then withhold the real lane's finding from the
// provider. A missing or invalid sibling no longer withholds this lane's
// publication: per-result validation is the only withhold reason, so
// synthesis runs over the siblings that validate, and round completeness on
// the read side keeps a partial round from ever counting as approved.
function loadSiblingSynthesisLanes(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, excludeLane: LocalReviewLaneId, expectedLanes: readonly LocalReviewLaneId[], providerReuseLanes: ReadonlySet<LocalReviewLaneId>): { siblings: SynthesisLaneInput[]; missing: LocalReviewLaneId[] } {
  const siblings: SynthesisLaneInput[] = [];
  const missing: LocalReviewLaneId[] = [];
  for (const laneId of expectedLanes) {
    if (laneId === excludeLane) continue;
    try {
      const sibling = validateLaneEvidence(repoRoot, issueNumber, prNumber, headSha, laneId);
      siblings.push({ laneId, findings: sibling.findings });
    } catch (error) {
      // A trusted-provider-reuse sibling is an already-approved lane whose
      // evidence lives only on its provider marker, so it has no local file
      // and contributes no findings to synthesis; it must not fail the mixed
      // head closed. Any other local-origin sibling that fails validation is
      // genuinely missing and fails publication closed.
      if (providerReuseLanes.has(laneId)) {
        siblings.push({ laneId, findings: [] });
      } else {
        missing.push(laneId);
      }
    }
  }
  return { siblings, missing };
}

export interface ValidatedRoundLane {
  readonly laneId: LocalReviewLaneId;
  readonly status: string;
  readonly recommendation: ReviewForgeLocalReviewRecommendation;
  readonly summary: string;
  readonly findings: ReviewFinding[];
  readonly preconditions: readonly string[];
  /** The head this lane's own evidence record was recorded at; equals the round head unless the lane carried evidence forward. */
  readonly evidenceHeadSha: string;
  readonly carriedForwardFromHeadSha: string | null;
  readonly path: string;
}

// Loads every expected lane's current-head validated evidence for a round
// summary, reusing the exact same fail-closed validation as per-lane publish
// (trust chain, provenance, artifact contract) so the summary never renders
// content that would not itself pass lane publication.
export function loadValidatedRoundLanes(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, expectedLanes: readonly LocalReviewLaneId[], providerReuseLanes: ReadonlySet<LocalReviewLaneId>): { lanes: ValidatedRoundLane[]; missing: LocalReviewLaneId[] } {
  const lanes: ValidatedRoundLane[] = [];
  const missing: LocalReviewLaneId[] = [];
  for (const laneId of expectedLanes) {
    try {
      const validated = validateLaneEvidence(repoRoot, issueNumber, prNumber, headSha, laneId);
      const carriedForwardFromHeadSha = isRecord(validated.evidence.carriedForward) && typeof validated.evidence.carriedForward.fromHeadSha === 'string' && validated.evidence.carriedForward.fromHeadSha.trim() !== ''
        ? validated.evidence.carriedForward.fromHeadSha.trim()
        : null;
      const preconditions = Array.isArray(validated.evidence.preconditions)
        ? validated.evidence.preconditions.filter((entry): entry is string => typeof entry === 'string')
        : [];
      lanes.push({
        laneId,
        status: validated.status,
        recommendation: validated.recommendation,
        summary: validated.summary,
        findings: validated.findings,
        preconditions,
        evidenceHeadSha: carriedForwardFromHeadSha ?? headSha,
        carriedForwardFromHeadSha,
        path: validated.path,
      });
    } catch (error) {
      if (providerReuseLanes.has(laneId)) {
        lanes.push({
          laneId,
          status: 'passed',
          recommendation: 'approve',
          summary: 'Trusted provider current-head review reused.',
          findings: [],
          preconditions: [],
          evidenceHeadSha: headSha,
          carriedForwardFromHeadSha: null,
          path: '',
        });
        continue;
      }
      missing.push(laneId);
      void error;
    }
  }
  return { lanes, missing };
}

function laneEvidenceFailure(path: string, detail: string): Error {
  return new Error(`required local review lane evidence is missing or invalid at ${relativeEvidencePath(process.cwd(), path) ?? path}: ${detail}`);
}

// Profile and host serialize verbatim into provider-visible marker metadata,
// so they must stay short fixed-charset identifiers: free text here could
// leak paths or secrets and break out of the marker comment.
function validPublishIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}

function loadLaneEvidence(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, lane: LocalReviewLaneId): { path: string; raw: Record<string, unknown> } {
  const path = laneEvidencePath(repoRoot, issueNumber, prNumber, headSha, lane);
  // Evidence reads go through the verified literal chain and must land on a
  // regular file: a planted symlink or junction can never redirect the gate
  // to forged evidence outside the store.
  verifyTrustedStoreChain(repoRoot, ['.qube', 'aie', 'reviews'], path);
  try {
    if (!lstatSync(path).isFile()) throw laneEvidenceFailure(path, 'evidence must be a regular file, not a symlink or directory.');
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('required local review lane evidence')) throw error;
    throw laneEvidenceFailure(path, 'evidence file is missing or unreadable.');
  }
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
    if (item.confidence !== undefined && !(typeof item.confidence === 'number' && Number.isFinite(item.confidence) && item.confidence >= 0 && item.confidence <= 1)) {
      throw laneEvidenceFailure(path, `${label}.confidence must be a number between 0 and 1 when present.`);
    }
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
      ...(typeof item.confidence === 'number' ? { confidence: item.confidence } : {}),
    });
  }
  return findings;
}

function validateTrustedHostProvenance(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, lane: LocalReviewLaneId, evidence: Record<string, unknown>, evidencePath: string, provenance: Record<string, unknown>): void {
  const path = trustedLocalHostProvenancePath(repoRoot, issueNumber, prNumber, headSha, lane);
  verifyTrustedStoreChain(repoRoot, ['.git', 'qube', 'aie'], path);
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

function validateLaneEvidence(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, lane: LocalReviewLaneId): { evidence: Record<string, unknown>; path: string; status: string; summary: string; blockers: string[]; findings: ReviewFinding[]; completeness: string; profile: string; host: string; recommendation: ReviewForgeLocalReviewRecommendation } {
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
  if (!validPublishIdentifier(profile)) throw laneEvidenceFailure(path, 'profile must be a short identifier of letters, digits, dot, underscore, or dash; it serializes into provider-visible marker metadata.');
  {
    const artifactViolation = laneArtifactViolation(lane, String(raw.status), raw.artifacts, repoRoot);
    if (artifactViolation) throw laneEvidenceFailure(path, `${artifactViolation} ${LANE_ARTIFACT_REQUIREMENT}`);
  }
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
      const priorArtifactViolation = laneArtifactViolation(lane, String(prior.raw.status), prior.raw.artifacts, repoRoot);
      if (priorArtifactViolation) throw laneEvidenceFailure(path, `carried-forward prior-head record is incomplete: ${priorArtifactViolation} ${LANE_ARTIFACT_REQUIREMENT}`);
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
  if (recommendation === 'request-changes' && structuredFindings.length === 0) {
    throw laneEvidenceFailure(path, 'request-changes evidence must include at least one structured findings[] entry; a rejection without findings publishes no provider-visible obligation.');
  }
  if (structuredFindings.some(finding => finding.severity === 'blocking')
    && (raw.status === 'passed' || recommendation !== 'request-changes')) {
    throw laneEvidenceFailure(path, `recorded blocking structured findings but claimed status ${raw.status} with recommendation ${recommendation}.`);
  }
  const host = stringField(provenance, 'host') || 'local-review';
  if (!validPublishIdentifier(host)) throw laneEvidenceFailure(path, 'runnerProvenance host must be a short identifier of letters, digits, dot, underscore, or dash; it serializes into provider-visible marker metadata.');
  return {
    evidence: raw,
    path,
    status: raw.status,
    summary,
    blockers,
    findings: structuredFindings,
    completeness,
    profile,
    host,
    recommendation,
  };
}

export async function runPrReviewPublishWithProvider(provider: ReviewForgeProvider, options: PrReviewPublishOptions): Promise<PrReviewPublishResult> {
  // A single-lane default would publish markers whose expected set hides the
  // other active lanes and corrupts convergence stats, so the resolved active
  // lane set is mandatory here; the service entry resolves it from config.
  if (!options.expectedLanes || options.expectedLanes.length === 0) {
    throw new Error('publish lane review failed. Likely cause: no expected lane set was provided. Next action: resolve the active review lanes for this change before publishing the lane review.');
  }
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
  // Only terminal verdicts are provider-worthy results. Pending and
  // inconclusive evidence is a rerun signal: publishing it would mint a
  // marker the same round immediately supersedes, violating the
  // one-marker-per-lane-per-round noise bound.
  if (evidence.status !== 'passed' && evidence.status !== 'failed' && evidence.status !== 'needs-work') {
    throw new Error(`publish lane review failed. Likely cause: ${options.lane} evidence carries the non-terminal status ${evidence.status}; only terminal lane verdicts (passed, failed, needs-work) publish provider-visible reviews. Next action: rerun the lane to a terminal verdict, then publish.`);
  }
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
  // Synthesis is the last mile before publication: it dedupes this lane's
  // findings against every other expected lane at the same head (so a
  // gate-level restatement never republishes), drops advisory findings
  // outside the diff, and enforces the global advisory nit cap exactly once.
  // The delta binds to the resolved publish head, never to local HEAD: a
  // stale checkout must not classify current-head findings as off-diff.
  const changedPaths = options.changedPaths !== undefined
    ? options.changedPaths
    : options.deltaBaseRef
      ? gitDeltaPathsSync(repoRoot, options.deltaBaseRef, headSha)
      : undefined;
  if (changedPaths === null) {
    throw new Error('publish lane review failed. Likely cause: the changed-path delta for this head could not be observed with git, so off-diff synthesis filtering cannot run truthfully. Next action: fetch the configured base branch and the PR head, then rerun publish.');
  }
  // One canonical expected lane set drives sibling synthesis and provider
  // metadata: it must name the publishing lane exactly once and contain
  // only known lane ids, or markers could disown their own lane and
  // duplicated entries would double-count findings during synthesis.
  if (!options.expectedLanes || options.expectedLanes.length === 0) {
    throw new Error('publish lane review failed. Likely cause: no expected lane set was provided; a single-lane default would hide the head\'s other active lanes and corrupt convergence stats. Next action: pass the complete validated lane set for this head.');
  }
  const providedLaneIds = options.expectedLanes;
  const expectedLaneIds = [...new Set(providedLaneIds)];
  if (expectedLaneIds.length !== providedLaneIds.length) {
    throw new Error(`publish lane review failed. Likely cause: the expected lane set contains duplicate lane ids (${providedLaneIds.join(', ')}). Next action: pass each expected lane exactly once.`);
  }
  const knownLaneIds = new Set<string>(COMPREHENSIVE_LOCAL_REVIEW_LANES);
  const unknownLaneIds = expectedLaneIds.filter(laneId => !knownLaneIds.has(laneId));
  if (unknownLaneIds.length > 0) {
    throw new Error(`publish lane review failed. Likely cause: the expected lane set names unknown lane id(s) ${unknownLaneIds.join(', ')}. Next action: pass only configured review lane ids.`);
  }
  if (!expectedLaneIds.includes(options.lane)) {
    throw new Error(`publish lane review failed. Likely cause: the expected lane set (${expectedLaneIds.join(', ')}) does not name the publishing lane ${options.lane}. Next action: include the publishing lane in the expected set.`);
  }
  const providerReuseLaneSet = new Set<LocalReviewLaneId>(options.providerReuseLanes ?? []);
  const { siblings } = loadSiblingSynthesisLanes(repoRoot, issueNumber, options.prNumber, headSha, options.lane, expectedLaneIds, providerReuseLaneSet);
  const synthesisLanes: SynthesisLaneInput[] = [
    { laneId: options.lane, findings: evidence.findings },
    ...siblings,
  ];
  const synthesisPlan = planFindingPublication(synthesisLanes, {
    changedPaths,
    nitCap: options.nitCap ?? DEFAULT_REVIEW_NIT_CAP,
    laneSuppress: options.laneSuppress,
    laneAdvisoryCaps: options.laneAdvisoryCaps,
  }).find(plan => plan.laneId === options.lane);
  if (!synthesisPlan) {
    throw new Error(`publish lane review failed. Likely cause: cross-lane synthesis returned no plan for lane ${options.lane}. Next action: rerun the lane review for the current head.`);
  }
  // A request-changes lane must leave at least one provider-visible
  // obligation. Synthesis reports whether any of this lane's findings survived
  // onto some marker (this lane or the identity owner); a duplicate this lane
  // withheld can still vanish if the owner dropped it off-diff or by the cap,
  // so the guard fails closed on the union-visibility signal, not on which
  // withhold bucket was hit.
  if (synthesisPlan.published.length === 0 && evidence.recommendation === 'request-changes' && !synthesisPlan.hasVisibleObligation) {
    throw new Error(`publish lane review failed. Likely cause: cross-lane synthesis left no provider-visible obligation for the request-changes lane ${options.lane} (${synthesisPlan.withheldDuplicates} duplicate(s), ${synthesisPlan.withheldOffDiff} off-diff, ${synthesisPlan.withheldByCap} beyond the cap), and no other lane published the withheld identities. Next action: rerun the lane review with anchored findings for this head, or raise policy.reviews.nitCap.`);
  }
  const publishInput = {
    dryRun: options.dryRun ?? false,
    prNumber: options.prNumber,
    headSha,
    lane: options.lane,
    expectedLanes: expectedLaneIds,
    round: reviewRoundId({ prNumber: options.prNumber, headSha, expectedLanes: expectedLaneIds, issueNumber }),
    profile: evidence.profile,
    status: evidence.status,
    recommendation: evidence.recommendation,
    host: evidence.host,
    issueNumber,
    summary: evidence.summary,
    findings: synthesisPlan.published,
    completeness: evidence.completeness,
    evidencePath: relativeEvidencePath(repoRoot, evidence.path),
    withheld: { duplicates: synthesisPlan.withheldDuplicates, offDiff: synthesisPlan.withheldOffDiff, byCap: synthesisPlan.withheldByCap },
  };
  // Both publish paths verify the provider still points at the head being
  // published: the adapter's ForPullRequest path rejects a stale input head
  // against the PR it loads, and the legacy path goes through
  // loadCachedSnapshot, which throws on a head change.
  const publish = provider.publishLaneReviewFeedbackForPullRequest
    ? await provider.publishLaneReviewFeedbackForPullRequest(publishInput)
    : await provider.publishLaneReviewFeedback((loadedSnapshot?.pr.headRefOid === headSha ? loadedSnapshot : await loadCachedSnapshot(provider, options.prNumber, headSha, snapshotCachePath(repoRoot, issueNumber, options.prNumber, headSha), repoRoot)).item, publishInput);
  return { ok: true, command: 'pr review publish', prNumber: options.prNumber, lane: options.lane, publish };
}

export async function runPrReviewPublishService(config: Config, options: PrReviewPublishOptions): Promise<PrReviewPublishResult> {
  const repoRoot = options.repoRoot ?? process.cwd();
  const provider = await createReviewForgeProvider(config.providers.review.kind, { exec: options.exec, cwd: repoRoot, reviewAgents: config.reviewAgents, publisher: config.providers.review.publisher ?? null, ...config.providers.connections[config.providers.review.kind], ...config.providers.review.connection });
  // Lane activation may look at the local delta, but the synthesis filter
  // itself binds to the resolved publish head inside the provider run via
  // deltaBaseRef; a failed observation there fails publication closed after
  // own-lane evidence validation has raised its more actionable errors.
  const laneActivationPaths = options.changedPaths ?? gitDeltaPathsSync(repoRoot, `${config.baseRemote}/${config.baseBranch}`, options.headSha ?? 'HEAD') ?? undefined;
  const expectedLanes = options.expectedLanes ?? activeLocalReviewFocusesForConfig(config, laneActivationPaths);
  return runPrReviewPublishWithProvider(provider, {
    ...options,
    repoRoot,
    expectedLanes,
    carryForwardPublish: options.carryForwardPublish ?? config.reviewCarryForwardPublish,
    changedPaths: options.changedPaths,
    deltaBaseRef: options.deltaBaseRef ?? `${config.baseRemote}/${config.baseBranch}`,
    nitCap: options.nitCap ?? config.reviewNitCap,
    ...reviewLanePublicationPolicy(config.reviewLanes),
  });
}

// The CLI must not report a failed provider publication as success; the
// runtime handler turns a non-null message into a failing command result.
export function prReviewPublishFailureMessage(result: PrReviewPublishResult): string | null {
  if (result.publish.status !== 'failed') return null;
  const cause = result.publish.failure ?? result.publish.nextAction ?? 'provider publication failed';
  return `Failed to publish lane review for #${result.prNumber} lane ${result.lane}. Likely cause: ${cause}.`;
}

export function formatPrReviewPublish(result: PrReviewPublishResult): string {
  return `PR review publish for #${result.prNumber} lane ${result.lane}: ${result.publish.status}. ${result.publish.nextAction}`;
}
