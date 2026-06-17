const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  buildWorkDependencyGraph,
  computeWorkQueue,
  createWorkStatusSyncActionPlan,
  planStatusSyncFromWorkItems,
  selectNextWork,
} = require('../dist/core/queue_rules.js');

const policy = {
  priorityLabels: ['P1-Critical', 'P2-High', 'P3-Medium', 'P4-Low'],
  statusLabels: ['S-Ready', 'S-InProgress', 'S-Blocked', 'S-Blocking'],
  milestoneOrdering: { enabled: false, order: [], missingAssignment: 'warn' },
};

function key(id) {
  return { providerId: 'test', id: String(id) };
}

function item(id, overrides = {}) {
  const tags = overrides.tags ?? [];
  return {
    key: key(id),
    displayId: `W-${id}`,
    title: overrides.title ?? `Work ${id}`,
    body: '',
    url: null,
    state: overrides.state ?? 'open',
    status: overrides.status ?? 'unknown',
    priority: overrides.priority ?? 'none',
    tags,
    assignees: [],
    project: overrides.project ?? null,
    blockers: (overrides.blockers ?? []).map(key),
    blockedBy: (overrides.blockedBy ?? []).map(key),
    sequence: overrides.sequence ?? null,
    checklist: overrides.checklist ?? { total: 0, completed: 0 },
    trustedMetadata: {},
    source: { providerId: 'test', resourceKind: 'work-item', resourceId: String(id), url: null, metadata: {} },
  };
}

describe('provider-neutral queue rules', () => {
  it('resumes the single active item before choosing ready work', () => {
    const queue = computeWorkQueue([
      item(1, { status: 'ready', priority: 'critical', tags: ['S-Ready'] }),
      item(2, { status: 'in-progress', priority: 'low', tags: ['S-InProgress'] }),
    ], policy);
    const next = selectNextWork(queue);

    assert.equal(queue.inProgressCount, 1);
    assert.equal(next.workItem.key.id, '2');
    assert.equal(next.multipleInProgress, false);
  });

  it('filters closed blockers out of effective blocked-state decisions', () => {
    const queue = computeWorkQueue([
      item(1, { state: 'closed', status: 'blocked', tags: ['S-Blocked'] }),
      item(2, { status: 'ready', tags: ['S-Ready'], blockers: [1] }),
    ], policy);

    assert.equal(queue.items.length, 1);
    assert.equal(queue.items[0].workItem.key.id, '2');
    assert.equal(queue.items[0].effectiveStatus, 'Ready');
    assert.deepEqual(queue.items[0].openBlockerKeys, []);
  });

  it('computes blocked queue state and dependency cycles from blocker metadata', () => {
    const queue = computeWorkQueue([
      item(1, { status: 'ready', tags: ['S-Ready'], blockers: [2] }),
      item(2, { status: 'ready', tags: ['S-Ready'], blockers: [1] }),
    ], policy);
    const graph = buildWorkDependencyGraph(queue.items.map(queueItem => queueItem.workItem));

    assert.equal(queue.readyCount, 0);
    assert.equal(queue.blockedCount, 2);
    assert.equal(queue.cycles.length, 1);
    assert.deepEqual(graph.cycles[0].keys.map(cycleKey => cycleKey.id).sort(), ['1', '2']);
  });

  it('reports independent dependency cycles without enumerating every path', () => {
    const queue = computeWorkQueue([
      item(1, { status: 'ready', tags: ['S-Ready'], blockers: [2] }),
      item(2, { status: 'ready', tags: ['S-Ready'], blockers: [1] }),
      item(3, { status: 'ready', tags: ['S-Ready'], blockers: [4] }),
      item(4, { status: 'ready', tags: ['S-Ready'], blockers: [5] }),
      item(5, { status: 'ready', tags: ['S-Ready'], blockers: [3] }),
      item(6, { status: 'ready', tags: ['S-Ready'], blockers: [1, 3] }),
    ], policy);

    const cycleIds = queue.cycles.map(cycle => cycle.keys.map(cycleKey => cycleKey.id).sort());

    assert.deepEqual(cycleIds.sort((left, right) => left.length - right.length), [['1', '2'], ['3', '4', '5']]);
  });

  it('keeps self-dependencies blocked and cyclic without marking them as blocking other work', () => {
    const queue = computeWorkQueue([
      item(1, { status: 'blocked', tags: ['S-Blocked'], blockers: [1] }),
    ], policy);
    const only = queue.items[0];

    assert.equal(only.effectiveStatus, 'Blocked');
    assert.equal(only.blocksOpenWork, false);
    assert.deepEqual(queue.cycles[0].keys, [key(1)]);
    assert.deepEqual(planStatusSyncFromWorkItems([only.workItem], policy)[0].addLabels, []);
  });

  it('uses normalized blockedBy metadata when providers supply reverse edges', () => {
    const queue = computeWorkQueue([
      item(1, { status: 'ready', tags: ['S-Ready'], blockedBy: [2] }),
      item(2, { status: 'ready', tags: ['S-Ready'] }),
    ], policy);

    const blocker = queue.items.find(queueItem => queueItem.workItem.key.id === '1');
    assert.equal(blocker.blocksOpenWork, true);
    assert.deepEqual(blocker.openDependentKeys, [key(2)]);

    const plans = planStatusSyncFromWorkItems(queue.items.map(queueItem => queueItem.workItem), policy);
    assert.deepEqual(plans.find(plan => plan.key.id === '1').addLabels, ['S-Blocking']);
  });

  it('respects configured status labels in provider-neutral status decisions', () => {
    const customPolicy = {
      ...policy,
      statusLabels: ['Ready', 'Doing', 'Blocked', 'Blocking'],
    };
    const queue = computeWorkQueue([
      item(1, { status: 'unknown', tags: ['Doing'] }),
      item(2, { status: 'unknown', tags: ['Ready'], blockers: [1] }),
    ], customPolicy);

    assert.equal(queue.items.find(queueItem => queueItem.workItem.key.id === '1').effectiveStatus, 'InProgress');
    assert.equal(queue.items.find(queueItem => queueItem.workItem.key.id === '2').effectiveStatus, 'Blocked');
  });

  it('sorts sequence metadata with numeric collation', () => {
    const queue = computeWorkQueue([
      item(10, { status: 'ready', tags: ['S-Ready'], priority: 'high', sequence: '10' }),
      item(2, { status: 'ready', tags: ['S-Ready'], priority: 'high', sequence: '2' }),
    ], policy);

    assert.deepEqual(queue.items.map(queueItem => queueItem.workItem.key.id), ['2', '10']);
  });

  it('orders by milestone policy and exposes milestone progress groups', () => {
    const milestonePolicy = {
      ...policy,
      milestoneOrdering: { enabled: true, order: ['Alpha', 'Beta'], missingAssignment: 'warn' },
    };
    const queue = computeWorkQueue([
      item(3, { status: 'ready', tags: ['S-Ready'], priority: 'high', project: { id: '2', title: 'Beta', state: 'open', dueOn: null }, checklist: { total: 2, completed: 1 } }),
      item(2, { status: 'ready', tags: ['S-Ready'], priority: 'high', project: { id: '1', title: 'Alpha', state: 'open', dueOn: '2026-06-01' }, checklist: { total: 1, completed: 1 } }),
    ], milestonePolicy);

    assert.deepEqual(queue.items.map(queueItem => queueItem.workItem.key.id), ['2', '3']);
    const alpha = queue.milestoneGroups.find(group => group.title === 'Alpha');
    assert.equal(alpha.progress.totalItems, 1);
    assert.equal(alpha.progress.checklistCompleted, 1);
  });

  it('reports no-ready-work states when all open work is blocked', () => {
    const queue = computeWorkQueue([
      item(1, { status: 'blocked', tags: ['S-Blocked'], blockers: [2] }),
      item(2, { status: 'blocked', tags: ['S-Blocked'], blockers: [1] }),
    ], policy);
    const next = selectNextWork(queue);

    assert.equal(queue.readyCount, 0);
    assert.equal(next.workItem, null);
    assert.match(next.reason, /No ready work items/);
  });

  it('creates provider-neutral status sync plans without provider-specific issue details', () => {
    const plans = planStatusSyncFromWorkItems([
      item(1, { status: 'ready', tags: ['S-Ready'], blockers: [2] }),
      item(2, { status: 'in-progress', tags: ['S-InProgress'] }),
    ], policy);
    const actionPlan = createWorkStatusSyncActionPlan([
      item(1, { status: 'ready', tags: ['S-Ready'], blockers: [2] }),
      item(2, { status: 'in-progress', tags: ['S-InProgress'] }),
    ], policy);

    assert.deepEqual(plans.find(plan => plan.key.id === '1').addLabels, ['S-Blocked']);
    assert.deepEqual(plans.find(plan => plan.key.id === '1').removeLabels, ['S-Ready']);
    assert.equal(plans.find(plan => plan.key.id === '2').skipped, true);
    assert.equal('issueNumber' in actionPlan.actions[0].details, false);
  });
});
