import { maybeWorkItemKeyNumber, type WorkItem, type WorkItemKey } from './core/work_item.js';
import type { GhExec } from '@tjalve/qube-adapter-github';
import { buildWorkDependencyGraph, computeWorkQueue, planStatusSyncFromWorkItems, resolveWorkStatusLabels, type WorkQueuePolicy } from './core/queue_rules.js';
import { getDefaults, loadConfig, type Config } from './config/index.js';
import { createWorkProvider } from './providers/work_provider_adapters.js';
import type { WorkProvider, WorkProviderId } from './providers/work_provider.js';

export interface BlockerDetail {
  number: number;
  title: string;
  state: string;
}

export interface StatusFixPlan {
  issueNumber: number;
  add: string[];
  remove: string[];
  skipped: boolean;
  reason?: string;
}

export interface IssueLikeDependencyInput {
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED' | string;
  labels?: string[];
  declaredBlockers?: number[];
}

const DEFAULT_WORK_QUEUE_POLICY: WorkQueuePolicy = {
  priorityLabels: ['P1-Critical', 'P2-High', 'P3-Medium', 'P4-Low'],
  statusLabels: ['S-Ready', 'S-InProgress', 'S-Blocked', 'S-Blocking'],
  milestoneOrdering: { enabled: false, order: [], missingAssignment: 'warn' },
};

export function configToWorkQueuePolicy(config: Config): WorkQueuePolicy {
  return {
    priorityLabels: config.priorityLabels,
    statusLabels: config.statusLabels,
    milestoneOrdering: config.milestoneOrdering,
  };
}

async function loadRuntimeConfig(options: { cwd?: string; config?: Config }): Promise<Config> {
  return options.config ?? (await loadConfig(options.cwd)) ?? getDefaults();
}

async function loadWorkQueuePolicy(options: { cwd?: string; config?: Config }): Promise<WorkQueuePolicy> {
  return configToWorkQueuePolicy(await loadRuntimeConfig(options));
}

async function loadWorkProvider(options: { exec?: GhExec; cwd?: string; config?: Config; includeAssignees?: boolean } = {}): Promise<{ provider: WorkProvider; providerId: WorkProviderId }> {
  const config = await loadRuntimeConfig(options);
  const providerId = config.providers.work.kind;
  const provider = await createWorkProvider(providerId, { exec: options.exec, cwd: options.cwd, includeAssignees: options.includeAssignees ?? false });
  return { provider, providerId };
}

function githubKey(issueNumber: number): WorkItemKey {
  return { providerId: 'github', id: String(issueNumber) };
}

function providerKey(providerId: WorkProviderId, issueNumber: number): WorkItemKey {
  return { providerId, id: String(issueNumber) };
}

function stableKey(key: WorkItemKey): string {
  return JSON.stringify([key.providerId, key.id]);
}

function workItemDetail(item: WorkItem): BlockerDetail {
  const number = maybeWorkItemKeyNumber(item.key);
  if (number === null) {
    throw new Error(`Dependency command expected numeric work item key, got ${item.key.providerId}:${item.key.id}.`);
  }
  return { number, title: item.title, state: item.state === 'open' ? 'OPEN' : 'CLOSED' };
}

function workStatusFromLabels(labels: string[] | undefined, policy: WorkQueuePolicy): WorkItem['status'] {
  const status = resolveWorkStatusLabels(policy);
  if (labels?.includes(status.inProgress)) return 'in-progress';
  if (labels?.includes(status.ready)) return 'ready';
  if (labels?.includes(status.blocked)) return 'blocked';
  return 'unknown';
}

async function blockerDetailsFromOpenItems(keys: WorkItemKey[], itemsByKey: Map<string, WorkItem>, options: { exec?: GhExec; cwd?: string }): Promise<BlockerDetail[]> {
  const details: BlockerDetail[] = [];
  for (const key of keys) {
    const openItem = itemsByKey.get(stableKey(key));
    if (openItem) {
      details.push(workItemDetail(openItem));
      continue;
    }

    const number = maybeWorkItemKeyNumber(key);
    if (number !== null) {
      details.push(...await resolveBlockerDetails([number], options));
    }
  }
  return details;
}

function issueLikeToWorkItem(input: IssueLikeDependencyInput, policy: WorkQueuePolicy = DEFAULT_WORK_QUEUE_POLICY): WorkItem {
  return {
    key: githubKey(input.number),
    displayId: `#${input.number}`,
    title: input.title,
    body: '',
    url: null,
    state: input.state === 'CLOSED' ? 'closed' : 'open',
    status: workStatusFromLabels(input.labels, policy),
    priority: 'none',
    tags: input.labels ?? [],
    assignees: [],
    project: null,
    blockers: (input.declaredBlockers ?? []).map(githubKey),
    blockedBy: [],
    sequence: null,
    checklist: { total: 0, completed: 0 },
    trustedMetadata: {
      githubIssueNumber: input.number,
      githubLabels: input.labels ?? [],
      githubState: input.state,
      githubDeclaredBlockers: input.declaredBlockers ?? [],
      githubMilestoneNumber: null,
    },
    source: { providerId: 'github', resourceKind: 'work-item', resourceId: String(input.number), url: null, metadata: { githubIssueNumber: input.number } },
  };
}

function toWorkItems(inputs: Array<WorkItem | IssueLikeDependencyInput>, policy: WorkQueuePolicy = DEFAULT_WORK_QUEUE_POLICY): WorkItem[] {
  return inputs.map(input => 'key' in input ? input : issueLikeToWorkItem(input, policy));
}

export async function resolveBlockerDetails(numbers: number[], options: { exec?: GhExec; cwd?: string; config?: Config } = {}): Promise<BlockerDetail[]> {
  const { provider, providerId } = await loadWorkProvider({ ...options, includeAssignees: false });
  const details: BlockerDetail[] = [];
  for (const number of numbers) {
    try {
      const blocker = await provider.getWorkItem(providerKey(providerId, number));
      details.push(workItemDetail(blocker));
    } catch {
      details.push({ number, title: 'not found or inaccessible', state: 'UNKNOWN' });
    }
  }
  return details;
}

export async function getDependencyIssueDetail(issueNumber: number, options: { exec?: GhExec; cwd?: string; config?: Config } = {}): Promise<BlockerDetail> {
  const { provider, providerId } = await loadWorkProvider({ ...options, includeAssignees: false });
  return workItemDetail(await provider.getWorkItem(providerKey(providerId, issueNumber)));
}

export async function getDirectBlockers(issueNumber: number, options: { exec?: GhExec; cwd?: string; config?: Config } = {}): Promise<BlockerDetail[]> {
  const { provider, providerId } = await loadWorkProvider({ ...options, includeAssignees: false });
  const item = await provider.getWorkItem(providerKey(providerId, issueNumber));
  return resolveBlockerDetails(item.blockers.map(maybeWorkItemKeyNumber).filter((number): number is number => number !== null), options);
}

export async function getIssuesBlockedBy(issueNumber: number, options: { exec?: GhExec; cwd?: string; config?: Config } = {}): Promise<BlockerDetail[]> {
  const { provider } = await loadWorkProvider(options);
  const openItems = await provider.listOpenWorkItems();
  return openItems.filter(item => item.blockers.some(blocker => blocker.id === String(issueNumber))).map(workItemDetail);
}

export async function getDependencyChain(issueNumber: number, visited: Set<number> = new Set(), options: { exec?: GhExec; cwd?: string; config?: Config } = {}): Promise<BlockerDetail[]> {
  if (visited.has(issueNumber)) return [];
  visited.add(issueNumber);
  const { provider, providerId } = await loadWorkProvider(options);
  const item = await provider.getWorkItem(providerKey(providerId, issueNumber));
  const chain: BlockerDetail[] = [workItemDetail(item)];
  for (const blocker of item.blockers) {
    const blockerNumber = maybeWorkItemKeyNumber(blocker);
    if (blockerNumber !== null && !visited.has(blockerNumber)) {
      chain.push(...await getDependencyChain(blockerNumber, visited, options));
    }
  }
  return chain;
}

export async function getAllBlockedIssues(options: { exec?: GhExec; cwd?: string; config?: Config } = {}): Promise<Array<{ number: number; title: string; state: string; blockers: BlockerDetail[] }>> {
  const { provider } = await loadWorkProvider(options);
  const openItems = await provider.listOpenWorkItems();
  const openItemsByKey = new Map(openItems.map(item => [stableKey(item.key), item]));
  const graph = buildWorkDependencyGraph(openItems);
  const blocked: Array<{ number: number; title: string; state: string; blockers: BlockerDetail[] }> = [];
  for (const node of graph.nodes) {
    if (node.openBlockerKeys.length > 0) {
      blocked.push({ ...workItemDetail(node.workItem), blockers: await blockerDetailsFromOpenItems(node.openBlockerKeys, openItemsByKey, options) });
    }
  }
  return blocked;
}

export async function getReadyIssues(options: { exec?: GhExec; cwd?: string; config?: Config } = {}): Promise<BlockerDetail[]> {
  const { provider } = await loadWorkProvider(options);
  const openItems = await provider.listOpenWorkItems();
  return computeWorkQueue(openItems, await loadWorkQueuePolicy(options)).items
    .filter(item => item.effectiveStatus === 'Ready')
    .map(item => workItemDetail(item.workItem));
}

export async function getDependencyGraph(options: { exec?: GhExec; cwd?: string; config?: Config } = {}): Promise<{ nodes: BlockerDetail[]; blockers: Record<number, number[]>; cycles: number[][] }> {
  const { provider } = await loadWorkProvider(options);
  const openItems = await provider.listOpenWorkItems();
  const graph = buildWorkDependencyGraph(openItems);
  const nodes = graph.nodes.map(node => workItemDetail(node.workItem));
  const blockers: Record<number, number[]> = {};
  for (const node of graph.nodes) {
    blockers[workItemDetail(node.workItem).number] = node.workItem.blockers.map(maybeWorkItemKeyNumber).filter((number): number is number => number !== null);
  }
  return { nodes, blockers, cycles: graph.cycles.map(cycle => cycle.keys.map(maybeWorkItemKeyNumber).filter((number): number is number => number !== null)) };
}

export function computeStatusFixPlanFromWorkItems(items: WorkItem[], policy: WorkQueuePolicy = DEFAULT_WORK_QUEUE_POLICY): StatusFixPlan[] {
  const byKey = new Map(items.map(item => [stableKey(item.key), item]));
  return planStatusSyncFromWorkItems(items, policy).map(plan => {
    const item = byKey.get(stableKey(plan.key));
    if (!item) {
      throw new Error(`compute status fix plan failed: missing work item ${plan.displayId}. Rebuild the dependency graph and retry.`);
    }
    return {
      issueNumber: workItemDetail(item).number,
      add: plan.addLabels,
      remove: plan.removeLabels,
      skipped: plan.skipped,
      reason: plan.reason,
    };
  });
}

export function computeStatusFixPlan(inputs: Array<WorkItem | IssueLikeDependencyInput>, policy: WorkQueuePolicy = DEFAULT_WORK_QUEUE_POLICY): StatusFixPlan[] {
  return computeStatusFixPlanFromWorkItems(toWorkItems(inputs, policy), policy);
}
