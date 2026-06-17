import { createAction, createActionPlan, type Action, type ActionPlan } from './action_plan.js';
import type { MilestoneOrderingPolicy } from './policy.js';
import { maybeWorkItemKeyNumber, type WorkItem, type WorkItemKey, type WorkPriority, type WorkStatus } from './work_item.js';

export type EffectiveWorkStatus = 'InProgress' | 'Ready' | 'Blocked';

export interface WorkQueuePolicy {
  priorityLabels: string[];
  statusLabels: string[];
  milestoneOrdering: MilestoneOrderingPolicy;
}

export interface WorkDependencyNode {
  workItem: WorkItem;
  openBlockerKeys: WorkItemKey[];
  openDependentKeys: WorkItemKey[];
  blocksOpenWork: boolean;
}

export interface WorkDependencyCycle {
  keys: WorkItemKey[];
}

export interface WorkDependencyGraph {
  nodes: WorkDependencyNode[];
  cycles: WorkDependencyCycle[];
}

export interface WorkQueueItem {
  workItem: WorkItem;
  effectiveStatus: EffectiveWorkStatus;
  openBlockerKeys: WorkItemKey[];
  openDependentKeys: WorkItemKey[];
  blocksOpenWork: boolean;
  drifted: boolean;
}

export interface WorkMilestoneProgress {
  totalItems: number;
  inProgressCount: number;
  readyCount: number;
  blockedCount: number;
  checklistTotal: number;
  checklistCompleted: number;
}

export interface WorkMilestoneGroup {
  projectId: string | null;
  title: string;
  state: 'open' | 'closed' | 'unknown';
  dueOn: string | null;
  itemKeys: WorkItemKey[];
  progress: WorkMilestoneProgress;
}

export interface WorkQueueState {
  items: WorkQueueItem[];
  inProgressCount: number;
  readyCount: number;
  blockedCount: number;
  driftCount: number;
  multipleInProgress: boolean;
  cycles: WorkDependencyCycle[];
  milestoneGroups: WorkMilestoneGroup[];
}

export interface WorkStatusSyncPlan {
  key: WorkItemKey;
  displayId: string;
  effectiveStatus: EffectiveWorkStatus;
  openBlockerKeys: WorkItemKey[];
  blocksOpenWork: boolean;
  addLabels: string[];
  removeLabels: string[];
  skipped: boolean;
  reason?: string;
}

export interface NextWorkSelection {
  workItem: WorkItem | null;
  reason: string;
  multipleInProgress: boolean;
  driftCount: number;
}

const DEFAULT_PRIORITY_ORDER: WorkPriority[] = ['critical', 'high', 'medium', 'low', 'none'];
const DEFAULT_STATUS_LABELS = ['S-Ready', 'S-InProgress', 'S-Blocked', 'S-Blocking'];

function stableKey(key: WorkItemKey): string {
  return JSON.stringify([key.providerId, key.id]);
}

function uniqueKeys(keys: WorkItemKey[]): WorkItemKey[] {
  const seen = new Set<string>();
  const unique: WorkItemKey[] = [];
  for (const key of keys) {
    const id = stableKey(key);
    if (!seen.has(id)) {
      seen.add(id);
      unique.push({ providerId: key.providerId, id: key.id });
    }
  }
  return unique;
}

export function resolveWorkStatusLabels(policy: WorkQueuePolicy): { ready: string; inProgress: string; blocked: string; blocking: string; all: string[] } {
  const labels = policy.statusLabels.length > 0 ? policy.statusLabels : DEFAULT_STATUS_LABELS;
  return {
    ready: labels.find(label => label === 'S-Ready') ?? labels[0] ?? 'S-Ready',
    inProgress: labels.find(label => label === 'S-InProgress') ?? labels[1] ?? 'S-InProgress',
    blocked: labels.find(label => label === 'S-Blocked') ?? labels[2] ?? 'S-Blocked',
    blocking: labels.find(label => label === 'S-Blocking') ?? labels[3] ?? 'S-Blocking',
    all: labels,
  };
}

function itemHasStatusLabel(item: WorkItem, label: string): boolean {
  return item.tags.includes(label);
}

export function workItemStableKey(item: WorkItem): string {
  return stableKey(item.key);
}

export function workItemIsInProgress(item: WorkItem, policy: WorkQueuePolicy): boolean {
  return item.status === 'in-progress' || itemHasStatusLabel(item, resolveWorkStatusLabels(policy).inProgress);
}

export function getOpenWorkItemKeys(items: WorkItem[]): Set<string> {
  return new Set(items.filter(item => item.state === 'open').map(workItemStableKey));
}

export function getOpenBlockerKeys(item: WorkItem, openKeys: Set<string>): WorkItemKey[] {
  return uniqueKeys(item.blockers.filter(blocker => openKeys.has(stableKey(blocker))));
}

function keysFromStableSet(keys: Set<string>, keyByStableKey: Map<string, WorkItemKey>): WorkItemKey[] {
  return [...keys].map(key => keyByStableKey.get(key)).filter((key): key is WorkItemKey => key !== undefined);
}

function detectCycles(openItems: WorkItem[], blockersByItemKey: Map<string, Set<string>>, keyByStableKey: Map<string, WorkItemKey>): WorkDependencyCycle[] {
  const cycles: WorkDependencyCycle[] = [];
  const seenCycles = new Set<string>();

  let nextIndex = 0;
  const indexes = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const stack: string[] = [];
  const stacked = new Set<string>();

  function addCycle(stableKeys: string[]): void {
    const cycleKeys = keysFromStableSet(new Set(stableKeys), keyByStableKey);
    const stableCycle = cycleKeys.map(stableKey).sort().join('|');
    if (!stableCycle || seenCycles.has(stableCycle)) return;
    seenCycles.add(stableCycle);
    cycles.push({ keys: cycleKeys });
  }

  function visit(itemKey: string): void {
    indexes.set(itemKey, nextIndex);
    lowlinks.set(itemKey, nextIndex);
    nextIndex += 1;
    stack.push(itemKey);
    stacked.add(itemKey);

    for (const blockerKey of blockersByItemKey.get(itemKey) ?? []) {
      if (!keyByStableKey.has(blockerKey)) continue;
      if (!indexes.has(blockerKey)) {
        visit(blockerKey);
        lowlinks.set(itemKey, Math.min(lowlinks.get(itemKey) ?? 0, lowlinks.get(blockerKey) ?? 0));
      } else if (stacked.has(blockerKey)) {
        lowlinks.set(itemKey, Math.min(lowlinks.get(itemKey) ?? 0, indexes.get(blockerKey) ?? 0));
      }
    }

    if (lowlinks.get(itemKey) !== indexes.get(itemKey)) return;

    const component: string[] = [];
    let currentKey: string | undefined;
    do {
      currentKey = stack.pop();
      if (!currentKey) break;
      stacked.delete(currentKey);
      component.push(currentKey);
    } while (currentKey !== itemKey);

    if (component.length > 1 || (component.length === 1 && (blockersByItemKey.get(component[0]) ?? new Set<string>()).has(component[0]))) {
      addCycle(component);
    }
  }

  for (const item of openItems) {
    const itemKey = workItemStableKey(item);
    if (!indexes.has(itemKey)) visit(itemKey);
  }

  return cycles;
}

export function buildWorkDependencyGraph(items: WorkItem[]): WorkDependencyGraph {
  const openItems = items.filter(item => item.state === 'open');
  const openKeySet = getOpenWorkItemKeys(openItems);
  const keyByStableKey = new Map(openItems.map(item => [workItemStableKey(item), item.key]));
  const blockersByItemKey = new Map<string, Set<string>>();
  const dependentsByItemKey = new Map<string, Set<string>>();

  for (const item of openItems) {
    const itemKey = workItemStableKey(item);
    blockersByItemKey.set(itemKey, blockersByItemKey.get(itemKey) ?? new Set<string>());
    dependentsByItemKey.set(itemKey, dependentsByItemKey.get(itemKey) ?? new Set<string>());
  }

  function addEdge(dependent: WorkItemKey, blocker: WorkItemKey): void {
    const dependentKey = stableKey(dependent);
    const blockerKey = stableKey(blocker);
    if (!openKeySet.has(dependentKey) || !openKeySet.has(blockerKey)) return;
    blockersByItemKey.get(dependentKey)?.add(blockerKey);
    if (dependentKey === blockerKey) return;
    dependentsByItemKey.get(blockerKey)?.add(dependentKey);
  }

  for (const item of openItems) {
    for (const blocker of item.blockers) addEdge(item.key, blocker);
    for (const dependent of item.blockedBy) addEdge(dependent, item.key);
  }

  const nodes = openItems.map(workItem => {
    const itemKey = workItemStableKey(workItem);
    const openDependentKeys = keysFromStableSet(dependentsByItemKey.get(itemKey) ?? new Set<string>(), keyByStableKey);
    return {
      workItem,
      openBlockerKeys: keysFromStableSet(blockersByItemKey.get(itemKey) ?? new Set<string>(), keyByStableKey),
      openDependentKeys,
      blocksOpenWork: openDependentKeys.length > 0,
    };
  });
  return { nodes, cycles: detectCycles(openItems, blockersByItemKey, keyByStableKey) };
}

function effectiveStatus(item: WorkItem, node: WorkDependencyNode, policy: WorkQueuePolicy): EffectiveWorkStatus {
  if (workItemIsInProgress(item, policy)) return 'InProgress';
  return node.openBlockerKeys.length > 0 ? 'Blocked' : 'Ready';
}

function itemStatusMatchesEffective(item: WorkItem, expected: WorkStatus, label: string): boolean {
  return item.status === expected || item.tags.includes(label);
}

function isDrifted(item: WorkItem, status: EffectiveWorkStatus, policy: WorkQueuePolicy): boolean {
  const labels = resolveWorkStatusLabels(policy);
  if (status === 'InProgress') return false;
  if (status === 'Ready') {
    return !itemStatusMatchesEffective(item, 'ready', labels.ready) || item.status === 'blocked' || item.tags.includes(labels.blocked);
  }
  return !itemStatusMatchesEffective(item, 'blocked', labels.blocked) || item.status === 'ready' || item.status === 'in-progress' || item.tags.includes(labels.ready) || item.tags.includes(labels.inProgress);
}

function extractTaskNumber(title: string): string | null {
  const match = title.match(/^(?:[A-Z]+)?(\d+(?:\.\d+)*)/);
  return match ? match[1] : null;
}

function priorityRank(item: WorkItem, policy: WorkQueuePolicy): number {
  const configured = policy.priorityLabels.find(label => item.tags.includes(label));
  if (configured) return policy.priorityLabels.indexOf(configured);
  const fallback = DEFAULT_PRIORITY_ORDER.indexOf(item.priority);
  return fallback >= 0 ? fallback : DEFAULT_PRIORITY_ORDER.length;
}

function milestoneRank(item: WorkItem, policy: WorkQueuePolicy): number {
  if (!policy.milestoneOrdering.enabled) return 0;
  if (!item.project) return policy.milestoneOrdering.order.length + 1;
  const index = policy.milestoneOrdering.order.indexOf(item.project.title);
  return index >= 0 ? index : policy.milestoneOrdering.order.length;
}

function numericFallback(item: WorkItem): number | null {
  return maybeWorkItemKeyNumber(item.key);
}

function compareWorkItems(left: WorkQueueItem, right: WorkQueueItem, policy: WorkQueuePolicy): number {
  const statusRank = (status: EffectiveWorkStatus): number => status === 'InProgress' ? 0 : status === 'Ready' ? 1 : 2;
  let comparison = statusRank(left.effectiveStatus) - statusRank(right.effectiveStatus);
  if (comparison !== 0) return comparison;

  comparison = priorityRank(left.workItem, policy) - priorityRank(right.workItem, policy);
  if (comparison !== 0) return comparison;

  comparison = (left.workItem.sequence ?? '').localeCompare(right.workItem.sequence ?? '', undefined, { numeric: true });
  if (comparison !== 0) return comparison;

  comparison = milestoneRank(left.workItem, policy) - milestoneRank(right.workItem, policy);
  if (comparison !== 0) return comparison;

  comparison = (extractTaskNumber(left.workItem.title) ?? '').localeCompare(extractTaskNumber(right.workItem.title) ?? '', undefined, { numeric: true });
  if (comparison !== 0) return comparison;

  const leftNumber = numericFallback(left.workItem);
  const rightNumber = numericFallback(right.workItem);
  if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber;
  return left.workItem.displayId.localeCompare(right.workItem.displayId, undefined, { numeric: true });
}

function milestoneGroupKey(item: WorkItem): string {
  return item.project ? `project:${item.project.id}:${item.project.title}` : 'project:none';
}

function buildMilestoneGroups(items: WorkQueueItem[]): WorkMilestoneGroup[] {
  const groups = new Map<string, WorkMilestoneGroup>();
  for (const item of items) {
    const key = milestoneGroupKey(item.workItem);
    const existing = groups.get(key) ?? {
      projectId: item.workItem.project?.id ?? null,
      title: item.workItem.project?.title ?? 'No milestone',
      state: item.workItem.project?.state ?? 'unknown',
      dueOn: item.workItem.project?.dueOn ?? null,
      itemKeys: [],
      progress: { totalItems: 0, inProgressCount: 0, readyCount: 0, blockedCount: 0, checklistTotal: 0, checklistCompleted: 0 },
    };
    existing.itemKeys.push(item.workItem.key);
    existing.progress.totalItems += 1;
    existing.progress.checklistTotal += item.workItem.checklist.total;
    existing.progress.checklistCompleted += item.workItem.checklist.completed;
    if (item.effectiveStatus === 'InProgress') existing.progress.inProgressCount += 1;
    if (item.effectiveStatus === 'Ready') existing.progress.readyCount += 1;
    if (item.effectiveStatus === 'Blocked') existing.progress.blockedCount += 1;
    groups.set(key, existing);
  }
  return [...groups.values()];
}

export function computeWorkQueue(items: WorkItem[], policy: WorkQueuePolicy): WorkQueueState {
  const graph = buildWorkDependencyGraph(items);
  const queueItems: WorkQueueItem[] = graph.nodes.map(node => {
    const status = effectiveStatus(node.workItem, node, policy);
    return {
      workItem: node.workItem,
      effectiveStatus: status,
      openBlockerKeys: node.openBlockerKeys,
      openDependentKeys: node.openDependentKeys,
      blocksOpenWork: node.blocksOpenWork,
      drifted: isDrifted(node.workItem, status, policy),
    };
  }).sort((left, right) => compareWorkItems(left, right, policy));

  const inProgressCount = queueItems.filter(item => item.effectiveStatus === 'InProgress').length;
  const readyCount = queueItems.filter(item => item.effectiveStatus === 'Ready').length;
  const blockedCount = queueItems.filter(item => item.effectiveStatus === 'Blocked').length;
  const driftCount = queueItems.filter(item => item.drifted).length;

  return {
    items: queueItems,
    inProgressCount,
    readyCount,
    blockedCount,
    driftCount,
    multipleInProgress: inProgressCount > 1,
    cycles: graph.cycles,
    milestoneGroups: buildMilestoneGroups(queueItems),
  };
}

export function selectNextWork(queue: WorkQueueState): NextWorkSelection {
  const inProgress = queue.items.filter(item => item.effectiveStatus === 'InProgress');
  if (inProgress.length === 1) {
    return {
      workItem: inProgress[0].workItem,
      reason: `Resuming the single active work item ${inProgress[0].workItem.displayId}`,
      multipleInProgress: false,
      driftCount: queue.driftCount,
    };
  }
  if (inProgress.length > 1) {
    return {
      workItem: null,
      reason: `Multiple active work items detected (${inProgress.length}). Fix status labels before any new or resumed work. Selection fails.`,
      multipleInProgress: true,
      driftCount: queue.driftCount,
    };
  }
  const ready = queue.items.find(item => item.effectiveStatus === 'Ready');
  if (ready) {
    return {
      workItem: ready.workItem,
      reason: `Next ready work item ${ready.workItem.displayId} (no open blockers, highest priority)`,
      multipleInProgress: false,
      driftCount: queue.driftCount,
    };
  }
  return {
    workItem: null,
    reason: 'No ready work items (queue empty or all blocked). Run the status sync command if drift exists.',
    multipleInProgress: false,
    driftCount: queue.driftCount,
  };
}

export function planStatusSyncFromWorkItems(items: WorkItem[], policy: WorkQueuePolicy): WorkStatusSyncPlan[] {
  const labels = resolveWorkStatusLabels(policy);
  const queue = computeWorkQueue(items, policy);
  const queueItemsByKey = new Map(queue.items.map(item => [workItemStableKey(item.workItem), item]));
  return items.filter(item => item.state === 'open').map(workItem => {
    const item = queueItemsByKey.get(workItemStableKey(workItem));
    if (!item) {
      throw new Error(`plan status sync failed: open work item ${workItem.displayId} was missing from the computed queue. Rebuild the queue and retry.`);
    }
    if (item.effectiveStatus === 'InProgress') {
      return {
        key: item.workItem.key,
        displayId: item.workItem.displayId,
        effectiveStatus: item.effectiveStatus,
        openBlockerKeys: item.openBlockerKeys,
        blocksOpenWork: item.blocksOpenWork,
        addLabels: [],
        removeLabels: [],
        skipped: true,
        reason: 'S-InProgress issues are never changed by deps fix',
      };
    }

    const addLabels: string[] = [];
    const removeLabels: string[] = [];
    const hasReady = item.workItem.tags.includes(labels.ready);
    const hasBlocked = item.workItem.tags.includes(labels.blocked);
    const hasBlocking = item.workItem.tags.includes(labels.blocking);

    if (item.effectiveStatus === 'Ready') {
      if (!hasReady) addLabels.push(labels.ready);
      if (hasBlocked) removeLabels.push(labels.blocked);
    } else {
      if (!hasBlocked) addLabels.push(labels.blocked);
      if (hasReady) removeLabels.push(labels.ready);
    }

    if (item.blocksOpenWork && !hasBlocking) addLabels.push(labels.blocking);
    if (!item.blocksOpenWork && hasBlocking) removeLabels.push(labels.blocking);

    for (const label of labels.all) {
      if (label !== labels.ready && label !== labels.blocked && label !== labels.blocking && item.workItem.tags.includes(label)) {
        removeLabels.push(label);
      }
    }

    return {
      key: item.workItem.key,
      displayId: item.workItem.displayId,
      effectiveStatus: item.effectiveStatus,
      openBlockerKeys: item.openBlockerKeys,
      blocksOpenWork: item.blocksOpenWork,
      addLabels: [...new Set(addLabels)],
      removeLabels: [...new Set(removeLabels)],
      skipped: false,
    };
  });
}

export function createWorkStatusSyncActionPlan(items: WorkItem[], policy: WorkQueuePolicy): ActionPlan {
  const actions: Action[] = [];
  for (const plan of planStatusSyncFromWorkItems(items, policy)) {
    if (plan.skipped || (plan.addLabels.length === 0 && plan.removeLabels.length === 0)) continue;
    actions.push(createAction({
      id: `replace-status-labels:${plan.key.providerId}:${plan.key.id}`,
      kind: 'replace-status-labels',
      target: { kind: 'work-item', id: plan.key.id },
      mutation: 'work-provider',
      description: `Synchronize dependency status labels for ${plan.displayId}`,
      expectedResult: `${plan.displayId} has provider labels synchronized with Executor work state.`,
      details: {
        providerId: plan.key.providerId,
        workItemId: plan.key.id,
        displayId: plan.displayId,
        effectiveStatus: plan.effectiveStatus,
        addLabels: plan.addLabels,
        removeLabels: plan.removeLabels,
      },
    }));
  }
  return createActionPlan({
    id: 'work:status-sync',
    purpose: 'Synchronize work status labels from provider-neutral work state.',
    dryRun: true,
    actions,
  });
}
