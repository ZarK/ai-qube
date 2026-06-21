const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { execFileSync } = require('node:child_process');
const { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { getDefaults } = require('../dist/config/index.js');
const { getDesiredLabels } = require('../dist/labels.js');
const {
  buildRepoPrimePlan,
  findMissingMilestones,
  findMilestoneWarnings,
  formatMinimalConfig,
  listMilestones,
  listOpenPullRequests,
} = require('../dist/repo/index.js');

function makeFixtureExec(responses, calls = []) {
  return async (args) => {
    calls.push(args);
    const key = args.join(' ');
    if (responses[key]) return responses[key];
    return { args, exitCode: 1, stdout: '', stderr: `unexpected gh call in test fixture: ${key}` };
  };
}

function makeGitRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'aie-repo-prime-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'executor@example.invalid'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Executor Test'], { cwd: repo, stdio: 'ignore' });
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repo, stdio: 'ignore' });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', head], { cwd: repo, stdio: 'ignore' });
  return repo;
}

function success(args, stdout) {
  return { args, exitCode: 0, stdout, stderr: '' };
}

const repoViewArgs = ['repo', 'view', '--json', 'nameWithOwner,url'];
const labelListArgs = ['label', 'list', '--json', 'name,color,description', '--limit', '1000'];
const issueListArgs = ['issue', 'list', '--state', 'open', '--json', 'number,title,state,labels,body,milestone,url', '--limit', '1000'];
const prListArgs = ['pr', 'list', '--state', 'open', '--json', 'number,title,author,isDraft,url,headRefName', '--limit', '1000'];
const milestoneArgs = ['api', 'repos/example/repo/milestones', '--method', 'GET', '-F', 'state=all', '-F', 'per_page=100'];

describe('repo prime service', () => {
  it('builds a dry-run plan without mutating GitHub or local config', async () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, 'AGENTS.md'), 'instructions\n');
    writeFileSync(join(repo, 'docs', 'spec.md'), 'spec\n');
    writeFileSync(join(repo, 'docs', 'M1-example.md'), 'milestone\n');

    const config = getDefaults();
    const desired = getDesiredLabels(config);
    const calls = [];
    const exec = makeFixtureExec({
      [repoViewArgs.join(' ')]: success(repoViewArgs, JSON.stringify({ nameWithOwner: 'example/repo', url: 'https://github.com/example/repo' })),
      [labelListArgs.join(' ')]: success(labelListArgs, JSON.stringify(desired.slice(0, 2))),
      [issueListArgs.join(' ')]: success(issueListArgs, JSON.stringify([
        { number: 10, title: 'Ready work', body: '', state: 'OPEN', labels: [{ name: 'S-Ready' }], milestone: null, url: 'https://github.com/example/repo/issues/10' },
        { number: 11, title: 'Milestoned work', body: '', state: 'OPEN', labels: [{ name: 'S-Ready' }], milestone: { number: 1, title: 'Product', state: 'OPEN', dueOn: null }, url: 'https://github.com/example/repo/issues/11' },
      ])),
      [prListArgs.join(' ')]: success(prListArgs, JSON.stringify([
        { number: 2, title: 'Automation', author: { login: 'dependabot[bot]' }, isDraft: false, url: 'https://github.com/example/repo/pull/2', headRefName: 'deps' },
        { number: 3, title: 'Feature', author: { login: 'human' }, isDraft: false, url: 'https://github.com/example/repo/pull/3', headRefName: 'feature' },
      ])),
      [milestoneArgs.join(' ')]: success(milestoneArgs, JSON.stringify([{ number: 1, title: 'Product', state: 'open', due_on: null, open_issues: 1, closed_issues: 0 }])),
    }, calls);

    const plan = await buildRepoPrimePlan({ config, dryRun: true, yes: false, exec, cwd: repo });

    assert.equal(plan.repository.nameWithOwner, 'example/repo');
    assert.equal(plan.configPresent, false);
    assert.equal(plan.configWillWrite, false);
    assert.ok(plan.plannedChanges.includes(`Write minimal Executor config to ${plan.configPath}`));
    assert.ok(plan.skippedActions.includes('Config write requires --yes'));
    assert.equal(plan.labelPlan.created.length, desired.length - 2);
    assert.equal(plan.openIssueCount, 2);
    assert.equal(plan.pullRequests.length, 2);
    assert.deepEqual(plan.blockingPullRequests.map(pr => pr.number), [3]);
    assert.deepEqual(plan.milestoneWarnings.map(warning => warning.issueNumber), [10]);
    assert.equal(plan.instructions.agents, true);
    assert.equal(plan.planning.spec, true);
    assert.equal(plan.planning.milestones.length, 1);
    assert.equal(existsSync(join(repo, '.qube', 'aie', 'config.json')), false);
    assert.equal(calls.some(args => args[0] === 'label' && (args[1] === 'create' || args[1] === 'edit')), false);
  });

  it('writes minimal config with --yes when config is missing', async () => {
    const repo = makeGitRepo();
    const config = getDefaults();
    const desired = getDesiredLabels(config);
    const exec = makeFixtureExec({
      [repoViewArgs.join(' ')]: success(repoViewArgs, JSON.stringify({ nameWithOwner: 'example/repo', url: 'https://github.com/example/repo' })),
      [labelListArgs.join(' ')]: success(labelListArgs, JSON.stringify(desired)),
      [issueListArgs.join(' ')]: success(issueListArgs, JSON.stringify([])),
      [prListArgs.join(' ')]: success(prListArgs, JSON.stringify([])),
      [milestoneArgs.join(' ')]: success(milestoneArgs, JSON.stringify([])),
    });

    const plan = await buildRepoPrimePlan({ config, dryRun: false, yes: true, exec, cwd: repo });

    assert.equal(plan.configWillWrite, true);
    assert.equal(plan.completedChanges.includes(`Wrote ${plan.configPath}`), true);
    assert.equal(readFileSync(plan.configPath, 'utf8'), formatMinimalConfig());
  });
});

describe('repo data helpers', () => {
  it('classifies ignored and blocking pull requests from config', async () => {
    const config = getDefaults();
    const exec = makeFixtureExec({
      [prListArgs.join(' ')]: success(prListArgs, JSON.stringify([
        { number: 4, title: 'Automation', author: { login: 'renovate[bot]' }, isDraft: false, url: 'https://github.com/example/repo/pull/4', headRefName: 'renovate' },
        { number: 5, title: 'Manual', author: { login: 'maintainer' }, isDraft: true, url: 'https://github.com/example/repo/pull/5', headRefName: 'manual' },
      ])),
    });

    const prs = await listOpenPullRequests(config, { exec });

    assert.deepEqual(prs.map(pr => [pr.number, pr.ignored]), [[4, true], [5, false]]);
  });

  it('normalizes milestones and missing milestone warnings', async () => {
    const exec = makeFixtureExec({
      [milestoneArgs.join(' ')]: success(milestoneArgs, JSON.stringify([{ number: 7, title: 'Release', state: 'closed', due_on: '2026-01-01T00:00:00Z', open_issues: 0, closed_issues: 3 }])),
    });

    const milestones = await listMilestones({ nameWithOwner: 'example/repo', url: 'https://github.com/example/repo' }, { exec });
    const warnings = findMissingMilestones([
      { number: 1, title: 'Missing', body: '', state: 'OPEN', labels: [], milestone: null, url: '', declaredBlockers: [] },
      { number: 2, title: 'Assigned', body: '', state: 'OPEN', labels: [], milestone: { number: 7, title: 'Release', state: 'closed', dueOn: null }, url: '', declaredBlockers: [] },
    ]);

    assert.equal(milestones[0].title, 'Release');
    assert.equal(milestones[0].closedIssues, 3);
    assert.deepEqual(warnings, [{ issueNumber: 1, title: 'Missing', kind: 'missing-assignment', message: 'Issue has no GitHub milestone assignment.' }]);
  });

  it('reports milestone ordering preservation warnings from blocker metadata', () => {
    const config = getDefaults();
    config.milestoneOrdering.enabled = true;
    config.milestoneOrdering.order = ['Foundation', 'Adoption', 'Release'];
    const issues = [
      { number: 10, title: 'Blocked adoption work', body: 'Blocked by: #11', state: 'OPEN', labels: [], milestone: { number: 1, title: 'Foundation', state: 'OPEN', dueOn: null }, url: '', declaredBlockers: [11] },
      { number: 11, title: 'Later blocker', body: '', state: 'OPEN', labels: [], milestone: { number: 2, title: 'Adoption', state: 'OPEN', dueOn: null }, url: '', declaredBlockers: [] },
      { number: 12, title: 'Unknown milestone', body: '', state: 'OPEN', labels: [], milestone: { number: 3, title: 'Custom', state: 'OPEN', dueOn: null }, url: '', declaredBlockers: [] },
    ];

    const warnings = findMilestoneWarnings(issues, config);

    assert.deepEqual(warnings.map(warning => warning.kind), ['ordering-drift', 'unknown-order']);
    assert.equal(warnings[0].issueNumber, 10);
    assert.equal(warnings[0].blockerNumber, 11);
    assert.equal(warnings[0].issueMilestone, 'Foundation');
    assert.equal(warnings[0].blockerMilestone, 'Adoption');
    assert.match(warnings[0].message, /ordered before blocker #11/);
    assert.equal(warnings[1].issueNumber, 12);
    assert.match(warnings[1].message, /not in configured milestone order/);
  });

  it('respects ignored missing milestone policy while still reporting ordering drift', () => {
    const config = getDefaults();
    config.milestoneOrdering.enabled = true;
    config.milestoneOrdering.missingAssignment = 'ignore';
    config.milestoneOrdering.order = ['Current', 'Next'];
    const warnings = findMilestoneWarnings([
      { number: 20, title: 'No milestone', body: '', state: 'OPEN', labels: [], milestone: null, url: '', declaredBlockers: [] },
      { number: 21, title: 'Blocked current work', body: 'Blocked by: #22', state: 'OPEN', labels: [], milestone: { number: 1, title: 'Current', state: 'OPEN', dueOn: null }, url: '', declaredBlockers: [22] },
      { number: 22, title: 'Next blocker', body: '', state: 'OPEN', labels: [], milestone: { number: 2, title: 'Next', state: 'OPEN', dueOn: null }, url: '', declaredBlockers: [] },
    ], config);

    assert.deepEqual(warnings.map(warning => warning.kind), ['ordering-drift']);
  });

  it('reports when blocker milestone order is unknown', () => {
    const config = getDefaults();
    config.milestoneOrdering.enabled = true;
    config.milestoneOrdering.order = ['Current'];
    const warnings = findMilestoneWarnings([
      { number: 30, title: 'Blocked current work', body: 'Blocked by: #31', state: 'OPEN', labels: [], milestone: { number: 1, title: 'Current', state: 'OPEN', dueOn: null }, url: '', declaredBlockers: [31] },
      { number: 31, title: 'Unknown blocker milestone', body: '', state: 'OPEN', labels: [], milestone: { number: 2, title: 'External', state: 'OPEN', dueOn: null }, url: '', declaredBlockers: [] },
    ], config);

    assert.equal(warnings.some(warning => warning.kind === 'unknown-order' && warning.blockerNumber === 31), true);
  });
});

describe('repo command metadata and schema', () => {
  it('publishes repo topic and repo prime metadata through the shared registry', () => {
    const { getCommandMetadata } = require('../dist/command_metadata.js');
    const repo = getCommandMetadata('repo');
    const repoPrime = getCommandMetadata('repo prime');

    assert.ok(repo.description.includes('Inspect and prepare repository state'));
    assert.ok(repo.examples.some(example => example.includes('repo prime --dry-run')));
    assert.ok(repoPrime.flags.includes('--json'));
    assert.ok(repoPrime.flags.includes('--dry-run'));
    assert.ok(repoPrime.flags.includes('--yes'));
    assert.ok(repoPrime.examples.some(example => example.includes('repo prime --yes')));
  });

  it('publishes repo commands with mutation, JSON, and dry-run markers', () => {
    const { getImplementedCommands } = require('../dist/command_metadata.js');
    const commands = getImplementedCommands();
    const labels = commands.find(command => command.name === 'labels');
    const repo = commands.find(command => command.name === 'repo');
    const prime = commands.find(command => command.name === 'repo prime');

    assert.equal(labels.mutates, false);
    assert.equal(repo.mutates, false);
    assert.ok(repo.examples.includes('aie repo'));
    assert.equal(prime.mutates, true);
    assert.equal(prime.supportsJson, true);
    assert.equal(prime.supportsDryRun, true);
    assert.ok(prime.flags.includes('--yes'));
  });
});
