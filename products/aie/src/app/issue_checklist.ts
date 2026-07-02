import { parseChecklist, planChecklistUpdate, type ChecklistItem, type ChecklistSelector, type ChecklistState, type ChecklistSummary } from '../checklist.js';
import { getIssue, type GitHubIssue } from '@tjalve/qube-adapter-github';
import { GhExecutionError, runGh, type GhExec } from '@tjalve/qube-adapter-github';

export interface IssueChecklistSummary {
  issue: {
    number: number;
    title: string;
    state: GitHubIssue['state'];
    url: string;
  };
  checklist: ChecklistSummary;
}

export interface ChecklistUpdateResult {
  ok: true;
  command: 'checklist update';
  issue: IssueChecklistSummary['issue'];
  dryRun: boolean;
  state: ChecklistState;
  selector: ChecklistSelector;
  matchedItems: ChecklistItem[];
  before: ChecklistSummary;
  after: ChecklistSummary;
  changed: boolean;
  mutation: {
    status: 'planned' | 'completed' | 'skipped';
    description: string;
  };
  nextAction: string;
}

export interface ChecklistUpdateOptions {
  issueNumber: number;
  selector: ChecklistSelector;
  state: ChecklistState;
  dryRun: boolean;
  cwd?: string;
  exec?: GhExec;
}

function issueSummary(issue: GitHubIssue): IssueChecklistSummary['issue'] {
  return { number: issue.number, title: issue.title, state: issue.state, url: issue.url };
}

function ensureGhSuccess(operation: string, result: Awaited<ReturnType<typeof runGh>>): void {
  if (result.exitCode !== 0) throw new GhExecutionError(operation, result.exitCode, result.stderr || result.stdout);
}

export function summarizeIssueChecklist(issue: GitHubIssue): IssueChecklistSummary {
  return { issue: issueSummary(issue), checklist: parseChecklist(issue.body) };
}

export async function inspectIssueChecklist(issueNumber: number, options: { cwd?: string; exec?: GhExec } = {}): Promise<IssueChecklistSummary> {
  return summarizeIssueChecklist(await getIssue(issueNumber, options));
}

export async function updateIssueChecklist(options: ChecklistUpdateOptions): Promise<ChecklistUpdateResult> {
  if (options.state === 'checked') {
    throw new Error('direct checklist checking is restricted. Likely cause: acceptance criteria require evidence-backed verification. Next action: run `aie checklist verify <issue> --index <n> --prompt`, then rerun with --evidence <path> --state checked.');
  }
  const issue = await getIssue(options.issueNumber, { cwd: options.cwd, exec: options.exec });
  const plan = planChecklistUpdate(issue.body, options.selector, options.state);
  const description = plan.changed ? `Set ${plan.matchedItems.map(item => `#${item.index}`).join(', ')} on issue #${issue.number} to ${options.state}.` : `Issue #${issue.number} checklist already matches ${options.state}.`;
  if (plan.changed && !options.dryRun) {
    const result = await runGh(['issue', 'edit', String(issue.number), '--body', plan.updatedBody], { cwd: options.cwd, exec: options.exec });
    ensureGhSuccess(`gh issue edit ${issue.number} --body`, result);
  }
  const status = plan.changed ? options.dryRun ? 'planned' : 'completed' : 'skipped';
  return {
    ok: true,
    command: 'checklist update',
    issue: issueSummary(issue),
    dryRun: options.dryRun,
    state: options.state,
    selector: options.selector,
    matchedItems: plan.matchedItems,
    before: plan.before,
    after: plan.after,
    changed: plan.changed,
    mutation: { status, description },
    nextAction: plan.after.unchecked > 0 ? `Resolve ${plan.after.unchecked} unchecked issue checklist item(s), then rerun \`aie complete ${issue.number} --check-only\`.` : `Run \`aie complete ${issue.number} --check-only\` after the pull request is merged.`,
  };
}

export function formatChecklistUpdate(result: ChecklistUpdateResult): string {
  const lines = [`Checklist update for issue #${result.issue.number}: ${result.mutation.status}.`];
  lines.push(`Issue: ${result.issue.title} (${result.issue.url})`);
  lines.push(`Selector: ${result.selector.index !== undefined ? `index #${result.selector.index}` : `item "${result.selector.text}"`}; state=${result.state}.`);
  lines.push(`Checklist: ${result.after.checked}/${result.after.total} checked.`);
  lines.push(`Mutation: ${result.mutation.description}`);
  if (result.after.unchecked > 0) {
    lines.push('Unchecked items:');
    for (const item of result.after.items.filter(item => !item.checked)) lines.push(`- #${item.index}: ${item.text}`);
  }
  lines.push(`Next action: ${result.nextAction}`);
  return lines.join('\n');
}
