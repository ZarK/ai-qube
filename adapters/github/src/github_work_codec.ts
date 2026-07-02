import { normalizeProviderSource, normalizeWorkItem, normalizeWorkItemKey, type WorkChecklist, type WorkItem, type WorkItemKey, type WorkPriority, type WorkProject, type WorkStatus } from "@tjalve/qube-core";
import type { GitHubIssue, GitHubMilestone } from './github_issue_api.js';

const PROVIDER_ID = 'github';

export function githubWorkItemKey(issueNumber: number | string): WorkItemKey {
  return normalizeWorkItemKey(PROVIDER_ID, String(issueNumber));
}

export function parseWorkSequence(body: string): string | null {
  if (!body) return null;
  const match = body.match(/Sequence:\s*(\S+)/i);
  return match ? match[1] : null;
}

export interface WorkChecklistItem {
  text: string;
  checked: boolean;
}

export function parseWorkChecklistItems(body: string): WorkChecklistItem[] {
  return parseChecklistItems(body);
}

export function parseWorkChecklist(body: string): WorkChecklist {
  const items = parseChecklistItems(body);
  return { total: items.length, completed: items.filter(item => item.checked).length };
}

function parseChecklistItems(body: string): WorkChecklistItem[] {
  const items: WorkChecklistItem[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:[-*+]\s*)?\[( |x|X)\]\s+(.+?)\s*$/);
    if (!match) continue;
    items.push({ checked: match[1].toLowerCase() === 'x', text: match[2] });
  }
  return items;
}

function mapStatus(labels: string[]): WorkStatus {
  if (labels.includes('S-InProgress')) return 'in-progress';
  if (labels.includes('S-Ready')) return 'ready';
  if (labels.includes('S-Blocked')) return 'blocked';
  return 'unknown';
}

function mapPriority(labels: string[]): WorkPriority {
  if (labels.includes('P1-Critical')) return 'critical';
  if (labels.includes('P2-High')) return 'high';
  if (labels.includes('P3-Medium')) return 'medium';
  if (labels.includes('P4-Low')) return 'low';
  return 'none';
}

function mapMilestone(milestone: GitHubMilestone | null): WorkProject | null {
  if (!milestone) return null;
  return {
    id: String(milestone.number),
    title: milestone.title,
    state: milestone.state.toLowerCase() === 'open' ? 'open' : milestone.state.toLowerCase() === 'closed' ? 'closed' : 'unknown',
    dueOn: milestone.dueOn,
  };
}

export function githubIssueToWorkItem(issue: GitHubIssue): WorkItem {
  return normalizeWorkItem({
    key: githubWorkItemKey(issue.number),
    displayId: `#${issue.number}`,
    title: issue.title,
    body: issue.body,
    url: issue.url,
    state: issue.state === 'OPEN' ? 'open' : 'closed',
    status: mapStatus(issue.labels),
    priority: mapPriority(issue.labels),
    tags: issue.labels,
    assignees: issue.assignees,
    project: mapMilestone(issue.milestone),
    blockers: issue.declaredBlockers.map(githubWorkItemKey),
    blockedBy: [],
    sequence: parseWorkSequence(issue.body),
    checklist: parseWorkChecklist(issue.body),
    trustedMetadata: {
      githubIssueNumber: issue.number,
      githubLabels: issue.labels,
      githubState: issue.state,
      githubDeclaredBlockers: issue.declaredBlockers,
      githubMilestoneNumber: issue.milestone?.number ?? null,
    },
    source: normalizeProviderSource({
      providerId: PROVIDER_ID,
      resourceKind: 'work-item',
      resourceId: String(issue.number),
      url: issue.url,
      metadata: { githubIssueNumber: issue.number },
    }),
  });
}

export function attachBlockedBy(items: WorkItem[]): WorkItem[] {
  const blockedBy = new Map<string, WorkItemKey[]>();
  for (const item of items) {
    for (const blocker of item.blockers) {
      const key = JSON.stringify([blocker.providerId, blocker.id]);
      blockedBy.set(key, [...(blockedBy.get(key) ?? []), item.key]);
    }
  }
  return items.map((item) => normalizeWorkItem({
    ...item,
    blockedBy: blockedBy.get(JSON.stringify([item.key.providerId, item.key.id])) ?? item.blockedBy,
  }));
}

export function githubIssueNumber(item: WorkItem): number {
  const value = item.trustedMetadata.githubIssueNumber;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  const numericId = Number(item.key.id);
  if (Number.isInteger(numericId) && numericId > 0) return numericId;
  throw new Error(`map GitHub work item failed: ${item.key.id} is not a positive GitHub issue number. Use a GitHub work item key with a numeric id.`);
}
