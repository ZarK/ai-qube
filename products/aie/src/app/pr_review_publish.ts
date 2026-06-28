import type { Config } from '../config/index.js';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { LocalReviewLaneId } from '../local_review_evidence.js';
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

function loadLaneEvidence(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, lane: LocalReviewLaneId): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(laneEvidencePath(repoRoot, issueNumber, prNumber, headSha, lane), 'utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function runPrReviewPublishService(config: Config, options: PrReviewPublishOptions): Promise<PrReviewPublishResult> {
  const repoRoot = options.repoRoot ?? process.cwd();
  const provider = await createReviewForgeProvider(config.providers.review.kind, { exec: options.exec, cwd: repoRoot });
  const snapshot = await provider.loadPullRequestReview(options.prNumber);
  const headSha = options.headSha ?? snapshot.pr.headRefOid;
  const issueNumber = options.issueNumber ?? snapshot.closingIssueNumbers[0] ?? 0;
  if (issueNumber <= 0) {
    throw new Error('publish lane review failed. Likely cause: no linked issue number was available. Next action: pass --issue or link a closing issue on the pull request.');
  }
  const evidence = loadLaneEvidence(repoRoot, issueNumber, options.prNumber, headSha, options.lane);
  const summary = typeof evidence?.summary === 'string' && evidence.summary.trim() !== '' ? evidence.summary.trim() : `${options.lane} review completed.`;
  const blockers = Array.isArray(evidence?.blockers) ? evidence.blockers.filter((item): item is string => typeof item === 'string') : [];
  const profile = typeof evidence?.profile === 'string' ? evidence.profile : config.reviewProfile;
  const host = isRecord(evidence?.runnerProvenance) && typeof evidence.runnerProvenance.host === 'string'
    ? evidence.runnerProvenance.host
    : 'codex';
  const publishInput = {
    dryRun: options.dryRun ?? false,
    prNumber: options.prNumber,
    headSha,
    lane: options.lane,
    profile,
    status: typeof evidence?.status === 'string' ? evidence.status : 'passed',
    recommendation: readRecommendation(evidence?.recommendation ?? evidence?.status),
    host,
    issueNumber,
    summary,
    findings: blockers,
    evidencePath: relativeEvidencePath(repoRoot, laneEvidencePath(repoRoot, issueNumber, options.prNumber, headSha, options.lane)),
  };
  const publish = await provider.publishLaneReviewFeedback(snapshot.item, publishInput);
  return { ok: true, command: 'pr review publish', prNumber: options.prNumber, lane: options.lane, publish };
}

export function formatPrReviewPublish(result: PrReviewPublishResult): string {
  return `PR review publish for #${result.prNumber} lane ${result.lane}: ${result.publish.status}. ${result.publish.nextAction}`;
}