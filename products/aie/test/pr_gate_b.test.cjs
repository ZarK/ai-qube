'use strict';

const { describe, it } = require('node:test');
const {
  createHash,
  cloneGitRepo,
  execFileSync,
  spawnSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  tmpdir,
  basename,
  join,
  getDefaults,
  renderAgentPrompt,
  laneContextLines,
  promptStack,
  promptTextHashFromLines,
  buildFixBatch,
  localReviewEvidenceSha256,
  parsePrNumber,
  runPrGate,
  runPrViewService,
  buildPrBody,
  parsePrBodyIssueNumber,
  runPrReviewPublishService,
  runPrReviewPublishWithProvider,
  resolveModelReviewPlan,
  reviewRouteKey,
  runPrThreadResolveService,
  stringListFlag,
  assert,
  prViewFields,
  STANDARD_LOCAL_REVIEW_LANES,
  createGitHubReviewForgeProvider,
  observeReviewParticipants,
  makeGitRepo,
  binRun,
  writeConfig,
  commitTrustedBase,
  trustReviewCommands,
  commitRoutedReviewHead,
  writeWorkflow,
  safeRepoSegment,
  basePr,
  qubeReviewRequestComment,
  localReviewComment,
  laneReviewComment,
  promptStackHash,
  promptTextHash,
  promptStackForLane,
  promptForLane,
  withPromptStackProvenance,
  safeEvidenceSegment,
  trustedLocalHostProvenancePath,
  writeTestTrustedLocalHostProvenance,
  expectedPromptHashForLane,
  localEvidence,
  writeLocalEvidence,
  standardReviewLanes,
  localReviewConfig,
  approvedLocalPr,
  localCommandConfig,
  localHostConfig,
  readyRouteProbe,
  requiredTaskContext,
  comprehensiveEvidence,
  cleanLocalPr,
  threadResponse,
  issueCommentsFromPr,
  issueViewKey,
  issuePayload,
  issueViewResponse,
  makePrExec,
  fixtureLocalCommand,
  alignLocalEvidencePromptHashes,
  applyRoutedReviewFixture,
} = require('./support/pr_gate_fixture.cjs');

describe('PR gate service: provider reuse and publication', { concurrency: 4 }, () => {
  it('executes the routed lane with the probe-resolved executable', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    applyRoutedReviewFixture(repo);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = [];
    config.reviewWaitMinutes = 0;
    config.reviewRoute = { host: 'grok', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewModels.review.grok = { model: 'grok-4.5', effort: null };
    const executablesUsed = new Set();
    const modelRouteProcess = async invocation => {
      executablesUsed.add(invocation.executable);
      const prompt = readFileSync(invocation.promptPath, 'utf8');
      const lane = prompt.match(/Run local review lane ([a-z-]+)\./)?.[1];
      const body = {
        issueNumber: 93,
        prNumber: 12,
        headSha: 'abc123',
        lane,
        status: 'passed',
        severity: 'none',
        recommendation: 'approve',
        summary: `${lane} routed review passed.`,
        blockers: [],
        findings: [],
        artifacts: [{ kind: 'command', path: 'command:git diff --check', sha256: null }],
        commands: ['git diff --check'],
        surfaces: ['PR diff'],
        contextReviewed: requiredTaskContext(),
        toolsUsed: ['git'],
        completeness: `Inspected the complete ${lane} scope at the current head.`,
        coverage: ((prompt.match(/Attest coverage for exactly these areas: ([^\n]+?)\. Each coverage entry/) || [])[1] || lane).split(', ').map(area => ({ area, status: 'clear' })),
        preconditions: [],
      };
      return { exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: JSON.stringify(body), sessionId: `session-${lane}` }) };
    };
    const routeProbe = (host, model) => ({ host, model, status: 'ready', executable: 'probe-resolved-grok', version: 'probe-test', modelListed: true, diagnostic: null, resolved: 'probe-resolved-grok' });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec: makePrExec({ prViews: [cleanLocalPr()] }).exec, modelRouteProcess, routeProbe, resolveModelHead: async () => 'abc123' });

    assert.ok(result.localReviewRunner.lanes.filter(lane => lane.route !== null).every(lane => lane.status === 'completed'));
    assert.deepEqual([...executablesUsed], ['probe-resolved-grok'], 'execution must spawn exactly the probe-resolved executable');
  });

  it('accumulates faults from repeatedly blocked primary probes and engages the fallback', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    applyRoutedReviewFixture(repo);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = [];
    config.reviewWaitMinutes = 0;
    config.reviewRoute = { host: 'grok', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewModels.review.grok = { model: 'grok-4.5', effort: null };
    config.reviewModels.review.codex = { model: 'gpt-fallback-test', effort: 'low' };
    config.reviewFailover = { faults: 2, route: { host: 'codex', tier: 'review', timeoutSeconds: 600, maxTurns: 8 } };
    const codexLanes = [];
    const modelRouteProcess = async invocation => {
      assert.notEqual(invocation.schemaPath, null, 'only the codex fallback may execute while the grok primary probe is blocked');
      const prompt = invocation.stdin ?? '';
      const lane = prompt.match(/Run local review lane ([a-z-]+)\./)?.[1];
      codexLanes.push(lane);
      const body = {
        issueNumber: 93,
        prNumber: 12,
        headSha: 'abc123',
        lane,
        status: 'passed',
        severity: 'none',
        recommendation: 'approve',
        summary: `${lane} routed review passed.`,
        blockers: [],
        findings: [],
        artifacts: [{ kind: 'command', path: 'command:git diff --check', sha256: null }],
        commands: ['git diff --check'],
        surfaces: ['PR diff'],
        contextReviewed: requiredTaskContext(),
        toolsUsed: ['git'],
        completeness: `Inspected the complete ${lane} scope at the current head.`,
        coverage: ((prompt.match(/Attest coverage for exactly these areas: ([^\n]+?)\. Each coverage entry/) || [])[1] || lane).split(', ').map(area => ({ area, status: 'clear' })),
        preconditions: [],
      };
      const events = [
        JSON.stringify({ type: 'thread.started', thread_id: `codex-thread-${lane}` }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(body) } }),
      ];
      return { exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: events.join('\n') };
    };
    const routeProbe = (host, model) => (host === 'grok'
      ? { host, model, status: 'blocked', executable: null, version: null, modelListed: null, resolved: null, diagnostic: 'The grok CLI is not resolvable. Install and authenticate the grok CLI on PATH before running routed review lanes.' }
      : { host, model, status: 'ready', executable: 'codex-probe', version: 'probe-test', modelListed: null, diagnostic: null, resolved: 'codex-probe' });
    const gateOptions = { prNumber: 12, repoRoot: repo, exec: makePrExec({ prViews: [cleanLocalPr()] }).exec, modelRouteProcess, routeProbe, resolveModelHead: async () => 'abc123' };

    const firstRun = await runPrGate(config, gateOptions);
    assert.equal(codexLanes.length, 0, 'the first blocked probe stays under the threshold and must not execute any route');
    assert.ok(firstRun.localReviewRunner.lanes.filter(lane => lane.route !== null).every(lane => lane.status === 'unavailable'));
    const ledger = JSON.parse(readFileSync(join(repo, '.git', 'qube', 'aie', 'route-faults', '93', '12.json'), 'utf8'));
    assert.ok(Object.values(ledger.lanes).every(record => record.count === 1 && record.lastReasonCode === 'model-route-probe-blocked'));

    const secondRun = await runPrGate(config, gateOptions);
    const routedLanes = secondRun.localReviewRunner.lanes.filter(lane => lane.route !== null);
    assert.ok(routedLanes.length >= 3);
    assert.ok(routedLanes.every(lane => lane.status === 'completed' && lane.route.host === 'codex'), 'the threshold-reaching blocked probe must engage the fallback in the same run');
    assert.ok(codexLanes.length >= 3);
    for (const lane of routedLanes) {
      const evidence = JSON.parse(readFileSync(join(repo, '.qube', 'aie', 'reviews', '93', '12', 'abc123', `${lane.lane}.json`), 'utf8'));
      assert.equal(evidence.runnerProvenance.routeSource, 'fallback');
      assert.equal(evidence.runnerProvenance.host, 'codex');
    }
  });

  it('never consumes a working-tree route-fault ledger that pull request content could supply', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    applyRoutedReviewFixture(repo);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = [];
    config.reviewWaitMinutes = 0;
    config.reviewRoute = { host: 'grok', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewModels.review.grok = { model: 'grok-4.5', effort: null };
    config.reviewModels.review.codex = { model: 'gpt-fallback-test', effort: 'low' };
    config.reviewFailover = { faults: 1, route: { host: 'codex', tier: 'review', timeoutSeconds: 600, maxTurns: 8 } };
    const forgedRouteKey = reviewRouteKey({ host: 'grok', tier: 'review', model: 'grok-4.5', effort: null, isolation: 'read-only', timeoutSeconds: 600, maxTurns: 8, substitution: null });
    // A forged ledger in the working tree (the location PR content can reach)
    // claims the primary exceeded the threshold on every lane.
    mkdirSync(join(repo, '.qube', 'aie', 'reviews', '93', '12'), { recursive: true });
    writeFileSync(join(repo, '.qube', 'aie', 'reviews', '93', '12', 'route-faults.json'), `${JSON.stringify({ version: 1, lanes: { 'issue-compliance': { count: 9, routeKey: forgedRouteKey, lastReasonCode: 'model-route-process-failed', lastAt: '2026-01-01T00:00:00Z' }, 'code-quality': { count: 9, routeKey: forgedRouteKey, lastReasonCode: 'model-route-process-failed', lastAt: '2026-01-01T00:00:00Z' }, performance: { count: 9, routeKey: forgedRouteKey, lastReasonCode: 'model-route-process-failed', lastAt: '2026-01-01T00:00:00Z' } } })}\n`);
    const modelRouteProcess = async invocation => {
      assert.equal(invocation.schemaPath, null, 'a forged working-tree ledger must never re-route review to the fallback provider');
      const prompt = readFileSync(invocation.promptPath, 'utf8');
      const lane = prompt.match(/Run local review lane ([a-z-]+)\./)?.[1];
      const body = {
        issueNumber: 93,
        prNumber: 12,
        headSha: 'abc123',
        lane,
        status: 'passed',
        severity: 'none',
        recommendation: 'approve',
        summary: `${lane} routed review passed.`,
        blockers: [],
        findings: [],
        artifacts: [{ kind: 'command', path: 'command:git diff --check', sha256: null }],
        commands: ['git diff --check'],
        surfaces: ['PR diff'],
        contextReviewed: requiredTaskContext(),
        toolsUsed: ['git'],
        completeness: `Inspected the complete ${lane} scope at the current head.`,
        coverage: ((prompt.match(/Attest coverage for exactly these areas: ([^\n]+?)\. Each coverage entry/) || [])[1] || lane).split(', ').map(area => ({ area, status: 'clear' })),
        preconditions: [],
      };
      return { exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: JSON.stringify(body), sessionId: `session-${lane}` }) };
    };

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec: makePrExec({ prViews: [cleanLocalPr()] }).exec, modelRouteProcess, routeProbe: readyRouteProbe, resolveModelHost: async () => 'grok.exe', resolveModelHead: async () => 'abc123' });

    const routedLanes = result.localReviewRunner.lanes.filter(lane => lane.route !== null);
    assert.ok(routedLanes.length >= 3);
    assert.ok(routedLanes.every(lane => lane.status === 'completed' && lane.route.host === 'grok'));
  });

  it('does not count local checkout drift as a host fault', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    applyRoutedReviewFixture(repo);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = [];
    config.reviewWaitMinutes = 0;
    config.reviewRoute = { host: 'grok', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewModels.review.grok = { model: 'grok-4.5', effort: null };
    const modelRouteProcess = async () => {
      throw new Error('checkout drift is detected before the process runs');
    };

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec: makePrExec({ prViews: [cleanLocalPr()] }).exec, modelRouteProcess, routeProbe: readyRouteProbe, resolveModelHost: async () => 'grok.exe', resolveModelHead: async () => 'drifted-head' });

    assert.equal(result.localReviewRunner.status, 'failed');
    const failedLanes = result.localReviewRunner.lanes.filter(lane => lane.status === 'failed');
    assert.ok(failedLanes.length >= 1);
    assert.ok(failedLanes.every(lane => lane.blocker === 'model-route-checkout-mismatch'));
    assert.ok(!existsSync(join(repo, '.git', 'qube', 'aie', 'route-faults', '93', '12.json')), 'checkout drift must record zero host faults');
  });

  it('surfaces provider feedback when local review evidence is still missing', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    config.reviewAdapter = 'mixed';
    const pr = basePr({
      reviewDecision: 'CHANGES_REQUESTED',
      latestReviews: [{ author: { login: 'reviewer' }, state: 'CHANGES_REQUESTED', body: 'Please fix this.' }],
    });
    const threads = [{ isResolved: false, comments: { nodes: [{ author: { login: 'reviewer' }, body: 'Unresolved thread.', url: 'https://github.com/example/repo/pull/12#discussion_r1' }] } }];
    const { exec } = makePrExec({ prViews: [pr], threads: [threads] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec });

    assert.equal(result.status, 'pending');
    assert.equal(result.localReview.status, 'missing');
    assert.equal(result.localReviewPublish.status, 'disabled');
    assert.ok(result.feedback.some(item => item.source === 'thread' || item.state === 'CHANGES_REQUESTED'));
    assert.match(result.nextAction, /fresh-context review subagents|publish provider-visible|pending until current-head|provider-visible review feedback/);
    assert.match(result.nextAction, /provider-visible review feedback|address review feedback/);
  });

  it('includes commandless Codex prompt bodies only when explicitly requested', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    const { exec } = makePrExec({ prViews: [cleanLocalPr()] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec, includeLocalReviewPrompts: true });

    assert.match(result.localReviewRunner.lanes[0].spawnPrompt, /qube-review-focus subagent for review lane/);
    assert.match(result.localReviewRunner.lanes[0].spawnPrompt, /--- LANE PROMPT START ---/);
    assert.match(result.localReviewRunner.lanes[0].spawnPrompt, /Do not read external prompt files/);
    assert.equal(result.localReviewRunner.lanes[0].spawnContract.agentType, 'qube-review-focus');
    assert.equal(result.localReviewRunner.lanes[0].spawnContract.forkContext, false);
    assert.equal(result.localReviewRunner.lanes[0].spawnContract.publishCommand, `qube aie pr review publish 12 --lane ${result.localReviewRunner.lanes[0].lane} --issue 93`);
    assert.equal(result.localReviewRunner.lanes[0].spawnContract.promptStackHash, result.localReviewRunner.lanes[0].promptStackHash);
    assert.match(result.localReviewRunner.lanes[0].spawnPrompt, new RegExp(`Prompt stack hash for runnerProvenance\\.promptStackHash: ${result.localReviewRunner.lanes[0].promptStackHash}\\.`));
    assert.match(result.localReviewRunner.lanes[0].promptText, /Host safety prefix for Codex/);
    assert.match(result.localReviewRunner.lanes[0].promptText, /independent production PR review agent/);
    assert.match(result.localReviewRunner.lanes[0].promptText, /security and trust boundaries/);
    assert.match(result.localReviewRunner.lanes[0].promptText, /Review context source policy/);
    assert.match(result.localReviewRunner.lanes[0].promptText, /Bounded review bundle/);
    assert.match(result.localReviewRunner.lanes[0].promptText, /Bundle PR: #12 Review me/);
    assert.match(result.localReviewRunner.lanes[0].promptText, /Bundle changed files:/);
    assert.equal((result.localReviewRunner.lanes[0].promptText.match(/no changed paths were available from local git diff commands/g) ?? []).length, 1);
    assert.doesNotMatch(result.localReviewRunner.lanes[0].promptText, /Changed and relevant local paths: no changed paths were available from local git diff commands/);
    const bundleChangedFileLines = result.localReviewRunner.lanes
      .map(lane => lane.promptText.split('\n').find(line => line.includes('Bundle changed files:')))
      .filter(Boolean);
    assert.ok(bundleChangedFileLines.length > 1);
    assert.equal(new Set(bundleChangedFileLines).size, 1);
    assert.match(result.localReviewRunner.lanes[0].promptText, /Bundle provider feedback summaries:/);
    assert.match(result.localReviewRunner.lanes[0].promptText, /Repository instructions: AGENTS\.md/);
    assert.match(result.localReviewRunner.lanes[0].promptText, /Inspect linked issue\(s\): #93/);
    assert.match(result.localReviewRunner.lanes[0].promptText, /Pull request: #12/);
    assert.match(result.localReviewRunner.lanes[0].promptText, /PR head SHA: abc123/);
    assert.match(result.localReviewRunner.lanes[0].promptText, /\.git[\\/]qube[\\/]aie[\\/]host-provenance[\\/]93[\\/]12[\\/]abc123/);
    assert.match(result.localReviewRunner.lanes[0].promptText, /evidenceSha256 is the canonical SHA-256 digest/);
    assert.match(result.localReviewRunner.lanes[0].promptText, /Writing the requested evidence and host-provenance files is allowed/);
    assert.match(result.localReviewRunner.lanes[0].promptText, /QUBE context commands/);
    assert.match(result.localReviewRunner.lanes[0].promptText, /Issue #93 checklist:/);
    assert.match(result.localReviewRunner.lanes[0].promptText, /Check ci:/);
    assert.doesNotMatch(result.localReviewRunner.lanes[0].promptText, /Fallback host mode/);
  });

  it('keeps prior-head lane evidence out of new-head lane prompts', async () => {
    const repo = makeGitRepo();
    const priorPath = join(repo, '.qube', 'aie', 'reviews', '93', '12', 'oldhead', 'issue-compliance.json');
    mkdirSync(join(repo, '.qube', 'aie', 'reviews', '93', '12', 'oldhead'), { recursive: true });
    writeFileSync(priorPath, `${JSON.stringify({
      version: 1,
      issueNumber: 93,
      prNumber: 12,
      headSha: 'oldhead',
      lane: 'issue-compliance',
      summary: 'SUPERSEDED_ACCEPTANCE_WORDING remains blocking.',
    }, null, 2)}\n`);
    const config = localHostConfig(null);
    const { exec } = makePrExec({
      prViews: [cleanLocalPr()],
      issueBodies: { 93: '## Requirements\nCURRENT_ACCEPTANCE_WORDING is the live criterion.\n' },
    });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec, includeLocalReviewPrompts: true });
    const promptText = result.localReviewRunner.lanes.map(lane => lane.promptText).join('\n');

    assert.match(promptText, /Do not read files under \.qube\/aie\/reviews\/\*\*/);
    assert.match(promptText, /CURRENT_ACCEPTANCE_WORDING/);
    assert.doesNotMatch(promptText, /SUPERSEDED_ACCEPTANCE_WORDING/);
    assert.ok(existsSync(priorPath));
    assert.match(result.localReviewRunner.lanes[0].spawnPrompt, /Do not read any path under \.qube\/aie\/reviews\/\*\*/);
  });

  it('writes a shared per-head digest and drops raw issue-body rereads from lane prompts', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    const prBody = '## Summary\nDetails.\n\n## Criterion-to-proof map\n### Criterion 1: Bundled acceptance context reaches the reviewer.\n- Proven by: `products/aie/test/pr_gate_b.test.cjs`.\n\n## Notes\nOutside the map.';
    const { exec } = makePrExec({
      prViews: [cleanLocalPr({ body: prBody })],
      issueBodies: { 93: 'Issue acceptance context body.\n\n- [ ] Bundled criterion.' },
    });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec, includeLocalReviewPrompts: true });

    const digest = result.localReviewRunner.headDigest;
    assert.ok(digest);
    assert.equal(digest.builder, 'qube-review-digest');
    assert.match(digest.sha256, /^[a-f0-9]{64}$/);
    assert.match(digest.path.replace(/\\/g, '/'), /\.qube\/aie\/reviews\/93\/12\/abc123\/context-digest\.json$/);
    const written = JSON.parse(readFileSync(digest.path, 'utf8'));
    assert.equal(written.sha256, digest.sha256);
    assert.ok(written.provenance.sources.some(source => source.kind === 'issue-body'));
    const promptText = result.localReviewRunner.lanes[0].promptText;
    assert.match(promptText, /Shared per-head review digest/);
    assert.match(promptText, new RegExp(`Digest sha256: ${digest.sha256}`));
    assert.match(promptText, /Criterion 1: Bundled acceptance context reaches the reviewer\./);
    assert.match(promptText, /items=\[ \] #1 Bundled criterion\./);
    assert.doesNotMatch(promptText, /Bundle issue body #93:/);
    assert.doesNotMatch(promptText, /Issue acceptance context body/);
    assert.doesNotMatch(promptText, /Outside the map/);
    const digestHashes = new Set(result.localReviewRunner.lanes.map(lane => {
      const match = lane.promptText.match(/Digest sha256: ([a-f0-9]{64})/);
      return match && match[1];
    }));
    assert.deepEqual([...digestHashes], [digest.sha256]);
  });

  it('names a genuinely missing digest field instead of omitting it silently', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    const { exec } = makePrExec({ prViews: [cleanLocalPr({ body: 'No criterion map in this body.' })] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec, includeLocalReviewPrompts: true });

    const promptText = result.localReviewRunner.lanes[0].promptText;
    assert.match(promptText, /body=missing/);
    assert.match(promptText, /Digest criterion-to-proof: missing/);
    assert.doesNotMatch(promptText, /Bundle issue body #93:/);
    assert.doesNotMatch(promptText, /Bundle PR criterion-to-proof map:/);
  });

  it('folds changed-file AIQ findings into local review spawn prompts for verification', async () => {
    const repo = makeGitRepo();
    const sourcePath = join(repo, 'src', 'changed.ts');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(sourcePath, 'export const changed = false;\n');
    commitTrustedBase(repo);
    writeFileSync(sourcePath, 'export const changed = true;\n');
    const reportPath = join(repo, '.qube', 'aiq', 'out', 'aiq.report.json');
    mkdirSync(join(repo, '.qube', 'aiq', 'out'), { recursive: true });
    copyFileSync(join(__dirname, 'fixtures', 'aiq-report.json'), reportPath);
    const config = localHostConfig(null);
    const { exec } = makePrExec({ prViews: [cleanLocalPr()] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec, includeLocalReviewPrompts: true });
    const lane = result.localReviewRunner.lanes.find(entry => entry.spawnContract);

    assert.ok(lane);
    assert.match(lane.promptText, /Pre-collected AIQ static findings/);
    assert.match(lane.spawnPrompt, /VERIFY against the current head/);
    assert.match(lane.promptText, /"rule":"biome\/no-debugger"/);
    assert.match(lane.promptText, /"path":"src\/changed\.ts"/);
    assert.match(lane.promptText, /"line":7/);
    assert.match(lane.promptText, /"kind":"aiq-finding"/);
    assert.match(lane.promptText, /add its evidenceLink object verbatim to evidence artifacts/);
    assert.match(lane.promptText, /Do not add a supplied AIQ defect to findings\[\] as a new finding/);
    assert.doesNotMatch(lane.promptText, /src\/unchanged\.ts/);
  });

  it('keeps local-host prompt hashes stable across mutable PR context', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    const pending = makePrExec({
      prViews: [cleanLocalPr({ statusCheckRollup: [{ name: 'ci', status: 'IN_PROGRESS', conclusion: null }] })],
      checkRuns: [{ id: 200, name: 'ci', status: 'IN_PROGRESS', conclusion: null }],
    });
    const passed = makePrExec({
      prViews: [cleanLocalPr({ statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] })],
      checkRuns: [{ id: 200, name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    });

    const pendingResult = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec: pending.exec, includeLocalReviewPrompts: true });
    const passedResult = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec: passed.exec, includeLocalReviewPrompts: true });

    assert.notEqual(pendingResult.localReviewRunner.lanes[0].promptText, passedResult.localReviewRunner.lanes[0].promptText);
    assert.match(pendingResult.localReviewRunner.lanes[0].promptText, /Check ci: pending-current-head-run/);
    assert.match(passedResult.localReviewRunner.lanes[0].promptText, /Check ci: mapped/);
    assert.equal(pendingResult.localReviewRunner.lanes[0].promptStackHash, passedResult.localReviewRunner.lanes[0].promptStackHash);
  });

  it('uses the source checkout runner in Codex spawn publish commands when available', async () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, 'products', 'aie', 'bin'), { recursive: true });
    writeFileSync(join(repo, 'products', 'aie', 'bin', 'run'), '');
    const config = localHostConfig(null);
    const { exec } = makePrExec({ prViews: [cleanLocalPr()] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec, includeLocalReviewPrompts: true });

    assert.equal(result.localReviewRunner.lanes[0].spawnContract.publishCommand, `node products/aie/bin/run pr review publish 12 --lane ${result.localReviewRunner.lanes[0].lane} --issue 93`);
    assert.equal(result.localReviewRunner.lanes[0].spawnContract.promptStackHash, result.localReviewRunner.lanes[0].promptStackHash);
    assert.match(result.localReviewRunner.lanes[0].spawnPrompt, /When complete, publish provider-visible feedback with: node products\/aie\/bin\/run pr review publish 12 --lane/);
    assert.match(result.localReviewRunner.lanes[0].spawnPrompt, /Prompt stack hash for runnerProvenance\.promptStackHash: [a-f0-9]{64}\./);
    assert.match(result.localReviewRunner.lanes[0].promptText, /publish provider-visible lane review with `node products\/aie\/bin\/run pr review publish 12 --lane/);
    assert.doesNotMatch(result.localReviewRunner.lanes[0].promptText, /publish provider-visible lane review with `qube aie pr review publish/);
  });

  it('plans commandless Codex local-host lanes per linked issue', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    const pr = cleanLocalPr({ closingIssuesReferences: [{ number: 93 }, { number: 94 }] });
    const { exec } = makePrExec({ prViews: [pr] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec, includeLocalReviewPrompts: true });

    assert.equal(result.localReviewRunner.lanes.length, 12);
    assert.equal(result.localReviewRunner.lanes.filter(lane => lane.issueNumber === 93).length, 6);
    assert.equal(result.localReviewRunner.lanes.filter(lane => lane.issueNumber === 94).length, 6);
    assert.ok(result.localReviewRunner.lanes.every(lane => lane.issueNumbers[0] === lane.issueNumber));
    assert.ok(result.localReviewRunner.lanes.every(lane => lane.issueNumbers.includes(93) && lane.issueNumbers.includes(94)));
    assert.ok(result.localReviewRunner.lanes.every(lane => lane.evidencePaths.length === 1));
    assert.match(result.localReviewRunner.lanes[0].promptText, /Linked issues for this PR-level lane: #93, #94/);
    assert.ok(result.localReviewRunner.lanes.filter(lane => lane.issueNumber === 93).every(lane => lane.evidencePath.includes('\\93\\12\\abc123') || lane.evidencePath.includes('/93/12/abc123')));
    assert.ok(result.localReviewRunner.lanes.filter(lane => lane.issueNumber === 94).every(lane => lane.evidencePath.includes('\\94\\12\\abc123') || lane.evidencePath.includes('/94/12/abc123')));
  });

  it('runs local-command fixture lanes and writes valid current-head evidence before PR gate validation', async () => {
    const repo = makeGitRepo();
    const config = localCommandConfig();
    trustReviewCommands(repo);
    const { exec, calls } = makePrExec({ prViews: [approvedLocalPr(), approvedLocalPr()] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec });
    const lanePath = join(repo, '.qube', 'aie', 'reviews', '93', '12', 'abc123', 'issue-compliance.json');
    const lane = JSON.parse(readFileSync(lanePath, 'utf8'));
    const rawPath = join(repo, '.qube', 'aie', 'reviews', '93', '12', 'abc123', 'issue-compliance.raw-output.json');
    const rawOutput = JSON.parse(readFileSync(rawPath, 'utf8'));
    const issueCommand = calls.find(args => args[0] === 'review-fixture' && args.includes('--lane') && args[args.indexOf('--lane') + 1] === 'issue-compliance');
    const bundlePath = issueCommand?.[issueCommand.indexOf('--review-bundle') + 1];
    const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));

    assert.equal(result.localReviewRunner.status, 'completed');
    assert.equal(result.localReviewRunner.written.length, 7);
    assert.ok(result.localReviewRunner.headDigest);
    assert.ok(result.localReviewRunner.written.includes(result.localReviewRunner.headDigest.path));
    assert.equal(result.localReview.status, 'passed');
    assert.equal(result.status, 'complete');
    assert.equal(lane.issueNumber, 93);
    assert.equal(lane.prNumber, 12);
    assert.equal(lane.headSha, 'abc123');
    assert.equal(lane.adapter, 'local-command');
    assert.equal(lane.lane, 'issue-compliance');
    assert.ok(Array.isArray(lane.promptStack) && lane.promptStack.length > 0);
    assert.equal(rawOutput.lane, 'issue-compliance');
    assert.match(rawOutput.stdout, /Fixture local review passed issue-compliance/);
    assert.ok(lane.artifacts.some(artifact => typeof artifact.path === 'string' && artifact.path.endsWith('issue-compliance.raw-output.json')));
    assert.match(bundle.promptText, /Run local review lane issue-compliance/);
    assert.match(bundle.outputContract, /Return JSON local review lane evidence/);
    assert.match(bundle.outputContract, /Report admissible blocking findings first/);
    assert.match(bundle.outputContract, /a blocker must cite a violated acceptance criterion or a defect introduced by this diff/);
    assert.match(bundle.outputContract, /completeness self-check/);
    assert.match(bundle.promptText, /Your verdict is scoped to this lane/);
    assert.match(bundle.promptText, /as preconditions entries/);
    assert.equal(bundle.promptStackHash, lane.runnerProvenance.promptStackHash);
    assert.equal(bundle.evidencePath, lanePath);
  });

  it('blocks executable local review commands when the trusted base cannot be verified', async () => {
    const repo = makeGitRepo();
    const config = localCommandConfig();
    writeConfig(repo, { version: 1, policy: { reviews: { adapter: 'local' } } });
    const { exec, calls } = makePrExec({ prViews: [cleanLocalPr()] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec });

    assert.equal(calls.some(args => args[0] === 'review-fixture'), false);
    assert.equal(result.localReviewRunner.status, 'unavailable');
    assert.ok(result.localReviewRunner.lanes.some(lane => lane.status === 'unavailable'));
    assert.ok(result.localReviewRunner.unavailable.some(item => item.includes('review runner configuration changed outside the trusted base')));
    assert.equal(result.status, 'unavailable');
  });

  it('blocks executable local review commands when the repo is not a git worktree', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'aie-pr-gate-no-git-'));
    const config = localCommandConfig();
    const { exec, calls } = makePrExec({ prViews: [cleanLocalPr()] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec });

    assert.equal(calls.some(args => args[0] === 'review-fixture'), false);
    assert.equal(result.localReviewRunner.status, 'unavailable');
    assert.equal(result.status, 'unavailable');
    assert.ok(result.localReviewRunner.unavailable.some(item => item.includes('review runner configuration changed outside the trusted base')));
  });

  it('blocks executable local review commands when QUBE config is missing from the trusted base', async () => {
    const repo = makeGitRepo();
    const config = localCommandConfig();
    execFileSync('git', ['commit', '--allow-empty', '-m', 'trusted empty base'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: repo, stdio: 'ignore' });
    const { exec, calls } = makePrExec({ prViews: [cleanLocalPr()] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec });

    assert.equal(calls.some(args => args[0] === 'review-fixture'), false);
    assert.equal(result.localReviewRunner.status, 'unavailable');
    assert.equal(result.status, 'unavailable');
  });

  it('blocks executable local review commands when trusted config has worktree drift', async () => {
    const repo = makeGitRepo();
    const config = localCommandConfig();
    writeConfig(repo, { version: 1, policy: { reviews: { adapter: 'local' } } });
    commitTrustedBase(repo);
    writeConfig(repo, { version: 1, policy: { reviews: { adapter: 'mixed' } } });
    const { exec, calls } = makePrExec({ prViews: [cleanLocalPr()] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec });

    assert.equal(calls.some(args => args[0] === 'review-fixture'), false);
    assert.ok(result.localReviewRunner.lanes.some(lane => lane.status === 'unavailable'));
    assert.ok(result.localReviewRunner.unavailable.some(item => item.includes('review runner configuration changed outside the trusted base')));
  });

  it('blocks executable local review commands when trusted config has staged drift', async () => {
    const repo = makeGitRepo();
    const config = localCommandConfig();
    writeConfig(repo, { version: 1, policy: { reviews: { adapter: 'local' } } });
    commitTrustedBase(repo);
    writeConfig(repo, { version: 1, policy: { reviews: { adapter: 'mixed' } } });
    execFileSync('git', ['add', '.qube/aie/config.json'], { cwd: repo, stdio: 'ignore' });
    const { exec, calls } = makePrExec({ prViews: [cleanLocalPr()] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec });

    assert.equal(calls.some(args => args[0] === 'review-fixture'), false);
    assert.ok(result.localReviewRunner.lanes.some(lane => lane.status === 'unavailable'));
    assert.ok(result.localReviewRunner.unavailable.some(item => item.includes('review runner configuration changed outside the trusted base')));
  });

  it('blocks executable local review commands when trusted config differs from origin main', async () => {
    const repo = makeGitRepo();
    const config = localCommandConfig();
    writeConfig(repo, { version: 1, policy: { reviews: { adapter: 'local' } } });
    commitTrustedBase(repo);
    writeConfig(repo, { version: 1, policy: { reviews: { adapter: 'mixed' } } });
    execFileSync('git', ['add', '.qube/aie/config.json'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'change review config'], { cwd: repo, stdio: 'ignore' });
    const { exec, calls } = makePrExec({ prViews: [cleanLocalPr()] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec });

    assert.equal(calls.some(args => args[0] === 'review-fixture'), false);
    assert.ok(result.localReviewRunner.lanes.some(lane => lane.status === 'unavailable'));
    assert.ok(result.localReviewRunner.unavailable.some(item => item.includes('review runner configuration changed outside the trusted base')));
  });

  it('trusts executable local review commands against the configured base ref', async () => {
    const repo = makeGitRepo();
    const config = localCommandConfig();
    config.baseRemote = 'upstream';
    config.baseBranch = 'trunk';
    trustReviewCommands(repo, 'upstream', 'trunk');
    const { exec, calls } = makePrExec({ prViews: [cleanLocalPr()] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec });

    assert.equal(calls.some(args => args[0] === 'review-fixture'), true);
    assert.equal(result.localReviewRunner.status, 'completed');
    assert.equal(result.localReview.status, 'passed');
  });

  it('keeps distinct same-message findings at different lines in the fix batch', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    const evidence = localEvidence();
    evidence.lanes = evidence.lanes.map(lane => lane.id === 'code-quality'
      ? { ...lane, status: 'needs-work', recommendation: 'request-changes', severity: 'high', blockers: ['Fix the parser crash.'], findings: [
          { id: 'finding-a', severity: 'blocking', message: 'Fix the parser crash.', location: { path: 'src/parser.ts', line: 10 } },
          { id: 'finding-b', severity: 'blocking', message: 'Fix the parser crash.', location: { path: 'src/parser.ts', line: 42 } },
        ] }
      : lane);
    writeLocalEvidence(repo, evidence);
    const { exec } = makePrExec({ prViews: [cleanLocalPr()] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec });

    const parserFindings = result.fixBatch.findings.filter(finding => finding.message === 'Fix the parser crash.');
    assert.equal(parserFindings.length, 2);
    assert.deepEqual(parserFindings.map(finding => finding.location.line).sort((a, b) => a - b), [10, 42]);
  });

  it('carries resolved review tier model and substitution in spawn contracts', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    config.reviewModels = { review: { codex: { model: 'gpt-5.5-codex', effort: 'high' } }, economy: {}, synthesis: {} };
    const { exec } = makePrExec({ prViews: [cleanLocalPr()] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, includeLocalReviewPrompts: true, exec });

    const lane = result.localReviewRunner.lanes.find(entry => entry.spawnContract && entry.modelTier === 'review');
    assert.equal(lane.spawnContract.model, 'gpt-5.5-codex');
    assert.equal(lane.spawnContract.effort, 'high');
    assert.equal(lane.spawnContract.tierSubstitution, null);
    assert.equal(lane.spawnContract.modelTier, 'review');
    const economyLane = result.localReviewRunner.lanes.find(entry => entry.lane === 'task-record-compliance');
    assert.equal(economyLane.modelTier, 'economy');
    assert.equal(economyLane.spawnContract.modelTier, 'economy');
    assert.match(economyLane.spawnContract.tierSubstitution, /review tier model was substituted/);

    const fallbackConfig = localHostConfig(null);
    const fallbackExec = makePrExec({ prViews: [cleanLocalPr()] }).exec;
    const fallbackResult = await runPrGate(fallbackConfig, { prNumber: 12, repoRoot: repo, dryRun: true, includeLocalReviewPrompts: true, exec: fallbackExec });

    const fallbackLane = fallbackResult.localReviewRunner.lanes.find(entry => entry.spawnContract);
    assert.match(fallbackLane.spawnContract.tierSubstitution, /host default model applies/);
    assert.equal(result.localReviewRunner.modelTiers.review.model, 'gpt-5.5-codex');
    assert.match(result.localReviewRunner.modelTiers.economy.substitution, /review tier model was substituted/);
    assert.match(fallbackResult.localReviewRunner.modelTiers.synthesis.substitution, /host default model applies/);
  });

  it('accounts for duplicate same-message findings across heads by count', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    const priorEvidence = localEvidence({ headSha: 'aaa111' });
    priorEvidence.lanes = priorEvidence.lanes.map(lane => lane.id === 'code-quality'
      ? { ...lane, status: 'needs-work', recommendation: 'request-changes', severity: 'high', blockers: ['Fix the parser crash.'], findings: [
          { id: 'finding-a', severity: 'blocking', message: 'Fix the parser crash.', location: { path: 'src/parser.ts', line: 10 } },
          { id: 'finding-b', severity: 'blocking', message: 'Fix the parser crash.', location: { path: 'src/parser.ts', line: 42 } },
        ], recordedAt: '2026-06-20T00:00:00.000Z' }
      : lane);
    writeLocalEvidence(repo, priorEvidence);
    const currentEvidence = localEvidence();
    currentEvidence.lanes = currentEvidence.lanes.map(lane => lane.id === 'code-quality'
      ? { ...lane, status: 'needs-work', recommendation: 'request-changes', severity: 'high', blockers: ['Fix the parser crash.'], findings: [
          { id: 'finding-a', severity: 'blocking', message: 'Fix the parser crash.', location: { path: 'src/parser.ts', line: 10 } },
        ] }
      : lane);
    writeLocalEvidence(repo, currentEvidence);
    const { exec } = makePrExec({ prViews: [cleanLocalPr()] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec });

    const parserFindings = result.fixBatch.findings.filter(finding => finding.message === 'Fix the parser crash.');
    assert.equal(parserFindings.length, 1);
    assert.equal(parserFindings[0].classification, 'persisting');
    assert.equal(result.fixBatch.resolved.filter(entry => entry.message === 'Fix the parser crash.').length, 1);
  });

  it('keeps the fix batch content hash stable when only confidence changes between heads', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    const priorEvidence = localEvidence({ headSha: 'aaa111' });
    priorEvidence.lanes = priorEvidence.lanes.map(lane => lane.id === 'code-quality'
      ? { ...lane, status: 'needs-work', recommendation: 'request-changes', severity: 'high', blockers: ['Tighten the null check.'], findings: [
          { id: 'finding-a', severity: 'advisory', message: 'Tighten the null check.', location: { path: 'src/parser.ts', line: 10 }, confidence: 0.2 },
        ], recordedAt: '2026-06-20T00:00:00.000Z' }
      : lane);
    writeLocalEvidence(repo, priorEvidence);
    const currentEvidence = localEvidence();
    currentEvidence.lanes = currentEvidence.lanes.map(lane => lane.id === 'code-quality'
      ? { ...lane, status: 'needs-work', recommendation: 'request-changes', severity: 'high', blockers: ['Tighten the null check.'], findings: [
          { id: 'finding-a', severity: 'advisory', message: 'Tighten the null check.', location: { path: 'src/parser.ts', line: 10 }, confidence: 0.9 },
        ] }
      : lane);
    writeLocalEvidence(repo, currentEvidence);
    const { exec } = makePrExec({ prViews: [cleanLocalPr()] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec });

    const nullCheckFindings = result.fixBatch.findings.filter(finding => finding.message === 'Tighten the null check.');
    assert.equal(nullCheckFindings.length, 1);
    assert.equal(nullCheckFindings[0].classification, 'persisting', 'content hash must not vary with confidence alone');
    assert.equal(result.fixBatch.resolved.filter(entry => entry.message === 'Tighten the null check.').length, 0, 're-scored confidence must not read as resolved-plus-new');
  });

  it('resolves prior findings only for issues with completed current evidence', () => {
    const repo = makeGitRepo();
    const priorFirstIssue = localEvidence({ headSha: 'aaa111' });
    priorFirstIssue.lanes = priorFirstIssue.lanes.map(lane => lane.id === 'code-quality'
      ? { ...lane, status: 'needs-work', recommendation: 'request-changes', severity: 'high', blockers: ['Fix the parser crash.'], findings: [{ id: 'finding-a', severity: 'blocking', message: 'Fix the parser crash.', location: { path: 'src/parser.ts', line: 10 } }], recordedAt: '2026-06-20T00:00:00.000Z' }
      : lane);
    writeLocalEvidence(repo, priorFirstIssue);
    const priorSecondIssue = localEvidence({ issueNumber: 94, headSha: 'aaa111' });
    priorSecondIssue.lanes = priorSecondIssue.lanes.map(lane => lane.id === 'code-quality'
      ? { ...lane, status: 'needs-work', recommendation: 'request-changes', severity: 'high', blockers: ['Remove the dead code.'], findings: [{ id: 'finding-b', severity: 'blocking', message: 'Remove the dead code.', location: { path: 'src/legacy.ts', line: 3 } }], recordedAt: '2026-06-20T00:00:00.000Z' }
      : lane);
    writeLocalEvidence(repo, priorSecondIssue);

    const batch = buildFixBatch(repo, [93, 94], 12, 'def456', [
      { status: 'passed', issueNumber: 93, prNumber: 12, headSha: 'def456', lanes: [] },
      { status: 'pending', issueNumber: 94, prNumber: 12, headSha: 'def456', lanes: [] },
    ]);

    assert.equal(batch.resolved.length, 1);
    assert.equal(batch.resolved[0].message, 'Fix the parser crash.');
  });

  it('keeps fix batch resolution indeterminate for pending current-head evidence', () => {
    const repo = makeGitRepo();
    const priorEvidence = localEvidence({ headSha: 'aaa111' });
    priorEvidence.lanes = priorEvidence.lanes.map(lane => lane.id === 'code-quality'
      ? { ...lane, status: 'needs-work', recommendation: 'request-changes', severity: 'high', blockers: ['Fix the parser crash.'], findings: [{ id: 'finding-a', severity: 'blocking', message: 'Fix the parser crash.', location: { path: 'src/parser.ts', line: 10 } }], recordedAt: '2026-06-20T00:00:00.000Z' }
      : lane);
    writeLocalEvidence(repo, priorEvidence);

    const batch = buildFixBatch(repo, [93], 12, 'def456', [{ status: 'pending', issueNumber: 93, prNumber: 12, headSha: 'def456', lanes: [] }]);

    assert.equal(batch.resolved.length, 0);
    assert.match(batch.summary, /resolved state is indeterminate/);
  });

  it('keeps fix batch resolution indeterminate when current-head lane evidence is missing', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    const priorEvidence = localEvidence({ headSha: 'aaa111' });
    priorEvidence.lanes = priorEvidence.lanes.map(lane => lane.id === 'code-quality'
      ? { ...lane, status: 'needs-work', recommendation: 'request-changes', severity: 'high', blockers: ['Fix the parser crash.'], findings: [{ id: 'finding-a', severity: 'blocking', message: 'Fix the parser crash.', location: { path: 'src/parser.ts', line: 10 } }], recordedAt: '2026-06-20T00:00:00.000Z' }
      : lane);
    writeLocalEvidence(repo, priorEvidence);
    const { exec } = makePrExec({ prViews: [cleanLocalPr({ headRefOid: 'def456' })] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec });

    assert.equal(result.fixBatch.resolved.length, 0);
    assert.match(result.fixBatch.summary, /resolved state is indeterminate/);
  });

  it('carries forward an approved lane when the head delta does not touch its scope', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    config.reviewLanes = [
      { id: 'code-quality', required: 'always', match: ['src/**'], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
    ];
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'app.js'), 'module.exports = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo, stdio: 'ignore' });
    const priorHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const evidence = localEvidence({ headSha: priorHead });
    evidence.lanes = evidence.lanes.filter(lane => lane.id === 'code-quality').map(lane => ({
      ...lane,
      artifacts: [{ kind: 'json', path: `.qube/aie/reviews/93/12/${priorHead}/code-quality.json`, sha256: null }],
      contextReviewed: [
        { kind: 'agents', source: 'AGENTS.md', trust: 'policy', freshness: 'current' },
        { kind: 'diff', source: 'git diff origin/main...HEAD', trust: 'local-evidence', freshness: 'current' },
      ],
      toolsUsed: ['codex'],
    }));
    writeLocalEvidence(repo, evidence);
    writeFileSync(join(repo, 'notes.md'), 'release notes\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'docs only'], { cwd: repo, stdio: 'ignore' });
    const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const { exec } = makePrExec({ prViews: [cleanLocalPr({ headRefOid: currentHead })] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec });

    const carried = result.localReviewRunner.lanes.find(lane => lane.lane === 'code-quality');
    assert.equal(carried.status, 'completed');
    assert.match(carried.summary, /Carried forward from approved review at/);
    const carriedEvidence = JSON.parse(readFileSync(join(repo, '.qube', 'aie', 'reviews', '93', '12', currentHead, 'code-quality.json'), 'utf8'));
    assert.equal(carriedEvidence.carriedForward.fromHeadSha, priorHead);
    assert.equal(carriedEvidence.carriedForward.priorRunId, 'test-review-task');
    assert.equal(carriedEvidence.headSha, currentHead);
    assert.equal(carriedEvidence.usage, undefined);
    assert.equal(result.localReview.status, 'passed');
    assert.equal(result.localReviewRunner.deltaTriage.modelTier, 'economy');
    const triage = result.localReviewRunner.deltaTriage.lanes.find(entry => entry.lane === 'code-quality');
    assert.equal(triage.verdict, 'not-relevant');
    assert.equal(triage.escalate, false);
    assert.equal(triage.modelTier, 'economy');
  });

  it('does not carry forward approved evidence that never recorded a model tier', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    config.reviewLanes = [
      { id: 'code-quality', required: 'always', match: ['src/**'], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
    ];
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'app.js'), 'module.exports = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo, stdio: 'ignore' });
    const priorHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const evidence = localEvidence({ headSha: priorHead });
    evidence.lanes = evidence.lanes.filter(lane => lane.id === 'code-quality').map(lane => {
      const { modelTier: _omit, ...rest } = lane;
      return {
        ...rest,
        artifacts: [{ kind: 'json', path: `.qube/aie/reviews/93/12/${priorHead}/code-quality.json`, sha256: null }],
        contextReviewed: [
          { kind: 'agents', source: 'AGENTS.md', trust: 'policy', freshness: 'current' },
          { kind: 'diff', source: 'git diff origin/main...HEAD', trust: 'local-evidence', freshness: 'current' },
        ],
        toolsUsed: ['codex'],
      };
    });
    writeLocalEvidence(repo, evidence);
    writeFileSync(join(repo, 'notes.md'), 'release notes\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'docs only'], { cwd: repo, stdio: 'ignore' });
    const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const { exec } = makePrExec({ prViews: [cleanLocalPr({ headRefOid: currentHead })] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec });

    const lane = result.localReviewRunner.lanes.find(entry => entry.lane === 'code-quality');
    assert.notEqual(lane.status, 'completed');
    assert.doesNotMatch(lane.summary, /Carried forward/);
  });

  it('does not carry forward when the recorded lane tier differs from the current plan', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    config.reviewLanes = [
      { id: 'code-quality', required: 'always', match: ['src/**'], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host', tier: 'economy' },
    ];
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'app.js'), 'module.exports = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo, stdio: 'ignore' });
    const priorHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const evidence = localEvidence({ headSha: priorHead });
    evidence.lanes = evidence.lanes.filter(lane => lane.id === 'code-quality').map(lane => ({
      ...lane,
      modelTier: 'review',
      artifacts: [{ kind: 'json', path: `.qube/aie/reviews/93/12/${priorHead}/code-quality.json`, sha256: null }],
      contextReviewed: [
        { kind: 'agents', source: 'AGENTS.md', trust: 'policy', freshness: 'current' },
        { kind: 'diff', source: 'git diff origin/main...HEAD', trust: 'local-evidence', freshness: 'current' },
      ],
      toolsUsed: ['codex'],
    }));
    writeLocalEvidence(repo, evidence);
    writeFileSync(join(repo, 'notes.md'), 'release notes\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'docs only'], { cwd: repo, stdio: 'ignore' });
    const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const { exec } = makePrExec({ prViews: [cleanLocalPr({ headRefOid: currentHead })] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec });

    const lane = result.localReviewRunner.lanes.find(entry => entry.lane === 'code-quality');
    assert.equal(lane.modelTier, 'economy');
    assert.notEqual(lane.status, 'completed');
    assert.doesNotMatch(lane.summary, /Carried forward/);
  });

  it('plans default and explicit per-lane model tiers in pr gate json', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    config.reviewModels = {
      review: { grok: { model: 'grok-4.5', effort: null }, codex: { model: 'gpt-5.6-luna', effort: 'high' } },
      economy: {},
      synthesis: {},
    };
    config.reviewRoute = { host: 'grok', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewLanes = [
      { id: 'code-quality', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
      { id: 'docs-instructions', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
      { id: 'security', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host', tier: 'economy' },
      {
        id: 'performance',
        required: 'always',
        match: [],
        severityThreshold: 'high',
        prompt: [],
        tools: [],
        runner: 'local-host',
        tier: 'economy',
        route: { host: 'codex', tier: 'review', timeoutSeconds: 600, maxTurns: 8 },
      },
    ];
    const { exec } = makePrExec({ prViews: [cleanLocalPr()] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec });

    const byLane = new Map(result.localReviewRunner.lanes.map(lane => [lane.lane, lane]));
    assert.equal(byLane.get('code-quality').modelTier, 'review');
    assert.equal(byLane.get('code-quality').route.tier, 'review');
    assert.equal(byLane.get('docs-instructions').modelTier, 'economy');
    assert.equal(byLane.get('docs-instructions').route.tier, 'economy');
    assert.equal(byLane.get('security').modelTier, 'economy');
    assert.equal(byLane.get('security').route.tier, 'economy');
    assert.equal(byLane.get('performance').modelTier, 'review');
    assert.equal(byLane.get('performance').route.tier, 'review');
    assert.equal(byLane.get('performance').route.host, 'codex');
  });

  it('escalates a relevant delta instead of carrying the lane forward', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    config.reviewLanes = [
      { id: 'code-quality', required: 'always', match: ['src/**'], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
    ];
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'app.js'), 'module.exports = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo, stdio: 'ignore' });
    const priorHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const evidence = localEvidence({ headSha: priorHead });
    evidence.lanes = evidence.lanes.filter(lane => lane.id === 'code-quality').map(lane => ({
      ...lane,
      artifacts: [{ kind: 'json', path: `.qube/aie/reviews/93/12/${priorHead}/code-quality.json`, sha256: null }],
      contextReviewed: [
        { kind: 'agents', source: 'AGENTS.md', trust: 'policy', freshness: 'current' },
        { kind: 'diff', source: 'git diff origin/main...HEAD', trust: 'local-evidence', freshness: 'current' },
      ],
      toolsUsed: ['codex'],
    }));
    writeLocalEvidence(repo, evidence);
    writeFileSync(join(repo, 'src', 'app.js'), 'module.exports = 2;\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'touch source'], { cwd: repo, stdio: 'ignore' });
    const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const { exec } = makePrExec({ prViews: [cleanLocalPr({ headRefOid: currentHead })] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec });

    const lane = result.localReviewRunner.lanes.find(entry => entry.lane === 'code-quality');
    assert.notEqual(lane.status, 'completed');
    assert.doesNotMatch(lane.summary, /Carried forward/);
    const triage = result.localReviewRunner.deltaTriage.lanes.find(entry => entry.lane === 'code-quality');
    assert.equal(triage.verdict, 'relevant');
    assert.equal(triage.escalate, true);
    assert.equal(triage.modelTier, 'economy');
  });

  it('escalates an uncomputable prior-head delta instead of carrying the lane forward', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    config.reviewLanes = [
      { id: 'code-quality', required: 'always', match: ['src/**'], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
    ];
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'app.js'), 'module.exports = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo, stdio: 'ignore' });
    const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const missingHead = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const evidence = localEvidence({ headSha: missingHead });
    evidence.lanes = evidence.lanes.filter(lane => lane.id === 'code-quality').map(lane => ({
      ...lane,
      artifacts: [{ kind: 'json', path: `.qube/aie/reviews/93/12/${missingHead}/code-quality.json`, sha256: null }],
      contextReviewed: [
        { kind: 'agents', source: 'AGENTS.md', trust: 'policy', freshness: 'current' },
        { kind: 'diff', source: 'git diff origin/main...HEAD', trust: 'local-evidence', freshness: 'current' },
      ],
      toolsUsed: ['codex'],
    }));
    writeLocalEvidence(repo, evidence);
    const { exec } = makePrExec({ prViews: [cleanLocalPr({ headRefOid: currentHead })] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec });

    const lane = result.localReviewRunner.lanes.find(entry => entry.lane === 'code-quality');
    assert.notEqual(lane.status, 'completed');
    assert.doesNotMatch(lane.summary, /Carried forward/);
    const triage = result.localReviewRunner.deltaTriage.lanes.find(entry => entry.lane === 'code-quality');
    assert.equal(triage.verdict, 'unsure');
    assert.equal(triage.escalate, true);
    assert.equal(triage.modelTier, 'economy');
  });

  it('carries scope-mode lanes across an instruction-doc-only delta while all-mode lanes rerun', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    config.reviewLanes = [
      { id: 'performance', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
      { id: 'task-record-compliance', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
      { id: 'issue-compliance', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
    ];
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'app.js'), 'module.exports = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo, stdio: 'ignore' });
    const priorHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const evidence = localEvidence({ headSha: priorHead });
    const base = evidence.lanes.find(lane => lane.id === 'code-quality');
    const laneFor = id => ({
      ...base,
      id,
      summary: `${id} reviewed`,
      artifacts: [{ kind: 'json', path: `.qube/aie/reviews/93/12/${priorHead}/${id}.json`, sha256: null }],
      promptStack: promptStackForLane(id),
      runnerProvenance: { ...base.runnerProvenance, promptStackHash: promptStackHash(promptStackForLane(id)) },
      contextReviewed: [
        { kind: 'agents', source: 'AGENTS.md', trust: 'policy', freshness: 'current' },
        { kind: 'diff', source: 'git diff origin/main...HEAD', trust: 'local-evidence', freshness: 'current' },
      ],
      toolsUsed: ['codex'],
    });
    evidence.lanes = [laneFor('performance'), laneFor('task-record-compliance')];
    writeLocalEvidence(repo, evidence);
    writeFileSync(join(repo, 'CLAUDE.md'), 'updated machine instructions\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'instructions only'], { cwd: repo, stdio: 'ignore' });
    const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const { exec } = makePrExec({ prViews: [cleanLocalPr({ headRefOid: currentHead })] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec });

    const performance = result.localReviewRunner.lanes.find(lane => lane.lane === 'performance');
    const taskRecord = result.localReviewRunner.lanes.find(lane => lane.lane === 'task-record-compliance');
    const issueCompliance = result.localReviewRunner.lanes.find(lane => lane.lane === 'issue-compliance');
    assert.equal(performance.status, 'completed');
    assert.match(performance.summary, /Carried forward from approved review at/);
    assert.notEqual(taskRecord.status, 'completed');
    assert.doesNotMatch(taskRecord.summary, /Carried forward/);
    assert.notEqual(issueCompliance.status, 'completed');
    assert.doesNotMatch(issueCompliance.summary, /Carried forward/);
  });

  it('reruns config-mode lanes on a configuration delta while scope-mode lanes carry forward', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    config.reviewLanes = [
      { id: 'performance', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
      { id: 'security', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
      { id: 'issue-compliance', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
    ];
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'app.js'), 'module.exports = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo, stdio: 'ignore' });
    const priorHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const evidence = localEvidence({ headSha: priorHead });
    const base = evidence.lanes.find(lane => lane.id === 'code-quality');
    const laneFor = id => ({
      ...base,
      id,
      summary: `${id} reviewed`,
      artifacts: [{ kind: 'json', path: `.qube/aie/reviews/93/12/${priorHead}/${id}.json`, sha256: null }],
      promptStack: promptStackForLane(id),
      runnerProvenance: { ...base.runnerProvenance, promptStackHash: promptStackHash(promptStackForLane(id)) },
      contextReviewed: [
        { kind: 'agents', source: 'AGENTS.md', trust: 'policy', freshness: 'current' },
        { kind: 'diff', source: 'git diff origin/main...HEAD', trust: 'local-evidence', freshness: 'current' },
      ],
      toolsUsed: ['codex'],
    });
    evidence.lanes = [laneFor('performance'), laneFor('security')];
    writeLocalEvidence(repo, evidence);
    mkdirSync(join(repo, '.qube', 'aie'), { recursive: true });
    writeFileSync(join(repo, '.qube', 'aie', 'config.json'), '{"version":1}\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'config only'], { cwd: repo, stdio: 'ignore' });
    const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const { exec } = makePrExec({ prViews: [cleanLocalPr({ headRefOid: currentHead })] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec });

    const performance = result.localReviewRunner.lanes.find(lane => lane.lane === 'performance');
    const security = result.localReviewRunner.lanes.find(lane => lane.lane === 'security');
    const issueCompliance = result.localReviewRunner.lanes.find(lane => lane.lane === 'issue-compliance');
    assert.equal(performance.status, 'completed');
    assert.match(performance.summary, /Carried forward from approved review at/);
    assert.notEqual(security.status, 'completed');
    assert.doesNotMatch(security.summary, /Carried forward/);
    assert.notEqual(issueCompliance.status, 'completed');
    assert.doesNotMatch(issueCompliance.summary, /Carried forward/);
  });

  it('rejects tampered head-mismatched carried evidence under scoped invalidation', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    config.reviewLanes = [
      { id: 'performance', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
    ];
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'app.js'), 'module.exports = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo, stdio: 'ignore' });
    const priorHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const evidence = localEvidence({ headSha: priorHead });
    const base = evidence.lanes.find(lane => lane.id === 'code-quality');
    evidence.lanes = [{
      ...base,
      id: 'performance',
      summary: 'performance reviewed',
      artifacts: [{ kind: 'json', path: `.qube/aie/reviews/93/12/${priorHead}/performance.json`, sha256: null }],
      promptStack: promptStackForLane('performance'),
      runnerProvenance: { ...base.runnerProvenance, promptStackHash: promptStackHash(promptStackForLane('performance')) },
      contextReviewed: [
        { kind: 'agents', source: 'AGENTS.md', trust: 'policy', freshness: 'current' },
        { kind: 'diff', source: 'git diff origin/main...HEAD', trust: 'local-evidence', freshness: 'current' },
      ],
      toolsUsed: ['codex'],
    }];
    writeLocalEvidence(repo, evidence);
    writeFileSync(join(repo, 'CLAUDE.md'), 'updated machine instructions\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'instructions only'], { cwd: repo, stdio: 'ignore' });
    const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const firstRun = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec: makePrExec({ prViews: [cleanLocalPr({ headRefOid: currentHead })] }).exec });
    assert.equal(firstRun.localReview.status, 'passed');
    const carriedPath = join(repo, '.qube', 'aie', 'reviews', '93', '12', currentHead, 'performance.json');
    const carried = JSON.parse(readFileSync(carriedPath, 'utf8'));
    carried.carriedForward.fromHeadSha = 'f'.repeat(40);
    writeFileSync(carriedPath, `${JSON.stringify(carried, null, 2)}\n`);

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec: makePrExec({ prViews: [cleanLocalPr({ headRefOid: currentHead })] }).exec });

    assert.notEqual(result.localReview.status, 'passed');
    const blockers = result.localReview.evidence.flatMap(entry => entry.blockers).join(' ');
    assert.match(blockers, /carried-forward|prior head|prior approved/i);
  });

  it('carries forward with non-empty risk card activation when prior fragment identity matches', async () => {
    const { formatRiskCardReviewerFragment, selectRiskCards } = require('../dist/risk_cards/index.js');
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    config.reviewLanes = [
      { id: 'code-quality', required: 'always', match: ['src/**'], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host', rereview: 'delta' },
    ];
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'app.js'), 'module.exports = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo, stdio: 'ignore' });
    const priorHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

    const issueBody = 'status success failed provider capability fixture test oracle';
    const prTitle = 'Review me';
    const riskCardIssueText = `${prTitle}\nIssue 93\n${issueBody}`;
    const changedPaths = ['src/app.js', 'notes.md'];
    const cards = selectRiskCards({ issueText: riskCardIssueText, paths: changedPaths });
    assert.ok(cards.length > 0, 'fixture must activate risk cards');
    const fragments = cards.map(card => formatRiskCardReviewerFragment(card));
    const cardStack = promptStack('code-quality', [`Run local review lane code-quality.`], fragments).promptStack.map(fragment => ({
      id: fragment.id,
      source: fragment.source,
      sourceCategory: fragment.sourceCategory,
      path: fragment.path,
      sha256: fragment.sha256,
      trust: fragment.trust,
    }));

    const evidence = localEvidence({ headSha: priorHead });
    evidence.lanes = evidence.lanes.filter(lane => lane.id === 'code-quality').map(lane => ({
      ...lane,
      promptStack: cardStack,
      artifacts: [{ kind: 'json', path: `.qube/aie/reviews/93/12/${priorHead}/code-quality.json`, sha256: null }],
      contextReviewed: [
        { kind: 'agents', source: 'AGENTS.md', trust: 'policy', freshness: 'current' },
        { kind: 'diff', source: 'git diff origin/main...HEAD', trust: 'local-evidence', freshness: 'current' },
      ],
      toolsUsed: ['codex'],
    }));
    writeLocalEvidence(repo, evidence);
    writeFileSync(join(repo, 'notes.md'), 'release notes\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'docs only'], { cwd: repo, stdio: 'ignore' });
    const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const { exec } = makePrExec({
      prViews: [cleanLocalPr({ headRefOid: currentHead, title: prTitle })],
      issueBodies: { 93: issueBody },
    });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec });

    const carried = result.localReviewRunner.lanes.find(lane => lane.lane === 'code-quality');
    assert.equal(carried.status, 'completed');
    assert.match(carried.summary, /Carried forward from approved review at/);
    assert.ok(carried.promptFragmentIds.some(id => id.startsWith('command-supplied:')));
    const carriedEvidence = JSON.parse(readFileSync(join(repo, '.qube', 'aie', 'reviews', '93', '12', currentHead, 'code-quality.json'), 'utf8'));
    assert.equal(carriedEvidence.carriedForward.fromHeadSha, priorHead);
    assert.equal(result.localReview.status, 'passed');
  });

  it('reruns a delta lane when review configuration changed in the head delta', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    config.reviewLanes = [
      { id: 'code-quality', required: 'always', match: ['src/**'], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host', carryForwardContext: 'config' },
    ];
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'app.js'), 'module.exports = 1;\n');
    mkdirSync(join(repo, '.qube', 'aie'), { recursive: true });
    writeFileSync(join(repo, '.qube', 'aie', 'config.json'), '{"version":1}\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo, stdio: 'ignore' });
    const priorHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const evidence = localEvidence({ headSha: priorHead });
    evidence.lanes = evidence.lanes.filter(lane => lane.id === 'code-quality');
    writeLocalEvidence(repo, evidence);
    writeFileSync(join(repo, '.qube', 'aie', 'config.json'), '{"version":1,"policy":{}}\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'review config change'], { cwd: repo, stdio: 'ignore' });
    const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const { exec } = makePrExec({ prViews: [cleanLocalPr({ headRefOid: currentHead })] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec });

    const lane = result.localReviewRunner.lanes.find(entry => entry.lane === 'code-quality');
    assert.equal(lane.status, 'pending');
    assert.equal(existsSync(join(repo, '.qube', 'aie', 'reviews', '93', '12', currentHead, 'code-quality.json')), false);
  });

  it('reruns a delta lane when review context instructions changed in the head delta', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    config.reviewLanes = [
      { id: 'code-quality', required: 'always', match: ['src/**'], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host', carryForwardContext: 'all' },
    ];
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'app.js'), 'module.exports = 1;\n');
    writeFileSync(join(repo, 'AGENTS.md'), '# instructions\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo, stdio: 'ignore' });
    const priorHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const evidence = localEvidence({ headSha: priorHead });
    evidence.lanes = evidence.lanes.filter(lane => lane.id === 'code-quality');
    writeLocalEvidence(repo, evidence);
    writeFileSync(join(repo, 'AGENTS.md'), '# instructions changed\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'update instructions'], { cwd: repo, stdio: 'ignore' });
    const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const { exec } = makePrExec({ prViews: [cleanLocalPr({ headRefOid: currentHead })] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec });

    const lane = result.localReviewRunner.lanes.find(entry => entry.lane === 'code-quality');
    assert.equal(lane.status, 'pending');
    assert.equal(existsSync(join(repo, '.qube', 'aie', 'reviews', '93', '12', currentHead, 'code-quality.json')), false);
  });

  it('reruns a delta lane when the current lane runner does not match the prior evidence adapter', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    config.localReviewAgents = ['local-command'];
    config.reviewLanes = [
      { id: 'code-quality', required: 'always', match: ['src/**'], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-command', command: 'review-fixture' },
    ];
    trustReviewCommands(repo);
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'app.js'), 'module.exports = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo, stdio: 'ignore' });
    const priorHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const evidence = localEvidence({ headSha: priorHead });
    evidence.lanes = evidence.lanes.filter(lane => lane.id === 'code-quality');
    writeLocalEvidence(repo, evidence);
    writeFileSync(join(repo, 'notes.md'), 'release notes\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'docs only'], { cwd: repo, stdio: 'ignore' });
    const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const { exec } = makePrExec({ prViews: [cleanLocalPr({ headRefOid: currentHead })] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec });

    const currentEvidencePath = join(repo, '.qube', 'aie', 'reviews', '93', '12', currentHead, 'code-quality.json');
    if (existsSync(currentEvidencePath)) {
      const written = JSON.parse(readFileSync(currentEvidencePath, 'utf8'));
      assert.equal(written.carriedForward, undefined);
    }
  });

  it('skips provider publishing for carried evidence when the carry-forward publish policy is none', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    config.reviewCarryForwardPublish = 'none';
    const evidence = localEvidence();
    evidence.lanes = evidence.lanes.map(lane => ({
      ...lane,
      contextReviewed: [
        { kind: 'agents', source: 'AGENTS.md', trust: 'policy', freshness: 'current' },
        { kind: 'diff', source: 'git diff origin/main...HEAD', trust: 'local-evidence', freshness: 'current' },
      ],
      toolsUsed: ['codex'],
    }));
    writeLocalEvidence(repo, evidence);
    const carriedTarget = join(repo, '.qube', 'aie', 'reviews', '93', '12', 'def456');
    mkdirSync(carriedTarget, { recursive: true });
    const priorLane = JSON.parse(readFileSync(join(repo, '.qube', 'aie', 'reviews', '93', '12', 'abc123', 'code-quality.json'), 'utf8'));
    const carriedLane = { ...priorLane, headSha: 'def456', carriedForward: { fromHeadSha: 'abc123', deltaSummary: 'no scope paths changed' } };
    writeFileSync(join(carriedTarget, 'code-quality.json'), `${JSON.stringify(carriedLane, null, 2)}\n`);
    const { exec } = makePrExec({ prViews: [cleanLocalPr({ headRefOid: 'def456' })] });

    const result = await runPrReviewPublishService(config, { prNumber: 12, issueNumber: 93, headSha: 'def456', lane: 'code-quality', dryRun: true, repoRoot: repo, exec });

    assert.equal(result.publish.status, 'skipped');
    assert.match(result.publish.nextAction, /Carried-forward lane publishing is disabled by policy/);
  });

  it('reruns lanes with an always-rerun policy instead of carrying forward', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    config.reviewLanes = [
      { id: 'code-quality', required: 'always', match: ['src/**'], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host', rereview: 'always-rerun' },
    ];
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'app.js'), 'module.exports = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo, stdio: 'ignore' });
    const priorHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const evidence = localEvidence({ headSha: priorHead });
    evidence.lanes = evidence.lanes.filter(lane => lane.id === 'code-quality');
    writeLocalEvidence(repo, evidence);
    writeFileSync(join(repo, 'notes.md'), 'release notes\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'docs only'], { cwd: repo, stdio: 'ignore' });
    const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const { exec } = makePrExec({ prViews: [cleanLocalPr({ headRefOid: currentHead })] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec });

    const lane = result.localReviewRunner.lanes.find(entry => entry.lane === 'code-quality');
    assert.equal(lane.status, 'pending');
    assert.equal(existsSync(join(repo, '.qube', 'aie', 'reviews', '93', '12', currentHead, 'code-quality.json')), false);
  });

  it('reruns a delta lane when the head delta touches its scope', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    config.reviewLanes = [
      { id: 'code-quality', required: 'always', match: ['src/**'], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
    ];
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'app.js'), 'module.exports = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo, stdio: 'ignore' });
    const priorHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const evidence = localEvidence({ headSha: priorHead });
    evidence.lanes = evidence.lanes.filter(lane => lane.id === 'code-quality');
    writeLocalEvidence(repo, evidence);
    writeFileSync(join(repo, 'src', 'app.js'), 'module.exports = 2;\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'change lane scope'], { cwd: repo, stdio: 'ignore' });
    const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const { exec } = makePrExec({ prViews: [cleanLocalPr({ headRefOid: currentHead })] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec });

    const lane = result.localReviewRunner.lanes.find(entry => entry.lane === 'code-quality');
    assert.equal(lane.status, 'pending');
    assert.equal(existsSync(join(repo, '.qube', 'aie', 'reviews', '93', '12', currentHead, 'code-quality.json')), false);
  });

  it('keeps lane verdicts lane-scoped when gate-level CI is red', async () => {
    const repo = makeGitRepo();
    const config = localCommandConfig();
    trustReviewCommands(repo);
    const failingPr = cleanLocalPr({
      statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/example/repo/actions/runs/100/job/1' }],
    });
    const { exec } = makePrExec({
      prViews: [failingPr],
      localCommand: args => {
        const result = fixtureLocalCommand(args);
        const body = JSON.parse(result.stdout);
        body.preconditions = ['ci check failing at review time'];
        return { ...result, stdout: JSON.stringify(body) };
      },
    });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec });

    assert.equal(result.localReview.status, 'passed');
    const lanes = result.localReview.evidence[0].lanes;
    assert.ok(lanes.length > 0);
    assert.ok(lanes.every(lane => lane.recommendation === 'approve'));
    assert.ok(lanes.every(lane => lane.preconditions.includes('ci check failing at review time')));
    assert.notEqual(result.status, 'complete');
  });

  it('publishes local-command review results as provider-visible PR feedback', async () => {
    const repo = makeGitRepo();
    const config = localCommandConfig();
    trustReviewCommands(repo);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = [];
    config.reviewWaitMinutes = 0;
    const approvedPr = approvedLocalPr({ reviewDecision: 'APPROVED' });
    const { exec, calls } = makePrExec({
      prViews: [approvedPr, approvedPr],
      localCommand: args => {
        const result = fixtureLocalCommand(args);
        const body = JSON.parse(result.stdout);
        if (body.lane === 'code-quality') {
          body.summary = 'Reviewed C:\\Users\\executor\\secret repo\\src\\parser.ts, \\\\server\\share\\private file.txt, and /home/executor/repo/src/parser.ts';
          body.blockers = ['Inspect C:\\Users\\executor\\secret repo\\.env and /tmp/private-token.txt before publish'];
        }
        return { ...result, stdout: JSON.stringify(body) };
      },
    });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec });

    assert.equal(result.localReviewRunner.status, 'completed');
    assert.equal(result.localReview.status, 'passed');
    assert.equal(result.localReviewPublish.status, 'disabled');
    assert.match(result.localReviewPublish.nextAction, /pr review publish/);
    assert.equal(result.status, 'complete');
    assert.equal(calls.some(args => args[0] === 'pr' && args[1] === 'comment' && String(args[4] ?? '').includes('qube-local-review')), false);
  });

  it('keeps mixed dry-run pending when provider-visible local review publishing is only planned', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = [];
    config.reviewWaitMinutes = 0;
    writeLocalEvidence(repo, localEvidence(), { reviewDecision: 'APPROVED' });
    await alignLocalEvidencePromptHashes(repo, config, makePrExec({ prViews: [cleanLocalPr({ reviewDecision: 'APPROVED' })] }).exec);
    const { exec } = makePrExec({ prViews: [cleanLocalPr({ reviewDecision: 'APPROVED' })] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec });

    assert.equal(result.localReview.status, 'passed');
    assert.equal(result.localReviewPublish.status, 'disabled');
    assert.equal(result.status, 'pending');
    assert.match(result.nextAction, /QUBEReview|lane reviews received|pr review publish/);
  });

  it('does not mutate digest-bound local-host evidence when publishing provider feedback', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = [];
    config.reviewWaitMinutes = 0;
    writeLocalEvidence(repo, localEvidence(), { reviewDecision: 'APPROVED' });
    await alignLocalEvidencePromptHashes(repo, config, makePrExec({ prViews: [approvedLocalPr({ reviewDecision: 'APPROVED' })] }).exec);
    const lanePath = join(repo, '.qube', 'aie', 'reviews', '93', '12', 'abc123', 'code-quality.json');
    const originalLane = JSON.parse(readFileSync(lanePath, 'utf8'));
    const originalHash = localReviewEvidenceSha256(originalLane);
    const fixture = makePrExec({ prViews: [approvedLocalPr(), approvedLocalPr()] });

    const published = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec: fixture.exec });
    const laneAfterPublish = JSON.parse(readFileSync(lanePath, 'utf8'));

    assert.equal(published.localReview.status, 'passed');
    assert.equal(published.localReviewPublish.status, 'disabled');
    assert.equal(localReviewEvidenceSha256(laneAfterPublish), originalHash);
    assert.equal(laneAfterPublish.runnerProvenance.providerPublishStatus, null);
    assert.equal(published.status, 'complete');
  });

  it('does not complete when published local review feedback is not visible after provider reload', async () => {
    const repo = makeGitRepo();
    const config = localCommandConfig();
    trustReviewCommands(repo);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = [];
    config.reviewWaitMinutes = 0;
    const { exec } = makePrExec({ prViews: [approvedLocalPr(), approvedLocalPr()] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec });

    assert.equal(result.localReviewPublish.status, 'disabled');
    assert.equal(result.status, 'complete');
  });

  it('does not accept matching local review metadata from another author as publish visibility', async () => {
    const repo = makeGitRepo();
    const config = localReviewConfig();
    const pr = approvedLocalPr({
      reviewDecision: 'APPROVED',
      comments: [qubeReviewRequestComment(), localReviewComment({ recommendation: 'approve', status: 'passed' })],
    });
    pr.comments[1].author = { login: 'attacker' };
    const { exec } = makePrExec({ prViews: [pr] });

    const result = await runPrGate(config, { prNumber: 12, dryRun: true, exec });

    assert.equal(result.localReviewPublish.status, 'disabled');
    assert.equal(result.status, 'pending');
    assert.match(result.nextAction, /QUBEReview|lane reviews received/);
  });

  it('surfaces current-head QUBE local review comments in PR view feedback', async () => {
    const pr = cleanLocalPr({
      reviewDecision: 'APPROVED',
      comments: [localReviewComment({ recommendation: 'approve', status: 'passed', summary: 'all local lanes passed' })],
    });
    const { exec } = makePrExec({ prViews: [pr] });

    const result = await runPrViewService({ prNumber: 12, exec });

    assert.equal(result.feedback.length, 1);
    assert.equal(result.feedback[0].source, 'comment');
    assert.equal(result.feedback[0].author, 'executor');
    assert.equal(result.feedback[0].state, 'APPROVED');
    assert.match(result.feedback[0].summary, /QUBE local review approve/);
  });

  it('blocks PR gates on provider-visible QUBE local review requested changes', async () => {
    const config = getDefaults();
    config.reviewAgents = [];
    const pr = cleanLocalPr({
      reviewDecision: 'APPROVED',
      comments: [localReviewComment({ recommendation: 'request-changes', status: 'failed', summary: 'local review found blockers', findings: '- Fix unsafe parser' })],
    });
    const { exec } = makePrExec({ prViews: [pr] });

    const result = await runPrGate(config, { prNumber: 12, dryRun: true, exec });

    assert.equal(result.status, 'failed');
    assert.equal(result.feedback[0].state, 'CHANGES_REQUESTED');
    assert.match(result.nextAction, /address review feedback/);
  });

  it('does not suppress spoofed QUBE local review marker comments', async () => {
    const pr = cleanLocalPr({
      comments: [{ ...localReviewComment({ recommendation: 'approve', status: 'passed' }), author: { login: 'attacker' } }],
    });
    const { exec } = makePrExec({ prViews: [pr] });

    const result = await runPrViewService({ prNumber: 12, exec });

    assert.equal(result.feedback.length, 1);
    assert.equal(result.feedback[0].author, 'attacker');
    assert.equal(result.feedback[0].state, undefined);
    assert.match(result.feedback[0].summary, /QUBE local review: approve/);
  });

  it('does not let QUBE local review markers from another publisher account set review state', async () => {
    const config = getDefaults();
    config.reviewAgents = [];
    const pr = cleanLocalPr({
      reviewDecision: 'APPROVED',
      comments: [{ ...localReviewComment({ recommendation: 'request-changes', status: 'failed', summary: 'other runner found blockers' }), author: { login: 'review-runner' } }],
    });
    const { exec } = makePrExec({ prViews: [pr] });

    const result = await runPrGate(config, { prNumber: 12, dryRun: true, exec });

    assert.equal(result.status, 'complete');
    assert.equal(result.feedback[0].author, 'review-runner');
    assert.equal(result.feedback[0].state, undefined);
  });

  it('supersedes stale-head QUBE local review feedback with current-head feedback', async () => {
    const config = getDefaults();
    config.reviewAgents = [];
    const pr = cleanLocalPr({
      reviewDecision: 'APPROVED',
      comments: [
        localReviewComment({ head: 'oldsha', recommendation: 'request-changes', status: 'failed', runId: 'old-run', summary: 'old head failed' }),
        localReviewComment({ head: 'abc123', recommendation: 'approve', status: 'passed', runId: 'new-run', summary: 'current head passed' }),
      ],
    });
    const { exec } = makePrExec({ prViews: [pr] });

    const result = await runPrGate(config, { prNumber: 12, dryRun: true, exec });

    assert.equal(result.status, 'complete');
    assert.equal(result.feedback.length, 1);
    assert.equal(result.feedback[0].state, 'APPROVED');
    assert.equal(result.feedback.some(item => item.state === 'CHANGES_REQUESTED'), false);
  });

  it('does not approve provider-first local review from incomplete provider metadata', async () => {
    const repo = makeGitRepo();
    const config = localReviewConfig();
    writeLocalEvidence(repo, localEvidence(), { reviewDecision: 'APPROVED' });
    const pr = approvedLocalPr({
      reviewDecision: 'APPROVED',
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      comments: [qubeReviewRequestComment(), localReviewComment({ lanes: ['issue-compliance'], runId: 'incomplete-lanes' })],
    });
    const { exec } = makePrExec({ prViews: [pr] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, dryRun: true, exec });

    assert.equal(result.localReview.status, 'passed');
    assert.equal(result.localReviewPublish.status, 'disabled');
    assert.equal(result.status, 'pending');
    assert.match(result.nextAction, /QUBEReview|lane reviews received|pr review publish/);
  });

  it('keeps PR gates unavailable when provider publishing fails', async () => {
    const repo = makeGitRepo();
    const config = localCommandConfig();
    trustReviewCommands(repo);
    config.reviewAdapter = 'mixed';
    config.reviewAgents = [];
    config.reviewWaitMinutes = 0;
    const { exec } = makePrExec({ prViews: [approvedLocalPr(), approvedLocalPr()] });

    const result = await runPrGate(config, { prNumber: 12, repoRoot: repo, exec });

    assert.equal(result.localReview.status, 'passed');
    assert.equal(result.localReviewPublish.status, 'disabled');
    assert.equal(result.status, 'complete');
  });

  it('reports local review publishing as skipped when no linked issues are available during dry-run', async () => {
    const { exec } = makePrExec({ prViews: [cleanLocalPr({ closingIssuesReferences: [] })] });
    const provider = createGitHubReviewForgeProvider({ exec });
    const snapshot = await provider.loadPullRequestReview(12);

    const result = await provider.publishLocalReviewFeedback(snapshot.item, {
      enabled: true,
      dryRun: true,
      prNumber: 12,
      headSha: 'abc123',
      profile: 'local-standard',
      status: 'passed',
      recommendation: 'approve',
      runner: 'local-command',
      host: 'local-command',
      evidencePath: null,
      issueNumbers: [],
      lanes: [],
      summary: 'local review passed',
      findings: [],
    });

    assert.equal(result.status, 'skipped');
    assert.match(result.nextAction, /No linked issue numbers/);
  });

  it('reports local review publishing as skipped during dry-run when the run is already published', async () => {
    const input = {
      enabled: true,
      dryRun: true,
      prNumber: 12,
      headSha: 'abc123',
      profile: 'local-standard',
      status: 'passed',
      recommendation: 'approve',
      runner: 'local-command',
      host: 'local-command',
      evidencePath: '.qube/aie/reviews/93/12/abc123',
      issueNumbers: [93],
      lanes: ['task-record-compliance', 'issue-compliance', 'code-quality', 'tests-quality', 'manual-qa', 'final-gate'],
      summary: 'local review passed',
      findings: [],
    };
    const firstProvider = createGitHubReviewForgeProvider({ exec: makePrExec({ prViews: [cleanLocalPr()] }).exec });
    const firstSnapshot = await firstProvider.loadPullRequestReview(12);
    const planned = await firstProvider.publishLocalReviewFeedback(firstSnapshot.item, input);
    const { exec } = makePrExec({ prViews: [cleanLocalPr({ comments: [localReviewComment({ runId: planned.runId })] })] });
    const provider = createGitHubReviewForgeProvider({ exec });
    const snapshot = await provider.loadPullRequestReview(12);

    const result = await provider.publishLocalReviewFeedback(snapshot.item, input);

    assert.equal(planned.status, 'planned');
    assert.equal(result.status, 'skipped');
    assert.match(result.nextAction, /already published/);
  });

  it('uses runner and host in local review publish run ids', async () => {
    const input = {
      enabled: true,
      dryRun: true,
      prNumber: 12,
      headSha: 'abc123',
      profile: 'local-standard',
      status: 'passed',
      recommendation: 'approve',
      runner: 'local-command',
      host: 'local-command',
      evidencePath: '.qube/aie/reviews/93/12/abc123',
      issueNumbers: [93],
      lanes: ['task-record-compliance', 'issue-compliance', 'code-quality', 'tests-quality', 'manual-qa', 'final-gate'],
      summary: 'local review passed',
      findings: [],
    };
    const provider = createGitHubReviewForgeProvider({ exec: makePrExec({ prViews: [cleanLocalPr()] }).exec });
    const snapshot = await provider.loadPullRequestReview(12);

    const localCommand = await provider.publishLocalReviewFeedback(snapshot.item, input);
    const localHost = await provider.publishLocalReviewFeedback(snapshot.item, { ...input, runner: 'local-host', host: 'codex' });

    assert.equal(localCommand.status, 'planned');
    assert.equal(localHost.status, 'planned');
    assert.notEqual(localCommand.runId, localHost.runId);
    assert.match(localCommand.marker ?? '', /"runner":"local-command"/);
    assert.match(localHost.marker ?? '', /"runner":"local-host"/);
    assert.match(localHost.marker ?? '', /"host":"codex"/);
  });

  it('canonicalizes set-like local review publish metadata in run ids', async () => {
    const baseInput = {
      enabled: true,
      dryRun: true,
      prNumber: 12,
      headSha: 'abc123',
      profile: 'local-standard',
      status: 'passed',
      recommendation: 'approve',
      runner: 'local-command',
      host: 'local-command',
      evidencePath: '.qube/aie/reviews/93/12/abc123',
      issueNumbers: [94, 93, 93],
      lanes: ['final-gate', 'code-quality', 'issue-compliance', 'task-record-compliance', 'manual-qa', 'tests-quality', 'code-quality'],
      summary: 'local review passed',
      findings: [],
    };
    const provider = createGitHubReviewForgeProvider({ exec: makePrExec({ prViews: [cleanLocalPr()] }).exec });
    const snapshot = await provider.loadPullRequestReview(12);

    const unordered = await provider.publishLocalReviewFeedback(snapshot.item, baseInput);
    const ordered = await provider.publishLocalReviewFeedback(snapshot.item, {
      ...baseInput,
      issueNumbers: [93, 94],
      lanes: ['code-quality', 'final-gate', 'issue-compliance', 'manual-qa', 'task-record-compliance', 'tests-quality'],
    });

    assert.equal(unordered.status, 'planned');
    assert.equal(ordered.status, 'planned');
    assert.equal(unordered.runId, ordered.runId);
    assert.match(unordered.marker ?? '', /"issueNumbers":\[93,94\]/);
    assert.match(unordered.marker ?? '', /"lanes":\["code-quality","final-gate","issue-compliance","manual-qa","task-record-compliance","tests-quality"\]/);
    assert.match(unordered.body ?? '', /- issue #93\n- issue #94/);
    assert.match(unordered.body ?? '', /- lanes: code-quality, final-gate, issue-compliance, manual-qa, task-record-compliance, tests-quality/);
  });

  it('returns failed local review publishing results when gh comment execution throws', async () => {
    const fixture = makePrExec({ prViews: [cleanLocalPr()] });
    const exec = async args => {
      if (args[0] === 'pr' && args[1] === 'comment') throw new Error('network unavailable');
      return fixture.exec(args);
    };
    const provider = createGitHubReviewForgeProvider({ exec });
    const snapshot = await provider.loadPullRequestReview(12);

    const result = await provider.publishLocalReviewFeedback(snapshot.item, {
      enabled: true,
      dryRun: false,
      prNumber: 12,
      headSha: 'abc123',
      profile: 'local-standard',
      status: 'passed',
      recommendation: 'approve',
      runner: 'local-command',
      host: 'local-command',
      evidencePath: '.qube/aie/reviews/93/12/abc123',
      issueNumbers: [93],
      lanes: ['task-record-compliance', 'issue-compliance', 'code-quality', 'tests-quality', 'manual-qa', 'final-gate'],
      summary: 'local review passed',
      findings: [],
    });

    assert.equal(result.status, 'failed');
    assert.match(result.failure, /network unavailable/);
  });

  it('fails lane review publishing when required lane evidence is missing', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    const { exec } = makePrExec({ prViews: [cleanLocalPr()] });

    await assert.rejects(
      () => runPrReviewPublishService(config, { prNumber: 12, issueNumber: 93, lane: 'code-quality', dryRun: true, repoRoot: repo, exec }),
      /required local review lane evidence is missing or invalid/,
    );
  });

  it('publishes evidence-backed lane review dry-runs from current local-host evidence', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    const evidence = localEvidence();
    evidence.lanes = evidence.lanes.map(lane => ({
      ...lane,
      contextReviewed: [
        { kind: 'agents', source: 'AGENTS.md', trust: 'policy', freshness: 'current' },
        { kind: 'issue-body', source: 'https://github.com/example/repo/issues/93', trust: 'untrusted-task-input', freshness: 'current' },
        { kind: 'pr-body', source: 'https://github.com/example/repo/pull/12', trust: 'untrusted-task-input', freshness: 'current' },
        { kind: 'diff', source: 'git diff origin/main...HEAD', trust: 'local-evidence', freshness: 'current' },
      ],
      toolsUsed: ['codex'],
    }));
    writeLocalEvidence(repo, evidence);
    const { exec, calls } = makePrExec({ prViews: [cleanLocalPr()] });

    const result = await runPrReviewPublishService(config, { changedPaths: [], prNumber: 12, issueNumber: 93, lane: 'code-quality', dryRun: true, repoRoot: repo, exec });

    assert.equal(result.publish.status, 'planned');
    assert.equal(result.publish.publishKind, 'pull-request-review');
    assert.match(result.publish.body ?? '', /QUBE review \(code-quality\): approve/);
    assert.match(result.publish.body ?? '', /Completeness self-check:/);
    assert.match(result.publish.body ?? '', /Inspected the code-quality lane scope at this head/);
    assert.match(result.publish.body ?? '', /- evidence: \.qube\/aie\/reviews\/93\/12\/abc123\/code-quality\.json/);
    assert.ok(calls.some(call => call.join(' ') === `pr view 12 --json ${prViewFields}`));
    assert.equal(calls.some(call => call.join(' ') === 'pr diff 12 --patch'), false);
    assert.ok(calls.some(call => call.join(' ') === 'api repos/example/repo/issues/12/comments --method GET -F per_page=100 --paginate --slurp'));
    assert.equal(calls.some(call => call.join(' ') === 'api repos/example/repo/pulls/12/comments --method GET -F per_page=100 --paginate --slurp'), false);
    assert.equal(calls.some(call => call[0] === 'api' && call[1] === 'graphql'), false);
    assert.equal(calls.some(call => call[0] === 'api' && /^repos\/example\/repo\/commits\//.test(call[1] ?? '')), false);
  });

  it('rejects lane evidence publishing with mismatched recommendation and status', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    const evidence = localEvidence();
    evidence.lanes = evidence.lanes.map(lane => ({
      ...lane,
      recommendation: lane.id === 'code-quality' ? 'request-changes' : lane.recommendation,
      contextReviewed: [
        { kind: 'agents', source: 'AGENTS.md', trust: 'policy', freshness: 'current' },
        { kind: 'diff', source: 'git diff origin/main...HEAD', trust: 'local-evidence', freshness: 'current' },
      ],
      toolsUsed: ['codex'],
    }));
    writeLocalEvidence(repo, evidence);
    const { exec } = makePrExec({ prViews: [cleanLocalPr()] });

    await assert.rejects(
      () => runPrReviewPublishService(config, { prNumber: 12, issueNumber: 93, lane: 'code-quality', dryRun: true, repoRoot: repo, exec }),
      /recommendation request-changes is not valid with status passed/,
    );
  });

  it('rejects lane evidence publishing without a preconditions array', async () => {
    const repo = makeGitRepo();
    const config = localHostConfig(null);
    const evidence = localEvidence();
    evidence.lanes = evidence.lanes.map(lane => {
      const { preconditions, ...rest } = lane;
      return {
        ...rest,
        contextReviewed: [
          { kind: 'agents', source: 'AGENTS.md', trust: 'policy', freshness: 'current' },
          { kind: 'diff', source: 'git diff origin/main...HEAD', trust: 'local-evidence', freshness: 'current' },
        ],
        toolsUsed: ['codex'],
      };
    });
    writeLocalEvidence(repo, evidence);
    const { exec } = makePrExec({ prViews: [cleanLocalPr()] });

    await assert.rejects(
      () => runPrReviewPublishService(config, { prNumber: 12, issueNumber: 93, lane: 'code-quality', dryRun: true, repoRoot: repo, exec }),
      /preconditions must be an array of observed gate-level facts/,
    );
  });

});
