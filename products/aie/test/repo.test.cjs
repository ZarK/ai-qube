const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { execFileSync } = require('node:child_process');
const { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs');
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
  runRepoAffected,
  runRepoInspect,
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

function makeFixtureRepo(fixtureName) {
  const repo = makeGitRepo();
  cpSync(join(__dirname, 'fixtures', 'layout', fixtureName), repo, { recursive: true });
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', `fixture ${fixtureName}`], { cwd: repo, stdio: 'ignore' });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', head], { cwd: repo, stdio: 'ignore' });
  return repo;
}

function commitFile(repo, path, content) {
  writeFileSync(join(repo, path), content);
  execFileSync('git', ['add', path], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', `change ${path}`], { cwd: repo, stdio: 'ignore' });
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

describe('repo layout inspection and affected scope', () => {
  it('inspects a JavaScript workspace layout with projects and local signals', async () => {
    const repo = makeFixtureRepo('js-workspace');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.command, 'repo inspect');
    assert.equal(result.kind, 'javascript-typescript-workspace');
    assert.deepEqual(result.projects.map(project => project.path), ['.', 'apps/web', 'packages/core', 'tools/cli']);
    assert.equal(result.projects.find(project => project.path === 'apps/web').packageName, '@fixture/web');
    assert.equal(result.projects.find(project => project.path === 'packages/core').packageName, '@fixture/core');
    assert.equal(result.projects.find(project => project.path === 'tools/cli').packageName, '@fixture/cli');
    assert.deepEqual(result.lockfiles, ['pnpm-lock.yaml']);
    assert.ok(result.rootMarkers.some(marker => marker.path === 'pnpm-workspace.yaml'));
    assert.ok(result.rootMarkers.some(marker => marker.path === 'turbo.json'));
    assert.ok(result.ciHints.some(hint => hint.path === '.github/workflows/ci.yml'));
  });

  it('inspects a single app service layout from fixture root signals', async () => {
    const repo = makeFixtureRepo('single-app-service');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.command, 'repo inspect');
    assert.equal(result.kind, 'single-app-service');
    assert.deepEqual(result.projects.map(project => [project.id, project.path, project.kind]), [['single-app-fixture', '.', 'app']]);
    assert.equal(result.projects[0].packageName, 'single-app-fixture');
    assert.ok(result.projects[0].gates.includes('build'));
    assert.ok(result.rootMarkers.some(marker => marker.path === 'package.json'));
    assert.ok(result.ciHints.some(hint => hint.path === '.github/workflows/ci.yml'));
  });

  it('maps nested single app changes to the root project and safe gates', async () => {
    const repo = makeFixtureRepo('single-app-service');

    const result = await runRepoAffected({
      config: getDefaults(),
      cwd: repo,
      changedPaths: ['src/index.ts', 'test/index.test.ts', 'package.json'],
    });

    assert.equal(result.command, 'repo affected');
    assert.deepEqual(result.affectedProjects.map(project => project.project.id), ['single-app-fixture']);
    assert.deepEqual(result.affectedProjects[0].changedPaths, ['src/index.ts', 'test/index.test.ts', 'package.json']);
    assert.ok(result.affectedProjects[0].gates.includes('build'));
    assert.ok(result.affectedProjects[0].gates.includes('typecheck'));
    assert.ok(result.affectedProjects[0].gates.includes('test'));
    assert.ok(result.suggestedGates.includes('dependency-review'));
  });

  it('keeps generated single app paths out of mutation scope', async () => {
    const repo = makeFixtureRepo('single-app-service');
    mkdirSync(join(repo, 'dist'), { recursive: true });
    writeFileSync(join(repo, 'dist', 'bundle.js'), 'generated\n');

    const result = await runRepoAffected({
      config: getDefaults(),
      cwd: repo,
      changedPaths: ['dist/bundle.js'],
    });

    assert.deepEqual(result.affectedProjects, []);
    assert.ok(result.suggestedGates.includes('build'));
    assert.ok(result.warnings.some(warning => warning.includes('did not map to a detected project')));
  });

  it('treats conflicting single app root signals as ambiguous', async () => {
    const repo = makeFixtureRepo('ambiguous-single-app');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'unknown');
    assert.notEqual(result.kind, 'single-app-service');
    assert.ok(result.warnings.some(warning => warning.includes('Multiple root package/build signals were detected')));
  });

  it('uses narrow git probes for layout inspection', async () => {
    const repo = makeFixtureRepo('js-workspace');
    const calls = [];
    const git = async (args) => {
      calls.push(args.join(' '));
      if (args.join(' ') === 'rev-parse --show-toplevel') return { args, exitCode: 0, stdout: repo, stderr: '' };
      if (args.join(' ') === 'remote -v') return { args, exitCode: 0, stdout: 'origin\thttps://github.com/example/repo.git (fetch)\norigin\thttps://github.com/example/repo.git (push)\n', stderr: '' };
      return { args, exitCode: 1, stdout: '', stderr: `unexpected git call: ${args.join(' ')}` };
    };

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo, git });

    assert.equal(result.kind, 'javascript-typescript-workspace');
    assert.deepEqual(calls, ['rev-parse --show-toplevel', 'remote -v']);
  });

  it('maps changed paths to affected workspace projects and suggested gates', async () => {
    const repo = makeFixtureRepo('js-workspace');

    const result = await runRepoAffected({
      config: getDefaults(),
      cwd: repo,
      changedPaths: ['apps/web/src/index.ts', 'packages/core/src/index.ts', 'tools/cli/src/index.ts', 'pnpm-lock.yaml'],
    });

    assert.equal(result.command, 'repo affected');
    assert.deepEqual(result.affectedProjects.map(project => project.project.id), ['fixture-root', '@fixture/web', '@fixture/core', '@fixture/cli']);
    assert.ok(result.affectedProjects.find(project => project.project.id === '@fixture/web').gates.includes('typecheck'));
    assert.ok(result.affectedProjects.find(project => project.project.id === '@fixture/core').gates.includes('typecheck'));
    assert.ok(result.affectedProjects.find(project => project.project.id === '@fixture/cli').gates.includes('typecheck'));
    assert.ok(result.suggestedGates.includes('dependency-review'));
  });

  it('does not treat nested lockfiles as root project changes', async () => {
    const repo = makeFixtureRepo('js-workspace');

    const result = await runRepoAffected({
      config: getDefaults(),
      cwd: repo,
      changedPaths: ['products/aie/test/fixtures/layout/js-workspace/pnpm-lock.yaml'],
    });

    assert.deepEqual(result.affectedProjects, []);
    assert.ok(result.suggestedGates.includes('dependency-review'));
    assert.ok(result.warnings.some(warning => warning.includes('did not map to a detected project')));
  });

  it('does not expand workspace projects outside the repository root', async () => {
    const repo = makeFixtureRepo('js-workspace');
    const outside = join(repo, '..', 'outside-layout-leak');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'package.json'), JSON.stringify({ name: 'outside-layout-leak' }));
    writeFileSync(join(repo, 'package.json'), JSON.stringify({
      name: 'fixture-root',
      private: true,
      workspaces: ['packages/*', '../outside-*'],
    }));

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.deepEqual(result.projects.map(project => project.path), ['.', 'apps/web', 'packages/core', 'tools/cli']);
    assert.equal(result.projects.some(project => project.packageName === 'outside-layout-leak'), false);
    assert.equal(result.projects.some(project => project.path.startsWith('..')), false);
  });

  it('does not classify JavaScript tooling markers without a root package as a workspace', async () => {
    const repo = makeFixtureRepo('ambiguous-js-workspace');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'unknown');
    assert.deepEqual(result.projects.map(project => project.path), ['apps/web']);
    assert.ok(result.rootMarkers.some(marker => marker.path === 'turbo.json'));
    assert.ok(result.warnings.some(warning => warning.includes('no root package.json was found')));
  });

  it('uses configured base ref when changed paths are not provided', async () => {
    const repo = makeFixtureRepo('js-workspace');
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['branch', 'develop', base], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['update-ref', 'refs/remotes/upstream/develop', base], { cwd: repo, stdio: 'ignore' });
    commitFile(repo, 'packages/core/src/index.ts', 'export const changed = true;\n');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', head], { cwd: repo, stdio: 'ignore' });

    const result = await runRepoAffected({
      config: { ...getDefaults(), baseRemote: 'upstream', baseBranch: 'develop' },
      cwd: repo,
    });

    assert.deepEqual(result.changedPaths, ['packages/core/src/index.ts']);
    assert.deepEqual(result.affectedProjects.map(project => project.project.id), ['@fixture/core']);
    assert.equal(result.warnings.some(warning => warning.includes('Failed to inspect changed paths')), false);
  });

  it('warns when default changed path inspection fails', async () => {
    const repo = makeFixtureRepo('js-workspace');

    const result = await runRepoAffected({
      config: { ...getDefaults(), baseRemote: 'missing-remote', baseBranch: 'missing-branch' },
      cwd: repo,
    });

    assert.deepEqual(result.changedPaths, []);
    assert.ok(result.warnings.some(warning => warning.includes('Failed to inspect changed paths from missing-remote/missing-branch...HEAD')));
  });
});

describe('repo command metadata and schema', () => {
  it('publishes repo topic and repo prime metadata through the shared registry', () => {
    const { getCommandMetadata } = require('../dist/command_metadata.js');
    const repo = getCommandMetadata('repo');
    const repoPrime = getCommandMetadata('repo prime');

    const inspect = getCommandMetadata('repo inspect');
    const affected = getCommandMetadata('repo affected');

    assert.ok(repo.description.includes('Inspect repository layout'));
    assert.ok(repo.examples.some(example => example.includes('repo inspect --json')));
    assert.ok(inspect.flags.includes('--json'));
    assert.ok(affected.flags.includes('--changed'));
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
    const inspect = commands.find(command => command.name === 'repo inspect');
    const affected = commands.find(command => command.name === 'repo affected');
    const prime = commands.find(command => command.name === 'repo prime');

    assert.equal(labels.mutates, false);
    assert.equal(repo.mutates, false);
    assert.ok(repo.examples.includes('aie repo'));
    assert.equal(inspect.mutates, false);
    assert.equal(inspect.supportsJson, true);
    assert.equal(affected.mutates, false);
    assert.equal(affected.supportsJson, true);
    assert.equal(prime.mutates, true);
    assert.equal(prime.supportsJson, true);
    assert.equal(prime.supportsDryRun, true);
    assert.ok(prime.flags.includes('--yes'));
  });
});
