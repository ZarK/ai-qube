import { normalizeProviderSource, normalizeWorkItem, normalizeWorkItemKey, type WorkChecklist, type WorkItem, type WorkItemKey, type WorkPriority, type WorkProject, type WorkStatus } from '@tjalve/qube-core';

const PROVIDER_ID = 'gitlab';

export interface GitLabUser {
  id?: number | null;
  name?: string | null;
  username?: string | null;
  public_email?: string | null;
}

export interface GitLabMilestone {
  id?: number | null;
  iid?: number | null;
  title: string;
  state?: string | null;
  due_date?: string | null;
}

export interface GitLabLinkedIssue {
  id?: number | null;
  iid?: number | null;
  project_id?: number | null;
  web_url?: string | null;
}

export interface GitLabIssueLink {
  id?: number | null;
  link_type?: string | null;
  source_issue?: GitLabLinkedIssue | null;
  target_issue?: GitLabLinkedIssue | null;
}

export interface GitLabIssue {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description?: string | null;
  state?: string | null;
  labels?: string[] | null;
  assignees?: GitLabUser[] | null;
  assignee?: GitLabUser | null;
  milestone?: GitLabMilestone | null;
  web_url?: string | null;
  references?: { short?: string | null; relative?: string | null; full?: string | null } | null;
  task_completion_status?: { count?: number | null; completed_count?: number | null } | null;
  issue_type?: string | null;
  weight?: number | null;
  closed_at?: string | null;
  links?: GitLabIssueLink[] | null;
}

export function gitLabWorkItemKey(issueIid: number | string, projectId?: number | string | null): WorkItemKey {
  const iid = String(issueIid).replace(/^#/, '');
  return normalizeWorkItemKey(PROVIDER_ID, projectId === undefined || projectId === null ? iid : `${projectId}:${iid}`);
}

function mapStatus(issue: GitLabIssue): WorkStatus {
  const labels = labelsFromIssue(issue);
  if (labels.includes('S-InProgress')) return 'in-progress';
  if (labels.includes('S-Ready')) return 'ready';
  if (labels.includes('S-Blocked')) return 'blocked';
  return issue.state === 'opened' ? 'ready' : 'unknown';
}

function mapPriority(issue: GitLabIssue): WorkPriority {
  const labels = labelsFromIssue(issue);
  if (labels.includes('P1-Critical')) return 'critical';
  if (labels.includes('P2-High')) return 'high';
  if (labels.includes('P3-Medium')) return 'medium';
  if (labels.includes('P4-Low')) return 'low';
  return 'none';
}

function labelsFromIssue(issue: GitLabIssue): string[] {
  return (issue.labels ?? []).map(label => label.trim()).filter(label => label !== '');
}

function assigneesFromIssue(issue: GitLabIssue): string[] {
  const assignees = issue.assignees?.length ? issue.assignees : issue.assignee ? [issue.assignee] : [];
  return assignees
    .map(user => user.name ?? user.username ?? user.public_email ?? '')
    .map(name => name.trim())
    .filter(name => name !== '');
}

function mapMilestone(milestone: GitLabMilestone | null | undefined): WorkProject | null {
  if (!milestone) return null;
  const state = milestone.state === 'active'
    ? 'open'
    : milestone.state === 'closed'
      ? 'closed'
      : 'unknown';
  return {
    id: String(milestone.id ?? milestone.iid ?? milestone.title),
    title: milestone.title,
    state,
    dueOn: milestone.due_date ?? null,
  };
}

function parseGitLabBlockerKeys(description: string | null | undefined): WorkItemKey[] {
  if (!description) return [];
  const matches = description.matchAll(/Blocked by:\s*#?([1-9]\d*)\b/g);
  return [...matches].map(match => gitLabWorkItemKey(match[1]));
}

function parseWorkSequence(description: string | null | undefined): string | null {
  if (!description) return null;
  const match = /^Sequence:\s*(\d+)\s*$/m.exec(description);
  return match ? match[1] : null;
}

function parseWorkChecklist(issue: GitLabIssue, description: string): WorkChecklist {
  const taskStatus = issue.task_completion_status;
  if (
    Number.isInteger(taskStatus?.count) &&
    Number.isInteger(taskStatus?.completed_count) &&
    (taskStatus?.count ?? 0) >= 0 &&
    (taskStatus?.completed_count ?? 0) >= 0
  ) {
    return {
      total: taskStatus?.count ?? 0,
      completed: Math.min(taskStatus?.completed_count ?? 0, taskStatus?.count ?? 0),
    };
  }
  const items = [...description.matchAll(/^\s*-\s+\[(x|X| )\]\s+/gm)];
  return { total: items.length, completed: items.filter(item => item[1].toLowerCase() === 'x').length };
}

function isCurrentIssue(issue: GitLabIssue, linked: GitLabLinkedIssue | null | undefined): boolean {
  return linked?.iid === issue.iid && linked?.project_id === issue.project_id;
}

function linkedIssueKey(currentProjectId: number, linked: GitLabLinkedIssue | null | undefined): WorkItemKey | null {
  if (!linked?.iid) return null;
  const projectId = linked.project_id !== undefined && linked.project_id !== null && linked.project_id !== currentProjectId
    ? linked.project_id
    : undefined;
  return gitLabWorkItemKey(linked.iid, projectId);
}

function relationBlockers(issue: GitLabIssue): WorkItemKey[] {
  const keys: WorkItemKey[] = [];
  for (const link of issue.links ?? []) {
    if (link.link_type === 'is_blocked_by' && isCurrentIssue(issue, link.source_issue)) {
      const key = linkedIssueKey(issue.project_id, link.target_issue);
      if (key) keys.push(key);
    }
    if (link.link_type === 'blocks' && isCurrentIssue(issue, link.target_issue)) {
      const key = linkedIssueKey(issue.project_id, link.source_issue);
      if (key) keys.push(key);
    }
  }
  return keys;
}

function relationBlockedBy(issue: GitLabIssue): WorkItemKey[] {
  const keys: WorkItemKey[] = [];
  for (const link of issue.links ?? []) {
    if (link.link_type === 'blocks' && isCurrentIssue(issue, link.source_issue)) {
      const key = linkedIssueKey(issue.project_id, link.target_issue);
      if (key) keys.push(key);
    }
    if (link.link_type === 'is_blocked_by' && isCurrentIssue(issue, link.target_issue)) {
      const key = linkedIssueKey(issue.project_id, link.source_issue);
      if (key) keys.push(key);
    }
  }
  return keys;
}

export function attachGitLabBlockedBy(items: WorkItem[]): WorkItem[] {
  const blockedBy = new Map<string, WorkItemKey[]>();
  for (const item of items) {
    for (const blocker of item.blockers) {
      const key = JSON.stringify([blocker.providerId, blocker.id]);
      blockedBy.set(key, [...(blockedBy.get(key) ?? []), item.key]);
    }
  }
  return items.map((item) => normalizeWorkItem({
    ...item,
    blockedBy: [...item.blockedBy, ...(blockedBy.get(JSON.stringify([item.key.providerId, item.key.id])) ?? [])],
  }));
}

export function gitLabIssueToWorkItem(issue: GitLabIssue): WorkItem {
  const description = issue.description ?? '';
  const labels = labelsFromIssue(issue);
  const blockers = [...relationBlockers(issue), ...parseGitLabBlockerKeys(description)];
  const displayId = issue.references?.relative ?? issue.references?.short ?? `#${issue.iid}`;
  const state = issue.state === 'closed' || issue.closed_at ? 'closed' : 'open';
  const tags = [
    ...labels,
    issue.state ? `gitlab:state:${issue.state}` : null,
    issue.issue_type ? `gitlab:type:${issue.issue_type}` : null,
  ].filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '');
  return normalizeWorkItem({
    key: gitLabWorkItemKey(issue.iid),
    displayId,
    title: issue.title,
    body: description,
    url: issue.web_url ?? null,
    state,
    status: mapStatus(issue),
    priority: mapPriority(issue),
    tags,
    assignees: assigneesFromIssue(issue),
    project: mapMilestone(issue.milestone),
    blockers,
    blockedBy: relationBlockedBy(issue),
    sequence: parseWorkSequence(description),
    checklist: parseWorkChecklist(issue, description),
    trustedMetadata: {
      gitlabIssueId: issue.id,
      gitlabIssueIid: issue.iid,
      gitlabProjectId: issue.project_id,
      gitlabState: issue.state ?? null,
      gitlabLabels: labels,
      gitlabIssueType: issue.issue_type ?? null,
      gitlabWeight: issue.weight ?? null,
    },
    source: normalizeProviderSource({
      providerId: PROVIDER_ID,
      resourceKind: 'work-item',
      resourceId: `${issue.project_id}:${issue.iid}`,
      url: issue.web_url ?? null,
      metadata: {
        gitlabIssueId: issue.id,
        gitlabIssueIid: issue.iid,
        gitlabProjectId: issue.project_id,
      },
    }),
  });
}
