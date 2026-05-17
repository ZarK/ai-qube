import { loadConfig, getDefaults, Config } from '../config';
import { maybeWorkItemKeyNumber, type WorkItem } from '../core/work_item';
import { computeWorkQueue, type WorkMilestoneGroup, type WorkQueuePolicy } from '../core/queue_rules';
import { createGitHubWorkProvider } from '../providers/github/github_work_provider';
import { githubIssueNumber } from '../providers/github/github_work_codec';
import { createLifecycleContext } from '../app/lifecycle_services';
import { runNextWorkService } from '../app/next_work';

export interface QueueIssueSummary {
  number: number;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED';
  labels: string[];
  assignees: string[];
  milestone: {
    number: number;
    title: string;
    state: string;
    dueOn: string | null;
  } | null;
  url: string;
  declaredBlockers: number[];
}

export interface QueueItem {
  workItem: WorkItem;
  issue: QueueIssueSummary;
  effectiveStatus: 'InProgress' | 'Ready' | 'Blocked';
  openBlockers: number[];
  drifted: boolean;
}

export interface QueueDependencyCycle {
  issues: number[];
}

export interface QueueMilestoneGroup {
  milestone: QueueIssueSummary['milestone'];
  title: string;
  itemNumbers: number[];
  progress: WorkMilestoneGroup['progress'];
}

export interface Queue {
  items: QueueItem[];
  inProgressCount: number;
  readyCount: number;
  blockedCount: number;
  driftCount: number;
  multipleInProgress: boolean;
  cycles: QueueDependencyCycle[];
  milestoneGroups: QueueMilestoneGroup[];
}

export interface IssueLikeQueueInput {
  number: number;
  title: string;
  body?: string;
  state: 'OPEN' | 'CLOSED' | string;
  labels?: string[];
  assignees?: string[];
  milestone?: QueueIssueSummary['milestone'];
  url?: string;
  declaredBlockers?: number[];
}

function milestoneNumber(item: WorkItem): number | null {
  const value = item.trustedMetadata.githubMilestoneNumber;
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function configToWorkQueuePolicy(config: Config): WorkQueuePolicy {
  return {
    priorityLabels: config.priorityLabels,
    statusLabels: config.statusLabels,
    milestoneOrdering: config.milestoneOrdering,
  };
}

export function workItemToIssueSummary(item: WorkItem): QueueIssueSummary {
  return {
    number: githubIssueNumber(item),
    title: item.title,
    body: item.body,
    state: item.state === 'open' ? 'OPEN' : 'CLOSED',
    labels: [...item.tags],
    assignees: [...item.assignees],
    milestone: item.project ? {
      number: milestoneNumber(item) ?? Number(item.project.id),
      title: item.project.title,
      state: item.project.state.toUpperCase(),
      dueOn: item.project.dueOn,
    } : null,
    url: item.url ?? '',
    declaredBlockers: item.blockers.map(maybeWorkItemKeyNumber).filter((number): number is number => number !== null),
  };
}

function issueLikeToWorkItem(input: IssueLikeQueueInput): WorkItem {
  return {
    key: { providerId: 'github', id: String(input.number) },
    displayId: `#${input.number}`,
    title: input.title,
    body: input.body ?? '',
    url: input.url ?? '',
    state: input.state === 'CLOSED' ? 'closed' : 'open',
    status: input.labels?.includes('S-InProgress') ? 'in-progress' : input.labels?.includes('S-Ready') ? 'ready' : input.labels?.includes('S-Blocked') ? 'blocked' : 'unknown',
    priority: input.labels?.includes('P1-Critical') ? 'critical' : input.labels?.includes('P2-High') ? 'high' : input.labels?.includes('P3-Medium') ? 'medium' : input.labels?.includes('P4-Low') ? 'low' : 'none',
    tags: input.labels ?? [],
    assignees: input.assignees ?? [],
    project: input.milestone ? {
      id: String(input.milestone.number),
      title: input.milestone.title,
      state: input.milestone.state.toLowerCase() === 'closed' ? 'closed' : input.milestone.state.toLowerCase() === 'open' ? 'open' : 'unknown',
      dueOn: input.milestone.dueOn,
    } : null,
    blockers: (input.declaredBlockers ?? []).map(number => ({ providerId: 'github', id: String(number) })),
    blockedBy: [],
    sequence: (input.body ?? '').match(/Sequence:\s*(\S+)/i)?.[1] ?? null,
    checklist: { total: 0, completed: 0 },
    trustedMetadata: {
      githubIssueNumber: input.number,
      githubLabels: input.labels ?? [],
      githubState: input.state,
      githubDeclaredBlockers: input.declaredBlockers ?? [],
      githubMilestoneNumber: input.milestone?.number ?? null,
    },
    source: { providerId: 'github', resourceKind: 'work-item', resourceId: String(input.number), url: input.url ?? '', metadata: { githubIssueNumber: input.number } },
  };
}

export function computeQueueFromWorkItems(openWorkItems: WorkItem[], config: Config = getDefaults()): Queue {
  const coreQueue = computeWorkQueue(openWorkItems, configToWorkQueuePolicy(config));
  const items = coreQueue.items.map((item): QueueItem => {
    const workItem = item.workItem;
    const issue = workItemToIssueSummary(workItem);
    const openBlockers = item.openBlockerKeys.map(maybeWorkItemKeyNumber).filter((number): number is number => number !== null);
    return { workItem, issue, effectiveStatus: item.effectiveStatus, openBlockers, drifted: item.drifted };
  });

  return {
    items,
    inProgressCount: coreQueue.inProgressCount,
    readyCount: coreQueue.readyCount,
    blockedCount: coreQueue.blockedCount,
    driftCount: coreQueue.driftCount,
    multipleInProgress: coreQueue.multipleInProgress,
    cycles: coreQueue.cycles.map(cycle => ({ issues: cycle.keys.map(maybeWorkItemKeyNumber).filter((number): number is number => number !== null) })),
    milestoneGroups: coreQueue.milestoneGroups.map(group => ({
      milestone: group.projectId === null ? null : {
        number: Number(group.projectId),
        title: group.title,
        state: group.state.toUpperCase(),
        dueOn: group.dueOn,
      },
      title: group.title,
      itemNumbers: group.itemKeys.map(maybeWorkItemKeyNumber).filter((number): number is number => number !== null),
      progress: group.progress,
    })),
  };
}

export function computeQueueFromIssues(openIssues: IssueLikeQueueInput[], config: Config = getDefaults()): Queue {
  return computeQueueFromWorkItems(openIssues.map(issueLikeToWorkItem), config);
}

export async function computeQueue(): Promise<Queue> {
  const config = (await loadConfig()) || getDefaults();
  const provider = createGitHubWorkProvider();
  const openWorkItems = await provider.listOpenWorkItems();
  return computeQueueFromWorkItems(openWorkItems, config);
}

export async function getNextIssue(): Promise<{ issue: QueueIssueSummary | null; reason: string; multipleInProgress: boolean; driftCount: number; }> {
  const config = (await loadConfig()) || getDefaults();
  const result = await runNextWorkService(await createLifecycleContext({ config }));
  return {
    issue: result.workItem ? workItemToIssueSummary(result.workItem) : null,
    reason: result.reason,
    multipleInProgress: result.multipleInProgress,
    driftCount: result.driftCount,
  };
}
