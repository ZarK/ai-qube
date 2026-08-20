import type { Config } from '../config/index.js';
import { changedReviewPaths } from './pr_gate.js';
import { activeLocalReviewFocusesForConfig, carryForwardScopeFromConfig } from '../review_focus.js';
import { buildFixBatch, readLocalReviewGate, type FixBatch } from '../local_review_evidence.js';
import { ghFailureMessage, runGh, type GhExec } from '../providers/github_adapter_exports.js';
import { createReviewForgeProvider } from '../providers/review_forge_adapters.js';
import { resolveReviewSources } from '../review_source.js';
import { ingestProviderReviewFindings } from '../provider_review_findings.js';
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
  const carryForwardScope = carryForwardScopeFromConfig(config);
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
  // Provider-visible feedback from configured reviewer sources feeds the same
  // batch as local lane evidence; a stale snapshot (the head moved between the
  // context read above and this provider read) contributes no findings rather
  // than reporting on the wrong head, since local evidence is already bound to
  // pr.headSha independently of this read.
  const reviewProvider = await createReviewForgeProvider(config.providers.review.kind, { exec: options.exec, cwd: repoRoot, reviewAgents: config.reviewAgents, publisher: config.providers.review.publisher ?? null, ...config.providers.connections[config.providers.review.kind], ...config.providers.review.connection });
  const reviewSnapshot = await reviewProvider.loadPullRequestReview(pr.number);
  const reviewSources = resolveReviewSources(config);
  const providerFindings = reviewSnapshot.pr.headRefOid === pr.headSha ? ingestProviderReviewFindings(reviewSnapshot.item, reviewSources) : [];
  const batch = buildFixBatch(repoRoot, pr.issueNumbers, pr.number, pr.headSha, localReview.evidence, providerFindings);
  const lanesWithEvidence = [...new Set(localReview.evidence.flatMap(entry => entry.lanes.map(lane => lane.id)))];
  const limitation = lanesWithEvidence.length === 0 && providerFindings.length === 0
    ? 'No current-head local lane evidence or provider-visible reviewer feedback was found; the batch covers nothing yet. Run `aie pr gate <pr>` (or individual lanes) first, then re-read the batch.'
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
          ? 'Only advisory findings remain; fix cheap ones now or drop them and fold anything real into already-queued Ready work — never open a new issue. Run `aie pr triage <pr>` for the disposition report, then merge when the gate reports ship-ready.'
          : 'No open findings at the current head; run `aie pr gate <pr>` for merge readiness.'),
  };
}

export function formatPrBatch(result: PrBatchResult): string {
  const lines = [`PR fix batch for #${result.pr} at head ${result.headSha.slice(0, 12)}: ${result.summary}`];
  for (const finding of result.batch.findings) {
    const location = finding.location ? ` (${finding.location.path}${finding.location.line !== null ? `:${finding.location.line}` : ''})` : '';
    const origin = finding.lanes.length > 0 ? finding.lanes.join('+') : finding.sources.join('+');
    lines.push(`- [${finding.severity}/${finding.classification}] ${origin}${location}: ${finding.message.slice(0, 160)}`);
  }
  if (result.limitation) lines.push(`Limitation: ${result.limitation}`);
  lines.push(`Next action: ${result.nextAction}`);
  return lines.join('\n');
}
