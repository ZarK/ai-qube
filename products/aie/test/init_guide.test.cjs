const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
require('./support/compile_cache.cjs');
const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { cloneGitRepo } = require('./support/git_fixture.cjs');

const {
  buildInitPlan,
  runInit,
  collectSetupDoctorRecommendations,
  resolveContainedFromPath,
  parseAdoptedConfig,
  classifyFromSpec,
} = require('../dist/init/index.js');
const { applyQuestionAnswersToPolicy, buildInitQuestions, detectGuideMachine, isolatedReviewHostsOnMachine, recommendedReviewMode } = require('../dist/init/questions.js');
const { configToFileShape, getDefaults, validateConfig } = require('../dist/config/index.js');

function makeGitRepo() {
  const repo = cloneGitRepo('committed', 'aie-init-guide-');
  mkdirSync(join(repo, '.qube', 'aie'), { recursive: true });
  return repo;
}

function binRun(args, cwd = process.cwd()) {
  return spawnSync(process.execPath, [join(process.cwd(), 'bin/run'), ...args], { cwd, encoding: 'utf8' });
}

function writeSourceConfig(root, relativeDir, overrides = {}) {
  const dir = join(root, relativeDir, '.qube', 'aie');
  mkdirSync(dir, { recursive: true });
  const base = configToFileShape(getDefaults());
  const record = {
    ...base,
    ...overrides,
    policy: {
      ...base.policy,
      ...(overrides.policy ?? {}),
      reviews: {
        ...base.policy.reviews,
        ...(overrides.policy?.reviews ?? {}),
      },
      audit: {
        ...base.policy.audit,
        ...(overrides.policy?.audit ?? {}),
      },
      gates: {
        ...base.policy.gates,
        ...(overrides.policy?.gates ?? {}),
      },
    },
  };
  const path = join(dir, 'config.json');
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return { path, record };
}

describe('init guide questions', () => {
  it('discovers Cursor for isolated review without making it a delegated routing host', () => {
    const machine = detectGuideMachine({
      repoRoot: null,
      installedHosts: ['cursor'],
      agentBrowserAvailable: false,
      aiqAvailable: false,
    });
    assert.deepEqual(machine.installedHosts, ['cursor']);
    assert.deepEqual(isolatedReviewHostsOnMachine(machine), ['cursor']);
    assert.equal(recommendedReviewMode(machine), 'isolated');
  });

  it('emits a machine-readable question set without writing files', async () => {
    const repo = makeGitRepo();
    const result = await buildInitPlan({
      target: '.',
      tool: 'opencode',
      dryRun: false,
      force: false,
      cwd: repo,
      guide: true,
      installedHosts: ['grok-build'],
      agentBrowserAvailable: false,
      aiqAvailable: false,
    });

    assert.equal(result.ok, true);
    assert.equal(result.awaitingAnswers, true);
    assert.equal(existsSync(join(repo, '.qube/aie/config.json')), false);
    assert.deepEqual(result.questions.map(item => item.id), ['review-mode', 'reviewers', 'review-models', 'publisher', 'quality-gate', 'ui-audit', 'attribution-hygiene']);
    assert.ok(!result.questions.some(item => /run command|ready url|app launch|audit target/i.test(`${item.id} ${item.prompt}`)));
    assert.ok(result.questions.every(item => item.prompt && item.recommendation && Array.isArray(item.options)));
    assert.deepEqual(result.unansweredQuestionIds, ['review-mode', 'reviewers', 'review-models', 'publisher', 'quality-gate', 'ui-audit', 'attribution-hygiene']);
    assert.equal(result.setupSummary.manualUiAudit, false);
    assert.equal(result.setupSummary.qualityControl, false);
    assert.equal(result.setupSummary.reviewMode, 'isolated');
  });

  it('consumes invocation answers without re-asking those questions', async () => {
    const repo = makeGitRepo();
    const result = await buildInitPlan({
      target: '.',
      tool: 'opencode',
      dryRun: true,
      force: false,
      cwd: repo,
      guide: true,
      installedHosts: ['grok-build'],
      agentBrowserAvailable: false,
      aiqAvailable: false,
      policy: { reviewMode: 'host', manualUiAudit: false },
    });

    const reviewMode = result.questions.find(item => item.id === 'review-mode');
    const uiAudit = result.questions.find(item => item.id === 'ui-audit');
    assert.equal(reviewMode.answered, true);
    assert.equal(reviewMode.value, 'host');
    assert.equal(uiAudit.answered, true);
    assert.equal(uiAudit.value, 'false');
    assert.ok(result.unansweredQuestionIds.includes('publisher'));
    assert.ok(!result.unansweredQuestionIds.includes('review-mode'));
    assert.equal(result.setupSummary.reviewMode, 'host');
  });

  it('includes live host models in the review-models question, not reviewers', () => {
    const questions = buildInitQuestions({
      machine: {
        installedHosts: ['grok-build'],
        agentBrowserAvailable: false,
        aiqAvailable: false,
        hasUserFacingUi: false,
        liveModels: { 'grok-build': ['grok-4.5'] },
      },
      answers: {},
    });
    const models = questions.find(item => item.id === 'review-models');
    assert.ok(models.options.some(option => option.value === 'grok-build:grok-4.5'));
    assert.ok(!questions.find(item => item.id === 'reviewers').options.some(option => option.value === 'grok-build:grok-4.5'));
  });

  it('offers live OpenCode models for native host review', () => {
    const questions = buildInitQuestions({
      machine: {
        installedHosts: ['opencode'],
        agentBrowserAvailable: false,
        aiqAvailable: false,
        hasUserFacingUi: false,
        liveModels: { opencode: ['opencode-current'] },
      },
      answers: { reviewMode: 'host' },
    });
    const models = questions.find(item => item.id === 'review-models');
    assert.match(models.prompt, /native review/);
    assert.ok(models.options.some(option => option.value === 'opencode:opencode-current'));
    const policy = applyQuestionAnswersToPolicy({}, [
      { id: 'review-models', answered: true, value: ['opencode:opencode-current'] },
    ]);
    assert.deepEqual(policy.reviewModels.review.opencode, { model: 'opencode-current', effort: null });
  });

  it('does not invent a Claude Code catalog for native host review', () => {
    const questions = buildInitQuestions({
      machine: {
        installedHosts: ['claude-code'],
        agentBrowserAvailable: false,
        aiqAvailable: false,
        hasUserFacingUi: false,
        liveModels: {},
      },
      answers: { reviewMode: 'host' },
    });
    const models = questions.find(item => item.id === 'review-models');
    assert.deepEqual(models.options, [{ value: 'none', label: 'No live host catalog is available.', available: false }]);
  });

  it('writes live host models to reviewModels and never to reviewAgents', () => {
    const policy = applyQuestionAnswersToPolicy({}, [
      { id: 'reviewers', answered: true, value: ['coderabbitai', 'grok-build:grok-4.5'] },
      { id: 'review-models', answered: true, value: ['grok-build:grok-4.5'] },
    ]);
    assert.deepEqual(policy.reviewAgents, ['coderabbitai']);
    assert.deepEqual(policy.reviewModels.review['grok-build'], { model: 'grok-4.5', effort: null });
    const empty = applyQuestionAnswersToPolicy({}, [
      { id: 'review-models', answered: true, value: [] },
    ]);
    assert.equal(empty.reviewModels, undefined);
  });

  it('does not recommend isolated when no review host is installed', () => {
    const questions = buildInitQuestions({
      machine: { installedHosts: [], agentBrowserAvailable: false, aiqAvailable: false, hasUserFacingUi: false },
      answers: {},
    });
    const reviewMode = questions.find(item => item.id === 'review-mode');
    assert.equal(reviewMode.recommendedValue, 'external');
    assert.equal(reviewMode.options.find(option => option.value === 'isolated').available, false);
    for (const item of questions) {
      if (typeof item.recommendedValue !== 'string') continue;
      assert.ok(
        item.options.some(option => option.value === item.recommendedValue),
        `${item.id} recommendedValue must match an option value`,
      );
    }
  });

  it('rejects isolated mode when the invocation asked for it without an installed host', async () => {
    const repo = makeGitRepo();
    const result = await buildInitPlan({
      target: '.',
      tool: 'opencode',
      dryRun: true,
      force: false,
      cwd: repo,
      guide: true,
      installedHosts: [],
      policy: { reviewMode: 'isolated' },
    });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /isolated requires an installed review host/);
  });

  it('asks where to keep UI audit evidence when UI audit is recommended', () => {
    const questions = buildInitQuestions({
      machine: { installedHosts: ['grok-build'], agentBrowserAvailable: true, aiqAvailable: false, hasUserFacingUi: true },
      answers: {},
    });
    const evidence = questions.find(item => item.id === 'ui-audit-evidence');
    assert.ok(evidence);
    assert.match(evidence.prompt, /Where should this machine keep local UI audit evidence/);
    assert.equal(evidence.recommendedValue, '~/.qube/verification');
    assert.ok(evidence.options.some(option => option.value === '~/.qube/verification'));
    assert.equal(evidence.options.some(option => option.value === '~/github-verification'), false);
  });

  it('omits the evidence-root question when UI audit is off and not recommended', () => {
    const questions = buildInitQuestions({
      machine: { installedHosts: [], agentBrowserAvailable: false, aiqAvailable: false, hasUserFacingUi: false },
      answers: { manualUiAudit: false },
    });
    assert.equal(questions.some(item => item.id === 'ui-audit-evidence'), false);
  });

  it('writes the QUBE user default evidence root on --yes when UI audit is on', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'index.html'), '<html></html>\n');
    const result = await runInit({
      target: '.',
      tool: 'opencode',
      dryRun: false,
      force: false,
      cwd: repo,
      yes: true,
      installedHosts: ['grok-build'],
      agentBrowserAvailable: true,
      aiqAvailable: false,
    });
    assert.equal(result.ok, true);
    const written = JSON.parse(readFileSync(join(repo, '.qube', 'aie', 'config.json'), 'utf8'));
    assert.equal(written.policy.audit.evidenceRoot, '~/.qube/verification');
  });

  it('keeps a pre-set custom evidence root instead of overwriting it', () => {
    const policy = applyQuestionAnswersToPolicy(
      { uiAuditEvidenceRoot: '~/already-set' },
      [{ id: 'ui-audit-evidence', answered: true, value: '~/.qube/verification' }],
    );
    assert.equal(policy.uiAuditEvidenceRoot, '~/already-set');
  });

  it('asks whether to install attribution hygiene rules and recommends include', () => {
    const questions = buildInitQuestions({
      machine: { installedHosts: [], agentBrowserAvailable: false, aiqAvailable: false, hasUserFacingUi: false },
      answers: {},
    });
    const item = questions.find(entry => entry.id === 'attribution-hygiene');
    assert.ok(item);
    assert.match(item.prompt, /human project identity/);
    assert.equal(item.recommendedValue, 'true');
    assert.equal(item.answered, false);
  });

  it('writes attribution hygiene on --yes and omits it for --no-credit-warning', async () => {
    const included = makeGitRepo();
    const includedResult = await runInit({
      target: '.',
      tool: 'opencode',
      dryRun: false,
      force: false,
      cwd: included,
      yes: true,
      installedHosts: ['grok-build'],
      agentBrowserAvailable: false,
      aiqAvailable: false,
    });
    assert.equal(includedResult.ok, true);
    const includedConfig = JSON.parse(readFileSync(join(included, '.qube', 'aie', 'config.json'), 'utf8'));
    const includedAgents = readFileSync(join(included, 'AGENTS.md'), 'utf8');
    assert.equal(includedConfig.policy.instructions.noCreditWarning, true);
    assert.match(includedAgents, /agent, model, service, or vendor credit/);
    assert.match(includedAgents, /Co-authored-by/);
    assert.match(includedAgents, /refs\/notes\/ai/);
    assert.match(includedAgents, /QUBE may use its configured review publisher/);
    assert.match(includedAgents, /Silence is not a waiver/);

    const omitted = makeGitRepo();
    const omittedResult = await runInit({
      target: '.',
      tool: 'opencode',
      dryRun: false,
      force: false,
      cwd: omitted,
      yes: true,
      installedHosts: ['grok-build'],
      agentBrowserAvailable: false,
      aiqAvailable: false,
      policy: { instructions: { noCreditWarning: false } },
    });
    assert.equal(omittedResult.ok, true);
    const omittedConfig = JSON.parse(readFileSync(join(omitted, '.qube', 'aie', 'config.json'), 'utf8'));
    const omittedAgents = readFileSync(join(omitted, 'AGENTS.md'), 'utf8');
    assert.equal(omittedConfig.policy.instructions.noCreditWarning, false);
    assert.doesNotMatch(omittedAgents, /agent, model, service, or vendor credit/);
    assert.doesNotMatch(omittedAgents, /QUBE may use its configured review publisher/);
  });
});

describe('UI audit evidence path docs', () => {
  it('records the user-local ~/.qube/verification path as uncommitted AIE audit evidence', () => {
    const { readFileSync: readDoc } = require('node:fs');
    const { resolve } = require('node:path');
    const page = readDoc(resolve(process.cwd(), '../../docs/qube-paths-and-artifacts.md'), 'utf8');
    assert.match(page, /~\/\.qube\/verification\/<repository>\/<issue>\//);
    assert.match(page, /user-local UI audit evidence/);
    assert.match(page, /not committed/i);
    assert.doesNotMatch(page, /github-verification/);
  });
});

describe('init --from', () => {
  it('adopts a relative source and reports machine adjustments', async () => {
    const repo = makeGitRepo();
    writeSourceConfig(repo, 'known-good', {
      policy: {
        reviews: { mode: 'isolated', agents: ['review-bot'] },
        audit: { manualUiAudit: true, appLaunch: '', target: '' },
        gates: { qualityControl: true, definitions: [], focusedSelectors: [] },
      },
    });

    const result = await runInit({
      target: '.',
      tool: 'opencode',
      dryRun: false,
      force: false,
      cwd: repo,
      guide: true,
      yes: true,
      from: 'known-good',
      installedHosts: ['grok-build'],
      agentBrowserAvailable: false,
      aiqAvailable: false,
    });

    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.awaitingAnswers, false);
    assert.equal(result.from.kind, 'path');
    assert.equal(result.from.source, 'known-good/.qube/aie/config.json');
    assert.ok(result.from.sourceDigest);
    assert.ok(result.from.adjustments.some(item => /Disabled manual UI audit/.test(item)));
    assert.ok(result.from.adjustments.some(item => /Disabled Quality Control/.test(item)));
    const config = JSON.parse(readFileSync(join(repo, '.qube/aie/config.json'), 'utf8'));
    assert.equal(config.policy.reviews.mode, 'isolated');
    assert.deepEqual(config.policy.reviews.agents, ['review-bot']);
    assert.equal(config.policy.audit.manualUiAudit, false);
    assert.equal(config.policy.gates.qualityControl, false);
  });

  it('adopts an owner/repo slug through the injected fetcher', async () => {
    const repo = makeGitRepo();
    const source = configToFileShape(getDefaults());
    source.policy.reviews.mode = 'host';
    source.policy.reviews.agents = ['slug-bot'];
    const first = await runInit({
      target: '.',
      tool: 'opencode',
      dryRun: true,
      force: false,
      cwd: repo,
      guide: true,
      yes: true,
      from: 'owner/good-repo',
      fetchRepoConfig: async () => JSON.stringify(source),
      installedHosts: ['grok-build'],
      agentBrowserAvailable: false,
      aiqAvailable: false,
    });
    assert.equal(first.ok, true, first.errors.join('\n'));
    assert.equal(first.from.kind, 'repo');
    assert.equal(first.from.source, 'owner/good-repo');
    assert.equal(first.setupSummary.reviewMode, 'host');
    assert.deepEqual(first.setupSummary.reviewers, ['slug-bot']);

    const changed = { ...source, policy: { ...source.policy, reviews: { ...source.policy.reviews, agents: ['other-bot'] } } };
    const second = await runInit({
      target: '.',
      tool: 'opencode',
      dryRun: true,
      force: false,
      cwd: repo,
      guide: true,
      yes: true,
      from: 'owner/good-repo',
      fetchRepoConfig: async () => JSON.stringify(changed),
      installedHosts: ['grok-build'],
      agentBrowserAvailable: false,
      aiqAvailable: false,
    });
    assert.notEqual(second.from.sourceDigest, first.from.sourceDigest);
    assert.deepEqual(second.setupSummary.reviewers, ['other-bot']);
  });

  it('rejects absolute, parent-directory, url, and symlink-escape --from values', async () => {
    const repo = makeGitRepo();
    const outsideDir = join(tmpdir(), `aie-from-outside-${process.pid}`);
    mkdirSync(join(outsideDir, '.qube', 'aie'), { recursive: true });
    writeFileSync(join(outsideDir, '.qube', 'aie', 'config.json'), '{}\n');
    mkdirSync(join(repo, 'inside'), { recursive: true });
    symlinkSync(outsideDir, join(repo, 'inside', 'escape'), 'junction');

    assert.equal(classifyFromSpec('https://example.com/repo'), 'url');
    assert.equal(resolveContainedFromPath(repo, '/etc/passwd').failure, 'absolute-path');
    assert.equal(resolveContainedFromPath(repo, '..\\secret').failure, 'parent-directory');
    assert.equal(resolveContainedFromPath(repo, 'inside/escape').failure, 'symlink-escape');

    const absolute = await buildInitPlan({ target: '.', tool: 'opencode', dryRun: true, force: false, cwd: repo, guide: true, from: join(repo, 'known-good') });
    assert.equal(absolute.ok, false);
    assert.match(absolute.errors[0], /Absolute paths are rejected/);

    const parent = await buildInitPlan({ target: '.', tool: 'opencode', dryRun: true, force: false, cwd: repo, guide: true, from: '../outside' });
    assert.equal(parent.ok, false);
    assert.match(parent.errors[0], /parent-directory/);

    const url = await buildInitPlan({ target: '.', tool: 'opencode', dryRun: true, force: false, cwd: repo, guide: true, from: 'https://github.com/owner/repo' });
    assert.equal(url.ok, false);
    assert.match(url.errors[0], /does not accept URLs/);

    const escaped = await buildInitPlan({ target: '.', tool: 'opencode', dryRun: true, force: false, cwd: repo, guide: true, from: 'inside/escape' });
    assert.equal(escaped.ok, false);
    assert.match(escaped.errors[0], /symlink or junction/);
    assert.equal(existsSync(join(repo, '.qube/aie/config.json')), false);
  });

  it('rejects a forged approval marker and invalid source JSON without writing', async () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, 'forged', '.qube', 'aie'), { recursive: true });
    writeFileSync(join(repo, 'forged', '.qube', 'aie', 'config.json'), `${JSON.stringify({ ok: true, approved: true, policy: {} })}\n`);
    const forged = parseAdoptedConfig(JSON.stringify({ ok: true, policy: {} }));
    assert.equal(forged.ok, false);
    assert.equal(forged.failure, 'forged-marker');

    const result = await runInit({
      target: '.',
      tool: 'opencode',
      dryRun: false,
      force: false,
      cwd: repo,
      guide: true,
      yes: true,
      from: 'forged',
    });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /does not trust approval or ok markers/);
    assert.equal(existsSync(join(repo, 'AGENTS.md')), false);
  });
});

describe('init guide CLI and doctor-clean setup', () => {
  it('CLI without --yes emits questions and does not write', () => {
    const repo = makeGitRepo();
    const result = binRun(['init', '.', '--json'], repo);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.awaitingAnswers, true);
    assert.ok(parsed.questions.length >= 5);
    assert.equal(existsSync(join(repo, '.qube/aie/config.json')), false);
    assert.equal(existsSync(join(repo, 'AGENTS.md')), false);
  });

  it('CLI --yes writes a fresh repository setup that passes doctor with no setup warnings', async () => {
    const repo = makeGitRepo();
    const preview = binRun(['init', '.', '--review-mode', 'host', '--json'], repo);
    const previewParsed = JSON.parse(preview.stdout);
    assert.equal(previewParsed.questions.find(item => item.id === 'review-mode').answered, true);
    assert.equal(previewParsed.questions.find(item => item.id === 'review-mode').value, 'host');
    assert.equal(existsSync(join(repo, '.qube/aie/config.json')), false);

    const written = binRun(['init', '.', '--yes', '--json'], repo);
    assert.equal(written.status, 0, written.stderr);
    const parsed = JSON.parse(written.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.awaitingAnswers, false);
    assert.equal(existsSync(join(repo, '.qube/aie/config.json')), true);
    assert.equal(existsSync(join(repo, 'AGENTS.md')), true);
    const config = validateConfig(JSON.parse(readFileSync(join(repo, '.qube/aie/config.json'), 'utf8')));
    assert.equal(config.ok, true);
    const recommendations = collectSetupDoctorRecommendations(repo, config.config);
    assert.deepEqual(recommendations, [], 'fresh repository setup must pass doctor with no setup warnings');
    if (parsed.setupSummary.reviewMode === 'isolated') {
      assert.equal(config.config.reviewAdapter, 'local');
      assert.equal(config.config.reviewProfile, 'local-focused');
      assert.deepEqual(config.config.reviewLanes.map(lane => lane.id), [
        'issue-compliance',
        'code-quality',
        'performance',
        'ui-ux-accessibility',
        'security',
      ]);
      assert.equal(config.config.reviewLanes.find(lane => lane.id === 'security').required, 'when-matched');
    } else {
      assert.equal(parsed.setupSummary.reviewMode, 'external');
      assert.equal(config.config.reviewAdapter, 'github');
    }
  });

  it('publishes --from, --review-mode, and --publisher in schema metadata', () => {
    const { getCommandMetadata } = require('../dist/command_metadata.js');
    const metadata = getCommandMetadata('init');
    assert.ok(metadata.flags.includes('--from'));
    assert.ok(metadata.flags.includes('--review-mode'));
    assert.ok(metadata.flags.includes('--ui-audit-evidence-root'));
    assert.ok(metadata.flags.includes('--publisher'));
  });

  it('CLI --ui-audit-evidence-root writes the evidence root', () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'index.html'), '<html></html>\n');
    const preview = binRun(['init', '.', '--manual-ui-audit', '--ui-audit-evidence-root', '~/custom-audit', '--json'], repo);
    const previewParsed = JSON.parse(preview.stdout);
    const evidence = previewParsed.questions.find(item => item.id === 'ui-audit-evidence');
    assert.ok(evidence);
    assert.equal(evidence.answered, true);
    assert.equal(evidence.value, '~/custom-audit');

    const written = binRun(['init', '.', '--yes', '--ui-audit-evidence-root', '~/custom-audit', '--json'], repo);
    assert.equal(written.status, 0, written.stderr);
    const config = JSON.parse(readFileSync(join(repo, '.qube', 'aie', 'config.json'), 'utf8'));
    assert.equal(config.policy.audit.evidenceRoot, '~/custom-audit');
  });

  it('CLI rejects parent-directory --ui-audit-evidence-root values', () => {
    const repo = makeGitRepo();
    const result = binRun(['init', '.', '--yes', '--ui-audit-evidence-root', '~/custom/../outside', '--json'], repo);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /parent-directory/);
  });
});
