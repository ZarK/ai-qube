import { suggestBranchName } from '../core/branch_rules';
import { maybeWorkItemKeyNumber, type WorkItem } from '../core/work_item';
import { resolveBlockerDetails, type BlockerDetail } from '../deps';
import { getRepositoryIdentity, listMilestones } from '../repo';
import { githubIssueNumber, parseWorkChecklist } from '../providers/github/github_work_codec';
import type { LifecycleServiceContext } from './lifecycle_common';

export interface ViewServiceResult {
  ok: boolean;
  item: WorkItem;
  effectiveStatus: 'InProgress' | 'Ready' | 'Blocked' | 'Closed';
  milestone: { number: number; title: string; state: string; dueOn: string | null; openIssues: number | null; closedIssues: number | null } | null;
  dependency: { declaredBlockers: number[]; openBlockers: number[]; unresolvedBlockers: number[]; blockers: BlockerDetail[]; dependents: BlockerDetail[] };
  checklist: { total: number; checked: number; unchecked: number; items: string[] };
  branch: { suggested: string; current: string | null; matches: boolean };
  warnings: string[];
  recommendedAction: string;
}

function checklistItems(body: string): string[] {
  const items: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:[-*+]\s+)?\[[ xX]\]\s*(.*)$/);
    if (match) items.push(match[1].trim());
  }
  return items;
}

function recommendedAction(issueNumber: number, status: ViewServiceResult['effectiveStatus'], unresolvedBlockers: BlockerDetail[], hasOtherInProgress: boolean): string {
  if (status === 'Closed') return `Issue is closed. Run \`aie deps blocking ${issueNumber}\` to inspect open dependents before advancing related work.`;
  if (status === 'InProgress') return `Resume this issue after confirming the current branch matches the suggested branch. Run \`aie view ${issueNumber} --json\` for machine-readable context.`;
  if (unresolvedBlockers.length > 0) return `Do not start — blocker status could not be verified. Run \`aie deps blockers ${issueNumber}\` and resolve inaccessible blockers first.`;
  if (status === 'Blocked') return `Do not start — open blockers must close first. Run \`aie deps blockers ${issueNumber}\` for details.`;
  if (hasOtherInProgress) return 'Another issue is already in progress. Run `aie queue` to inspect the active issue before changing work.';
  return 'Issue is ready. Confirm selection with `aie next --json`, then create or check out the suggested branch before implementation.';
}

export async function runViewService(options: { issueNumber: number; context: LifecycleServiceContext; currentBranch: string | null }): Promise<ViewServiceResult> {
  const { issueNumber, context, currentBranch } = options;
  const item = await context.provider.getWorkItem({ providerId: 'github', id: String(issueNumber) });
  const blockerNumbers = item.blockers.map(maybeWorkItemKeyNumber).filter((number): number is number => number !== null);
  const blockers = await resolveBlockerDetails(blockerNumbers, { exec: context.exec, cwd: context.cwd });
  const openBlockers = blockers.filter(blocker => blocker.state === 'OPEN');
  const unresolvedBlockers = blockers.filter(blocker => blocker.state === 'UNKNOWN');
  const openItems = await context.provider.listOpenWorkItems();
  const dependents = openItems.filter(candidate => candidate.blockers.some(blocker => blocker.id === String(issueNumber))).map(candidate => ({ number: githubIssueNumber(candidate), title: candidate.title, state: candidate.state === 'open' ? 'OPEN' : 'CLOSED' }));
  const status: ViewServiceResult['effectiveStatus'] = item.state === 'closed' ? 'Closed' : item.tags.includes('S-InProgress') ? 'InProgress' : openBlockers.length > 0 || unresolvedBlockers.length > 0 ? 'Blocked' : 'Ready';
  const hasOtherInProgress = openItems.some(candidate => candidate.key.id !== String(issueNumber) && candidate.tags.includes('S-InProgress'));
  const checklist = parseWorkChecklist(item.body);
  const items = checklistItems(item.body);
  const suggested = suggestBranchName(item, context.policy.branch).branchName;

  let milestone: ViewServiceResult['milestone'] = item.project ? { number: Number(item.project.id), title: item.project.title, state: item.project.state.toUpperCase(), dueOn: item.project.dueOn, openIssues: null, closedIssues: null } : null;
  const warnings: string[] = [];
  if (milestone) {
    try {
      const repository = await getRepositoryIdentity({ exec: context.exec, cwd: context.cwd });
      const milestones = await listMilestones(repository, { exec: context.exec, cwd: context.cwd });
      const match = milestones.find(candidate => candidate.number === milestone?.number);
      if (match) milestone = { number: match.number, title: match.title, state: match.state.toUpperCase(), dueOn: match.dueOn, openIssues: match.openIssues, closedIssues: match.closedIssues };
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      warnings.push(`Milestone progress counts unavailable: ${detail}`);
    }
  }

  const unchecked = checklist.total - checklist.completed;
  if (unchecked > 0 && item.state !== 'closed') warnings.push(`${unchecked} unchecked checklist item(s).`);
  if (unresolvedBlockers.length > 0) warnings.push(`Could not verify blocker status for issue(s): ${unresolvedBlockers.map(blocker => `#${blocker.number}`).join(', ')}.`);
  if (hasOtherInProgress && status !== 'InProgress') warnings.push('Another issue is S-InProgress.');

  return {
    ok: true,
    item,
    effectiveStatus: status,
    milestone,
    dependency: { declaredBlockers: blockerNumbers, openBlockers: openBlockers.map(blocker => blocker.number), unresolvedBlockers: unresolvedBlockers.map(blocker => blocker.number), blockers, dependents },
    checklist: { total: checklist.total, checked: checklist.completed, unchecked, items },
    branch: { suggested, current: currentBranch, matches: currentBranch !== null && currentBranch === suggested },
    warnings,
    recommendedAction: recommendedAction(issueNumber, status, unresolvedBlockers, hasOtherInProgress),
  };
}
