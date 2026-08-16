const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { cloneGitRepo } = require('./support/git_fixture.cjs');
const { execFileSync, spawnSync } = require('node:child_process');
const { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, posix: pathPosix } = require('node:path');
const { pathToFileURL } = require('node:url');

const { buildInitPlan, runInit } = require('../dist/init/index.js');
const { configToFileShape, getDefaults } = require('../dist/config/index.js');
const { renderAgentInstructions } = require('../dist/init_content.js');
const { getAgentHostProfiles } = require('../dist/agent_hosts.js');
const { renderManagedSection } = require('../dist/managed_file.js');

const EXPECTED_PR_CADENCE_LINES = [
  'Fix merge-blocking feedback in the same issue and pull request; never defer a blocker to a new issue.',
  'Blocking findings are limited to: correctness bugs, security or trust risks, broken required CI or checks, and failed acceptance criteria of the active issue. Everything else is advisory.',
  'Treat non-blocking polish (advisory findings, nits, style preferences) as: fix it in the same pull request when cheap, otherwise drop it, or fold it into an already-queued Ready issue if it genuinely matches that scope. Never open a new GitHub issue to track review or audit leftovers.',
  'Reviews, audits, and `qube aie pr triage <pr>` report advisory findings for this in-PR fix-or-drop disposition; they do not suggest or automate `gh issue create`, and neither should you.',
  'Run one fresh multi-lane review pass per pull request head. Cap reviews at two rounds unless a blocker fix materially changes the head. After round two, when required checks are green and no unresolved blockers remain, merge; handle residual advisories by the fix-or-drop disposition above.',
  'While a review gate or review lane runs, do not edit files, commit, or move the branch head; isolated lanes fail when the checkout changes mid-run. Finish or stop the gate before making changes.',
  'Commit only intentional, issue-scoped changes. Never commit unrelated untracked files that accumulate in the working tree.',
];

function extractPrCadenceLines(text) {
  const heading = 'PR review and merge cadence:\n\n';
  const start = text.indexOf(heading);
  assert.ok(start >= 0, 'missing PR review and merge cadence heading');
  const lines = [];
  for (const line of text.slice(start + heading.length).split('\n')) {
    if (!line.startsWith('- ')) break;
    lines.push(line.slice(2));
  }
  return lines;
}

function assertPrCadence(text) {
  assert.deepEqual(extractPrCadenceLines(text), EXPECTED_PR_CADENCE_LINES);
  assert.doesNotMatch(text, /Target a few strong review rounds/);
}

function makeGitRepo() {
  const repo = cloneGitRepo('committed', 'aie-init-');
  mkdirSync(join(repo, '.qube', 'aie'), { recursive: true });
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
    assert.deepEqual(result.actions.map(action => action.path), [join('.qube', 'aie', 'config.json'), '.gitignore', 'AGENTS.md', opencodeCommandPath('make-it-so.md')]);
    assert.equal(result.actions.every(action => action.status === 'planned'), true);
    assert.equal(existsSync(join(repo, '.qube/aie/config.json')), false);
    assert.equal(existsSync(join(repo, 'AGENTS.md')), false);
  });

  it('writes Claude Code command and skill assets without installing unselected review agents', async () => {
    const repo = makeGitRepo();
    const result = await runInit({ target: '.', tool: 'claude-code', dryRun: false, force: false, cwd: repo });
    assert.equal(result.ok, true);
    const command = readFileSync(join(repo, '.claude', 'commands', 'make-it-so.md'), 'utf8');
    const skill = readFileSync(join(repo, '.claude', 'skills', 'make-it-so', 'SKILL.md'), 'utf8');
    const claude = readFileSync(join(repo, 'CLAUDE.md'), 'utf8');
    assert.match(command, /Continue repository development/);
    assert.match(skill, /Continue repository development/);
    assert.match(claude, /\.claude\/commands\/make-it-so\.md/);
    assert.doesNotMatch(claude, /\.claude\/agents\/qube-review-focus\.md/);
    assert.equal(existsSync(join(repo, '.claude', 'agents', 'qube-review-focus.md')), false);
  });

  it('plans Grok Build as its own init tool and does not write Codex files', async () => {
    const repo = makeGitRepo();
    const planned = await buildInitPlan({ target: '.', tool: 'grok-build', dryRun: true, force: false, cwd: repo });
    assert.equal(planned.ok, true);
    assert.deepEqual(planned.selectedTools, ['grok-build']);
    assert.deepEqual(planned.actions.map(action => action.path), [
      join('.qube', 'aie', 'config.json'),
      '.gitignore',
      'AGENTS.md',
      '.grok/commands/make-it-so.md',
      '.grok/skills/make-it-so/SKILL.md',
    ]);

    const result = await runInit({ target: '.', tool: 'grok-build', dryRun: false, force: false, cwd: repo });
    assert.equal(result.ok, true);
    const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
    assert.match(agents, /Grok Build:/);
    assert.match(agents, /Do not invent a Grok todo tool/);
    assert.match(agents, /\.grok\/commands\/make-it-so\.md/);
    assert.match(agents, /\.grok\/skills\/make-it-so\/SKILL.md/);
    assert.doesNotMatch(agents, /\.codex\//);
    assert.equal(existsSync(join(repo, '.grok', 'commands', 'make-it-so.md')), true);
    assert.equal(existsSync(join(repo, '.grok', 'skills', 'make-it-so', 'SKILL.md')), true);
    assert.equal(existsSync(join(repo, '.codex')), false);
    assert.equal(existsSync(join(repo, '.claude')), false);
    assert.equal(existsSync(join(repo, 'CLAUDE.md')), false);

    const cli = binRun(['init', '.', '--tool', 'grok-build', '--dry-run', '--json'], repo);
    assert.equal(cli.status, 0, cli.stderr);
    const parsed = JSON.parse(cli.stdout);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.selectedTools, ['grok-build']);
  });

  it('shares one AGENTS.md managed section for Grok Build plus Codex', async () => {
    const repo = makeGitRepo();
    const planned = await buildInitPlan({ target: '.', tool: 'grok-build,codex', dryRun: true, force: false, cwd: repo });
    assert.equal(planned.ok, true);
    assert.deepEqual(planned.selectedTools, ['codex', 'grok-build']);
    const result = await runInit({ target: '.', tool: 'grok-build,codex', dryRun: false, force: false, cwd: repo });
    assert.equal(result.ok, true);
    const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
    assert.equal((agents.match(/<!-- BEGIN EXECUTOR MANAGED SECTION -->/g) || []).length, 1);
    assert.match(agents, /Grok Build:/);
    assert.match(agents, /Codex:/);
    assert.match(agents, /\.codex\/prompts\/make-it-so\.md/);
    assert.equal(existsSync(join(repo, '.codex', 'prompts', 'make-it-so.md')), true);
  });

  it('writes the Codex make-it-so prompt for a Codex-only init', async () => {
    const repo = makeGitRepo();
    const result = await runInit({ target: '.', tool: 'codex', dryRun: false, force: false, cwd: repo });
    assert.equal(result.ok, true);
    const prompt = readFileSync(join(repo, '.codex', 'prompts', 'make-it-so.md'), 'utf8');
    const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
    assert.match(prompt, /Continue repository development/);
    assert.match(agents, /\.codex\/prompts\/make-it-so\.md/);
    assert.doesNotMatch(agents, /\.codex\/agents\/qube-review-focus\.toml/);
    assert.equal(existsSync(join(repo, '.codex', 'agents', 'qube-review-focus.toml')), false);
  });

  it('writes managed sections and preserves user-authored instruction content', async () => {
    const repo = makeGitRepo();
    const userContent = '# Project Rules\n\nKeep this local rule.   \n\n';
    writeFileSync(join(repo, 'AGENTS.md'), userContent);

    const result = await runInit({
      target: '.',
      tool: 'opencode',
      dryRun: false,
      force: false,
      cwd: repo,
      yes: true,
      guide: true,
      installedHosts: ['grok-build'],
      policy: {
        reviewModels: {
          review: { 'grok-build': { model: 'grok-4.5', effort: null } },
          economy: {},
          synthesis: {},
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.completedChanges.length, 4);
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
    assert.match(agents, /qube autoresearch --help/);
    assert.match(agents, /synthesize the arena before edits/);
    const command = readFileSync(join(repo, '.opencode', 'commands', 'make-it-so.md'), 'utf8');
    assert.match(command, /Continue repository development/);
    assert.match(command, /run `qube aie pr gate <pr>` to request reviewers/);
    assert.match(command, /configured gates cannot run/);
    assert.match(agents, /Review mode: isolated\./);
    assert.match(agents, /pr-review-wait/);
    const config = JSON.parse(readFileSync(join(repo, '.qube/aie/config.json'), 'utf8'));
    assert.equal(config.version, 1);
    assert.equal(config.providers.work.kind, 'github');
    assert.equal(config.providers.repository.kind, 'local-git');
    assert.equal(config.policy.branch.naming, 'issue/<number>-<slug>');
    assert.equal(config.policy.branch.requireBaseBranchFreshness, true);
    assert.equal(config.policy.lifecycle.assignOnStart, true);
    assert.equal(config.policy.lifecycle.commentOnStart, true);
    assert.deepEqual(config.policy.reviews.agents, []);
    assert.equal(config.policy.reviews.adapter, 'local');
    assert.equal(config.policy.reviews.mode, 'isolated');
    assert.equal(config.policy.reviews.profile, 'local-focused');
    assert.deepEqual(config.policy.reviews.localAgents, []);
    assert.equal(config.policy.reviews.waitMinutes, 0);
    assert.equal(config.policy.instructions.opencodeCommandAlias, false);
    assert.equal(config.policy.instructions.namingRules, false);
    assert.equal(config.policy.supplyChain.packageAgeDays, 7);
    assert.equal(config.policy.supplyChain.pinCiActions, true);
  });

  it('writes selected work, review, and CI providers into config and instructions', async () => {
    const repo = makeGitRepo();
    const result = await runInit({
      target: '.',
      tool: 'opencode',
      dryRun: false,
      force: false,
      cwd: repo,
      policy: { workProvider: 'jira', reviewProvider: 'gitlab', ciProvider: 'jenkins' },
    });

    assert.equal(result.ok, true);
    const config = JSON.parse(readFileSync(join(repo, '.qube/aie/config.json'), 'utf8'));
    assert.equal(config.providers.work.kind, 'jira');
    assert.equal(config.providers.review.kind, 'gitlab');
    assert.equal(config.providers.ci.kind, 'jenkins');
    const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
    assert.match(agents, /configured work provider is Jira and the configured review provider is GitLab/);
    assert.match(agents, /Configured providers: work Jira, review GitLab, repository local git, CI Jenkins jobs, layout local filesystem/);
    assert.doesNotMatch(agents, /configured work and review provider is GitHub/);
  });

  it('infers GitLab review when work is GitLab and review is omitted', async () => {
    const repo = makeGitRepo();
    const result = await runInit({
      target: '.',
      tool: 'opencode',
      dryRun: false,
      force: false,
      cwd: repo,
      policy: { workProvider: 'gitlab', ciProvider: 'gitlab' },
    });

    assert.equal(result.ok, true);
    const config = JSON.parse(readFileSync(join(repo, '.qube/aie/config.json'), 'utf8'));
    assert.equal(config.providers.work.kind, 'gitlab');
    assert.equal(config.providers.review.kind, 'gitlab');
    assert.equal(config.providers.ci.kind, 'gitlab');
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
    writeFileSync(join(repo, '.qube/aie/config.json'), `${JSON.stringify({ version: 1, customPolicy: { keep: true } }, null, 2)}\n`);

    const blocked = await runInit({ target: '.', tool: 'codex', dryRun: false, force: false, cwd: repo });
    assert.equal(blocked.ok, false);
    assert.match(blocked.errors.join('\n'), /customPolicy/);

    const result = await runInit({ target: '.', tool: 'codex', dryRun: false, force: true, cwd: repo });

    assert.equal(result.ok, true);
    const config = JSON.parse(readFileSync(join(repo, '.qube/aie/config.json'), 'utf8'));
    assert.equal(config.customPolicy, undefined);
    assert.deepEqual(config.policy.labels.statuses, ['S-Ready', 'S-InProgress', 'S-Blocked', 'S-Blocking']);
  });

  it('normalizes partial current config files to full provider and policy shape', async () => {
    const repo = makeGitRepo();
    const config = cleanConfig();
    config.policy.milestoneOrdering = { enabled: true, missingAssignment: 'warn' };
    config.policy.instructions = { namingRules: true };
    config.policy.supplyChain = { packageAgeDays: 8 };
    writeFileSync(join(repo, '.qube/aie/config.json'), `${JSON.stringify({
      version: config.version,
      providers: config.providers,
      policy: config.policy,
    }, null, 2)}\n`);

    const result = await runInit({ target: '.', tool: 'codex', dryRun: false, force: false, cwd: repo });

    assert.equal(result.ok, true);
    const written = JSON.parse(readFileSync(join(repo, '.qube/aie/config.json'), 'utf8'));
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
    writeFileSync(join(repo, '.qube/aie/config.json'), `${JSON.stringify({
      version: 1,
      promptInjectionWarning: false,
      noCreditWarning: false,
    }, null, 2)}\n`);

    const result = await runInit({ target: '.', tool: 'codex', dryRun: false, force: true, cwd: repo });

    assert.equal(result.ok, true);
    const config = JSON.parse(readFileSync(join(repo, '.qube/aie/config.json'), 'utf8'));
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
    writeFileSync(join(repo, '.qube/aie/config.json'), `${JSON.stringify(config, null, 2)}\n`);

    const result = await runInit({ target: '.', tool: 'codex', dryRun: false, force: true, cwd: repo });

    assert.equal(result.ok, true);
    const written = JSON.parse(readFileSync(join(repo, '.qube/aie/config.json'), 'utf8'));
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
    writeFileSync(join(repo, '.qube/aie/config.json'), `${JSON.stringify(config, null, 2)}\n`);

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
      join('.qube', 'aie', 'config.json'),
      '.gitignore',
      'AGENTS.md',
      'CLAUDE.md',
      opencodeCommandPath('make-it-so.md'),
      opencodeCommandPath('makeitso.md'),
      pathPosix.join('.codex', 'prompts', 'make-it-so.md'),
      pathPosix.join('.claude', 'commands', 'make-it-so.md'),
      pathPosix.join('.claude', 'skills', 'make-it-so', 'SKILL.md'),
      pathPosix.join('.grok', 'commands', 'make-it-so.md'),
      pathPosix.join('.grok', 'skills', 'make-it-so', 'SKILL.md'),
    ]);
    assert.doesNotMatch(planned.warnings.join('\n'), /Codex project command files are configured but none are enabled/);
    assert.doesNotMatch(planned.warnings.join('\n'), /Claude Code project command files are not installed/);

    const applied = await runInit({ target: '.', tool: 'all', dryRun: false, force: false, cwd: repo, policy: { opencodeCommandAlias: true } });
    assert.equal(applied.ok, true);
    assert.equal(existsSync(join(repo, '.opencode', 'commands', 'make-it-so.md')), true);
    assert.equal(existsSync(join(repo, '.opencode', 'commands', 'makeitso.md')), true);
    assert.equal(readFileSync(join(repo, '.opencode', 'commands', 'makeitso.md'), 'utf8'), readFileSync(join(repo, '.opencode', 'commands', 'make-it-so.md'), 'utf8'));
  });

  it('installs Codex local review agent and cycle prompt when local codex review is configured', async () => {
    const repo = makeGitRepo();
    const config = cleanConfig();
    config.policy.reviews.adapter = 'local';
    config.policy.reviews.profile = 'local-focused';
    config.policy.reviews.agents = [];
    config.policy.reviews.localAgents = ['codex'];
    writeFileSync(join(repo, '.qube/aie/config.json'), `${JSON.stringify(config, null, 2)}\n`);

    const planned = await buildInitPlan({ target: '.', tool: 'codex', dryRun: true, force: false, cwd: repo });
    assert.equal(planned.ok, true);
    assert.deepEqual(planned.actions.map(action => action.path), [
      join('.qube', 'aie', 'config.json'),
      '.gitignore',
      'AGENTS.md',
      pathPosix.join('.codex', 'prompts', 'make-it-so.md'),
      pathPosix.join('.codex', 'agents', 'qube-review-focus.toml'),
      pathPosix.join('.codex', 'agents', 'qube-review-explorer.toml'),
      pathPosix.join('.codex', 'agents', 'qube-review-digest.toml'),
      pathPosix.join('.codex', 'agents', 'qube-review-librarian.toml'),
    ]);

    const result = await runInit({ target: '.', tool: 'codex', dryRun: false, force: false, cwd: repo });
    assert.equal(result.ok, true);
    const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
    assert.match(agents, /Configured review adapter: local/);
    assert.match(agents, /pr gate <pr> --dry-run --json --local-review-prompts/);
    assert.match(agents, /spawn one independent Codex subagent per lane with `agent_type: "qube-review-focus"`/);
    // Each lane subagent must write current-head evidence and publish its own lane review; the gate only aggregates and verifies.
    assert.match(agents, /require each lane subagent to write its current-head lane evidence JSON and publish its own lane review with/);
    assert.match(agents, /pr review publish <pr> --lane <lane> --issue <issue>/);
    assert.match(agents, /the gate is aggregation and verification after per-lane publication, not the publisher/);
    assert.doesNotMatch(agents, /optional audit evidence/);
    assert.doesNotMatch(agents, /publish through pr gate/);
    const agent = readFileSync(join(repo, '.codex', 'agents', 'qube-review-focus.toml'), 'utf8');
    assert.match(agent, /name = "qube-review-focus"/);
    assert.match(agent, /read-only PR reviewer/);
    assert.match(agent, /^# BEGIN EXECUTOR MANAGED SECTION/);
    assert.doesNotMatch(agent, /<!--/);
    // Lane JSON is required publication input for the subagent, never optional main-agent input.
    assert.match(agent, /required publication input/);
    assert.match(agent, /publish your own lane review with the pr review publish command named in the inline lane prompt/);
    assert.match(agent, /aggregates and verifies published lane feedback after per-lane publication; it does not publish lane feedback for you/);
    assert.doesNotMatch(agent, /optional audit evidence/);
    assert.doesNotMatch(agent, /publish through pr gate/);
  });

  it('renders configured review tier model and effort into the Codex review agent', async () => {
    const repo = makeGitRepo();
    const config = cleanConfig();
    config.policy.reviews.adapter = 'local';
    config.policy.reviews.profile = 'local-focused';
    config.policy.reviews.agents = [];
    config.policy.reviews.localAgents = ['codex'];
    config.policy.reviews.models = { review: { codex: { model: 'gpt-5.5-codex', effort: 'high' } } };
    writeFileSync(join(repo, '.qube/aie/config.json'), `${JSON.stringify(config, null, 2)}\n`);

    const result = await runInit({ target: '.', tool: 'codex', dryRun: false, force: false, cwd: repo });

    assert.equal(result.ok, true);
    const agent = readFileSync(join(repo, '.codex', 'agents', 'qube-review-focus.toml'), 'utf8');
    assert.match(agent, /model = "gpt-5\.5-codex"/);
    assert.match(agent, /model_reasoning_effort = "high"/);
  });

  it('renders routed review workflow instructions instead of native subagent steps', async () => {
    const repo = makeGitRepo();
    const config = cleanConfig();
    config.policy.reviews.adapter = 'local';
    config.policy.reviews.profile = 'local-focused';
    config.policy.reviews.agents = [];
    config.policy.reviews.localAgents = ['codex'];
    config.policy.reviews.models = { review: { 'grok-build': { model: 'grok-4.5', effort: null } }, economy: {}, synthesis: {} };
    config.policy.reviews.route = { host: 'grok-build', tier: 'review', timeoutSeconds: 900, maxTurns: 8 };
    writeFileSync(join(repo, '.qube/aie/config.json'), `${JSON.stringify(config, null, 2)}\n`);

    const result = await runInit({ target: '.', tool: 'codex', dryRun: false, force: false, cwd: repo });

    assert.equal(result.ok, true);
    const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
    const reviewAgent = readFileSync(join(repo, '.codex', 'agents', 'qube-review-focus.toml'), 'utf8');
    assert.match(agents, /Configured routed local review executes through/);
    assert.match(agents, /complete lane batch in fresh read-only model sessions/);
    assert.match(agents, /Do not spawn native review subagents for routed lanes/);
    assert.match(agents, /pr triage <pr>` for the disposition report/);
    assert.match(agents, /read the aggregated batch with .*pr batch <pr>/);
    assert.match(agents, /apply all blocking fixes in one commit, then run one re-review round/);
    assert.match(agents, /never open a new issue for a residual advisory/);
    assert.match(agents, /QUBE owns exact prompt execution, evidence, and provider publication from the main process/);
    assert.match(agents, /Three review modes remain available: remote provider reviews, native host-local subagents with pinned review-tier models, and routed isolated model hosts/);
    assert.doesNotMatch(agents, /spawn one independent Codex subagent per (?:lane|active focus)/i);
    assert.doesNotMatch(agents, /spawn independent Codex subagents for local PR review focuses/i);
    assert.doesNotMatch(agents, /paste each lane `spawnPrompt`/i);
    assert.doesNotMatch(reviewAgent, /model = /);
  });

  it('pins the Codex review model in native review-focus assets while routed review is enabled', async () => {
    const repo = makeGitRepo();
    const config = cleanConfig();
    config.policy.reviews.adapter = 'local';
    config.policy.reviews.profile = 'local-focused';
    config.policy.reviews.agents = [];
    config.policy.reviews.localAgents = ['codex'];
    config.policy.reviews.models = {
      review: {
        'grok-build': { model: 'grok-4.5', effort: null },
        codex: { model: 'gpt-5.5-codex', effort: 'high' },
      },
      economy: {},
      synthesis: {},
    };
    config.policy.reviews.route = { host: 'grok-build', tier: 'review', timeoutSeconds: 900, maxTurns: 8 };
    writeFileSync(join(repo, '.qube/aie/config.json'), `${JSON.stringify(config, null, 2)}\n`);

    const result = await runInit({ target: '.', tool: 'codex', dryRun: false, force: false, cwd: repo });

    assert.equal(result.ok, true);
    const reviewAgent = readFileSync(join(repo, '.codex', 'agents', 'qube-review-focus.toml'), 'utf8');
    assert.match(reviewAgent, /model = "gpt-5\.5-codex"/);
    assert.match(reviewAgent, /model_reasoning_effort = "high"/);
  });

  it('keeps native review assets pinned after the routed route is removed', async () => {
    const repo = makeGitRepo();
    const config = cleanConfig();
    config.policy.reviews.adapter = 'local';
    config.policy.reviews.profile = 'local-focused';
    config.policy.reviews.agents = [];
    config.policy.reviews.localAgents = ['codex'];
    config.policy.reviews.models = {
      review: { codex: { model: 'gpt-5.5-codex', effort: 'high' } },
      economy: { codex: { model: 'gpt-5.5-mini', effort: 'low' } },
      synthesis: {},
    };
    config.policy.reviews.route = { host: 'grok-build', tier: 'review', timeoutSeconds: 900, maxTurns: 8 };
    writeFileSync(join(repo, '.qube/aie/config.json'), `${JSON.stringify(config, null, 2)}\n`);
    assert.equal((await runInit({ target: '.', tool: 'codex', dryRun: false, force: false, cwd: repo })).ok, true);

    delete config.policy.reviews.route;
    writeFileSync(join(repo, '.qube/aie/config.json'), `${JSON.stringify(config, null, 2)}\n`);
    const result = await runInit({ target: '.', tool: 'codex', dryRun: false, force: true, cwd: repo });
    assert.equal(result.ok, true);
    const reviewAgent = readFileSync(join(repo, '.codex', 'agents', 'qube-review-focus.toml'), 'utf8');
    const explorer = readFileSync(join(repo, '.codex', 'agents', 'qube-review-explorer.toml'), 'utf8');
    assert.match(reviewAgent, /model = "gpt-5\.5-codex"/);
    assert.match(reviewAgent, /model_reasoning_effort = "high"/);
    assert.match(explorer, /model = "gpt-5\.5-mini"/);
    assert.match(explorer, /model_reasoning_effort = "low"/);
  });

  it('renders review-focus agents with tier models and effort for Claude Code and OpenCode hosts', async () => {
    const repo = makeGitRepo();
    const config = cleanConfig();
    config.policy.reviews.adapter = 'local';
    config.policy.reviews.profile = 'local-focused';
    config.policy.reviews.agents = [];
    config.policy.reviews.localAgents = ['claude-code', 'opencode'];
    config.policy.reviews.models = {
      review: {
        'claude-code': { model: 'claude-sonnet-5', effort: 'low' },
        opencode: { model: 'anthropic/claude-sonnet-5', effort: 'high' },
      },
    };
    writeFileSync(join(repo, '.qube/aie/config.json'), `${JSON.stringify(config, null, 2)}\n`);

    const result = await runInit({ target: '.', tool: 'all', dryRun: false, force: false, cwd: repo });

    assert.equal(result.ok, true);
    const claudeAgent = readFileSync(join(repo, '.claude', 'agents', 'qube-review-focus.md'), 'utf8');
    assert.match(claudeAgent, /name: qube-review-focus/);
    assert.match(claudeAgent, /model: claude-sonnet-5/);
    assert.match(claudeAgent, /effort: low/);
    const opencodeAgent = readFileSync(join(repo, '.opencode', 'agent', 'qube-review-focus.md'), 'utf8');
    assert.match(opencodeAgent, /mode: subagent/);
    assert.match(opencodeAgent, /model: anthropic\/claude-sonnet-5/);
    assert.match(opencodeAgent, /reasoningEffort: high/);
  });

  it('enables each review-focus agent by its own host in local review agents', async () => {
    const repo = makeGitRepo();
    const config = cleanConfig();
    config.policy.reviews.adapter = 'local';
    config.policy.reviews.profile = 'local-focused';
    config.policy.reviews.agents = [];
    config.policy.reviews.localAgents = ['claude-code'];
    writeFileSync(join(repo, '.qube/aie/config.json'), `${JSON.stringify(config, null, 2)}\n`);

    const claudeOnly = await runInit({ target: '.', tool: 'all', dryRun: false, force: false, cwd: repo });
    assert.equal(claudeOnly.ok, true);
    assert.equal(existsSync(join(repo, '.claude', 'agents', 'qube-review-focus.md')), true);
    assert.equal(existsSync(join(repo, '.codex', 'agents', 'qube-review-focus.toml')), false);
    assert.equal(existsSync(join(repo, '.opencode', 'agent', 'qube-review-focus.md')), false);
    assert.equal(existsSync(join(repo, '.claude', 'agents', 'qube-review-explorer.md')), true);
    assert.equal(existsSync(join(repo, '.codex', 'agents', 'qube-review-explorer.toml')), false);
    assert.equal(existsSync(join(repo, '.opencode', 'agent', 'qube-review-explorer.md')), false);

    const opencodeRepo = makeGitRepo();
    config.policy.reviews.localAgents = ['opencode'];
    writeFileSync(join(opencodeRepo, '.qube/aie/config.json'), `${JSON.stringify(config, null, 2)}\n`);

    const opencodeOnly = await runInit({ target: '.', tool: 'opencode', dryRun: false, force: false, cwd: opencodeRepo });
    assert.equal(opencodeOnly.ok, true);
    assert.equal(existsSync(join(opencodeRepo, '.opencode', 'agent', 'qube-review-focus.md')), true);
    assert.equal(existsSync(join(opencodeRepo, '.codex', 'agents', 'qube-review-focus.toml')), false);
    assert.equal(existsSync(join(opencodeRepo, '.opencode', 'agent', 'qube-review-digest.md')), true);
    assert.equal(existsSync(join(opencodeRepo, '.codex', 'agents', 'qube-review-digest.toml')), false);
  });

  it('renders economy catalog agents for codex, claude-code, and opencode hosts', async () => {
    const repo = makeGitRepo();
    const config = cleanConfig();
    config.policy.reviews.adapter = 'local';
    config.policy.reviews.profile = 'local-focused';
    config.policy.reviews.agents = [];
    config.policy.reviews.localAgents = ['codex', 'claude-code', 'opencode'];
    writeFileSync(join(repo, '.qube/aie/config.json'), `${JSON.stringify(config, null, 2)}\n`);

    const result = await runInit({ target: '.', tool: 'all', dryRun: false, force: false, cwd: repo });
    assert.equal(result.ok, true);

    const codexExplorer = readFileSync(join(repo, '.codex', 'agents', 'qube-review-explorer.toml'), 'utf8');
    assert.match(codexExplorer, /name = "qube-review-explorer"/);
    assert.match(codexExplorer, /^# BEGIN EXECUTOR MANAGED SECTION/);
    assert.match(codexExplorer, /read-only economy delegation helper/);
    assert.match(codexExplorer, /Do not publish provider-visible feedback/);
    assert.match(codexExplorer, /untrusted task input/);

    const codexDigest = readFileSync(join(repo, '.codex', 'agents', 'qube-review-digest.toml'), 'utf8');
    assert.match(codexDigest, /name = "qube-review-digest"/);
    assert.match(codexDigest, /Condense diffs, test output, and evidence files/);

    const codexLibrarian = readFileSync(join(repo, '.codex', 'agents', 'qube-review-librarian.toml'), 'utf8');
    assert.match(codexLibrarian, /name = "qube-review-librarian"/);
    assert.match(codexLibrarian, /Locate files, symbols, and prior review evidence/);

    const claudeExplorer = readFileSync(join(repo, '.claude', 'agents', 'qube-review-explorer.md'), 'utf8');
    assert.match(claudeExplorer, /name: qube-review-explorer/);
    assert.match(claudeExplorer, /read-only economy delegation helper/);
    assert.match(claudeExplorer, /^<!-- BEGIN EXECUTOR MANAGED SECTION -->/);

    const opencodeDigest = readFileSync(join(repo, '.opencode', 'agent', 'qube-review-digest.md'), 'utf8');
    assert.match(opencodeDigest, /mode: subagent/);
    assert.match(opencodeDigest, /read-only economy delegation helper/);

    const opencodeLibrarian = readFileSync(join(repo, '.opencode', 'agent', 'qube-review-librarian.md'), 'utf8');
    assert.match(opencodeLibrarian, /mode: subagent/);
    assert.match(opencodeLibrarian, /Locate files, symbols, and prior review evidence/);
  });

  it('resolves the economy tier model and effort into the Codex review catalog agents', async () => {
    const repo = makeGitRepo();
    const config = cleanConfig();
    config.policy.reviews.adapter = 'local';
    config.policy.reviews.profile = 'local-focused';
    config.policy.reviews.agents = [];
    config.policy.reviews.localAgents = ['codex'];
    config.policy.reviews.models = { review: { codex: { model: 'gpt-5.5-codex', effort: 'high' } }, economy: { codex: { model: 'gpt-5.5-mini', effort: 'low' } } };
    writeFileSync(join(repo, '.qube/aie/config.json'), `${JSON.stringify(config, null, 2)}\n`);

    const result = await runInit({ target: '.', tool: 'codex', dryRun: false, force: false, cwd: repo });

    assert.equal(result.ok, true);
    const explorer = readFileSync(join(repo, '.codex', 'agents', 'qube-review-explorer.toml'), 'utf8');
    assert.match(explorer, /model = "gpt-5\.5-mini"/);
    assert.match(explorer, /model_reasoning_effort = "low"/);
  });

  it('substitutes the review tier binding into the economy catalog when economy is unconfigured', async () => {
    const repo = makeGitRepo();
    const config = cleanConfig();
    config.policy.reviews.adapter = 'local';
    config.policy.reviews.profile = 'local-focused';
    config.policy.reviews.agents = [];
    config.policy.reviews.localAgents = ['codex'];
    config.policy.reviews.models = { review: { codex: { model: 'gpt-5.5-codex', effort: 'high' } } };
    writeFileSync(join(repo, '.qube/aie/config.json'), `${JSON.stringify(config, null, 2)}\n`);

    const result = await runInit({ target: '.', tool: 'codex', dryRun: false, force: false, cwd: repo });

    assert.equal(result.ok, true);
    const explorer = readFileSync(join(repo, '.codex', 'agents', 'qube-review-explorer.toml'), 'utf8');
    assert.match(explorer, /model = "gpt-5\.5-codex"/);
    assert.match(explorer, /model_reasoning_effort = "high"/);
  });

  it('falls back to each catalog agent descriptor effort when the economy binding has no effort', async () => {
    const repo = makeGitRepo();
    const config = cleanConfig();
    config.policy.reviews.adapter = 'local';
    config.policy.reviews.profile = 'local-focused';
    config.policy.reviews.agents = [];
    config.policy.reviews.localAgents = ['codex'];
    config.policy.reviews.models = { review: {}, economy: { codex: { model: 'gpt-5.5-mini', effort: null } } };
    writeFileSync(join(repo, '.qube/aie/config.json'), `${JSON.stringify(config, null, 2)}\n`);

    const result = await runInit({ target: '.', tool: 'codex', dryRun: false, force: false, cwd: repo });

    assert.equal(result.ok, true);
    const explorer = readFileSync(join(repo, '.codex', 'agents', 'qube-review-explorer.toml'), 'utf8');
    assert.match(explorer, /model = "gpt-5\.5-mini"/);
    assert.match(explorer, /model_reasoning_effort = "medium"/);
    const librarian = readFileSync(join(repo, '.codex', 'agents', 'qube-review-librarian.toml'), 'utf8');
    assert.match(librarian, /model = "gpt-5\.5-mini"/);
    assert.match(librarian, /model_reasoning_effort = "low"/);
  });

  it('keeps economy catalog bindings truthful under routed review configurations', async () => {
    const repo = makeGitRepo();
    const config = cleanConfig();
    config.policy.reviews.adapter = 'local';
    config.policy.reviews.profile = 'local-focused';
    config.policy.reviews.agents = [];
    config.policy.reviews.localAgents = ['codex'];
    config.policy.reviews.models = { review: { 'grok-build': { model: 'grok-4.5', effort: null } }, economy: {}, synthesis: {} };
    config.policy.reviews.route = { host: 'grok-build', tier: 'review', timeoutSeconds: 900, maxTurns: 8 };
    writeFileSync(join(repo, '.qube/aie/config.json'), `${JSON.stringify(config, null, 2)}\n`);

    const result = await runInit({ target: '.', tool: 'codex', dryRun: false, force: false, cwd: repo });

    assert.equal(result.ok, true);
    // No codex binding resolves for the economy tier, so model lines are omitted.
    const explorer = readFileSync(join(repo, '.codex', 'agents', 'qube-review-explorer.toml'), 'utf8');
    assert.doesNotMatch(explorer, /model = /);

    // A configured economy binding renders even in a routed configuration:
    // economy helpers only spawn natively, so the global routed flag never blanks their bindings.
    config.policy.reviews.models = { review: { 'grok-build': { model: 'grok-4.5', effort: null } }, economy: { codex: { model: 'gpt-5.5-mini', effort: 'low' } }, synthesis: {} };
    writeFileSync(join(repo, '.qube/aie/config.json'), `${JSON.stringify(config, null, 2)}\n`);
    const mixed = await runInit({ target: '.', tool: 'codex', dryRun: false, force: false, cwd: repo });
    assert.equal(mixed.ok, true);
    const mixedExplorer = readFileSync(join(repo, '.codex', 'agents', 'qube-review-explorer.toml'), 'utf8');
    assert.match(mixedExplorer, /model = "gpt-5\.5-mini"/);
    assert.match(mixedExplorer, /model_reasoning_effort = "low"/);
  });

  it('mentions the economy catalog in host instructions only for hosts with rendered catalog assets', async () => {
    const repo = makeGitRepo();
    const config = cleanConfig();
    config.policy.reviews.adapter = 'local';
    config.policy.reviews.profile = 'local-focused';
    config.policy.reviews.agents = [];
    config.policy.reviews.localAgents = ['codex'];
    writeFileSync(join(repo, '.qube/aie/config.json'), `${JSON.stringify(config, null, 2)}\n`);

    const result = await runInit({ target: '.', tool: 'all', dryRun: false, force: false, cwd: repo });
    assert.equal(result.ok, true);
    const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
    const claude = readFileSync(join(repo, 'CLAUDE.md'), 'utf8');
    assert.match(agents, /Codex: .*Economy review catalog agents available to this host: qube-review-explorer, qube-review-digest, qube-review-librarian/);
    assert.doesNotMatch(agents, /OpenCode: .*Economy review catalog agents available/);
    assert.doesNotMatch(claude, /Economy review catalog agents available/);

    const routedRepo = makeGitRepo();
    config.policy.reviews.models = { review: { 'grok-build': { model: 'grok-4.5', effort: null } }, economy: {}, synthesis: {} };
    config.policy.reviews.route = { host: 'grok-build', tier: 'review', timeoutSeconds: 900, maxTurns: 8 };
    writeFileSync(join(routedRepo, '.qube/aie/config.json'), `${JSON.stringify(config, null, 2)}\n`);

    const routedResult = await runInit({ target: '.', tool: 'codex', dryRun: false, force: false, cwd: routedRepo });
    assert.equal(routedResult.ok, true);
    const routedAgents = readFileSync(join(routedRepo, 'AGENTS.md'), 'utf8');
    assert.doesNotMatch(routedAgents, /Economy review catalog agents available/);
  });

  it('projects Codex CLI review lane wording into hosts without Codex task APIs', async () => {
    const repo = makeGitRepo();
    const config = cleanConfig();
    config.policy.reviews.adapter = 'local';
    config.policy.reviews.profile = 'local-focused';
    config.policy.reviews.agents = [];
    config.policy.reviews.localAgents = ['codex'];
    writeFileSync(join(repo, '.qube/aie/config.json'), `${JSON.stringify(config, null, 2)}\n`);

    const result = await runInit({ target: '.', tool: 'claude-code', dryRun: false, force: false, cwd: repo });
    assert.equal(result.ok, true);
    const claude = readFileSync(join(repo, 'CLAUDE.md'), 'utf8');
    assert.match(claude, /spawn one independent fresh-context review subagent per lane that runs the lane through the Codex CLI/);
    assert.match(claude, /pass each lane `spawnPrompt` verbatim as the Codex prompt/);
    assert.match(claude, /complete the implementer self-check rendered in the dry-run output — confirm or fix every lane digest and risk card it lists — and address those gaps before creating the review session lock/);
    assert.doesNotMatch(claude, /agent_type: "qube-review-focus"/);
  });

  it('documents OpenCode local review-runner boundary when local opencode review is configured', async () => {
    const repo = makeGitRepo();
    const config = cleanConfig();
    config.policy.reviews.adapter = 'local';
    config.policy.reviews.profile = 'local-focused';
    config.policy.reviews.agents = [];
    config.policy.reviews.localAgents = ['opencode'];
    writeFileSync(join(repo, '.qube/aie/config.json'), `${JSON.stringify(config, null, 2)}\n`);

    const result = await runInit({ target: '.', tool: 'opencode', dryRun: false, force: false, cwd: repo });

    assert.equal(result.ok, true);
    const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
    const command = readFileSync(join(repo, '.opencode', 'commands', 'make-it-so.md'), 'utf8');
    assert.match(agents, /Configured review adapter: local/);
    assert.match(agents, /OpenCode local-host review-runner automation is explicitly unsupported/);
    assert.match(agents, /Configure Codex local-host review lanes or trusted local-command review lane commands/);
    assert.match(agents, /OpenCode: instructions target `AGENTS\.md`/);
    assert.match(agents, /does not currently have a tested OpenCode fresh-context review-runner API/);
    assert.match(command, /Continue repository development/);
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
    assert.match(agents, /OpenCode: instructions target `AGENTS\.md`, project commands or agents are installed when configured/);
    assert.match(agents, /Codex: instructions target `AGENTS\.md`, project commands or agents are installed when configured/);
    assert.match(claude, /Claude Code: instructions target `CLAUDE\.md`, project commands or agents are installed when configured \(\.claude\/commands\/make-it-so\.md, \.claude\/skills\/make-it-so\/SKILL\.md\)/);
    assert.doesNotMatch(claude, /\.claude\/agents\/qube-review-focus\.md/);
    assert.match(agents, /Protected workflow todo ids are `branch-check`, `ship`, `pr-review-wait`, `next`/);
    assert.match(agents, /BOOTSTRAP NEXT ISSUE - DO NOT COMPLETE UNTIL NEW TODOS EXIST/);
    assert.match(agents, /remain pending until new issue todos exist or the queue is confirmed empty or blocked/);
    assert.match(agents, /Mark exactly one todo item `in_progress`/);
    assert.match(agents, /mark items `completed` immediately after finishing them/);
    assert.match(agents, /Never reach zero pending local todos while ready issue work may remain/);
    assert.match(agents, /Local todos are working memory and continuation state; GitHub issue checkboxes and comments are the durable shared task record/);
    assert.match(agents, /run `qube aie complete <issue>`/);
    assert.match(agents, /Analysis and discovered work:/);
    assert.match(agents, /Issue-gated implementation starts only after Executor selects or starts valid GitHub issue work/);
    assert.match(agents, /manual GitHub issue creation or issue suggestion are allowed before implementation starts when the user explicitly asks/);
    assert.match(agents, /When explicitly directed to record a confirmed product gap, create or suggest GitHub issue work with clear requirements and acceptance criteria/);
    assert.match(agents, /branch-check: verify the current branch matches the active issue before shipping/);
    assert.match(agents, /implementation: read the implementation brief rendered by `qube aie start` and `qube aie view <issue> --json`/);
    assert.match(agents, /post that plan as a comment on the issue before editing source/);
    assert.match(agents, /the plan commits you to the full obligation surface before anchoring on an architecture/);
    assert.match(agents, /Then implement the complete issue scope/);
    assert.match(agents, /audit: run the configured manual UI audit/);
    assert.match(agents, /Executor local app runner/);
    assert.match(agents, /prefer repository package scripts/);
    assert.match(agents, /qube aie run start --name ui-audit -- <command>/);
    assert.match(agents, /qube aie run wait --name ui-audit --url <url> --timeout 30/);
    assert.match(agents, /agent-browser first and Playwright\/browser automation as fallback/);
    assert.match(agents, /capture screenshots/);
    assert.match(agents, /collect `qube aie run status --name ui-audit` logs\/status once/);
    assert.match(agents, /Do not claim UI audit success from CLI JSON, API health, notes, or status checks/);
    assert.match(agents, /review: run `qube aie review gate <issue> --prompt`, use `qube aie pr view <pr> --json` for concise PR state when inspecting, run `qube aie pr gate <pr>` when a PR exists to request reviewers/);
    assert.match(agents, /test: during review-round fixes, run the focused commands selected by `aie gates plan --round fix --changed <path>`/);
    assert.match(agents, /at the final head run the complete configured gate set before merge/);
    assert.match(agents, /PR: commit intentional source changes, push the issue branch, fill every criterion-to-proof entry in the PR body before opening the pull request and update entries when review fixes move code or tests, open a non-draft, ready-for-review pull request that closes the issue/);
    assert.match(agents, /merge: address review\/check feedback, loop back to implementation when a gate fails/);
    assert.match(agents, /completion: after merge, run `qube aie complete <issue>`/);
    assert.match(agents, /pull-base: return to `main` and pull `origin\/main`/);
    assert.match(agents, /next-issue: inspect the queue, resume active work before starting new work/);
    const completeIndex = agents.indexOf('After merge, run `qube aie complete <issue>`');
    const baseUpdateIndex = agents.indexOf('return to the configured base branch', completeIndex);
    assert.notEqual(completeIndex, -1);
    assert.notEqual(baseUpdateIndex, -1);
    assert.ok(completeIndex < baseUpdateIndex);
    assert.match(agents, /placeholder command classes, stubs, no-op implementations/);
    assert.match(agents, /milestone numbers, bootstrap phases, issue implementation history, baseline language/);
    assert.match(agents, /reference repository names, local reference paths, or source-provenance explanations/);
    assert.match(agents, /Use `qube aie pr view <pr> --json`, `qube aie pr gate <pr>`, and `qube aie pr body <issue>` for pull request state/);
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
    assert.match(command, /explicit full authorization under repository policy to commit, push, create non-draft PRs, run `qube aie pr gate <pr>` to request reviewers, wait for configured review gates, and check status, merge, run `qube aie complete <issue>`, pull the configured base branch, and continue/);
    assert.match(command, /Analysis, investigation, queue triage, and manual GitHub issue creation or issue suggestion are allowed before implementation starts when the user explicitly asks/);
    assert.match(command, /Use `qube aie pr view <pr> --json`, `qube aie pr gate <pr>`, and `qube aie pr body <issue>` for pull request state instead of raw `gh pr view` review\/comment payloads whenever possible/);
    assert.match(command, /Use the Executor local app runner/);
    assert.match(command, /`qube aie run start --name ui-audit -- <command>`, `qube aie run wait --name ui-audit --url <url> --timeout 30`, `qube aie run status --name ui-audit`, and `qube aie run stop --name ui-audit`/);
    assert.match(command, /prefer repository package scripts/);
    assert.match(command, /Use agent-browser first for visual UI inspection/);
    assert.match(command, /capture screenshots/);
    assert.match(command, /never claim UI audit success from CLI JSON, API health, notes, or status checks/);
    assert.match(command, /collect `qube aie run status --name ui-audit` logs\/status once/);
    assert.match(command, /no linked worktree is in use/);
    assert.match(command, /tests\/audits\/configured gates/);
    assert.match(command, /non-draft, ready-for-review pull request with issue closure -> `qube aie pr gate <pr>` to request reviewers, wait for configured review gates, and check status/);
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
    assert.doesNotMatch(agents, /performed_via_github_app/);
    assert.doesNotMatch(agents, /refs\/notes\/ai/);
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
    const config = JSON.parse(readFileSync(join(repo, '.qube/aie/config.json'), 'utf8'));
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

  it('scopes legacy instruction detection to selected init tools', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'CLAUDE.md'), '# Project instructions\n\nUse gh-workflow.sh for issue work.\n');

    const opencode = await runInit({ target: '.', tool: 'opencode', dryRun: false, force: false, cwd: repo });

    assert.equal(opencode.ok, true);
    assert.deepEqual(opencode.legacy, []);
    assert.match(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), /BEGIN EXECUTOR MANAGED SECTION/);
    assert.doesNotMatch(readFileSync(join(repo, 'CLAUDE.md'), 'utf8'), /BEGIN EXECUTOR MANAGED SECTION/);

    const claudeRepo = makeGitRepo();
    writeFileSync(join(claudeRepo, 'CLAUDE.md'), '# Project instructions\n\nUse gh-workflow.sh for issue work.\n');

    const blocked = await runInit({ target: '.', tool: 'claude-code', dryRun: false, force: false, cwd: claudeRepo });

    assert.equal(blocked.ok, false);
    assert.equal(blocked.legacy[0].category, 'instructions');
    assert.deepEqual(blocked.legacy[0].paths, ['CLAUDE.md']);
    assert.doesNotMatch(readFileSync(join(claudeRepo, 'CLAUDE.md'), 'utf8'), /BEGIN EXECUTOR MANAGED SECTION/);
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
    writeFileSync(join(repo, '.qube/aie/config.json'), '{broken');

    const result = await runInit({ target: '.', tool: 'opencode', dryRun: false, force: true, cwd: repo });

    assert.equal(result.ok, true);
    assert.equal(result.actions.find(action => action.path === join('.qube', 'aie', 'config.json')).operation, 'update-config');
  });

  it('preserves requested policy summaries in blocked init plans', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, '.qube/aie/config.json'), '{broken');
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
    assert.deepEqual(all.selectedTools, ['opencode', 'codex', 'claude-code', 'grok-build']);
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
    const profiles = await getAllAgentHostProfiles();
    const opencode = profiles.find(profile => profile.id === 'opencode');
    const codex = profiles.find(profile => profile.id === 'codex');
    const claude = profiles.find(profile => profile.id === 'claude-code');

    assert.equal(profiles.length, 4);
    assert.ok(opencode);
    assert.ok(codex);
    assert.ok(claude);
    const grok = profiles.find(profile => profile.id === 'grok-build');
    assert.ok(grok);
    assert.equal(grok.supportsProjectCommands, true);
    assert.ok(grok.commandTargets.some(target => target.path === pathPosix.join('.grok', 'commands', 'make-it-so.md')));
    assert.ok(grok.commandTargets.some(target => target.path === pathPosix.join('.grok', 'skills', 'make-it-so', 'SKILL.md')));
    assert.equal(opencode.supportsProjectCommands, true);
    assert.deepEqual(opencode.commandTargets.map(target => target.path), [pathPosix.join('.opencode', 'commands', 'make-it-so.md'), pathPosix.join('.opencode', 'commands', 'makeitso.md'), pathPosix.join('.opencode', 'agent', 'qube-review-focus.md'), pathPosix.join('.opencode', 'agent', 'qube-review-explorer.md'), pathPosix.join('.opencode', 'agent', 'qube-review-digest.md'), pathPosix.join('.opencode', 'agent', 'qube-review-librarian.md')]);
    assert.equal(codex.supportsProjectCommands, true);
    assert.deepEqual(codex.commandTargets.map(target => target.path), [pathPosix.join('.codex', 'prompts', 'make-it-so.md'), pathPosix.join('.codex', 'agents', 'qube-review-focus.toml'), pathPosix.join('.codex', 'agents', 'qube-review-explorer.toml'), pathPosix.join('.codex', 'agents', 'qube-review-digest.toml'), pathPosix.join('.codex', 'agents', 'qube-review-librarian.toml')]);
    assert.ok(claude.commandTargets.some(target => target.path === pathPosix.join('.claude', 'commands', 'make-it-so.md')));
    assert.ok(claude.commandTargets.some(target => target.path === pathPosix.join('.claude', 'skills', 'make-it-so', 'SKILL.md')));
    assert.equal(claude.supportsProjectCommands, true);
    assert.equal(codex.todo.tools.includes('update_plan'), true);
    assert.equal(claude.instructionTargets[0].path, 'CLAUDE.md');
    const agentsHosts = await hostIdsForInstructionPath('AGENTS.md');
    assert.deepEqual(agentsHosts, ['opencode', 'codex', 'grok-build']);

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

  it('skips missing optional host adapters during generic instruction discovery', () => {
    const isolated = mkdtempSync(join(tmpdir(), 'aie-host-adapters-'));
    const isolatedModule = join(isolated, 'agent_host_adapters.mjs');
    const distDir = join(__dirname, '..', 'dist');
    copyFileSync(join(distDir, 'agent_host_adapters.js'), isolatedModule);
    copyFileSync(join(distDir, 'missing_adapter_package.js'), join(isolated, 'missing_adapter_package.js'));

    const script = `
      const mod = await import(${JSON.stringify(pathToFileURL(isolatedModule).href)});
      const profiles = await mod.getAllAgentHostProfiles();
      const paths = await mod.getInstructionTargetPaths();
      const agentsHosts = await mod.hostIdsForInstructionPath('AGENTS.md');
      const claudeHosts = await mod.hostIdsForInstructionPath('CLAUDE.md');
      let explicitClaudeMessage = '';
      try {
        await mod.getAgentHostProfile('claude-code');
      } catch (error) {
        explicitClaudeMessage = error instanceof Error ? error.message : String(error);
      }
      console.log(JSON.stringify({
        profiles: profiles.map(profile => profile.id),
        paths,
        agentsHosts,
        claudeHosts,
        explicitClaudeMessage,
      }));
    `;

    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { cwd: isolated, encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.profiles, ['opencode']);
    assert.deepEqual(parsed.paths, ['AGENTS.md']);
    assert.deepEqual(parsed.agentsHosts, ['opencode']);
    assert.equal(parsed.claudeHosts, null);
    assert.match(parsed.explicitClaudeMessage, /Claude Code host profile adapter @tjalve\/qube-adapter-claude-code is not installed/);
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
    assert.ok(metadata.flags.includes('--from'));
    assert.ok(metadata.flags.includes('--review-mode'));
    assert.ok(metadata.flags.includes('--ui-audit-evidence-root'));
    assert.ok(metadata.flags.includes('--publisher'));
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
    const usage = 'aie init <target> [--tool opencode|codex|claude-code|grok-build|all] [--from <path-or-repo>] [--review-mode external|host|isolated] [--publisher user|github-app|token] [--work-provider github|gitlab|linear|jira] [--review-provider github|gitlab] [--ci-provider github|gitlab|jenkins] [--primary-host codex|claude-code|opencode|grok-build] [--primary-model <id>] [--defaults] [--yes] [--dry-run] [--force] [--json]';
    assert.equal(JSON.parse(json.stdout).usage, usage);
    assert.equal(jsonWithTool.status, 0);
    assert.equal(JSON.parse(jsonWithTool.stdout).usage, usage);
    assert.equal(jsonWithListFlag.status, 0);
    assert.equal(JSON.parse(jsonWithListFlag.stdout).usage, usage);
    assert.equal(existsSync(join(repo, '.qube/aie/config.json')), false);
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
    assert.equal(parsed.actions.length, 4);
    assert.equal(existsSync(join(repo, '.qube/aie/config.json')), false);
  });

  it('runs defaults and yes mode without prompts and writes default policy', () => {
    const repo = makeGitRepo();
    const result = binRun(['init', '.', '--defaults', '--yes', '--json'], repo);
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.policy.namingRules, false);
    assert.equal(parsed.policy.supplyChainSafety, true);
    const config = JSON.parse(readFileSync(join(repo, '.qube/aie/config.json'), 'utf8'));
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
    assert.deepEqual(parsed.selectedTools, ['opencode', 'codex', 'claude-code', 'grok-build']);
    assert.equal(parsed.policy.namingRules, true);
    assert.equal(parsed.policy.milestoneOrdering, true);
    assert.equal(parsed.policy.missingMilestonePolicy, 'ignore');
    assert.equal(parsed.policy.opencodeCommandAlias, true);
    assert.equal(parsed.actions.some((action) => action.path === '.opencode/commands/makeitso.md'), true);
    assert.equal(parsed.actions.some((action) => action.path === 'CLAUDE.md'), true);
    assert.equal(existsSync(join(repo, '.qube/aie/config.json')), false);
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
    assert.equal(existsSync(join(repo, '.qube/aie/config.json')), false);
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
    assert.deepEqual(tool.options, ['opencode', 'codex', 'claude-code', 'grok-build', 'all']);
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

describe('managed section checksum normalization', () => {
  const { createHash } = require('node:crypto');
  const { planManagedUpdate, renderManagedSection, getManagedSectionHealth, MANAGED_START, MANAGED_END } = require('../dist/managed_file.js');

  it('does not report conflicts for CRLF-only differences', () => {
    const body = 'Line one.\nLine two.\nLine three.\n';
    const rendered = renderManagedSection(body);
    const crlfContent = rendered.replace(/\n/g, '\r\n');
    assert.equal(getManagedSectionHealth(crlfContent).checksumValid, true);
    const update = planManagedUpdate({ existingContent: crlfContent, generatedBody: body, allowAppend: true, force: false });
    assert.equal(update.operation === 'blocked', false);
    assert.equal(update.conflict, false);
    assert.equal(update.diff, null);
  });

  it('does not report conflicts when per-line trailing whitespace drifts', () => {
    const body = 'Line one.\nLine two.\nLine three.\n';
    const rendered = renderManagedSection(body);
    const driftedContent = rendered.replace('Line two.', 'Line two.   ');
    assert.equal(getManagedSectionHealth(driftedContent).checksumValid, true);
    const update = planManagedUpdate({ existingContent: driftedContent, generatedBody: body, allowAppend: true, force: false });
    assert.equal(update.operation === 'blocked', false);
    assert.equal(update.conflict, false);
  });

  it('accepts legacy checksums so existing managed files migrate without spurious conflicts', () => {
    // A pre-normalization managed section stored its checksum over the CRLF-collapsed body including per-line trailing whitespace.
    const legacyBody = 'Line one.  \nLine two.\n';
    const legacyChecksum = createHash('sha256').update(legacyBody).digest('hex');
    const legacyContent = [
      MANAGED_START,
      '<!-- executor-managed-version: 1 -->',
      `<!-- executor-managed-checksum: ${legacyChecksum} -->`,
      legacyBody.trimEnd(),
      MANAGED_END,
      '',
    ].join('\n');
    assert.equal(getManagedSectionHealth(legacyContent).checksumValid, true);
    const update = planManagedUpdate({ existingContent: legacyContent, generatedBody: 'Line one.  \nLine two.\n', allowAppend: true, force: false });
    assert.equal(update.operation === 'blocked', false);
    assert.equal(update.conflict, false);
  });

  it('shows a bounded diff for real conflicts and still requires explicit force', () => {
    const rendered = renderManagedSection('Keep this line.\nOriginal instruction.\n');
    const editedContent = rendered.replace('Original instruction.', 'Hand-edited instruction.');
    const blocked = planManagedUpdate({ existingContent: editedContent, generatedBody: 'Keep this line.\nOriginal instruction.\n', allowAppend: true, force: false });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.operation, 'blocked');
    assert.equal(blocked.conflict, true);
    assert.match(blocked.reason, /Review the diff/);
    assert.match(blocked.reason, /--force/);
    assert.match(blocked.diff, /^- Hand-edited instruction\.$/m);
    assert.match(blocked.diff, /^\+ Original instruction\.$/m);
    assert.doesNotMatch(blocked.diff, /Keep this line\./);
    const forced = planManagedUpdate({ existingContent: editedContent, generatedBody: 'Keep this line.\nOriginal instruction.\n', allowAppend: true, force: true });
    assert.equal(forced.ok, true);
    assert.equal(forced.operation, 'replace-managed');
    assert.match(forced.content, /Original instruction\./);
    // A checksum matching neither the strict nor the legacy form still blocks.
    const forgedContent = rendered.replace(/executor-managed-checksum: [a-f0-9]+/, 'executor-managed-checksum: deadbeef');
    const forged = planManagedUpdate({ existingContent: forgedContent, generatedBody: 'Keep this line.\nOriginal instruction.\n', allowAppend: true, force: false });
    assert.equal(forged.operation, 'blocked');
    // Non-conflict and unmanaged-file blocks carry no managed diff.
    const unmanaged = planManagedUpdate({ existingContent: 'plain file\n', generatedBody: 'Body.\n', allowAppend: false, force: false });
    assert.equal(unmanaged.operation, 'blocked');
    assert.equal(unmanaged.diff, null);
  });

  it('caps oversized conflict diffs with an omission note', () => {
    const originalBody = `${Array.from({ length: 80 }, (unused, index) => `Original line ${index}.`).join('\n')}\n`;
    const editedBody = `${Array.from({ length: 80 }, (unused, index) => `Edited line ${index}.`).join('\n')}\n`;
    const rendered = renderManagedSection(originalBody);
    const editedContent = rendered.replace(originalBody.trimEnd(), editedBody.trimEnd());
    const blocked = planManagedUpdate({ existingContent: editedContent, generatedBody: originalBody, allowAppend: true, force: false });
    assert.equal(blocked.operation, 'blocked');
    assert.match(blocked.diff, /more differing line\(s\) omitted\./);
    assert.ok(blocked.diff.split('\n').length <= 61);
  });

  it('appends the managed diff to blocked init action reasons', async () => {
    const repo = makeGitRepo();
    const result = await runInit({ target: '.', tool: 'codex', dryRun: false, force: false, cwd: repo });
    assert.equal(result.ok, true);
    const agentsPath = join(repo, 'AGENTS.md');
    const tampered = readFileSync(agentsPath, 'utf8').replace('Executor Issue Workflow', 'Tampered Workflow Title');
    writeFileSync(agentsPath, tampered);
    const blocked = await runInit({ target: '.', tool: 'codex', dryRun: true, force: false, cwd: repo });
    assert.equal(blocked.ok, false);
    const agentsAction = blocked.actions.find(action => action.path === 'AGENTS.md');
    assert.equal(agentsAction.operation, 'blocked');
    assert.match(agentsAction.reason, /Managed section diff \(current vs rendered\):/);
    assert.match(agentsAction.reason, /^- .*Tampered Workflow Title/m);
    assert.match(agentsAction.reason, /^\+ .*Executor Issue Workflow/m);
  });

  it('renders the seven review-cadence lines in the managed instruction text', async () => {
    const hosts = await getAgentHostProfiles(['opencode', 'codex', 'claude-code', 'grok-build']);
    const instructions = renderAgentInstructions(getDefaults(), hosts);
    assertPrCadence(instructions);
    assert.equal(extractPrCadenceLines(instructions).length, 7);
  });

  it('writes the seven review-cadence lines into every enabled host target on a fresh init', async () => {
    const repo = makeGitRepo();
    const result = await runInit({ target: '.', tool: 'all', dryRun: false, force: false, cwd: repo });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.deepEqual(result.selectedTools, ['opencode', 'codex', 'claude-code', 'grok-build']);
    assertPrCadence(readFileSync(join(repo, 'AGENTS.md'), 'utf8'));
    assertPrCadence(readFileSync(join(repo, 'CLAUDE.md'), 'utf8'));
    assert.doesNotMatch(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), /PR review and merge culture/);
    assert.doesNotMatch(readFileSync(join(repo, 'CLAUDE.md'), 'utf8'), /PR review and merge culture/);

    const grokRepo = makeGitRepo();
    const grok = await runInit({ target: '.', tool: 'grok-build', dryRun: false, force: false, cwd: grokRepo });
    assert.equal(grok.ok, true, grok.errors.join('\n'));
    assertPrCadence(readFileSync(join(grokRepo, 'AGENTS.md'), 'utf8'));
    assert.equal(existsSync(join(grokRepo, 'CLAUDE.md')), false);
  });

  it('replaces the old four-line cadence list when refreshing a valid managed section', async () => {
    const repo = makeGitRepo();
    const oldCadence = [
      '## Executor Issue Workflow',
      '',
      'PR review and merge cadence:',
      '',
      '- Fix merge-blocking feedback in the same issue and pull request; never defer a blocker to a new issue.',
      '- Treat non-blocking polish (advisory findings, nits, style preferences) as: fix it in the same pull request when cheap, otherwise drop it, or fold it into an already-queued Ready issue if it genuinely matches that scope. Never open a new GitHub issue to track review or audit leftovers.',
      '- Reviews, audits, and `qube aie pr triage <pr>` report advisory findings for this in-PR fix-or-drop disposition; they do not suggest or automate `gh issue create`, and neither should you.',
      '- Target a few strong review rounds on the active issue, then complete it. Prefer shipping the Ready queue over repeated review rounds on one pull request; if a lane keeps surfacing new findings past a couple of rounds, stop and report the blocker instead of looping.',
      '',
    ].join('\n');
    writeFileSync(join(repo, 'AGENTS.md'), renderManagedSection(oldCadence));

    const result = await runInit({ target: '.', tool: 'opencode', dryRun: false, force: false, cwd: repo });
    assert.equal(result.ok, true, result.errors.join('\n'));
    const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
    assertPrCadence(agents);
    const agentsAction = result.actions.find(action => action.path === 'AGENTS.md');
    assert.ok(agentsAction);
    assert.equal(agentsAction.operation, 'replace-managed');
  });
});
