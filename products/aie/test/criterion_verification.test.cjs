const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { describe, it } = require('node:test');
require('./support/compile_cache.cjs');
const { cloneGitRepo } = require('./support/git_fixture.cjs');
const { configToFileShape, getDefaults } = require('../dist/config/index.js');
const { verifyIssueChecklist } = require('../dist/app/checklist_verify.js');
const { buildCriterionSnapshot, hashFile } = require('../dist/app/criterion_inputs.js');

const PR_ARGS = 'pr view --json number,title,url,headRefOid,body';
const ISSUE_ARGS = 'issue view 93 --json number,title,state,labels,body,milestone,url';
const criterionText = 'The guide describes a bounded stop rule.';
const success = (args, payload) => ({ args, exitCode: 0, stdout: payload === undefined ? '' : JSON.stringify(payload), stderr: '' });
function git(repo, args) { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function input(repo, path, kind = 'source') { return { kind, path, sha256: hashFile(join(repo, path)) }; }
function map(text = criterionText, source = '`guide.md`', proof = 'Source inspection of `guide.md` confirms the explicit bound.') {
  return `## Criterion-to-proof map\n\n### Criterion 1: ${text}\n\n- Implemented at: ${source}\n- Proven by: ${proof}\n- Negative case: A missing bound would contradict the cited source.\n`;
}
function fixture() {
  const repo = cloneGitRepo('committed', 'criterion-verification-');
  writeFileSync(join(repo, 'guide.md'), 'Stop after three follow-ups.\n');
  git(repo, ['add', 'guide.md']);
  git(repo, ['commit', '-m', 'Add bounded stop guidance']);
  const head = git(repo, ['rev-parse', 'HEAD']);
  const evidencePath = join(repo, 'acceptance.json');
  const record = {
    version: 1,
    criterion: { issueNumber: 93, index: 1, text: criterionText },
    revision: { kind: 'pr', headSha: head },
    criterionToProof: map(),
    inputs: [input(repo, 'guide.md')], artifacts: [],
    proof: { kind: 'source-inspection', observation: 'The guide explicitly stops continuation after three follow-ups.' },
    recordedAt: new Date().toISOString(), recommendation: 'approve',
  };
  const f = { repo, head, evidencePath, record, body: `Intro\r\n- [ ] ${criterionText}\r\n- [x] Another requirement\r\nFooter`, pr: true, calls: [], issueReads: 0, prReads: 0 };
  f.save = () => writeFileSync(evidencePath, JSON.stringify(record));
  f.exec = async args => {
    f.calls.push(args);
    if (args.join(' ') === ISSUE_ARGS) {
      f.issueReads += 1;
      if (f.onIssueRead) f.onIssueRead(f.issueReads);
      return success(args, { number: 93, title: 'Acceptance verification', body: f.body, state: 'OPEN', labels: [{ name: 'S-InProgress' }], milestone: null, url: 'https://github.com/example/repo/issues/93' });
    }
    if (args.join(' ') === PR_ARGS) {
      f.prReads += 1;
      if (f.onPrRead) f.onPrRead(f.prReads);
      return f.pr ? success(args, { number: 12, title: 'Bounded stop', url: 'https://github.com/example/repo/pull/12', headRefOid: f.head, body: f.prBody ?? record.criterionToProof }) : { args, exitCode: 1, stdout: '', stderr: 'no pull requests found for branch "work"' };
    }
    if (args[0] === 'issue' && args[1] === 'edit') { f.body = args[4]; return success(args); }
    throw new Error(`Unexpected provider call ${args.join(' ')}`);
  };
  f.verify = (options = {}) => verifyIssueChecklist({ issueNumber: 93, index: 1, state: 'checked', cwd: repo, evidencePath, dryRun: false, promptOnly: false, exec: f.exec, ...options });
  f.writes = () => f.calls.filter(args => args[0] === 'issue' && args[1] === 'edit');
  f.save();
  return f;
}

describe('criterion proof verification', () => {
  it('uses current source inspection without a reviewer or execution record and changes exactly one checkbox', async () => {
    const f = fixture();
    const expected = f.body.replace('- [ ]', '- [x]');
    const result = await f.verify();
    assert.equal(result.evidence.status, 'verified', result.evidence.errors.join('\n'));
    assert.equal(result.mutation.status, 'completed');
    assert.deepEqual(result.identity, f.record.criterion);
    assert.equal(f.writes().length, 1);
    assert.equal(f.body, expected);
    const repeat = await f.verify();
    assert.equal(repeat.mutation.status, 'skipped');
    assert.equal(f.writes().length, 1);
  });

  it('renders a reusable criterion-specific template without requiring an independent reviewer', async () => {
    const f = fixture();
    const result = await f.verify({ promptOnly: true, runGate: 'behavior' });
    assert.equal(result.prompt.category.id, 'acceptance-verification');
    assert.match(result.prompt.text, /Criterion #1:/);
    assert.match(result.prompt.text, /source-inspection/);
    assert.equal(result.prompt.promptStack.some(fragment => fragment.id.startsWith('hosts/') || fragment.id.startsWith('descriptors/')), false);
    assert.equal(f.writes().length, 0);
  });

  it('preserves compatible proof after unrelated committed and uncommitted edits', async () => {
    const f = fixture();
    writeFileSync(join(f.repo, 'unrelated.txt'), 'unrelated\n');
    git(f.repo, ['add', 'unrelated.txt']); git(f.repo, ['commit', '-m', 'Add unrelated text']);
    f.head = git(f.repo, ['rev-parse', 'HEAD']);
    writeFileSync(join(f.repo, 'unrelated.txt'), 'other unrelated work\n');
    const result = await f.verify();
    assert.equal(result.evidence.status, 'verified', result.evidence.errors.join('\n'));
    assert.equal(f.writes().length, 1);
  });

  it('binds dirty pre-PR inputs to a reproducible snapshot and can reuse them after they are committed', async () => {
    const f = fixture();
    f.pr = false;
    writeFileSync(join(f.repo, 'guide.md'), 'Stop after two follow-ups.\n');
    f.record.inputs = [input(f.repo, 'guide.md')];
    f.record.revision = { kind: 'work-snapshot', ...buildCriterionSnapshot(f.repo, f.head, f.record.inputs) };
    f.save();
    const planned = await f.verify({ dryRun: true });
    assert.equal(planned.evidence.status, 'verified', planned.evidence.errors.join('\n'));
    assert.equal(f.writes().length, 0);
    git(f.repo, ['add', 'guide.md']); git(f.repo, ['commit', '-m', 'Tighten stop bound']);
    f.head = git(f.repo, ['rev-parse', 'HEAD']); f.pr = true;
    const result = await f.verify();
    assert.equal(result.evidence.status, 'verified', result.evidence.errors.join('\n'));
  });

  for (const initializeGit of [false, true]) it(`returns inconclusive when the pre-PR Git snapshot is unavailable (${initializeGit ? 'unborn HEAD' : 'no repository'})`, async () => {
    const f = fixture();
    f.pr = false;
    const cwd = mkdtempSync(join(tmpdir(), 'criterion-no-snapshot-'));
    if (initializeGit) git(cwd, ['init']);
    const result = await f.verify({ cwd });
    assert.equal(result.evidence.status, 'inconclusive');
    assert.match(result.evidence.errors.join(' '), /Git snapshot is unavailable/);
    assert.equal(result.mutation.status, 'blocked');
    assert.equal(f.writes().length, 0);
  });

  for (const [name, change, expected] of [
    ['missing revision without a PR', f => { f.pr = false; delete f.record.revision; }, /revision|snapshot/],
    ['PR binding without a PR', f => { f.pr = false; }, /No PR exists/],
    ['fabricated work snapshot', f => { f.pr = false; f.record.revision = { kind: 'work-snapshot', headSha: f.head, sha256: '0'.repeat(64) }; }, /snapshot SHA/],
    ['wrong issue', f => { f.record.criterion.issueNumber = 94; }, /exact issue/],
    ['wrong index', f => { f.record.criterion.index = 2; }, /exact issue/],
    ['punctuation drift', f => { f.record.criterion.text += '!'; }, /full text/],
    ['unknown head', f => { f.record.revision.headSha = '0'.repeat(40); }, /ancestor/],
    ['partial full head', f => { f.record.revision.headSha = 'a'.repeat(41); }, /full head SHA/],
    ['invalid timestamp', f => { f.record.recordedAt = 'not-a-date'; }, /timestamp/],
    ['impossible date', f => { f.record.recordedAt = '2026-02-31T01:02:03.000Z'; }, /timestamp/],
    ['future timestamp', f => { f.record.recordedAt = new Date(Date.now() + 60000).toISOString(); }, /future/],
    ['malformed input entry', f => { f.record.inputs = ['guide.md']; }, /malformed/],
    ['missing digest', f => { delete f.record.inputs[0].sha256; }, /SHA-256/],
    ['changed digest', f => { f.record.inputs[0].sha256 = '0'.repeat(64); }, /current content/],
    ['missing artifact', f => { f.record.artifacts = [{ kind: 'observation', path: 'missing.txt', sha256: '0'.repeat(64) }]; }, /does not exist/],
    ['non-file artifact', f => { mkdirSync(join(f.repo, 'folder')); f.record.artifacts = [{ kind: 'observation', path: 'folder', sha256: '0'.repeat(64) }]; }, /not a repository file/],
    ['escaping path', f => { f.record.inputs[0].path = '../guide.md'; }, /repository-relative/],
    ['absolute path', f => { f.record.inputs[0].path = join(f.repo, 'guide.md'); }, /repository-relative/],
    ['duplicate inputs', f => { f.record.inputs.push(f.record.inputs[0]); }, /duplicate/],
    ['unbound cited file', f => { f.record.criterionToProof = map(criterionText, '`guide.md` and `behavior.cjs`'); }, /missing its required/],
    ['different PR proof map', f => { f.prBody = map(criterionText, '`guide.md`', 'A changed observation of `guide.md`.'); }, /current PR entry/],
    ['uncommitted PR behavior', f => { writeFileSync(join(f.repo, 'guide.md'), 'Changed rule.\n'); f.record.inputs = [input(f.repo, 'guide.md')]; }, /current PR revision/],
    ['self-declared execution', f => { f.record.proof = { ...f.record.proof, kind: 'test-result', execution: { path: 'passed.log', sha256: '0'.repeat(64) }, runner: 'trusted' }; }, /behavioral test/],
    ['prompt narration', f => { f.record.proof = { ...f.record.proof, kind: 'prompted-review', promptStack: [{ id: 'acceptance/verify-criterion', sha256: '0'.repeat(64) }] }; }, /existing current-PR/],
  ]) it(`rejects ${name} without any provider mutation`, async () => {
    const f = fixture(); const before = f.body;
    change(f); f.save();
    const result = await f.verify();
    assert.equal(result.ok, false);
    assert.match(result.evidence.errors.join('\n'), expected);
    assert.equal(f.body, before); assert.equal(f.writes().length, 0);
  });

  it('rejects source bytes changed since approval even when the current PR contains the edit', async () => {
    const f = fixture();
    writeFileSync(join(f.repo, 'guide.md'), 'Stop without a bound.\n');
    git(f.repo, ['add', 'guide.md']); git(f.repo, ['commit', '-m', 'Change rule']);
    f.head = git(f.repo, ['rev-parse', 'HEAD']);
    const result = await f.verify();
    assert.equal(result.ok, false); assert.equal(f.writes().length, 0);
    assert.match(result.evidence.errors.join('\n'), /current content/);
  });

  it('rejects a junction that redirects a cited artifact outside the repository', async () => {
    const f = fixture(); const outside = mkdtempSync(join(tmpdir(), 'criterion-outside-'));
    writeFileSync(join(outside, 'observation.txt'), 'Observed bound.\n');
    symlinkSync(outside, join(f.repo, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    f.record.artifacts = [{ kind: 'observation', path: 'linked/observation.txt', sha256: hashFile(join(outside, 'observation.txt')) }];
    f.save();
    const result = await f.verify();
    assert.equal(result.ok, false); assert.match(result.evidence.errors.join('\n'), /outside|symlink|junction/); assert.equal(f.writes().length, 0);
  });

  it('accepts direct observation artifacts and rejects changed artifact bytes', async () => {
    const f = fixture();
    writeFileSync(join(f.repo, 'observation.txt'), 'Observed stopping after the third follow-up.\n');
    f.record.artifacts = [input(f.repo, 'observation.txt', 'observation')];
    f.record.proof.kind = 'direct-observation'; f.save();
    assert.equal((await f.verify({ dryRun: true })).evidence.status, 'verified');
    writeFileSync(join(f.repo, 'observation.txt'), 'Different observation.\n');
    assert.equal((await f.verify()).ok, false); assert.equal(f.writes().length, 0);
  });

  it('rechecks edited criterion identity and preserves unrelated provider text', async () => {
    const f = fixture();
    f.onIssueRead = count => { if (count === 2) f.body = f.body.replace(criterionText, 'A different requirement.'); };
    const result = await f.verify();
    assert.equal(result.evidence.status, 'inconclusive'); assert.equal(f.writes().length, 0);
    assert.match(result.evidence.errors.join('\n'), /criterion changed/);
    const g = fixture();
    g.onIssueRead = count => { if (count === 2) g.body += '\r\nNew unrelated detail.'; };
    const changed = await g.verify();
    assert.equal(changed.ok, true); assert.match(g.body, /New unrelated detail\.$/);
  });

  it('rechecks source, evidence document, and PR head immediately before mutation', async () => {
    for (const change of [
      f => writeFileSync(join(f.repo, 'guide.md'), 'Changed during verification.'),
      f => { f.record.proof.observation = 'Changed during verification.'; f.save(); },
      f => { f.head = '0'.repeat(40); },
    ]) {
      const f = fixture(); f.onPrRead = count => { if (count === 2) change(f); };
      const result = await f.verify();
      assert.equal(result.ok, false); assert.equal(f.writes().length, 0);
    }
  });

  it('never writes for rejected, inconclusive, dry-run, or prompt-only verification', async () => {
    for (const recommendation of ['request-changes', 'inconclusive']) {
      const f = fixture(); f.record.recommendation = recommendation; f.save();
      const result = await f.verify({ runGate: 'not-executed' });
      assert.equal(result.ok, false); assert.equal(f.writes().length, 0);
    }
    const f = fixture();
    assert.equal((await f.verify({ dryRun: true })).mutation.status, 'planned');
    assert.equal((await f.verify({ promptOnly: true })).mutation.status, 'skipped');
    assert.equal(f.writes().length, 0);
  });

  it('binds a real behavioral test, reuses its observed result, and refuses completion when required behavior is removed', async () => {
    const f = fixture();
    const config = getDefaults();
    config.gates = [{ name: 'behavior', kind: 'unit', command: 'node --test behavior.test.cjs', stage: 'pre-pr', required: true, timeoutSeconds: 10, workingDirectory: '.', env: {}, externalService: false }];
    config.policy.gates.definitions = config.gates.map(gate => ({ ...gate }));
    mkdirSync(join(f.repo, '.qube', 'aie'), { recursive: true });
    writeFileSync(join(f.repo, '.qube', 'aie', 'config.json'), JSON.stringify(configToFileShape(config)));
    writeFileSync(join(f.repo, 'behavior.cjs'), 'exports.stopLimit = 3;\n');
    writeFileSync(join(f.repo, 'behavior.test.cjs'), "require('node:assert/strict').equal(require('./behavior.cjs').stopLimit, 3);\n");
    git(f.repo, ['add', '.qube/aie/config.json', 'behavior.cjs', 'behavior.test.cjs']); git(f.repo, ['commit', '-m', 'Add bounded stop test']);
    f.head = git(f.repo, ['rev-parse', 'HEAD']);
    f.record.inputs = [input(f.repo, 'behavior.cjs'), input(f.repo, 'behavior.test.cjs', 'test')];
    f.record.revision = { kind: 'pr', headSha: f.head };
    f.record.criterionToProof = map(criterionText, '`behavior.cjs`', 'The assertions in `behavior.test.cjs` require a stop limit of three.');
    f.record.proof.kind = 'test-result'; f.record.proof.gateName = 'behavior'; f.save();
    let executed = 0;
    const noRun = await f.verify({ config, dryRun: true, runGate: 'behavior', commandExec: async () => { executed += 1; throw new Error('must not execute'); } });
    assert.equal(noRun.ok, false); assert.equal(executed, 0);
    const passed = await f.verify({ config, runGate: 'behavior' });
    assert.equal(passed.ok, true, passed.evidence.errors.join('\n')); assert.equal(f.writes().length, 1);
    f.record.proof.execution = passed.evidence.execution; f.record.recordedAt = new Date().toISOString(); f.save();
    const repeated = await f.verify({ config });
    assert.equal(repeated.evidence.status, 'verified', repeated.evidence.errors.join('\n')); assert.equal(f.writes().length, 1);
    f.body = f.body.replace('- [x]', '- [ ]');
    writeFileSync(join(f.repo, 'behavior.cjs'), 'exports.stopLimit = undefined;\n');
    git(f.repo, ['add', 'behavior.cjs']); git(f.repo, ['commit', '-m', 'Remove bounded stop behavior']);
    f.head = git(f.repo, ['rev-parse', 'HEAD']);
    f.record.inputs = [input(f.repo, 'behavior.cjs'), input(f.repo, 'behavior.test.cjs', 'test')];
    f.record.revision = { kind: 'pr', headSha: f.head }; delete f.record.proof.execution; f.save();
    const failed = await f.verify({ config, runGate: 'behavior' });
    assert.equal(failed.ok, false); assert.match(failed.evidence.errors.join('\n'), /did not pass/); assert.equal(f.writes().length, 1);
  });
});
