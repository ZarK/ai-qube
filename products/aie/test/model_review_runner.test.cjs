const assert = require('node:assert/strict');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { describe, it } = require('node:test');

const {
  buildModelReviewPrompt,
  buildModelRouteInvocation,
  runModelReview,
  runModelRouteProcess,
  resolveWindowsNodeShim,
} = require('../dist/app/model_review_runner.js');

function reviewInput(repoRoot, host = 'grok') {
  return {
    plan: {
      host,
      tier: 'review',
      model: host === 'grok' ? 'grok-4.5' : 'gpt-5.6-luna',
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
    assert.equal(invocation.args.includes(prompt), false);
    assert.deepEqual(invocation.args.slice(-2), ['--json', '-']);
    assert.ok(invocation.args.includes('read-only'));
    assert.ok(invocation.args.includes('gpt-5.6-luna'));
    assert.ok(invocation.args.includes('model_reasoning_effort="high"'));
    assert.ok(invocation.args.includes('--ignore-user-config'));
    assert.ok(invocation.args.includes('multi_agent'));
    assert.ok(invocation.args.includes('mcp_servers={}'));
    assert.ok(invocation.args.includes('web_search="disabled"'));
    assert.equal(invocation.args[invocation.args.indexOf('--output-schema') + 1], schemaPath);
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
        assert.deepEqual(schema.properties.findings.items.required, ['id', 'severity', 'message', 'suggestion', 'location']);
        assert.deepEqual(schema.properties.artifacts.items.required, ['kind', 'path', 'sha256']);
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
    assert.equal(existsSync(capturedSchemaPath), false);
  });

  it('routes Grok through a private prompt file and injects trusted provenance', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'aie-model-route-'));
    const input = reviewInput(repoRoot, 'grok');
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
    assert.equal(result.evidence.runnerProvenance.host, 'grok');
    assert.equal(result.evidence.runnerProvenance.model, 'grok-4.5');
    assert.equal(result.evidence.runnerProvenance.isolation, 'read-only');
    assert.equal(result.evidence.runnerProvenance.sessionId, 'grok-session');
    assert.equal(result.evidence.promptStack[0].id, 'review-lanes/code-quality');
    assert.ok(capturedArgs.includes('dontAsk'));
    assert.ok(capturedArgs.includes('strict'));
    assert.ok(capturedArgs.includes('--no-plan'));
    assert.ok(capturedArgs.includes('Bash(*)'));
    assert.ok(capturedArgs.includes('Edit'));
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

  it('fails closed on malformed or incomplete routed output', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'aie-model-route-bad-'));
    const malformed = await runModelReview({
      ...reviewInput(repoRoot, 'codex'),
      resolveExecutable: async () => 'codex.exe',
      runProcess: async () => ({ exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"not-json"}}\n' }),
    });
    assert.equal(malformed.evidence, null);
    assert.equal(malformed.reasonCode, 'model-route-malformed-json');

    const incompleteResult = laneResult();
    incompleteResult.artifacts = [];
    const incomplete = await runModelReview({
      ...reviewInput(repoRoot, 'grok'),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({ exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: JSON.stringify(incompleteResult), sessionId: 'bad' }) }),
    });
    assert.equal(incomplete.evidence, null);
    assert.equal(incomplete.reasonCode, 'model-route-contract-mismatch');

    const mismatchedResult = laneResult();
    mismatchedResult.lane = 'security';
    const mismatched = await runModelReview({
      ...reviewInput(repoRoot, 'grok'),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({ exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: JSON.stringify(mismatchedResult), sessionId: 'wrong-lane' }) }),
    });
    assert.equal(mismatched.evidence, null);
    assert.equal(mismatched.reasonCode, 'model-route-contract-mismatch');

    const falseSuccess = laneResult();
    falseSuccess.findings = [{ severity: 'blocking', message: 'Fix the false-success path.' }];
    const blockingPassed = await runModelReview({
      ...reviewInput(repoRoot, 'grok'),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({ exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: JSON.stringify(falseSuccess), sessionId: 'false-success' }) }),
    });
    assert.equal(blockingPassed.evidence, null);
    assert.equal(blockingPassed.reasonCode, 'model-route-contract-mismatch');
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
      ...reviewInput(repoRoot, 'grok'),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({ exitCode: 1, stderr: 'login required token abcdefghijklmnopqrstuvwxyz1234567890', stdout: '', timedOut: false, stdinDelivered: true }),
    });
    assert.equal(auth.reasonCode, 'model-route-authentication');
    assert.doesNotMatch(auth.error, /abcdefghijklmnopqrstuvwxyz/);
  });

  it('classifies missing hosts, rejected models, and generic non-zero exits', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'aie-model-route-errors-'));
    const missingHost = await runModelReview({
      ...reviewInput(repoRoot, 'grok'),
      resolveExecutable: async () => { throw new Error('grok executable was not found'); },
    });
    assert.equal(missingHost.reasonCode, 'model-route-unavailable');

    const rejectedModel = await runModelReview({
      ...reviewInput(repoRoot, 'grok'),
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
      ...reviewInput(repoRoot, 'grok'),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({ exitCode: 1, stderr: 'runner stopped', stdout: 'The configured model validation appears unavailable in reviewed code.', timedOut: false, stdinDelivered: true }),
    });
    assert.equal(untrustedReviewText.reasonCode, 'model-route-process-failed');
  });

  it('rejects checkout drift, incomplete prompt delivery, and permissively malformed evidence', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'aie-model-route-strict-'));
    const checkoutMismatch = await runModelReview({
      ...reviewInput(repoRoot, 'grok'),
      resolveHead: async () => 'different-head',
      resolveExecutable: async () => 'grok.exe',
    });
    assert.equal(checkoutMismatch.reasonCode, 'model-route-checkout-mismatch');

    const promptFailure = await runModelReview({
      ...reviewInput(repoRoot, 'grok'),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({ exitCode: 0, stderr: 'EPIPE', stdout: '', timedOut: false, stdinDelivered: false }),
    });
    assert.equal(promptFailure.reasonCode, 'model-route-prompt-delivery');

    const invalid = laneResult();
    invalid.severity = 'surprising';
    invalid.artifacts = [{}];
    const malformedEvidence = await runModelReview({
      ...reviewInput(repoRoot, 'grok'),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({ exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: JSON.stringify(invalid), sessionId: 'invalid' }) }),
    });
    assert.equal(malformedEvidence.reasonCode, 'model-route-contract-mismatch');

    const forgedDigest = laneResult();
    forgedDigest.artifacts = [{ kind: 'source', path: 'tracked.txt', sha256: '0'.repeat(64) }];
    writeFileSync(join(repoRoot, 'tracked.txt'), 'trusted bytes');
    const forgedEvidence = await runModelReview({
      ...reviewInput(repoRoot, 'grok'),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({ exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: JSON.stringify(forgedDigest), sessionId: 'forged' }) }),
    });
    assert.equal(forgedEvidence.reasonCode, 'model-route-contract-mismatch');

    const directoryArtifact = laneResult();
    mkdirSync(join(repoRoot, 'artifact-directory'));
    directoryArtifact.artifacts = [{ kind: 'source', path: 'artifact-directory', sha256: null }];
    const directoryEvidence = await runModelReview({
      ...reviewInput(repoRoot, 'grok'),
      resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({ exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: JSON.stringify(directoryArtifact), sessionId: 'directory' }) }),
    });
    assert.equal(directoryEvidence.reasonCode, 'model-route-contract-mismatch');
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
