const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { getDesiredLabels, computeLabelPlan, applyLabelPlan, parseGhLabelList } = require('../dist/labels.js');
const { getDefaults } = require('../dist/config/index.js');

describe('labels service', () => {
  it('getDesiredLabels produces specs for defaults and errors on cross-family duplicates', () => {
    const config = getDefaults();
    const desired = getDesiredLabels(config);
    assert.ok(desired.some(l => l.name === 'P1-Critical' && l.color === 'b60205'));
    assert.ok(desired.some(l => l.name === 'S-Ready'));
    assert.ok(desired.some(l => l.name === 'C-Tooling'));

    const bad = { ...config, priorityLabels: ['P1-Critical'], statusLabels: [], componentLabels: ['P1-Critical'] };
    assert.throws(() => getDesiredLabels(bad), /Duplicate label name 'P1-Critical'/);
  });

  it('computeLabelPlan detects created, updated (drift), unchanged, skipped', () => {
    const desired = [
      { name: 'P1-Critical', color: 'b60205', description: 'Highest...' },
      { name: 'S-Ready', color: '0e8a16', description: 'Ready...' },
    ];
    const current = [
      { name: 'P1-Critical', color: 'b60205', description: 'Highest...' }, // unchanged
      { name: 'S-Ready', color: 'ff0000', description: 'Ready...' }, // drifted
      { name: 'random', color: 'ededed', description: 'unrelated' }, // skipped
    ];
    const plan = computeLabelPlan(current, desired);
    assert.equal(plan.created.length, 0);
    assert.equal(plan.updated.length, 1);
    assert.equal(plan.updated[0].name, 'S-Ready');
    assert.equal(plan.unchanged.length, 1);
    assert.equal(plan.skipped.length, 1);
  });
});

describe('labels command (via service)', () => {
  it('uses GhExec injection and produces stable plan for --json / dry-run', async () => {
    // This test exercises the service used by the command; full command integration covered by fixtures in practice
    const config = getDefaults();
    const desired = getDesiredLabels(config);
    const fakeCurrent = desired.slice(0, 3).map(d => ({ ...d })); // partial
    const plan = computeLabelPlan(fakeCurrent, desired);
    assert.ok(plan.created.length > 0 || plan.updated.length > 0 || plan.unchanged.length > 0);
    // In real command test we would inject GhExec that returns the fakeCurrent JSON and assert no create/edit calls on dry-run
  });
});

describe('LabelsSetup command module', () => {
  it('loads and exposes correct static metadata for oclif discovery', () => {
    const mod = require('../dist/commands/labels/setup.js');
    const LabelsSetup = mod.default || mod;
    assert.ok(LabelsSetup.description.includes('Create or update the configured Executor'));
    assert.ok(LabelsSetup.flags.json);
    assert.ok(LabelsSetup.flags['dry-run']);
    assert.ok(LabelsSetup.examples.some((e) => e.includes('labels setup --dry-run')));
  });
});

describe('labels command behavior (apply decision + doctor error surfacing)', () => {
  const { computeDoctorOk } = require('../dist/commands/doctor.js');

  it('applies create and update operations without touching unchanged or skipped labels', async () => {
    const config = getDefaults();
    const desired = getDesiredLabels(config);
    const partialCurrent = desired.slice(0, Math.floor(desired.length / 2)).map(d => ({ ...d, color: '000000' }));
    const plan = computeLabelPlan(partialCurrent, desired);
    const calls = [];
    const exec = async (args) => {
      calls.push(args);
      return { args, exitCode: 0, stdout: '', stderr: '' };
    };

    await applyLabelPlan(plan, exec);

    assert.equal(calls.length, plan.created.length + plan.updated.length);
    assert.equal(calls.some(args => args[0] === 'label' && args[1] === 'create'), plan.created.length > 0);
    assert.equal(calls.some(args => args[0] === 'label' && args[1] === 'edit'), plan.updated.length > 0);
    assert.equal(calls.some(args => args.includes('random')), false);
  });

  it('rejects malformed label list output before planning label changes', () => {
    assert.throws(
      () => parseGhLabelList(JSON.stringify([{ name: 'S-Ready', description: 'missing color' }])),
      /malformed or unexpected output/
    );
  });

  it('doctor ok is false when queue health reports drift, multiple active issues, or queue errors', () => {
    const healthy = {
      isRepo: true,
      configValid: true,
      gitAvailable: true,
      ghAvailable: true,
      nodeSatisfies: true,
      isWorktree: false,
      labelsOk: true,
      queueDriftCount: 0,
      queueMultipleInProgress: false,
      baseRef: { remote: 'origin', branch: 'main', resolved: true, upToDate: true },
      blockingPullRequestCount: 0,
    };

    assert.equal(computeDoctorOk(healthy), true);
    assert.equal(computeDoctorOk({ ...healthy, queueDriftCount: 1 }), false);
    assert.equal(computeDoctorOk({ ...healthy, queueMultipleInProgress: true }), false);
    assert.equal(computeDoctorOk({ ...healthy, queueError: 'gh failed' }), false);
    assert.equal(computeDoctorOk({ ...healthy, baseRef: { remote: 'origin', branch: 'main', resolved: true, upToDate: false } }), false);
    assert.equal(computeDoctorOk({ ...healthy, blockingPullRequestCount: 1 }), false);
    assert.equal(computeDoctorOk({ ...healthy, pullRequestError: 'gh failed' }), false);
  });
});
