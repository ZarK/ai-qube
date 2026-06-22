import type { Config } from '../config/index.js';
import { runUiAudit, type UiAuditResult } from '../audit.js';
import { inspectIssueChecklist, type IssueChecklistSummary } from './issue_checklist.js';
import type { EvidenceSource, EvidenceTrust, GateEvidenceReasonCode } from '../core/gate_evidence.js';
import { buildGateStatus, type GateStatusEntry, type GateStatusResult } from '../gates/index.js';
import { runReviewGate, type ReviewGateResult } from '../review.js';
import { createGitHubReviewProvider } from '../providers/github/github_review_provider.js';
import { runPrGateService, type PrGateCheckDiagnostic, type PrGateExec, type PrGateResult } from './pr_gate.js';

function redactText(text: string): string {
  return text
    .replace(/\b(ghp_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,}|ghs_[A-Za-z0-9_]{10,}|gho_[A-Za-z0-9_]{10,}|ghu_[A-Za-z0-9_]{10,})\b/g, '[REDACTED]')
    .replace(/\b([A-Za-z0-9_-]{40,})\b/g, value => /[A-Z]/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value) ? '[REDACTED]' : value);
}

export type PrBodyReadinessStatus = 'ready' | 'blocked' | 'pending';
export type PrBodyGateState = 'passed' | 'failed' | 'skipped' | 'pending' | 'unknown' | 'stale' | 'missing';
export type PrBodyReadinessReasonCode = GateEvidenceReasonCode | 'missing-pr' | 'pr-review-pending' | 'pr-review-blocked' | 'merge-state-not-ready' | 'mergeability-not-ready' | 'pr-review-state-unavailable' | 'pull-request-not-open' | 'pull-request-draft' | 'merge-conflict' | 'review-feedback-blocker' | 'issue-checklist-unchecked' | 'issue-checklist-unavailable' | 'missing-current-head-ci-run' | 'stale-old-head-ci-run' | 'current-head-check-run-pending' | 'current-head-check-run-failed' | 'current-head-check-run-skipped';

export interface PrBodyReadinessItem {
  reasonCode: PrBodyReadinessReasonCode;
  message: string;
  source: EvidenceSource | 'github-pr' | 'pr-review-gate';
  trust: EvidenceTrust | 'trusted-provider';
}

export interface PrBodyGateLine {
  name: string;
  stage: string;
  requirement: string;
  state: PrBodyGateState;
  recorded: boolean;
  summary: string;
  source: EvidenceSource;
  trust: EvidenceTrust;
  reasonCode: GateEvidenceReasonCode;
  verified: boolean;
}

export interface PrBodyPullRequest {
  number: number;
  title: string;
  state: string;
  url: string;
  reviewDecision: string;
  mergeStateStatus: string;
  mergeable: string;
  isDraft: boolean;
}

export interface PrBodyPrReviewerLine {
  handle: string;
  trigger: string;
  requestedForHead: boolean;
  pending: boolean;
  staleRequest: boolean;
  actionStatus: string;
  actionDescription: string;
}

export interface PrBodyResult {
  ok: true;
  command: 'pr body';
  issue: number;
  body: string;
  readiness: {
    status: PrBodyReadinessStatus;
    blockers: string[];
    pending: string[];
    blockerDetails: PrBodyReadinessItem[];
    pendingDetails: PrBodyReadinessItem[];
    nextCommand: string;
    mergeStrategy: 'squash';
  };
  pullRequest: PrBodyPullRequest | null;
  gates: {
    result: GateStatusResult;
    lines: PrBodyGateLine[];
  };
  uiAudit: UiAuditResult;
  reviewGate: ReviewGateResult;
  prReviewGate: {
    result: PrGateResult | null;
    reviewers: PrBodyPrReviewerLine[];
  };
  issueChecklist: IssueChecklistSummary | null;
  warnings: string[];
}

export interface PrBodyOptions {
  issueNumber: number;
  repoRoot?: string;
  homeDirectory?: string;
  exec?: PrGateExec;
}

function redactInput(input: string): string {
  return input.replace(/\b([A-Za-z0-9_-]{20,})\b/g, '[REDACTED]');
}

export function parsePrBodyIssueNumber(input: string | undefined): number | null {
  if (!input) return null;
  const normalized = input.startsWith('#') ? input.slice(1) : input;
  if (!/^\d+$/.test(normalized)) throw new Error(`parse issue number failed. Likely cause: input must be a positive integer such as 93 or #93; received ${redactInput(input)}. Next action: pass a numeric issue number.`);
  const issueNumber = Number(normalized);
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) throw new Error(`parse issue number failed. Likely cause: input must be a positive integer such as 93 or #93; received ${redactInput(input)}. Next action: pass a numeric issue number.`);
  return issueNumber;
}

function gateState(gate: GateStatusEntry): PrBodyGateState {
  if (gate.evidence.result === 'missing') return 'missing';
  if (gate.evidence.result === 'stale') return 'stale';
  if (gate.evidenceSource === 'not-recorded') return 'pending';
  if (gate.status === 'passed' || gate.status === 'failed' || gate.status === 'skipped') return gate.status;
  return 'unknown';
}

function gateLines(result: GateStatusResult): PrBodyGateLine[] {
  return result.gates.map(gate => ({
    name: gate.name,
    stage: gate.stage,
    requirement: gate.requirement,
    state: gateState(gate),
    recorded: gate.evidenceSource !== 'not-recorded',
    summary: gate.evidenceSummary,
    source: gate.source,
    trust: gate.trust,
    reasonCode: gate.reasonCode,
    verified: gate.verified,
  }));
}

async function getCurrentPullRequest(options: PrBodyOptions): Promise<{ pr: PrBodyPullRequest | null; warning: string | null }> {
  const provider = createGitHubReviewProvider({ cwd: options.repoRoot, exec: options.exec });
  const current = await provider.findCurrentReview();
  return { pr: current.pr, warning: current.warning };
}

async function inspectPrReviewGate(config: Config, pr: PrBodyPullRequest | null, options: PrBodyOptions): Promise<{ result: PrGateResult | null; warning: string | null }> {
  if (!pr) return { result: null, warning: null };
  try {
    return { result: await runPrGateService(config, { prNumber: pr.number, repoRoot: options.repoRoot, exec: options.exec, dryRun: true }), warning: null };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { result: null, warning: `PR review-gate state unavailable: ${redactText(detail)}` };
  }
}

function prReviewerLines(result: PrGateResult | null): PrBodyPrReviewerLine[] {
  if (!result) return [];
  return result.reviewers.map(reviewer => {
    const action = result.actions.find(entry => entry.target === reviewer.handle);
    return {
      handle: reviewer.handle,
      trigger: reviewer.trigger,
      requestedForHead: reviewer.requestedForHead,
      pending: reviewer.pending,
      staleRequest: reviewer.staleRequest,
      actionStatus: action?.status ?? 'unknown',
      actionDescription: action?.description ?? 'No reviewer action was planned.',
    };
  });
}

async function inspectIssueChecklistState(options: PrBodyOptions): Promise<{ result: IssueChecklistSummary | null; warning: string | null }> {
  try {
    return { result: await inspectIssueChecklist(options.issueNumber, { cwd: options.repoRoot, exec: options.exec }), warning: null };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { result: null, warning: `Issue checklist state unavailable: ${redactText(detail)}` };
  }
}

function reviewState(result: ReviewGateResult): 'passed' | 'failed' | 'needs-work' | 'pending' | 'stale' | 'missing' | 'unknown' {
  if (result.evidence.source === 'not-recorded') return 'pending';
  return result.evidence.status;
}

function uiAuditState(result: UiAuditResult): string {
  if (!result.required) return 'disabled';
  return result.evidence.state;
}

function reviewEvidencePending(evidence: ReviewGateResult['evidence']): boolean {
  return evidence.source === 'not-recorded' || evidence.status === 'unknown' || evidence.status === 'pending' || evidence.status === 'stale' || evidence.status === 'missing';
}

function readinessItem(reasonCode: PrBodyReadinessReasonCode, message: string, source: PrBodyReadinessItem['source'], trust: PrBodyReadinessItem['trust']): PrBodyReadinessItem {
  return { reasonCode, message, source, trust };
}

function ciReasonCode(diagnostic: PrGateCheckDiagnostic): PrBodyReadinessReasonCode {
  if (diagnostic.reasonCode === 'missing-current-head-ci-run') return 'missing-current-head-ci-run';
  if (diagnostic.reasonCode === 'stale-old-head-ci-run') return 'stale-old-head-ci-run';
  if (diagnostic.reasonCode === 'current-head-check-run-pending') return 'current-head-check-run-pending';
  if (diagnostic.reasonCode === 'current-head-check-run-failed') return 'current-head-check-run-failed';
  if (diagnostic.reasonCode === 'current-head-check-run-skipped') return 'current-head-check-run-skipped';
  return 'provider-check-pending';
}

function githubReviewDecisionBlocks(pr: PrBodyPullRequest | null): boolean {
  return pr?.reviewDecision === 'CHANGES_REQUESTED';
}

function pendingItems(gates: PrBodyGateLine[], audit: UiAuditResult, review: ReviewGateResult, pr: PrBodyPullRequest | null, prReview: PrGateResult | null, issueChecklist: IssueChecklistSummary | null): PrBodyReadinessItem[] {
  const pending: PrBodyReadinessItem[] = [];
  for (const gate of gates) if (gate.state === 'pending' || gate.state === 'unknown' || gate.state === 'stale' || gate.state === 'missing') pending.push(readinessItem(gate.reasonCode, `Record evidence for ${gate.name} (${gate.stage}).`, gate.source, gate.trust));
  if (audit.required && audit.evidence.state !== 'visual-analysis-recorded') pending.push(readinessItem(audit.evidence.reasonCode, 'Record browser-observation evidence, capture screenshots, and add visual analysis notes for the real running app.', audit.evidence.source, audit.evidence.trust));
  if (reviewEvidencePending(review.evidence)) pending.push(readinessItem(review.evidence.reasonCode, 'Run the configured review-agent gate and record evidence.', review.evidence.evidenceSource, review.evidence.trust));
  if (!pr) pending.push(readinessItem('missing-pr', 'Create a non-draft, ready-for-review pull request, then run `aie pr gate <pr>`.', 'github-pr', 'trusted-provider'));
  else {
    if (pr.reviewDecision !== 'APPROVED' && !githubReviewDecisionBlocks(pr)) pending.push(readinessItem('pr-review-pending', `Run or rerun \`aie pr gate ${pr.number}\` until PR review state is ready.`, 'github-pr', 'trusted-provider'));
    if (pr.mergeStateStatus !== 'CLEAN') pending.push(readinessItem('merge-state-not-ready', `Wait for or fix GitHub merge state ${pr.mergeStateStatus}.`, 'github-pr', 'trusted-provider'));
    if (pr.mergeable !== 'MERGEABLE') pending.push(readinessItem('mergeability-not-ready', `Wait for or fix GitHub mergeability ${pr.mergeable}.`, 'github-pr', 'trusted-provider'));
  }
  if (pr && !prReview) pending.push(readinessItem('pr-review-state-unavailable', `Run \`aie pr gate ${pr.number}\` to collect PR review-gate state before merge.`, 'pr-review-gate', 'trusted-provider'));
  if (prReview) {
    if (prReview.status === 'pending') pending.push(readinessItem('pr-review-pending', `Rerun \`aie pr gate ${prReview.pr.number}\` after pending PR review requirements complete.`, 'pr-review-gate', 'trusted-provider'));
    for (const diagnostic of prReview.checkDiagnostics) {
      if (['missing-current-head-run', 'stale-old-head-run', 'pending-current-head-run', 'skipped-current-head-run'].includes(diagnostic.status)) pending.push(readinessItem(ciReasonCode(diagnostic), diagnostic.nextAction, 'github-pr', 'trusted-provider'));
    }
    for (const reviewer of prReview.reviewers) {
      if (reviewer.staleRequest) pending.push(readinessItem('stale-evidence', `Rerun \`aie pr gate ${prReview.pr.number}\` because ${reviewer.handle} was requested for an older PR head.`, 'pr-review-gate', 'trusted-provider'));
      else if (!reviewer.requestedForHead && !reviewer.pending) pending.push(readinessItem('pr-review-pending', `Request configured PR reviewer ${reviewer.handle} with \`aie pr gate ${prReview.pr.number}\`.`, 'pr-review-gate', 'trusted-provider'));
    }
  }
  if (prReview?.status === 'unavailable') pending.push(readinessItem('pr-review-state-unavailable', 'Inspect unavailable PR review state before merge.', 'pr-review-gate', 'trusted-provider'));
  if (!issueChecklist) pending.push(readinessItem('issue-checklist-unavailable', 'Inspect GitHub issue checklist state before merge.', 'github-pr', 'trusted-provider'));
  return pending;
}

function blockerItems(gates: PrBodyGateLine[], audit: UiAuditResult, review: ReviewGateResult, pr: PrBodyPullRequest | null, prReview: PrGateResult | null, issueChecklist: IssueChecklistSummary | null): PrBodyReadinessItem[] {
  const blockers: PrBodyReadinessItem[] = [];
  for (const gate of gates) if (gate.state === 'failed' && gate.requirement === 'required') blockers.push(readinessItem(gate.reasonCode, `Required gate ${gate.name} failed.`, gate.source, gate.trust));
  if (review.evidence.status === 'failed' || review.evidence.status === 'needs-work') blockers.push(readinessItem(review.evidence.reasonCode, 'Review-agent evidence reports findings that need work.', review.evidence.evidenceSource, review.evidence.trust));
  if (pr?.state !== undefined && pr.state !== 'OPEN') blockers.push(readinessItem('pull-request-not-open', `Pull request is ${pr.state}.`, 'github-pr', 'trusted-provider'));
  if (pr?.isDraft) blockers.push(readinessItem('pull-request-draft', 'Pull request is still a draft.', 'github-pr', 'trusted-provider'));
  if (githubReviewDecisionBlocks(pr)) blockers.push(readinessItem('pr-review-blocked', 'GitHub review state is CHANGES_REQUESTED; address requested changes before merge.', 'github-pr', 'trusted-provider'));
  if (pr?.mergeable === 'CONFLICTING') blockers.push(readinessItem('merge-conflict', 'Pull request has merge conflicts.', 'github-pr', 'trusted-provider'));
  if (pr?.mergeStateStatus === 'DIRTY') blockers.push(readinessItem('merge-conflict', 'Pull request branch is dirty and cannot merge cleanly.', 'github-pr', 'trusted-provider'));
  if (audit.required && (audit.evidence.state === 'metadata-only' || audit.evidence.state === 'browser-visited' || audit.evidence.state === 'screenshots-captured')) blockers.push(readinessItem(audit.evidence.reasonCode, 'Manual UI audit evidence directory exists but visual evidence is incomplete.', audit.evidence.source, audit.evidence.trust));
  if (prReview?.status === 'failed') blockers.push(readinessItem('review-feedback-blocker', 'PR review gate reports feedback that must be addressed.', 'pr-review-gate', 'trusted-provider'));
  for (const diagnostic of prReview?.checkDiagnostics ?? []) {
    if (diagnostic.status === 'failed-current-head-run') blockers.push(readinessItem(ciReasonCode(diagnostic), diagnostic.nextAction, 'github-pr', 'trusted-provider'));
  }
  if (issueChecklist && issueChecklist.checklist.unchecked > 0) blockers.push(readinessItem('issue-checklist-unchecked', `Issue #${issueChecklist.issue.number} has ${issueChecklist.checklist.unchecked} unchecked checklist item(s).`, 'github-pr', 'trusted-provider'));
  return blockers;
}

function readinessNextCommand(status: PrBodyReadinessStatus, issueNumber: number, pr: PrBodyPullRequest | null): string {
  if (status === 'blocked') return 'Fix blockers, rerun affected checks, then run `aie pr body <issue>` again.';
  if (!pr) return 'Create a non-draft, ready-for-review pull request with this body, then run `aie pr gate <pr>` before merge.';
  if (status === 'pending') return `Run \`aie pr gate ${pr.number}\`, address feedback, and rerun \`aie pr body ${issueNumber}\`.`;
  return `Squash merge PR #${pr.number} when repository policy and CI are satisfied, then run \`aie complete ${issueNumber}\`.`;
}

function readiness(issueNumber: number, gates: PrBodyGateLine[], audit: UiAuditResult, review: ReviewGateResult, pr: PrBodyPullRequest | null, prReview: PrGateResult | null, issueChecklist: IssueChecklistSummary | null): PrBodyResult['readiness'] {
  const blockers = blockerItems(gates, audit, review, pr, prReview, issueChecklist);
  const pending = pendingItems(gates, audit, review, pr, prReview, issueChecklist);
  const status = blockers.length > 0 ? 'blocked' : pending.length > 0 ? 'pending' : 'ready';
  return { status, blockers: blockers.map(item => item.message), pending: pending.map(item => item.message), blockerDetails: blockers, pendingDetails: pending, nextCommand: readinessNextCommand(status, issueNumber, pr), mergeStrategy: 'squash' };
}

function formatReviewers(result: ReviewGateResult): string {
  return result.reviewers.map(reviewer => `${reviewer.name} (${reviewer.invocation})`).join(', ') || 'none configured';
}

function formatPrReviewers(result: PrBodyResult['prReviewGate'], pullRequest: PrBodyPullRequest | null): string[] {
  if (result.reviewers.length === 0) {
    if (!pullRequest) return ['- PR reviewers: no current PR detected.'];
    if (!result.result) return ['- PR reviewers: PR review-gate state unavailable; run `aie pr gate <pr>` before merge.'];
    return ['- PR reviewers: none configured.'];
  }
  return result.reviewers.map(reviewer => `- PR reviewer ${reviewer.handle}: ${reviewer.trigger}; current=${reviewer.requestedForHead ? 'yes' : 'no'}; pending=${reviewer.pending ? 'yes' : 'no'}; stale=${reviewer.staleRequest ? 'yes' : 'no'}; action=${reviewer.actionStatus} - ${reviewer.actionDescription}`);
}

function formatCiDiagnostics(result: PrGateResult | null): string[] {
  if (!result) return ['- unavailable until PR review-gate state is collected.'];
  if (result.checkDiagnostics.length === 0) return ['- no provider check diagnostics reported.'];
  return result.checkDiagnostics.map(diagnostic => `- ${diagnostic.checkName}: ${diagnostic.status}; ${diagnostic.summary} Next action: ${diagnostic.nextAction}`);
}

function buildBody(result: Omit<PrBodyResult, 'body'>): string {
  const lines = ['## Summary', `- Complete Executor issue #${result.issue}.`, '', '## Verification'];
  if (result.gates.lines.length === 0) lines.push('- Configured gates: none configured.');
  for (const gate of result.gates.lines) lines.push(`- ${gate.state}: ${gate.name} (${gate.stage}, ${gate.requirement}) - ${gate.recorded ? 'recorded' : 'pending evidence'}; ${gate.summary}`);
  lines.push(`- Manual UI audit: ${uiAuditState(result.uiAudit)} - ${result.uiAudit.nextAction}`);
  lines.push(`- Review-agent gate: ${reviewState(result.reviewGate)} - reviewers: ${formatReviewers(result.reviewGate)}; ${result.reviewGate.evidence.summary}`);
  if (result.issueChecklist) {
    lines.push(`- Issue checklist: ${result.issueChecklist.checklist.checked}/${result.issueChecklist.checklist.total} checked.`);
    for (const item of result.issueChecklist.checklist.items.filter(item => !item.checked)) lines.push(`  - unchecked #${item.index}: ${item.text}`);
  } else {
    lines.push('- Issue checklist: unavailable.');
  }
  lines.push('- PR review agents:');
  lines.push(...formatPrReviewers(result.prReviewGate, result.pullRequest));
  lines.push('- PR CI diagnostics:');
  lines.push(...formatCiDiagnostics(result.prReviewGate.result).map(line => `  ${line}`));
  lines.push('', '## Merge readiness');
  lines.push(`- Status: ${result.readiness.status}.`);
  if (result.pullRequest) {
    lines.push(`- Pull request: #${result.pullRequest.number} ${result.pullRequest.title} (${result.pullRequest.url}).`);
    lines.push(`- GitHub state: review=${result.pullRequest.reviewDecision}; merge=${result.pullRequest.mergeStateStatus}; mergeable=${result.pullRequest.mergeable}; draft=${result.pullRequest.isDraft ? 'yes' : 'no'}.`);
  } else {
    lines.push('- Pull request: not detected for the current branch yet.');
  }
  if (result.readiness.blockers.length > 0) {
    lines.push('- Blockers:');
    for (const blocker of result.readiness.blockers) lines.push(`  - ${blocker}`);
  }
  if (result.readiness.pending.length > 0) {
    lines.push('- Pending:');
    for (const item of result.readiness.pending) lines.push(`  - ${item}`);
  }
  lines.push(`- Recommended next command: ${result.readiness.nextCommand}`);
  lines.push('- Default merge strategy when policy permits: squash merge.');
  lines.push('', `Closes #${result.issue}`);
  return lines.join('\n');
}

export async function buildPrBodyService(config: Config, options: PrBodyOptions): Promise<PrBodyResult> {
  const gateStatus = buildGateStatus(config, { evidenceRoot: options.repoRoot });
  const gates = gateLines(gateStatus);
  const uiAudit = runUiAudit(config, { issueNumber: options.issueNumber, repoRoot: options.repoRoot, homeDirectory: options.homeDirectory, check: true });
  const reviewGate = runReviewGate(config, { issueNumber: options.issueNumber, repoRoot: options.repoRoot });
  const issueChecklist = await inspectIssueChecklistState(options);
  const currentPr = await getCurrentPullRequest(options);
  const prReview = await inspectPrReviewGate(config, currentPr.pr, options);
  const prReviewers = prReviewerLines(prReview.result);
  const ready = readiness(options.issueNumber, gates, uiAudit, reviewGate, currentPr.pr, prReview.result, issueChecklist.result);
  const warnings = ['PR body output is a draft; inspect it before posting and keep only accurate verification claims.', 'Executor recommends next commands only; it never silently merges pull requests.'];
  if (issueChecklist.warning) warnings.push(issueChecklist.warning);
  if (currentPr.warning) warnings.push(currentPr.warning);
  if (prReview.warning) warnings.push(prReview.warning);
  const result = { ok: true as const, command: 'pr body' as const, issue: options.issueNumber, readiness: ready, pullRequest: currentPr.pr, gates: { result: gateStatus, lines: gates }, uiAudit, reviewGate, prReviewGate: { result: prReview.result, reviewers: prReviewers }, issueChecklist: issueChecklist.result, warnings };
  return { ...result, body: buildBody(result) };
}

export function formatPrBody(result: PrBodyResult): string {
  const lines = [`PR body draft for issue #${result.issue}:`, result.body, ''];
  lines.push(`Readiness: ${result.readiness.status}.`);
  lines.push(`Recommended next command: ${result.readiness.nextCommand}`);
  lines.push('Default merge strategy when policy permits: squash merge.');
  for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
  return lines.join('\n');
}

export async function buildPrBody(config: Config, options: PrBodyOptions): Promise<PrBodyResult> {
  return buildPrBodyService(config, options);
}
