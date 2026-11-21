'use strict';

const { describe, it } = require('node:test');
const { mkdirSync, readdirSync, statSync } = require('node:fs');
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
const { splitPullRequestNextAction } = require('../dist/app/pr_gate_next_action.js');

const DIFF_PATH_PATTERN = /-> (\.qube\/aie\/review-input\/\S+\.diff)/g;

function reviewInputRoot(repo) {
  return join(repo, '.qube', 'aie', 'review-input');
}

function reviewInputFolders(repo) {
  return existsSync(reviewInputRoot(repo)) ? readdirSync(reviewInputRoot(repo)) : [];
}

function noShellConfig() {
  const config = localHostConfig(null);
  config.reviewAdapter = 'mixed';
  config.reviewAgents = [];
  config.reviewWaitMinutes = 0;
  config.reviewRoute = { host: 'grok-build', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
  config.reviewModels.review['grok-build'] = { model: 'grok-4.5', effort: null };
  return config;
}

function routedRepo() {
  const repo = makeGitRepo();
  applyRoutedReviewFixture(repo);
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  return { repo, headSha };
}

function passingLane(prompt, headSha) {
  const lane = prompt.match(/Run local review lane ([a-z-]+)\./)?.[1];
  const diffFiles = [...prompt.matchAll(DIFF_PATH_PATTERN)].map(match => match[1]);
  const body = {
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
    coverage: ((prompt.match(/Attest coverage for exactly these areas: ([^\n]+?)\. Each coverage entry/) || [])[1] || lane).split(', ').map(area => ({ area, status: 'clear' })),
    preconditions: [],
  };
  return { exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: JSON.stringify(body), sessionId: `session-${lane}` }) };
}

/** Holds each lane until `size` lanes run at once, or a bounded wait ends. */
function concurrencyBarrier(size) {
  let active = 0;
  let peak = 0;
  let released = false;
  const waiters = [];
  return {
    get peak() { return peak; },
    async enter() {
      active += 1;
      peak = Math.max(peak, active);
      if (released) return;
      if (active >= size) {
        released = true;
        for (const release of waiters.splice(0)) release();
        return;
      }
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 5000);
        waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    },
    leave() { active -= 1; },
  };
}

describe('gate review input for routes without shell', () => {
  it('prepares the review diff once per gate and shares the same files with concurrent lanes', async () => {
    const { repo, headSha } = routedRepo();
    const config = noShellConfig();
    const fixture = makePrExec({ prViews: [cleanLocalPr({ headRefOid: headSha })] });
    const barrier = concurrencyBarrier(2);
    const laneDiffFiles = [];
    const writeTimes = [];
    const foldersSeen = new Set();
    const modelRouteProcess = async invocation => {
      const prompt = readFileSync(invocation.promptPath, 'utf8');
      await barrier.enter();
      try {
        for (const folder of reviewInputFolders(repo)) foldersSeen.add(folder);
        const diffFiles = [...prompt.matchAll(DIFF_PATH_PATTERN)].map(match => match[1]);
        for (const diffFile of diffFiles) assert.equal(existsSync(join(repo, diffFile)), true, diffFile);
        laneDiffFiles.push(diffFiles);
        writeTimes.push(diffFiles.map(diffFile => statSync(join(repo, diffFile)).mtimeMs));
        return passingLane(prompt, headSha);
      } finally {
        barrier.leave();
      }
    };

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec: fixture.exec, modelRouteProcess, routeProbe: readyRouteProbe, resolveModelHost: async () => 'grok.exe' });

    const routed = result.localReviewRunner.lanes.filter(lane => lane.route !== null);
    assert.ok(routed.length >= 2, 'the gate runs two or more lanes without shell');
    assert.ok(barrier.peak >= 2, 'two lanes without shell ran at the same time');
    assert.ok(routed.every(lane => lane.status === 'completed' && lane.blocker !== 'model-route-checkout-mismatch'), JSON.stringify(routed.map(lane => ({ lane: lane.lane, status: lane.status, blocker: lane.blocker }))));
    assert.equal(laneDiffFiles.length, routed.length);
    assert.ok(laneDiffFiles[0].length > 0, 'lanes receive review input diff files');
    for (const files of laneDiffFiles) assert.deepEqual(files, laneDiffFiles[0], 'every lane gets the same review input files');
    for (const times of writeTimes) assert.deepEqual(times, writeTimes[0], 'no lane rewrites the shared diff files');
    assert.equal(foldersSeen.size, 1, 'the gate writes one review input folder, not one per lane');
    assert.ok(laneDiffFiles[0].every(path => path.startsWith(`.qube/aie/review-input/${[...foldersSeen][0]}/`)));
    assert.deepEqual(reviewInputFolders(repo), [], 'the gate removes the review input folder when it ends');
  });

  it('removes the shared review input folder when lanes fail or their process throws', async () => {
    const { repo, headSha } = routedRepo();
    const config = noShellConfig();
    const fixture = makePrExec({ prViews: [cleanLocalPr({ headRefOid: headSha })] });
    let calls = 0;
    const foldersSeen = new Set();
    const modelRouteProcess = async () => {
      calls += 1;
      for (const folder of reviewInputFolders(repo)) foldersSeen.add(folder);
      if (calls % 2 === 0) throw new Error('host process crashed');
      return { exitCode: 1, stderr: 'host failed', stdout: '', timedOut: false, stdinDelivered: true };
    };

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec: fixture.exec, modelRouteProcess, routeProbe: readyRouteProbe, resolveModelHost: async () => 'grok.exe' });

    const routed = result.localReviewRunner.lanes.filter(lane => lane.route !== null);
    assert.ok(calls >= 2);
    assert.ok(routed.every(lane => lane.status === 'failed'), JSON.stringify(routed.map(lane => lane.status)));
    assert.equal(foldersSeen.size, 1, 'failing lanes still shared one review input folder');
    assert.deepEqual(reviewInputFolders(repo), [], 'the folder is removed although every lane failed');
  });

  it('still fails a lane when a file outside the review input folder appears during the run', async () => {
    const { repo, headSha } = routedRepo();
    const config = noShellConfig();
    const fixture = makePrExec({ prViews: [cleanLocalPr({ headRefOid: headSha })] });
    let wroteStrayFile = false;
    const modelRouteProcess = async invocation => {
      const prompt = readFileSync(invocation.promptPath, 'utf8');
      if (!wroteStrayFile) {
        wroteStrayFile = true;
        writeFileSync(join(repo, 'stray-untracked.txt'), 'written during review\n');
      }
      return passingLane(prompt, headSha);
    };

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec: fixture.exec, modelRouteProcess, routeProbe: readyRouteProbe, resolveModelHost: async () => 'grok.exe' });

    const routed = result.localReviewRunner.lanes.filter(lane => lane.route !== null);
    assert.ok(wroteStrayFile);
    assert.ok(routed.length >= 2);
    assert.ok(routed.every(lane => lane.status === 'failed' && lane.blocker === 'model-route-checkout-mismatch'), JSON.stringify(routed.map(lane => ({ lane: lane.lane, status: lane.status, blocker: lane.blocker }))));
    assert.deepEqual(reviewInputFolders(repo), []);
  });

  it('fails every lane without shell as review input unavailable and starts no host when the diff cannot be computed', async () => {
    const { repo, headSha } = routedRepo();
    const config = noShellConfig();
    config.baseBranch = 'missing-base';
    const fixture = makePrExec({ prViews: [cleanLocalPr({ headRefOid: headSha })] });
    let hostStarts = 0;
    const modelRouteProcess = async () => {
      hostStarts += 1;
      throw new Error('no host may start without review input');
    };

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec: fixture.exec, modelRouteProcess, routeProbe: readyRouteProbe, resolveModelHost: async () => 'grok.exe' });

    const routed = result.localReviewRunner.lanes.filter(lane => lane.route !== null);
    assert.ok(routed.length >= 2);
    assert.equal(hostStarts, 0);
    assert.ok(routed.every(lane => lane.status === 'failed' && lane.blocker === 'model-route-review-input-unavailable'), JSON.stringify(routed.map(lane => ({ lane: lane.lane, status: lane.status, blocker: lane.blocker }))));
    assert.deepEqual(reviewInputFolders(repo), []);
  });

  function commitFiles(repo, files, message) {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(repo, ...path.split('/').slice(0, -1)), { recursive: true });
      writeFileSync(join(repo, ...path.split('/')), content);
      execFileSync('git', ['add', path], { cwd: repo, stdio: 'ignore' });
    }
    execFileSync('git', ['commit', '-m', message], { cwd: repo, stdio: 'ignore' });
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  }

  /** Approve every lane at a first head, then change one of two files for a delta round. */
  async function approvedThenDelta(config) {
    const { repo } = routedRepo();
    const approvedHead = commitFiles(repo, {
      'src/first.ts': 'export const first = 1;\n',
      'src/second.ts': 'export const second = 2;\n',
    }, 'add two files');
    const firstGate = makePrExec({ prViews: [cleanLocalPr({ headRefOid: approvedHead })] });
    const fullPrompts = [];
    await runPrGate(config, {
      prNumber: 12, repoRoot: repo, exec: firstGate.exec, routeProbe: readyRouteProbe, resolveModelHost: async () => 'grok.exe',
      modelRouteProcess: async invocation => {
        const prompt = readFileSync(invocation.promptPath, 'utf8');
        fullPrompts.push(prompt);
        return passingLane(prompt, approvedHead);
      },
    });
    const headSha = commitFiles(repo, { 'src/first.ts': 'export const first = 1;\nexport const fixed = true;\n' }, 'fix first file');
    return { repo, approvedHead, headSha, fullPrompts };
  }

  it('gives a delta round only the files changed since the approved head and keeps a lane that reads them passed', async () => {
    const config = noShellConfig();
    const { repo, approvedHead, headSha, fullPrompts } = await approvedThenDelta(config);
    assert.ok(fullPrompts.length >= 1);
    assert.ok(fullPrompts.every(prompt => /src\/second\.ts/.test(prompt) && /src\/first\.ts/.test(prompt)), 'the full round lists every changed file');
    const fixture = makePrExec({ prViews: [cleanLocalPr({ headRefOid: headSha })] });
    const deltaPrompts = [];
    const diffContents = [];
    const result = await runPrGate(config, {
      prNumber: 12, repoRoot: repo, exec: fixture.exec, routeProbe: readyRouteProbe, resolveModelHost: async () => 'grok.exe',
      modelRouteProcess: async invocation => {
        const prompt = readFileSync(invocation.promptPath, 'utf8');
        deltaPrompts.push(prompt);
        for (const match of prompt.matchAll(DIFF_PATH_PATTERN)) diffContents.push(readFileSync(join(repo, match[1]), 'utf8'));
        return passingLane(prompt, headSha);
      },
    });

    assert.ok(deltaPrompts.length >= 1, 'a lane ran a delta round');
    for (const prompt of deltaPrompts) {
      assert.match(prompt, new RegExp(`Delta re-review since approved head ${approvedHead}`));
      assert.match(prompt, new RegExp(`Review input diff files for the delta since approved head ${approvedHead}`));
      const listed = [...prompt.matchAll(/^- (\S+) \(\+\d+ -\d+\) -> /gm)].map(match => match[1]);
      assert.deepEqual(listed, ['src/first.ts'], 'the delta input holds only the file changed since the approved head');
    }
    for (const content of diffContents) {
      assert.match(content, /^2 \+export const fixed = true;$/m, 'the diff shows the change since the approved head');
      assert.match(content, /^1 {2}export const first = 1;$/m, 'the approved line is context, not an added line');
      assert.doesNotMatch(content, /second/);
    }
    const routed = result.localReviewRunner.lanes.filter(lane => lane.route !== null && lane.status === 'completed');
    assert.equal(routed.length, deltaPrompts.length);
    for (const lane of routed) {
      const evidence = JSON.parse(readFileSync(join(repo, '.qube', 'aie', 'reviews', '93', '12', headSha, `${lane.lane}.json`), 'utf8'));
      assert.equal(evidence.status, 'passed');
      assert.equal(evidence.reviewScope, 'delta');
      assert.deepEqual(evidence.notInspected, []);
    }
    assert.doesNotMatch(JSON.stringify(result), /Split the pull request/);
    assert.deepEqual(reviewInputFolders(repo), []);
  });

  it('makes a delta lane that skips the delta diff file inconclusive and names only that file', async () => {
    const config = noShellConfig();
    const { repo, headSha } = await approvedThenDelta(config);
    const fixture = makePrExec({ prViews: [cleanLocalPr({ headRefOid: headSha })] });
    let runs = 0;
    const result = await runPrGate(config, {
      prNumber: 12, repoRoot: repo, exec: fixture.exec, routeProbe: readyRouteProbe, resolveModelHost: async () => 'grok.exe',
      modelRouteProcess: async invocation => {
        runs += 1;
        const prompt = readFileSync(invocation.promptPath, 'utf8');
        const lane = passingLane(prompt, headSha);
        const body = JSON.parse(JSON.parse(lane.stdout).text);
        body.surfaces = ['src/second.ts'];
        body.artifacts = [{ kind: 'file', path: 'src/second.ts', sha256: null }];
        return { ...lane, stdout: JSON.stringify({ text: JSON.stringify(body), sessionId: `session-${body.lane}` }) };
      },
    });

    assert.ok(runs >= 1);
    const routed = result.localReviewRunner.lanes.filter(lane => lane.route !== null && lane.status === 'completed');
    assert.equal(routed.length, runs);
    for (const lane of routed) {
      const evidence = JSON.parse(readFileSync(join(repo, '.qube', 'aie', 'reviews', '93', '12', headSha, `${lane.lane}.json`), 'utf8'));
      assert.equal(evidence.status, 'inconclusive');
      assert.deepEqual(evidence.notInspected, ['src/first.ts']);
    }
    const splitText = splitPullRequestNextAction(12, ['src/first.ts']);
    assert.equal(splitText, 'Split the pull request into smaller pull requests so every changed file can be inspected. Files not inspected: src/first.ts. Then rerun `aie pr gate 12`.');
    assert.equal(result.localReview.status, 'inconclusive');
    assert.equal(result.localReview.nextAction, splitText, 'the local review gate uses the shared builder');
    assert.equal(result.shipReady.nextAction, splitText, 'aie pr gate uses the same shared builder');
  });

  it('never reads Not inspected prose from lane text as files in either gate path', async () => {
    const { repo, headSha } = routedRepo();
    const config = noShellConfig();
    const fixture = makePrExec({ prViews: [cleanLocalPr({ headRefOid: headSha })] });
    const ownNote = 'Not inspected: remaining files due to the turn limit.';
    const result = await runPrGate(config, {
      prNumber: 12, repoRoot: repo, exec: fixture.exec, routeProbe: readyRouteProbe, resolveModelHost: async () => 'grok.exe',
      modelRouteProcess: async invocation => {
        const prompt = readFileSync(invocation.promptPath, 'utf8');
        const lane = passingLane(prompt, headSha);
        const body = JSON.parse(JSON.parse(lane.stdout).text);
        Object.assign(body, {
          status: 'inconclusive',
          recommendation: 'inconclusive',
          summary: `Stopped early. ${ownNote}`,
          completeness: ownNote,
          coverage: body.coverage.map(entry => ({ ...entry, status: 'not-inspected' })),
        });
        return { ...lane, stdout: JSON.stringify({ text: JSON.stringify(body), sessionId: `session-${body.lane}` }) };
      },
    });

    assert.equal(result.localReview.status, 'inconclusive');
    const lanes = result.localReview.evidence.flatMap(evidence => evidence.lanes);
    assert.ok(lanes.some(lane => lane.summary.includes(ownNote)), 'the lane text keeps its own wording');
    assert.ok(lanes.every(lane => lane.notInspected.length === 0));
    for (const nextAction of [result.localReview.nextAction, result.shipReady.nextAction]) {
      assert.doesNotMatch(nextAction, /Split the pull request/);
      assert.doesNotMatch(nextAction, /remaining files/);
    }
  });

  it('gives shell routes no review input and shares the gate input with a lane that fails over to a route without shell', async () => {
    const { repo, headSha } = routedRepo();
    const config = noShellConfig();
    config.reviewRoute = { host: 'codex', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewModels.review.codex = { model: 'gpt-5.6-luna', effort: 'medium' };
    config.reviewFailover = { faults: 2, route: { host: 'grok-build', tier: 'review', timeoutSeconds: 600, maxTurns: 8 } };
    const fixture = makePrExec({ prViews: [cleanLocalPr({ headRefOid: headSha })] });
    const shellPrompts = [];
    const foldersDuringShell = [];
    const fallbackDiffFiles = [];
    const modelRouteProcess = async invocation => {
      if (invocation.schemaPath) {
        shellPrompts.push(invocation.promptPath ? readFileSync(invocation.promptPath, 'utf8') : invocation.stdin);
        foldersDuringShell.push(reviewInputFolders(repo));
        return { exitCode: 1, stderr: 'rejected: blocked by policy\ngit rev-parse HEAD\ngit diff', stdout: '', timedOut: false, stdinDelivered: true };
      }
      const prompt = readFileSync(invocation.promptPath, 'utf8');
      fallbackDiffFiles.push([...prompt.matchAll(DIFF_PATH_PATTERN)].map(match => match[1]));
      return passingLane(prompt, headSha);
    };

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec: fixture.exec, modelRouteProcess, routeProbe: readyRouteProbe, resolveModelHost: async host => (host === 'codex' ? 'codex.exe' : 'grok.exe') });

    const routed = result.localReviewRunner.lanes.filter(lane => lane.route !== null);
    assert.ok(shellPrompts.length >= 2, 'shell route lanes ran first');
    assert.ok(shellPrompts.every(prompt => !/review-input/.test(prompt)), 'a shell route prompt lists no review input');
    assert.ok(shellPrompts.every(prompt => /Prefer Git and Node\.js/.test(prompt)), 'a shell route keeps its Git inspection text');
    assert.deepEqual(foldersDuringShell[0], [], 'shell routes alone do not prepare review input');
    assert.ok(routed.every(lane => lane.status === 'completed' && lane.route.host === 'grok-build'), JSON.stringify(routed.map(lane => ({ lane: lane.lane, status: lane.status, blocker: lane.blocker }))));
    assert.equal(fallbackDiffFiles.length, routed.length);
    assert.ok(fallbackDiffFiles[0].length > 0);
    for (const files of fallbackDiffFiles) assert.deepEqual(files, fallbackDiffFiles[0], 'failover lanes share one gate review input');
    assert.deepEqual(reviewInputFolders(repo), []);
  });
});
