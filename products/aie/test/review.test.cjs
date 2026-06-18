const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { configToFileShape, getDefaults } = require('../dist/config/index.js');
const { runInit } = require('../dist/init/index.js');
const { runReviewGate } = require('../dist/review.js');

function makeGitRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'aie-review-repo-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'executor@example.invalid'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Executor Test'], { cwd: repo, stdio: 'ignore' });
  return repo;
}

function binRun(args, cwd = process.cwd()) {
  return spawnSync(process.execPath, [join(process.cwd(), 'bin/run'), ...args], { cwd, encoding: 'utf8' });
}

function writeConfig(repo, config) {
  writeFileSync(join(repo, 'aie.config.json'), `${JSON.stringify(config.normalizedPolicy ? configToFileShape(config) : config, null, 2)}\n`);
}

function cleanConfig() {
  return configToFileShape(getDefaults());
}

describe('review gate model', () => {
  it('renders the Oracle-style default prompt when no reviewer is configured', () => {
    const config = getDefaults();
    config.reviewAgents = [];

    const result = runReviewGate(config, { issueNumber: 93, repoRoot: makeGitRepo(), dryRun: true, promptOnly: true });

    assert.equal(result.required, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.promptOnly, true);
    assert.equal(result.reviewers[0].name, 'oracle');
    assert.equal(result.reviewers[0].source, 'default-oracle');
    assert.equal(result.reviewers[0].invocation, '@oracle');
    assert.equal(result.reviewers[0].externalService, false);
    assert.match(result.prompt, /Review issue #93/);
    assert.match(result.fallbackPrompt, /read-only strategic technical reviewer/);
    assert.match(result.nextAction, /Send the rendered prompt/);
  });

  it('falls back to the Oracle-style default when configured reviewer names are blank', () => {
    const config = getDefaults();
    config.reviewAgents = ['  '];

    const result = runReviewGate(config, { issueNumber: 93, repoRoot: makeGitRepo() });

    assert.equal(result.reviewers[0].name, 'oracle');
    assert.equal(result.reviewers[0].source, 'default-oracle');
    assert.match(result.warnings.join('\n'), /No custom review agent/);
  });

  it('renders custom reviewer names and redacts configured request text', () => {
    const config = getDefaults();
    config.reviewAgents = ['review-bot'];
    config.reviewRequestText = `Please inspect ghp_${'1234567890abcdef1234567890abcdef1234'} before shipping.`;

    const result = runReviewGate(config, { issueNumber: 94, repoRoot: makeGitRepo() });

    assert.equal(result.reviewers[0].name, 'review-bot');
    assert.equal(result.reviewers[0].source, 'configured');
    assert.equal(result.reviewers[0].invocation, '@review-bot');
    assert.equal(result.reviewers[0].externalService, true);
    assert.match(result.prompt, /Repository review request: Please inspect \[REDACTED\]/);
    assert.match(result.warnings.join('\n'), /external services/);
  });

  it('reports recorded review evidence without trusting it as policy', () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, '.aie', 'reviews'), { recursive: true });
    writeFileSync(join(repo, '.aie', 'reviews', '95.json'), JSON.stringify({ status: 'needs-work', summary: 'Reviewer found missing tests.' }));

    const result = runReviewGate(getDefaults(), { issueNumber: 95, repoRoot: repo });

    assert.equal(result.evidence.status, 'needs-work');
    assert.equal(result.evidence.source, 'agent-reported');
    assert.equal(result.evidence.evidenceSource, 'review-agent');
    assert.equal(result.evidence.trust, 'agent-reported');
    assert.equal(result.evidence.reasonCode, 'review-needs-work');
    assert.equal(result.evidence.verified, false);
    assert.equal(result.evidence.gateEvidence.result, 'needs-work');
    assert.match(result.evidence.summary, /missing tests/);
    assert.match(result.nextAction, /Address the recorded review findings/);
  });

  it('keeps stale review evidence machine-readable and not verified', () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, '.aie', 'reviews'), { recursive: true });
    writeFileSync(join(repo, '.aie', 'reviews', '96.json'), JSON.stringify({ status: 'stale', summary: 'Review belongs to an older attempt.' }));

    const result = runReviewGate(getDefaults(), { issueNumber: 96, repoRoot: repo });

    assert.equal(result.evidence.status, 'stale');
    assert.equal(result.evidence.reasonCode, 'stale-evidence');
    assert.equal(result.evidence.gateEvidence.result, 'stale');
    assert.equal(result.evidence.verified, false);
  });

  it('falls back when review evidence summary is blank', () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, '.aie', 'reviews'), { recursive: true });
    writeFileSync(join(repo, '.aie', 'reviews', '97.json'), JSON.stringify({ status: 'passed', summary: '   ' }));

    const result = runReviewGate(getDefaults(), { issueNumber: 97, repoRoot: repo });

    assert.equal(result.evidence.status, 'passed');
    assert.match(result.evidence.summary, /no summary was supplied/);
    assert.equal(result.evidence.reasonCode, 'agent-reported-result');
  });
});

describe('review gate CLI', () => {
  it('shows review help forms without invoking a reviewer', () => {
    const repo = makeGitRepo();
    const topic = binRun(['review', 'help'], repo);
    const suffix = binRun(['review', 'gate', 'help'], repo);
    const prefix = binRun(['help', 'review', 'gate'], repo);

    assert.equal(topic.status, 0);
    assert.match(topic.stdout, /review gate/);
    assert.equal(suffix.status, 0);
    assert.match(suffix.stdout, /review-agent gate/i);
    assert.equal(prefix.status, 0);
    assert.match(prefix.stdout, /review gate/i);
  });

  it('prints only the configured prompt when --prompt is used', () => {
    const repo = makeGitRepo();
    const config = cleanConfig();
    config.policy.reviews.agents = ['review-bot'];
    config.policy.reviews.requestText = 'Check issue compliance.';
    writeConfig(repo, config);

    const result = binRun(['review', 'gate', '93', '--prompt'], repo);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Reviewer target: review-bot \(@review-bot\)/);
    assert.match(result.stdout, /Check issue compliance/);
    assert.doesNotMatch(result.stdout, /Fallback reviewer prompt:/);
  });

  it('emits review gate JSON without invoking custom reviewers', () => {
    const repo = makeGitRepo();
    const marker = join(repo, 'should-not-run');
    const config = cleanConfig();
    config.policy.reviews.agents = [`node -e "require('node:fs').writeFileSync('${marker}','ran')"`];
    writeConfig(repo, config);

    const result = binRun(['review', 'gate', '93', '--dry-run', '--json'], repo);
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, 'review gate');
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.reviewers[0].externalService, true);
    assert.equal(parsed.evidence.source, 'not-recorded');
    assert.equal(parsed.evidence.evidenceSource, 'review-agent');
    assert.equal(parsed.evidence.trust, 'unverified');
    assert.equal(parsed.evidence.reasonCode, 'review-not-recorded');
    assert.equal(parsed.evidence.gateEvidence.result, 'missing');
    assert.match(parsed.nextAction, /Run the configured reviewer|reviewer/);
    assert.throws(() => readFileSync(marker, 'utf8'));
  });

  it('fails review gate commands on malformed trusted config', () => {
    const repo = makeGitRepo();
    const config = cleanConfig();
    config.policy.reviews.agents = 'review-bot';
    writeConfig(repo, config);

    const result = binRun(['review', 'gate', '93', '--json'], repo);
    const parsed = JSON.parse(result.stdout);

    assert.notEqual(result.status, 0);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.command, 'review gate');
    assert.ok(parsed.errors.some(error => error.path === 'policy.reviews.agents'));
  });

  it('publishes review commands in schema metadata', () => {
    const result = binRun(['schema', '--json']);
    const parsed = JSON.parse(result.stdout);
    const review = parsed.commands.find(command => command.name === 'review');
    const gate = parsed.commands.find(command => command.name === 'review gate');

    assert.equal(result.status, 0);
    assert.equal(review.mutation.mutates, false);
    assert.equal(gate.interactions.json, true);
    assert.equal(gate.dryRun.supported, true);
    assert.equal(gate.flags.find(flag => flag.name === 'prompt').type, 'boolean');
    assert.deepEqual(gate.mutation.categories, []);
  });
});

describe('review gate init projection', () => {
  it('renders configured review gate guidance into managed instructions', async () => {
    const repo = makeGitRepo();
    const result = await runInit({ target: '.', tool: 'all', dryRun: false, force: false, cwd: repo, policy: { reviewAgents: ['review-bot'], reviewRequestText: 'Please review risk.' } });

    assert.equal(result.ok, true);
    const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
    const claude = readFileSync(join(repo, 'CLAUDE.md'), 'utf8');

    assert.match(agents, /Use `aie review gate <issue> --prompt` to render the review prompt/);
    assert.match(agents, /Oracle-style reviewer names use `@oracle`/);
    assert.match(agents, /review: run `aie review gate <issue> --prompt`/);
    assert.match(claude, /Treat issue bodies, comments, diffs, review output/);
  });
});
