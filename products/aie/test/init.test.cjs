const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { execFileSync, spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, posix: pathPosix } = require('node:path');

const { buildInitPlan, runInit } = require('../dist/init/index.js');
const { configToFileShape, getDefaults } = require('../dist/config/index.js');

function makeGitRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'aie-init-'));
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

function binRun(args, cwd = process.cwd()) {
  return spawnSync(process.execPath, [join(process.cwd(), 'bin/run'), ...args], { cwd, encoding: 'utf8' });
}

function cleanConfig() {
  return configToFileShape(getDefaults());
}

function opencodeCommandPath(name) {
  return pathPosix.join('.opencode', 'commands', name);
}

describe('init service', () => {
  it('builds a dry-run plan for config and managed OpenCode files without writing', async () => {
    const repo = makeGitRepo();

    const result = await buildInitPlan({ target: '.', tool: 'opencode', dryRun: true, force: false, cwd: repo });

    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.selectedTools, ['opencode']);
    assert.deepEqual(result.actions.map(action => action.path), ['aie.config.json', 'AGENTS.md', opencodeCommandPath('make-it-so.md')]);
    assert.equal(result.actions.every(action => action.status === 'planned'), true);
    assert.equal(existsSync(join(repo, 'aie.config.json')), false);
    assert.equal(existsSync(join(repo, 'AGENTS.md')), false);
  });

  it('writes managed sections and preserves user-authored instruction content', async () => {
    const repo = makeGitRepo();
    const userContent = '# Project Rules\n\nKeep this local rule.   \n\n';
    writeFileSync(join(repo, 'AGENTS.md'), userContent);

    const result = await runInit({ target: '.', tool: 'opencode', dryRun: false, force: false, cwd: repo });

    assert.equal(result.ok, true);
    assert.equal(result.completedChanges.length, 3);
    const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
    assert.equal(agents.startsWith(userContent), true);
    assert.match(agents, /Keep this local rule\./);
    assert.match(agents, /BEGIN EXECUTOR MANAGED SECTION/);
    assert.match(agents, /Executor Issue Workflow/);
    assert.match(agents, /configured work and review provider is GitHub/);
    assert.match(agents, /Configured providers: work GitHub, review GitHub, repository local git, CI GitHub checks, layout local filesystem/);
    assert.match(agents, /Linked worktree execution is disabled/);
    assert.match(agents, /ZarK\/ai-supply-chain-guard/);
    assert.match(agents, /https:\/\/github\.com\/ZarK\/ai-supply-chain-guard/);
    assert.match(agents, /\.agents\/skills\/supply-chain-guard\/SKILL\.md/);
    const command = readFileSync(join(repo, '.opencode', 'commands', 'make-it-so.md'), 'utf8');
    assert.match(command, /Continue repository development/);
    assert.match(command, /inspect required reviews and checks/);
    assert.match(command, /configured gates cannot run/);
    assert.doesNotMatch(command, /request configured reviews, wait for configured review gates/);
    assert.doesNotMatch(agents, /pr-review-wait/);
    const config = JSON.parse(readFileSync(join(repo, 'aie.config.json'), 'utf8'));
    assert.equal(config.version, 1);
    assert.equal(config.providers.work.kind, 'github');
    assert.equal(config.providers.repository.kind, 'local-git');
    assert.equal(config.policy.branch.naming, 'issue/<number>-<slug>');
    assert.equal(config.policy.branch.requireBaseBranchFreshness, true);
    assert.equal(config.policy.lifecycle.assignOnStart, true);
    assert.equal(config.policy.lifecycle.commentOnStart, true);
    assert.equal(config.policy.instructions.opencodeCommandAlias, false);
    assert.equal(config.policy.instructions.namingRules, false);
    assert.equal(config.policy.supplyChain.packageAgeDays, 7);
    assert.equal(config.policy.supplyChain.pinCiActions, true);
  });

  it('is idempotent after writing managed sections', async () => {
    const repo = makeGitRepo();
    await runInit({ target: '.', tool: 'opencode', dryRun: false, force: false, cwd: repo });

    const second = await runInit({ target: '.', tool: 'opencode', dryRun: false, force: false, cwd: repo });

    assert.equal(second.ok, true);
    assert.equal(second.completedChanges.length, 0);
    assert.equal(second.actions.every(action => action.status === 'skipped'), true);
  });

  it('blocks unknown config fields unless force replaces with current shape', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'aie.config.json'), `${JSON.stringify({ version: 1, customPolicy: { keep: true } }, null, 2)}\n`);

    const blocked = await runInit({ target: '.', tool: 'codex', dryRun: false, force: false, cwd: repo });
    assert.equal(blocked.ok, false);
    assert.match(blocked.errors.join('\n'), /customPolicy/);

    const result = await runInit({ target: '.', tool: 'codex', dryRun: false, force: true, cwd: repo });

    assert.equal(result.ok, true);
    const config = JSON.parse(readFileSync(join(repo, 'aie.config.json'), 'utf8'));
    assert.equal(config.customPolicy, undefined);
    assert.deepEqual(config.policy.labels.statuses, ['S-Ready', 'S-InProgress', 'S-Blocked', 'S-Blocking']);
  });

  it('normalizes partial current config files to full provider and policy shape', async () => {
    const repo = makeGitRepo();
    const config = cleanConfig();
    config.policy.milestoneOrdering = { enabled: true, missingAssignment: 'warn' };
    config.policy.instructions = { namingRules: true };
    config.policy.supplyChain = { packageAgeDays: 8 };
    writeFileSync(join(repo, 'aie.config.json'), `${JSON.stringify({
      version: config.version,
      providers: config.providers,
      policy: config.policy,
    }, null, 2)}\n`);

    const result = await runInit({ target: '.', tool: 'codex', dryRun: false, force: false, cwd: repo });

    assert.equal(result.ok, true);
    const written = JSON.parse(readFileSync(join(repo, 'aie.config.json'), 'utf8'));
    assert.equal(written.policy.milestoneOrdering.enabled, true);
    assert.equal(written.policy.milestoneOrdering.missingAssignment, 'warn');
    assert.deepEqual(written.policy.milestoneOrdering.order, []);
    assert.equal(written.policy.instructions.namingRules, true);
    assert.equal(written.policy.instructions.supplyChainSafety, true);
    assert.equal(written.policy.lifecycle.assignOnStart, true);
    assert.equal(written.policy.lifecycle.commentOnStart, true);
    assert.equal(written.policy.supplyChain.packageAgeDays, 8);
    assert.equal(written.policy.supplyChain.highRiskPackageAgeDays, 14);
    assert.equal(written.policy.supplyChain.pinCiActions, true);
  });

  it('replaces old flat safety toggles under force instead of migrating unreleased shapes', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'aie.config.json'), `${JSON.stringify({
      version: 1,
      promptInjectionWarning: false,
      noCreditWarning: false,
    }, null, 2)}\n`);

    const result = await runInit({ target: '.', tool: 'codex', dryRun: false, force: true, cwd: repo });

    assert.equal(result.ok, true);
    const config = JSON.parse(readFileSync(join(repo, 'aie.config.json'), 'utf8'));
    assert.equal(config.promptInjectionWarning, undefined);
    assert.equal(config.noCreditWarning, undefined);
    assert.equal(config.policy.instructions.promptInjectionWarning, true);
    assert.equal(config.policy.instructions.noCreditWarning, true);
  });

  it('preserves valid existing config values during forced init updates', async () => {
    const repo = makeGitRepo();
    const config = cleanConfig();
    config.policy.branch.baseRemote = 'upstream';
    config.policy.branch.baseBranch = 'develop';
    config.policy.lifecycle.assignOnStart = false;
    config.policy.lifecycle.commentOnStart = false;
    config.policy.reviews.agents = ['review-bot'];
    writeFileSync(join(repo, 'aie.config.json'), `${JSON.stringify(config, null, 2)}\n`);

    const result = await runInit({ target: '.', tool: 'codex', dryRun: false, force: true, cwd: repo });

    assert.equal(result.ok, true);
    const written = JSON.parse(readFileSync(join(repo, 'aie.config.json'), 'utf8'));
    assert.equal(written.policy.branch.baseRemote, 'upstream');
    assert.equal(written.policy.branch.baseBranch, 'develop');
    assert.equal(written.policy.lifecycle.assignOnStart, false);
    assert.equal(written.policy.lifecycle.commentOnStart, false);
    assert.deepEqual(written.policy.reviews.agents, ['review-bot']);
  });

  it('renders managed instructions from existing repository policy', async () => {
    const repo = makeGitRepo();
    const config = cleanConfig();
    config.policy.branch.baseRemote = 'upstream';
    config.policy.branch.baseBranch = 'develop';
    config.policy.branch.naming = 'work/<number>/<slug>';
    config.policy.branch.noWorktree = false;
    config.policy.branch.requireBaseBranchFreshness = false;
    config.policy.gates.qualityGates = ['npm test'];
    config.policy.reviews.agents = ['review-bot'];
    config.policy.reviews.requestText = 'Please\nreview\tthis  policy-sensitive change.';
    config.policy.instructions.opencodeCommandAlias = true;
    config.policy.audit.manualUiAudit = false;
    config.policy.shipping.autonomousMode = false;
    config.policy.milestoneOrdering = { enabled: true, order: ['Alpha', 'Beta'], missingAssignment: 'warn' };
    config.policy.instructions = { ...config.policy.instructions, namingRules: true };
    config.policy.supplyChain = { ...config.policy.supplyChain, pinCiActions: false, packageAgeDays: 11, highRiskPackageAgeDays: 22 };
    writeFileSync(join(repo, 'aie.config.json'), `${JSON.stringify(config, null, 2)}\n`);

    const result = await runInit({ target: '.', tool: 'opencode', dryRun: false, force: false, cwd: repo });

    assert.equal(result.ok, true);
    const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
    const command = readFileSync(join(repo, '.opencode', 'commands', 'make-it-so.md'), 'utf8');
    assert.match(agents, /Base branch: `upstream\/develop`/);
    assert.match(agents, /Issue branches follow `work\/<number>\/<slug>`/);
    assert.match(agents, /Manual UI audit is disabled/);
    assert.match(agents, /Linked worktree execution is enabled/);
    assert.match(agents, /Local base branch freshness checks before new issue work are disabled/);
    assert.match(agents, /Autonomous shipping mode is disabled/);
    assert.match(agents, /GitHub milestone ordering is enabled/);
    assert.doesNotMatch(agents, /primary checkout, no blocking open pull requests, and a current local base branch/);
    assert.match(agents, /Configured quality gate commands: `npm test`/);
    assert.match(agents, /Configured review agents: review-bot/);
    assert.match(agents, /Review request text: Please review this policy-sensitive change\./);
    assert.match(agents, /Naming rules:/);
    assert.match(agents, /follow configured repository pinning policy/);
    assert.doesNotMatch(command, /`upstream\/develop` is current/);
    assert.match(command, /autonomous shipping mode is disabled/);
    assert.doesNotMatch(command, /commit -> push -> pull request/);
    assert.match(readFileSync(join(repo, '.opencode', 'commands', 'makeitso.md'), 'utf8'), /Continue repository development/);
  });

  it('installs optional OpenCode command alias and reports host command fallbacks', async () => {
    const repo = makeGitRepo();

    const planned = await buildInitPlan({ target: '.', tool: 'all', dryRun: true, force: false, cwd: repo, policy: { opencodeCommandAlias: true } });

    assert.equal(planned.ok, true);
    assert.equal(planned.policy.opencodeCommandAlias, true);
    assert.deepEqual(planned.actions.map(action => action.path), [
      'aie.config.json',
      'AGENTS.md',
      'CLAUDE.md',
      opencodeCommandPath('make-it-so.md'),
      opencodeCommandPath('makeitso.md'),
    ]);
    assert.match(planned.warnings.join('\n'), /Codex project command files are not installed; Codex uses the managed AGENTS\.md always-loaded instructions\./);
    assert.match(planned.warnings.join('\n'), /Claude Code project command files are not installed; Claude Code uses the managed CLAUDE\.md always-loaded instructions\./);

    const applied = await runInit({ target: '.', tool: 'all', dryRun: false, force: false, cwd: repo, policy: { opencodeCommandAlias: true } });
    assert.equal(applied.ok, true);
    assert.equal(existsSync(join(repo, '.opencode', 'commands', 'make-it-so.md')), true);
    assert.equal(existsSync(join(repo, '.opencode', 'commands', 'makeitso.md')), true);
    assert.equal(readFileSync(join(repo, '.opencode', 'commands', 'makeitso.md'), 'utf8'), readFileSync(join(repo, '.opencode', 'commands', 'make-it-so.md'), 'utf8'));
  });

  it('renders full always-loaded workflow instructions with host projections', async () => {
    const repo = makeGitRepo();
    const result = await runInit({
      target: '.',
      tool: 'all',
      dryRun: false,
      force: false,
      cwd: repo,
      policy: { reviewAgents: ['review-bot'], instructions: { namingRules: true } },
    });

    assert.equal(result.ok, true);
    const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
    const claude = readFileSync(join(repo, 'CLAUDE.md'), 'utf8');
    const command = readFileSync(join(repo, '.opencode', 'commands', 'make-it-so.md'), 'utf8');

    assert.match(agents, /issue-driven autonomous development/);
    assert.match(agents, /standing authorization under repository policy to run tests, commit, push, create non-draft PRs/);
    assert.match(agents, /Keep at most one open issue in progress/);
    assert.match(agents, /For OpenCode, use `todowrite` and `todoread` directly/);
    assert.match(agents, /For Codex, use `update_plan` or the host plan\/todo tool directly/);
    assert.match(claude, /For Claude Code, use `TodoWrite` and `TodoRead`/);
    assert.match(agents, /Host capability profile:/);
    assert.match(agents, /OpenCode: instructions target `AGENTS\.md`, project commands are installed when configured/);
    assert.match(agents, /Codex: instructions target `AGENTS\.md`, project command files are not installed by Executor for this host/);
    assert.match(claude, /Claude Code: instructions target `CLAUDE\.md`, project command files are not installed by Executor for this host/);
    assert.match(agents, /Protected workflow todo ids are `branch-check`, `ship`, `pr-review-wait`, `next`/);
    assert.match(agents, /BOOTSTRAP NEXT ISSUE - DO NOT COMPLETE UNTIL NEW TODOS EXIST/);
    assert.match(agents, /remain pending until new issue todos exist or the queue is confirmed empty or blocked/);
    assert.match(agents, /Mark exactly one todo item `in_progress`/);
    assert.match(agents, /mark items `completed` immediately after finishing them/);
    assert.match(agents, /Never reach zero pending local todos while ready issue work may remain/);
    assert.match(agents, /Local todos are working memory and continuation state; GitHub issue checkboxes and comments are the durable shared task record/);
    assert.match(agents, /run `aie complete <issue>`/);
    assert.match(agents, /Analysis and discovered work:/);
    assert.match(agents, /Issue-gated implementation starts only after Executor selects or starts valid GitHub issue work/);
    assert.match(agents, /manual GitHub issue creation or issue suggestion are allowed before implementation starts when the user explicitly asks/);
    assert.match(agents, /When explicitly directed to record a confirmed product gap, create or suggest GitHub issue work with clear requirements and acceptance criteria/);
    assert.match(agents, /branch-check: verify the current branch matches the active issue before shipping/);
    assert.match(agents, /implementation: implement the complete issue scope/);
    assert.match(agents, /audit: run the configured manual UI audit/);
    assert.match(agents, /review: run `aie review gate <issue> --prompt`, use `aie pr view <pr> --json` for concise PR state when inspecting, run `aie pr gate <pr>` when a PR exists to request reviewers/);
    assert.match(agents, /test: run configured quality gates/);
    assert.match(agents, /PR: commit intentional source changes, push the issue branch, open a non-draft, ready-for-review pull request that closes the issue/);
    assert.match(agents, /merge: address review\/check feedback, loop back to implementation when a gate fails/);
    assert.match(agents, /completion: after merge, run `aie complete <issue>`/);
    assert.match(agents, /pull-base: return to `main` and pull `origin\/main`/);
    assert.match(agents, /next-issue: inspect the queue, resume active work before starting new work/);
    const completeIndex = agents.indexOf('After merge, run `aie complete <issue>`');
    const baseUpdateIndex = agents.indexOf('return to the configured base branch', completeIndex);
    assert.notEqual(completeIndex, -1);
    assert.notEqual(baseUpdateIndex, -1);
    assert.ok(completeIndex < baseUpdateIndex);
    assert.match(agents, /placeholder command classes, stubs, no-op implementations/);
    assert.match(agents, /milestone numbers, bootstrap phases, issue implementation history, baseline language/);
    assert.match(agents, /reference repository names, local reference paths, or source-provenance explanations/);
    assert.match(agents, /Use `aie pr view <pr> --json`, `aie pr gate <pr>`, and `aie pr body <issue>` for pull request state/);
    assert.match(agents, /Avoid raw `gh pr view` comment or review payloads/);
    assert.match(agents, /Stop implementation work cleanly and report the exact blocker/);
    assert.match(agents, /implementation stop conditions do not block explicitly user-directed analysis, investigation, queue triage, or manual GitHub issue creation and issue suggestion/);
    assert.match(agents, /repository meta documentation/);
    assert.match(agents, /Create or edit repository docs only when the active issue explicitly asks/);
    assert.match(agents, /Do not commit generated build output unless repository policy explicitly allows it/);
    assert.match(agents, /Use exact dependency versions/);
    assert.match(agents, /canonical supply-chain guard/);
    assert.match(agents, /Before dependency, package-manager, CI\/release, IDE\/MCP, or AI-agent-tooling work/);
    assert.match(agents, /Preserve or update lockfiles intentionally/);
    assert.match(agents, /Disable lifecycle or build scripts/);
    assert.match(agents, /package-age gates before adding or upgrading dependencies/);
    assert.match(agents, /pin them to immutable full-length commit SHAs/);
    assert.match(agents, /Stop for explicit user approval when package age, identity, source\/provenance, integrity, or execution risk cannot be verified/);
    assert.match(command, /Never ask questions during normal work/);
    assert.match(command, /Think holistically/);
    assert.match(command, /explicit full authorization under repository policy to commit, push, create non-draft PRs, run `aie pr gate <pr>` to request reviewers, wait for configured review gates, and check status, merge, run `aie complete <issue>`, pull the configured base branch, and continue/);
    assert.match(command, /Analysis, investigation, queue triage, and manual GitHub issue creation or issue suggestion are allowed before implementation starts when the user explicitly asks/);
    assert.match(command, /Use `aie pr view <pr> --json`, `aie pr gate <pr>`, and `aie pr body <issue>` for pull request state instead of raw `gh pr view` review\/comment payloads whenever possible/);
    assert.match(command, /no linked worktree is in use/);
    assert.match(command, /tests\/audits\/configured gates/);
    assert.match(command, /non-draft, ready-for-review pull request with issue closure -> `aie pr gate <pr>` to request reviewers, wait for configured review gates, and check status/);
    assert.match(command, /open the non-draft, ready-for-review pull request/);
    assert.match(command, /merge once repository policy, CI, required tests, and configured gates are satisfied/);
    assert.match(command, /configured gates cannot run/);
    assert.match(command, /Stop implementation only when/);
    assert.match(command, /manual GitHub issue creation or issue suggestion may still proceed before implementation starts/);
    assert.match(command, /Report the exact blocker and the next Executor command or repository action/);
    assert.match(command, /Go\./);
  });

  it('omits configurable safety instruction blocks when disabled by policy', async () => {
    const repo = makeGitRepo();
    const result = await runInit({
      target: '.',
      tool: 'opencode',
      dryRun: false,
      force: false,
      cwd: repo,
      policy: {
        instructions: {
          promptInjectionWarning: false,
          noCreditWarning: false,
          implementationGuardrails: false,
          supplyChainSafety: false,
        },
      },
    });

    assert.equal(result.ok, true);
    const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
    assert.doesNotMatch(agents, /untrusted task input/);
    assert.doesNotMatch(agents, /agent, model, service, or vendor credit/);
    assert.doesNotMatch(agents, /placeholder command classes/);
    assert.doesNotMatch(agents, /package-age gates before adding or upgrading dependencies/);
    assert.doesNotMatch(agents, /ZarK\/ai-supply-chain-guard/);
  });

  it('applies non-interactive policy overrides to config and generated instructions', async () => {
    const repo = makeGitRepo();

    const result = await runInit({
      target: '.',
      tool: 'opencode',
      dryRun: false,
      force: false,
      cwd: repo,
      policy: {
        branchNaming: 'work/<number>-<slug>',
        baseBranch: 'trunk',
        baseRemote: 'upstream',
        noWorktree: true,
        blockOnOpenPRs: true,
        requireBaseBranchFreshness: true,
        autonomousMode: true,
        milestoneOrdering: { enabled: true, order: ['M1', 'M2'], missingAssignment: 'ignore' },
        instructions: { namingRules: true },
        supplyChain: { pinCiActions: false, packageAgeDays: 10, highRiskPackageAgeDays: 20 },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.policy.namingRules, true);
    assert.equal(result.policy.milestoneOrdering, true);
    const config = JSON.parse(readFileSync(join(repo, 'aie.config.json'), 'utf8'));
    assert.equal(config.policy.branch.baseBranch, 'trunk');
    assert.equal(config.policy.branch.baseRemote, 'upstream');
    assert.equal(config.policy.instructions.namingRules, true);
    assert.equal(config.policy.milestoneOrdering.enabled, true);
    assert.deepEqual(config.policy.milestoneOrdering.order, ['M1', 'M2']);
    assert.equal(config.policy.supplyChain.packageAgeDays, 10);
    assert.equal(config.policy.supplyChain.pinCiActions, false);
    const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
    assert.match(agents, /Base branch: `upstream\/trunk`/);
    assert.match(agents, /Naming rules:/);
    assert.match(agents, /package-age gates before adding or upgrading dependencies: 10 full days by default and 20 full days/);
    assert.match(agents, /follow configured repository pinning policy/);
  });

  it('writes project npm defaults only when explicitly accepted', async () => {
    const repo = makeGitRepo();

    const defaults = await runInit({ target: '.', tool: 'opencode', dryRun: false, force: false, cwd: repo });
    assert.equal(defaults.ok, true);
    assert.equal(existsSync(join(repo, '.npmrc')), false);

    const optedInRepo = makeGitRepo();
    const optedIn = await runInit({ target: '.', tool: 'opencode', dryRun: false, force: false, cwd: optedInRepo, policy: { supplyChain: { writePackageManagerDefaults: true } } });

    assert.equal(optedIn.ok, true);
    assert.equal(readFileSync(join(optedInRepo, '.npmrc'), 'utf8'), 'ignore-scripts=true\nsave-exact=true\n');
  });

  it('blocks existing npm defaults unless force is supplied', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, '.npmrc'), 'registry=https://registry.npmjs.org/\n');

    const blocked = await runInit({ target: '.', tool: 'opencode', dryRun: false, force: false, cwd: repo, policy: { supplyChain: { writePackageManagerDefaults: true } } });
    assert.equal(blocked.ok, false);
    assert.match(blocked.errors.join('\n'), /Existing \.npmrc is missing/);
    assert.equal(readFileSync(join(repo, '.npmrc'), 'utf8'), 'registry=https://registry.npmjs.org/\n');

    const forced = await runInit({ target: '.', tool: 'opencode', dryRun: false, force: true, cwd: repo, policy: { supplyChain: { writePackageManagerDefaults: true } } });
    assert.equal(forced.ok, true);
    assert.match(readFileSync(join(repo, '.npmrc'), 'utf8'), /ignore-scripts=true\nsave-exact=true/);
  });

  it('recognizes equivalent existing npm defaults', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, '.npmrc'), 'IGNORE-SCRIPTS = true # reviewed\nsave-exact=true\n');

    const result = await runInit({ target: '.', tool: 'opencode', dryRun: false, force: false, cwd: repo, policy: { supplyChain: { writePackageManagerDefaults: true } } });

    assert.equal(result.ok, true);
    assert.equal(result.actions.find(action => action.id === 'npm-secure-defaults').status, 'skipped');
    assert.equal(readFileSync(join(repo, '.npmrc'), 'utf8'), 'IGNORE-SCRIPTS = true # reviewed\nsave-exact=true\n');
  });

  it('blocks unmanaged command-file conflicts unless force is supplied', async () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, '.opencode', 'commands'), { recursive: true });
    writeFileSync(join(repo, '.opencode', 'commands', 'make-it-so.md'), 'custom command\n');

    const blocked = await runInit({ target: '.', tool: 'opencode', dryRun: false, force: false, cwd: repo });
    assert.equal(blocked.ok, false);
    assert.match(blocked.errors.join('\n'), /make-it-so\.md/);
    assert.equal(readFileSync(join(repo, '.opencode', 'commands', 'make-it-so.md'), 'utf8'), 'custom command\n');

    const forced = await runInit({ target: '.', tool: 'opencode', dryRun: false, force: true, cwd: repo });
    assert.equal(forced.ok, true);
    assert.match(readFileSync(join(repo, '.opencode', 'commands', 'make-it-so.md'), 'utf8'), /BEGIN EXECUTOR MANAGED SECTION/);
  });

  it('detects legacy helper files and installs alongside without cleanup', async () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, 'scripts', 'lib'), { recursive: true });
    writeFileSync(join(repo, 'scripts', 'gh-workflow.sh'), '#!/bin/sh\n# issue work helper\n');
    writeFileSync(join(repo, 'scripts', 'lib', 'gh-priority-order.sh'), '#!/bin/sh\n# queue helper\n');
    writeFileSync(join(repo, 'scripts', 'gh-pr-review-gate.sh'), '#!/bin/sh\n# pull request helper\n');

    const result = await runInit({ target: '.', tool: 'opencode', dryRun: false, force: false, cwd: repo });
    const legacyByCategory = new Map(result.legacy.map(item => [item.category, item]));

    assert.equal(result.ok, true);
    assert.equal(legacyByCategory.get('lifecycle').action, 'install-alongside');
    assert.equal(legacyByCategory.get('queue').paths.includes(join('scripts', 'lib', 'gh-priority-order.sh')), true);
    assert.equal(legacyByCategory.get('pull-request').paths.includes(join('scripts', 'gh-pr-review-gate.sh')), true);
    assert.deepEqual(result.legacy.map(item => item.category), ['queue', 'lifecycle', 'pull-request']);
    assert.deepEqual(legacyByCategory.get('queue').choices, ['leave-untouched', 'install-alongside', 'install-compatibility-wrappers', 'cleanup-and-replace', 'defer-to-migration']);
    assert.match(result.warnings.join('\n'), /installs Executor alongside and leaves existing files untouched/);
    assert.equal(readFileSync(join(repo, 'scripts', 'gh-workflow.sh'), 'utf8'), '#!/bin/sh\n# issue work helper\n');
    assert.equal(readFileSync(join(repo, 'scripts', 'lib', 'gh-priority-order.sh'), 'utf8'), '#!/bin/sh\n# queue helper\n');
    assert.match(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), /BEGIN EXECUTOR MANAGED SECTION/);
  });

  it('blocks legacy instruction content until force is supplied', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'AGENTS.md'), '# Project instructions\n\nUse gh-workflow.sh for issue work.\n');

    const blocked = await runInit({ target: '.', tool: 'opencode', dryRun: false, force: false, cwd: repo });

    assert.equal(blocked.ok, false);
    assert.equal(blocked.legacy[0].category, 'instructions');
    assert.equal(blocked.legacy[0].action, 'defer-to-migration');
    assert.match(blocked.errors.join('\n'), /leave untouched, install alongside managed Executor files, install compatibility wrappers, clean up and replace known helpers, or defer to migration/);
    assert.doesNotMatch(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), /BEGIN EXECUTOR MANAGED SECTION/);

    const forced = await runInit({ target: '.', tool: 'opencode', dryRun: false, force: true, cwd: repo });

    assert.equal(forced.ok, true);
    assert.match(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), /Use gh-workflow\.sh for issue work/);
    assert.match(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), /BEGIN EXECUTOR MANAGED SECTION/);
  });

  it('requires force for managed sections with missing checksums', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'AGENTS.md'), [
      '<!-- BEGIN EXECUTOR MANAGED SECTION -->',
      '## Executor Issue Workflow',
      '<!-- END EXECUTOR MANAGED SECTION -->',
      '',
    ].join('\n'));

    const blocked = await runInit({ target: '.', tool: 'opencode', dryRun: false, force: false, cwd: repo });

    assert.equal(blocked.ok, false);
    assert.match(blocked.errors.join('\n'), /Managed section was edited outside Executor/);
    assert.match(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), /## Executor Issue Workflow/);

    const forced = await runInit({ target: '.', tool: 'opencode', dryRun: false, force: true, cwd: repo });

    assert.equal(forced.ok, true);
    assert.match(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), /executor-managed-checksum/);
  });

  it('keeps managed sections idempotent after CRLF line ending conversion', async () => {
    const repo = makeGitRepo();
    await runInit({ target: '.', tool: 'opencode', dryRun: false, force: false, cwd: repo });
    const agentsPath = join(repo, 'AGENTS.md');
    writeFileSync(agentsPath, readFileSync(agentsPath, 'utf8').replace(/\n/g, '\r\n'));

    const second = await runInit({ target: '.', tool: 'opencode', dryRun: false, force: false, cwd: repo });

    assert.equal(second.ok, true);
    assert.equal(second.actions.find(action => action.path === 'AGENTS.md').status, 'skipped');
  });

  it('labels forced malformed config rewrites as config updates', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'aie.config.json'), '{broken');

    const result = await runInit({ target: '.', tool: 'opencode', dryRun: false, force: true, cwd: repo });

    assert.equal(result.ok, true);
    assert.equal(result.actions.find(action => action.path === 'aie.config.json').operation, 'update-config');
  });

  it('preserves requested policy summaries in blocked init plans', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'aie.config.json'), '{broken');
    const policy = { instructions: { namingRules: true }, milestoneOrdering: { enabled: true, missingAssignment: 'block' } };

    const blockedConfig = await buildInitPlan({ target: '.', tool: 'opencode', dryRun: true, force: false, cwd: repo, policy });
    const unsupportedTool = await buildInitPlan({ target: '.', tool: 'bad-tool', dryRun: true, force: false, cwd: repo, policy });
    const nonRepo = await buildInitPlan({ target: '.', tool: 'opencode', dryRun: true, force: false, cwd: tmpdir(), policy });

    assert.equal(blockedConfig.ok, false);
    assert.equal(blockedConfig.policy.namingRules, true);
    assert.equal(blockedConfig.policy.milestoneOrdering, true);
    assert.equal(blockedConfig.policy.missingMilestonePolicy, 'block');
    assert.equal(unsupportedTool.policy.namingRules, true);
    assert.equal(nonRepo.policy.namingRules, true);
  });

  it('plans all supported tools and rejects unsupported tool values', async () => {
    const repo = makeGitRepo();
    const all = await buildInitPlan({ target: '.', tool: 'all', dryRun: true, force: false, cwd: repo });
    assert.equal(all.ok, true);
    assert.deepEqual(all.selectedTools, ['opencode', 'codex', 'claude-code']);
    assert.ok(all.actions.some(action => action.path === 'CLAUDE.md'));

    const invalid = await buildInitPlan({ target: '.', tool: 'bad-tool', dryRun: true, force: false, cwd: repo });
    assert.equal(invalid.ok, false);
    assert.match(invalid.errors[0], /Unsupported init tool/);
  });

  it('models supported host capabilities and uses migration policy choices in init plans', async () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    writeFileSync(join(repo, 'scripts', 'gh-issue-start.sh'), '#!/bin/sh\n');

    const { getAllAgentHostProfiles, hostIdsForInstructionPath } = require('../dist/agent_hosts.js');
    const profiles = getAllAgentHostProfiles();
    const opencode = profiles.find(profile => profile.id === 'opencode');
    const codex = profiles.find(profile => profile.id === 'codex');
    const claude = profiles.find(profile => profile.id === 'claude-code');

    assert.equal(profiles.length, 3);
    assert.ok(opencode);
    assert.ok(codex);
    assert.ok(claude);
    assert.equal(opencode.supportsProjectCommands, true);
    assert.deepEqual(opencode.commandTargets.map(target => target.path), [pathPosix.join('.opencode', 'commands', 'make-it-so.md'), pathPosix.join('.opencode', 'commands', 'makeitso.md')]);
    assert.equal(codex.supportsProjectCommands, false);
    assert.equal(codex.todo.tools.includes('update_plan'), true);
    assert.equal(claude.instructionTargets[0].path, 'CLAUDE.md');
    const agentsHosts = hostIdsForInstructionPath('AGENTS.md');
    assert.deepEqual(agentsHosts, ['opencode', 'codex']);

    const wrapperPlan = await buildInitPlan({ target: '.', tool: 'opencode', dryRun: true, force: false, cwd: repo, policy: { migration: { legacyScripts: 'install-wrappers' } } });
    const cleanupPlan = await buildInitPlan({ target: '.', tool: 'opencode', dryRun: true, force: false, cwd: repo, policy: { migration: { cleanupKnownHelpers: true } } });
    assert.equal(wrapperPlan.ok, true);
    assert.equal(cleanupPlan.ok, true);
    assert.ok(Array.isArray(wrapperPlan.legacy));
    assert.ok(Array.isArray(cleanupPlan.legacy));
    const wrapperLifecycle = wrapperPlan.legacy.find(item => item.category === 'lifecycle');
    const cleanupLifecycle = cleanupPlan.legacy.find(item => item.category === 'lifecycle');
    assert.ok(wrapperLifecycle);
    assert.ok(cleanupLifecycle);

    assert.equal(wrapperLifecycle.action, 'install-compatibility-wrappers');
    assert.match(wrapperLifecycle.nextCommand, /--install-wrappers --dry-run/);
    assert.equal(cleanupLifecycle.action, 'cleanup-and-replace');
    assert.match(cleanupLifecycle.nextCommand, /--cleanup --dry-run/);
  });
});

describe('init command metadata', () => {
  it('publishes registry-backed schema metadata', () => {
    const { getCommandMetadata } = require('../dist/command_metadata.js');
    const metadata = getCommandMetadata('init');

    assert.ok(metadata.description.includes('Initialize Executor config'));
    assert.deepEqual(metadata.args, ['target']);
    assert.ok(metadata.flags.includes('--json'));
    assert.ok(metadata.flags.includes('--dry-run'));
    assert.ok(metadata.flags.includes('--force'));
    assert.ok(metadata.flags.includes('--yes'));
    assert.ok(metadata.flags.includes('--defaults'));
    assert.ok(metadata.flags.includes('--tool'));
    assert.ok(metadata.flags.includes('--naming-rules'));
    assert.ok(metadata.flags.includes('--opencode-command-alias'));
    assert.ok(metadata.flags.includes('--pin-ci-actions'));
    assert.ok(metadata.flags.includes('--package-manager-defaults'));
    assert.equal(metadata.mutates, true);
    assert.deepEqual(metadata.mutationTargets, ['local-files']);
    assert.equal(metadata.supportsJson, true);
    assert.equal(metadata.supportsDryRun, true);
  });

  it('prints safe usage for init help forms without mutation', () => {
    const repo = makeGitRepo();
    const missing = binRun(['init'], repo);
    const suffixHelp = binRun(['init', 'help'], repo);
    const prefixHelp = binRun(['help', 'init'], repo);
    const flagHelp = binRun(['init', '--help'], repo);
    const json = binRun(['init', '--json'], repo);
    const jsonWithTool = binRun(['init', '--tool', 'all', '--json'], repo);
    const jsonWithListFlag = binRun(['init', '--component-label', 'C-Core', '--milestone-order', 'M1', '--json'], repo);

    assert.equal(missing.status, 0);
    assert.match(missing.stdout, /Usage: aie init <target>/);
    assert.equal(suffixHelp.status, 0);
    assert.match(suffixHelp.stdout, /Usage:/);
    assert.equal(prefixHelp.status, 0);
    assert.match(prefixHelp.stdout, /Usage:/);
    assert.equal(flagHelp.status, 0);
    assert.match(flagHelp.stdout, /Usage:/);
    assert.equal(json.status, 0);
    assert.equal(JSON.parse(json.stdout).usage, 'aie init <target> [--tool opencode|codex|claude-code|all] [--defaults] [--yes] [--dry-run] [--force] [--json]');
    assert.equal(jsonWithTool.status, 0);
    assert.equal(JSON.parse(jsonWithTool.stdout).usage, 'aie init <target> [--tool opencode|codex|claude-code|all] [--defaults] [--yes] [--dry-run] [--force] [--json]');
    assert.equal(jsonWithListFlag.status, 0);
    assert.equal(JSON.parse(jsonWithListFlag.stdout).usage, 'aie init <target> [--tool opencode|codex|claude-code|all] [--defaults] [--yes] [--dry-run] [--force] [--json]');
    assert.equal(existsSync(join(repo, 'aie.config.json')), false);
  });

  it('emits stable JSON dry-run output from the CLI', () => {
    const repo = makeGitRepo();
    const result = binRun(['init', '.', '--dry-run', '--json'], repo);
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, 'init');
    assert.equal(parsed.dryRun, true);
    assert.deepEqual(parsed.selectedTools, ['opencode']);
    assert.equal(parsed.policy.namingRules, false);
    assert.equal(parsed.actions.length, 3);
    assert.equal(existsSync(join(repo, 'aie.config.json')), false);
  });

  it('runs defaults and yes mode without prompts and writes default policy', () => {
    const repo = makeGitRepo();
    const result = binRun(['init', '.', '--defaults', '--yes', '--json'], repo);
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.policy.namingRules, false);
    assert.equal(parsed.policy.supplyChainSafety, true);
    const config = JSON.parse(readFileSync(join(repo, 'aie.config.json'), 'utf8'));
    assert.equal(config.policy.branch.noWorktree, true);
    assert.equal(config.policy.branch.blockOnOpenPRs, true);
    assert.equal(config.policy.branch.requireBaseBranchFreshness, true);
    assert.equal(config.policy.instructions.namingRules, false);
  });

  it('honors init policy flags without prompting in JSON mode', () => {
    const repo = makeGitRepo();
    const result = binRun([
      'init',
      '.',
      '--dry-run',
      '--json',
      '--tool',
      'all',
      '--naming-rules',
      '--milestone-ordering',
      '--milestone-order',
      'M1,M2',
      '--missing-milestone',
      'ignore',
      '--package-age-days',
      '9',
      '--high-risk-package-age-days',
      '15',
      '--no-pin-ci-actions',
      '--review-agent',
      'review-bot',
      '--opencode-command-alias',
    ], repo);
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.deepEqual(parsed.selectedTools, ['opencode', 'codex', 'claude-code']);
    assert.equal(parsed.policy.namingRules, true);
    assert.equal(parsed.policy.milestoneOrdering, true);
    assert.equal(parsed.policy.missingMilestonePolicy, 'ignore');
    assert.equal(parsed.policy.opencodeCommandAlias, true);
    assert.equal(parsed.actions.some((action) => action.path === '.opencode/commands/makeitso.md'), true);
    assert.equal(parsed.actions.some((action) => action.path === 'CLAUDE.md'), true);
    assert.equal(existsSync(join(repo, 'aie.config.json')), false);
  });

  it('reports unsupported init policy values before mutation', () => {
    const repo = makeGitRepo();
    const result = binRun(['init', '.', '--missing-milestone', 'required', '--json'], repo);
    const shortJson = binRun(['init', '.', '--missing-milestone', 'required', '-j'], repo);

    assert.notEqual(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /Failed to parse init arguments/);
    assert.notEqual(shortJson.status, 0);
    assert.equal(JSON.parse(shortJson.stdout).ok, false);
    assert.equal(existsSync(join(repo, 'aie.config.json')), false);
  });

  it('publishes non-interactive negative policy flags in schema metadata', () => {
    const { getImplementedCommands } = require('../dist/command_metadata.js');
    const metadata = getImplementedCommands().find(command => command.name === 'init');

    assert.ok(metadata.flags.includes('--no-naming-rules'));
    assert.ok(metadata.flags.includes('--no-milestone-ordering'));
    assert.ok(metadata.flags.includes('--pin-ci-actions'));
    assert.ok(metadata.flags.includes('--no-pin-ci-actions'));
    assert.ok(metadata.flags.includes('--opencode-command-alias'));
    assert.ok(metadata.flags.includes('--no-opencode-command-alias'));
    assert.ok(metadata.flags.includes('--no-package-manager-defaults'));
    const tool = metadata.flagDetails.find(flag => flag.name === '--tool');
    const missingMilestone = metadata.flagDetails.find(flag => flag.name === '--missing-milestone');
    const age = metadata.flagDetails.find(flag => flag.name === '--package-age-days');
    assert.deepEqual(tool.options, ['opencode', 'codex', 'claude-code', 'all']);
    assert.deepEqual(missingMilestone.options, ['ignore', 'warn', 'block']);
    assert.equal(age.type, 'integer');
  });

  it('generated content uses product wording only', async () => {
    const repo = makeGitRepo();
    const result = await runInit({ target: '.', tool: 'all', dryRun: false, force: false, cwd: repo });
    assert.equal(result.ok, true);
    const generated = [
      readFileSync(join(repo, 'AGENTS.md'), 'utf8'),
      readFileSync(join(repo, 'CLAUDE.md'), 'utf8'),
      readFileSync(join(repo, '.opencode', 'commands', 'make-it-so.md'), 'utf8'),
    ].join('\n');

    assert.doesNotMatch(generated, /\breferences\b/i);
    assert.doesNotMatch(generated, new RegExp(['source', 'repository'].join(' '), 'i'));
    assert.doesNotMatch(generated, new RegExp(['planning', 'history'].join(' '), 'i'));
    assert.match(generated, /Do not mention milestone numbers, bootstrap phases, issue implementation history, baseline language/);
    assert.match(generated, /reference repository names, local reference paths, or source-provenance explanations/);
  });
});
