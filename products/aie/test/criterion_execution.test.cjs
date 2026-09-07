const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { cloneGitRepo } = require('./support/git_fixture.cjs');

const { configToFileShape, getDefaults } = require('../dist/config/index.js');
const { captureCriterionExecution, validateCriterionExecution } = require('../dist/app/criterion_execution.js');
const { criterionInputDigest } = require('../dist/app/criterion_inputs.js');

const sha = value => createHash('sha256').update(value).digest('hex');

function fixture(command = 'node --test behavior.test.cjs', timeoutSeconds = 10, env = {}) {
  const repo = cloneGitRepo('committed', 'criterion-execution-');
  const config = getDefaults();
  config.gates = [{
    name: 'behavior', kind: 'unit', command, stage: 'pre-pr', required: true,
    timeoutSeconds, workingDirectory: '.', env, externalService: false,
  }];
  config.policy.gates.definitions = config.gates.map(gate => ({ ...gate }));
  mkdirSync(join(repo, '.qube', 'aie'), { recursive: true });
  writeFileSync(join(repo, '.qube', 'aie', 'config.json'), `${JSON.stringify(configToFileShape(config), null, 2)}\n`);
  writeFileSync(join(repo, 'behavior.test.cjs'), "require('node:assert/strict').equal(require('node:fs').existsSync('required.txt'), true);\n");
  writeFileSync(join(repo, 'required.txt'), 'required\n');
  execFileSync('git', ['add', '.qube/aie/config.json', 'behavior.test.cjs', 'required.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'fixture gate'], { cwd: repo, stdio: 'ignore' });
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const input = { kind: 'test', path: 'behavior.test.cjs', sha256: sha(readFileSync(join(repo, 'behavior.test.cjs'))) };
  return { repo, config, headSha, input };
}

describe('criterion execution receipts', () => {
  it('captures real passing behavior and rejects the same gate after required behavior is removed', async () => {
    const { repo, config, headSha, input } = fixture();
    const inputDigest = criterionInputDigest([input]);
    const reference = await captureCriterionExecution({
      repoRoot: repo, config, gateName: 'behavior', headSha, inputs: [input], readInputDigest: () => inputDigest,
    });
    const recordedAt = new Date(Date.now() + 1000).toISOString();
    assert.deepEqual(validateCriterionExecution({ repoRoot: repo, config, reference, headSha, inputs: [input], inputDigest, recordedAt }), []);

    rmSync(join(repo, 'required.txt'));
    const failed = await captureCriterionExecution({
      repoRoot: repo, config, gateName: 'behavior', headSha, inputs: [input], readInputDigest: () => inputDigest,
    });
    assert.match(validateCriterionExecution({ repoRoot: repo, config, reference: failed, headSha, inputs: [input], inputDigest, recordedAt: new Date(Date.now() + 1000).toISOString() }).join('\n'), /did not pass/);
  });

  it('does not execute a gate from changed repository config', async () => {
    const { repo, config, headSha, input } = fixture();
    writeFileSync(join(repo, '.qube', 'aie', 'config.json'), '{}\n');
    let calls = 0;
    await assert.rejects(captureCriterionExecution({
      repoRoot: repo, config, gateName: 'behavior', headSha, inputs: [input], readInputDigest: () => criterionInputDigest([input]),
      exec: async args => { calls += 1; return { args, exitCode: 0, stdout: '', stderr: '' }; },
    }), /not unchanged from trusted base/);
    assert.equal(calls, 0);
  });

  it('preserves a receipt but refuses success when inputs change during execution', async () => {
    const { repo, config, headSha, input } = fixture();
    const digests = [criterionInputDigest([input]), sha('after')];
    await assert.rejects(captureCriterionExecution({
      repoRoot: repo, config, gateName: 'behavior', headSha, inputs: [input], readInputDigest: () => digests.shift(),
      exec: async args => ({ args, exitCode: 0, stdout: 'ok', stderr: '' }),
    }), /inputs changed/);
    const directory = join(repo, '.git', 'qube', 'aie', 'host-provenance', 'executions');
    const receiptName = readdirSync(directory).find(name => name.endsWith('.json') && !name.endsWith('.output.json'));
    const receipt = JSON.parse(readFileSync(join(directory, receiptName), 'utf8'));
    const reference = { path: `.git/qube/aie/host-provenance/executions/${receiptName}`, sha256: sha(readFileSync(join(directory, receiptName))) };
    assert.match(validateCriterionExecution({ repoRoot: repo, config, reference, headSha, inputs: [input], inputDigest: criterionInputDigest([input]), recordedAt: new Date(Date.now() + 1000).toISOString() }).join('\n'), /observer does not match|changes during execution/);
  });

  it('rejects changed output, changed receipt, wrong config, and missing artifacts', async () => {
    const { repo, config, headSha, input } = fixture();
    const inputDigest = criterionInputDigest([input]);
    const reference = await captureCriterionExecution({ repoRoot: repo, config, gateName: 'behavior', headSha, inputs: [input], readInputDigest: () => inputDigest });
    const receiptPath = join(repo, ...reference.path.split('/'));
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    const outputPath = join(repo, ...receipt.outputPath.split('/'));
    writeFileSync(outputPath, 'forged\n');
    assert.match(validateCriterionExecution({ repoRoot: repo, config, reference, headSha, inputs: [input], inputDigest, recordedAt: new Date(Date.now() + 1000).toISOString() }).join('\n'), /output SHA-256/);

    rmSync(outputPath);
    assert.match(validateCriterionExecution({ repoRoot: repo, config, reference, headSha, inputs: [input], inputDigest, recordedAt: new Date(Date.now() + 1000).toISOString() }).join('\n'), /could not be read/);
    writeFileSync(receiptPath, '{}\n');
    assert.match(validateCriterionExecution({ repoRoot: repo, config, reference, headSha, inputs: [input], inputDigest, recordedAt: new Date(Date.now() + 1000).toISOString() }).join('\n'), /receipt SHA-256/);
  });

  it('allows an ancestor receipt for unchanged inputs and rejects a divergent head', async () => {
    const { repo, config, headSha, input } = fixture();
    const inputDigest = criterionInputDigest([input]);
    const reference = await captureCriterionExecution({ repoRoot: repo, config, gateName: 'behavior', headSha, inputs: [input], readInputDigest: () => inputDigest });
    writeFileSync(join(repo, 'unrelated.txt'), 'change\n');
    execFileSync('git', ['add', 'unrelated.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'unrelated'], { cwd: repo, stdio: 'ignore' });
    const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.deepEqual(validateCriterionExecution({ repoRoot: repo, config, reference, headSha: currentHead, inputs: [input], inputDigest, recordedAt: new Date(Date.now() + 1000).toISOString() }), []);
    assert.match(validateCriterionExecution({ repoRoot: repo, config, reference, headSha: '0'.repeat(40), inputs: [input], inputDigest, recordedAt: new Date(Date.now() + 1000).toISOString() }).join('\n'), /not the current head or one of its ancestors/);
  });

  it('reuses a receipt for a required input subset and enforces the expected gate name', async () => {
    const { repo, config, headSha, input } = fixture();
    writeFileSync(join(repo, 'second.txt'), 'second\n');
    execFileSync('git', ['add', 'second.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'second input'], { cwd: repo, stdio: 'ignore' });
    const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const second = { kind: 'source', path: 'second.txt', sha256: sha(readFileSync(join(repo, 'second.txt'))) };
    const allInputs = [input, second];
    const reference = await captureCriterionExecution({ repoRoot: repo, config, gateName: 'behavior', headSha: currentHead, inputs: allInputs, readInputDigest: () => criterionInputDigest(allInputs) });
    assert.deepEqual(validateCriterionExecution({ repoRoot: repo, config, reference, headSha: currentHead, inputs: [input], inputDigest: criterionInputDigest([input]), recordedAt: new Date(Date.now() + 1000).toISOString(), expectedGateName: 'behavior' }), []);
    assert.match(validateCriterionExecution({ repoRoot: repo, config, reference, headSha: currentHead, inputs: [input], inputDigest: criterionInputDigest([input]), recordedAt: new Date(Date.now() + 1000).toISOString(), expectedGateName: 'other' }).join('\n'), /expected gate other/);
  });

  it('rejects changed effective gate configuration and unsupported shell syntax before execution', async () => {
    const { repo, config, headSha, input } = fixture();
    const inputDigest = criterionInputDigest([input]);
    const reference = await captureCriterionExecution({ repoRoot: repo, config, gateName: 'behavior', headSha, inputs: [input], readInputDigest: () => inputDigest });
    const changed = getDefaults();
    changed.gates = [{ ...config.gates[0], command: 'node --version' }];
    changed.policy.gates.definitions = changed.gates.map(gate => ({ ...gate }));
    assert.match(validateCriterionExecution({ repoRoot: repo, config: changed, reference, headSha, inputs: [input], inputDigest, recordedAt: new Date(Date.now() + 1000).toISOString() }).join('\n'), /does not exactly match|does not match configured gate/);
    const unsafe = getDefaults();
    unsafe.gates = [{ ...config.gates[0], command: 'node behavior.test.cjs & echo forged' }];
    unsafe.policy.gates.definitions = unsafe.gates.map(gate => ({ ...gate }));
    writeFileSync(join(repo, '.qube', 'aie', 'config.json'), `${JSON.stringify(configToFileShape(unsafe), null, 2)}\n`);
    execFileSync('git', ['add', '.qube/aie/config.json'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'unsafe gate fixture'], { cwd: repo, stdio: 'ignore' });
    const unsafeHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    let calls = 0;
    await assert.rejects(captureCriterionExecution({ repoRoot: repo, config: unsafe, gateName: 'behavior', headSha: unsafeHead, inputs: [input], readInputDigest: () => inputDigest, exec: async args => { calls += 1; return { args, exitCode: 0, stdout: '', stderr: '' }; } }), /unsupported shell syntax/);
    assert.equal(calls, 0);
  });

  it('records and rejects a timed-out gate', async () => {
    const { repo, config, headSha, input } = fixture('node slow.cjs', 1);
    writeFileSync(join(repo, 'slow.cjs'), 'setTimeout(function wait() {}, 5000);\n');
    execFileSync('git', ['add', 'slow.cjs'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'slow gate'], { cwd: repo, stdio: 'ignore' });
    const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const inputDigest = criterionInputDigest([input]);
    const reference = await captureCriterionExecution({ repoRoot: repo, config, gateName: 'behavior', headSha: currentHead, inputs: [input], readInputDigest: () => inputDigest });
    assert.match(validateCriterionExecution({ repoRoot: repo, config, reference, headSha: currentHead, inputs: [input], inputDigest, recordedAt: new Date(Date.now() + 1000).toISOString() }).join('\n'), /exit 124/);
  });

  it('runs a real Windows command wrapper without shell expansion', { skip: process.platform !== 'win32' }, async () => {
    const { repo, config, headSha, input } = fixture('tools\\behavior.cmd');
    mkdirSync(join(repo, 'tools'));
    writeFileSync(join(repo, 'tools', 'behavior.cmd'), '@echo off\r\nnode --test behavior.test.cjs\r\n');
    execFileSync('git', ['add', 'tools/behavior.cmd'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'command wrapper'], { cwd: repo, stdio: 'ignore' });
    const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const inputDigest = criterionInputDigest([input]);
    const reference = await captureCriterionExecution({ repoRoot: repo, config, gateName: 'behavior', headSha: currentHead, inputs: [input], readInputDigest: () => inputDigest });
    assert.deepEqual(validateCriterionExecution({ repoRoot: repo, config, reference, headSha: currentHead, inputs: [input], inputDigest, recordedAt: new Date(Date.now() + 1000).toISOString() }), []);
  });

  it('does not launch a Windows wrapper resolved through an unsafe PATH entry', { skip: process.platform !== 'win32' }, async () => {
    const staging = mkdtempSync(join(tmpdir(), 'criterion&percent%-'));
    const launcher = join(staging, 'danger.cmd');
    writeFileSync(launcher, '@echo off\r\necho unsafe>escaped-marker\r\n');
    const { repo, config, headSha, input } = fixture('danger', 10, { PATH: staging, PATHEXT: '.CMD;.EXE' });
    const inputDigest = criterionInputDigest([input]);
    const reference = await captureCriterionExecution({ repoRoot: repo, config, gateName: 'behavior', headSha, inputs: [input], readInputDigest: () => inputDigest });
    assert.equal(require('node:fs').existsSync(join(repo, 'escaped-marker')), false);
    assert.match(validateCriterionExecution({ repoRoot: repo, config, reference, headSha, inputs: [input], inputDigest, recordedAt: new Date(Date.now() + 1000).toISOString() }).join('\n'), /did not pass/);
  });

  it('rejects a trusted-store junction before executing the gate', async () => {
    const { repo, config, headSha, input } = fixture();
    const storeParent = join(repo, '.git', 'qube', 'aie');
    const outside = mkdtempSync(join(tmpdir(), 'criterion-store-'));
    mkdirSync(storeParent, { recursive: true });
    symlinkSync(outside, join(storeParent, 'host-provenance'), process.platform === 'win32' ? 'junction' : 'dir');
    let calls = 0;
    await assert.rejects(captureCriterionExecution({
      repoRoot: repo, config, gateName: 'behavior', headSha, inputs: [input], readInputDigest: () => criterionInputDigest([input]),
      exec: async args => { calls += 1; return { args, exitCode: 0, stdout: '', stderr: '' }; },
    }), /symlink|junction/);
    assert.equal(calls, 0);
  });
});
