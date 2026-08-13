import { createHash } from 'node:crypto';
import type { Config } from '../config/index.js';
import { runPrBatchService } from './pr_batch.js';
import { redact } from '../redact.js';
import {
  REVIEW_LEARNINGS_RELATIVE_PATH,
  appendReviewLearning,
  loadReviewLearnings,
  type ReviewLearningDisposition,
  type ReviewLearningEntry,
} from '../review_learnings.js';

export interface ReviewFeedbackFindingMatch {
  findingId: string;
  contentHash?: string | null;
  message: string;
  laneId: string | null;
  path?: string | null;
  headSha?: string | null;
}

export interface ReviewFeedbackOptions {
  prNumber?: number;
  accept?: string;
  reject?: string;
  guidance?: string;
  list?: boolean;
  dryRun?: boolean;
  repoRoot?: string;
  resolveFinding?: (findingId: string) => Promise<ReviewFeedbackFindingMatch | null>;
}

export interface ReviewFeedbackResult {
  ok: true;
  command: 'review feedback';
  dryRun: boolean;
  path: string;
  action: 'list' | 'accepted' | 'rejected' | 'guidance';
  entry: ReviewLearningEntry | null;
  entries: ReviewLearningEntry[];
  summary: string;
  nextAction: string;
}

async function lookupCurrentHeadFinding(config: Config, prNumber: number, repoRoot: string, findingId: string): Promise<ReviewFeedbackFindingMatch | null> {
  const batch = await runPrBatchService(config, { prNumber, repoRoot });
  const finding = batch.batch.findings.find(item => item.findingId === findingId || item.contentHash === findingId);
  if (!finding) return null;
  return {
    findingId: finding.findingId,
    contentHash: finding.contentHash,
    message: finding.message,
    laneId: finding.laneId,
    path: finding.location?.path ?? null,
    headSha: batch.headSha,
  };
}

function learningId(disposition: ReviewLearningDisposition, findingId: string | null, message: string): string {
  const seed = [disposition, findingId ?? '', message].join('|');
  return `learning:${createHash('sha256').update(seed).digest('hex').slice(0, 12)}`;
}

export function formatReviewFeedback(result: ReviewFeedbackResult): string {
  const lines = [result.summary, `Learnings file: ${result.path}.`, `Entries: ${result.entries.length}.`];
  if (result.entry) lines.push(`Recorded ${result.entry.disposition}: ${result.entry.message}`);
  lines.push(result.nextAction);
  return `${lines.join('\n')}\n`;
}

export async function runReviewFeedback(config: Config, options: ReviewFeedbackOptions): Promise<ReviewFeedbackResult> {
  const repoRoot = options.repoRoot ?? process.cwd();
  const dryRun = options.dryRun === true;
  if (options.list || (!options.accept && !options.reject && !(options.guidance ?? '').trim())) {
    const file = loadReviewLearnings(repoRoot);
    const entries = file?.entries ?? [];
    return {
      ok: true,
      command: 'review feedback',
      dryRun,
      path: REVIEW_LEARNINGS_RELATIVE_PATH,
      action: 'list',
      entry: null,
      entries,
      summary: entries.length === 0 ? 'No review learnings are recorded.' : `Recorded ${entries.length} review learning(s).`,
      nextAction: 'Use --accept or --reject with a current-head finding id to record team feedback.',
    };
  }
  const prNumber = options.prNumber;
  if (!prNumber) throw new Error('review feedback requires a pull request number when recording accept, reject, or guidance.');
  const rejectId = options.reject?.trim() || '';
  const acceptId = options.accept?.trim() || '';
  if (rejectId !== '' && acceptId !== '') throw new Error('review feedback accepts only one of --accept or --reject.');
  const guidance = (options.guidance ?? '').trim();
  if (rejectId !== '' && guidance === '') throw new Error('review feedback --reject requires --guidance so later reviews know why the finding was dropped.');
  const disposition: ReviewLearningDisposition = rejectId !== '' ? 'rejected' : acceptId !== '' ? 'accepted' : 'guidance';
  const findingId = rejectId || acceptId || null;
  let message = guidance;
  let lane: string | null = null;
  let paths: string[] = [];
  let headSha: string | null = null;
  if (findingId) {
    const finding = options.resolveFinding
      ? await options.resolveFinding(findingId)
      : await lookupCurrentHeadFinding(config, prNumber, repoRoot, findingId);
    if (!finding) throw new Error(`No current-head finding ${findingId} is available on pull request #${prNumber}. Run aie pr batch ${prNumber} and use a listed finding id.`);
    message = finding.message;
    lane = finding.laneId;
    paths = finding.path ? [finding.path] : [];
    headSha = finding.headSha ?? null;
  }
  if (message.trim() === '') throw new Error('review feedback requires a finding or --guidance text.');
  const safeMessage = redact(message.trim());
  const safeGuidance = redact(guidance);
  const entry: ReviewLearningEntry = {
    id: learningId(disposition, findingId, safeMessage),
    disposition,
    findingId,
    lane,
    message: safeMessage,
    guidance: safeGuidance,
    paths,
    prNumber,
    headSha,
    recordedAt: new Date().toISOString(),
  };
  const next = dryRun ? { version: 1 as const, entries: [...(loadReviewLearnings(repoRoot)?.entries ?? []).filter(item => item.id !== entry.id), entry] } : appendReviewLearning(repoRoot, entry);
  return {
    ok: true,
    command: 'review feedback',
    dryRun,
    path: REVIEW_LEARNINGS_RELATIVE_PATH,
    action: disposition,
    entry,
    entries: next.entries,
    summary: dryRun
      ? `Would record a ${disposition} learning for pull request #${prNumber}.`
      : `Recorded a ${disposition} learning for pull request #${prNumber}.`,
    nextAction: 'Rerun pr gate --dry-run --local-review-prompts to confirm later lane prompts include the learnings fragment.',
  };
}
