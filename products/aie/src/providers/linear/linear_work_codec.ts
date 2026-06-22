import { normalizeProviderSource } from '../../core/provider_source.js';
import { normalizeWorkItem, normalizeWorkItemKey, type WorkChecklist, type WorkItem, type WorkItemKey, type WorkPriority, type WorkProject, type WorkStatus } from '../../core/work_item.js';

const PROVIDER_ID = 'linear';

export type LinearWorkflowType = 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled' | 'unknown';

export interface LinearWorkflowState {
  id: string;
  name: string;
  type?: string | null;
  category?: string | null;
}

export interface LinearTeam {
  id: string;
  key?: string | null;
  name?: string | null;
}

export interface LinearLabel {
  id?: string | null;
  name: string;
}

export interface LinearUser {
  id?: string | null;
  name?: string | null;
  displayName?: string | null;
  email?: string | null;
}

export interface LinearProject {
  id: string;
  name: string;
  status?: { name?: string | null; type?: string | null } | null;
  targetDate?: string | null;
}

export interface LinearIssueRelation {
  type?: string | null;
  relatedIssue?: {
    id: string;
    identifier?: string | null;
  } | null;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  number?: number | null;
  title: string;
  description?: string | null;
  url?: string | null;
  priority?: number | null;
  team?: LinearTeam | null;
  state?: LinearWorkflowState | null;
  assignee?: LinearUser | null;
  labels?: { nodes?: LinearLabel[] | null } | LinearLabel[] | null;
  project?: LinearProject | null;
  relations?: { nodes?: LinearIssueRelation[] | null } | LinearIssueRelation[] | null;
  archivedAt?: string | null;
}

export function linearWorkItemKey(issueIdOrIdentifier: number | string): WorkItemKey {
  return normalizeWorkItemKey(PROVIDER_ID, String(issueIdOrIdentifier));
}

function workflowType(state: LinearWorkflowState | null | undefined): LinearWorkflowType {
  const value = (state?.type ?? state?.category ?? '').toLowerCase();
  if (value === 'triage' || value === 'backlog' || value === 'unstarted' || value === 'started' || value === 'completed' || value === 'canceled') return value;
  return 'unknown';
}

function mapStatus(state: LinearWorkflowState | null | undefined): WorkStatus {
  const type = workflowType(state);
  if (type === 'started') return 'in-progress';
  if (type === 'triage' || type === 'backlog' || type === 'unstarted') return 'ready';
  if (type === 'completed' || type === 'canceled') return 'unknown';
  return 'unknown';
}

function mapState(issue: LinearIssue): WorkItem['state'] {
  const type = workflowType(issue.state);
  return type === 'completed' || type === 'canceled' || issue.archivedAt ? 'closed' : 'open';
}

function mapPriority(priority: number | null | undefined): WorkPriority {
  if (priority === 1) return 'critical';
  if (priority === 2) return 'high';
  if (priority === 3) return 'medium';
  if (priority === 4) return 'low';
  return 'none';
}

function labelsFromIssue(issue: LinearIssue): string[] {
  const labels = Array.isArray(issue.labels) ? issue.labels : issue.labels?.nodes ?? [];
  return labels.map(label => label.name).filter(name => name.trim() !== '');
}

function assigneesFromIssue(issue: LinearIssue): string[] {
  const user = issue.assignee;
  if (!user) return [];
  const name = user.displayName ?? user.name ?? user.email ?? '';
  return name.trim() === '' ? [] : [name.trim()];
}

function mapProject(project: LinearProject | null | undefined): WorkProject | null {
  if (!project) return null;
  const state = project.status?.type?.toLowerCase() === 'completed'
    ? 'closed'
    : project.status?.type?.toLowerCase() === 'canceled'
      ? 'closed'
      : project.status?.type
        ? 'open'
        : 'unknown';
  return {
    id: project.id,
    title: project.name,
    state,
    dueOn: project.targetDate ?? null,
  };
}

function relationIssueKeys(issue: LinearIssue, type: string): WorkItemKey[] {
  const relations = Array.isArray(issue.relations) ? issue.relations : issue.relations?.nodes ?? [];
  return relations
    .filter(relation => relation.type === type)
    .map(relation => relation.relatedIssue)
    .filter((related): related is NonNullable<LinearIssueRelation['relatedIssue']> => !!related)
    .map(related => linearWorkItemKey(related.identifier ?? related.id));
}

function relationBlockers(issue: LinearIssue): WorkItemKey[] {
  return relationIssueKeys(issue, 'blockedBy');
}

function relationBlockedBy(issue: LinearIssue): WorkItemKey[] {
  return relationIssueKeys(issue, 'blocks');
}

export function parseLinearBlockerKeys(description: string | null | undefined): WorkItemKey[] {
  if (!description) return [];
  const matches = description.matchAll(/Blocked by:\s*\b([A-Z][A-Z0-9]+-\d+)/g);
  return [...matches].map(match => linearWorkItemKey(match[1]));
}

function parseWorkChecklist(description: string | null | undefined): WorkChecklist {
  if (!description) return { total: 0, completed: 0 };
  const items = [...description.matchAll(/^\s*-\s+\[(x|X| )\]\s+/gm)];
  return { total: items.length, completed: items.filter(item => item[1].toLowerCase() === 'x').length };
}

export function attachLinearBlockedBy(items: WorkItem[]): WorkItem[] {
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

export function linearIssueToWorkItem(issue: LinearIssue): WorkItem {
  const description = issue.description ?? '';
  const stateType = workflowType(issue.state);
  const blockers = [...relationBlockers(issue), ...parseLinearBlockerKeys(description)];
  const labels = labelsFromIssue(issue);
  const tags = [
    ...labels,
    issue.state?.name ? `linear:state:${issue.state.name}` : null,
    stateType !== 'unknown' ? `linear:state-type:${stateType}` : null,
    issue.team?.key ? `linear:team:${issue.team.key}` : null,
  ].filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '');
  return normalizeWorkItem({
    key: linearWorkItemKey(issue.identifier || issue.id),
    displayId: issue.identifier || issue.id,
    title: issue.title,
    body: description,
    url: issue.url ?? null,
    state: mapState(issue),
    status: mapStatus(issue.state),
    priority: mapPriority(issue.priority),
    tags,
    assignees: assigneesFromIssue(issue),
    project: mapProject(issue.project),
    blockers,
    blockedBy: relationBlockedBy(issue),
    sequence: null,
    checklist: parseWorkChecklist(description),
    trustedMetadata: {
      linearIssueId: issue.id,
      linearIdentifier: issue.identifier,
      linearNumber: issue.number ?? null,
      linearTeamId: issue.team?.id ?? null,
      linearTeamKey: issue.team?.key ?? null,
      linearStateId: issue.state?.id ?? null,
      linearStateName: issue.state?.name ?? null,
      linearStateType: stateType,
      linearPriority: issue.priority ?? 0,
      linearLabels: labels,
    },
    source: normalizeProviderSource({
      providerId: PROVIDER_ID,
      resourceKind: 'work-item',
      resourceId: issue.id,
      url: issue.url ?? null,
      metadata: {
        linearIssueId: issue.id,
        linearIdentifier: issue.identifier,
        linearTeamId: issue.team?.id ?? null,
      },
    }),
  });
}
