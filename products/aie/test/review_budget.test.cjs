'use strict';

const { describe, it } = require('node:test');
const { mkdirSync, readdirSync } = require('node:fs');
const {
  assert,
  execFileSync,
  existsSync,
  join,
  readFileSync,
  writeFileSync,
  makeGitRepo,
  applyRoutedReviewFixture,
  localHostConfig,
  makePrExec,
  cleanLocalPr,
  readyRouteProbe,
  requiredTaskContext,
  runPrGate,
} = require('./support/pr_gate_fixture.cjs');
const { calculateReviewBudget, readReviewBudget } = require('../dist/app/review_budget.js');
const { MAX_TURNS_ERROR, isolatedRawOutputPath } = require('../dist/app/model_review_runner.js');
const { computePrGateNextAction, notInspectedNextAction } = require('../dist/app/pr_gate_next_action.js');
const { readRouteFaults } = require('../dist/app/local_review_runner_support.js');
const { trustedLocalHostProvenancePath } = require('../dist/local_review_evidence.js');
const { resolveTrustedLocalStore } = require('../dist/trusted_local_store.js');

const DIFF_PATH_PATTERN = /-> (\.qube\/aie\/review-input\/\S+\.diff)/g;
const LISTED_FILE_PATTERN = /^- (\S+) \(\+\d+ -\d+\) -> /gm;
const SPLIT_TEXT = /split the pull request|split it|make the change smaller|smaller pull request/i;
const MINIMUM = { maxTurns: 16, timeoutSeconds: 900 };

function noShellConfig() {
  const config = localHostConfig(null);
  config.reviewAdapter = 'mixed';
  config.reviewAgents = [];
  config.reviewWaitMinutes = 0;
  config.reviewRoute = { host: 'grok-build', tier: 'review', ...MINIMUM };
  config.reviewModels.review['grok-build'] = { model: 'grok-4.5', effort: null };
  return config;
}

function commitFiles(repo, files, message) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo, ...path.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(repo, ...path.split('/')), content);
    execFileSync('git', ['add', path], { cwd: repo, stdio: 'ignore' });
  }
  execFileSync('git', ['commit', '-m', message], { cwd: repo, stdio: 'ignore' });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
}

function sourceFiles(count) {
  const files = {};
  for (let index = 0; index < count; index += 1) {
    files[`src/file${String(index).padStart(2, '0')}.ts`] = `export const value${index} = ${index};\nexport const double${index} = ${index * 2};\n`;
  }
  return files;
}

function routedRepo() {
  const repo = makeGitRepo();
  applyRoutedReviewFixture(repo);
  return repo;
}

/** A routed repository whose full diff holds `total` changed files: the routed config file and `total - 1` source files. */
function repoWithFiles(total) {
  const repo = routedRepo();
  const headSha = commitFiles(repo, sourceFiles(total - 1), `add ${total - 1} files`);
  return { repo, headSha };
}

function promptOf(invocation) {
  return invocation.promptPath ? readFileSync(invocation.promptPath, 'utf8') : invocation.stdin;
}

function laneOf(prompt) {
  return prompt.match(/Run local review lane ([a-z-]+)\./)?.[1];
}

function coverageOf(prompt, status) {
  const lane = laneOf(prompt);
  return ((prompt.match(/Attest coverage for exactly these areas: ([^\n]+?)\. Each coverage entry/) || [])[1] || lane).split(', ').map(area => ({ area, status }));
}

function laneBody(prompt, headSha, overrides = {}) {
  const lane = laneOf(prompt);
  const diffFiles = [...prompt.matchAll(DIFF_PATH_PATTERN)].map(match => match[1]);
  return {
    issueNumber: 93,
    prNumber: 12,
    headSha,
    lane,
    status: 'passed',
    severity: 'none',
    recommendation: 'approve',
    summary: `${lane} routed review passed.`,
    blockers: [],
    findings: [],
    artifacts: diffFiles.map(path => ({ kind: 'diff', path, sha256: null })),
    commands: [],
    surfaces: diffFiles,
    contextReviewed: requiredTaskContext(),
    toolsUsed: ['Read'],
    completeness: `Inspected the complete ${lane} scope at the current head.`,
    coverage: coverageOf(prompt, 'clear'),
    preconditions: [],
    ...overrides,
  };
}

function grokOutput(body) {
  return { exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: JSON.stringify(body), sessionId: `session-${body.lane}-${Math.random()}` }) };
}

function codexOutput(body, toolCalls) {
  const lines = [JSON.stringify({ type: 'thread.started', thread_id: `codex-${body.lane}` })];
  for (let index = 0; index < toolCalls; index += 1) {
    lines.push(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', exit_code: 0, aggregated_output: 'ok' } }));
  }
  lines.push(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(body) } }));
  return { exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: lines.join('\n') };
}

function evidenceOf(repo, headSha, lane) {
  return JSON.parse(readFileSync(join(repo, '.qube', 'aie', 'reviews', '93', '12', headSha, `${lane}.json`), 'utf8'));
}

function routedLanes(result) {
  return result.localReviewRunner.lanes.filter(lane => lane.route !== null);
}

describe('review turn budget follows the review input', () => {
  it('grows the turn budget and the timeout with files and lines and keeps the configured values as the minimum', () => {
    const large = calculateReviewBudget(MINIMUM, { files: 62, changedLines: 4000, coverageAreas: 1 });
    const small = calculateReviewBudget(MINIMUM, { files: 2, changedLines: 40, coverageAreas: 1 });
    assert.ok(large.maxTurns > small.maxTurns, JSON.stringify({ large, small }));
    assert.ok(large.timeoutSeconds > small.timeoutSeconds, JSON.stringify({ large, small }));
    assert.ok(large.maxTurns > 20, 'there is no fixed upper cap of 20 turns');
    assert.ok(large.timeoutSeconds > 1200);
    assert.deepEqual(small, { maxTurns: 16, timeoutSeconds: 900, files: 2, changedLines: 40, coverageAreas: 1, minimumTurns: 16, minimumTimeoutSeconds: 900 });
    const moreAreas = calculateReviewBudget({ maxTurns: 4, timeoutSeconds: 30 }, { files: 2, changedLines: 40, coverageAreas: 3 });
    const oneArea = calculateReviewBudget({ maxTurns: 4, timeoutSeconds: 30 }, { files: 2, changedLines: 40, coverageAreas: 1 });
    assert.ok(moreAreas.maxTurns > oneArea.maxTurns, 'coverage areas add turns');
    const unknownLines = calculateReviewBudget(MINIMUM, { files: 62, changedLines: null, coverageAreas: 1 });
    assert.equal(unknownLines.changedLines, null);
    assert.ok(unknownLines.maxTurns > small.maxTurns, 'the file count still sizes the budget when git cannot count lines');
    assert.deepEqual(readReviewBudget(large), large);
    assert.equal(readReviewBudget({ ...large, maxTurns: -1 }), null);
    assert.equal(readReviewBudget({ ...large, changedLines: 'many' }), null);
  });

  it('records a larger planned budget for 62 changed files than for 2 in the lane plan and in provenance', async () => {
    const sizes = {};
    for (const count of [62, 2]) {
      const { repo, headSha } = repoWithFiles(count);
      const config = noShellConfig();
      const planned = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec: makePrExec({ prViews: [cleanLocalPr({ headRefOid: headSha })] }).exec, routeProbe: readyRouteProbe, resolveModelHost: async () => 'grok.exe' });
      const plannedLane = routedLanes(planned).find(lane => lane.lane === 'code-quality');
      assert.ok(plannedLane?.budget, JSON.stringify(routedLanes(planned).map(lane => lane.lane)));
      const prompts = [];
      const result = await runPrGate(config, {
        prNumber: 12, repoRoot: repo, exec: makePrExec({ prViews: [cleanLocalPr({ headRefOid: headSha })] }).exec, routeProbe: readyRouteProbe, resolveModelHost: async () => 'grok.exe',
        modelRouteProcess: async invocation => {
          const prompt = promptOf(invocation);
          prompts.push({ prompt, timeoutMs: invocation.timeoutMs, maxTurns: invocation.args[invocation.args.indexOf('--max-turns') + 1] });
          return grokOutput(laneBody(prompt, headSha));
        },
      });
      const completed = routedLanes(result).find(lane => lane.lane === 'code-quality');
      assert.equal(completed.status, 'completed', completed.summary);
      const evidence = evidenceOf(repo, headSha, 'code-quality');
      assert.deepEqual(evidence.runnerProvenance.budget, plannedLane.budget, 'the evidence records the planned budget');
      assert.deepEqual(completed.budget, plannedLane.budget);
      const trustedPath = trustedLocalHostProvenancePath(resolveTrustedLocalStore(repo), 93, 12, headSha, 'code-quality');
      assert.deepEqual(JSON.parse(readFileSync(trustedPath, 'utf8')).budget, plannedLane.budget, 'the trusted provenance records the budget');
      const run = prompts.find(entry => laneOf(entry.prompt) === 'code-quality');
      assert.equal(run.maxTurns, String(plannedLane.budget.maxTurns), 'the host gets the calculated turn budget');
      assert.equal(run.timeoutMs, plannedLane.budget.timeoutSeconds * 1000, 'the process timeout follows the same budget');
      assert.match(run.prompt, new RegExp(`Your budget for this review input is ${plannedLane.budget.maxTurns} turns and ${plannedLane.budget.timeoutSeconds} seconds, calculated from ${count} changed files`));
      assert.doesNotMatch(run.prompt, /ran out of capacity|within your turn limit|at most \d+ turns/i);
      assert.doesNotMatch(run.prompt, SPLIT_TEXT);
      assert.equal(result.localReview.status, 'passed', result.localReview.summary);
      sizes[count] = plannedLane.budget;
    }
    assert.equal(sizes[62].files, 62);
    assert.equal(sizes[2].files, 2);
    assert.ok(sizes[62].maxTurns > sizes[2].maxTurns, JSON.stringify(sizes));
    assert.ok(sizes[62].timeoutSeconds > sizes[2].timeoutSeconds, JSON.stringify(sizes));
    assert.equal(sizes[2].maxTurns, MINIMUM.maxTurns, 'a small input keeps the configured minimum');
  });

  it('rejects a provenance budget that does not match the trusted record', async () => {
    const { repo, headSha } = repoWithFiles(3);
    const config = noShellConfig();
    await runPrGate(config, {
      prNumber: 12, repoRoot: repo, exec: makePrExec({ prViews: [cleanLocalPr({ headRefOid: headSha })] }).exec, routeProbe: readyRouteProbe, resolveModelHost: async () => 'grok.exe',
      modelRouteProcess: async invocation => grokOutput(laneBody(promptOf(invocation), headSha)),
    });
    const path = join(repo, '.qube', 'aie', 'reviews', '93', '12', headSha, 'code-quality.json');
    const evidence = JSON.parse(readFileSync(path, 'utf8'));
    evidence.runnerProvenance.budget.maxTurns += 100;
    writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
    const gate = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec: makePrExec({ prViews: [cleanLocalPr({ headRefOid: headSha })] }).exec, routeProbe: readyRouteProbe, resolveModelHost: async () => 'grok.exe' });
    assert.notEqual(gate.localReview.status, 'passed');
    assert.match(JSON.stringify(gate.localReview), /routed model provenance does not match the trusted host record/);
  });

  it('sizes a delta round from the delta files only', async () => {
    const repo = routedRepo();
    const approvedHead = commitFiles(repo, sourceFiles(29), 'add 29 files');
    const config = noShellConfig();
    const firstRound = await runPrGate(config, {
      prNumber: 12, repoRoot: repo, exec: makePrExec({ prViews: [cleanLocalPr({ headRefOid: approvedHead })] }).exec, routeProbe: readyRouteProbe, resolveModelHost: async () => 'grok.exe',
      modelRouteProcess: async invocation => grokOutput(laneBody(promptOf(invocation), approvedHead)),
    });
    for (const lane of routedLanes(firstRound)) assert.equal(lane.budget.files, 30, `${lane.lane}: the full first round counts every changed file`);
    const headSha = commitFiles(repo, { 'src/file00.ts': 'export const value0 = 0;\nexport const fixed = true;\n' }, 'fix one file');
    const result = await runPrGate(config, {
      prNumber: 12, repoRoot: repo, exec: makePrExec({ prViews: [cleanLocalPr({ headRefOid: headSha })] }).exec, routeProbe: readyRouteProbe, resolveModelHost: async () => 'grok.exe',
      modelRouteProcess: async invocation => grokOutput(laneBody(promptOf(invocation), headSha)),
    });
    const completed = routedLanes(result).filter(lane => lane.status === 'completed' && lane.evidenceSource === 'fresh-run');
    const scopes = completed.map(lane => ({ lane, evidence: evidenceOf(repo, headSha, lane.lane) }));
    const delta = scopes.filter(entry => entry.evidence.reviewScope === 'delta');
    const full = scopes.filter(entry => entry.evidence.reviewScope === 'full');
    assert.ok(delta.length >= 1, JSON.stringify(scopes.map(entry => ({ lane: entry.lane.lane, scope: entry.evidence.reviewScope }))));
    for (const { lane, evidence } of delta) {
      assert.equal(lane.budget.files, 1, `${lane.lane}: the delta budget counts only the file changed since the approved head`);
      assert.equal(lane.budget.changedLines, 2, 'one line replaced: one added and one removed');
      assert.equal(evidence.runnerProvenance.budget.files, 1);
    }
    for (const { lane } of full) assert.equal(lane.budget.files, 30, `${lane.lane}: a full round in the same gate counts every changed file`);
  });
});

describe('capacity stops continue the lane or fail over', () => {
  it('continues a lane over only the files a run did not read, merges findings, and passes without a route fault', async () => {
    const { repo, headSha } = repoWithFiles(6);
    const config = noShellConfig();
    const runsByLane = new Map();
    const result = await runPrGate(config, {
      prNumber: 12, repoRoot: repo, exec: makePrExec({ prViews: [cleanLocalPr({ headRefOid: headSha })] }).exec, routeProbe: readyRouteProbe, resolveModelHost: async () => 'grok.exe',
      modelRouteProcess: async invocation => {
        const prompt = promptOf(invocation);
        const lane = laneOf(prompt);
        const runs = runsByLane.get(lane) ?? [];
        runsByLane.set(lane, runs);
        const listed = [...prompt.matchAll(LISTED_FILE_PATTERN)].map(match => match[1]);
        const diffFiles = [...prompt.matchAll(DIFF_PATH_PATTERN)].map(match => match[1]);
        runs.push({ listed, prompt, maxTurns: invocation.args[invocation.args.indexOf('--max-turns') + 1] });
        if (runs.length === 1) {
          // Read half of the files and attest the rest as not inspected.
          const read = diffFiles.slice(0, 3);
          return grokOutput(laneBody(prompt, headSha, {
            status: 'inconclusive', recommendation: 'inconclusive',
            summary: 'Read three files; the remaining files were not inspected for capacity.',
            completeness: 'Partial review for capacity.',
            surfaces: read,
            artifacts: read.map(path => ({ kind: 'diff', path, sha256: null })),
            findings: [{ id: `${lane}-first`, severity: 'advisory', message: 'First part advisory.', location: { path: 'src/file00.ts', line: 1, endLine: 1, side: 'destination' } }],
            coverage: coverageOf(prompt, 'not-inspected'),
          }));
        }
        return grokOutput(laneBody(prompt, headSha, {
          findings: [{ id: `${lane}-second`, severity: 'advisory', message: 'Continuation advisory.', location: { path: 'src/file04.ts', line: 1, endLine: 1, side: 'destination' } }],
          coverage: coverageOf(prompt, 'finding'),
        }));
      },
    });

    const lanes = routedLanes(result);
    assert.ok(lanes.length >= 2);
    for (const lane of lanes) {
      assert.equal(lane.status, 'completed', lane.summary);
      const runs = runsByLane.get(lane.lane);
      assert.equal(runs.length, 2, `${lane.lane} runs once and continues once`);
      assert.equal(runs[0].listed.length, 6);
      assert.deepEqual(runs[1].listed, ['src/file02.ts', 'src/file03.ts', 'src/file04.ts'], 'the continuation lists only the unread files');
      assert.match(runs[1].prompt, /Continuation run: an earlier run of this lane at this head read 3 other changed file\(s\) in scope/);
      assert.match(runs[1].prompt, /calculated from 3 changed files/, 'the continuation budget follows its own files');
      const evidence = evidenceOf(repo, headSha, lane.lane);
      assert.equal(evidence.status, 'passed', evidence.summary);
      assert.deepEqual(evidence.notInspected, []);
      assert.deepEqual(evidence.findings.map(finding => finding.id).sort(), [`${lane.lane}-first`, `${lane.lane}-second`].sort(), 'findings of both runs are kept');
      assert.equal(evidence.surfaces.length, 6, 'the verdict covers every file');
      assert.match(evidence.summary, /covers the 6 of 6 changed files in scope/);
      assert.equal(evidence.runnerProvenance.budget.files, 6, 'the lane provenance keeps the full-scope budget');
      const store = resolveTrustedLocalStore(repo);
      assert.ok(existsSync(isolatedRawOutputPath(store, 93, 12, headSha, lane.lane)), 'the first run keeps its raw output');
      assert.ok(existsSync(isolatedRawOutputPath(store, 93, 12, headSha, lane.lane, 1)), 'the continuation keeps its own raw output');
    }
    assert.deepEqual(readRouteFaults(repo, 93, 12).lanes, {}, 'a continuation leaves the rerun counter unchanged');
    assert.equal(result.localReview.status, 'passed', result.localReview.summary);
    assert.doesNotMatch(result.shipReady.nextAction, /lane rerun/);
  });

  it('keeps a blocking finding from the first part when the continuation passes', async () => {
    const { repo, headSha } = repoWithFiles(4);
    const config = noShellConfig();
    const runs = new Map();
    await runPrGate(config, {
      prNumber: 12, repoRoot: repo, exec: makePrExec({ prViews: [cleanLocalPr({ headRefOid: headSha })] }).exec, routeProbe: readyRouteProbe, resolveModelHost: async () => 'grok.exe',
      modelRouteProcess: async invocation => {
        const prompt = promptOf(invocation);
        const lane = laneOf(prompt);
        runs.set(lane, (runs.get(lane) ?? 0) + 1);
        const diffFiles = [...prompt.matchAll(DIFF_PATH_PATTERN)].map(match => match[1]);
        if (runs.get(lane) === 1) {
          return grokOutput(laneBody(prompt, headSha, {
            status: 'failed', recommendation: 'request-changes', severity: 'high',
            blockers: ['src/file00.ts drops the value.'],
            findings: [{ id: 'blocker', severity: 'blocking', message: 'Drops the value.', location: { path: 'src/file00.ts', line: 1, endLine: 1, side: 'destination' } }],
            surfaces: diffFiles.slice(0, 2),
            artifacts: diffFiles.slice(0, 2).map(path => ({ kind: 'diff', path, sha256: null })),
            coverage: coverageOf(prompt, 'finding'),
          }));
        }
        return grokOutput(laneBody(prompt, headSha));
      },
    });
    const evidence = evidenceOf(repo, headSha, 'code-quality');
    assert.equal(runs.get('code-quality'), 2);
    assert.equal(evidence.status, 'failed');
    assert.equal(evidence.recommendation, 'request-changes');
    assert.deepEqual(evidence.blockers, ['src/file00.ts drops the value.']);
    assert.deepEqual(evidence.notInspected, []);
  });

  it('fails over to the second host in the same gate run when a host makes zero tool calls and stops for capacity', async () => {
    const { repo, headSha } = repoWithFiles(5);
    const config = noShellConfig();
    config.reviewRoute = { host: 'codex', tier: 'review', ...MINIMUM };
    config.reviewModels.review.codex = { model: 'gpt-5.6-luna', effort: 'medium' };
    config.reviewFailover = { faults: 2, route: { host: 'grok-build', tier: 'review', ...MINIMUM } };
    const primaryRuns = [];
    const fallbackRuns = [];
    const result = await runPrGate(config, {
      prNumber: 12, repoRoot: repo, exec: makePrExec({ prViews: [cleanLocalPr({ headRefOid: headSha })] }).exec, routeProbe: readyRouteProbe, resolveModelHost: async host => (host === 'codex' ? 'codex.exe' : 'grok.exe'),
      modelRouteProcess: async invocation => {
        const prompt = promptOf(invocation);
        if (invocation.schemaPath) {
          primaryRuns.push(laneOf(prompt));
          return codexOutput(laneBody(prompt, headSha, {
            status: 'inconclusive', recommendation: 'inconclusive',
            summary: 'The changed files cannot be read within the turn budget.',
            completeness: 'Not inspected for capacity.',
            artifacts: [], surfaces: [], toolsUsed: [],
            coverage: coverageOf(prompt, 'not-inspected'),
          }), 0);
        }
        fallbackRuns.push(laneOf(prompt));
        return grokOutput(laneBody(prompt, headSha));
      },
    });
    const lanes = routedLanes(result);
    assert.ok(primaryRuns.length >= 2);
    assert.deepEqual([...fallbackRuns].sort(), [...primaryRuns].sort(), 'every capacity-stopped lane reruns on the second host in the same run');
    for (const lane of lanes) {
      assert.equal(lane.status, 'completed', lane.summary);
      assert.equal(lane.route.host, 'grok-build');
      assert.match(String(lane.route.substitution), /model-route-capacity-stop/);
      const evidence = evidenceOf(repo, headSha, lane.lane);
      assert.equal(evidence.status, 'passed');
      assert.equal(evidence.runnerProvenance.route.reason.code, 'model-route-capacity-stop');
      assert.equal(evidence.runnerProvenance.route.executed.host, 'grok-build');
    }
  });

  it('fails the lane as a host fault when a route without shell reads no file for capacity and no second host is configured', async () => {
    const { repo, headSha } = repoWithFiles(4);
    const config = noShellConfig();
    let runs = 0;
    const result = await runPrGate(config, {
      prNumber: 12, repoRoot: repo, exec: makePrExec({ prViews: [cleanLocalPr({ headRefOid: headSha })] }).exec, routeProbe: readyRouteProbe, resolveModelHost: async () => 'grok.exe',
      modelRouteProcess: async invocation => {
        runs += 1;
        const prompt = promptOf(invocation);
        return grokOutput(laneBody(prompt, headSha, {
          status: 'inconclusive', recommendation: 'inconclusive',
          summary: 'The changed files cannot be read within the turn budget.',
          completeness: 'Not inspected for capacity.',
          artifacts: [], surfaces: [], toolsUsed: [],
          coverage: coverageOf(prompt, 'not-inspected'),
        }));
      },
    });
    const lanes = routedLanes(result);
    assert.equal(runs, lanes.length, 'a run that read nothing is not continued');
    for (const lane of lanes) {
      assert.equal(lane.status, 'failed');
      assert.equal(lane.blocker, 'model-route-capacity-stop');
      assert.match(lane.summary, /host fault/);
      assert.doesNotMatch(lane.summary, SPLIT_TEXT);
    }
    assert.equal(readRouteFaults(repo, 93, 12).lanes['code-quality'].lastReasonCode, 'model-route-capacity-stop');
    assert.doesNotMatch(result.shipReady.nextAction, SPLIT_TEXT);
  });

  it('keeps a lane that reads every file and returns inconclusive for another reason inconclusive, with no continuation', async () => {
    const { repo, headSha } = repoWithFiles(4);
    const config = noShellConfig();
    const runs = new Map();
    const result = await runPrGate(config, {
      prNumber: 12, repoRoot: repo, exec: makePrExec({ prViews: [cleanLocalPr({ headRefOid: headSha })] }).exec, routeProbe: readyRouteProbe, resolveModelHost: async () => 'grok.exe',
      modelRouteProcess: async invocation => {
        const prompt = promptOf(invocation);
        const lane = laneOf(prompt);
        runs.set(lane, (runs.get(lane) ?? 0) + 1);
        return grokOutput(laneBody(prompt, headSha, {
          status: 'inconclusive', recommendation: 'inconclusive',
          summary: 'Read every changed file; the CI result needed to judge the change is missing.',
          completeness: 'Every file was read; CI evidence is missing.',
          coverage: coverageOf(prompt, 'not-inspected'),
        }));
      },
    });
    for (const lane of routedLanes(result)) {
      assert.equal(runs.get(lane.lane), 1, `${lane.lane} is not continued`);
      const evidence = evidenceOf(repo, headSha, lane.lane);
      assert.equal(evidence.status, 'inconclusive');
      assert.deepEqual(evidence.notInspected, []);
    }
    assert.equal(result.localReview.status, 'inconclusive');
    assert.match(result.shipReady.nextAction, /^Run `aie pr lane rerun 12 [a-z-]+` once/, 'the lane counts against the rerun limit as before');
    assert.deepEqual(readRouteFaults(repo, 93, 12).lanes, {});
  });
});

describe('no gate text tells the author to split the pull request', () => {
  it('keeps split and smaller-change text out of the max-turns error and every next action', async () => {
    assert.doesNotMatch(MAX_TURNS_ERROR, SPLIT_TEXT);
    assert.match(MAX_TURNS_ERROR, /model-route-max-turns/);
    const state = { shipReady: false, twoRoundMergeMet: false, hostRequestRecorded: false, prNumber: 12, fallback: 'fallback' };
    for (const action of [
      computePrGateNextAction({ ...state, inconclusiveLanes: [], notInspectedFiles: ['src/a.ts'] }),
      computePrGateNextAction({ ...state, inconclusiveLanes: [], rerunLanes: ['code-quality'] }),
      computePrGateNextAction({ ...state, inconclusiveLanes: ['code-quality'] }),
      notInspectedNextAction(0, ['src/a.ts']),
    ]) {
      assert.doesNotMatch(action, SPLIT_TEXT, action);
    }

    // The local review gate path: a lane that leaves a file unread after the
    // gate continued it as far as it could.
    const { repo, headSha } = repoWithFiles(3);
    const result = await runPrGate(noShellConfig(), {
      prNumber: 12, repoRoot: repo, exec: makePrExec({ prViews: [cleanLocalPr({ headRefOid: headSha })] }).exec, routeProbe: readyRouteProbe, resolveModelHost: async () => 'grok.exe',
      modelRouteProcess: async invocation => {
        const prompt = promptOf(invocation);
        const diffFiles = [...prompt.matchAll(DIFF_PATH_PATTERN)].map(match => match[1]);
        // Every run reads only its first file, so the last continuation
        // still leaves files unread when no run makes progress.
        const read = diffFiles.length > 1 ? diffFiles.slice(0, 1) : [];
        return grokOutput(laneBody(prompt, headSha, { surfaces: read, artifacts: read.length > 0 ? read.map(path => ({ kind: 'diff', path, sha256: null })) : [{ kind: 'file', path: 'src/file00.ts', sha256: null }] }));
      },
    });
    assert.equal(result.localReview.status, 'inconclusive');
    for (const action of [result.localReview.nextAction, result.shipReady.nextAction]) {
      assert.doesNotMatch(action, SPLIT_TEXT, action);
      assert.match(action, /Files not inspected: src\/file01\.ts/);
    }
    assert.doesNotMatch(JSON.stringify(result), SPLIT_TEXT);
  });

  it('ships no split or smaller-change wording in the gate source', () => {
    const root = join(__dirname, '..', 'src');
    const stack = [root];
    const offenders = [];
    while (stack.length > 0) {
      const directory = stack.pop();
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) stack.push(path);
        else if (entry.name.endsWith('.ts') && existsSync(path) && SPLIT_TEXT.test(readFileSync(path, 'utf8'))) offenders.push(path);
      }
    }
    assert.deepEqual(offenders, []);
  });
});
