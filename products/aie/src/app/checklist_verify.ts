import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { renderAgentPrompt, type RenderedAgentPrompt } from '../agent_descriptors.js';
import { parseChecklist, planChecklistUpdate, type ChecklistItem, type ChecklistState, type ChecklistSummary } from '../checklist.js';
import { getIssue, type GitHubIssue } from '../github.js';
import { GhExecutionError, runGh, type GhExec } from '../gh.js';

export interface ChecklistVerifyIssue {
  number: number;
  title: string;
  state: GitHubIssue['state'];
  url: string;
}

export interface ChecklistVerifyPrContext {
  number: number;
  title: string;
  url: string;
  headSha: string;
}

export interface ChecklistVerifyEvidence {
  path: string | null;
  status: 'missing' | 'valid' | 'invalid' | 'rejected';
  recommendation: string | null;
  summary: string;
  errors: string[];
}

export interface ChecklistVerifyResult {
  ok: boolean;
  command: 'checklist verify';
  issue: ChecklistVerifyIssue;
  dryRun: boolean;
  promptOnly: boolean;
  state: ChecklistState;
  criterion: ChecklistItem;
  checklist: ChecklistSummary;
  pr: ChecklistVerifyPrContext | null;
  prompt: RenderedAgentPrompt;
  evidence: ChecklistVerifyEvidence;
  mutation: {
    status: 'planned' | 'completed' | 'skipped' | 'blocked';
    description: string;
  };
  nextAction: string;
}

export interface ChecklistVerifyOptions {
  issueNumber: number;
  index: number | undefined;
  state: ChecklistState;
  evidencePath?: string;
  dryRun: boolean;
  promptOnly: boolean;
  cwd?: string;
  exec?: GhExec;
}

function issueSummary(issue: GitHubIssue): ChecklistVerifyIssue {
  return { number: issue.number, title: issue.title, state: issue.state, url: issue.url };
}

function ensureGhSuccess(operation: string, result: Awaited<ReturnType<typeof runGh>>): void {
  if (result.exitCode !== 0) throw new GhExecutionError(operation, result.exitCode, result.stderr || result.stdout);
}

function selectCriterion(summary: ChecklistSummary, index: number | undefined): ChecklistItem {
  if (!Number.isInteger(index) || index === undefined || index <= 0) {
    throw new Error('acceptance verification failed. Likely cause: --index must select one checklist item. Next action: pass --index <n> from `aie view <issue>`.');
  }
  const match = summary.items.find(item => item.index === index);
  if (!match) {
    throw new Error(`acceptance verification failed. Likely cause: checklist item #${index} does not exist. Next action: run \`aie view <issue>\` and choose an existing checklist index.`);
  }
  return match;
}

async function currentPrContext(cwd?: string, exec?: GhExec): Promise<ChecklistVerifyPrContext | null> {
  let result: Awaited<ReturnType<typeof runGh>>;
  try {
    result = await runGh(['pr', 'view', '--json', 'number,title,url,headRefOid'], { cwd, exec });
  } catch {
    return null;
  }
  if (result.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    if (typeof parsed.number !== 'number' || typeof parsed.title !== 'string' || typeof parsed.url !== 'string' || typeof parsed.headRefOid !== 'string') return null;
    return { number: parsed.number, title: parsed.title, url: parsed.url, headSha: parsed.headRefOid };
  } catch {
    return null;
  }
}

function buildPrompt(issue: GitHubIssue, criterion: ChecklistItem, pr: ChecklistVerifyPrContext | null): RenderedAgentPrompt {
  const prLine = pr ? `Current PR: #${pr.number} ${pr.title} ${pr.url} head ${pr.headSha}` : 'Current PR: not detected for the current branch.';
  return renderAgentPrompt({
    hostId: 'codex',
    descriptorId: 'qa-reviewer',
    categoryId: 'acceptance-verification',
    contextLines: [
      `Issue #${issue.number}: ${issue.title}`,
      `Criterion #${criterion.index}: ${criterion.text}`,
      prLine,
      'Required evidence: reviewed sources, artifacts, reviewer or runner provenance, recommendation, timestamp, and prompt stack.',
      `Issue body:\n${issue.body}`,
    ],
    outputContract: 'Return acceptance verification evidence JSON for exactly this issue checklist criterion.',
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function hasReviewerProvenance(record: Record<string, unknown>): boolean {
  if (typeof record.runner === 'string' && record.runner.trim() !== '') return true;
  if (!isRecord(record.reviewer)) return false;
  return typeof record.reviewer.id === 'string' && record.reviewer.id.trim() !== '';
}

function validateEvidence(path: string | undefined, issue: GitHubIssue, criterion: ChecklistItem, pr: ChecklistVerifyPrContext | null): ChecklistVerifyEvidence {
  if (!path) return { path: null, status: 'missing', recommendation: null, summary: 'No acceptance verification evidence file was provided.', errors: ['Pass --evidence <path> before checking an acceptance criterion.'] };
  if (!existsSync(path)) return { path, status: 'missing', recommendation: null, summary: 'Acceptance verification evidence file was not found.', errors: [`Evidence file does not exist: ${path}`] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { path, status: 'invalid', recommendation: null, summary: 'Acceptance verification evidence JSON could not be parsed.', errors: ['Evidence must be valid JSON.'] };
  }
  if (!isRecord(parsed)) return { path, status: 'invalid', recommendation: null, summary: 'Acceptance verification evidence must be a JSON object.', errors: ['Evidence root must be an object.'] };
  const errors: string[] = [];
  if (parsed.version !== 1) errors.push('Evidence version must be 1.');
  if (parsed.issueNumber !== issue.number) errors.push(`Evidence issueNumber must be ${issue.number}.`);
  if (parsed.criterionIndex !== criterion.index) errors.push(`Evidence criterionIndex must be ${criterion.index}.`);
  if (typeof parsed.criterionText !== 'string' || parsed.criterionText.trim() !== criterion.text) errors.push('Evidence criterionText must match the selected checklist item text.');
  if (pr && parsed.headSha !== pr.headSha) errors.push(`Evidence headSha must match current PR head ${pr.headSha}.`);
  if (!hasReviewerProvenance(parsed)) errors.push('Evidence must include reviewer.id or runner provenance.');
  if (!nonEmptyArray(parsed.reviewedSources)) errors.push('Evidence reviewedSources must be a non-empty array.');
  if (!nonEmptyArray(parsed.artifacts)) errors.push('Evidence artifacts must be a non-empty array.');
  if (parsed.recommendation !== 'approve' && parsed.recommendation !== 'request-changes' && parsed.recommendation !== 'inconclusive') errors.push('Evidence recommendation must be approve, request-changes, or inconclusive.');
  if (typeof parsed.recordedAt !== 'string' || parsed.recordedAt.trim() === '') errors.push('Evidence recordedAt timestamp is required.');
  if (!nonEmptyArray(parsed.promptStack)) errors.push('Evidence promptStack must be a non-empty array.');
  const recommendation = typeof parsed.recommendation === 'string' ? parsed.recommendation : null;
  const summary = typeof parsed.summary === 'string' && parsed.summary.trim() !== '' ? parsed.summary.trim() : `Acceptance evidence ${basename(path)} was inspected.`;
  if (errors.length > 0) return { path, status: 'invalid', recommendation, summary, errors };
  if (recommendation !== 'approve') return { path, status: 'rejected', recommendation, summary, errors: [`Evidence recommendation is ${recommendation}, not approve.`] };
  return { path, status: 'valid', recommendation, summary, errors: [] };
}

export async function verifyIssueChecklist(options: ChecklistVerifyOptions): Promise<ChecklistVerifyResult> {
  const issue = await getIssue(options.issueNumber, { cwd: options.cwd, exec: options.exec });
  const checklist = parseChecklist(issue.body);
  const criterion = selectCriterion(checklist, options.index);
  const pr = await currentPrContext(options.cwd, options.exec);
  const prompt = buildPrompt(issue, criterion, pr);
  const evidence = options.promptOnly ? { path: null, status: 'missing' as const, recommendation: null, summary: 'Prompt rendered; no evidence was validated.', errors: [] } : validateEvidence(options.evidencePath, issue, criterion, pr);
  const canCheck = options.state === 'checked' && evidence.status === 'valid';
  const plan = canCheck ? planChecklistUpdate(issue.body, { index: criterion.index }, 'checked') : null;
  if (canCheck && plan?.changed && !options.dryRun) {
    const result = await runGh(['issue', 'edit', String(issue.number), '--body', plan.updatedBody], { cwd: options.cwd, exec: options.exec });
    ensureGhSuccess(`gh issue edit ${issue.number} --body`, result);
  }
  const mutationStatus = options.promptOnly ? 'skipped' : canCheck ? options.dryRun ? 'planned' : plan?.changed ? 'completed' : 'skipped' : 'blocked';
  const remainingUnchecked = canCheck && plan ? plan.after.unchecked : checklist.unchecked;
  return {
    ok: mutationStatus !== 'blocked',
    command: 'checklist verify',
    issue: issueSummary(issue),
    dryRun: options.dryRun,
    promptOnly: options.promptOnly,
    state: options.state,
    criterion,
    checklist,
    pr,
    prompt,
    evidence,
    mutation: {
      status: mutationStatus,
      description: mutationStatus === 'blocked'
        ? 'Acceptance criterion was not checked because required evidence did not pass validation.'
        : mutationStatus === 'completed'
          ? `Checked criterion #${criterion.index} on issue #${issue.number}.`
          : mutationStatus === 'planned'
            ? `Would check criterion #${criterion.index} on issue #${issue.number}.`
            : `Criterion #${criterion.index} already matches ${options.state} or prompt-only mode was requested.`,
    },
    nextAction: mutationStatus === 'blocked'
      ? 'Provide valid criterion-specific evidence, then rerun `aie checklist verify <issue> --index <n> --evidence <path> --state checked`.'
      : remainingUnchecked > 0
        ? 'Verify the next unchecked criterion one checkbox at a time.'
        : `Run \`aie complete ${issue.number} --check-only\` after the pull request is merged.`,
  };
}

export function formatChecklistVerify(result: ChecklistVerifyResult): string {
  if (result.promptOnly) return result.prompt.text;
  const lines = [`Checklist verification for issue #${result.issue.number} criterion #${result.criterion.index}: ${result.mutation.status}.`];
  lines.push(`Criterion: ${result.criterion.text}`);
  lines.push(`PR head: ${result.pr?.headSha ?? 'not detected'}`);
  lines.push(`Evidence: ${result.evidence.status}; ${result.evidence.summary}`);
  for (const error of result.evidence.errors) lines.push(`- ${error}`);
  lines.push(`Mutation: ${result.mutation.description}`);
  lines.push(`Next action: ${result.nextAction}`);
  return lines.join('\n');
}
