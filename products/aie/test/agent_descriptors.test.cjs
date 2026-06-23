const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

describe('agent descriptors and prompt registry', () => {
  it('renders deterministic prompt stacks with ids, paths, hashes, trust, and output contract', async () => {
    const { renderAgentPrompt } = await import('../dist/agent_descriptors.js');

    const first = renderAgentPrompt({
      hostId: 'fallback-single-agent',
      descriptorId: 'qa-reviewer',
      categoryId: 'review',
      laneIds: ['issue-compliance', 'code-quality'],
      contextLines: ['Review issue #170.'],
      outputContract: 'Return findings and residual risk.',
    });
    const second = renderAgentPrompt({
      hostId: 'fallback-single-agent',
      descriptorId: 'qa-reviewer',
      categoryId: 'review',
      laneIds: ['issue-compliance', 'code-quality'],
      contextLines: ['Review issue #170.'],
      outputContract: 'Return findings and residual risk.',
    });

    assert.deepEqual(first.orderedFragmentIds, second.orderedFragmentIds);
    assert.deepEqual(first.hashes, second.hashes);
    assert.equal(first.outputContract, 'Return findings and residual risk.');
    assert.ok(first.orderedFragmentIds.includes('safety/review-output-untrusted'));
    assert.ok(first.sourcePaths.includes('prompts/descriptors/qa-reviewer.md'));
    assert.ok(first.promptStack.every(fragment => /^[a-f0-9]{64}$/.test(fragment.sha256)));
    assert.ok(first.promptStack.some(fragment => fragment.sourceCategory === 'lane' && fragment.trust === 'policy'));
    assert.match(first.text, /## safety\/repository-policy/);
  });

  it('detects missing prompt assets without claiming runner availability', async () => {
    const { buildDescriptorSummary, validatePromptAssets } = await import('../dist/agent_descriptors.js');
    const root = mkdtempSync(join(tmpdir(), 'aie-prompts-'));
    writeFileSync(join(root, 'placeholder.md'), 'not enough\n');

    const validation = validatePromptAssets(root);
    const summary = buildDescriptorSummary();

    assert.equal(validation.ok, false);
    assert.ok(validation.missing.some(path => path.endsWith('safety/review-output-untrusted.md')));
    assert.equal(summary.runnerAvailability, 'unavailable');
    assert.ok(summary.agents.some(agent => agent.id === 'explorer'));
    assert.ok(summary.categories.some(category => category.id === 'acceptance-verification'));
  });
});
