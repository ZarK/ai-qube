const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { describe, it } = require('node:test');

const {
  buildModelReviewPrompt,
  buildModelRouteInvocation,
  expectedCoverageAreas,
  isolatedRawOutputPath,
  modelRouteEnvironment,
  windowsPowerShellRouteEnvironment,
  runModelReview,
  runModelRouteProcess,
  resolveWindowsNodeShim,
  resolveModelReviewCheckoutState,
} = require('../dist/app/model_review_runner.js');

function reviewInput(repoRoot, host = 'grok-build') {
  return {
    plan: {
      host,
      tier: 'review',
      model: host === 'grok-build' ? 'grok-4.5' : 'gpt-5.6-luna',
      effort: host === 'codex' ? 'high' : null,
      isolation: 'read-only',
      timeoutSeconds: 60,
      maxTurns: 8,
      substitution: null,
    },
    repoRoot,
    lane: 'code-quality',
    issueNumber: 309,
    prNumber: 310,
    headSha: 'abc123',
    profile: 'local-focused',
    promptStackHash: 'hash123',
    promptText: 'INSPECT EXACT LANE PROMPT',
    promptStack: [{ id: 'review-lanes/code-quality', source: 'builtin', path: null, sha256: null, trust: 'policy' }],
    resolveHead: async () => 'abc123',
  };
}

function laneResult() {
  return {
    issueNumber: 309,
    prNumber: 310,
    headSha: 'abc123',
    lane: 'code-quality',
    status: 'passed',
    severity: 'none',
    recommendation: 'approve',
    summary: 'No blocking code-quality defects found.',
    blockers: [],
    findings: [],
    artifacts: [{ kind: 'command', path: 'command:git diff --check', sha256: null }],
    commands: ['git diff --check'],
    surfaces: ['routed review runner'],
    contextReviewed: [{ kind: 'diff', source: 'git diff', trust: 'local-evidence', freshness: 'current' }],
    toolsUsed: ['git'],
    completeness: 'Inspected the routed runner and its focused tests; no broad suite was run.',
    coverage: [{ area: 'code-quality', status: 'clear' }],
    preconditions: [],
  };
}

describe('model review runner', () => {
  it('executes a fake host with literal argument arrays, stdin fidelity, and Windows-safe paths', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'aie fake host '));
    const fakeHost = join(repoRoot, 'fake-host.cjs');
    writeFileSync(fakeHost, `let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { input += chunk; }); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input })));\n`);
    const args = [fakeHost, 'literal;separator', '$(not-a-command)', 'C:\\review path\\prompt.json'];
    const result = await runModelRouteProcess({
      executable: process.execPath,
      args,
      cwd: repoRoot,
      stdin: 'exact prompt bytes',
      promptPath: null,
      schemaPath: null,
      timeoutMs: 5_000,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.stdinDelivered, true);
    assert.deepEqual(JSON.parse(result.stdout), { args: args.slice(1), input: 'exact prompt bytes' });
  });

  it('does not inherit unrelated parent secrets in routed host processes', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'aie-fake-env-'));
    const fakeHost = join(repoRoot, 'fake-env.cjs');
    const secretName = 'QUBE_ROUTE_TEST_SECRET';
    writeFileSync(fakeHost, `process.stdout.write(JSON.stringify({ secret: process.env.${secretName} ?? null, path: process.env.PATH ?? null }));\n`);
    const previous = process.env[secretName];
    process.env[secretName] = 'must-not-reach-review-host';
    try {
      const result = await runModelRouteProcess({
        executable: process.execPath,
        args: [fakeHost],
        cwd: repoRoot,
        stdin: null,
        promptPath: null,
        schemaPath: null,
        timeoutMs: 5_000,
      });
      const routeEnvironment = modelRouteEnvironment();
      const routePathKey = Object.keys(routeEnvironment).find(key => key.toUpperCase() === 'PATH');
      assert.deepEqual(JSON.parse(result.stdout), { secret: null, path: routePathKey ? routeEnvironment[routePathKey] : null });
      assert.equal(modelRouteEnvironment({ [secretName]: 'hidden', PATH: 'kept', GH_TOKEN: 'hidden' }).PATH, 'kept');
      assert.equal(modelRouteEnvironment({ [secretName]: 'hidden', PATH: 'kept', GH_TOKEN: 'hidden' })[secretName], undefined);
      assert.equal(modelRouteEnvironment({ [secretName]: 'hidden', PATH: 'kept', GH_TOKEN: 'hidden' }).GH_TOKEN, undefined);
    } finally {
      if (previous === undefined) delete process.env[secretName];
      else process.env[secretName] = previous;
    }
  });

  it('removes incomplete PowerShell Core paths and requires a healthy Windows fallback', () => {
    const root = mkdtempSync(join(tmpdir(), 'aie-powershell-health-'));
    const broken = join(root, 'broken');
    const healthy = join(root, 'healthy');
    const systemRoot = join(root, 'windows');
    mkdirSync(broken, { recursive: true });
    mkdirSync(join(healthy, 'Modules', 'Microsoft.PowerShell.Management'), { recursive: true });
    mkdirSync(join(healthy, 'Modules', 'Microsoft.PowerShell.Utility'), { recursive: true });
    writeFileSync(join(broken, 'pwsh.exe'), '');
    writeFileSync(join(healthy, 'pwsh.exe'), '');
    writeFileSync(join(healthy, 'Modules', 'Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Management.psd1'), '');
    writeFileSync(join(healthy, 'Modules', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1'), '');

    const blocked = windowsPowerShellRouteEnvironment({ PATH: broken, SYSTEMROOT: systemRoot, PSModulePath: join(root, 'polluted-modules') });
    assert.equal(blocked.status, 'blocked');
    assert.deepEqual(blocked.removedPathEntries, [broken]);
    assert.match(blocked.diagnostic, /built-in module directory is incomplete/);
    assert.equal(blocked.environment.PATH, '');
    assert.equal(blocked.environment.PSModulePath, '');

    const fallbackDirectory = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0');
    mkdirSync(join(fallbackDirectory, 'Modules', 'Microsoft.PowerShell.Management'), { recursive: true });
    mkdirSync(join(fallbackDirectory, 'Modules', 'Microsoft.PowerShell.Utility'), { recursive: true });
    writeFileSync(join(fallbackDirectory, 'powershell.exe'), '');
    writeFileSync(join(fallbackDirectory, 'Modules', 'Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Management.psd1'), '');
    writeFileSync(join(fallbackDirectory, 'Modules', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1'), '');
    const fallback = windowsPowerShellRouteEnvironment({ PATH: `${broken};${root}`, SYSTEMROOT: systemRoot, PSModulePath: join(root, 'polluted-modules') });
    assert.equal(fallback.status, 'ready');
    assert.equal(fallback.environment.PATH, `${root};${fallbackDirectory}`);
    assert.equal(fallback.environment.PSModulePath, join(fallbackDirectory, 'Modules'));

    const completeCore = windowsPowerShellRouteEnvironment({ PATH: `${healthy};${root}`, SYSTEMROOT: join(root, 'missing') });
    assert.equal(completeCore.status, 'ready');
    assert.equal(completeCore.environment.PATH, `${healthy};${root}`);
    assert.equal(completeCore.environment.PSModulePath, join(healthy, 'Modules'));
  });

  it('terminates a fake host at the configured execution bound', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'aie-fake-timeout-'));
    const fakeHost = join(repoRoot, 'fake-timeout.cjs');
    writeFileSync(fakeHost, `setInterval(() => {}, 1_000);\n`);

    const result = await runModelRouteProcess({
      executable: process.execPath,
      args: [fakeHost],
      cwd: repoRoot,
      stdin: null,
      promptPath: null,
      schemaPath: null,
      timeoutMs: 100,
    });

    assert.equal(result.timedOut, true);
    assert.notEqual(result.exitCode, 0);
  });

  it('reports bounded process progress without changing the host envelope', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'aie-fake-progress-'));
    const fakeHost = join(repoRoot, 'fake-progress.cjs');
    writeFileSync(fakeHost, `setTimeout(() => process.stdout.write('done'), 350);\n`);
    const progress = [];

    const result = await runModelRouteProcess({
      executable: process.execPath,
      args: [fakeHost],
      cwd: repoRoot,
      stdin: null,
      promptPath: null,
      schemaPath: null,
      timeoutMs: 1_000,
      progressLabel: 'code-quality via fake-host',
      progressIntervalMs: 50,
      onProgress: event => progress.push(event),
    });

    assert.equal(result.stdout, 'done');
    assert.deepEqual(progress.map(event => event.phase), ['started', 'waiting', 'completed']);
    assert.ok(progress.every(event => event.label === 'code-quality via fake-host' && event.elapsedMs <= event.timeoutMs));
  });

  it('force-terminates a fake host that ignores graceful shutdown', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'aie-fake-hard-timeout-'));
    const fakeHost = join(repoRoot, 'fake-hard-timeout.cjs');
    writeFileSync(fakeHost, `process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);\n`);
    const startedAt = Date.now();

    const result = await runModelRouteProcess({
      executable: process.execPath,
      args: [fakeHost],
      cwd: repoRoot,
      stdin: null,
      promptPath: null,
      schemaPath: null,
      timeoutMs: 100,
    });

    assert.equal(result.timedOut, true);
    assert.notEqual(result.exitCode, 0);
    assert.ok(Date.now() - startedAt < 3_000);
  });

  it('keeps Codex prompt content on stdin and uses fixed read-only arguments', () => {
    const input = reviewInput('C:\\repo with spaces', 'codex');
    const prompt = buildModelReviewPrompt(input);
    const codexScript = 'C:\\npm path\\node_modules\\@openai\\codex\\bin\\codex.js';
    const schemaPath = 'C:\\repo with spaces\\.git\\qube\\aie\\model-route\\review.schema.json';
    const invocation = buildModelRouteInvocation(input, { executable: 'node.exe', prefixArgs: [codexScript] }, prompt, null, schemaPath);

    assert.equal(invocation.executable, 'node.exe');
    assert.equal(invocation.args[0], codexScript);
    assert.equal(invocation.stdin, prompt);
    assert.match(prompt, /at most 8 turns/);
    assert.match(prompt, /reserve the final turn/);
    assert.match(prompt, /If a PowerShell built-in module fails to load/);
    // The prompt must state the exact verdict-consistency and progress-snapshot
    // rules the strict validator enforces, or hosts fail on rules they never saw.
    assert.match(prompt, /Verdict consistency is validated after generation/);
    // The convergence contract: blockers need a violated criterion or an
    // introduced defect, and re-review rounds verify fixes instead of
    // re-opening the full surface.
    assert.match(prompt, /Blocker admissibility/);
    assert.match(prompt, /a diff does not need to be perfect/);
    assert.match(prompt, /endLine to at most line\+9/);
    assert.match(prompt, /Never put English instructions in suggestion/);
    assert.match(prompt, /do not re-open the full review surface/);
    assert.match(prompt, /Do not read any path under \.qube\/aie\/reviews\/\*\*/);
    assert.match(prompt, /Inspect the full current-head diff for this lane/);
    assert.match(prompt, /passed maps to approve/);
    assert.match(prompt, /keep blockers empty and severity below high/);
    assert.match(prompt, /Do not emit JSON progress, pending envelopes, or interim verdicts/);
    assert.equal(invocation.args.includes(prompt), false);
    assert.deepEqual(invocation.args.slice(-2), ['--json', '-']);
    assert.ok(invocation.args.includes('read-only'));
    assert.ok(invocation.args.includes('gpt-5.6-luna'));
    assert.ok(invocation.args.includes('model_reasoning_effort="high"'));
    assert.ok(invocation.args.includes('--ignore-user-config'));
    assert.ok(invocation.args.includes('--ignore-rules'));
    assert.ok(invocation.args.includes('read-only'));
    assert.ok(invocation.args.includes('--strict-config'));
    assert.ok(invocation.args.includes('shell_environment_policy.inherit=all'));
    assert.equal(invocation.args.includes('--approve-for-me'), false, '--approve-for-me cannot be combined with --sandbox');
    assert.equal(invocation.args.includes('sandbox_permissions=["disk-full-read-access"]'), false);
    assert.equal(
      invocation.args.includes('windows.sandbox="unelevated"'),
      process.platform === 'win32',
      'Windows isolated review must enable the unelevated sandbox backend after --ignore-user-config',
    );
    assert.ok(invocation.args.includes('multi_agent'));
    assert.ok(invocation.args.includes('mcp_servers={}'));
    assert.ok(invocation.args.includes('web_search="disabled"'));
    assert.equal(invocation.args[invocation.args.indexOf('--output-schema') + 1], schemaPath);
  });

  it('rejects routed artifacts that the gate and publish contract would reject', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'aie-routed-artifact-'));
    writeFileSync(join(repoRoot, 'README.md'), 'routed artifact fixture\n');
    const codexRun = result => runModelReview({
      ...reviewInput(repoRoot, 'codex'),
      resolveExecutable: async () => 'codex.exe',
      runProcess: async () => ({
        exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true,
        stdout: `${JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread' })}\n${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } })}\n`,
      }),
    });
    return (async () => {
      // terminal:/test-output: pseudo-paths are outside the shared artifact contract.
      const terminalArtifact = await codexRun({ ...laneResult(), artifacts: [{ kind: 'terminal', path: 'terminal:test run', sha256: null }] });
      assert.equal(terminalArtifact.evidence, null);
      assert.equal(terminalArtifact.reasonCode, 'model-route-contract-mismatch');
      const rawPath = isolatedRawOutputPath(repoRoot, 309, 310, 'abc123', 'code-quality');
      assert.equal(existsSync(rawPath), true);
      assert.match(terminalArtifact.error, /Raw output:/);
      assert.match(terminalArtifact.error, /\.raw-output\.json/);
      const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
      assert.equal(raw.headSha, 'abc123');
      assert.equal(raw.reasonCode, 'model-route-contract-mismatch');
      assert.ok(typeof raw.stdout === 'string' && raw.stdout.length > 0);
      // Uppercase digests are rejected exactly as laneArtifactViolation rejects them.
      const digest = createHash('sha256').update(readFileSync(join(repoRoot, 'README.md'))).digest('hex');
      const uppercaseDigest = await codexRun({ ...laneResult(), artifacts: [{ kind: 'source', path: 'README.md', sha256: digest.toUpperCase() }] });
      assert.equal(uppercaseDigest.evidence, null);
      assert.equal(uppercaseDigest.reasonCode, 'model-route-artifact-digest');
      // A command observation can never carry a content digest.
      const digestedCommand = await codexRun({ ...laneResult(), artifacts: [{ kind: 'command', path: 'command:git diff --check', sha256: digest }] });
      assert.equal(digestedCommand.evidence, null);
      assert.equal(digestedCommand.reasonCode, 'model-route-artifact-digest');
      // The exact lowercase digest still passes.
      const validDigest = await codexRun({ ...laneResult(), artifacts: [{ kind: 'source', path: 'README.md', sha256: digest }] });
      assert.notEqual(validDigest.evidence, null);
      assert.equal(validDigest.reasonCode, null);
    })();
  });

  it('routes Codex through a private strict schema file and removes it after execution', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'aie-codex-schema-'));
    const input = reviewInput(repoRoot, 'codex');
    let capturedSchemaPath = null;

    const result = await runModelReview({
      ...input,
      resolveExecutable: async () => 'codex.exe',
      runProcess: async invocation => {
        capturedSchemaPath = invocation.schemaPath;
        assert.equal(invocation.promptPath, null);
        assert.equal(existsSync(invocation.schemaPath), true);
        const schema = JSON.parse(readFileSync(invocation.schemaPath, 'utf8'));
        assert.equal(schema.properties.issueNumber.const, 309);
        assert.equal(schema.properties.issueNumber.type, 'integer');
        assert.equal(schema.properties.lane.const, 'code-quality');
        assert.equal(schema.properties.lane.type, 'string');
        assert.deepEqual(schema.properties.status.enum, ['passed', 'failed', 'needs-work', 'inconclusive']);
        assert.deepEqual(schema.properties.recommendation.enum, ['approve', 'request-changes', 'inconclusive']);
        assert.deepEqual(schema.properties.findings.items.required, ['id', 'severity', 'message', 'suggestion', 'location', 'confidence']);
        assert.deepEqual(schema.properties.findings.items.properties.confidence, { anyOf: [{ type: 'number', minimum: 0, maximum: 1 }, { type: 'null' }] });
        assert.deepEqual(schema.properties.artifacts.items.required, ['kind', 'path', 'sha256']);
        assert.deepEqual(schema.properties.artifacts.items.properties.sha256, { type: 'null' });
        assert.equal(invocation.args[invocation.args.indexOf('--output-schema') + 1], invocation.schemaPath);
        return {
          exitCode: 0,
          stderr: '',
          timedOut: false,
          stdinDelivered: true,
          stdout: `${JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread' })}\n${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(laneResult()) } })}\n`,
        };
      },
    });

    assert.equal(result.error, null);
    assert.equal(result.evidence.runnerProvenance.sessionId, 'codex-thread');
    assert.equal(result.evidence.modelTier, 'review');
    assert.equal(result.evidence.usage, undefined);
    assert.equal(existsSync(capturedSchemaPath), false);
  });

  it('records host-reported usage on routed evidence and omits it when the host reports none', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'aie-usage-'));
    const withUsage = await runModelReview({
      ...reviewInput(repoRoot, 'codex'),
      resolveExecutable: async () => 'codex.exe',
      runProcess: async () => ({
        exitCode: 0,
        stderr: '',
        timedOut: false,
        stdinDelivered: true,
        stdout: [
          JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread' }),
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(laneResult()) } }),
          JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 40, output_tokens: 9 } }),
        ].join('\n'),
      }),
    });
    assert.equal(withUsage.error, null);
    assert.deepEqual(withUsage.evidence.usage, { inputTokens: 40, outputTokens: 9 });
    assert.equal(withUsage.evidence.modelTier, 'review');

    const withoutUsage = await runModelReview({
      ...reviewInput(repoRoot, 'grok-build'),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({
        exitCode: 0,
        stderr: '',
        timedOut: false,
        stdinDelivered: true,
        stdout: JSON.stringify({ text: JSON.stringify(laneResult()), sessionId: 'grok-session' }),
      }),
    });
    assert.equal(withoutUsage.error, null);
    assert.equal(withoutUsage.evidence.usage, undefined);
    assert.ok(!Object.hasOwn(withoutUsage.evidence, 'usage'));
  });

  it('classifies a Codex policy-blocked git inspection as a host fault, not a contract mismatch', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'aie-codex-policy-'));
    const result = await runModelReview({
      ...reviewInput(repoRoot, 'codex'),
      resolveExecutable: async () => 'codex.exe',
      runProcess: async () => ({
        exitCode: 1,
        stderr: 'rejected: blocked by policy\ngit rev-parse HEAD',
        timedOut: false,
        stdinDelivered: true,
        stdout: '',
      }),
    });
    assert.equal(result.evidence, null);
    assert.equal(result.reasonCode, 'model-route-policy-blocked');
    assert.match(result.error, /fails over to the configured second host/);
  });

  it('does not treat review prose that quotes a policy block as a host fault', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'aie-grok-policy-quote-'));
    const quoted = {
      ...laneResult(),
      summary: 'The host reported rejected: blocked by policy for git rev-parse on a prior Codex run; this Grok lane inspected the checkout.',
    };
    const result = await runModelReview({
      ...reviewInput(repoRoot, 'grok-build'),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({
        exitCode: 0,
        stderr: '',
        timedOut: false,
        stdinDelivered: true,
        stdout: JSON.stringify({ text: JSON.stringify(quoted), sessionId: 'grok-session' }),
      }),
    });
    assert.equal(result.reasonCode, null);
    assert.notEqual(result.evidence, null);
    assert.equal(result.evidence.status, 'passed');
  });

  it('does not treat policy text in successful command output as a host fault', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'aie-codex-policy-source-'));
    const result = await runModelReview({
      ...reviewInput(repoRoot, 'codex'),
      resolveExecutable: async () => 'codex.exe',
      runProcess: async () => ({
        exitCode: 0,
        stderr: '',
        timedOut: false,
        stdinDelivered: true,
        stdout: [
          JSON.stringify({ type: 'thread.started', thread_id: 'codex-source' }),
          JSON.stringify({
            type: 'item.completed',
            item: {
              type: 'command_execution',
              exit_code: 0,
              aggregated_output: 'diff output documents a prior blocked by policy failure',
            },
          }),
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(laneResult()) } }),
        ].join('\n'),
      }),
    });
    assert.equal(result.reasonCode, null);
    assert.notEqual(result.evidence, null);
    assert.equal(result.evidence.status, 'passed');
  });

  it('does not treat policy-matching source text from a failed inspection command as a host fault', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'aie-codex-policy-regex-'));
    const result = await runModelReview({
      ...reviewInput(repoRoot, 'codex'),
      resolveExecutable: async () => 'codex.exe',
      runProcess: async () => ({
        exitCode: 0,
        stderr: '',
        timedOut: false,
        stdinDelivered: true,
        stdout: [
          JSON.stringify({ type: 'thread.started', thread_id: 'codex-policy-regex' }),
          JSON.stringify({
            type: 'item.completed',
            item: {
              type: 'command_execution',
              exit_code: 1,
              aggregated_output: '721: return /blocked by policy|rejected:\\s*blocked/i.test(inspectionPolicyHaystack(result));',
            },
          }),
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(laneResult()) } }),
        ].join('\n'),
      }),
    });
    assert.equal(result.reasonCode, null);
    assert.notEqual(result.evidence, null);
  });

  it('rejects a structured failed command that reports a policy block', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'aie-codex-policy-command-'));
    const result = await runModelReview({
      ...reviewInput(repoRoot, 'codex'),
      resolveExecutable: async () => 'codex.exe',
      runProcess: async () => ({
        exitCode: 0,
        stderr: '',
        timedOut: false,
        stdinDelivered: true,
        stdout: [
          JSON.stringify({ type: 'thread.started', thread_id: 'codex-policy-command' }),
          JSON.stringify({
            type: 'item.completed',
            item: {
              type: 'command_execution',
              exit_code: 1,
              aggregated_output: 'rejected: blocked by policy\ngit diff HEAD',
            },
          }),
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(laneResult()) } }),
        ].join('\n'),
      }),
    });
    assert.equal(result.evidence, null);
    assert.equal(result.reasonCode, 'model-route-policy-blocked');
  });

  it('does not accept a schema-valid Codex verdict when the host blocked git inspection', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'aie-codex-policy-valid-'));
    const result = await runModelReview({
      ...reviewInput(repoRoot, 'codex'),
      resolveExecutable: async () => 'codex.exe',
      runProcess: async () => ({
        exitCode: 0,
        stderr: 'rejected: blocked by policy\ngit diff HEAD',
        timedOut: false,
        stdinDelivered: true,
        stdout: `${JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread' })}\n${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(laneResult()) } })}\n`,
      }),
    });
    assert.equal(result.evidence, null);
    assert.equal(result.reasonCode, 'model-route-policy-blocked');
  });

  it('accepts a Codex lane that inspected git and returned a terminal verdict', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'aie-codex-git-ok-'));
    const inspected = {
      ...laneResult(),
      commands: ['git rev-parse HEAD', 'git diff'],
      artifacts: [
        { kind: 'command', path: 'command:git rev-parse HEAD', sha256: null },
        { kind: 'command', path: 'command:git diff', sha256: null },
      ],
    };
    const result = await runModelReview({
      ...reviewInput(repoRoot, 'codex'),
      resolveExecutable: async () => 'codex.exe',
      runProcess: async () => ({
        exitCode: 0,
        stderr: '',
        timedOut: false,
        stdinDelivered: true,
        stdout: `${JSON.stringify({ type: 'thread.started', thread_id: 'codex-git' })}\n${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(inspected) } })}\n`,
      }),
    });
    assert.equal(result.error, null);
    assert.equal(result.reasonCode, null);
    assert.notEqual(result.evidence, null);
    assert.equal(result.evidence.status, 'passed');
    assert.deepEqual(result.evidence.commands, ['git rev-parse HEAD', 'git diff']);
  });

  it('routes Grok through a private prompt file and injects trusted provenance', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'aie-model-route-'));
    const input = reviewInput(repoRoot, 'grok-build');
    let capturedPromptPath = null;
    let capturedArgs = null;

    const result = await runModelReview({
      ...input,
      resolveExecutable: async () => 'grok.exe',
      runProcess: async invocation => {
        capturedPromptPath = invocation.promptPath;
        capturedArgs = invocation.args;
        assert.equal(invocation.stdin, null);
        assert.equal(existsSync(invocation.promptPath), true);
        assert.match(readFileSync(invocation.promptPath, 'utf8'), /INSPECT EXACT LANE PROMPT/);
        assert.equal(invocation.args.some(arg => arg.includes('INSPECT EXACT LANE PROMPT')), false);
        const pending = { ...laneResult(), status: 'pending', recommendation: 'pending', summary: 'Inspection in progress.' };
        return { exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: `${JSON.stringify(pending)}\n${JSON.stringify(laneResult())}`, sessionId: 'grok-session' }) };
      },
    });

    assert.equal(result.error, null);
    assert.equal(result.evidence.runnerProvenance.host, 'grok-build');
    assert.equal(result.evidence.runnerProvenance.model, 'grok-4.5');
    assert.equal(result.evidence.runnerProvenance.isolation, 'read-only');
    assert.equal(result.evidence.runnerProvenance.sessionId, 'grok-session');
    assert.equal(result.evidence.promptStack[0].id, 'review-lanes/code-quality');
    assert.ok(capturedArgs.includes('dontAsk'));
    assert.ok(capturedArgs.includes('strict'));
    assert.ok(capturedArgs.includes('--no-plan'));
    assert.ok(capturedArgs.includes('Bash(*)'));
    assert.ok(capturedArgs.includes('Edit'));
    assert.ok(capturedArgs.includes('Read(.qube/aie/reviews/**)'));
    assert.equal(capturedArgs.includes('plan'), false);
    assert.ok(capturedArgs.includes('--no-subagents'));
    assert.ok(capturedArgs.includes('--disable-web-search'));
    const schemaIndex = capturedArgs.indexOf('--json-schema');
    assert.ok(schemaIndex >= 0);
    const schema = JSON.parse(capturedArgs[schemaIndex + 1]);
    assert.equal(schema.properties.issueNumber.const, 309);
    assert.equal(schema.properties.lane.const, 'code-quality');
    assert.equal(schema.properties.artifacts.minItems, 1);
    assert.equal(existsSync(capturedPromptPath), false);
  });

  it('redacts model-derived evidence before persistence or publication', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'aie-model-route-redact-'));
    const token = (...parts) => parts.join('');
    const tokens = [
      token('gh', 'p_', 'abcdefghijklmnopqrstuvwxyz123456'),
      token('s', 'k-proj-', 'abcdefghijklmnopqrstuvwxyz123456'),
      token('xa', 'i-', 'abcdefghijklmnopqrstuvwxyz123456'),
      token('gl', 'pat-', 'abcdefghijklmnopqrstuvwxyz123456'),
      token('np', 'm_', 'abcdefghijklmnopqrstuvwxyz123456'),
      token('xo', 'xb-', '1234567890-abcdefghijklmnopqrstuvwxyz'),
      token('AI', 'za', 'abcdefghijklmnopqrstuvwxyz1234567890'),
      token('AK', 'IA', 'ABCDEFGHIJKLMNOP'),
      token('ey', 'Jabcdefghijk', '.abcdefghijklmnop.abcdefghijklmnop'),
    ];
    const body = laneResult();
    body.status = 'needs-work';
    body.severity = 'high';
    body.recommendation = 'request-changes';
    body.summary = `Summary ${tokens[0]} ${tokens[1]}`;
    body.blockers = [`Blocker ${tokens[2]}`, 'client_secret=lowercase-punctuation_secret-value'];
    body.findings = [{ severity: 'advisory', message: `Message ${tokens[3]}`, suggestion: `Suggestion ${tokens[4]}`, location: { path: `source-${tokens[5]}.ts` } }];
    body.commands = [`command ${tokens[6]}`];
    body.surfaces = [`surface ${tokens[7]}`];
    body.contextReviewed = [{ kind: 'diff', source: `source ${tokens[8]}`, trust: 'local-evidence', freshness: 'current' }];
    body.toolsUsed = ['tool password="lowercase-secret-value"'];
    body.coverage = [{ area: 'code-quality', status: 'finding' }];
    body.completeness = 'Complete -----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----';
    body.preconditions = ['Precondition auth_token=lowercase-secret-value'];

    const result = await runModelReview({
      ...reviewInput(repoRoot, 'grok-build'),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({ exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: JSON.stringify(body), sessionId: 'redacted' }) }),
    });

    assert.equal(result.error, null);
    const serialized = JSON.stringify(result.evidence);
    for (const token of tokens) assert.doesNotMatch(serialized, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(serialized, /lowercase-secret-value|private-key-material/);
    assert.match(serialized, /\[REDACTED\]/);
  });

  it('accepts a confidence-bearing advisory and preserves confidence into routed evidence', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'aie-model-route-confidence-'));
    const body = laneResult();
    body.status = 'needs-work';
    body.severity = 'high';
    body.recommendation = 'request-changes';
    body.blockers = ['Fix the unchecked parser bound.'];
    body.findings = [
      { severity: 'blocking', message: 'Fix the unchecked parser bound.', location: { path: 'src/parser.ts', line: 12 }, confidence: 0.8 },
      { severity: 'advisory', message: 'Prefer the shared helper.', location: { path: 'src/parser.ts', line: 20 }, confidence: 0.3 },
    ];
    body.coverage = [{ area: 'code-quality', status: 'finding' }];

    const result = await runModelReview({
      ...reviewInput(repoRoot, 'grok-build'),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({ exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: JSON.stringify(body), sessionId: 'confidence' }) }),
    });

    assert.equal(result.error, null);
    assert.ok(result.evidence, 'a confidence-bearing result must be accepted, not rejected whole');
    const byMessage = Object.fromEntries(result.evidence.findings.map(finding => [finding.message, finding.confidence]));
    assert.equal(byMessage['Fix the unchecked parser bound.'], 0.8, 'confidence must survive into routed evidence for the confidence-ranked cap');
    assert.equal(byMessage['Prefer the shared helper.'], 0.3);
  });

  it('rejects an out-of-range confidence without discarding the lane silently', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'aie-model-route-confidence-bad-'));
    const body = laneResult();
    body.findings = [{ severity: 'advisory', message: 'Out-of-range confidence.', location: { path: 'src/parser.ts', line: 4 }, confidence: 1.5 }];

    const result = await runModelReview({
      ...reviewInput(repoRoot, 'grok-build'),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({ exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: JSON.stringify(body), sessionId: 'bad-confidence' }) }),
    });

    assert.equal(result.evidence, null, 'an out-of-range confidence must fail the lane closed, not coerce silently');
  });

  it('fails closed on malformed or incomplete routed output', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'aie-model-route-bad-'));
    const malformed = await runModelReview({
      ...reviewInput(repoRoot, 'codex'),
      resolveExecutable: async () => 'codex.exe',
      runProcess: async () => ({ exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"not-json"}}\n' }),
    });
    assert.equal(malformed.evidence, null);
    assert.equal(malformed.reasonCode, 'model-route-malformed-json');

    const malformedProgress = await runModelReview({
      ...reviewInput(repoRoot, 'codex'),
      resolveExecutable: async () => 'codex.exe',
      runProcess: async () => ({
        exitCode: 0,
        stderr: '',
        timedOut: false,
        stdinDelivered: true,
        stdout: [
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'not-json' } }),
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(laneResult()) } }),
        ].join('\n'),
      }),
    });
    assert.equal(malformedProgress.error, null);
    assert.equal(malformedProgress.evidence.status, 'passed', 'transient host prose must not become lane evidence');

    const multipleCodexMessages = await runModelReview({
      ...reviewInput(repoRoot, 'codex'),
      resolveExecutable: async () => 'codex.exe',
      runProcess: async () => ({
        exitCode: 0,
        stderr: '',
        timedOut: false,
        stdinDelivered: true,
        stdout: `${JSON.stringify({ type: 'thread.started', thread_id: 'multiple-codex' })}\n${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(laneResult()) } })}\n${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(laneResult()) } })}\n`,
      }),
    });
    assert.equal(multipleCodexMessages.evidence, null);
    assert.equal(multipleCodexMessages.reasonCode, 'model-route-multiple-terminal');

    const codexProgress = {
      ...laneResult(),
      status: 'pending',
      severity: 'none',
      recommendation: 'pending',
      summary: 'Inspection in progress.',
      blockers: [],
      findings: [],
    };
    const codexProgressThenFinal = await runModelReview({
      ...reviewInput(repoRoot, 'codex'),
      resolveExecutable: async () => 'codex.exe',
      runProcess: async () => ({
        exitCode: 0,
        stderr: '',
        timedOut: false,
        stdinDelivered: true,
        stdout: [
          JSON.stringify({ type: 'thread.started', thread_id: 'codex-progress' }),
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(codexProgress) } }),
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(laneResult()) } }),
        ].join('\n'),
      }),
    });
    assert.equal(codexProgressThenFinal.error, null);
    assert.equal(codexProgressThenFinal.evidence.status, 'passed');

    const multipleFinalObjects = await runModelReview({
      ...reviewInput(repoRoot, 'grok-build'),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({
        exitCode: 0,
        stderr: '',
        timedOut: false,
        stdinDelivered: true,
        stdout: JSON.stringify({ text: `${JSON.stringify(laneResult())}\n${JSON.stringify(laneResult())}`, sessionId: 'multiple' }),
      }),
    });
    assert.equal(multipleFinalObjects.evidence, null);
    assert.equal(multipleFinalObjects.reasonCode, 'model-route-multiple-terminal');

    const progressThenFinal = await runModelReview({
      ...reviewInput(repoRoot, 'grok-build'),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({
        exitCode: 0,
        stderr: '',
        timedOut: false,
        stdinDelivered: true,
        stdout: JSON.stringify({
          text: `${JSON.stringify({
            issueNumber: 309,
            prNumber: 310,
            headSha: 'abc123',
            lane: 'code-quality',
            status: 'pending',
            severity: 'none',
            recommendation: 'pending',
            summary: 'Inspection in progress.',
            blockers: [],
            findings: [],
            artifacts: [{ kind: 'progress', path: 'command:pending', sha256: null }],
            commands: [],
            surfaces: [],
            contextReviewed: [{ kind: 'diff', source: 'lane-prompt-bundle', trust: 'untrusted-task-input', freshness: 'current' }],
            toolsUsed: [],
            completeness: 'Progress snapshot only.',
            preconditions: [],
          })}${JSON.stringify(laneResult())}`,
          sessionId: 'progress-then-final',
        }),
      }),
    });
    assert.equal(progressThenFinal.error, null);
    assert.equal(progressThenFinal.evidence.status, 'passed');

    const contradictoryPending = { ...laneResult(), status: 'pending', recommendation: 'pending', blockers: ['Contradictory blocker.'] };
    const contradictorySequence = await runModelReview({
      ...reviewInput(repoRoot, 'grok-build'),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({
        exitCode: 0,
        stderr: '',
        timedOut: false,
        stdinDelivered: true,
        stdout: JSON.stringify({ text: `${JSON.stringify(contradictoryPending)}\n${JSON.stringify(laneResult())}`, sessionId: 'contradictory' }),
      }),
    });
    assert.equal(contradictorySequence.error, null);
    assert.equal(contradictorySequence.evidence.status, 'passed', 'nonterminal transient JSON must not affect the final verdict');

    const nonterminalFinal = await runModelReview({
      ...reviewInput(repoRoot, 'grok-build'),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({
        exitCode: 0,
        stderr: '',
        timedOut: false,
        stdinDelivered: true,
        stdout: JSON.stringify({ text: JSON.stringify(codexProgress), sessionId: 'pending-final' }),
      }),
    });
    assert.equal(nonterminalFinal.evidence, null);
    assert.equal(nonterminalFinal.reasonCode, 'model-route-nonterminal-result');

    const missingDigest = laneResult();
    delete missingDigest.artifacts[0].sha256;
    const missingDigestResult = await runModelReview({
      ...reviewInput(repoRoot, 'grok-build'),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({ exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: JSON.stringify(missingDigest), sessionId: 'missing-digest' }) }),
    });
    assert.equal(missingDigestResult.evidence, null);
    assert.equal(missingDigestResult.reasonCode, 'model-route-contract-mismatch');

    const incompleteResult = laneResult();
    incompleteResult.artifacts = [];
    const incomplete = await runModelReview({
      ...reviewInput(repoRoot, 'grok-build'),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({ exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: JSON.stringify(incompleteResult), sessionId: 'bad' }) }),
    });
    assert.equal(incomplete.evidence, null);
    assert.equal(incomplete.reasonCode, 'model-route-contract-mismatch');

    const mismatchedResult = laneResult();
    mismatchedResult.lane = 'security';
    const mismatched = await runModelReview({
      ...reviewInput(repoRoot, 'grok-build'),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({ exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: JSON.stringify(mismatchedResult), sessionId: 'wrong-lane' }) }),
    });
    assert.equal(mismatched.evidence, null);
    assert.equal(mismatched.reasonCode, 'model-route-contract-mismatch');

    const falseSuccess = laneResult();
    falseSuccess.findings = [{ severity: 'blocking', message: 'Fix the false-success path.' }];
    const blockingPassed = await runModelReview({
      ...reviewInput(repoRoot, 'grok-build'),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({ exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: JSON.stringify(falseSuccess), sessionId: 'false-success' }) }),
    });
    assert.equal(blockingPassed.evidence, null);
    assert.equal(blockingPassed.reasonCode, 'model-route-contract-mismatch');

    const blockersApproved = laneResult();
    blockersApproved.blockers = ['This result cannot be approved.'];
    const approvedWithBlockers = await runModelReview({
      ...reviewInput(repoRoot, 'grok-build'),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({ exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: JSON.stringify(blockersApproved), sessionId: 'blockers-approved' }) }),
    });
    assert.equal(approvedWithBlockers.evidence, null);
    assert.equal(approvedWithBlockers.reasonCode, 'model-route-contract-mismatch');
  });

  it('classifies timeout and authentication failures without returning raw model output', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'aie-model-route-fail-'));
    const timedOut = await runModelReview({
      ...reviewInput(repoRoot, 'codex'),
      resolveExecutable: async () => 'codex.exe',
      runProcess: async () => ({ exitCode: 1, stderr: '', stdout: '', timedOut: true, stdinDelivered: true }),
    });
    assert.equal(timedOut.reasonCode, 'model-route-timeout');

    const auth = await runModelReview({
      ...reviewInput(repoRoot, 'grok-build'),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({ exitCode: 1, stderr: 'login required token abcdefghijklmnopqrstuvwxyz1234567890', stdout: '', timedOut: false, stdinDelivered: true }),
    });
    assert.equal(auth.reasonCode, 'model-route-authentication');
    assert.doesNotMatch(auth.error, /abcdefghijklmnopqrstuvwxyz/);
  });

  it('classifies missing hosts, rejected models, and generic non-zero exits', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'aie-model-route-errors-'));
    const missingHost = await runModelReview({
      ...reviewInput(repoRoot, 'grok-build'),
      resolveExecutable: async () => { throw new Error('grok executable was not found'); },
    });
    assert.equal(missingHost.reasonCode, 'model-route-unavailable');

    const rejectedModel = await runModelReview({
      ...reviewInput(repoRoot, 'grok-build'),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({ exitCode: 2, stderr: 'configured model is unavailable', stdout: '', timedOut: false, stdinDelivered: true }),
    });
    assert.equal(rejectedModel.reasonCode, 'model-route-model-unavailable');

    const nonZero = await runModelReview({
      ...reviewInput(repoRoot, 'codex'),
      resolveExecutable: async () => 'codex.exe',
      runProcess: async () => ({ exitCode: 17, stderr: 'runner stopped', stdout: '', timedOut: false, stdinDelivered: true }),
    });
    assert.equal(nonZero.reasonCode, 'model-route-process-failed');
    assert.match(nonZero.error, /code 17/);

    const untrustedReviewText = await runModelReview({
      ...reviewInput(repoRoot, 'grok-build'),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({ exitCode: 1, stderr: 'runner stopped', stdout: 'The configured model validation appears unavailable in reviewed code.', timedOut: false, stdinDelivered: true }),
    });
    assert.equal(untrustedReviewText.reasonCode, 'model-route-process-failed');
  });

  it('rejects checkout drift, incomplete prompt delivery, and permissively malformed evidence', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'aie-model-route-strict-'));
    const checkoutMismatch = await runModelReview({
      ...reviewInput(repoRoot, 'grok-build'),
      resolveHead: async () => 'different-head',
      resolveExecutable: async () => 'grok.exe',
    });
    assert.equal(checkoutMismatch.reasonCode, 'model-route-checkout-mismatch');

    const checkoutStates = ['before', 'after'];
    const checkoutContentsChanged = await runModelReview({
      ...reviewInput(repoRoot, 'grok-build'),
      resolveCheckoutState: async () => checkoutStates.shift(),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({ exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: JSON.stringify(laneResult()), sessionId: 'drift' }) }),
    });
    assert.equal(checkoutContentsChanged.reasonCode, 'model-route-checkout-mismatch');
    assert.match(checkoutContentsChanged.error, /contents changed/);

    const promptFailure = await runModelReview({
      ...reviewInput(repoRoot, 'grok-build'),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({ exitCode: 0, stderr: 'EPIPE', stdout: '', timedOut: false, stdinDelivered: false }),
    });
    assert.equal(promptFailure.reasonCode, 'model-route-prompt-delivery');

    const invalid = laneResult();
    invalid.severity = 'surprising';
    invalid.artifacts = [{}];
    const malformedEvidence = await runModelReview({
      ...reviewInput(repoRoot, 'grok-build'),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({ exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: JSON.stringify(invalid), sessionId: 'invalid' }) }),
    });
    assert.equal(malformedEvidence.reasonCode, 'model-route-contract-mismatch');

    const forgedDigest = laneResult();
    forgedDigest.artifacts = [{ kind: 'source', path: 'tracked.txt', sha256: '0'.repeat(64) }];
    writeFileSync(join(repoRoot, 'tracked.txt'), 'trusted bytes');
    const forgedEvidence = await runModelReview({
      ...reviewInput(repoRoot, 'grok-build'),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({ exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: JSON.stringify(forgedDigest), sessionId: 'forged' }) }),
    });
    assert.equal(forgedEvidence.reasonCode, 'model-route-artifact-digest');
    assert.match(forgedEvidence.error, /must set sha256 to null/);

    const directoryArtifact = laneResult();
    mkdirSync(join(repoRoot, 'artifact-directory'));
    directoryArtifact.artifacts = [{ kind: 'source', path: 'artifact-directory', sha256: null }];
    const directoryEvidence = await runModelReview({
      ...reviewInput(repoRoot, 'grok-build'),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({ exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: JSON.stringify(directoryArtifact), sessionId: 'directory' }) }),
    });
    assert.equal(directoryEvidence.reasonCode, 'model-route-contract-mismatch');
  });

  it('detects content changes when a tracked file was already dirty', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'aie-checkout-content-'));
    execFileSync('git', ['init', '--quiet', repoRoot]);
    execFileSync('git', ['-C', repoRoot, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', ['-C', repoRoot, 'config', 'user.name', 'QUBE Test']);
    writeFileSync(join(repoRoot, 'tracked.txt'), 'committed\n');
    execFileSync('git', ['-C', repoRoot, 'add', 'tracked.txt']);
    execFileSync('git', ['-C', repoRoot, 'commit', '--quiet', '-m', 'fixture']);
    writeFileSync(join(repoRoot, 'tracked.txt'), 'dirty before review\n');
    const before = await resolveModelReviewCheckoutState(repoRoot);
    writeFileSync(join(repoRoot, 'tracked.txt'), 'changed during review\n');
    const after = await resolveModelReviewCheckoutState(repoRoot);
    assert.notEqual(after, before);
  });

  it('resolves an npm Windows command shim to its Node entrypoint without a shell', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aie-grok-shim-'));
    const script = join(root, 'node_modules', '@xai', 'grok', 'bin', 'grok.js');
    mkdirSync(join(root, 'node_modules', '@xai', 'grok', 'bin'), { recursive: true });
    writeFileSync(script, '');
    const shim = join(root, 'grok.cmd');
    writeFileSync(shim, '@ECHO off\r\nnode "%dp0%\\node_modules\\@xai\\grok\\bin\\grok.js" %*\r\n');

    const resolved = await resolveWindowsNodeShim(shim);
    assert.ok(resolved && typeof resolved === 'object');
    assert.equal(resolved.prefixArgs[0], script);
  });
});

describe('coverage attestation contract', () => {
  it('defaults expected coverage to the lane id only', () => {
    assert.deepEqual(expectedCoverageAreas({ lane: 'code-quality' }), ['code-quality']);
    const prompt = buildModelReviewPrompt({
      ...reviewInput(mkdtempSync(join(tmpdir(), 'aie-lane-coverage-'))),
      promptText: 'INSPECT EXACT LANE PROMPT',
    });
    assert.match(prompt, /Attest coverage for exactly these areas: code-quality\./);
    assert.equal(prompt.includes('multi-process-concurrency'), false);
  });

  function grokRun(body, coverageAreas) {
    return runModelReview({
      ...reviewInput(mkdtempSync(join(tmpdir(), 'aie-coverage-')), 'grok-build'),
      ...(coverageAreas ? { coverageAreas } : {}),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({ exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: JSON.stringify(body), sessionId: 'coverage' }) }),
    });
  }

  it('rejects a result without the coverage attestation', async () => {
    const body = laneResult();
    delete body.coverage;
    const result = await grokRun(body);
    assert.notEqual(result.error, null);
    assert.equal(result.evidence, null);
  });

  it('rejects a result missing an expected coverage area', async () => {
    const body = laneResult();
    const result = await grokRun(body, ['truthful-state-transitions']);
    assert.notEqual(result.error, null);
    assert.equal(result.evidence, null);
  });

  it('normalizes a passed result with a not-inspected area to inconclusive', async () => {
    const body = laneResult();
    body.coverage = [{ area: 'code-quality', status: 'not-inspected' }];
    const result = await grokRun(body);
    assert.equal(result.error, null);
    assert.equal(result.evidence.status, 'inconclusive');
    assert.notEqual(result.evidence.status, 'passed');
  });

  it('rejects findings reported against an all-clear attestation', async () => {
    const body = laneResult();
    body.findings = [{ severity: 'advisory', message: 'Residual advisory.', suggestion: null, location: null }];
    body.coverage = [{ area: 'code-quality', status: 'clear' }];
    const result = await grokRun(body);
    assert.notEqual(result.error, null);
    assert.equal(result.evidence, null);
  });

  it('accepts a complete attestation alongside several findings', async () => {
    const body = laneResult();
    body.findings = [
      { severity: 'advisory', message: 'First residual advisory.', suggestion: null, location: null },
      { severity: 'advisory', message: 'Second residual advisory.', suggestion: null, location: null },
    ];
    body.coverage = [
      { area: 'code-quality', status: 'finding' },
      { area: 'truthful-state-transitions', status: 'clear' },
    ];
    const result = await grokRun(body, ['truthful-state-transitions']);
    assert.equal(result.error, null);
    assert.equal(result.evidence.status, 'passed');
    assert.equal(result.evidence.findings.length, 2);
  });
});

describe('transient host message isolation', () => {
  it('ignores a transient pending object without coverage before an attested final result', async () => {
    const pending = { ...laneResult(), status: 'pending', recommendation: 'pending', summary: 'Inspection in progress.' };
    delete pending.coverage;
    const result = await runModelReview({
      ...reviewInput(mkdtempSync(join(tmpdir(), 'aie-interim-')), 'grok-build'),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({ exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: `${JSON.stringify(pending)}\n${JSON.stringify(laneResult())}`, sessionId: 'grok-session' }) }),
    });
    assert.equal(result.error, null);
    assert.equal(result.evidence.status, 'passed');
  });

  it('still rejects a final result without coverage when transient messages omit it', async () => {
    const pending = { ...laneResult(), status: 'pending', recommendation: 'pending', summary: 'Inspection in progress.' };
    delete pending.coverage;
    const final = laneResult();
    delete final.coverage;
    const result = await runModelReview({
      ...reviewInput(mkdtempSync(join(tmpdir(), 'aie-interim-')), 'grok-build'),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({ exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: `${JSON.stringify(pending)}\n${JSON.stringify(final)}`, sessionId: 'grok-session' }) }),
    });
    assert.notEqual(result.error, null);
    assert.equal(result.evidence, null);
  });
});

describe('transient host coverage isolation', () => {
  it('ignores freeform coverage areas in transient messages', async () => {
    const pending = { ...laneResult(), status: 'pending', recommendation: 'pending', summary: 'Inspection in progress.', coverage: [{ area: 'made-up-area', status: 'clear' }] };
    const result = await runModelReview({
      ...reviewInput(mkdtempSync(join(tmpdir(), 'aie-interim2-')), 'grok-build'),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({ exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: `${JSON.stringify(pending)}\n${JSON.stringify(laneResult())}`, sessionId: 'grok-session' }) }),
    });
    assert.equal(result.error, null);
    assert.equal(result.evidence.status, 'passed');
  });
});
