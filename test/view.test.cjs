const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

function makeFixtureExec(responses) {
  return async (args) => {
    const key = args.join(' ');
    if (responses[key]) {
      return responses[key];
    }
    return { args, exitCode: 1, stdout: '', stderr: 'unexpected gh call in test fixture' };
  };
}

function sampleIssueJson(number, title, state, labels, body, milestone = null) {
  return JSON.stringify({
    number,
    title,
    body,
    state,
    labels: labels.map(name => ({ name })),
    milestone,
    url: `https://github.com/example/repo/issues/${number}`,
  });
}

describe('view service', () => {
  const { viewIssue, suggestBranchName } = require('../dist/view.js');

  it('returns full context for a ready issue with no blockers', async () => {
    const exec = makeFixtureExec({
      'issue view 93 --json number,title,state,labels,body,milestone,url': {
        args: ['issue', 'view', '93', '--json', 'number,title,state,labels,body,milestone,url'],
        exitCode: 0,
        stdout: sampleIssueJson(93, 'Add view command', 'OPEN', ['P2-High', 'S-Ready', 'C-Tooling'], 'Body text.', null),
        stderr: '',
      },
      'issue list --state open --json number,title,state,labels,body,milestone,url --limit 1000': {
        args: ['issue', 'list', '--state', 'open', '--json', 'number,title,state,labels,body,milestone,url', '--limit', '1000'],
        exitCode: 0,
        stdout: '[]',
        stderr: '',
      },
    });

    const result = await viewIssue(93, { exec });
    assert.equal(result.ok, true);
    assert.equal(result.issue.number, 93);
    assert.equal(result.issue.effectiveStatus, 'Ready');
    assert.equal(result.issue.priority, 'P2-High');
    assert.equal(result.issue.statusLabel, 'S-Ready');
    assert.deepEqual(result.issue.componentLabels, ['C-Tooling']);
    assert.equal(result.dependency.blockers.length, 0);
    assert.equal(result.dependency.dependents.length, 0);
    assert.equal(result.checklist.total, 0);
    assert.equal(result.branch.suggested, 'issue/93-add-view-command');
    assert.ok(result.recommendedAction.includes('aie next --json'));
  });

  it('ignores non-configured labels that share managed prefixes', async () => {
    const exec = makeFixtureExec({
      'issue view 93 --json number,title,state,labels,body,milestone,url': {
        args: ['issue', 'view', '93', '--json', 'number,title,state,labels,body,milestone,url'],
        exitCode: 0,
        stdout: sampleIssueJson(93, 'Add view command', 'OPEN', ['Performance', 'S-Experimental', 'C-Custom', 'S-Ready'], '', null),
        stderr: '',
      },
      'issue list --state open --json number,title,state,labels,body,milestone,url --limit 1000': {
        args: ['issue', 'list', '--state', 'open', '--json', 'number,title,state,labels,body,milestone,url', '--limit', '1000'],
        exitCode: 0,
        stdout: '[]',
        stderr: '',
      },
    });

    const result = await viewIssue(93, { exec });

    assert.equal(result.issue.priority, null);
    assert.equal(result.issue.statusLabel, 'S-Ready');
    assert.deepEqual(result.issue.componentLabels, []);
  });

  it('returns blocked status when open blockers exist', async () => {
    const exec = makeFixtureExec({
      'issue view 93 --json number,title,state,labels,body,milestone,url': {
        args: ['issue', 'view', '93', '--json', 'number,title,state,labels,body,milestone,url'],
        exitCode: 0,
        stdout: sampleIssueJson(93, 'Add view command', 'OPEN', ['S-Ready'], 'Blocked by: #17\nBlocked by: #23'),
        stderr: '',
      },
      'issue view 17 --json number,title,state,labels,body,milestone,url': {
        args: ['issue', 'view', '17', '--json', 'number,title,state,labels,body,milestone,url'],
        exitCode: 0,
        stdout: sampleIssueJson(17, 'Old blocker', 'OPEN', ['S-InProgress'], ''),
        stderr: '',
      },
      'issue view 23 --json number,title,state,labels,body,milestone,url': {
        args: ['issue', 'view', '23', '--json', 'number,title,state,labels,body,milestone,url'],
        exitCode: 0,
        stdout: sampleIssueJson(23, 'Closed blocker', 'CLOSED', [], ''),
        stderr: '',
      },
      'issue list --state open --json number,title,state,labels,body,milestone,url --limit 1000': {
        args: ['issue', 'list', '--state', 'open', '--json', 'number,title,state,labels,body,milestone,url', '--limit', '1000'],
        exitCode: 0,
        stdout: '[]',
        stderr: '',
      },
    });

    const result = await viewIssue(93, { exec });
    assert.equal(result.issue.effectiveStatus, 'Blocked');
    assert.deepEqual(result.dependency.declaredBlockers, [17, 23]);
    assert.deepEqual(result.dependency.openBlockers, [17]);
    assert.deepEqual(result.dependency.unresolvedBlockers, []);
    assert.equal(result.dependency.blockers.length, 2);
    assert.equal(result.dependency.blockers[0].state, 'OPEN');
    assert.equal(result.dependency.blockers[1].state, 'CLOSED');
    assert.ok(result.recommendedAction.includes('Do not start'));
  });

  it('returns closed status and appropriate action for closed issues', async () => {
    const exec = makeFixtureExec({
      'issue view 93 --json number,title,state,labels,body,milestone,url': {
        args: ['issue', 'view', '93', '--json', 'number,title,state,labels,body,milestone,url'],
        exitCode: 0,
        stdout: sampleIssueJson(93, 'Add view command', 'CLOSED', [], ''),
        stderr: '',
      },
      'issue list --state open --json number,title,state,labels,body,milestone,url --limit 1000': {
        args: ['issue', 'list', '--state', 'open', '--json', 'number,title,state,labels,body,milestone,url', '--limit', '1000'],
        exitCode: 0,
        stdout: '[]',
        stderr: '',
      },
    });

    const result = await viewIssue(93, { exec });
    assert.equal(result.issue.state, 'CLOSED');
    assert.equal(result.issue.effectiveStatus, 'Closed');
    assert.ok(result.recommendedAction.includes('aie deps blocking 93'));
  });

  it('parses checklist from markdown task list checkboxes', async () => {
    const exec = makeFixtureExec({
      'issue view 93 --json number,title,state,labels,body,milestone,url': {
        args: ['issue', 'view', '93', '--json', 'number,title,state,labels,body,milestone,url'],
        exitCode: 0,
        stdout: sampleIssueJson(93, 'Add view command', 'OPEN', ['S-Ready'], '- [x] Task A\n- [ ] Task B\n- [ ] Task C'),
        stderr: '',
      },
      'issue list --state open --json number,title,state,labels,body,milestone,url --limit 1000': {
        args: ['issue', 'list', '--state', 'open', '--json', 'number,title,state,labels,body,milestone,url', '--limit', '1000'],
        exitCode: 0,
        stdout: '[]',
        stderr: '',
      },
    });

    const result = await viewIssue(93, { exec });
    assert.equal(result.checklist.total, 3);
    assert.equal(result.checklist.checked, 1);
    assert.equal(result.checklist.unchecked, 2);
    assert.deepEqual(result.checklist.items, ['Task A', 'Task B', 'Task C']);
  });

  it('warns when another issue is in progress', async () => {
    const exec = makeFixtureExec({
      'issue view 93 --json number,title,state,labels,body,milestone,url': {
        args: ['issue', 'view', '93', '--json', 'number,title,state,labels,body,milestone,url'],
        exitCode: 0,
        stdout: sampleIssueJson(93, 'Add view command', 'OPEN', ['S-Ready'], ''),
        stderr: '',
      },
      'issue list --state open --json number,title,state,labels,body,milestone,url --limit 1000': {
        args: ['issue', 'list', '--state', 'open', '--json', 'number,title,state,labels,body,milestone,url', '--limit', '1000'],
        exitCode: 0,
        stdout: JSON.stringify([
          { number: 93, title: 'Add view command', body: '', state: 'OPEN', labels: [{ name: 'S-Ready' }], milestone: null, url: 'https://github.com/example/repo/issues/93' },
          { number: 94, title: 'Other work', body: '', state: 'OPEN', labels: [{ name: 'S-InProgress' }], milestone: null, url: 'https://github.com/example/repo/issues/94' },
        ]),
        stderr: '',
      },
    });

    const result = await viewIssue(93, { exec });
    assert.equal(result.issue.effectiveStatus, 'Ready');
    assert.ok(result.warnings.some(w => w.includes('Another issue is S-InProgress')));
    assert.ok(result.recommendedAction.includes('aie queue'));
  });

  it('keeps issues blocked when blocker status cannot be verified', async () => {
    const exec = makeFixtureExec({
      'issue view 93 --json number,title,state,labels,body,milestone,url': {
        args: ['issue', 'view', '93', '--json', 'number,title,state,labels,body,milestone,url'],
        exitCode: 0,
        stdout: sampleIssueJson(93, 'Add view command', 'OPEN', ['S-Ready'], 'Blocked by: #17'),
        stderr: '',
      },
      'issue view 17 --json number,title,state,labels,body,milestone,url': {
        args: ['issue', 'view', '17', '--json', 'number,title,state,labels,body,milestone,url'],
        exitCode: 1,
        stdout: '',
        stderr: 'not found',
      },
      'issue list --state open --json number,title,state,labels,body,milestone,url --limit 1000': {
        args: ['issue', 'list', '--state', 'open', '--json', 'number,title,state,labels,body,milestone,url', '--limit', '1000'],
        exitCode: 0,
        stdout: '[]',
        stderr: '',
      },
    });

    const result = await viewIssue(93, { exec });
    assert.equal(result.issue.effectiveStatus, 'Blocked');
    assert.deepEqual(result.dependency.unresolvedBlockers, [17]);
    assert.ok(result.warnings.some(w => w.includes('Could not verify blocker status')));
    assert.ok(result.recommendedAction.includes('Do not start'));
  });

  it('includes dependents that declare this issue as blocker', async () => {
    const exec = makeFixtureExec({
      'issue view 93 --json number,title,state,labels,body,milestone,url': {
        args: ['issue', 'view', '93', '--json', 'number,title,state,labels,body,milestone,url'],
        exitCode: 0,
        stdout: sampleIssueJson(93, 'Add view command', 'OPEN', ['S-Ready'], ''),
        stderr: '',
      },
      'issue list --state open --json number,title,state,labels,body,milestone,url --limit 1000': {
        args: ['issue', 'list', '--state', 'open', '--json', 'number,title,state,labels,body,milestone,url', '--limit', '1000'],
        exitCode: 0,
        stdout: JSON.stringify([
          { number: 95, title: 'Depends on 93', body: 'Blocked by: #93', state: 'OPEN', labels: [{ name: 'S-Blocked' }], milestone: null, url: 'https://github.com/example/repo/issues/95' },
        ]),
        stderr: '',
      },
    });

    const result = await viewIssue(93, { exec });
    assert.equal(result.dependency.dependents.length, 1);
    assert.equal(result.dependency.dependents[0].number, 95);
  });

  it('includes milestone context when available', async () => {
    const exec = makeFixtureExec({
      'issue view 93 --json number,title,state,labels,body,milestone,url': {
        args: ['issue', 'view', '93', '--json', 'number,title,state,labels,body,milestone,url'],
        exitCode: 0,
        stdout: JSON.stringify({
          number: 93,
          title: 'Add view command',
          body: '',
          state: 'OPEN',
          labels: [{ name: 'S-Ready' }],
          milestone: { number: 3, title: 'Q2', state: 'OPEN', dueOn: '2026-06-01T00:00:00Z' },
          url: 'https://github.com/example/repo/issues/93',
        }),
        stderr: '',
      },
      'issue list --state open --json number,title,state,labels,body,milestone,url --limit 1000': {
        args: ['issue', 'list', '--state', 'open', '--json', 'number,title,state,labels,body,milestone,url', '--limit', '1000'],
        exitCode: 0,
        stdout: '[]',
        stderr: '',
      },
      'repo view --json nameWithOwner,url': {
        args: ['repo', 'view', '--json', 'nameWithOwner,url'],
        exitCode: 0,
        stdout: JSON.stringify({ nameWithOwner: 'example/repo', url: 'https://github.com/example/repo' }),
        stderr: '',
      },
      'api repos/example/repo/milestones --method GET -F state=all -F per_page=100': {
        args: ['api', 'repos/example/repo/milestones', '--method', 'GET', '-F', 'state=all', '-F', 'per_page=100'],
        exitCode: 0,
        stdout: JSON.stringify([
          { number: 3, title: 'Q2', state: 'OPEN', due_on: '2026-06-01T00:00:00Z', open_issues: 5, closed_issues: 10 },
        ]),
        stderr: '',
      },
    });

    const result = await viewIssue(93, { exec });
    assert.equal(result.milestone.number, 3);
    assert.equal(result.milestone.title, 'Q2');
    assert.equal(result.milestone.state, 'OPEN');
    assert.equal(result.milestone.dueOn, '2026-06-01T00:00:00Z');
    assert.equal(result.milestone.openIssues, 5);
    assert.equal(result.milestone.closedIssues, 10);
  });

  it('keeps milestone counts unknown when progress lookup fails', async () => {
    const exec = makeFixtureExec({
      'issue view 93 --json number,title,state,labels,body,milestone,url': {
        args: ['issue', 'view', '93', '--json', 'number,title,state,labels,body,milestone,url'],
        exitCode: 0,
        stdout: JSON.stringify({
          number: 93,
          title: 'Add view command',
          body: '',
          state: 'OPEN',
          labels: [{ name: 'S-Ready' }],
          milestone: { number: 3, title: 'Q2', state: 'OPEN', dueOn: null },
          url: 'https://github.com/example/repo/issues/93',
        }),
        stderr: '',
      },
      'issue list --state open --json number,title,state,labels,body,milestone,url --limit 1000': {
        args: ['issue', 'list', '--state', 'open', '--json', 'number,title,state,labels,body,milestone,url', '--limit', '1000'],
        exitCode: 0,
        stdout: '[]',
        stderr: '',
      },
    });

    const result = await viewIssue(93, { exec });
    assert.equal(result.milestone.openIssues, null);
    assert.equal(result.milestone.closedIssues, null);
    assert.ok(result.warnings.some(w => w.includes('Milestone progress counts unavailable')));
  });

  it('rejects invalid issue numbers with actionable error', async () => {
    await assert.rejects(
      () => viewIssue(0),
      /positive integer/
    );
  });

  it('rejects malformed issue context without live GitHub', async () => {
    const exec = makeFixtureExec({
      'issue view 93 --json number,title,state,labels,body,milestone,url': {
        args: ['issue', 'view', '93', '--json', 'number,title,state,labels,body,milestone,url'],
        exitCode: 0,
        stdout: JSON.stringify({ number: 93, title: 'Incomplete issue' }),
        stderr: '',
      },
    });

    await assert.rejects(
      () => viewIssue(93, { exec }),
      /gh JSON did not match expected shape/
    );
  });

  it('suggests branch name from issue and config', () => {
    const { getDefaults } = require('../dist/config/index.js');
    const issue = { number: 93, title: 'Add real view command!', body: '', state: 'OPEN', labels: [], milestone: null, url: '', declaredBlockers: [] };
    const name = suggestBranchName(issue, getDefaults());
    assert.equal(name, 'issue/93-add-real-view-command');
  });

  it('normalizes detached HEAD current branch to null', async () => {
    const { execFileSync } = require('node:child_process');
    const { mkdtempSync, writeFileSync } = require('node:fs');
    const { tmpdir } = require('node:os');
    const { join } = require('node:path');
    const repo = mkdtempSync(join(tmpdir(), 'aie-view-detached-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'executor@example.invalid'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Executor Test'], { cwd: repo, stdio: 'ignore' });
    writeFileSync(join(repo, 'README.md'), 'fixture\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repo, stdio: 'ignore' });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['switch', '--detach', head], { cwd: repo, stdio: 'ignore' });
    const exec = makeFixtureExec({
      'issue view 93 --json number,title,state,labels,body,milestone,url': {
        args: ['issue', 'view', '93', '--json', 'number,title,state,labels,body,milestone,url'],
        exitCode: 0,
        stdout: sampleIssueJson(93, 'Add view command', 'OPEN', ['S-Ready'], ''),
        stderr: '',
      },
      'issue list --state open --json number,title,state,labels,body,milestone,url --limit 1000': {
        args: ['issue', 'list', '--state', 'open', '--json', 'number,title,state,labels,body,milestone,url', '--limit', '1000'],
        exitCode: 0,
        stdout: '[]',
        stderr: '',
      },
    });

    const result = await viewIssue(93, { exec, cwd: repo });

    assert.equal(result.branch.current, null);
  });
});

describe('view command metadata', () => {
  it('publishes registry-backed schema metadata', () => {
    const { getCommandMetadata } = require('../dist/command_metadata.js');
    const view = getCommandMetadata('view');
    assert.ok(view.description.includes('issue context'));
    assert.deepEqual(view.args, ['issue']);
    assert.ok(view.flags.includes('--json'));
    assert.ok(view.examples.some((e) => e.includes('view 93')));
  });
});

describe('view schema metadata', () => {
  it('marks view as read-only with json support', () => {
    const { getImplementedCommands } = require('../dist/command_metadata.js');
    const commands = getImplementedCommands();
    const viewCmd = commands.find(c => c.name === 'view');

    assert.ok(viewCmd, 'Expected view command metadata to be registered');
    assert.equal(viewCmd.mutates, false);
    assert.deepEqual(viewCmd.mutationTargets, []);
    assert.equal(viewCmd.supportsJson, true);
    assert.equal(viewCmd.supportsDryRun, false);
  });
});
