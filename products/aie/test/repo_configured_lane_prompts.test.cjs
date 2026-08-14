'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { promptStack, expectedLaneFragmentDigest } = require('../dist/app/local_review_runner_support.js');
const { repoConfiguredFragment } = require('../dist/agent_descriptors.js');
const { createHash } = require('node:crypto');

describe('repo-configured lane spawn prompts', () => {
  it('renders repository fragments in every lane spawnPrompt', () => {
    const repository = ['Keep package files and runtime loaders aligned.'];
    const issue = promptStack('issue-compliance', ['Run local review lane issue-compliance.'], [], undefined, { repository });
    const quality = promptStack('code-quality', ['Run local review lane code-quality.'], [], undefined, { repository });
    assert.match(issue.text, /Repo-configured guidance/);
    assert.match(quality.text, /Keep package files and runtime loaders aligned/);
    assert.match(issue.text, /Keep package files and runtime loaders aligned/);
    const expected = repoConfiguredFragment(repository[0]);
    assert.ok(issue.promptStack.some(entry => entry.id === expected.id && entry.sha256 === expected.sha256 && entry.trust === 'repo-doc'));
    assert.ok(quality.promptStack.some(entry => entry.id === expected.id && entry.sha256 === expected.sha256 && entry.trust === 'repo-doc'));
  });

  it('renders per-lane prompt entries only into that lane', () => {
    const onlyIssue = promptStack('issue-compliance', ['Run local review lane issue-compliance.'], [], undefined, {
      lanePrompt: ['Only the issue-compliance lane should see this sentence.'],
    });
    const onlyQuality = promptStack('code-quality', ['Run local review lane code-quality.'], [], undefined, {
      lanePrompt: ['Only the code-quality lane should see this sentence.'],
    });
    assert.match(onlyIssue.text, /Only the issue-compliance lane should see this sentence/);
    assert.doesNotMatch(onlyIssue.text, /Only the code-quality lane should see this sentence/);
    assert.match(onlyQuality.text, /Only the code-quality lane should see this sentence/);
    assert.doesNotMatch(onlyQuality.text, /Only the issue-compliance lane should see this sentence/);
  });

  it('records the same provenance fields the issue-review stack uses', () => {
    const fragment = 'Repository ownership: adapters own provider encoding.';
    const rendered = promptStack('code-quality', ['Run local review lane code-quality.'], [], undefined, { repository: [fragment] });
    const entry = rendered.promptStack.find(item => item.source === 'repo-configured');
    const expectedHash = createHash('sha256').update(fragment).digest('hex');
    assert.equal(entry.id, fragment);
    assert.equal(entry.sha256, expectedHash);
    assert.equal(entry.trust, 'repo-doc');
    assert.equal(entry.source, 'repo-configured');
  });

  it('changes the carry-forward digest when repository guidance changes', () => {
    const before = expectedLaneFragmentDigest('issue-compliance', undefined, { repository: ['first guidance'] });
    const after = expectedLaneFragmentDigest('issue-compliance', undefined, { repository: ['second guidance'] });
    const unchanged = expectedLaneFragmentDigest('issue-compliance', undefined, { repository: ['first guidance'] });
    assert.notEqual(before, after);
    assert.equal(before, unchanged);
  });
});
