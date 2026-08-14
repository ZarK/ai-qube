const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { cloneGitRepo } = require('./support/git_fixture.cjs');
const { execFileSync } = require('node:child_process');
const { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } = require('node:fs');
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
  return cloneGitRepo('committed', 'aie-repo-prime-');
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

  it('inspects a Python workspace monorepo layout with projects and local signals', async () => {
    const repo = makeFixtureRepo('python-workspace');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.command, 'repo inspect');
    assert.equal(result.kind, 'python-workspace-monorepo');
    assert.deepEqual(result.projects.map(project => project.path), ['.', 'packages/core', 'services/api']);
    assert.equal(result.projects.find(project => project.path === '.').packageName, 'fixture-python-root');
    assert.equal(result.projects.find(project => project.path === 'packages/core').packageName, 'fixture-python-core');
    assert.equal(result.projects.find(project => project.path === 'services/api').packageName, 'fixture-python-api');
    assert.deepEqual(result.lockfiles, []);
    assert.ok(result.rootMarkers.some(marker => marker.path === 'pyproject.toml'));
    assert.ok(result.rootMarkers.some(marker => marker.path === 'pyproject.toml' && marker.section === 'tool.hatch'));
    assert.ok(result.rootMarkers.some(marker => marker.path === 'pyproject.toml' && marker.section === 'tool.uv'));
    assert.ok(result.rootMarkers.every(marker => !marker.path.includes('#')));
    assert.ok(result.projects.filter(project => project.path !== '.').every(project => project.packageManager === null));
    assert.ok(result.rootMarkers.some(marker => marker.path === 'uv.lock'));
    assert.ok(result.rootMarkers.some(marker => marker.path === 'tox.ini'));
    assert.ok(result.rootMarkers.some(marker => marker.path === 'noxfile.py'));
  });

  it('inspects a Rust workspace layout with crates and local signals', async () => {
    const repo = makeFixtureRepo('rust-workspace');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.command, 'repo inspect');
    assert.equal(result.kind, 'rust-workspace');
    assert.deepEqual(result.projects.map(project => project.path), ['.', 'crates/cli', 'crates/core']);
    assert.equal(result.projects.find(project => project.path === '.').kind, 'workspace');
    assert.equal(result.projects.find(project => project.path === 'crates/core').packageName, 'fixture-rust-core');
    assert.equal(result.projects.find(project => project.path === 'crates/cli').packageName, 'fixture-rust-cli');
    assert.ok(result.rootMarkers.some(marker => marker.path === 'Cargo.toml'));
    assert.ok(result.rootMarkers.some(marker => marker.path === 'Cargo.lock'));
    assert.ok(result.ciHints.some(hint => hint.path === '.github/workflows/ci.yml'));
    assert.ok(!result.warnings.some(warning => warning.includes('Affected-scope mapping is conservative')));
  });

  it('maps changed paths to affected Rust workspace crates and suggested gates', async () => {
    const repo = makeFixtureRepo('rust-workspace');

    const result = await runRepoAffected({
      config: getDefaults(),
      cwd: repo,
      changedPaths: ['crates/core/src/lib.rs', 'crates/cli/Cargo.toml', 'Cargo.lock'],
    });

    assert.equal(result.command, 'repo affected');
    assert.equal(result.layout.kind, 'rust-workspace');
    assert.deepEqual(result.affectedProjects.map(project => project.project.id), ['root', 'fixture-rust-cli', 'fixture-rust-core']);
    assert.deepEqual(result.affectedProjects.find(project => project.project.id === 'root').changedPaths, ['Cargo.lock']);
    assert.ok(result.affectedProjects.find(project => project.project.id === 'fixture-rust-core').gates.includes('test'));
    assert.ok(result.affectedProjects.find(project => project.project.id === 'fixture-rust-cli').gates.includes('dependency-review'));
    assert.ok(result.suggestedGates.includes('dependency-review'));
  });

  it('keeps a Rust workspace when incidental Node tooling exists at the root', async () => {
    const repo = makeFixtureRepo('rust-workspace');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'node-tooling-root', private: true }, null, 2));

    const inspected = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(inspected.kind, 'rust-workspace');
    assert.deepEqual(inspected.projects.map(project => project.path), ['.', 'crates/cli', 'crates/core']);
    assert.equal(inspected.projects.find(project => project.path === '.').kind, 'workspace');
  });

  it('reports an ambiguous layout when Rust and JavaScript workspaces both resolve members', async () => {
    const repo = makeFixtureRepo('rust-workspace');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'node-tooling-root', private: true, workspaces: ['tools/*'] }, null, 2));
    mkdirSync(join(repo, 'tools', 'cli'), { recursive: true });
    writeFileSync(join(repo, 'tools', 'cli', 'package.json'), JSON.stringify({ name: 'fixture-node-cli', private: true }, null, 2));

    const inspected = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(inspected.kind, 'unknown');
    assert.ok(inspected.warnings.some(warning => /both or neither resolve member projects; repository layout is ambiguous/.test(warning)));
  });

  it('does not classify Rust lockfiles without a root Cargo.toml as a workspace', async () => {
    const repo = makeFixtureRepo('ambiguous-rust-workspace');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'unknown');
    assert.deepEqual(result.projects.map(project => project.path), ['crates/core']);
    assert.ok(result.rootMarkers.some(marker => marker.path === 'Cargo.lock'));
    assert.ok(result.warnings.some(warning => warning.includes('no root Cargo.toml was found')));
  });

  it('keeps generated Rust target paths out of mutation scope', async () => {
    const repo = makeFixtureRepo('rust-workspace');
    mkdirSync(join(repo, 'target'), { recursive: true });
    writeFileSync(join(repo, 'target', 'debug.rs'), 'generated\n');

    const result = await runRepoAffected({
      config: getDefaults(),
      cwd: repo,
      changedPaths: ['target/debug.rs'],
    });

    assert.deepEqual(result.affectedProjects, []);
    assert.ok(result.warnings.some(warning => warning.includes('did not map to a detected project')));
  });

  it('does not expand Rust workspace members outside the repository root', async () => {
    const repo = makeFixtureRepo('rust-workspace');
    const outside = join(repo, '..', 'outside-rust-leak');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'Cargo.toml'), '[package]\nname = "outside-rust-leak"\nversion = "0.0.0"\n');
    writeFileSync(join(repo, 'Cargo.toml'), '[workspace]\nmembers = ["crates/*", "../outside-rust-leak"]\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.deepEqual(result.projects.map(project => project.path), ['.', 'crates/cli', 'crates/core']);
    assert.equal(result.projects.some(project => project.packageName === 'outside-rust-leak'), false);
    assert.equal(result.projects.some(project => project.path.startsWith('..')), false);
  });

  it('inspects a Go module workspace layout with modules and local signals', async () => {
    const repo = makeFixtureRepo('go-workspace');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.command, 'repo inspect');
    assert.equal(result.kind, 'go-workspace');
    assert.deepEqual(result.projects.map(project => project.path), ['.', 'modules/cli', 'modules/core']);
    assert.equal(result.projects.find(project => project.path === '.').kind, 'workspace');
    assert.equal(result.projects.find(project => project.path === 'modules/core').packageName, 'example.com/fixture/core');
    assert.equal(result.projects.find(project => project.path === 'modules/cli').packageName, 'example.com/fixture/cli');
    assert.ok(result.rootMarkers.some(marker => marker.path === 'go.work'));
    assert.ok(result.ciHints.some(hint => hint.path === '.github/workflows/ci.yml'));
    assert.ok(!result.warnings.some(warning => warning.includes('Affected-scope mapping is conservative')));
  });

  it('maps changed paths to affected Go workspace modules and suggested gates', async () => {
    const repo = makeFixtureRepo('go-workspace');

    const result = await runRepoAffected({
      config: getDefaults(),
      cwd: repo,
      changedPaths: ['modules/core/core.go', 'modules/cli/go.mod', 'go.work'],
    });

    assert.equal(result.command, 'repo affected');
    assert.equal(result.layout.kind, 'go-workspace');
    assert.deepEqual(result.affectedProjects.map(project => project.project.id), ['root', 'example.com/fixture/cli', 'example.com/fixture/core']);
    assert.deepEqual(result.affectedProjects.find(project => project.project.id === 'root').changedPaths, ['go.work']);
    assert.ok(result.affectedProjects.find(project => project.project.id === 'example.com/fixture/core').gates.includes('test'));
    assert.ok(result.affectedProjects.find(project => project.project.id === 'example.com/fixture/cli').gates.includes('dependency-review'));
    assert.ok(result.suggestedGates.includes('dependency-review'));
  });

  it('does not classify nested Go modules without a root go.work as a workspace', async () => {
    const repo = makeFixtureRepo('ambiguous-go-workspace');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'unknown');
    assert.deepEqual(result.projects.map(project => project.path), ['modules/core']);
    assert.ok(result.warnings.some(warning => warning.includes('no root go.work was found')));
  });

  it('keeps vendored Go paths out of mutation scope', async () => {
    const repo = makeFixtureRepo('go-workspace');
    mkdirSync(join(repo, 'vendor'), { recursive: true });
    writeFileSync(join(repo, 'vendor', 'mod.go'), 'vendored\n');

    const result = await runRepoAffected({
      config: getDefaults(),
      cwd: repo,
      changedPaths: ['vendor/mod.go'],
    });

    assert.deepEqual(result.affectedProjects, []);
    assert.ok(result.warnings.some(warning => warning.includes('did not map to a detected project')));
  });

  it('does not expand Go workspace members outside the repository root', async () => {
    const repo = makeFixtureRepo('go-workspace');
    const outside = join(repo, '..', 'outside-go-leak');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'go.mod'), 'module example.com/outside\n\ngo 1.22\n');
    writeFileSync(join(repo, 'go.work'), 'go 1.22\n\nuse (\n\t./modules/core\n\t../outside-go-leak\n)\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.deepEqual(result.projects.map(project => project.path), ['.', 'modules/cli', 'modules/core']);
    assert.equal(result.projects.some(project => project.packageName === 'example.com/outside'), false);
    assert.equal(result.projects.some(project => project.path.startsWith('..')), false);
  });

  it('does not follow symlink workspace members out of the repository root', async (t) => {
    const repo = makeFixtureRepo('go-workspace');
    const outside = join(repo, '..', 'outside-go-symlink');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'go.mod'), 'module example.com/outside\n\ngo 1.22\n');
    const link = join(repo, 'modules', 'escape');
    try {
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      t.skip('this environment cannot create a directory symlink or junction');
      return;
    }
    writeFileSync(join(repo, 'go.work'), 'go 1.22\n\nuse (\n\t./modules/core\n\t./modules/escape\n)\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.projects.some(project => project.packageName === 'example.com/outside'), false);
    assert.equal(result.projects.some(project => project.path === 'modules/escape'), false);
  });

  it('inspects a Gradle Java/Kotlin multi-project layout with modules and local signals', async () => {
    const repo = makeFixtureRepo('java-kotlin-gradle');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.command, 'repo inspect');
    assert.equal(result.kind, 'java-kotlin-multi-project');
    assert.deepEqual(result.projects.map(project => project.path), ['.', 'modules/app', 'modules/core']);
    assert.equal(result.projects.find(project => project.path === '.').kind, 'workspace');
    assert.equal(result.projects.find(project => project.path === '.').packageName, 'fixture-java-root');
    assert.equal(result.projects.find(project => project.path === 'modules/core').packageName, 'core');
    assert.equal(result.projects.find(project => project.path === 'modules/app').packageName, 'app');
    assert.ok(result.rootMarkers.some(marker => marker.path === 'settings.gradle.kts'));
    assert.ok(result.ciHints.some(hint => hint.path === '.github/workflows/ci.yml'));
    assert.ok(!result.warnings.some(warning => warning.includes('Affected-scope mapping is conservative')));
  });

  it('inspects a Maven Java/Kotlin multi-project layout with aggregator modules', async () => {
    const repo = makeFixtureRepo('java-kotlin-maven');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'java-kotlin-multi-project');
    assert.deepEqual(result.projects.map(project => project.path), ['.', 'modules/app', 'modules/core']);
    assert.equal(result.projects.find(project => project.path === '.').packageName, 'fixture-java-root');
    assert.equal(result.projects.find(project => project.path === 'modules/core').packageName, 'fixture-java-core');
    assert.equal(result.projects.find(project => project.path === 'modules/app').packageName, 'fixture-java-app');
    assert.ok(result.rootMarkers.some(marker => marker.path === 'pom.xml'));
  });

  it('maps changed paths to affected Java/Kotlin modules and suggested gates', async () => {
    const repo = makeFixtureRepo('java-kotlin-gradle');

    const result = await runRepoAffected({
      config: getDefaults(),
      cwd: repo,
      changedPaths: ['modules/core/src/main/kotlin/Core.kt', 'modules/app/build.gradle.kts', 'settings.gradle.kts'],
    });

    assert.equal(result.command, 'repo affected');
    assert.equal(result.layout.kind, 'java-kotlin-multi-project');
    assert.deepEqual(result.affectedProjects.map(project => project.project.id), ['fixture-java-root', 'app', 'core']);
    assert.deepEqual(result.affectedProjects.find(project => project.project.id === 'fixture-java-root').changedPaths, ['settings.gradle.kts']);
    assert.ok(result.affectedProjects.find(project => project.project.id === 'core').gates.includes('test'));
    assert.ok(result.affectedProjects.find(project => project.project.id === 'app').gates.includes('dependency-review'));
    assert.ok(result.suggestedGates.includes('dependency-review'));
  });

  it('keeps a Java/Kotlin multi-project when incidental Node tooling exists at the root', async () => {
    const repo = makeFixtureRepo('java-kotlin-gradle');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'node-tooling-root', private: true }, null, 2));

    const inspected = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(inspected.kind, 'java-kotlin-multi-project');
    assert.deepEqual(inspected.projects.map(project => project.path), ['.', 'modules/app', 'modules/core']);
    assert.equal(inspected.projects.find(project => project.path === '.').kind, 'workspace');
  });

  it('reports an ambiguous layout when Java/Kotlin and JavaScript workspaces both resolve members', async () => {
    const repo = makeFixtureRepo('java-kotlin-gradle');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'node-tooling-root', private: true, workspaces: ['tools/*'] }, null, 2));
    mkdirSync(join(repo, 'tools', 'cli'), { recursive: true });
    writeFileSync(join(repo, 'tools', 'cli', 'package.json'), JSON.stringify({ name: 'fixture-node-cli', private: true }, null, 2));

    const inspected = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(inspected.kind, 'unknown');
    assert.ok(inspected.warnings.some(warning => /both or neither resolve member projects; repository layout is ambiguous/.test(warning)));
  });

  it('does not classify nested Gradle modules without root settings as a multi-project', async () => {
    const repo = makeFixtureRepo('ambiguous-java-kotlin');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'unknown');
    assert.deepEqual(result.projects.map(project => project.path), ['modules/core']);
    assert.ok(result.warnings.some(warning => warning.includes('no root settings.gradle')));
  });

  it('does not classify a lone root pom.xml as a Java/Kotlin multi-project', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'pom.xml'), '<project>\n  <artifactId>lone-app</artifactId>\n</project>\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'single-app-service');
    assert.equal(result.projects.find(project => project.path === '.').kind, 'app');
  });

  it('does not classify settings without includes or members as a proven module set', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'settings.gradle.kts'), 'rootProject.name = "empty-settings"\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'java-kotlin-multi-project');
    assert.deepEqual(result.projects.map(project => project.path), ['.']);
    assert.ok(result.warnings.some(warning => warning.includes('no member module roots were resolved')));
  });

  it('keeps generated Gradle paths out of mutation scope', async () => {
    const repo = makeFixtureRepo('java-kotlin-gradle');
    mkdirSync(join(repo, '.gradle'), { recursive: true });
    writeFileSync(join(repo, '.gradle', 'fileHashes.bin'), 'generated\n');

    const result = await runRepoAffected({
      config: getDefaults(),
      cwd: repo,
      changedPaths: ['.gradle/fileHashes.bin'],
    });

    assert.deepEqual(result.affectedProjects, []);
    assert.ok(result.warnings.some(warning => warning.includes('did not map to a detected project')));
  });

  it('does not expand Gradle includes outside the repository root', async () => {
    const repo = makeFixtureRepo('java-kotlin-gradle');
    const outside = join(repo, '..', 'outside-java-leak');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'build.gradle.kts'), 'plugins { `java-library` }\n');
    writeFileSync(join(repo, 'settings.gradle.kts'), 'rootProject.name = "fixture-java-root"\ninclude(":modules:core")\ninclude(":modules:app")\ninclude("../outside-java-leak")\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.deepEqual(result.projects.map(project => project.path), ['.', 'modules/app', 'modules/core']);
    assert.equal(result.projects.some(project => project.path.startsWith('..')), false);
  });

  it('does not follow symlink Gradle members out of the repository root', async (t) => {
    const repo = makeFixtureRepo('java-kotlin-gradle');
    const outside = join(repo, '..', 'outside-java-symlink');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'build.gradle.kts'), 'plugins { `java-library` }\n');
    const link = join(repo, 'modules', 'escape');
    try {
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      t.skip('this environment cannot create a directory symlink or junction');
      return;
    }
    writeFileSync(join(repo, 'settings.gradle.kts'), 'rootProject.name = "fixture-java-root"\ninclude(":modules:core")\ninclude(":modules:escape")\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.projects.some(project => project.path === 'modules/escape'), false);
  });

  it('does not treat includeBuild paths as Gradle members', async () => {
    const repo = makeFixtureRepo('java-kotlin-gradle');
    mkdirSync(join(repo, 'tools', 'composite'), { recursive: true });
    writeFileSync(join(repo, 'tools', 'composite', 'build.gradle.kts'), 'plugins { base }\n');
    writeFileSync(join(repo, 'settings.gradle.kts'), 'rootProject.name = "fixture-java-root"\ninclude(":modules:core")\nincludeBuild("tools/composite")\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.projects.some(project => project.path === 'tools/composite'), false);
    assert.ok(result.projects.some(project => project.path === 'modules/core'));
  });

  it('inspects a .NET solution layout with projects and local signals', async () => {
    const repo = makeFixtureRepo('dotnet-solution');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.command, 'repo inspect');
    assert.equal(result.kind, 'dotnet-solution');
    assert.deepEqual(result.projects.map(project => project.path), ['.', 'src/App', 'src/Core']);
    assert.equal(result.projects.find(project => project.path === '.').kind, 'workspace');
    assert.equal(result.projects.find(project => project.path === '.').packageName, 'Fixture');
    assert.equal(result.projects.find(project => project.path === 'src/App').packageName, 'App');
    assert.equal(result.projects.find(project => project.path === 'src/Core').packageName, 'Core');
    assert.ok(result.rootMarkers.some(marker => marker.path === 'Fixture.sln'));
    assert.ok(result.rootMarkers.some(marker => marker.path === 'Directory.Build.props'));
    assert.ok(result.ciHints.some(hint => hint.path === '.github/workflows/ci.yml'));
    assert.ok(!result.warnings.some(warning => warning.includes('Affected-scope mapping is conservative')));
  });

  it('maps changed paths to affected .NET projects and suggested gates', async () => {
    const repo = makeFixtureRepo('dotnet-solution');

    const result = await runRepoAffected({
      config: getDefaults(),
      cwd: repo,
      changedPaths: ['src/Core/Class1.cs', 'src/App/App.csproj', 'Fixture.sln'],
    });

    assert.equal(result.command, 'repo affected');
    assert.equal(result.layout.kind, 'dotnet-solution');
    assert.deepEqual(result.affectedProjects.map(project => project.project.id), ['Fixture', 'App', 'Core']);
    assert.deepEqual(result.affectedProjects.find(project => project.project.id === 'Fixture').changedPaths, ['Fixture.sln']);
    assert.ok(result.affectedProjects.find(project => project.project.id === 'Core').gates.includes('test'));
    assert.ok(result.affectedProjects.find(project => project.project.id === 'App').gates.includes('dependency-review'));
    assert.ok(result.suggestedGates.includes('dependency-review'));
  });

  it('keeps a .NET solution when incidental Node tooling exists at the root', async () => {
    const repo = makeFixtureRepo('dotnet-solution');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'node-tooling-root', private: true }, null, 2));

    const inspected = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(inspected.kind, 'dotnet-solution');
    assert.deepEqual(inspected.projects.map(project => project.path), ['.', 'src/App', 'src/Core']);
  });

  it('reports an ambiguous layout when .NET and JavaScript workspaces both resolve members', async () => {
    const repo = makeFixtureRepo('dotnet-solution');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'node-tooling-root', private: true, workspaces: ['tools/*'] }, null, 2));
    mkdirSync(join(repo, 'tools', 'cli'), { recursive: true });
    writeFileSync(join(repo, 'tools', 'cli', 'package.json'), JSON.stringify({ name: 'fixture-node-cli', private: true }, null, 2));

    const inspected = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(inspected.kind, 'unknown');
    assert.ok(inspected.warnings.some(warning => /both or neither resolve member projects; repository layout is ambiguous/.test(warning)));
  });

  it('does not treat unlisted conventional .NET projects as solution members', async () => {
    const repo = makeFixtureRepo('dotnet-solution');
    mkdirSync(join(repo, 'src', 'Unlisted'), { recursive: true });
    writeFileSync(join(repo, 'src', 'Unlisted', 'Unlisted.csproj'), '<Project Sdk="Microsoft.NET.Sdk"></Project>\n');
    writeFileSync(join(repo, 'Fixture.sln'), 'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "App", "src\\App\\App.csproj", "{11111111-1111-1111-1111-111111111111}"\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'dotnet-solution');
    assert.deepEqual(result.projects.map(project => project.path), ['.', 'src/App']);
    assert.equal(result.projects.some(project => project.path === 'src/Unlisted'), false);
  });

  it('does not classify nested .NET projects without a root solution as a solution', async () => {
    const repo = makeFixtureRepo('ambiguous-dotnet-solution');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'unknown');
    assert.deepEqual(result.projects.map(project => project.path), ['src/App']);
    assert.ok(result.warnings.some(warning => warning.includes('no root .sln or .slnx was found')));
  });

  it('does not classify a lone root csproj as a .NET solution', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk"></Project>\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'single-app-service');
    assert.equal(result.projects.find(project => project.path === '.').kind, 'app');
  });

  it('keeps generated .NET bin and obj paths out of mutation scope', async () => {
    const repo = makeFixtureRepo('dotnet-solution');
    mkdirSync(join(repo, 'bin'), { recursive: true });
    writeFileSync(join(repo, 'bin', 'App.dll'), 'generated\n');

    const result = await runRepoAffected({
      config: getDefaults(),
      cwd: repo,
      changedPaths: ['bin/App.dll'],
    });

    assert.deepEqual(result.affectedProjects, []);
    assert.ok(result.warnings.some(warning => warning.includes('did not map to a detected project')));
  });

  it('does not expand .NET solution members outside the repository root', async () => {
    const repo = makeFixtureRepo('dotnet-solution');
    const outside = join(repo, '..', 'outside-dotnet-leak');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'Leak.csproj'), '<Project Sdk="Microsoft.NET.Sdk"></Project>\n');
    writeFileSync(join(repo, 'Fixture.sln'), 'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "App", "src\\App\\App.csproj", "{11111111-1111-1111-1111-111111111111}"\nProject("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Leak", "..\\outside-dotnet-leak\\Leak.csproj", "{33333333-3333-3333-3333-333333333333}"\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.deepEqual(result.projects.map(project => project.path), ['.', 'src/App']);
    assert.equal(result.projects.some(project => project.path.startsWith('..')), false);
  });

  it('does not follow symlink .NET members out of the repository root', async (t) => {
    const repo = makeFixtureRepo('dotnet-solution');
    const outside = join(repo, '..', 'outside-dotnet-symlink');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'Escape.csproj'), '<Project Sdk="Microsoft.NET.Sdk"></Project>\n');
    const link = join(repo, 'src', 'Escape');
    try {
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      t.skip('this environment cannot create a directory symlink or junction');
      return;
    }
    writeFileSync(join(repo, 'Fixture.sln'), 'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "App", "src\\App\\App.csproj", "{11111111-1111-1111-1111-111111111111}"\nProject("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Escape", "src\\Escape\\Escape.csproj", "{44444444-4444-4444-4444-444444444444}"\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.projects.some(project => project.path === 'src/Escape'), false);
  });

  it('inspects a Bazel monorepo layout with packages and local signals', async () => {
    const repo = makeFixtureRepo('bazel-monorepo');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.command, 'repo inspect');
    assert.equal(result.kind, 'bazel-pants-buck-monorepo');
    assert.deepEqual(result.projects.map(project => project.path), ['.', 'apps/cli', 'packages/core']);
    assert.equal(result.projects.find(project => project.path === '.').kind, 'workspace');
    assert.equal(result.projects.find(project => project.path === '.').packageName, 'fixture_bazel_root');
    assert.equal(result.projects.find(project => project.path === 'apps/cli').packageName, 'cli');
    assert.equal(result.projects.find(project => project.path === 'packages/core').packageName, 'core');
    assert.ok(result.rootMarkers.some(marker => marker.path === 'MODULE.bazel'));
    assert.ok(result.rootMarkers.some(marker => marker.path === 'WORKSPACE'));
    assert.ok(result.ciHints.some(hint => hint.path === '.github/workflows/ci.yml'));
    assert.ok(!result.warnings.some(warning => warning.includes('Affected-scope mapping is conservative')));
    assert.ok(result.warnings.some(warning => warning.includes('target graphs are not inferred')));
  });

  it('inspects a Pants monorepo layout from pants.toml source roots', async () => {
    const repo = makeFixtureRepo('pants-monorepo');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'bazel-pants-buck-monorepo');
    assert.deepEqual(result.projects.map(project => project.path), ['.', 'apps/cli', 'packages/core']);
    assert.equal(result.projects.find(project => project.path === '.').kind, 'workspace');
    assert.equal(result.projects.find(project => project.path === 'packages/core').packageName, 'core');
    assert.ok(result.rootMarkers.some(marker => marker.path === 'pants.toml'));
  });

  it('inspects a Buck monorepo layout from .buckconfig and BUCK packages', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, '.buckconfig'), '[project]\n');
    mkdirSync(join(repo, 'apps', 'cli'), { recursive: true });
    writeFileSync(join(repo, 'apps', 'cli', 'BUCK'), 'cxx_binary(name = "cli")\n');
    writeFileSync(join(repo, 'apps', 'cli', 'main.cc'), 'int main() { return 0; }\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'bazel-pants-buck-monorepo');
    assert.deepEqual(result.projects.map(project => project.path), ['.', 'apps/cli']);
    assert.ok(result.rootMarkers.some(marker => marker.path === '.buckconfig'));
  });

  it('maps changed paths to affected Bazel packages and suggested gates', async () => {
    const repo = makeFixtureRepo('bazel-monorepo');

    const result = await runRepoAffected({
      config: getDefaults(),
      cwd: repo,
      changedPaths: ['packages/core/lib.cc', 'apps/cli/BUILD', 'MODULE.bazel'],
    });

    assert.equal(result.command, 'repo affected');
    assert.equal(result.layout.kind, 'bazel-pants-buck-monorepo');
    assert.deepEqual(result.affectedProjects.map(project => project.project.id), ['fixture_bazel_root', 'cli', 'core']);
    assert.deepEqual(result.affectedProjects.find(project => project.project.id === 'fixture_bazel_root').changedPaths, ['MODULE.bazel']);
    assert.ok(result.affectedProjects.find(project => project.project.id === 'core').gates.includes('test'));
    assert.ok(result.affectedProjects.find(project => project.project.id === 'cli').gates.includes('dependency-review'));
    assert.ok(result.suggestedGates.includes('dependency-review'));
  });

  it('keeps a Bazel monorepo when incidental Node tooling exists at the root', async () => {
    const repo = makeFixtureRepo('bazel-monorepo');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'node-tooling-root', private: true }, null, 2));

    const inspected = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(inspected.kind, 'bazel-pants-buck-monorepo');
    assert.deepEqual(inspected.projects.map(project => project.path), ['.', 'apps/cli', 'packages/core']);
    assert.equal(inspected.projects.find(project => project.path === '.').kind, 'workspace');
  });

  it('reports an ambiguous layout when Bazel and JavaScript workspaces both resolve members', async () => {
    const repo = makeFixtureRepo('bazel-monorepo');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'node-tooling-root', private: true, workspaces: ['tools/*'] }, null, 2));
    mkdirSync(join(repo, 'tools', 'cli'), { recursive: true });
    writeFileSync(join(repo, 'tools', 'cli', 'package.json'), JSON.stringify({ name: 'fixture-node-cli', private: true }, null, 2));

    const inspected = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(inspected.kind, 'unknown');
    assert.ok(inspected.warnings.some(warning => /both or neither resolve member projects; repository layout is ambiguous/.test(warning)));
  });

  it('does not treat unlisted conventional BUILD packages as Pants members', async () => {
    const repo = makeFixtureRepo('pants-monorepo');
    mkdirSync(join(repo, 'services', 'api'), { recursive: true });
    writeFileSync(join(repo, 'services', 'api', 'BUILD'), 'python_sources()\n');
    writeFileSync(join(repo, 'pants.toml'), '[GLOBAL]\npants_version = "2.22.0"\n\n[source]\nroot_patterns = [\n  "/apps",\n]\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'bazel-pants-buck-monorepo');
    assert.deepEqual(result.projects.map(project => project.path), ['.', 'apps/cli']);
    assert.equal(result.projects.some(project => project.path === 'packages/core'), false);
    assert.equal(result.projects.some(project => project.path === 'services/api'), false);
  });

  it('does not classify nested BUILD packages without a root workspace proof as a monorepo', async () => {
    const repo = makeFixtureRepo('ambiguous-bazel-pants-buck');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'unknown');
    assert.deepEqual(result.projects.map(project => project.path), ['packages/core']);
    assert.ok(result.warnings.some(warning => warning.includes('no root MODULE.bazel')));
  });

  it('does not classify a lone root BUILD file as a Bazel monorepo', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'BUILD'), 'package(default_visibility = ["//visibility:public"])\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.notEqual(result.kind, 'bazel-pants-buck-monorepo');
    assert.equal(result.projects.some(project => project.path === '.' && project.kind === 'workspace'), false);
  });

  it('does not classify MODULE.bazel without packages as a proven package set', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'MODULE.bazel'), 'module(name = "empty-module")\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'bazel-pants-buck-monorepo');
    assert.deepEqual(result.projects.map(project => project.path), ['.']);
    assert.ok(result.warnings.some(warning => warning.includes('no member package roots were resolved')));
  });

  it('keeps generated Bazel output paths out of mutation scope', async () => {
    const repo = makeFixtureRepo('bazel-monorepo');
    mkdirSync(join(repo, 'bazel-bin'), { recursive: true });
    writeFileSync(join(repo, 'bazel-bin', 'cli'), 'generated\n');

    const result = await runRepoAffected({
      config: getDefaults(),
      cwd: repo,
      changedPaths: ['bazel-bin/cli'],
    });

    assert.deepEqual(result.affectedProjects, []);
    assert.ok(result.warnings.some(warning => warning.includes('did not map to a detected project')));
  });

  it('does not treat Bazel local_path_override or members outside the repository root as projects', async () => {
    const repo = makeFixtureRepo('bazel-monorepo');
    const outside = join(repo, '..', 'outside-bazel-leak');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'BUILD'), 'package(default_visibility = ["//visibility:public"])\n');
    writeFileSync(join(repo, 'MODULE.bazel'), 'module(\n    name = "fixture_bazel_root",\n    version = "0.0.0",\n)\n\nlocal_path_override(\n    module_name = "leak",\n    path = "../outside-bazel-leak",\n)\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.deepEqual(result.projects.map(project => project.path), ['.', 'apps/cli', 'packages/core']);
    assert.equal(result.projects.some(project => project.path.startsWith('..')), false);
    assert.equal(result.projects.some(project => project.path.includes('outside-bazel-leak')), false);
  });

  it('does not follow symlink Bazel packages out of the repository root', async (t) => {
    const repo = makeFixtureRepo('bazel-monorepo');
    const outside = join(repo, '..', 'outside-bazel-symlink');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'BUILD'), 'package(default_visibility = ["//visibility:public"])\n');
    const link = join(repo, 'packages', 'escape');
    try {
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      t.skip('this environment cannot create a directory symlink or junction');
      return;
    }

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.projects.some(project => project.path === 'packages/escape'), false);
  });

  it('inspects a CMake superbuild layout with projects and local signals', async () => {
    const repo = makeFixtureRepo('cmake-superbuild');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.command, 'repo inspect');
    assert.equal(result.kind, 'c-cpp-cmake-superbuild');
    assert.deepEqual(result.projects.map(project => project.path), ['.', 'apps/cli', 'packages/core']);
    assert.equal(result.projects.find(project => project.path === '.').kind, 'workspace');
    assert.equal(result.projects.find(project => project.path === '.').packageName, 'fixture_cmake_root');
    assert.equal(result.projects.find(project => project.path === 'apps/cli').packageName, 'cli');
    assert.equal(result.projects.find(project => project.path === 'packages/core').packageName, 'core');
    assert.ok(result.rootMarkers.some(marker => marker.path === 'CMakeLists.txt'));
    assert.ok(result.rootMarkers.some(marker => marker.path === 'CMakePresets.json'));
    assert.ok(result.ciHints.some(hint => hint.path === '.github/workflows/ci.yml'));
    assert.ok(!result.warnings.some(warning => warning.includes('Affected-scope mapping is conservative')));
  });

  it('maps changed paths to affected CMake projects and suggested gates', async () => {
    const repo = makeFixtureRepo('cmake-superbuild');

    const result = await runRepoAffected({
      config: getDefaults(),
      cwd: repo,
      changedPaths: ['packages/core/lib.cpp', 'apps/cli/CMakeLists.txt', 'CMakeLists.txt'],
    });

    assert.equal(result.command, 'repo affected');
    assert.equal(result.layout.kind, 'c-cpp-cmake-superbuild');
    assert.deepEqual(result.affectedProjects.map(project => project.project.id), ['fixture_cmake_root', 'cli', 'core']);
    assert.deepEqual(result.affectedProjects.find(project => project.project.id === 'fixture_cmake_root').changedPaths, ['CMakeLists.txt']);
    assert.ok(result.affectedProjects.find(project => project.project.id === 'core').gates.includes('test'));
    assert.ok(result.affectedProjects.find(project => project.project.id === 'cli').gates.includes('dependency-review'));
    assert.ok(result.suggestedGates.includes('dependency-review'));
  });

  it('keeps a CMake superbuild when incidental Node tooling exists at the root', async () => {
    const repo = makeFixtureRepo('cmake-superbuild');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'node-tooling-root', private: true }, null, 2));

    const inspected = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(inspected.kind, 'c-cpp-cmake-superbuild');
    assert.deepEqual(inspected.projects.map(project => project.path), ['.', 'apps/cli', 'packages/core']);
    assert.equal(inspected.projects.find(project => project.path === '.').kind, 'workspace');
  });

  it('reports an ambiguous layout when CMake and JavaScript workspaces both resolve members', async () => {
    const repo = makeFixtureRepo('cmake-superbuild');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'node-tooling-root', private: true, workspaces: ['tools/*'] }, null, 2));
    mkdirSync(join(repo, 'tools', 'cli'), { recursive: true });
    writeFileSync(join(repo, 'tools', 'cli', 'package.json'), JSON.stringify({ name: 'fixture-node-cli', private: true }, null, 2));

    const inspected = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(inspected.kind, 'unknown');
    assert.ok(inspected.warnings.some(warning => /both or neither resolve member projects; repository layout is ambiguous/.test(warning)));
  });

  it('does not treat unlisted conventional CMake projects as superbuild members', async () => {
    const repo = makeFixtureRepo('cmake-superbuild');
    mkdirSync(join(repo, 'services', 'api'), { recursive: true });
    writeFileSync(join(repo, 'services', 'api', 'CMakeLists.txt'), 'add_library(api api.cpp)\n');
    writeFileSync(join(repo, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\nproject(fixture_cmake_root)\nadd_subdirectory(apps/cli)\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'c-cpp-cmake-superbuild');
    assert.deepEqual(result.projects.map(project => project.path), ['.', 'apps/cli']);
    assert.equal(result.projects.some(project => project.path === 'packages/core'), false);
    assert.equal(result.projects.some(project => project.path === 'services/api'), false);
  });

  it('does not classify nested CMake projects without root add_subdirectory as a superbuild', async () => {
    const repo = makeFixtureRepo('ambiguous-cmake-superbuild');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'unknown');
    assert.deepEqual(result.projects.map(project => project.path), ['apps/cli']);
    assert.ok(result.warnings.some(warning => warning.includes('no root CMakeLists.txt add_subdirectory')));
  });

  it('recognizes case-insensitive CMake add_subdirectory commands', async () => {
    const repo = makeFixtureRepo('cmake-superbuild');
    writeFileSync(join(repo, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\nproject(fixture_cmake_root)\nAdd_Subdirectory(apps/cli)\nADD_SUBDIRECTORY("packages/core")\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'c-cpp-cmake-superbuild');
    assert.deepEqual(result.projects.map(project => project.path), ['.', 'apps/cli', 'packages/core']);
  });

  it('does not treat commented CMake add_subdirectory lines as superbuild proof', async () => {
    const repo = makeFixtureRepo('ambiguous-cmake-superbuild');
    writeFileSync(join(repo, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\nproject(commented_root)\n# add_subdirectory(apps/cli)\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.notEqual(result.kind, 'c-cpp-cmake-superbuild');
    assert.equal(result.kind, 'single-app-service');
    assert.ok(result.warnings.some(warning => warning.includes('no root CMakeLists.txt add_subdirectory')));
  });

  it('does not classify a lone root CMakeLists.txt as a CMake superbuild', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\nproject(lone_app)\nadd_executable(lone main.cpp)\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'single-app-service');
    assert.equal(result.projects.find(project => project.path === '.').kind, 'app');
  });

  it('does not classify FetchContent-only CMake as a proven member set', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\nproject(fetch_only)\ninclude(FetchContent)\nFetchContent_Declare(dep GIT_REPOSITORY https://example.invalid/dep.git)\nFetchContent_MakeAvailable(dep)\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'c-cpp-cmake-superbuild');
    assert.deepEqual(result.projects.map(project => project.path), ['.']);
    assert.ok(result.warnings.some(warning => warning.includes('no member project roots were resolved')));
  });

  it('keeps generated CMake output paths out of mutation scope', async () => {
    const repo = makeFixtureRepo('cmake-superbuild');
    mkdirSync(join(repo, 'cmake-build-debug'), { recursive: true });
    writeFileSync(join(repo, 'cmake-build-debug', 'cli'), 'generated\n');

    const result = await runRepoAffected({
      config: getDefaults(),
      cwd: repo,
      changedPaths: ['cmake-build-debug/cli'],
    });

    assert.deepEqual(result.affectedProjects, []);
    assert.ok(result.warnings.some(warning => warning.includes('did not map to a detected project')));
  });

  it('does not expand CMake add_subdirectory members outside the repository root', async () => {
    const repo = makeFixtureRepo('cmake-superbuild');
    const outside = join(repo, '..', 'outside-cmake-leak');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'CMakeLists.txt'), 'add_library(leak leak.cpp)\n');
    writeFileSync(join(repo, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\nproject(fixture_cmake_root)\nadd_subdirectory(apps/cli)\nadd_subdirectory(../outside-cmake-leak)\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.deepEqual(result.projects.map(project => project.path), ['.', 'apps/cli']);
    assert.equal(result.projects.some(project => project.path.startsWith('..')), false);
  });

  it('does not follow symlink CMake members out of the repository root', async (t) => {
    const repo = makeFixtureRepo('cmake-superbuild');
    const outside = join(repo, '..', 'outside-cmake-symlink');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'CMakeLists.txt'), 'add_library(escape escape.cpp)\n');
    const link = join(repo, 'packages', 'escape');
    try {
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      t.skip('this environment cannot create a directory symlink or junction');
      return;
    }
    writeFileSync(join(repo, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\nproject(fixture_cmake_root)\nadd_subdirectory(apps/cli)\nadd_subdirectory(packages/escape)\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.projects.some(project => project.path === 'packages/escape'), false);
  });

  it('inspects a mobile app repo layout with platform projects and local signals', async () => {
    const repo = makeFixtureRepo('mobile-app');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.command, 'repo inspect');
    assert.equal(result.kind, 'mobile-app-repo');
    assert.deepEqual(result.projects.map(project => project.path), ['.', 'android', 'ios']);
    assert.equal(result.projects.find(project => project.path === '.').kind, 'workspace');
    assert.equal(result.projects.find(project => project.path === '.').packageName, 'fixture-mobile');
    assert.equal(result.projects.find(project => project.path === 'android').packageName, 'android');
    assert.equal(result.projects.find(project => project.path === 'ios').packageName, 'ios');
    assert.ok(result.rootMarkers.some(marker => marker.path === 'app.json'));
    assert.ok(result.ciHints.some(hint => hint.path === '.github/workflows/ci.yml'));
    assert.ok(!result.warnings.some(warning => warning.includes('Affected-scope mapping is conservative')));
  });

  it('maps changed paths to affected mobile platform projects and suggested gates', async () => {
    const repo = makeFixtureRepo('mobile-app');

    const result = await runRepoAffected({
      config: getDefaults(),
      cwd: repo,
      changedPaths: ['android/app/src/main/AndroidManifest.xml', 'ios/App.swift', 'app.json'],
    });

    assert.equal(result.command, 'repo affected');
    assert.equal(result.layout.kind, 'mobile-app-repo');
    assert.deepEqual(result.affectedProjects.map(project => project.project.id), ['fixture-mobile', 'android', 'ios']);
    assert.deepEqual(result.affectedProjects.find(project => project.project.id === 'fixture-mobile').changedPaths, ['app.json']);
    assert.ok(result.affectedProjects.find(project => project.project.id === 'android').gates.includes('dependency-review'));
    assert.ok(result.affectedProjects.find(project => project.project.id === 'ios').gates.includes('test'));
    assert.ok(result.suggestedGates.includes('dependency-review'));
  });

  it('keeps a mobile app repo when incidental Node tooling exists at the root', async () => {
    const repo = makeFixtureRepo('mobile-app');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'node-tooling-root', private: true }, null, 2));

    const inspected = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(inspected.kind, 'mobile-app-repo');
    assert.deepEqual(inspected.projects.map(project => project.path), ['.', 'android', 'ios']);
  });

  it('reports an ambiguous layout when mobile and JavaScript workspaces both resolve members', async () => {
    const repo = makeFixtureRepo('mobile-app');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'node-tooling-root', private: true, workspaces: ['tools/*'] }, null, 2));
    mkdirSync(join(repo, 'tools', 'cli'), { recursive: true });
    writeFileSync(join(repo, 'tools', 'cli', 'package.json'), JSON.stringify({ name: 'fixture-node-cli', private: true }, null, 2));

    const inspected = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(inspected.kind, 'unknown');
    assert.ok(inspected.warnings.some(warning => /both or neither resolve member projects; repository layout is ambiguous/.test(warning)));
  });

  it('does not classify nested Android trees without a root mobile proof as a mobile app', async () => {
    const repo = makeFixtureRepo('ambiguous-mobile-app');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'unknown');
    assert.deepEqual(result.projects.map(project => project.path), ['android']);
    assert.ok(result.warnings.some(warning => warning.includes('no root Android settings')));
  });

  it('classifies a native Android Gradle app as a mobile app repo', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'settings.gradle'), 'rootProject.name = "native-android"\ninclude(":app")\n');
    mkdirSync(join(repo, 'app', 'src', 'main'), { recursive: true });
    writeFileSync(join(repo, 'app', 'build.gradle'), 'plugins { id("com.android.application") }\n');
    writeFileSync(join(repo, 'app', 'src', 'main', 'AndroidManifest.xml'), '<manifest package="fixture.android" />\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'mobile-app-repo');
    assert.ok(result.projects.some(project => project.path === 'app'));
    assert.equal(result.projects.find(project => project.path === '.').packageName, 'native-android');
  });

  it('does not classify a lone Expo config without platform trees as a mobile app', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'app.json'), JSON.stringify({ name: 'config-only', expo: { name: 'config-only' } }, null, 2));

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.notEqual(result.kind, 'mobile-app-repo');
  });

  it('does not classify a non-mobile Package.swift as a mobile app repo', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'Package.swift'), '// swift-tools-version: 5.9\nimport PackageDescription\nlet package = Package(name: "Lib")\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.notEqual(result.kind, 'mobile-app-repo');
  });

  it('does not classify a generic Java/Kotlin workspace as a mobile app repo', async () => {
    const repo = makeFixtureRepo('java-kotlin-gradle');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'java-kotlin-multi-project');
  });

  it('does not treat an empty android directory as mobile proof over a Java workspace', async () => {
    const repo = makeFixtureRepo('java-kotlin-gradle');
    mkdirSync(join(repo, 'android'), { recursive: true });

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'java-kotlin-multi-project');
    assert.equal(result.projects.some(project => project.path === 'android'), false);
  });

  it('classifies a root Xcode project as a mobile app repo', async () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, 'Fixture.xcodeproj'), { recursive: true });
    writeFileSync(join(repo, 'Fixture.xcodeproj', 'project.pbxproj'), '// !$*UTF8*$!\n');
    mkdirSync(join(repo, 'ios'), { recursive: true });
    writeFileSync(join(repo, 'ios', 'App.swift'), 'print("fixture")\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'mobile-app-repo');
    assert.ok(result.rootMarkers.some(marker => marker.path === 'Fixture.xcodeproj'));
    assert.ok(result.projects.some(project => project.path === 'ios'));
  });

  it('does not classify Java/Kotlin settings plus an empty android directory as a mobile app', async () => {
    const repo = makeFixtureRepo('java-kotlin-gradle');
    mkdirSync(join(repo, 'android'), { recursive: true });

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'java-kotlin-multi-project');
    assert.notEqual(result.kind, 'mobile-app-repo');
  });

  it('classifies Expo config plus an ios source tree as a mobile app repo', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'app.json'), JSON.stringify({ name: 'expo-ios', expo: { name: 'expo-ios' } }, null, 2));
    mkdirSync(join(repo, 'ios'), { recursive: true });
    writeFileSync(join(repo, 'ios', 'App.swift'), 'print("app")\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'mobile-app-repo');
    assert.ok(result.projects.some(project => project.path === 'ios'));
  });

  it('does not classify Expo config plus an empty android directory as a mobile app', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'app.json'), JSON.stringify({ name: 'empty-android', expo: { name: 'empty-android' } }, null, 2));
    mkdirSync(join(repo, 'android'), { recursive: true });

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.notEqual(result.kind, 'mobile-app-repo');
  });

  it('classifies a root Xcode project as a mobile app repo', async () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, 'Fixture.xcodeproj'), { recursive: true });
    writeFileSync(join(repo, 'Fixture.xcodeproj', 'project.pbxproj'), '// xcode\n');
    writeFileSync(join(repo, 'App.swift'), 'print("app")\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'mobile-app-repo');
    assert.equal(result.projects.find(project => project.path === '.').packageName, 'Fixture');
  });

  it('keeps generated mobile DerivedData paths out of mutation scope', async () => {
    const repo = makeFixtureRepo('mobile-app');
    mkdirSync(join(repo, 'DerivedData'), { recursive: true });
    writeFileSync(join(repo, 'DerivedData', 'build.log'), 'generated\n');

    const result = await runRepoAffected({
      config: getDefaults(),
      cwd: repo,
      changedPaths: ['DerivedData/build.log'],
    });

    assert.deepEqual(result.affectedProjects, []);
    assert.ok(result.warnings.some(warning => warning.includes('did not map to a detected project')));
  });

  it('does not follow symlink mobile members out of the repository root', async (t) => {
    const repo = makeFixtureRepo('mobile-app');
    const outside = join(repo, '..', 'outside-mobile-symlink');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'App.swift'), 'print("escape")\n');
    const link = join(repo, 'ios');
    try {
      // Replace the in-repo ios tree with an escaped junction/symlink.
      rmSync(link, { recursive: true, force: true });
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      t.skip('this environment cannot create a directory symlink or junction');
      return;
    }

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.projects.some(project => project.path === 'ios'), false);
  });

  it('inspects an infrastructure repo layout with modules and local signals', async () => {
    const repo = makeFixtureRepo('infrastructure-repo');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.command, 'repo inspect');
    assert.equal(result.kind, 'infrastructure-repo');
    assert.deepEqual(result.projects.map(project => project.path), ['.', 'modules/app', 'modules/network']);
    assert.equal(result.projects.find(project => project.path === '.').kind, 'workspace');
    assert.equal(result.projects.find(project => project.path === '.').packageName, 'fixture-infra');
    assert.equal(result.projects.find(project => project.path === 'modules/network').packageName, 'network');
    assert.equal(result.projects.find(project => project.path === 'modules/app').packageName, 'app');
    assert.ok(result.rootMarkers.some(marker => marker.path === 'main.tf'));
    assert.ok(result.ciHints.some(hint => hint.path === '.github/workflows/ci.yml'));
    assert.ok(!result.warnings.some(warning => warning.includes('Affected-scope mapping is conservative')));
  });

  it('maps changed paths to affected infrastructure modules and suggested gates', async () => {
    const repo = makeFixtureRepo('infrastructure-repo');

    const result = await runRepoAffected({
      config: getDefaults(),
      cwd: repo,
      changedPaths: ['modules/network/main.tf', 'modules/app/main.tf', 'main.tf'],
    });

    assert.equal(result.command, 'repo affected');
    assert.equal(result.layout.kind, 'infrastructure-repo');
    assert.deepEqual(result.affectedProjects.map(project => project.project.id), ['fixture-infra', 'app', 'network']);
    assert.deepEqual(result.affectedProjects.find(project => project.project.id === 'fixture-infra').changedPaths, ['main.tf']);
    assert.ok(result.affectedProjects.find(project => project.project.id === 'network').gates.includes('dependency-review'));
    assert.ok(result.affectedProjects.find(project => project.project.id === 'app').gates.includes('dependency-review'));
    assert.ok(result.suggestedGates.includes('dependency-review'));
  });

  it('keeps an infrastructure repo when incidental Node tooling exists at the root', async () => {
    const repo = makeFixtureRepo('infrastructure-repo');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'node-tooling-root', private: true }, null, 2));

    const inspected = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(inspected.kind, 'infrastructure-repo');
    assert.deepEqual(inspected.projects.map(project => project.path), ['.', 'modules/app', 'modules/network']);
  });

  it('reports an ambiguous layout when infrastructure and JavaScript workspaces both resolve members', async () => {
    const repo = makeFixtureRepo('infrastructure-repo');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'node-tooling-root', private: true, workspaces: ['tools/*'] }, null, 2));
    mkdirSync(join(repo, 'tools', 'cli'), { recursive: true });
    writeFileSync(join(repo, 'tools', 'cli', 'package.json'), JSON.stringify({ name: 'fixture-node-cli', private: true }, null, 2));

    const inspected = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(inspected.kind, 'unknown');
    assert.ok(inspected.warnings.some(warning => /both or neither resolve member projects; repository layout is ambiguous/.test(warning)));
  });

  it('does not classify nested Terraform modules without a root proof as an infrastructure repo', async () => {
    const repo = makeFixtureRepo('ambiguous-infrastructure-repo');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'unknown');
    assert.deepEqual(result.projects.map(project => project.path), ['modules/network']);
    assert.ok(result.warnings.some(warning => warning.includes('no root Terraform')));
  });

  it('classifies a root Pulumi stack as an infrastructure repo', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'Pulumi.yaml'), 'name: fixture-pulumi\nruntime: nodejs\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'infrastructure-repo');
    assert.equal(result.projects.find(project => project.path === '.').packageName, 'fixture-pulumi');
  });

  it('does not treat commented Terraform module sources as declared members', async () => {
    const repo = makeFixtureRepo('infrastructure-repo');
    mkdirSync(join(repo, 'modules', 'old'), { recursive: true });
    writeFileSync(join(repo, 'modules', 'old', 'main.tf'), 'variable "old" { type = string }\n');
    writeFileSync(join(repo, 'main.tf'), 'locals {\n  name = "fixture-infra"\n}\n\n# source = "./modules/old"\n\nmodule "network" {\n  source = "./modules/network"\n}\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'infrastructure-repo');
    assert.deepEqual(result.projects.map(project => project.path), ['.', 'modules/network']);
    assert.equal(result.projects.some(project => project.path === 'modules/old'), false);
  });

  it('maps Ansible playbook changes to the infrastructure dependency-review gate', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'playbook.yml'), '- hosts: all\n  tasks: []\n');

    const result = await runRepoAffected({
      config: getDefaults(),
      cwd: repo,
      changedPaths: ['playbook.yml'],
    });

    assert.equal(result.layout.kind, 'infrastructure-repo');
    assert.ok(result.suggestedGates.includes('dependency-review'));
  });

  it('does not classify a lone Terraform file without modules as an infrastructure repo', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'main.tf'), 'locals { name = "lone" }\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.notEqual(result.kind, 'infrastructure-repo');
  });

  it('keeps generated Terraform paths out of mutation scope', async () => {
    const repo = makeFixtureRepo('infrastructure-repo');
    mkdirSync(join(repo, '.terraform'), { recursive: true });
    writeFileSync(join(repo, '.terraform', 'providers.json'), '{}\n');

    const result = await runRepoAffected({
      config: getDefaults(),
      cwd: repo,
      changedPaths: ['.terraform/providers.json'],
    });

    assert.deepEqual(result.affectedProjects, []);
    assert.ok(result.warnings.some(warning => warning.includes('did not map to a detected project')));
  });

  it('does not expand Terraform module members outside the repository root', async () => {
    const repo = makeFixtureRepo('infrastructure-repo');
    const outside = join(repo, '..', 'outside-infra-leak');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'main.tf'), 'variable "leak" { type = string }\n');
    writeFileSync(join(repo, 'main.tf'), 'locals {\n  name = "fixture-infra"\n}\n\nmodule "network" {\n  source = "./modules/network"\n}\n\nmodule "leak" {\n  source = "../outside-infra-leak"\n}\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.deepEqual(result.projects.map(project => project.path), ['.', 'modules/network']);
    assert.equal(result.projects.some(project => project.path.startsWith('..')), false);
  });

  it('does not follow symlink infrastructure members out of the repository root', async (t) => {
    const repo = makeFixtureRepo('infrastructure-repo');
    const outside = join(repo, '..', 'outside-infra-symlink');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'main.tf'), 'variable "escape" { type = string }\n');
    const link = join(repo, 'modules', 'app');
    try {
      rmSync(link, { recursive: true, force: true });
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      t.skip('this environment cannot create a directory symlink or junction');
      return;
    }

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.projects.some(project => project.path === 'modules/app'), false);
  });

  it('inspects a docs content repo layout with docs projects and local signals', async () => {
    const repo = makeFixtureRepo('docs-content-repo');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.command, 'repo inspect');
    assert.equal(result.kind, 'docs-content-repo');
    assert.deepEqual(result.projects.map(project => project.path), ['.', 'docs']);
    assert.equal(result.projects.find(project => project.path === '.').kind, 'workspace');
    assert.equal(result.projects.find(project => project.path === '.').packageName, 'fixture-docs');
    assert.equal(result.projects.find(project => project.path === 'docs').packageName, 'docs');
    assert.ok(result.rootMarkers.some(marker => marker.path === 'mkdocs.yml'));
    assert.ok(result.ciHints.some(hint => hint.path === '.github/workflows/ci.yml'));
    assert.ok(!result.warnings.some(warning => warning.includes('Affected-scope mapping is conservative')));
  });

  it('maps changed paths to affected docs projects and suggested gates', async () => {
    const repo = makeFixtureRepo('docs-content-repo');

    const result = await runRepoAffected({
      config: getDefaults(),
      cwd: repo,
      changedPaths: ['docs/guide.md', 'mkdocs.yml'],
    });

    assert.equal(result.command, 'repo affected');
    assert.equal(result.layout.kind, 'docs-content-repo');
    assert.deepEqual(result.affectedProjects.map(project => project.project.id), ['fixture-docs', 'docs']);
    assert.deepEqual(result.affectedProjects.find(project => project.project.id === 'fixture-docs').changedPaths, ['mkdocs.yml']);
    assert.ok(result.affectedProjects.find(project => project.project.id === 'docs').gates.includes('docs'));
    assert.ok(result.suggestedGates.includes('dependency-review'));
  });

  it('keeps a docs content repo when incidental Node tooling exists at the root', async () => {
    const repo = makeFixtureRepo('docs-content-repo');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'node-tooling-root', private: true }, null, 2));

    const inspected = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(inspected.kind, 'docs-content-repo');
    assert.deepEqual(inspected.projects.map(project => project.path), ['.', 'docs']);
  });

  it('reports an ambiguous layout when docs and JavaScript workspaces both resolve members', async () => {
    const repo = makeFixtureRepo('docs-content-repo');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'node-tooling-root', private: true, workspaces: ['tools/*'] }, null, 2));
    mkdirSync(join(repo, 'tools', 'cli'), { recursive: true });
    writeFileSync(join(repo, 'tools', 'cli', 'package.json'), JSON.stringify({ name: 'fixture-node-cli', private: true }, null, 2));

    const inspected = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(inspected.kind, 'unknown');
    assert.ok(inspected.warnings.some(warning => /both or neither resolve member projects; repository layout is ambiguous/.test(warning)));
  });

  it('does not classify nested docs trees without a root proof as a docs content repo', async () => {
    const repo = makeFixtureRepo('ambiguous-docs-content-repo');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'unknown');
    assert.deepEqual(result.projects.map(project => project.path), ['website']);
    assert.ok(result.warnings.some(warning => warning.includes('no root Docusaurus')));
  });

  it('does not classify a root app project plus docs as a docs content repo', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk"></Project>\n');
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'index.md'), '# docs\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'single-app-service');
    assert.notEqual(result.kind, 'docs-content-repo');
  });

  it('does not classify a generic JavaScript workspace as a docs content repo', async () => {
    const repo = makeFixtureRepo('js-workspace');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'javascript-typescript-workspace');
    assert.notEqual(result.kind, 'docs-content-repo');
  });

  it('keeps generated docs build paths out of mutation scope', async () => {
    const repo = makeFixtureRepo('docs-content-repo');
    mkdirSync(join(repo, '_build'), { recursive: true });
    writeFileSync(join(repo, '_build', 'index.html'), '<html></html>\n');

    const result = await runRepoAffected({
      config: getDefaults(),
      cwd: repo,
      changedPaths: ['_build/index.html'],
    });

    assert.deepEqual(result.affectedProjects, []);
    assert.ok(result.warnings.some(warning => warning.includes('did not map to a detected project')));
  });

  it('does not follow symlink docs members out of the repository root', async (t) => {
    const repo = makeFixtureRepo('docs-content-repo');
    const outside = join(repo, '..', 'outside-docs-symlink');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'index.md'), '# escape\n');
    const link = join(repo, 'docs');
    try {
      rmSync(link, { recursive: true, force: true });
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      t.skip('this environment cannot create a directory symlink or junction');
      return;
    }

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.projects.some(project => project.path === 'docs'), false);
  });

  it('inspects a polyrepo multi-checkout layout with contained checkout projects and local signals', async () => {
    const repo = makeFixtureRepo('polyrepo-multi-checkout');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.command, 'repo inspect');
    assert.equal(result.kind, 'polyrepo-multi-checkout');
    assert.deepEqual(result.projects.map(project => project.path), ['.', 'repos/api', 'repos/web']);
    assert.equal(result.projects.find(project => project.path === '.').kind, 'workspace');
    assert.equal(result.projects.find(project => project.path === 'repos/api').packageName, 'api');
    assert.equal(result.projects.find(project => project.path === 'repos/web').packageName, 'web');
    assert.ok(result.rootMarkers.some(marker => marker.path === '.gitmodules'));
    assert.ok(result.ciHints.some(hint => hint.path === '.github/workflows/ci.yml'));
    assert.ok(!result.warnings.some(warning => warning.includes('Affected-scope mapping is conservative')));
  });

  it('maps changed paths to affected polyrepo checkouts and suggested gates', async () => {
    const repo = makeFixtureRepo('polyrepo-multi-checkout');

    const result = await runRepoAffected({
      config: getDefaults(),
      cwd: repo,
      changedPaths: ['repos/api/src/index.ts', '.gitmodules'],
    });

    assert.equal(result.command, 'repo affected');
    assert.equal(result.layout.kind, 'polyrepo-multi-checkout');
    assert.deepEqual(result.affectedProjects.map(project => project.project.path), ['.', 'repos/api']);
    assert.deepEqual(result.affectedProjects.find(project => project.project.path === '.').changedPaths, ['.gitmodules']);
    assert.ok(result.affectedProjects.find(project => project.project.path === '.').gates.includes('dependency-review'));
    assert.ok(result.affectedProjects.find(project => project.project.path === 'repos/api').gates.includes('typecheck'));
    assert.ok(result.suggestedGates.includes('dependency-review'));
  });

  it('keeps a polyrepo multi-checkout when incidental Node tooling exists at the root', async () => {
    const repo = makeFixtureRepo('polyrepo-multi-checkout');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'node-tooling-root', private: true }, null, 2));

    const inspected = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(inspected.kind, 'polyrepo-multi-checkout');
    assert.deepEqual(inspected.projects.map(project => project.path), ['.', 'repos/api', 'repos/web']);
  });

  it('reports an ambiguous layout when polyrepo and JavaScript workspaces both resolve members', async () => {
    const repo = makeFixtureRepo('polyrepo-multi-checkout');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'node-tooling-root', private: true, workspaces: ['tools/*'] }, null, 2));
    mkdirSync(join(repo, 'tools', 'cli'), { recursive: true });
    writeFileSync(join(repo, 'tools', 'cli', 'package.json'), JSON.stringify({ name: 'fixture-node-cli', private: true }, null, 2));

    const inspected = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(inspected.kind, 'unknown');
    assert.ok(inspected.warnings.some(warning => /both or neither resolve member projects; repository layout is ambiguous/.test(warning)));
  });

  it('does not classify nested checkout-shaped directories without extra git proof as a polyrepo', async () => {
    const repo = makeFixtureRepo('ambiguous-polyrepo-multi-checkout');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'unknown');
    assert.notEqual(result.kind, 'polyrepo-multi-checkout');
    assert.deepEqual(result.projects.map(project => project.path), []);
    assert.ok(result.warnings.some(warning => warning.includes('no contained extra git checkout')));
  });

  it('warns when modules checkout-shaped directories lack extra git proof', async () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, 'modules', 'api', 'src'), { recursive: true });
    writeFileSync(join(repo, 'modules', 'api', 'src', 'index.ts'), 'export {}\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'unknown');
    assert.notEqual(result.kind, 'polyrepo-multi-checkout');
    assert.ok(result.warnings.some(warning => warning.includes('modules/api') && warning.includes('no contained extra git checkout')));
  });

  it('does not classify a single-root app as a polyrepo multi-checkout', async () => {
    const repo = makeFixtureRepo('single-app-service');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'single-app-service');
    assert.notEqual(result.kind, 'polyrepo-multi-checkout');
  });

  it('does not classify multiple remotes without extra contained checkouts as a polyrepo', async () => {
    const repo = makeGitRepo();
    execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/app.git'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'fork', 'https://example.invalid/fork.git'], { cwd: repo, stdio: 'ignore' });

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.notEqual(result.kind, 'polyrepo-multi-checkout');
    assert.ok(result.remotes.length >= 1);
  });

  it('classifies conventional checkout directories that contain extra git roots as a polyrepo', async () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, 'repos', 'api', 'src'), { recursive: true });
    mkdirSync(join(repo, 'checkouts', 'web', 'src'), { recursive: true });
    writeFileSync(join(repo, 'repos', 'api', 'src', 'index.ts'), 'export {}\n');
    writeFileSync(join(repo, 'checkouts', 'web', 'src', 'index.ts'), 'export {}\n');
    writeFileSync(join(repo, 'repos', 'api', '.git'), 'gitdir: ../../.git/modules/repos/api\n');
    writeFileSync(join(repo, 'checkouts', 'web', '.git'), 'gitdir: ../../.git/modules/checkouts/web\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'polyrepo-multi-checkout');
    assert.deepEqual(result.projects.map(project => project.path), ['.', 'checkouts/web', 'repos/api']);
  });

  it('does not classify a Gradle includeBuild path without a contained git checkout as a polyrepo', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'settings.gradle.kts'), 'includeBuild("externals/lib")\n');
    mkdirSync(join(repo, 'externals', 'lib', 'src'), { recursive: true });
    writeFileSync(join(repo, 'externals', 'lib', 'src', 'Lib.kt'), 'object Lib\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.notEqual(result.kind, 'polyrepo-multi-checkout');
  });

  it('does not classify a generic JavaScript workspace as a polyrepo multi-checkout', async () => {
    const repo = makeFixtureRepo('js-workspace');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'javascript-typescript-workspace');
    assert.notEqual(result.kind, 'polyrepo-multi-checkout');
  });

  it('does not classify a Go workspace as a polyrepo multi-checkout', async () => {
    const repo = makeFixtureRepo('go-workspace');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'go-workspace');
    assert.notEqual(result.kind, 'polyrepo-multi-checkout');
  });

  it('keeps generated polyrepo paths out of mutation scope', async () => {
    const repo = makeFixtureRepo('polyrepo-multi-checkout');
    mkdirSync(join(repo, 'dist'), { recursive: true });
    writeFileSync(join(repo, 'dist', 'index.js'), 'export {}\n');

    const result = await runRepoAffected({
      config: getDefaults(),
      cwd: repo,
      changedPaths: ['dist/index.js'],
    });

    assert.deepEqual(result.affectedProjects, []);
    assert.ok(result.warnings.some(warning => warning.includes('did not map to a detected project')));
  });

  it('does not follow escaped .gitmodules paths out of the repository root', async () => {
    const repo = makeGitRepo();
    const outside = join(repo, '..', 'outside-polyrepo-checkout');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'index.ts'), 'export {}\n');
    writeFileSync(join(repo, '.gitmodules'), '[submodule "escape"]\n\tpath = ../outside-polyrepo-checkout\n\turl = https://example.invalid/escape.git\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.notEqual(result.kind, 'polyrepo-multi-checkout');
    assert.equal(result.projects.some(project => String(project.path).includes('outside') || String(project.path).includes('..')), false);
    assert.ok(result.warnings.some(warning => warning.includes('no contained extra git checkout')));
  });

  it('does not follow symlink polyrepo members out of the repository root', async (t) => {
    const repo = makeFixtureRepo('polyrepo-multi-checkout');
    const outside = join(repo, '..', 'outside-polyrepo-symlink');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'index.ts'), 'export {}\n');
    const link = join(repo, 'repos', 'api');
    try {
      rmSync(link, { recursive: true, force: true });
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      t.skip('this environment cannot create a directory symlink or junction');
      return;
    }

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.projects.some(project => project.path === 'repos/api'), false);
    assert.equal(result.projects.some(project => project.path === 'repos/web'), true);
  });

  it('inspects a generated vendor heavy layout with vendor and generated signals', async () => {
    const repo = makeFixtureRepo('generated-vendor-heavy');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.command, 'repo inspect');
    assert.equal(result.kind, 'generated-vendor-heavy');
    assert.deepEqual(result.projects.map(project => project.path), ['.']);
    assert.equal(result.projects[0].packageName, 'fixture-vendor-app');
    assert.ok(result.vendorPaths.some(signal => signal.path === 'vendor'));
    assert.ok(result.generatedPaths.some(signal => signal.path === 'dist'));
    assert.ok(result.generatedPaths.some(signal => signal.path === 'generated'));
    assert.ok(result.ciHints.some(hint => hint.path === '.github/workflows/ci.yml'));
    assert.ok(!result.warnings.some(warning => warning.includes('Affected-scope mapping is conservative')));
  });

  it('maps source changes in a generated vendor heavy repo and keeps vendor paths out of mutation', async () => {
    const repo = makeFixtureRepo('generated-vendor-heavy');

    const result = await runRepoAffected({
      config: getDefaults(),
      cwd: repo,
      changedPaths: ['src/index.ts', 'vendor/lib/index.js', 'dist/index.js', 'generated/client.ts'],
    });

    assert.equal(result.command, 'repo affected');
    assert.equal(result.layout.kind, 'generated-vendor-heavy');
    assert.deepEqual(result.affectedProjects.map(project => project.project.path), ['.']);
    assert.deepEqual(result.affectedProjects[0].changedPaths, ['src/index.ts']);
    assert.ok(result.affectedProjects[0].gates.includes('typecheck'));
    assert.ok(result.warnings.some(warning => warning.includes('did not map to a detected project')));
  });

  it('does not classify a single generated directory without vendor as generated-vendor-heavy', async () => {
    const repo = makeFixtureRepo('ambiguous-generated-vendor-heavy');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'single-app-service');
    assert.notEqual(result.kind, 'generated-vendor-heavy');
  });

  it('does not classify a generic JavaScript workspace as generated-vendor-heavy', async () => {
    const repo = makeFixtureRepo('js-workspace');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'javascript-typescript-workspace');
    assert.notEqual(result.kind, 'generated-vendor-heavy');
  });

  it('does not classify a lockfile-only root as generated-vendor-heavy', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'package-lock.json'), '{}\n');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.notEqual(result.kind, 'generated-vendor-heavy');
  });

  it('does not follow symlink vendor trees out of the repository root', async (t) => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'fixture-vendor-escape', private: true }, null, 2));
    const outside = join(repo, '..', 'outside-vendor-symlink');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'index.js'), 'module.exports = {}\n');
    try {
      symlinkSync(outside, join(repo, 'vendor'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      t.skip('this environment cannot create a directory symlink or junction');
      return;
    }

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.notEqual(result.kind, 'generated-vendor-heavy');
    assert.equal(result.vendorPaths.some(signal => signal.path === 'vendor'), false);
  });

  it('keeps Python root metadata when incidental Node tooling exists at the root', async () => {
    const repo = makeFixtureRepo('python-workspace');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'node-tooling-root', private: true }, null, 2));

    const inspected = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(inspected.kind, 'python-workspace-monorepo');
    assert.deepEqual(inspected.projects.map(project => project.path), ['.', 'packages/core', 'services/api']);
    const rootProject = inspected.projects.find(project => project.path === '.');
    assert.equal(rootProject.id, 'fixture-python-root');
    assert.equal(rootProject.kind, 'workspace');
    assert.equal(rootProject.packageName, 'fixture-python-root');
    assert.equal(rootProject.packageManager, null);

    const affected = await runRepoAffected({
      config: getDefaults(),
      cwd: repo,
      changedPaths: ['uv.lock'],
    });

    assert.equal(affected.layout.kind, 'python-workspace-monorepo');
    assert.deepEqual(affected.affectedProjects.map(project => project.project.id), ['fixture-python-root']);
    assert.equal(affected.affectedProjects[0].project.packageName, 'fixture-python-root');
    assert.equal(affected.affectedProjects[0].project.kind, 'workspace');
  });

  it('prefers the Python workspace when a root package.json declares workspaces without JS members', async () => {
    const repo = makeFixtureRepo('python-workspace');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'node-tooling-root', private: true, workspaces: ['packages/*'] }, null, 2));

    const inspected = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(inspected.kind, 'python-workspace-monorepo');
    const rootProject = inspected.projects.find(project => project.path === '.');
    assert.equal(rootProject.packageName, 'fixture-python-root');
    assert.equal(rootProject.kind, 'workspace');
    assert.ok(inspected.warnings.some(warning => /Both JavaScript and Python root workspace declarations were detected/.test(warning)));

    const affected = await runRepoAffected({
      config: getDefaults(),
      cwd: repo,
      changedPaths: ['uv.lock'],
    });

    assert.deepEqual(affected.affectedProjects.map(project => project.project.id), ['fixture-python-root']);
  });

  it('reports an ambiguous layout when JavaScript and Python workspaces both resolve members', async () => {
    const repo = makeFixtureRepo('python-workspace');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'node-tooling-root', private: true, workspaces: ['tools/*'] }, null, 2));
    mkdirSync(join(repo, 'tools', 'cli'), { recursive: true });
    writeFileSync(join(repo, 'tools', 'cli', 'package.json'), JSON.stringify({ name: 'fixture-node-cli', private: true }, null, 2));

    const inspected = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(inspected.kind, 'unknown');
    assert.ok(inspected.warnings.some(warning => /both or neither resolve member projects; repository layout is ambiguous/.test(warning)));
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

  it('maps changed paths to affected Python workspace projects and suggested gates', async () => {
    const repo = makeFixtureRepo('python-workspace');

    const result = await runRepoAffected({
      config: getDefaults(),
      cwd: repo,
      changedPaths: ['packages/core/src/fixture_core/__init__.py', 'services/api/pyproject.toml', 'uv.lock'],
    });

    assert.equal(result.command, 'repo affected');
    assert.equal(result.layout.kind, 'python-workspace-monorepo');
    assert.deepEqual(result.affectedProjects.map(project => project.project.id), ['fixture-python-root', 'fixture-python-core', 'fixture-python-api']);
    assert.deepEqual(result.affectedProjects.find(project => project.project.id === 'fixture-python-root').changedPaths, ['uv.lock']);
    assert.ok(result.affectedProjects.find(project => project.project.id === 'fixture-python-core').gates.includes('test'));
    assert.ok(result.affectedProjects.find(project => project.project.id === 'fixture-python-api').gates.includes('dependency-review'));
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

  it('does not classify Python tooling markers without a root pyproject as a workspace', async () => {
    const repo = makeFixtureRepo('ambiguous-python-workspace');

    const result = await runRepoInspect({ config: getDefaults(), cwd: repo });

    assert.equal(result.kind, 'unknown');
    assert.deepEqual(result.projects.map(project => project.path), ['packages/core']);
    assert.ok(result.rootMarkers.some(marker => marker.path === 'uv.lock'));
    assert.ok(result.rootMarkers.some(marker => marker.path === 'tox.ini'));
    assert.ok(result.warnings.some(warning => warning.includes('no root pyproject.toml was found')));
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
