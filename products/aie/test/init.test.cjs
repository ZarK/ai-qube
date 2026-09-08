const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { cloneGitRepo } = require('./support/git_fixture.cjs');
const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, posix: pathPosix } = require('node:path');

const { buildInitPlan, runInit } = require('../dist/init/index.js');
const { configToFileShape, getDefaults, userConfigPath } = require('../dist/config/index.js');
const { renderAgentInstructions, renderMakeItSoCommand, renderMakeItSoSkill } = require('../dist/init_content.js');
const { getAgentHostProfiles } = require('../dist/agent_hosts.js');
const { renderManagedSection } = require('../dist/managed_file.js');

function assertCompactWorkflow(text, { autonomous = true } = {}) {
  for (const heading of ['Core policy:', 'Workflow:', 'Task tools:', 'Procedure entry points:', 'Model delegation:', 'Stop conditions:', 'Safety requirements:']) {
    assert.match(text, new RegExp(`^${heading}$`, 'm'));
  }
  assert.match(text, /Follow the latest user instruction\. A user stop or scope change overrides continuation and repository automation/);
  assert.match(text, /Keep at most one issue in progress/);
  if (autonomous) {
    assert.match(text, /Only correctness bugs, security or trust risks, failed required checks, and unmet acceptance criteria block shipping/);
    assert.match(text, /Fix cheap advisories or drop them\. Do not open issues for review leftovers/);
    assert.match(text, /Cap normal review at two rounds; another round requires a blocker fix that materially changes the code/);
    assert.match(text, /Keep the checkout unchanged while review runs/);
    assert.match(text, /Commit only the issue's intended changes/);
    assert.match(text, /qube aie complete <issue>/);
  } else {
    assert.match(text, /Autonomous review and shipping are disabled/);
  }
  assert.doesNotMatch(text, /PR review and merge cadence:|Analysis and discovered work:|Stage checklist:|Host capability profile:/);
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

function parseSkillFrontmatter(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
  assert.ok(match, 'skill must start with YAML frontmatter');
  const metadata = Object.fromEntries(match[1]
    .split(/\r?\n/)
    .filter(line => line.trim() !== '' && !line.startsWith('#'))
    .map(line => {
      const separator = line.indexOf(':');
      assert.ok(separator > 0, `invalid frontmatter line: ${line}`);
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    }));
  return { metadata, body: content.slice(match[0].length) };
}

describe('init service', () => {
  it('keeps repository config absent when a complete user-global setup supplies the effective values', async () => {
    const repo = makeGitRepo();
    const home = join(tmpdir(), `aie-init-home-${process.pid}-${Date.now()}`);
    mkdirSync(join(home, '.qube', 'aie'), { recursive: true });
    writeFileSync(userConfigPath(home), `${JSON.stringify(cleanConfig(), null, 2)}\n`);

    const result = await runInit({ target: '.', tool: 'codex', dryRun: false, force: false, cwd: repo, homeDirectory: home });

    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.actions.find(action => action.id === 'config').operation, 'unchanged');
    assert.equal(existsSync(join(repo, '.qube', 'aie', 'config.json')), false);
  });

  it('stores one repository leaf when it differs from complete user-global setup', async () => {
    const repo = makeGitRepo();
    const home = join(tmpdir(), `aie-init-override-home-${process.pid}-${Date.now()}`);
    mkdirSync(join(home, '.qube', 'aie'), { recursive: true });
    const global = cleanConfig();
    global.policy.audit.manualUiAudit = false;
    writeFileSync(userConfigPath(home), `${JSON.stringify(global, null, 2)}\n`);

    const result = await runInit({
      target: '.', tool: 'codex', dryRun: false, force: false, cwd: repo, homeDirectory: home,
      policy: { manualUiAudit: true },
    });

    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.deepEqual(JSON.parse(readFileSync(join(repo, '.qube', 'aie', 'config.json'), 'utf8')), {
      version: 1,
      policy: { audit: { manualUiAudit: true } },
    });
  });

  it('removes a full repository config when every leaf equals explicit user-global setup', async () => {
    const repo = makeGitRepo();
    const home = join(tmpdir(), `aie-init-compact-home-${process.pid}-${Date.now()}`);
    mkdirSync(join(home, '.qube', 'aie'), { recursive: true });
    const global = cleanConfig();
    writeFileSync(userConfigPath(home), `${JSON.stringify(global, null, 2)}\n`);
    writeFileSync(join(repo, '.qube', 'aie', 'config.json'), `${JSON.stringify(global, null, 2)}\n`);

    const result = await runInit({ target: '.', tool: 'codex', dryRun: false, force: false, cwd: repo, homeDirectory: home });

    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.actions.find(action => action.id === 'config').operation, 'remove');
    assert.equal(existsSync(join(repo, '.qube', 'aie', 'config.json')), false);
    assert.equal(existsSync(join(repo, '.qube', 'aie')), true);
  });

  it('plans against an explicit prospective repository root without writing Git or managed files', async () => {
    const target = join(tmpdir(), `aie-prospective-${process.pid}-${Date.now()}`);
    mkdirSync(target, { recursive: true });

    const ordinary = await buildInitPlan({
      target: '.', tool: 'codex', dryRun: true, force: false, cwd: target,
    });
    assert.equal(ordinary.ok, false);
    assert.match(ordinary.errors.join("\n"), /not a Git repository/iu);
    assert.equal(ordinary.prerequisites.checks.find(check => check.id === 'repository').reasonCode, 'not-a-repository');

    const prospective = await buildInitPlan({
      target: '.', tool: 'codex', dryRun: true, force: false, prospectiveRoot: true, cwd: target,
    });
    assert.equal(prospective.ok, true);
    assert.equal(prospective.repoRoot, target);
    assert.equal(prospective.dryRun, true);
    assert.equal(prospective.actions.every(action => action.status === 'planned'), true);
    assert.equal(existsSync(join(target, '.git')), false);
    assert.equal(existsSync(join(target, '.qube')), false);
    assert.equal(existsSync(join(target, 'AGENTS.md')), false);
  });

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

  it('writes the Claude Code command without duplicate skill or review assets', async () => {
    const repo = makeGitRepo();
    const result = await runInit({ target: '.', tool: 'claude-code', dryRun: false, force: false, cwd: repo });
    assert.equal(result.ok, true);
    const command = readFileSync(join(repo, '.claude', 'commands', 'make-it-so.md'), 'utf8');
    const claude = readFileSync(join(repo, 'CLAUDE.md'), 'utf8');
    assert.match(command, /Continue repository development/);
    assert.match(claude, /\.claude\/commands\/make-it-so\.md/);
    assert.equal(existsSync(join(repo, '.claude', 'skills', 'make-it-so', 'SKILL.md')), false);
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
    ]);

    const result = await runInit({ target: '.', tool: 'grok-build', dryRun: false, force: false, cwd: repo });
    assert.equal(result.ok, true);
    const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
    assert.match(agents, /Grok Build:/);
    assert.match(agents, /Do not invent a Grok task tool/);
    assert.match(agents, /\.grok\/commands\/make-it-so\.md/);
    assert.doesNotMatch(agents, /\.codex\//);
    assert.equal(existsSync(join(repo, '.grok', 'commands', 'make-it-so.md')), true);
    assert.equal(existsSync(join(repo, '.grok', 'skills', 'make-it-so', 'SKILL.md')), false);
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
    assert.match(agents, /\.agents\/skills\/make-it-so\/SKILL\.md/);
    assert.equal(existsSync(join(repo, '.agents', 'skills', 'make-it-so', 'SKILL.md')), true);
  });

  it('writes the Codex Make It So skill for a Codex-only init', async () => {
    const repo = makeGitRepo();
    const result = await runInit({ target: '.', tool: 'codex', dryRun: false, force: false, cwd: repo });
    assert.equal(result.ok, true);
    const skill = readFileSync(join(repo, '.agents', 'skills', 'make-it-so', 'SKILL.md'), 'utf8');
    const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
    const parsedSkill = parseSkillFrontmatter(skill);
    assert.equal(parsedSkill.metadata.name, 'make-it-so');
    assert.match(parsedSkill.body, /Continue repository development/);
    assert.match(skill, /^---\n# BEGIN EXECUTOR MANAGED SECTION\n/);
    assert.match(agents, /\.agents\/skills\/make-it-so\/SKILL\.md/);
    assert.match(agents, /use `\$make-it-so`/);
    assert.doesNotMatch(agents, /\.codex\/agents\/qube-review-focus\.toml/);
    assert.equal(existsSync(join(repo, '.codex', 'agents', 'qube-review-focus.toml')), false);

    const second = await runInit({ target: '.', tool: 'codex', dryRun: false, force: false, cwd: repo });
    assert.equal(second.ok, true);
    assert.equal(second.actions.find(action => action.path === pathPosix.join('.agents', 'skills', 'make-it-so', 'SKILL.md')).status, 'skipped');
    assert.equal(readFileSync(join(repo, '.agents', 'skills', 'make-it-so', 'SKILL.md'), 'utf8'), skill);
  });

  it('repairs an unchanged HTML-managed Codex skill', async () => {
    const repo = makeGitRepo();
    const config = getDefaults();
    writeFileSync(join(repo, '.qube', 'aie', 'config.json'), `${JSON.stringify(configToFileShape(config), null, 2)}\n`);
    const skillPath = join(repo, '.agents', 'skills', 'make-it-so', 'SKILL.md');
    mkdirSync(join(repo, '.agents', 'skills', 'make-it-so'), { recursive: true });
    writeFileSync(skillPath, renderManagedSection(renderMakeItSoSkill(config), 'html'));

    const result = await runInit({ target: '.', tool: 'codex', dryRun: false, force: false, cwd: repo });

    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.actions.find(action => action.path === pathPosix.join('.agents', 'skills', 'make-it-so', 'SKILL.md')).operation, 'replace-managed');
    assert.match(readFileSync(skillPath, 'utf8'), /^---\n# BEGIN EXECUTOR MANAGED SECTION\n/);
  });

  for (const edit of [
    { name: 'metadata', apply: skill => skill.replace('name: make-it-so', 'name: custom-skill') },
    { name: 'body', apply: skill => skill.replace('Continue repository development', 'Continue custom development') },
  ]) {
    it(`blocks a user edit to managed skill ${edit.name}`, async () => {
      const repo = makeGitRepo();
      const first = await runInit({ target: '.', tool: 'codex', dryRun: false, force: false, cwd: repo });
      assert.equal(first.ok, true);
      const skillPath = join(repo, '.agents', 'skills', 'make-it-so', 'SKILL.md');
      const editedSkill = edit.apply(readFileSync(skillPath, 'utf8'));
      writeFileSync(skillPath, editedSkill);

      const blocked = await runInit({ target: '.', tool: 'codex', dryRun: false, force: false, cwd: repo });

      assert.equal(blocked.ok, false);
      assert.match(blocked.errors.join('\n'), /Managed section was edited outside Executor/);
      assert.equal(readFileSync(skillPath, 'utf8'), editedSkill);
    });
  }

  for (const tool of ['codex', 'cursor']) {
    it(`binds fresh default model routing to the selected ${tool} harness`, async () => {
      const repo = makeGitRepo();
      const result = await runInit({ target: '.', tool, dryRun: false, force: false, cwd: repo });

      assert.equal(result.ok, true);
      const config = JSON.parse(readFileSync(join(repo, '.qube', 'aie', 'config.json'), 'utf8'));
      assert.equal(config.policy.modelRouting.primary, 'primary');
      assert.deepEqual(config.policy.modelRouting.catalog, [{
        id: 'primary',
        host: tool,
        transport: 'host',
        costRank: 3,
        notes: 'Primary host model. Fallback target for every delegated route class.',
      }]);
      assert.equal(result.modelRouting.primary.host, tool);
    });
  }

  it('preserves valid custom model routing on rerun', async () => {
    const repo = makeGitRepo();
    const first = await runInit({ target: '.', tool: 'codex', dryRun: false, force: false, cwd: repo });
    assert.equal(first.ok, true);

    const configPath = join(repo, '.qube', 'aie', 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const customRouting = {
      primary: 'custom-primary',
      catalog: [
        { id: 'custom-primary', host: 'grok-build', transport: 'cli', costRank: 3, notes: 'Custom primary route.' },
        { id: 'custom-economy', host: 'opencode', transport: 'cli', costRank: 1, notes: 'Custom economy route.' },
      ],
      routes: {
        'mechanical-implementation': { preferred: 'custom-economy', fallback: ['custom-economy', 'custom-primary'] },
        'exploration-investigation': { preferred: 'custom-primary', fallback: ['custom-primary'] },
        'independent-review': { reviewTier: 'review' },
        'synthesis-judgment': { preferred: 'custom-primary', fallback: ['custom-primary'] },
      },
    };
    config.policy.modelRouting = customRouting;
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const rerun = await runInit({ target: '.', tool: 'codex', dryRun: false, force: false, cwd: repo });

    assert.equal(rerun.ok, true);
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).policy.modelRouting, customRouting);
    assert.equal(rerun.actions.find(action => action.id === 'config').status, 'skipped');
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
        reviewMode: 'external',
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
    assert.match(agents, /Before new issue work, verify repository policy: primary checkout/);
    assert.match(agents, /ZarK\/ai-supply-chain-guard/);
    assert.match(agents, /https:\/\/github\.com\/ZarK\/ai-supply-chain-guard/);
    assert.match(agents, /\.agents\/skills\/supply-chain-guard\/SKILL\.md/);
    assert.match(agents, /qube autoresearch --help/);
    assert.match(agents, /synthesize the arena before edits/);
    const command = readFileSync(join(repo, '.opencode', 'commands', 'make-it-so.md'), 'utf8');
    assert.match(command, /Continue repository development/);
    assert.match(command, /inspect required reviews and checks/);
    assert.match(command, /configured gates cannot run/);
    assert.match(agents, /Review mode is external/);
    assert.doesNotMatch(agents, /pr-review-wait/);
    const config = JSON.parse(readFileSync(join(repo, '.qube/aie/config.json'), 'utf8'));
    assert.equal(config.version, 1);
    assert.equal(config.providers.work.kind, 'github');
    assert.equal(config.providers.repository.kind, 'local-git');
    assert.equal(config.policy.branch.naming, 'issue/<number>-<slug>');
    assert.equal(config.policy.branch.requireBaseBranchFreshness, true);
    assert.equal(config.policy.lifecycle.assignOnStart, true);
    assert.equal(config.policy.lifecycle.commentOnStart, true);
    assert.deepEqual(config.policy.reviews.agents, []);
    assert.equal(config.policy.reviews.adapter, 'github');
    assert.equal(config.policy.reviews.mode, 'external');
    assert.equal(config.policy.reviews.profile, 'remote-compatible');
    assert.deepEqual(config.policy.reviews.localAgents, []);
    assert.equal(config.policy.reviews.waitMinutes, 10);
    assert.equal('opencodeCommandAlias' in config.policy.instructions, false);
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
    const command = readFileSync(join(repo, '.opencode', 'commands', 'make-it-so.md'), 'utf8');
    assert.match(command, /Review mode is external\. Use the configured GitLab workflow/);
    assert.doesNotMatch(`${agents}\n${command}`, /QUBEReview|qube-review\[bot\]|GitHub App|manual GitHub issue|gh issue create/);
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

  it('renders the selected review mode and GitHub publisher in host entry points', () => {
    const external = getDefaults();
    const externalCommand = renderMakeItSoCommand(external);
    assert.match(externalCommand, /Review mode is external/);
    assert.match(externalCommand, /GitHub review publisher mode is user/);
    assert.doesNotMatch(externalCommand, /QUBEReview|qube-review\[bot\]|Review mode is isolated|Review compute remains host-run/);

    const host = getDefaults();
    host.reviewAdapter = 'local';
    host.reviewMode = 'host';
    host.localReviewAgents = ['codex'];
    const hostCommand = renderMakeItSoCommand(host);
    assert.match(hostCommand, /Review mode is host/);
    assert.match(hostCommand, /complete local review focuses/);
    assert.doesNotMatch(hostCommand, /Review mode is isolated|qube-review\[bot\]/);

    const isolated = getDefaults();
    isolated.reviewAdapter = 'local';
    isolated.reviewMode = 'isolated';
    isolated.providers.review.publisher = { mode: 'github-app', githubApp: { appId: '1', installationId: '2', privateKeyEnv: 'KEY' } };
    const isolatedCommand = renderMakeItSoCommand(isolated);
    assert.match(isolatedCommand, /Review mode is isolated/);
    assert.match(isolatedCommand, /GitHub review publisher mode is github-app/);
    assert.doesNotMatch(isolatedCommand, /publisher mode is user|qube-review\[bot\]/);

    const token = getDefaults();
    token.providers.review.publisher = { mode: 'token', token: { env: 'TOKEN' } };
    assert.match(renderMakeItSoCommand(token), /GitHub review publisher mode is token/);

    const unavailable = getDefaults();
    unavailable.reviewAgents = [];
    assert.match(renderMakeItSoCommand(unavailable), /no supported reviewer is configured/);
  });

  it('is idempotent after writing managed sections', async () => {
    const repo = makeGitRepo();
    await runInit({ target: '.', tool: 'opencode', dryRun: false, force: false, cwd: repo });

    const second = await runInit({ target: '.', tool: 'opencode', dryRun: false, force: false, cwd: repo });

    assert.equal(second.ok, true);
    assert.equal(second.completedChanges.length, 0);
    assert.equal(second.actions.every(action => action.status === 'skipped'), true);
  });

  it('blocks unknown config fields without rewriting them under force', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, '.qube/aie/config.json'), `${JSON.stringify({ version: 1, customPolicy: { keep: true } }, null, 2)}\n`);

    const blocked = await runInit({ target: '.', tool: 'codex', dryRun: false, force: false, cwd: repo });
    assert.equal(blocked.ok, false);
    assert.match(blocked.errors.join('\n'), /customPolicy/);

    const result = await runInit({ target: '.', tool: 'codex', dryRun: false, force: true, cwd: repo });

    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /customPolicy/);
    const config = JSON.parse(readFileSync(join(repo, '.qube/aie/config.json'), 'utf8'));
    assert.deepEqual(config.customPolicy, { keep: true });
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

  it('blocks old flat safety toggles under force without rewriting the invalid layer', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, '.qube/aie/config.json'), `${JSON.stringify({
      version: 1,
      promptInjectionWarning: false,
      noCreditWarning: false,
    }, null, 2)}\n`);

    const result = await runInit({ target: '.', tool: 'codex', dryRun: false, force: true, cwd: repo });

    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /promptInjectionWarning/);
    const config = JSON.parse(readFileSync(join(repo, '.qube/aie/config.json'), 'utf8'));
    assert.equal(config.promptInjectionWarning, false);
    assert.equal(config.noCreditWarning, false);
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
    config.policy.gates.definitions = [
      { name: 'test', kind: 'custom', command: 'npm test', stage: 'pre-pr', required: true, timeoutSeconds: 600, workingDirectory: '.', env: {}, externalService: false },
    ];
    config.policy.reviews.agents = ['review-bot'];
    config.policy.reviews.requestText = 'Please\nreview\tthis  policy-sensitive change.';
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
    assert.match(agents, /Before new issue work, verify repository policy: no blocking open pull requests/);
    assert.match(agents, /Autonomous shipping mode is disabled/);
    assert.match(agents, /GitHub milestone ordering is enabled/);
    assert.doesNotMatch(agents, /primary checkout, no blocking open pull requests, and a current local base branch/);
    assert.match(agents, /Required quality gates: `test`/);
    assert.match(agents, /Review mode is external\. Shipping and review publication are disabled/);
    assert.doesNotMatch(agents, /After the pull request exists, run/);
    assert.match(agents, /Naming rules:/);
    assert.match(agents, /Follow repository pinning policy for third-party CI actions/);
    assert.doesNotMatch(command, /`upstream\/develop` is current/);
    assert.match(command, /autonomous shipping mode is disabled/);
    assert.doesNotMatch(command, /commit -> push -> pull request/);
    assert.doesNotMatch(command, /UI audit servers use|agent-browser first/);
    assertCompactWorkflow(agents, { autonomous: false });
    assert.match(command, /Stop before commit, push, pull request creation, review publication, merge, completion, or next-issue work/);
    assert.equal(existsSync(join(repo, '.opencode', 'commands', 'makeitso.md')), false);
  });

  it('installs exactly one canonical Make It So surface for each host', async () => {
    const repo = makeGitRepo();

    const planned = await buildInitPlan({ target: '.', tool: 'all', dryRun: true, force: false, cwd: repo });

    assert.equal(planned.ok, true);
    assert.deepEqual(planned.actions.map(action => action.path), [
      join('.qube', 'aie', 'config.json'),
      '.gitignore',
      'AGENTS.md',
      'CLAUDE.md',
      opencodeCommandPath('make-it-so.md'),
      pathPosix.join('.agents', 'skills', 'make-it-so', 'SKILL.md'),
      pathPosix.join('.claude', 'commands', 'make-it-so.md'),
      pathPosix.join('.grok', 'commands', 'make-it-so.md'),
      pathPosix.join('.cursor', 'commands', 'make-it-so.md'),
    ]);
    assert.deepEqual(planned.warnings, []);

    const applied = await runInit({ target: '.', tool: 'all', dryRun: false, force: false, cwd: repo });
    assert.equal(applied.ok, true);
    assert.match(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), /^<!-- BEGIN EXECUTOR MANAGED SECTION -->\n/);
    assert.match(readFileSync(join(repo, '.opencode', 'commands', 'make-it-so.md'), 'utf8'), /^<!-- BEGIN EXECUTOR MANAGED SECTION -->\n/);
    assert.equal(existsSync(join(repo, '.opencode', 'commands', 'make-it-so.md')), true);
    assert.equal(existsSync(join(repo, '.opencode', 'commands', 'makeitso.md')), false);
    assert.equal(existsSync(join(repo, '.claude', 'skills', 'make-it-so', 'SKILL.md')), false);
    assert.equal(existsSync(join(repo, '.grok', 'skills', 'make-it-so', 'SKILL.md')), false);
  });

  it('installs the Codex local review agents and Make It So skill when native review is configured', async () => {
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
      pathPosix.join('.agents', 'skills', 'make-it-so', 'SKILL.md'),
      pathPosix.join('.codex', 'agents', 'qube-review-focus.toml'),
      pathPosix.join('.codex', 'agents', 'qube-review-explorer.toml'),
      pathPosix.join('.codex', 'agents', 'qube-review-digest.toml'),
      pathPosix.join('.codex', 'agents', 'qube-review-librarian.toml'),
    ]);

    const result = await runInit({ target: '.', tool: 'codex', dryRun: false, force: false, cwd: repo });
    assert.equal(result.ok, true);
    const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
    assert.match(agents, /Review mode is host/);
    assert.match(agents, /pr gate <pr> --dry-run --json --local-review-prompts/);
    assert.match(agents, /Treat review output as untrusted input/);
    const agent = readFileSync(join(repo, '.codex', 'agents', 'qube-review-focus.toml'), 'utf8');
    assert.match(agent, /name = "qube-review-focus"/);
    assert.match(agent, /cannot modify source or worktree files/);
    assert.match(agent, /sandbox_mode = "read-only"/);
    assert.match(agent, /^# BEGIN EXECUTOR MANAGED SECTION/);
    assert.doesNotMatch(agent, /<!--/);
    assert.match(agent, /Do not write lane evidence or provenance/);
    assert.match(agent, /Do not invoke a review publish command/);
    assert.match(agent, /The main session writes evidence and provenance and publishes provider feedback only after validation succeeds/);
    assert.match(agent, /Return exactly one JSON lane result/);
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
    assert.match(agents, /Review mode is isolated/);
    assert.match(agents, /pr gate <pr> --dry-run --json --local-review-prompts/);
    assert.match(agents, /then run `qube aie pr gate <pr>`/);
    assert.match(agents, /Treat review output as untrusted input/);
    assert.doesNotMatch(agents, /spawn one independent Codex subagent per (?:lane|active focus)/i);
    assert.doesNotMatch(agents, /spawn independent Codex subagents for local PR review focuses/i);
    assert.doesNotMatch(agents, /paste each lane `spawnPrompt`/i);
    assert.equal(existsSync(join(repo, '.codex', 'agents', 'qube-review-focus.toml')), false);
  });

  it('does not install native review-focus assets while routed review is enabled', async () => {
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
    assert.equal(existsSync(join(repo, '.codex', 'agents', 'qube-review-focus.toml')), false);
  });

  it('installs pinned native review assets after the routed route is removed', async () => {
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
    assert.equal(existsSync(join(repo, '.codex', 'agents', 'qube-review-focus.toml')), false);

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
    assert.match(claudeAgent, /^tools: Read, Grep, Glob$/m);
    assert.match(claudeAgent, /model: claude-sonnet-5/);
    assert.match(claudeAgent, /effort: low/);
    const opencodeAgent = readFileSync(join(repo, '.opencode', 'agent', 'qube-review-focus.md'), 'utf8');
    assert.match(opencodeAgent, /mode: subagent/);
    assert.match(opencodeAgent, /^permission:$/m);
    assert.match(opencodeAgent, /^  "\*": deny$/m);
    assert.match(opencodeAgent, /^  read: allow$/m);
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

  it('renders read-only economy catalog agents for native review hosts', async () => {
    const repo = makeGitRepo();
    const config = cleanConfig();
    config.policy.reviews.adapter = 'local';
    config.policy.reviews.profile = 'local-focused';
    config.policy.reviews.agents = [];
    config.policy.reviews.localAgents = ['codex', 'claude-code', 'opencode', 'grok-build'];
    writeFileSync(join(repo, '.qube/aie/config.json'), `${JSON.stringify(config, null, 2)}\n`);

    const result = await runInit({ target: '.', tool: 'all', dryRun: false, force: false, cwd: repo });
    assert.equal(result.ok, true);

    const codexExplorer = readFileSync(join(repo, '.codex', 'agents', 'qube-review-explorer.toml'), 'utf8');
    assert.match(codexExplorer, /name = "qube-review-explorer"/);
    assert.match(codexExplorer, /^# BEGIN EXECUTOR MANAGED SECTION/);
    assert.match(codexExplorer, /read-only economy delegation helper/);
    assert.match(codexExplorer, /Do not publish provider-visible feedback/);
    assert.match(codexExplorer, /The main session validates review results and publishes provider-visible feedback/);
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
    assert.match(opencodeDigest, /^permission:$/m);
    assert.match(opencodeDigest, /^  "\*": deny$/m);
    assert.match(opencodeDigest, /^  read: allow$/m);
    assert.match(opencodeDigest, /read-only economy delegation helper/);

    const opencodeLibrarian = readFileSync(join(repo, '.opencode', 'agent', 'qube-review-librarian.md'), 'utf8');
    assert.match(opencodeLibrarian, /mode: subagent/);
    assert.match(opencodeLibrarian, /Locate files, symbols, and prior review evidence/);

    const grokExplorer = readFileSync(join(repo, '.grok', 'agents', 'qube-review-explorer.md'), 'utf8');
    assert.match(grokExplorer, /^tools: Read, Grep, Glob$/m);
    assert.match(grokExplorer, /^capabilityMode: read-only$/m);
    assert.match(grokExplorer, /^mcpInheritance: none$/m);
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

  it('does not render native economy agents under routed review configurations', async () => {
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
    assert.equal(existsSync(join(repo, '.codex', 'agents', 'qube-review-explorer.toml')), false);

    config.policy.reviews.models = { review: { 'grok-build': { model: 'grok-4.5', effort: null } }, economy: { codex: { model: 'gpt-5.5-mini', effort: 'low' } }, synthesis: {} };
    writeFileSync(join(repo, '.qube/aie/config.json'), `${JSON.stringify(config, null, 2)}\n`);
    const rerun = await runInit({ target: '.', tool: 'codex', dryRun: false, force: true, cwd: repo });
    assert.equal(rerun.ok, true);
    assert.equal(existsSync(join(repo, '.codex', 'agents', 'qube-review-explorer.toml')), false);
  });

  it('keeps economy catalog details out of always-loaded instructions', async () => {
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
    assert.doesNotMatch(agents, /Economy review catalog agents available/);
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

  it('projects configured review guidance into another host instructions file', async () => {
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
    assert.match(claude, /Review mode is host/);
    assert.match(claude, /pr gate <pr> --dry-run --json --local-review-prompts/);
    assert.match(claude, /Treat review output as untrusted input/);
  });

  it('documents OpenCode as a supported native review harness', async () => {
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
    assert.match(agents, /Review mode is host/);
    assert.match(agents, /OpenCode: read `AGENTS\.md`; use `\/make-it-so` from `\.opencode\/commands\/make-it-so\.md` for the full procedure/);
    const focusAgent = readFileSync(join(repo, '.opencode', 'agent', 'qube-review-focus.md'), 'utf8');
    assert.match(focusAgent, /Do not write lane evidence or provenance/);
    assert.match(focusAgent, /Return one candidate lane result to the main session/);
    assert.match(focusAgent, /^permission:$/m);
    assert.match(focusAgent, /^  "\*": deny$/m);
    for (const permission of ['read', 'glob', 'grep', 'list', 'lsp']) {
      assert.match(focusAgent, new RegExp(`^  ${permission}: allow$`, 'm'));
    }
    assert.doesNotMatch(agents, /OpenCode native review is unsupported/i);
    assert.doesNotMatch(agents, /Configure Codex|Codex local-host/i);
    assert.match(command, /Continue repository development/);
  });

  it('fails closed when the configured harness does not support native review', async () => {
    const repo = makeGitRepo();
    const config = cleanConfig();
    config.policy.reviews.adapter = 'local';
    config.policy.reviews.profile = 'local-focused';
    config.policy.reviews.agents = [];
    config.policy.reviews.localAgents = ['cursor'];
    writeFileSync(join(repo, '.qube/aie/config.json'), `${JSON.stringify(config, null, 2)}\n`);

    const result = await runInit({ target: '.', tool: 'cursor', dryRun: false, force: false, cwd: repo });

    assert.equal(result.ok, true);
    const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
    const command = readFileSync(join(repo, '.cursor', 'commands', 'make-it-so.md'), 'utf8');
    assert.match(agents, /Review mode is host, but no supported reviewer is configured/);
    assert.match(agents, /Cursor: read `AGENTS\.md`; use `\/make-it-so` from `\.cursor\/commands\/make-it-so\.md` for the full procedure/);
    assert.doesNotMatch(agents, /installed agents|Economy review catalog agents available to this host/);
    assert.doesNotMatch(agents, /spawn one fresh-context review subagent per lane through a configured harness/);
    assert.match(command, /configured native review harness does not support local review/);
    assert.doesNotMatch(command, /complete local review focuses/);
  });

  it('renders compact workflow rules and host procedure entry points', async () => {
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

    assertCompactWorkflow(agents);
    assertCompactWorkflow(claude);
    assert.match(agents, /issue-driven development/);
    assert.match(agents, /standing authorization under repository policy to run tests, commit, push, create non-draft PRs/);
    assert.match(agents, /For OpenCode, use `todowrite` and `todoread` directly/);
    assert.match(agents, /For Codex, use `update_plan` or the host plan or task-list tool directly/);
    assert.match(claude, /For Claude Code, use `TodoWrite` and `TodoRead`/);
    assert.match(agents, /OpenCode: read `AGENTS\.md`; use `\/make-it-so` from `\.opencode\/commands\/make-it-so\.md` for the full procedure/);
    assert.match(agents, /Codex: read `AGENTS\.md`; use `\$make-it-so` from `\.agents\/skills\/make-it-so\/SKILL\.md` for the full procedure/);
    assert.match(claude, /Claude Code: read `CLAUDE\.md`; use `\/make-it-so` from `\.claude\/commands\/make-it-so\.md` for the full procedure/);
    assert.doesNotMatch(claude, /\.claude\/agents\/qube-review-focus\.md/);
    assert.match(agents, /Use `qube aie pr body <issue>` for the pull request template/);
    assert.match(agents, /Use `qube aie checklist verify <issue> --index <n> --prompt` for acceptance checks/);
    assert.match(agents, /Delegate mechanical implementation and exploration to their preferred model.*Use the configured fallbacks/s);
    assert.match(agents, /placeholder command classes, stubs, no-op implementations/);
    assert.match(agents, /Use the target project's product terms/);
    assert.match(agents, /issue implementation history, local reference paths, or source-provenance explanations/);
    assert.match(agents, /Use `qube aie pr view <pr> --json`, `qube aie pr gate <pr>`, and `qube aie pr body <issue>` for pull request state/);
    assert.match(agents, /Stop implementation work cleanly and report the exact blocker/);
    assert.match(agents, /Update affected product documentation when behavior, commands, or workflows change/);
    assert.match(agents, /Do not commit generated build output unless repository policy explicitly allows it/);
    assert.match(agents, /canonical supply-chain guard/);
    assert.match(agents, /Use exact versions, inspect intentional lockfile changes, disable lifecycle scripts where supported, and apply package-age gates/);
    assert.match(agents, /Pin third-party CI actions to immutable commit SHAs/);
    assert.match(agents, /Stop for explicit user approval when package age, identity, source\/provenance, integrity, or execution risk cannot be verified/);
    assert.match(command, /Never ask questions during normal work/);
    assert.match(command, /Think holistically/);
    assert.match(command, /Repository policy authorizes you to commit, push, create non-draft PRs, run `qube pr gate <pr>` to request reviewers, wait for configured review gates, and check status, merge, run `qube complete <issue>`, pull the configured base branch, and continue/);
    assert.match(command, /Analysis, investigation, and queue triage are allowed before implementation starts when the user asks/);
    assert.match(command, /Use `qube pr view <pr> --json`, `qube pr gate <pr>`, and `qube pr body <issue>` for pull request state instead of raw provider review or comment payloads/);
    assert.match(command, /Use composer `qube` commands/);
    assert.match(command, /`qube aie run start --name ui-audit -- <command>`/);
    assert.match(command, /`qube aie run wait --name ui-audit --url <url> --timeout 30/);
    assert.match(command, /If start fails, run `qube aie run status --name ui-audit` exactly once/);
    assert.match(command, /If start succeeds, run exactly one bounded wait/);
    assert.match(command, /Do not run status after a successful start, retry wait/);
    assert.match(command, /Review mode is external/);
    assert.match(command, /GitHub review publisher mode is user/);
    assert.match(command, /Prefer repository package scripts/);
    assert.match(command, /Use agent-browser first for visual UI inspection/);
    assert.match(command, /capture and inspect PNG screenshots/);
    assert.match(command, /typed outcome, observations, screenshot hashes, findings, and blockers in audit\.json/);
    assert.match(command, /never claim UI audit success from CLI JSON, HTTP\/API responses, DOM text, passing tests, notes, filenames, hashes, or status checks/);
    assert.match(command, /collect `qube aie run status --name ui-audit` logs once/);
    assert.match(command, /no linked worktree is in use/);
    assert.match(command, /tests\/audits\/configured gates/);
    assert.match(command, /non-draft, ready-for-review pull request with work item closure -> run `qube pr gate <pr>` to request reviewers, wait for configured review gates, and check status/);
    assert.match(command, /open the ready pull request/);
    assert.match(command, /merge when required checks pass and no concrete blocker remains/);
    assert.match(command, /configured gates cannot run/);
    assert.match(command, /Stop implementation when/);
    assert.match(command, /Explicit user-directed analysis and queue triage may still proceed before implementation starts/);
    assert.match(command, /Report the exact blocker and the next supported action/);
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
    assert.doesNotMatch(agents, /apply package-age gates/);
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
    assert.match(agents, /apply package-age gates of 10 days or 20 days for high-risk tooling/);
    assert.match(agents, /Follow repository pinning policy for third-party CI actions/);
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

  it('does not rewrite malformed repository config when force is supplied', async () => {
    const repo = makeGitRepo();
    const configPath = join(repo, '.qube/aie/config.json');
    writeFileSync(configPath, '{broken');

    const result = await runInit({ target: '.', tool: 'opencode', dryRun: false, force: true, cwd: repo });

    assert.equal(result.ok, false);
    assert.equal(result.actions.find(action => action.path === join('.qube', 'aie', 'config.json')).operation, 'blocked');
    assert.match(result.errors.join('\n'), /Invalid repository config.*fix the file, then rerun the command/iu);
    assert.equal(readFileSync(configPath, 'utf8'), '{broken');
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
    assert.deepEqual(all.selectedTools, ['opencode', 'codex', 'claude-code', 'grok-build', 'cursor']);
    assert.ok(all.actions.some(action => action.path === 'CLAUDE.md'));

    const invalid = await buildInitPlan({ target: '.', tool: 'bad-tool', dryRun: true, force: false, cwd: repo });
    assert.equal(invalid.ok, false);
    assert.match(invalid.errors[0], /Unsupported init tool/);
  });

  it('models each host through the canonical capability profile', async () => {
    const { getAllAgentHostProfiles, hostIdsForInstructionPath } = require('../dist/agent_hosts.js');
    const profiles = await getAllAgentHostProfiles();
    const opencode = profiles.find(profile => profile.id === 'opencode');
    const codex = profiles.find(profile => profile.id === 'codex');
    const claude = profiles.find(profile => profile.id === 'claude-code');

    assert.equal(profiles.length, 5);
    assert.ok(opencode);
    assert.ok(codex);
    assert.ok(claude);
    const grok = profiles.find(profile => profile.id === 'grok-build');
    const cursor = profiles.find(profile => profile.id === 'cursor');
    assert.ok(cursor);
    assert.equal(cursor.subagents.support, 'unsupported');
    assert.equal(cursor.umpire.continuation.support, 'supported');
    assert.ok(grok);
    assert.deepEqual(profiles.map(profile => profile.makeItSo.path), [
      pathPosix.join('.opencode', 'commands', 'make-it-so.md'),
      pathPosix.join('.agents', 'skills', 'make-it-so', 'SKILL.md'),
      pathPosix.join('.claude', 'commands', 'make-it-so.md'),
      pathPosix.join('.grok', 'commands', 'make-it-so.md'),
      pathPosix.join('.cursor', 'commands', 'make-it-so.md'),
    ]);
    assert.deepEqual(opencode.review.local.agents.map(target => target.path), [pathPosix.join('.opencode', 'agent', 'qube-review-focus.md'), pathPosix.join('.opencode', 'agent', 'qube-review-explorer.md'), pathPosix.join('.opencode', 'agent', 'qube-review-digest.md'), pathPosix.join('.opencode', 'agent', 'qube-review-librarian.md')]);
    assert.deepEqual(codex.review.local.agents.map(target => target.path), [pathPosix.join('.codex', 'agents', 'qube-review-focus.toml'), pathPosix.join('.codex', 'agents', 'qube-review-explorer.toml'), pathPosix.join('.codex', 'agents', 'qube-review-digest.toml'), pathPosix.join('.codex', 'agents', 'qube-review-librarian.toml')]);
    assert.equal(grok.review.local.agents.length, 4);
    assert.equal(cursor.review.local.agents.length, 0);
    assert.equal(codex.taskList.tools.includes('update_plan'), true);
    assert.equal(claude.instructionTarget.path, 'CLAUDE.md');
    const agentsHosts = await hostIdsForInstructionPath('AGENTS.md');
    assert.deepEqual(agentsHosts, ['opencode', 'codex', 'grok-build', 'cursor']);
  });

  it('loads all required host profiles for instruction discovery', async () => {
    const { getAllAgentHostProfiles, getInstructionTargetPaths, hostIdsForInstructionPath } = require('../dist/agent_hosts.js');
    const profiles = await getAllAgentHostProfiles();

    assert.deepEqual(profiles.map(profile => profile.id), ['opencode', 'codex', 'claude-code', 'grok-build', 'cursor']);
    assert.deepEqual(await getInstructionTargetPaths(), ['AGENTS.md', 'CLAUDE.md']);
    assert.deepEqual(await hostIdsForInstructionPath('AGENTS.md'), ['opencode', 'codex', 'grok-build', 'cursor']);
    assert.deepEqual(await hostIdsForInstructionPath('CLAUDE.md'), ['claude-code']);
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
    assert.ok(metadata.flags.includes('--review-agent'));
    assert.ok(metadata.flags.includes('--local-review-agent'));
    assert.ok(metadata.flags.includes('--isolated-review-agent'));
    assert.ok(metadata.flags.includes('--review-model'));
    assert.ok(metadata.flags.includes('--ui-audit-evidence-root'));
    assert.ok(metadata.flags.includes('--publisher'));
    assert.ok(metadata.flags.includes('--tool'));
    assert.ok(metadata.flags.includes('--naming-rules'));
    assert.equal(metadata.flags.includes('--opencode-command-alias'), false);
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
    const usage = 'aie init <target> [--tool <id[,id...]|all>] [--from <path-or-repo>] [--review-mode external|host|isolated] [--review-agent <id>] [--local-review-agent <host>] [--isolated-review-agent <host>] [--review-model <host:model>] [--publisher user|github-app] [--work-provider github|gitlab|linear|jira] [--review-provider github|gitlab] [--ci-provider github|gitlab|jenkins] [--primary-host codex|claude-code|opencode|grok-build|cursor] [--primary-model <id>] [--defaults] [--yes] [--dry-run] [--force] [--json]';
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

  it('initializes a comma-separated agent harness set through the real CLI', () => {
    const repo = makeGitRepo();
    const requested = 'opencode,codex,claude-code,grok-build,cursor';

    const result = binRun(['init', '.', '--tool', requested, '--yes', '--json'], repo);
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.selectedTools, ['opencode', 'codex', 'claude-code', 'grok-build', 'cursor']);
    assert.equal(existsSync(join(repo, '.opencode', 'commands', 'make-it-so.md')), true);
    assert.equal(existsSync(join(repo, '.agents', 'skills', 'make-it-so', 'SKILL.md')), true);
    assert.equal(existsSync(join(repo, '.claude', 'commands', 'make-it-so.md')), true);
    assert.equal(existsSync(join(repo, '.grok', 'commands', 'make-it-so.md')), true);
    assert.equal(existsSync(join(repo, '.cursor', 'commands', 'make-it-so.md')), true);
  });

  it('binds the unpinned primary route to an explicit selected harness', () => {
    const repo = makeGitRepo();
    const requested = 'opencode,codex,claude-code,grok-build,cursor';
    const result = binRun([
      'init',
      '.',
      '--tool',
      requested,
      '--primary-host',
      'cursor',
      '--yes',
      '--json',
    ], repo);

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.selectedTools, ['opencode', 'codex', 'claude-code', 'grok-build', 'cursor']);
    const config = JSON.parse(readFileSync(join(repo, '.qube', 'aie', 'config.json'), 'utf8'));
    assert.equal(config.policy.modelRouting.primary, 'primary');
    assert.deepEqual(config.policy.modelRouting.catalog, [{
      id: 'primary',
      host: 'cursor',
      transport: 'host',
      costRank: 3,
      notes: 'Primary host model. Fallback target for every delegated route class.',
    }]);
    assert.equal(Object.hasOwn(config.policy.modelRouting.catalog[0], 'model'), false);
  });

  it('rejects a primary harness that is not selected by --tool', () => {
    const repo = makeGitRepo();
    const result = binRun([
      'init',
      '.',
      '--tool',
      'codex',
      '--primary-host',
      'cursor',
      '--yes',
      '--json',
    ], repo);

    assert.equal(result.status, 1, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.match(parsed.errors.join('\n'), /Primary harness cursor is not in the selected agent harnesses\./);
    assert.equal(existsSync(join(repo, '.qube', 'aie', 'config.json')), false);
  });

  it('routes isolated review to the selected non-primary harness', () => {
    const repo = makeGitRepo();
    const result = binRun([
      'init',
      '.',
      '--tool',
      'codex,cursor',
      '--review-mode',
      'isolated',
      '--isolated-review-agent',
      'cursor',
      '--yes',
      '--json',
    ], repo);

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.selectedTools, ['codex', 'cursor']);
    const config = JSON.parse(readFileSync(join(repo, '.qube', 'aie', 'config.json'), 'utf8'));
    assert.equal(config.policy.reviews.route.host, 'cursor');
    assert.equal(Object.hasOwn(config.policy.reviews.route, 'model'), false);
    assert.equal(config.policy.reviews.lanes.find(lane => lane.id === 'security').route.host, 'cursor');
  });

  it('rejects a selected harness that does not support isolated review', () => {
    const repo = makeGitRepo();
    const result = binRun([
      'init',
      '.',
      '--tool',
      'opencode,codex',
      '--review-mode',
      'isolated',
      '--isolated-review-agent',
      'opencode',
      '--yes',
      '--json',
    ], repo);

    assert.equal(result.status, 1, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.match(parsed.errors.join('\n'), /opencode.*does not support isolated review/);
    assert.equal(existsSync(join(repo, '.qube', 'aie', 'config.json')), false);
  });

  it('rejects an isolated review harness that is not selected by --tool', () => {
    const repo = makeGitRepo();
    const result = binRun([
      'init',
      '.',
      '--tool',
      'codex',
      '--review-mode',
      'isolated',
      '--isolated-review-agent',
      'cursor',
      '--yes',
      '--json',
    ], repo);

    assert.equal(result.status, 1, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.match(parsed.errors.join('\n'), /cursor.*not selected by --tool/);
    assert.equal(existsSync(join(repo, '.qube', 'aie', 'config.json')), false);
  });

  it('preserves the existing isolated review route when the flag is omitted on rerun', () => {
    const repo = makeGitRepo();
    const first = binRun([
      'init',
      '.',
      '--tool',
      'codex,cursor',
      '--review-mode',
      'isolated',
      '--isolated-review-agent',
      'cursor',
      '--yes',
      '--json',
    ], repo);
    assert.equal(first.status, 0, first.stderr);

    const rerun = binRun(['init', '.', '--tool', 'codex,cursor', '--yes', '--json'], repo);

    assert.equal(rerun.status, 0, rerun.stderr);
    const parsed = JSON.parse(rerun.stdout);
    assert.equal(parsed.ok, true);
    const config = JSON.parse(readFileSync(join(repo, '.qube', 'aie', 'config.json'), 'utf8'));
    assert.equal(config.policy.reviews.route.host, 'cursor');
    assert.equal(config.policy.reviews.lanes.find(lane => lane.id === 'security').route.host, 'cursor');
    assert.equal(parsed.actions.find(action => action.id === 'config').status, 'skipped');
  });

  it('reconciles mode-dependent review fields when an existing config changes review mode', () => {
    const repo = makeGitRepo();
    const configPath = join(repo, '.qube', 'aie', 'config.json');
    const config = cleanConfig();
    config.policy.branch.baseBranch = 'develop';
    config.policy.audit.manualUiAudit = false;
    config.policy.reviews.mode = 'external';
    config.policy.reviews.adapter = 'github';
    config.policy.reviews.profile = 'remote-compatible';
    config.policy.reviews.lanes = [];
    config.policy.reviews.route = null;
    config.policy.reviews.failover = null;
    config.policy.reviews.localAgents = ['opencode'];
    config.policy.reviews.models.review.codex = { model: 'custom-review-model', effort: 'high' };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const isolated = binRun([
      'init',
      '.',
      '--tool',
      'codex,cursor',
      '--review-mode',
      'isolated',
      '--isolated-review-agent',
      'cursor',
      '--yes',
      '--json',
    ], repo);

    assert.equal(isolated.status, 0, isolated.stderr);
    const isolatedConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(isolatedConfig.policy.reviews.mode, 'isolated');
    assert.equal(isolatedConfig.policy.reviews.adapter, 'local');
    assert.equal(isolatedConfig.policy.reviews.profile, 'local-focused');
    assert.equal(isolatedConfig.policy.reviews.route.host, 'cursor');
    assert.deepEqual(isolatedConfig.policy.reviews.localAgents, []);
    assert.ok(isolatedConfig.policy.reviews.lanes.length > 0);
    assert.equal(isolatedConfig.policy.reviews.lanes.find(lane => lane.id === 'security').route.host, 'cursor');
    assert.equal(isolatedConfig.policy.branch.baseBranch, 'develop');
    assert.equal(isolatedConfig.policy.audit.manualUiAudit, false);
    assert.deepEqual(isolatedConfig.policy.reviews.models.review.codex, { model: 'custom-review-model', effort: 'high' });

    const external = binRun(['init', '.', '--tool', 'codex,cursor', '--review-mode', 'external', '--yes', '--json'], repo);

    assert.equal(external.status, 0, external.stderr);
    const externalConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(externalConfig.policy.reviews.mode, 'external');
    assert.equal(externalConfig.policy.reviews.adapter, 'github');
    assert.equal(externalConfig.policy.reviews.profile, 'remote-compatible');
    assert.deepEqual(externalConfig.policy.reviews.lanes, []);
    assert.equal(externalConfig.policy.reviews.route, null);
    assert.equal(externalConfig.policy.reviews.failover, null);
    assert.deepEqual(externalConfig.policy.reviews.localAgents, []);
    assert.equal(externalConfig.policy.branch.baseBranch, 'develop');
    assert.equal(externalConfig.policy.audit.manualUiAudit, false);
    assert.deepEqual(externalConfig.policy.reviews.models.review.codex, { model: 'custom-review-model', effort: 'high' });
  });

  it('removes the GitHub publisher when an existing config changes to GitLab', () => {
    const repo = makeGitRepo();
    const configPath = join(repo, '.qube', 'aie', 'config.json');
    const config = cleanConfig();
    config.providers.review.publisher = {
      mode: 'github-app',
      githubApp: {
        appId: '123',
        installationId: '456',
        privateKeyEnv: 'QUBE_REVIEW_PRIVATE_KEY',
      },
    };
    config.policy.branch.baseBranch = 'develop';
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const result = binRun([
      'init',
      '.',
      '--tool',
      'codex',
      '--work-provider',
      'gitlab',
      '--review-provider',
      'gitlab',
      '--ci-provider',
      'gitlab',
      '--yes',
      '--json',
    ], repo);

    assert.equal(result.status, 0, result.stderr);
    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(written.providers.review.kind, 'gitlab');
    assert.equal(written.providers.review.publisher, undefined);
    assert.equal(written.policy.branch.baseBranch, 'develop');
  });

  it('rejects GitHub external review agents for a GitLab review provider', () => {
    const repo = makeGitRepo();
    const result = binRun([
      'init',
      '.',
      '--tool',
      'codex',
      '--work-provider',
      'gitlab',
      '--review-provider',
      'gitlab',
      '--review-mode',
      'external',
      '--review-agent',
      'coderabbit',
      '--yes',
      '--json',
    ], repo);

    assert.equal(result.status, 1, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.match(parsed.errors.join('\n'), /coderabbit.*not available for the GitLab review provider/);
    assert.equal(existsSync(join(repo, '.qube', 'aie', 'config.json')), false);
  });

  it('rejects an unknown id in a comma-separated agent harness set', () => {
    for (const requested of ['opencode,unknown', 'all,unknown']) {
      const repo = makeGitRepo();
      const result = binRun(['init', '.', '--tool', requested, '--yes', '--json'], repo);
      const parsed = JSON.parse(result.stdout);

      assert.equal(result.status, 1, result.stderr);
      assert.equal(parsed.ok, false);
      assert.match(parsed.errors[0], /Unsupported init tool/);
      assert.equal(existsSync(join(repo, '.qube', 'aie', 'config.json')), false);
    }
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
      'coderabbit',
    ], repo);
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.deepEqual(parsed.selectedTools, ['opencode', 'codex', 'claude-code', 'grok-build', 'cursor']);
    assert.equal(parsed.policy.namingRules, true);
    assert.equal(parsed.policy.milestoneOrdering, true);
    assert.equal(parsed.policy.missingMilestonePolicy, 'ignore');
    assert.equal(parsed.actions.some((action) => action.path === '.opencode/commands/makeitso.md'), false);
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
    assert.equal(metadata.flags.includes('--opencode-command-alias'), false);
    assert.equal(metadata.flags.includes('--no-opencode-command-alias'), false);
    assert.ok(metadata.flags.includes('--no-package-manager-defaults'));
    const tool = metadata.flagDetails.find(flag => flag.name === '--tool');
    const missingMilestone = metadata.flagDetails.find(flag => flag.name === '--missing-milestone');
    const age = metadata.flagDetails.find(flag => flag.name === '--package-age-days');
    assert.equal(tool.type, 'string');
    assert.equal(tool.options, undefined);
    assert.match(tool.description, /Comma-separated agent harness ids/);
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
    assert.match(generated, /Use the target project's product terms/);
    assert.match(generated, /issue implementation history, local reference paths, or source-provenance explanations/);
  });
});

describe('managed section checksum normalization', () => {
  const { planManagedUpdate, renderManagedSection, getManagedSectionHealth } = require('../dist/managed_file.js');

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
    // A checksum that does not match the managed body blocks.
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

  it('renders compact review and shipping rules in the managed instruction text', async () => {
    const hosts = await getAgentHostProfiles(['opencode', 'codex', 'claude-code', 'grok-build', 'cursor']);
    const instructions = renderAgentInstructions(getDefaults(), hosts);
    assertCompactWorkflow(instructions);
  });

  it('writes compact workflow rules into each instruction target on a fresh init', async () => {
    const repo = makeGitRepo();
    const result = await runInit({ target: '.', tool: 'all', dryRun: false, force: false, cwd: repo });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.deepEqual(result.selectedTools, ['opencode', 'codex', 'claude-code', 'grok-build', 'cursor']);
    assertCompactWorkflow(readFileSync(join(repo, 'AGENTS.md'), 'utf8'));
    assertCompactWorkflow(readFileSync(join(repo, 'CLAUDE.md'), 'utf8'));

    const grokRepo = makeGitRepo();
    const grok = await runInit({ target: '.', tool: 'grok-build', dryRun: false, force: false, cwd: grokRepo });
    assert.equal(grok.ok, true, grok.errors.join('\n'));
    assertCompactWorkflow(readFileSync(join(grokRepo, 'AGENTS.md'), 'utf8'));
    assert.equal(existsSync(join(grokRepo, 'CLAUDE.md')), false);
  });

  it('replaces an old cadence list with the compact workflow', async () => {
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
    assertCompactWorkflow(agents);
    const agentsAction = result.actions.find(action => action.path === 'AGENTS.md');
    assert.ok(agentsAction);
    assert.equal(agentsAction.operation, 'replace-managed');
  });
});
