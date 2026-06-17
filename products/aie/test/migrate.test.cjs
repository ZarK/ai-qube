const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { execFileSync, spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { categorizeLegacyPath } = require('../dist/legacy.js');
const { configToFileShape, getDefaults } = require('../dist/config/index.js');
const { buildMigrationMap, buildMigrationPlan, runMigration } = require('../dist/migrate/index.js');
const { renderManagedSection } = require('../dist/managed_file.js');

function makeGitRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'aie-migrate-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
  return repo;
}

function binRun(args, cwd = process.cwd()) {
  return spawnSync(process.execPath, [join(process.cwd(), 'bin/run'), ...args], { cwd, encoding: 'utf8' });
}

function writeFixture(repo) {
  const config = configToFileShape(getDefaults());
  config.policy.labels.priorities = ['Urgent'];
  config.policy.labels.statuses = ['S-Ready', 'S-InProgress'];
  config.policy.labels.components = ['C-CLI'];
  config.policy.milestoneOrdering = { enabled: true, order: ['M1', 'M2'], missingAssignment: 'block' };
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  mkdirSync(join(repo, '.opencode', 'commands'), { recursive: true });
  mkdirSync(join(repo, 'docs'), { recursive: true });
  writeFileSync(join(repo, 'gh-priority-order.sh'), '#!/usr/bin/env bash\n');
  writeFileSync(join(repo, 'scripts', 'gh-issue-start.sh'), '#!/usr/bin/env bash\n');
  writeFileSync(join(repo, 'scripts', 'gh-project-report.sh'), '#!/usr/bin/env bash\n');
  writeFileSync(join(repo, '.opencode', 'commands', 'project.md'), 'Run scripts/gh-issue-start.sh before taking the next issue.\n');
  writeFileSync(join(repo, '.opencode', 'commands', 'current.md'), 'Show S-InProgress and Blocked by: #1 in current Executor guidance.\n');
  writeFileSync(join(repo, 'AGENTS.md'), 'Use gh-priority-order.sh for the legacy issue workflow.\n');
  writeFileSync(join(repo, 'docs', 'gh-workflow.md'), 'Legacy workflow helper docs mention Blocked by: #1 and gh-issue-complete.sh.\n');
  writeFileSync(join(repo, 'docs', 'current-workflow.md'), 'Current Executor docs mention S-Ready, S-InProgress, and Blocked by: #1.\n');
  writeFileSync(join(repo, 'aie.config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

function readFixtureFiles(repo) {
  return {
    queue: readFileSync(join(repo, 'gh-priority-order.sh'), 'utf8'),
    start: readFileSync(join(repo, 'scripts', 'gh-issue-start.sh'), 'utf8'),
    unknown: readFileSync(join(repo, 'scripts', 'gh-project-report.sh'), 'utf8'),
    command: readFileSync(join(repo, '.opencode', 'commands', 'project.md'), 'utf8'),
    currentCommand: readFileSync(join(repo, '.opencode', 'commands', 'current.md'), 'utf8'),
    agents: readFileSync(join(repo, 'AGENTS.md'), 'utf8'),
    docs: readFileSync(join(repo, 'docs', 'gh-workflow.md'), 'utf8'),
    currentDocs: readFileSync(join(repo, 'docs', 'current-workflow.md'), 'utf8'),
    config: readFileSync(join(repo, 'aie.config.json'), 'utf8'),
  };
}

describe('legacy migration planner', () => {
  it('builds a stable non-mutating migration plan from legacy fixtures', async () => {
    const repo = makeGitRepo();
    writeFixture(repo);
    const before = readFixtureFiles(repo);

    const plan = await buildMigrationPlan({ cwd: repo, dryRun: true });

    assert.equal(plan.ok, true);
    assert.equal(plan.command, 'migrate legacy');
    assert.equal(plan.dryRun, true);
    assert.equal(plan.mode, 'audit-plan');
    assert.deepEqual(plan.inventory.map(item => item.path), [
      '.opencode/commands/project.md',
      'AGENTS.md',
      'docs/gh-workflow.md',
      'gh-priority-order.sh',
      'scripts/gh-issue-start.sh',
      'scripts/gh-project-report.sh',
    ]);
    assert.equal(plan.cleanupCandidates.some(item => item.path === 'gh-priority-order.sh'), true);
    assert.equal(plan.cleanupCandidates.some(item => item.path === 'scripts/gh-issue-start.sh'), true);
    assert.equal(plan.plannedFileChanges.some(item => item.path === 'AGENTS.md'), true);
    assert.equal(plan.inventory.some(item => item.path === '.opencode/commands/current.md'), false);
    assert.equal(plan.inventory.some(item => item.path === 'docs/current-workflow.md'), false);
    assert.equal(plan.skippedFiles.some(item => item.path === 'scripts/gh-project-report.sh' && item.confidence === 'review-required'), true);
    assert.equal(plan.conflicts.some(conflict => conflict.path === 'scripts/gh-project-report.sh'), true);
    assert.deepEqual(plan.preservation.priorityLabels, ['Urgent']);
    assert.deepEqual(plan.preservation.milestoneOrdering.order, ['M1', 'M2']);
    assert.equal(plan.preservation.milestoneAssignments, 'preserve');
    assert.equal(plan.preservation.branchState, 'preserve');
    assert.deepEqual(readFixtureFiles(repo), before);
  });

  it('categorizes gate and review helpers without treating them as pull request helpers', () => {
    assert.equal(categorizeLegacyPath('scripts/gate-status.sh'), 'gates');
    assert.equal(categorizeLegacyPath('scripts/review-agent.sh'), 'review');
    assert.equal(categorizeLegacyPath('scripts/pr-review.sh'), 'pull-request');
  });
});

describe('legacy migration CLI', () => {
  it('shows product-generic command mappings in human and JSON forms', () => {
    const human = binRun(['migrate', 'map']);
    const json = binRun(['migrate', 'map', '--json']);
    const parsed = JSON.parse(json.stdout);
    const map = buildMigrationMap();

    assert.equal(human.status, 0);
    assert.match(human.stdout, /Legacy command map/);
    assert.match(human.stdout, /queue and next issue selection: aie queue, aie next, aie start next/);
    assert.doesNotMatch(human.stdout, /gh-issue-start\.sh/);
    assert.equal(json.status, 0);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, 'migrate map');
    assert.deepEqual(parsed.mappings, map.mappings);
    assert.equal(parsed.mappings.some(mapping => mapping.executorCommands.includes('aie complete <issue>')), true);
  });

  it('shows migration topic and legacy help forms without mutation', () => {
    const repo = makeGitRepo();
    writeFixture(repo);
    const before = readFixtureFiles(repo);
    const topic = binRun(['migrate'], repo);
    const suffix = binRun(['migrate', 'legacy', 'help'], repo);
    const prefix = binRun(['help', 'migrate', 'legacy'], repo);
    const flag = binRun(['migrate', 'legacy', '--help'], repo);

    assert.equal(topic.status, 0);
    assert.match(topic.stdout, /migrate legacy/);
    assert.match(topic.stdout, /migrate map/);
    assert.equal(suffix.status, 0);
    assert.match(suffix.stdout, /Usage:/);
    assert.equal(prefix.status, 0);
    assert.match(prefix.stdout, /Usage:/);
    assert.equal(flag.status, 0);
    assert.match(flag.stdout, /--dry-run/);
    assert.match(flag.stdout, /--instruction/);
    assert.match(flag.stdout, /--cleanup/);
    assert.match(flag.stdout, /--install-wrappers/);
    assert.deepEqual(readFixtureFiles(repo), before);
  });

  it('defaults to audit plan mode and emits JSON dry-run without mutating files', () => {
    const repo = makeGitRepo();
    writeFixture(repo);
    const before = readFixtureFiles(repo);
    const human = binRun(['migrate', 'legacy'], repo);
    const json = binRun(['migrate', 'legacy', '--dry-run', '--json'], repo);
    const parsed = JSON.parse(json.stdout);

    assert.equal(human.status, 0);
    assert.match(human.stdout, /Legacy migration plan/);
    assert.match(human.stdout, /Preservation:/);
    assert.match(human.stdout, /Skipped files:/);
    assert.match(human.stdout, /Wrapper installs:/);
    assert.match(human.stdout, /Required confirmations:/);
    assert.equal(json.status, 0);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, 'migrate legacy');
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.wrapperInstalls.length, 0);
    assert.equal(parsed.inventory.some(item => item.path === 'scripts/gh-project-report.sh' && item.proposedAction === 'preserve'), true);
    assert.equal(existsSync(join(repo, '.aie')), false);
    assert.deepEqual(readFixtureFiles(repo), before);
  });
});

describe('legacy compatibility wrappers and cleanup', () => {
  it('plans wrappers only when explicitly requested and does not write during dry-run', async () => {
    const repo = makeGitRepo();
    writeFixture(repo);
    const before = readFixtureFiles(repo);

    const defaultPlan = await buildMigrationPlan({ cwd: repo, dryRun: true });
    const wrapperPlan = await buildMigrationPlan({ cwd: repo, dryRun: true, installWrappers: true });

    assert.equal(defaultPlan.wrapperInstalls.length, 0);
    assert.deepEqual(wrapperPlan.wrapperInstalls.map(item => item.path), ['gh-priority-order.sh', 'scripts/gh-issue-start.sh']);
    assert.deepEqual(readFixtureFiles(repo), before);
  });

  it('applies executable wrappers that delegate to package-backed commands', async () => {
    const repo = makeGitRepo();
    writeFixture(repo);

    const result = await runMigration({ cwd: repo, apply: true, installWrappers: true });
    const queueWrapper = readFileSync(join(repo, 'gh-priority-order.sh'), 'utf8');
    const startWrapper = readFileSync(join(repo, 'scripts', 'gh-issue-start.sh'), 'utf8');

    assert.equal(result.ok, true);
    assert.deepEqual(result.completedChanges, [
      'installed wrapper gh-priority-order.sh',
      'made executable gh-priority-order.sh',
      'installed wrapper scripts/gh-issue-start.sh',
      'made executable scripts/gh-issue-start.sh',
    ]);
    assert.match(queueWrapper, /executor-compat-wrapper-version: 1/);
    assert.match(queueWrapper, /exec 'aie' 'queue' "\$@"/);
    assert.match(startWrapper, /exec 'aie' 'start' "\$@"/);
    if (process.platform !== 'win32') {
      assert.notEqual(statSync(join(repo, 'gh-priority-order.sh')).mode & 0o111, 0);
      assert.notEqual(statSync(join(repo, 'scripts', 'gh-issue-start.sh')).mode & 0o111, 0);
    }
  });

  it('reports cleanup removals and preserves in dry-run output without mutating files', () => {
    const repo = makeGitRepo();
    writeFixture(repo);
    const before = readFixtureFiles(repo);

    const result = binRun(['migrate', 'legacy', '--cleanup', '--dry-run'], repo);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Cleanup decisions:/);
    assert.match(result.stdout, /gh-priority-order\.sh: remove/);
    assert.match(result.stdout, /scripts\/gh-issue-start\.sh: remove/);
    assert.match(result.stdout, /scripts\/gh-project-report\.sh: preserve/);
    assert.deepEqual(readFixtureFiles(repo), before);
  });

  it('applies cleanup to known helpers while preserving review-required files', async () => {
    const repo = makeGitRepo();
    writeFixture(repo);

    const result = await runMigration({ cwd: repo, apply: true, cleanup: true });

    assert.equal(result.ok, true);
    assert.deepEqual(result.completedChanges, ['removed gh-priority-order.sh', 'removed scripts/gh-issue-start.sh']);
    assert.equal(existsSync(join(repo, 'gh-priority-order.sh')), false);
    assert.equal(existsSync(join(repo, 'scripts', 'gh-issue-start.sh')), false);
    assert.equal(existsSync(join(repo, 'scripts', 'gh-project-report.sh')), true);
    assert.equal(existsSync(join(repo, '.git')), true);
  });

  it('blocks non-fingerprinted explicit cleanup paths unless forced', async () => {
    const repo = makeGitRepo();
    writeFixture(repo);

    const blocked = await runMigration({ cwd: repo, apply: true, cleanup: true, legacyPaths: ['scripts/gh-project-report.sh'] });
    const forced = await runMigration({ cwd: repo, apply: true, cleanup: true, force: true, legacyPaths: ['scripts/gh-project-report.sh'] });

    assert.equal(blocked.ok, false);
    assert.equal(blocked.conflicts.some(conflict => conflict.path === 'scripts/gh-project-report.sh' && /not a known legacy helper fingerprint/.test(conflict.reason)), true);
    assert.equal(forced.ok, true);
    assert.equal(existsSync(join(repo, 'scripts', 'gh-project-report.sh')), false);
  });

  it('blocks explicit cleanup paths outside the repository', async () => {
    const repo = makeGitRepo();
    writeFixture(repo);

    const result = await buildMigrationPlan({ cwd: repo, cleanup: true, legacyPaths: ['../outside.sh'] });

    assert.equal(result.ok, false);
    assert.equal(result.conflicts.some(conflict => conflict.path === '../outside.sh' && /outside the repository root/.test(conflict.reason)), true);
  });

  it('keeps wrapper targets when cleanup and wrapper installation are combined', async () => {
    const repo = makeGitRepo();
    writeFixture(repo);

    const result = await runMigration({ cwd: repo, apply: true, cleanup: true, installWrappers: true });
    const wrapper = readFileSync(join(repo, 'gh-priority-order.sh'), 'utf8');

    assert.equal(result.ok, true);
    assert.deepEqual(result.completedChanges, [
      'installed wrapper gh-priority-order.sh',
      'made executable gh-priority-order.sh',
      'installed wrapper scripts/gh-issue-start.sh',
      'made executable scripts/gh-issue-start.sh',
    ]);
    assert.match(wrapper, /exec 'aie' 'queue' "\$@"/);
    assert.equal(existsSync(join(repo, 'scripts', 'gh-issue-start.sh')), true);
    assert.equal(existsSync(join(repo, 'scripts', 'gh-project-report.sh')), true);
  });
});

describe('legacy instruction migration', () => {
  it('blocks selected unmanaged instruction files unless force is supplied', async () => {
    const repo = makeGitRepo();
    writeFixture(repo);
    const before = readFixtureFiles(repo);

    const plan = await buildMigrationPlan({ cwd: repo, apply: true, dryRun: true, instructionPaths: ['AGENTS.md'] });

    assert.equal(plan.ok, false);
    assert.equal(plan.mode, 'apply-plan');
    const update = plan.instructionUpdates.find(item => item.path === 'AGENTS.md');
    assert.equal(update.status, 'blocked');
    assert.equal(update.forceRequired, true);
    assert.match(update.reason, /--force/);
    assert.equal(update.replacements.some(replacement => replacement.legacyReference === 'gh-priority-order.sh' && replacement.executorCommand === 'aie queue'), true);
    assert.deepEqual(readFixtureFiles(repo), before);
  });

  it('blocks selected instruction paths that cannot be read', async () => {
    const repo = makeGitRepo();
    writeFixture(repo);

    const plan = await buildMigrationPlan({ cwd: repo, apply: true, dryRun: true, force: true, instructionPaths: ['docs'] });

    assert.equal(plan.ok, false);
    const update = plan.instructionUpdates.find(item => item.path === 'docs');
    assert.equal(update.status, 'blocked');
    assert.equal(update.forceRequired, false);
    assert.match(update.reason, /Failed to read instruction file/);
    assert.equal(plan.conflicts.some(conflict => conflict.path === 'docs' && /Failed to read instruction file/.test(conflict.reason)), true);
  });

  it('skips selected unmanaged instruction files when no known helper references need replacing', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'AGENTS.md'), 'Keep gh-priority-order.sh.old as historical text. No current helper command is configured.\n');

    const result = await runMigration({ cwd: repo, apply: true, instructionPaths: ['AGENTS.md'] });

    assert.equal(result.ok, true);
    const update = result.instructionUpdates.find(item => item.path === 'AGENTS.md');
    assert.equal(update.status, 'skipped');
    assert.equal(update.forceRequired, false);
    assert.deepEqual(result.completedChanges, []);
    assert.equal(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), 'Keep gh-priority-order.sh.old as historical text. No current helper command is configured.\n');
  });

  it('rewrites only selected unmanaged instruction files when forced and applied', async () => {
    const repo = makeGitRepo();
    writeFixture(repo);
    writeFileSync(join(repo, 'CLAUDE.md'), 'Keep Claude notes and run gh-issue-complete.sh after merge.\n');
    const commandBefore = readFileSync(join(repo, '.opencode', 'commands', 'project.md'), 'utf8');

    const result = await runMigration({ cwd: repo, apply: true, force: true, instructionPaths: ['AGENTS.md'] });

    assert.equal(result.ok, true);
    assert.deepEqual(result.completedChanges, ['updated AGENTS.md']);
    assert.doesNotMatch(result.warnings.join('\n'), /Instruction files are reported only/);
    const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
    assert.match(agents, /Use aie queue for the legacy issue workflow\./);
    assert.doesNotMatch(agents, /gh-priority-order\.sh/);
    assert.equal(readFileSync(join(repo, 'CLAUDE.md'), 'utf8'), 'Keep Claude notes and run gh-issue-complete.sh after merge.\n');
    assert.equal(readFileSync(join(repo, '.opencode', 'commands', 'project.md'), 'utf8'), commandBefore);
  });

  it('updates managed instruction sections while preserving user-authored content', async () => {
    const repo = makeGitRepo();
    const userContent = '# Project Rules\n\nKeep this repository rule.\n\n';
    writeFileSync(join(repo, 'AGENTS.md'), `${userContent}${renderManagedSection('Run gh-issue-start.sh before implementation.')}`);

    const dryRun = await runMigration({ cwd: repo, apply: true, dryRun: true });
    const beforeApply = readFileSync(join(repo, 'AGENTS.md'), 'utf8');

    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.instructionUpdates.find(update => update.path === 'AGENTS.md').status, 'planned');
    assert.equal(beforeApply, `${userContent}${renderManagedSection('Run gh-issue-start.sh before implementation.')}`);

    const applied = await runMigration({ cwd: repo, apply: true });
    const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');

    assert.equal(applied.ok, true);
    assert.equal(applied.instructionUpdates.find(update => update.path === 'AGENTS.md').status, 'completed');
    assert.doesNotMatch(applied.warnings.join('\n'), /Instruction files are reported only/);
    assert.equal(agents.startsWith(userContent), true);
    assert.match(agents, /BEGIN EXECUTOR MANAGED SECTION/);
    assert.match(agents, /Executor Issue Workflow/);
    assert.match(agents, /standing authorization under repository policy/);
    assert.match(agents, /test: run configured quality gates/);
    assert.doesNotMatch(agents, /gh-issue-start\.sh/);
  });

  it('emits JSON apply plans with stable instruction update fields', () => {
    const repo = makeGitRepo();
    writeFixture(repo);
    const result = binRun(['migrate', 'legacy', '--apply', '--dry-run', '--instruction', 'AGENTS.md', '--force', '--json'], repo);
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.equal(parsed.command, 'migrate legacy');
    assert.equal(parsed.mode, 'apply-plan');
    assert.equal(parsed.apply, true);
    assert.equal(parsed.dryRun, true);
    const update = parsed.instructionUpdates.find(item => item.path === 'AGENTS.md');
    assert.equal(update.operation, 'replace-references');
    assert.equal(update.status, 'planned');
    assert.equal(update.selected, true);
    assert.equal(update.replacements.some(replacement => replacement.legacyReference === 'gh-priority-order.sh' && replacement.executorCommand === 'aie queue'), true);
  });
});
