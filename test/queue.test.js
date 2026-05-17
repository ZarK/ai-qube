const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { computeQueue, computeQueueFromIssues, getNextIssue } = require('../dist/queue/index.js');

const sampleOpenIssues = [
  {
    number: 10,
    title: '9.1 High priority ready',
    body: 'Sequence: auth-v2\nBlocked by: #5',
    state: 'OPEN',
    labels: ['P1-Critical', 'S-Ready'],
    declaredBlockers: [5],
    milestone: { number: 2, title: 'Q3', state: 'OPEN', dueOn: '2026-09-01' },
    url: 'https://github.com/example/repo/issues/10',
  },
  {
    number: 11,
    title: 'Low priority in progress',
    body: '',
    state: 'OPEN',
    labels: ['P4-Low', 'S-InProgress'],
    declaredBlockers: [],
    milestone: null,
    url: 'https://github.com/example/repo/issues/11',
  },
  {
    number: 12,
    title: 'Blocked with open blocker',
    body: 'Blocked by: #11',
    state: 'OPEN',
    labels: ['P2-High', 'S-Ready'],
    declaredBlockers: [11],
    milestone: { number: 2, title: 'Q3', state: 'OPEN', dueOn: '2026-09-01' },
    url: 'https://github.com/example/repo/issues/12',
  },
  {
    number: 13,
    title: 'Another in progress (multiple)',
    body: '',
    state: 'OPEN',
    labels: ['P3-Medium', 'S-InProgress'],
    declaredBlockers: [],
    milestone: null,
    url: 'https://github.com/example/repo/issues/13',
  },
];

describe('queue service (computeQueue + getNextIssue via GhExec fixtures)', () => {
  function makeIssue(n, labels, blockers = []) {
    return {
      number: n,
      title: `Issue ${n}`,
      body: '',
      state: 'OPEN',
      labels,
      declaredBlockers: blockers,
    };
  }

  it('computes effective status, drift, multipleInProgress, and ordering (priority > sequence > task# > issue#)', async () => {
    const mod = require('../dist/queue/index.js');
    const q = computeQueueFromIssues(sampleOpenIssues);

    assert.ok(typeof mod.computeQueue === 'function');
    assert.ok(typeof mod.getNextIssue === 'function');
    assert.equal(q.inProgressCount, 2);
    assert.equal(q.readyCount, 1);
    assert.equal(q.blockedCount, 1);
    assert.equal(q.multipleInProgress, true);
    assert.deepEqual(q.items.map(item => item.issue.number), [13, 11, 10, 12]);
    assert.equal(q.items.find(item => item.issue.number === 12).effectiveStatus, 'Blocked');
    assert.deepEqual(q.items.find(item => item.issue.number === 12).openBlockers, [11]);
    assert.deepEqual(q.items.find(item => item.issue.number === 10).workItem.key, { providerId: 'github', id: '10' });
    assert.deepEqual(q.items.find(item => item.issue.number === 10).workItem.blockers, [{ providerId: 'github', id: '5' }]);
  });

  it('detects drift when blocked issues are missing S-Blocked or ready issues still have S-Blocked', () => {
    const q = computeQueueFromIssues([
      makeIssue(1, ['S-Ready'], [2]),
      makeIssue(2, ['S-Ready', 'S-Blocked'], []),
    ]);

    const blocked = q.items.find(i => i.issue.number === 1);
    const ready = q.items.find(i => i.issue.number === 2);

    assert.equal(blocked.effectiveStatus, 'Blocked');
    assert.equal(blocked.drifted, true);
    assert.equal(ready.effectiveStatus, 'Ready');
    assert.equal(ready.drifted, true);
    assert.equal(q.driftCount, 2);
  });

  it('exposes enough state for callers to block selection on multiple active issues', () => {
    const q = computeQueueFromIssues(sampleOpenIssues);
    const activeIssues = q.items.filter(item => item.effectiveStatus === 'InProgress');

    assert.equal(q.multipleInProgress, true);
    assert.deepEqual(activeIssues.map(item => item.issue.number), [13, 11]);
  });

  it('orders ready issues by priority, sequence metadata, title number, and issue number', () => {
    const q = computeQueueFromIssues([
      makeIssue(30, ['P3-Medium', 'S-Ready']),
      { ...makeIssue(21, ['P2-High', 'S-Ready']), body: 'Sequence: beta', title: '2.1 Later sequence' },
      { ...makeIssue(22, ['P2-High', 'S-Ready']), body: 'Sequence: alpha', title: '2.1 Lower issue tie-break' },
      { ...makeIssue(23, ['P2-High', 'S-Ready']), body: 'Sequence: alpha', title: '2.1 Lower issue tie-break' },
    ]);

    assert.deepEqual(q.items.map(item => item.issue.number), [22, 23, 21, 30]);
  });

  it('selects next work through the lifecycle application service', async () => {
    const { createLifecycleContext } = require('../dist/app/lifecycle_services.js');
    const { runNextWorkService } = require('../dist/app/next_work.js');
    const { getDefaults } = require('../dist/config/index.js');
    const exec = async (args) => {
      const key = args.join(' ');
      if (key === 'issue list --state open --json number,title,state,labels,body,milestone,url --limit 100') {
        return { args, exitCode: 0, stdout: JSON.stringify([
          { number: 22, title: 'Issue 22', body: '', state: 'OPEN', labels: [{ name: 'S-Ready' }], milestone: null, url: 'https://github.com/example/repo/issues/22' },
          { number: 21, title: 'Issue 21', body: '', state: 'OPEN', labels: [{ name: 'S-InProgress' }], milestone: null, url: 'https://github.com/example/repo/issues/21' },
        ]), stderr: '' };
      }
      return { args, exitCode: 1, stdout: '', stderr: `unexpected gh call: ${key}` };
    };

    const result = await runNextWorkService(await createLifecycleContext({ exec, config: getDefaults() }));

    assert.equal(result.workItem.key.id, '21');
    assert.equal(result.reason, 'Resuming the single active S-InProgress issue #21');
    assert.equal(result.multipleInProgress, false);
  });
});
