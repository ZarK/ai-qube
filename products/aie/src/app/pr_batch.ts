import type { Config } from '../config/index.js';
import { changedReviewPaths } from './pr_gate.js';
import { activeLocalReviewFocusesForConfig, defaultCarryForwardContext } from '../review_focus.js';
import { buildFixBatch, readLocalReviewGate, type FixBatch } from '../local_review_evidence.js';
import { ghFailureMessage, runGh, type GhExec } from '../providers/github_adapter_exports.js';
import { redact } from '../redact.js';

export interface PrBatchResult {
  ok: true;
  command: 'pr batch';
  pr: number;
  headSha: string;
  lanesWithEvidence: string[];
  batch: FixBatch;
  limitation: string | null;
  summary: string;
  nextAction: string;
}

export interface PrBatchOptions {
  prNumber: number;
  repoRoot?: string;
  exec?: GhExec;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function batchPrContext(prNumber: number, cwd: string | undefined, exec: GhExec | undefined): Promise<{ number: number; headSha: string; issueNumbers: number[] }> {
  const result = await runGh(['pr', 'view', String(prNumber), '--json', 'number,headRefOid,closingIssuesReferences'], { cwd, exec });
  if (result.exitCode !== 0) throw new Error(ghFailureMessage(`gh pr view ${prNumber}`, result.exitCode, result.stderr || result.stdout));
  const parsed: unknown = JSON.parse(result.stdout);
  if (!isRecord(parsed) || typeof parsed.number !== 'number' || typeof parsed.headRefOid !== 'string' || parsed.headRefOid.trim() === '') {
    throw new Error('gh pr view returned missing or malformed number or headRefOid fields.');
  }
  const issueNumbers = Array.isArray(parsed.closingIssuesReferences)
    ? parsed.closingIssuesReferences.flatMap(entry => isRecord(entry) && typeof entry.number === 'number' && Number.isSafeInteger(entry.number) && entry.number > 0 ? [entry.number] : [])
    : [];
  return { number: parsed.number, headSha: parsed.headRefOid, issueNumbers };
}

export async function runPrBatchService(config: Config, options: PrBatchOptions): Promise<PrBatchResult> {
  const repoRoot = options.repoRoot ?? process.cwd();
  const pr = await batchPrContext(options.prNumber, repoRoot, options.exec);
  // Read-only aggregation over whatever current-head lane evidence exists; no lane
  // execution and no provider mutation ever happens on this path. Lane scoping
  // mirrors the gate exactly (active focuses from the changed paths plus the
  // shared carry-forward scope) so the batch matches what the gate would report.
  const changedPaths = await changedReviewPaths(config, repoRoot);
  const activeFocuses = activeLocalReviewFocusesForConfig(config, changedPaths);
  const carryForwardScope = {
    laneMatchPatterns: Object.fromEntries(config.reviewLanes.map(lane => [lane.id, [...lane.match]])),
    contextPatterns: [...config.reviewContextSources.instructions, ...config.reviewContextSources.requirements],
    laneContextModes: Object.fromEntries(config.reviewLanes.map(lane => [lane.id, lane.carryForwardContext ?? defaultCarryForwardContext(lane.id)])),
  };
  const localReview = readLocalReviewGate({
    repoRoot,
    issueNumbers: pr.issueNumbers,
    prNumber: pr.number,
    headSha: pr.headSha,
    reviewers: config.localReviewAgents,
    required: true,
    profile: config.reviewProfile,
    severityThreshold: config.reviewSeverityThreshold,
    activeFocuses,
    carryForwardScope,
  });
  const batch = buildFixBatch(repoRoot, pr.issueNumbers, pr.number, pr.headSha, localReview.evidence);
  const lanesWithEvidence = [...new Set(localReview.evidence.flatMap(entry => entry.lanes.map(lane => lane.id)))];
  const limitation = lanesWithEvidence.length === 0
    ? 'No current-head local lane evidence was found; the batch covers nothing yet. Run `aie pr gate <pr>` (or individual lanes) first, then re-read the batch.'
    : null;
  return {
    ok: true,
    command: 'pr batch',
    pr: pr.number,
    headSha: redact(pr.headSha),
    lanesWithEvidence,
    batch,
    limitation,
    summary: `${batch.summary} Evidence lanes: ${lanesWithEvidence.length > 0 ? lanesWithEvidence.join(', ') : 'none'}.`,
    nextAction: limitation
      ?? (batch.findings.some(finding => finding.severity === 'blocking')
        ? 'Apply every blocking fix from this batch in one commit, then run one re-review round with `aie pr gate <pr>`.'
        : batch.findings.length > 0
          ? 'Only advisory findings remain; when the gate reports ship-ready, file them with `aie pr triage <pr>` instead of new commits.'
          : 'No open findings at the current head; run `aie pr gate <pr>` for merge readiness.'),
  };
}

export function formatPrBatch(result: PrBatchResult): string {
  const lines = [`PR fix batch for #${result.pr} at head ${result.headSha.slice(0, 12)}: ${result.summary}`];
  for (const finding of result.batch.findings) {
    const location = finding.location ? ` (${finding.location.path}${finding.location.line !== null ? `:${finding.location.line}` : ''})` : '';
    lines.push(`- [${finding.severity}/${finding.classification}] ${finding.lanes.join('+')}${location}: ${finding.message.slice(0, 160)}`);
  }
  if (result.limitation) lines.push(`Limitation: ${result.limitation}`);
  lines.push(`Next action: ${result.nextAction}`);
  return lines.join('\n');
}
