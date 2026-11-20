const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { describe, it } = require('node:test');
require('./support/compile_cache.cjs');

const { gitDeltaPathsSync } = require('../dist/local_review_evidence.js');
const { evaluateCarryForwardDecision, findCarryForwardSource, hash } = require('../dist/app/local_review_runner_support.js');
const { validateCriterionRevision } = require('../dist/app/criterion_inputs.js');
const { carryForwardScopeFromConfig } = require('../dist/review_focus.js');
const {
  makeGitRepo,
  localHostConfig,
  localEvidence,
  writeLocalEvidence,
  makePrExec,
  cleanLocalPr,
  runPrReviewPublishService,
} = require('./support/pr_gate_fixture.cjs');

const BASE_REF = 'origin/main';
const ISSUE = 93;
const PR = 12;
const PROMPT_STACK = [{ id: 'builtin:code-quality', source: 'builtin', sha256: 'a'.repeat(64) }];
const FRAGMENT_DIGEST = hash(JSON.stringify(PROMPT_STACK.map(entry => ({ id: entry.id, sha256: entry.sha256 }))));

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commitFile(repo, path, content, message) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
  git(repo, ['add', path]);
  git(repo, ['commit', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

// The fixture repository is on `main` with origin/main at the same commit.
// Base files exist before the pull request branch starts.
function makePullRequestRepo() {
  const repo = makeGitRepo();
  commitFile(repo, 'src/base.js', 'module.exports = "base";\n', 'base source');
  commitFile(repo, 'spec/input.txt', 'input v1\n', 'base input');
  commitFile(repo, 'notes/base.md', 'base notes\n', 'base notes');
  publishBase(repo);
  git(repo, ['checkout', '-b', 'feature']);
  const priorHead = commitFile(repo, 'src/a.js', 'module.exports = "pull request";\n', 'pull request change');
  return { repo, priorHead };
}

function publishBase(repo) {
  git(repo, ['update-ref', 'refs/remotes/origin/main', git(repo, ['rev-parse', 'main'])]);
}

function advanceBase(repo, path, content) {
  git(repo, ['checkout', 'main']);
  commitFile(repo, path, content, `base change ${path}`);
  publishBase(repo);
  git(repo, ['checkout', 'feature']);
}

// Collaborator pushes `src/c.js` on top of the approved head, a local commit
// adds `d.txt`, and the local branch merges the collaborator commit.
function collaboratorMerge(repo, priorHead) {
  git(repo, ['checkout', '-b', 'collaborator', priorHead]);
  commitFile(repo, 'src/c.js', 'module.exports = "collaborator";\n', 'collaborator change');
  git(repo, ['checkout', 'feature']);
  commitFile(repo, 'd.txt', 'local change\n', 'local change');
  git(repo, ['merge', '--no-edit', 'collaborator']);
  return git(repo, ['rev-parse', 'HEAD']);
}

function stackedMerge(repo, priorHead) {
  git(repo, ['checkout', '-b', 'stacked', priorHead]);
  commitFile(repo, 'src/stacked.js', 'module.exports = "stacked";\n', 'stacked change one');
  commitFile(repo, 'docs/stacked.md', 'stacked docs\n', 'stacked change two');
  git(repo, ['checkout', 'feature']);
  commitFile(repo, 'notes/local.md', 'local notes\n', 'local notes');
  git(repo, ['merge', '--no-edit', 'stacked']);
  return git(repo, ['rev-parse', 'HEAD']);
}

function baseMerge(repo, path, content) {
  advanceBase(repo, path, content);
  git(repo, ['merge', '--no-edit', 'main']);
  return git(repo, ['rev-parse', 'HEAD']);
}

function writeApprovedPriorLane(repo, priorHead) {
  const dir = join(repo, '.qube', 'aie', 'reviews', String(ISSUE), String(PR), priorHead);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'code-quality.json'), JSON.stringify({
    version: 1,
    lane: 'code-quality',
    status: 'passed',
    recommendation: 'approve',
    adapter: 'local-host',
    headSha: priorHead,
    runnerProvenance: { taskId: 'prior-review-task' },
    promptStack: PROMPT_STACK,
    recordedAt: '2026-01-01T00:00:00.000Z',
  }));
}

function carryForwardInput(repo, headSha) {
  return {
    repoRoot: repo,
    baseRef: BASE_REF,
    issueNumber: ISSUE,
    prNumber: PR,
    headSha,
    lane: 'code-quality',
    matchPatterns: ['src/**'],
    contextPatterns: [],
    contextMode: 'scope',
    expectedFragmentDigest: FRAGMENT_DIGEST,
    expectedAdapter: 'local-host',
    requiredCommand: null,
  };
}

function scopedCodeQualityConfig() {
  const config = localHostConfig(null);
  config.reviewLanes = [
    { id: 'code-quality', required: 'always', match: ['src/**'], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host', carryForwardContext: 'scope' },
  ];
  return config;
}

function writeCarriedPublishEvidence(repo, priorHead, currentHead) {
  const evidence = localEvidence({ headSha: priorHead });
  evidence.lanes = evidence.lanes.filter(lane => lane.id === 'code-quality').map(lane => ({
    ...lane,
    contextReviewed: [
      { kind: 'agents', source: 'AGENTS.md', trust: 'policy', freshness: 'current' },
      { kind: 'diff', source: 'git diff origin/main...HEAD', trust: 'local-evidence', freshness: 'current' },
    ],
    toolsUsed: ['codex'],
  }));
  writeLocalEvidence(repo, evidence);
  const priorPath = join(repo, '.qube', 'aie', 'reviews', String(ISSUE), String(PR), priorHead, 'code-quality.json');
  const priorLane = JSON.parse(readFileSync(priorPath, 'utf8'));
  const currentDir = join(repo, '.qube', 'aie', 'reviews', String(ISSUE), String(PR), currentHead);
  mkdirSync(currentDir, { recursive: true });
  writeFileSync(join(currentDir, 'code-quality.json'), `${JSON.stringify({
    ...priorLane,
    headSha: currentHead,
    carriedForward: { fromHeadSha: priorHead, deltaSummary: 'out of lane scope' },
  }, null, 2)}\n`);
}

function publishCarried(repo, config, currentHead) {
  const { exec } = makePrExec({ prViews: [cleanLocalPr({ headRefOid: currentHead })] });
  return runPrReviewPublishService(config, {
    prNumber: PR,
    issueNumber: ISSUE,
    headSha: currentHead,
    lane: 'code-quality',
    dryRun: true,
    repoRoot: repo,
    exec,
    changedPaths: [],
    carryForwardScope: carryForwardScopeFromConfig(config),
  });
}

describe('pull request delta across merges and rebases', () => {
  it('keeps collaborator commits that a merge brings in and refuses carry-forward for their lane', async () => {
    const { repo, priorHead } = makePullRequestRepo();
    const head = collaboratorMerge(repo, priorHead);

    assert.deepEqual(gitDeltaPathsSync(repo, BASE_REF, priorHead, head), ['d.txt', 'src/c.js']);

    writeApprovedPriorLane(repo, priorHead);
    assert.equal(await findCarryForwardSource(carryForwardInput(repo, head)), null);
    const decision = await evaluateCarryForwardDecision(carryForwardInput(repo, head));
    assert.equal(decision.source, null);
    assert.equal(decision.priorApproved, true);
    assert.deepEqual(decision.deltaPaths, ['d.txt', 'src/c.js']);

    // The same prior evidence does carry forward to a head whose delta stays
    // outside the lane scope, so the refusal above comes from the delta.
    git(repo, ['checkout', '-b', 'control', priorHead]);
    const outOfScope = commitFile(repo, 'notes/control.md', 'control\n', 'out of scope');
    const allowed = await findCarryForwardSource(carryForwardInput(repo, outOfScope));
    assert.equal(allowed?.fromHeadSha, priorHead);
  });

  it('rejects the publish-time carry-forward check when a merged collaborator commit touches the lane scope', async () => {
    const { repo, priorHead } = makePullRequestRepo();
    const head = collaboratorMerge(repo, priorHead);
    const config = scopedCodeQualityConfig();
    writeCarriedPublishEvidence(repo, priorHead, head);

    await assert.rejects(() => publishCarried(repo, config, head), /head delta touches the code-quality lane scope or review context/);
  });

  it('keeps a merged stacked branch in the delta and refuses carry-forward for lanes that match it', async () => {
    const { repo, priorHead } = makePullRequestRepo();
    const head = stackedMerge(repo, priorHead);

    assert.deepEqual(gitDeltaPathsSync(repo, BASE_REF, priorHead, head), ['docs/stacked.md', 'notes/local.md', 'src/stacked.js']);
    writeApprovedPriorLane(repo, priorHead);
    assert.equal(await findCarryForwardSource(carryForwardInput(repo, head)), null);
    const docsLane = await findCarryForwardSource({ ...carryForwardInput(repo, head), matchPatterns: ['docs/**'] });
    assert.equal(docsLane, null);
    const unrelatedLane = await findCarryForwardSource({ ...carryForwardInput(repo, head), matchPatterns: ['lib/**'] });
    assert.equal(unrelatedLane?.fromHeadSha, priorHead);
  });

  it('gives an empty delta for a clean base merge and allows carry-forward', async () => {
    const { repo, priorHead } = makePullRequestRepo();
    const head = baseMerge(repo, 'src/base.js', 'module.exports = "another pull request";\n');

    assert.deepEqual(gitDeltaPathsSync(repo, BASE_REF, priorHead, head), []);
    writeApprovedPriorLane(repo, priorHead);
    const source = await findCarryForwardSource(carryForwardInput(repo, head));
    assert.equal(source?.fromHeadSha, priorHead);
    assert.match(source.deltaSummary, /no files changed/);
    const decision = await evaluateCarryForwardDecision(carryForwardInput(repo, head));
    assert.equal(decision.source?.fromHeadSha, priorHead);

    const config = scopedCodeQualityConfig();
    writeCarriedPublishEvidence(repo, priorHead, head);
    const published = await publishCarried(repo, config, head);
    assert.equal(published.publish.status, 'planned');
  });

  it('leaves base-only files out after a rebase onto a newer base and allows carry-forward', async () => {
    const { repo, priorHead } = makePullRequestRepo();
    advanceBase(repo, 'src/base.js', 'module.exports = "another pull request";\n');
    git(repo, ['rebase', 'main']);
    const head = git(repo, ['rev-parse', 'HEAD']);

    assert.notEqual(head, priorHead);
    assert.deepEqual(gitDeltaPathsSync(repo, BASE_REF, priorHead, head), []);
    writeApprovedPriorLane(repo, priorHead);
    const source = await findCarryForwardSource(carryForwardInput(repo, head));
    assert.equal(source?.fromHeadSha, priorHead);
  });

  it('reports only the pull request file it changed after a rebase', async () => {
    const { repo, priorHead } = makePullRequestRepo();
    advanceBase(repo, 'src/base.js', 'module.exports = "another pull request";\n');
    advanceBase(repo, 'notes/base.md', 'base notes v2\n');
    git(repo, ['rebase', 'main']);
    const head = commitFile(repo, 'src/a.js', 'module.exports = "pull request v2";\n', 'pull request update');

    assert.deepEqual(gitDeltaPathsSync(repo, BASE_REF, priorHead, head), ['src/a.js']);
    writeApprovedPriorLane(repo, priorHead);
    assert.equal(await findCarryForwardSource(carryForwardInput(repo, head)), null);
  });

  it('refuses carry-forward when the base ref cannot be observed', async () => {
    const { repo, priorHead } = makePullRequestRepo();
    const head = baseMerge(repo, 'notes/base.md', 'base notes v2\n');
    writeApprovedPriorLane(repo, priorHead);

    const input = { ...carryForwardInput(repo, head), baseRef: 'origin/no-such-branch' };
    assert.equal(gitDeltaPathsSync(repo, input.baseRef, priorHead, head), null);
    assert.equal(await findCarryForwardSource(input), null);
    const decision = await evaluateCarryForwardDecision(input);
    assert.equal(decision.source, null);
    assert.equal(decision.deltaComputed, false);
  });
});

describe('criterion proof across base merges', () => {
  const inputs = [{ kind: 'test', path: 'spec/input.txt', sha256: 'b'.repeat(64) }];

  it('asks for a new proof when a base merge changed a required input', () => {
    const { repo, priorHead } = makePullRequestRepo();
    const head = baseMerge(repo, 'spec/input.txt', 'input v2\n');

    assert.deepEqual(gitDeltaPathsSync(repo, BASE_REF, priorHead, head), []);
    const errors = validateCriterionRevision({ kind: 'pr', headSha: priorHead }, repo, head, head, inputs);
    assert.deepEqual(errors, [`Required input spec/input.txt changed since proof revision ${priorHead}; capture current proof.`]);
  });

  it('carries the proof forward when a base merge does not touch any required input', () => {
    const { repo, priorHead } = makePullRequestRepo();
    const head = baseMerge(repo, 'notes/base.md', 'base notes v2\n');

    assert.deepEqual(validateCriterionRevision({ kind: 'pr', headSha: priorHead }, repo, head, head, inputs), []);
  });
});
