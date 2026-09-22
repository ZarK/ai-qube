const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { it } = require('node:test');
const { modelRouteEnvironment, resolveModelReviewCheckoutState, watchModelReviewCheckout, runModelReview, runModelRouteProcess } = require('../dist/app/model_review_runner.js');
const { redact } = require('../dist/redact.js');

function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'aie-review-isolation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', root]);
  return root;
}

it('ignores host scratch in simultaneous checkout monitors and the checkout digest', async t => {
  const root = repository(t);
  const before = await resolveModelReviewCheckoutState(root);
  const monitors = [watchModelReviewCheckout(root), watchModelReviewCheckout(root)];
  t.after(() => monitors.forEach(monitor => monitor.close()));
  writeFileSync(join(root, '_tmp_123_abcd'), 'host scratch');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await resolveModelReviewCheckoutState(root), before);
  for (const monitor of monitors) assert.equal(monitor.violation(), null);
  writeFileSync(join(root, 'source.ts'), 'export const changed = true;');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.notEqual(await resolveModelReviewCheckoutState(root), before);
  for (const monitor of monitors) assert.match(monitor.violation(), /source\.ts/);
});

it('does not exempt tracked files with host scratch names', async t => {
  const root = repository(t);
  const path = join(root, '_tmp_123_abcd');
  writeFileSync(path, 'original');
  execFileSync('git', ['-C', root, 'add', '_tmp_123_abcd']);
  const before = await resolveModelReviewCheckoutState(root);
  const monitor = watchModelReviewCheckout(root);
  t.after(() => monitor.close());
  writeFileSync(path, 'changed');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.notEqual(await resolveModelReviewCheckoutState(root), before);
  assert.match(monitor.violation(), /_tmp_123_abcd/);
});

it('passes network settings to isolated processes without unrelated credentials', async t => {
  const root = repository(t);
  const source = { HTTPS_PROXY: 'http://localhost:8080', http_proxy: 'http://localhost:8081', NO_PROXY: 'localhost', NODE_USE_ENV_PROXY: '1', GH_TOKEN: 'private' };
  const env = modelRouteEnvironment(source);
  for (const key of Object.keys(source).filter(key => key !== 'GH_TOKEN')) assert.equal(env[key], source[key]);
  assert.equal(env.GH_TOKEN, undefined);
  const previous = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = source.HTTPS_PROXY;
  t.after(() => { if (previous === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = previous; });
  const result = await runModelRouteProcess({ executable: process.execPath, args: ['-e', 'process.stdout.write(process.env.HTTPS_PROXY || "")'], cwd: root, stdin: null, promptPath: null, schemaPath: null, timeoutMs: 5000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, source.HTTPS_PROXY);
  assert.equal(redact('Cannot connect to http://user:private@proxy.example:8080'), 'Cannot connect to http://[REDACTED]@proxy.example:8080');
  assert.equal(redact('socks5://private@proxy.example:1080'), 'socks5://[REDACTED]@proxy.example:1080');
});

it('reports a network reason for resolver failure even when the host then times out', async t => {
  const root = repository(t);
  const plan = { host: 'grok-build', tier: 'review', model: 'grok-4.6', effort: null, isolation: 'read-only', timeoutSeconds: 60, maxTurns: 8, substitution: null };
  for (const timedOut of [false, true]) {
    const result = await runModelReview({
      plan, selectedPlan: plan, repoRoot: root, lane: 'code-quality', issueNumber: 309, prNumber: 310,
      headSha: 'abc123', profile: 'local-focused', promptStackHash: 'hash123', promptText: 'Inspect the diff.', promptStack: [],
      resolveHead: async () => 'abc123', resolveExecutable: async () => 'grok.exe',
      runProcess: async () => ({ exitCode: 1, stdout: '', stderr: 'getaddrinfo ENOTFOUND api.example.invalid', timedOut, stdinDelivered: true }),
    });
    assert.equal(result.reasonCode, 'model-route-network');
    assert.match(result.error, /proxy settings, then rerun the gate/);
  }
});
