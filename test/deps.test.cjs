const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { getDefaults } = require('../dist/config/index.js');

describe('deps topic and blockers command module', () => {
  it('publishes deps topic metadata through the shared registry', () => {
    const { getCommandMetadata } = require('../dist/command_metadata.js');
    const deps = getCommandMetadata('deps');
    assert.ok(deps.description.includes('Inspect the dependency graph'));
    assert.ok(deps.examples.some((e) => e.includes('deps blockers 93')));
  });

  it('publishes deps blockers metadata through the shared registry', () => {
    const { getCommandMetadata } = require('../dist/command_metadata.js');
    const depsBlockers = getCommandMetadata('deps blockers');
    assert.ok(depsBlockers.description.includes('List direct blockers for an issue'));
    assert.deepEqual(depsBlockers.args, ['issue']);
    assert.ok(depsBlockers.flags.includes('--json'));
    assert.ok(depsBlockers.examples.some((e) => e.includes('deps blockers #93')));
  });
});

// Note: Full GhExec fixture tests for the deps commands (success, #93 support, closed blockers, malformed lines, json output, error on invalid number, cycles)
// are covered in the service logic and will be expanded with makeFixtureExec for 'issue view'/'list' calls in follow-up work.
// The parser (parseDeclaredBlockers) is already tested in github.test.js (line-based, mid-line ignore, dedup+sort, malformed ignored without crash).

describe('computeStatusFixPlan (status label sync from live graph)', () => {
  const { computeStatusFixPlan, computeStatusFixPlanFromWorkItems } = require('../dist/deps.js');

  function makeIssue(n, labels, blockers = []) {
    return {
      number: n,
      title: `Issue ${n}`,
      state: 'OPEN',
      labels,
      declaredBlockers: blockers,
    };
  }

  it('skips S-InProgress issues and never plans changes for them', () => {
    const issues = [makeIssue(10, ['S-InProgress', 'S-Ready'], [])];
    const plans = computeStatusFixPlan(issues);
    assert.strictEqual(plans.length, 1);
    assert.strictEqual(plans[0].skipped, true);
    assert.ok(plans[0].reason.includes('S-InProgress issues are never changed'));
    assert.deepStrictEqual(plans[0].add, []);
    assert.deepStrictEqual(plans[0].remove, []);
  });

  it('plans add S-Ready for effective Ready with no labels', () => {
    const issues = [makeIssue(20, [], [])];
    const plans = computeStatusFixPlan(issues);
    assert.strictEqual(plans[0].skipped, false);
    assert.deepStrictEqual(plans[0].add, ['S-Ready']);
    assert.deepStrictEqual(plans[0].remove, []);
  });

  it('plans add S-Blocked + remove S-Ready for effective Blocked', () => {
    const issues = [
      makeIssue(30, ['S-Ready'], [99]),
      makeIssue(99, ['S-InProgress'], []),
    ];
    const plans = computeStatusFixPlan(issues);
    const p30 = plans.find(p => p.issueNumber === 30);
    assert.deepStrictEqual(p30.add, ['S-Blocked']);
    assert.deepStrictEqual(p30.remove, ['S-Ready']);
  });

  it('adds S-Blocking for Ready issue that blocks others; removes when no longer blocking', () => {
    const issues = [
      makeIssue(40, ['S-Ready'], []),
      makeIssue(50, [], [40]), // 40 blocks 50
    ];
    let plans = computeStatusFixPlan(issues);
    const p40 = plans.find(p => p.issueNumber === 40);
    assert.ok(p40.add.includes('S-Blocking'));

    // Now remove the dependent
    const issues2 = [makeIssue(40, ['S-Ready', 'S-Blocking'], [])];
    plans = computeStatusFixPlan(issues2);
    const p40b = plans.find(p => p.issueNumber === 40);
    assert.ok(p40b.remove.includes('S-Blocking'));
  });

  it('does not count self-referential blockers as blocking other work', () => {
    const plans = computeStatusFixPlan([makeIssue(90, ['S-Blocked'], [90])]);
    const p90 = plans.find(p => p.issueNumber === 90);

    assert.equal(p90.add.includes('S-Blocking'), false);
  });

  it('deduplicates add/remove labels and produces stable plans', () => {
    const issues = [makeIssue(60, ['S-Ready'], [])];
    const plans = computeStatusFixPlan(issues);
    assert.deepStrictEqual(plans[0].add, []);
    assert.deepStrictEqual(plans[0].remove, []);
  });

  it('honors custom status labels for issue-like compatibility inputs', () => {
    const plans = computeStatusFixPlan([
      makeIssue(70, ['Doing'], []),
      makeIssue(71, ['Ready'], [70]),
    ], {
      priorityLabels: ['P1-Critical', 'P2-High', 'P3-Medium', 'P4-Low'],
      statusLabels: ['Ready', 'Doing', 'Blocked', 'Blocking'],
      milestoneOrdering: { enabled: false, order: [], missingAssignment: 'warn' },
    });

    const p70 = plans.find(p => p.issueNumber === 70);
    const p71 = plans.find(p => p.issueNumber === 71);

    assert.equal(p70.skipped, true);
    assert.deepStrictEqual(p71.add, ['Blocked']);
    assert.deepStrictEqual(p71.remove, ['Ready']);
  });

  it('resolves canonical status labels when policy labels are not in default order', () => {
    const plans = computeStatusFixPlan([
      makeIssue(72, ['S-InProgress'], []),
      makeIssue(73, ['S-Ready'], [72]),
    ], {
      priorityLabels: ['P1-Critical', 'P2-High', 'P3-Medium', 'P4-Low'],
      statusLabels: ['S-InProgress', 'S-Ready', 'S-Blocked', 'S-Blocking'],
      milestoneOrdering: { enabled: false, order: [], missingAssignment: 'warn' },
    });

    const p72 = plans.find(p => p.issueNumber === 72);
    const p73 = plans.find(p => p.issueNumber === 73);

    assert.equal(p72.skipped, true);
    assert.deepStrictEqual(p73.add, ['S-Blocked']);
    assert.deepStrictEqual(p73.remove, ['S-Ready']);
  });

  it('computes status fixes directly from provider-neutral work items', () => {
    const plans = computeStatusFixPlanFromWorkItems([
      {
        key: { providerId: 'github', id: '80' },
        displayId: '#80',
        title: 'Provider item',
        body: '',
        url: null,
        state: 'open',
        status: 'ready',
        priority: 'none',
        tags: ['S-Ready'],
        assignees: [],
        project: null,
        blockers: [{ providerId: 'github', id: '81' }],
        blockedBy: [],
        sequence: null,
        checklist: { total: 0, completed: 0 },
        trustedMetadata: { githubIssueNumber: 80 },
        source: { providerId: 'github', resourceKind: 'work-item', resourceId: '80', url: null, metadata: { githubIssueNumber: 80 } },
      },
      {
        key: { providerId: 'github', id: '81' },
        displayId: '#81',
        title: 'Open blocker',
        body: '',
        url: null,
        state: 'open',
        status: 'in-progress',
        priority: 'none',
        tags: ['S-InProgress'],
        assignees: [],
        project: null,
        blockers: [],
        blockedBy: [{ providerId: 'github', id: '80' }],
        sequence: null,
        checklist: { total: 0, completed: 0 },
        trustedMetadata: { githubIssueNumber: 81 },
        source: { providerId: 'github', resourceKind: 'work-item', resourceId: '81', url: null, metadata: { githubIssueNumber: 81 } },
      },
    ]);

    const p80 = plans.find(p => p.issueNumber === 80);
    assert.deepStrictEqual(p80.add, ['S-Blocked']);
    assert.deepStrictEqual(p80.remove, ['S-Ready']);
  });
});

describe('dependency graph service', () => {
  const { getAllBlockedIssues, getDependencyGraph } = require('../dist/deps.js');

  function success(args, stdout = '') {
    return { args, exitCode: 0, stdout, stderr: '' };
  }

  it('preserves declared blocker metadata while reporting open dependency cycles', async () => {
    const issueList = [
      { number: 1, title: 'One', body: 'Blocked by: #2\nBlocked by: #99', state: 'OPEN', labels: [], assignees: [], milestone: null, url: '' },
      { number: 2, title: 'Two', body: 'Blocked by: #1', state: 'OPEN', labels: [], assignees: [], milestone: null, url: '' },
    ];
    const exec = async (args) => {
      if (args.join(' ') === 'issue list --state open --json number,title,state,labels,assignees,body,milestone,url --limit 1000') {
        return success(args, JSON.stringify(issueList));
      }
      return { args, exitCode: 1, stdout: '', stderr: `unexpected gh call: ${args.join(' ')}` };
    };

    const graph = await getDependencyGraph({ exec });

    assert.deepEqual(graph.blockers[1], [2, 99]);
    assert.deepEqual(graph.blockers[2], [1]);
    assert.deepEqual(graph.cycles[0].sort(), [1, 2]);
  });

  it('resolves blocked issue details from already listed open items', async () => {
    const calls = [];
    const issueList = [
      { number: 1, title: 'One', body: 'Blocked by: #2', state: 'OPEN', labels: [], assignees: [], milestone: null, url: '' },
      { number: 2, title: 'Two', body: '', state: 'OPEN', labels: [], assignees: [], milestone: null, url: '' },
    ];
    const exec = async (args) => {
      calls.push(args.join(' '));
      if (args.join(' ') === 'issue list --state open --json number,title,state,labels,assignees,body,milestone,url --limit 1000') {
        return success(args, JSON.stringify(issueList));
      }
      return { args, exitCode: 1, stdout: '', stderr: `unexpected gh call: ${args.join(' ')}` };
    };

    const blocked = await getAllBlockedIssues({ exec });

    assert.deepEqual(blocked, [{ number: 1, title: 'One', state: 'OPEN', blockers: [{ number: 2, title: 'Two', state: 'OPEN' }] }]);
    assert.equal(calls.some(call => call.startsWith('issue view ')), false);
  });
});

describe('deps fix result reporting', () => {
  const { formatStatusFixError, getStatusFixExitCode, mergeStatusFixPlanActions, summarizeStatusFixResults } = require('../dist/runtime_deps_fix.js');

  it('marks summaries as failed when any per-issue label edit fails', () => {
    const results = [
      { issueNumber: 70, changed: true, add: ['S-Ready'], remove: [], skipped: false, failed: false },
      { issueNumber: 71, changed: false, add: ['S-Blocked'], remove: ['S-Ready'], skipped: false, failed: true, error: 'failed' },
      { issueNumber: 72, changed: false, add: [], remove: [], skipped: true, failed: false, reason: 'S-InProgress issues are never changed by deps fix' },
    ];

    const summary = summarizeStatusFixResults(results);

    assert.equal(summary.ok, false);
    assert.equal(summary.failureCount, 1);
    assert.equal(summary.changedCount, 1);
    assert.equal(summary.skippedCount, 1);
    assert.equal(summary.failures[0].issueNumber, 71);
    assert.equal(getStatusFixExitCode(summary), 1);
  });

  it('keeps successful summaries machine-detectable as success', () => {
    const summary = summarizeStatusFixResults([
      { issueNumber: 74, changed: true, add: ['S-Ready'], remove: [], skipped: false, failed: false },
    ]);

    assert.equal(summary.ok, true);
    assert.equal(getStatusFixExitCode(summary), 0);
  });

  it('formats label sync errors with operation, cause, and next action', () => {
    const message = formatStatusFixError(73, new Error('permission denied'));

    assert.match(message, /Failed to synchronize labels for issue #73/);
    assert.match(message, /permission denied/);
    assert.match(message, /rerun `aie deps fix --dry-run`/);
  });

  it('reports provider-planned actions even when the compatibility planner has no-op output', () => {
    const merged = mergeStatusFixPlanActions([
      { issueNumber: 80, add: [], remove: [], skipped: false },
    ], {
      id: 'github:status-sync',
      purpose: 'Synchronize GitHub issue status labels from provider-neutral work state.',
      dryRun: true,
      summary: { plannedCount: 2, completedCount: 0, failedCount: 0, skippedCount: 0 },
      actions: [
        {
          id: 'replace-status-labels:80',
          kind: 'replace-status-labels',
          target: { kind: 'work-item', id: '80' },
          mutation: 'work-provider',
          description: 'Synchronize dependency status labels for #80',
          preconditions: [],
          expectedResult: 'Issue #80 has provider labels synchronized with Executor work state.',
          status: 'planned',
          details: { issueNumber: 80, addLabels: ['S-Ready'], removeLabels: ['Custom-Status'] },
          failure: null,
        },
        {
          id: 'replace-status-labels:81',
          kind: 'replace-status-labels',
          target: { kind: 'work-item', id: '81' },
          mutation: 'work-provider',
          description: 'Synchronize dependency status labels for #81',
          preconditions: [],
          expectedResult: 'Issue #81 has provider labels synchronized with Executor work state.',
          status: 'planned',
          details: { issueNumber: 81, addLabels: ['S-Blocked'], removeLabels: [] },
          failure: null,
        },
      ],
    });

    assert.deepEqual(merged.find(plan => plan.issueNumber === 80).add, ['S-Ready']);
    assert.deepEqual(merged.find(plan => plan.issueNumber === 80).remove, ['Custom-Status']);
    assert.deepEqual(merged.find(plan => plan.issueNumber === 81).add, ['S-Blocked']);
  });
});

describe('deps schema metadata', () => {
  it('marks the deps topic read-only and deps fix mutating', () => {
    const { getImplementedCommands } = require('../dist/command_metadata.js');
    const commands = getImplementedCommands();
    const depsTopic = commands.find(c => c.name === 'deps');
    const depsFix = commands.find(c => c.name === 'deps fix');

    assert.equal(depsTopic.mutates, false);
    assert.equal(depsFix.mutates, true);
  });

  it('publishes deps blocked as an argument-free command', () => {
    const { getImplementedCommands } = require('../dist/command_metadata.js');
    const commands = getImplementedCommands();
    const depsBlocked = commands.find(c => c.name === 'deps blocked');

    assert.deepStrictEqual(depsBlocked.args, []);
    assert.deepStrictEqual(depsBlocked.examples, ['aie deps blocked']);
  });
});
