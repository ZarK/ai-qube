import type { Config } from '../config/index.js';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { ReviewFinding } from '@tjalve/qube-core';
import { localReviewEvidenceSha256, trustedLocalHostProvenancePath, type LocalReviewLaneId } from '../local_review_evidence.js';
import { createReviewForgeProvider } from '../providers/review_forge_adapters.js';
import type { ReviewForgeLaneReviewPublishResult, ReviewForgeLocalReviewRecommendation } from '../providers/review_forge_provider.js';
import type { PrGateExec } from './pr_gate.js';

export interface PrReviewPublishOptions {
  prNumber: number;
  lane: LocalReviewLaneId;
  issueNumber?: number;
  headSha?: string;
  dryRun?: boolean;
  repoRoot?: string;
  exec?: PrGateExec;
}

export interface PrReviewPublishResult {
  ok: true;
  command: 'pr review publish';
  prNumber: number;
  lane: LocalReviewLaneId;
  publish: ReviewForgeLaneReviewPublishResult;
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

function readStructuredFindings(value: unknown): ReviewFinding[] {
  if (!Array.isArray(value)) return [];
  const findings: ReviewFinding[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.message !== 'string' || item.message.trim() === '') continue;
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
}

function validateLaneEvidence(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, lane: LocalReviewLaneId): { evidence: Record<string, unknown>; path: string; status: string; summary: string; blockers: string[]; findings: Array<ReviewFinding | string>; profile: string; host: string; recommendation: ReviewForgeLocalReviewRecommendation } {
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
  const adapter = raw.adapter;
  if (adapter !== 'local-command' && adapter !== 'local-host') throw laneEvidenceFailure(path, 'adapter must be local-command or local-host.');
  const provenance = raw.runnerProvenance;
  if (!isRecord(provenance)) throw laneEvidenceFailure(path, 'runnerProvenance must be present.');
  if (provenance.runnerKind !== adapter) throw laneEvidenceFailure(path, 'runnerProvenance runnerKind must match the evidence adapter.');
  if (provenance.freshContext !== true) throw laneEvidenceFailure(path, 'runnerProvenance must record fresh independent reviewer context.');
  if (provenance.promptOnly === true) throw laneEvidenceFailure(path, 'prompt-only review output cannot be published as provider-visible lane feedback.');
  if (provenance.headSha !== headSha) throw laneEvidenceFailure(path, 'runnerProvenance headSha must match the publish target.');
  if (typeof provenance.promptStackHash !== 'string' || provenance.promptStackHash.trim() === '') throw laneEvidenceFailure(path, 'runnerProvenance must record a prompt stack hash.');
  if (typeof provenance.taskId !== 'string' && typeof provenance.sessionId !== 'string' && typeof provenance.threadId !== 'string') {
    throw laneEvidenceFailure(path, 'runnerProvenance must record a separate task, session, or thread id.');
  }
  if (adapter === 'local-host') validateTrustedHostProvenance(repoRoot, issueNumber, prNumber, headSha, lane, raw, path, provenance);
  const blockers = Array.isArray(raw.blockers) ? raw.blockers.filter((item): item is string => typeof item === 'string') : [];
  const structuredFindings = readStructuredFindings(raw.findings);
  return {
    evidence: raw,
    path,
    status: raw.status,
    summary,
    blockers,
    findings: structuredFindings.length > 0 ? structuredFindings : blockers,
    profile,
    host: stringField(provenance, 'host') || 'local-review',
    recommendation: readRecommendation(raw.recommendation ?? raw.status),
  };
}

export async function runPrReviewPublishService(config: Config, options: PrReviewPublishOptions): Promise<PrReviewPublishResult> {
  const repoRoot = options.repoRoot ?? process.cwd();
  const provider = await createReviewForgeProvider(config.providers.review.kind, { exec: options.exec, cwd: repoRoot });
  const target = options.headSha && options.issueNumber
    ? null
    : provider.loadPullRequestReviewTarget
      ? await provider.loadPullRequestReviewTarget(options.prNumber)
      : await provider.loadPullRequestReview(options.prNumber);
  const headSha = options.headSha ?? target?.pr.headRefOid ?? '';
  const issueNumber = options.issueNumber ?? target?.closingIssueNumbers[0] ?? 0;
  if (issueNumber <= 0) {
    throw new Error('publish lane review failed. Likely cause: no linked issue number was available. Next action: pass --issue or link a closing issue on the pull request.');
  }
  const evidence = validateLaneEvidence(repoRoot, issueNumber, options.prNumber, headSha, options.lane);
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
    evidencePath: relativeEvidencePath(repoRoot, evidence.path),
  };
  const publish = provider.publishLaneReviewFeedbackForPullRequest
    ? await provider.publishLaneReviewFeedbackForPullRequest(publishInput)
    : await provider.publishLaneReviewFeedback((await provider.loadPullRequestReview(options.prNumber)).item, publishInput);
  return { ok: true, command: 'pr review publish', prNumber: options.prNumber, lane: options.lane, publish };
}

export function formatPrReviewPublish(result: PrReviewPublishResult): string {
  return `PR review publish for #${result.prNumber} lane ${result.lane}: ${result.publish.status}. ${result.publish.nextAction}`;
}
