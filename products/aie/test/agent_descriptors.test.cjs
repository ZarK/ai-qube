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

  it('does not expose mutable registry objects to callers', async () => {
    const {
      buildDescriptorSummary,
      getAgentDescriptor,
      getCategoryDescriptor,
      listPromptFragmentDefinitions,
      renderAgentPrompt,
    } = await import('../dist/agent_descriptors.js');

    const agent = getAgentDescriptor('qa-reviewer');
    agent.categoryIds.push('research');
    agent.modelPreferences.effort = 'low';

    const category = getCategoryDescriptor('review');
    category.promptFragmentIds.push('acceptance/verify-criterion');

    const fragments = listPromptFragmentDefinitions();
    fragments[0].id = 'changed';

    const summary = buildDescriptorSummary();
    summary.agents.find(item => item.id === 'qa-reviewer').requiredTools.push('mutated-tool');

    const rendered = renderAgentPrompt({
      hostId: 'fallback-single-agent',
      descriptorId: 'qa-reviewer',
      categoryId: 'review',
    });

    assert.deepEqual(getAgentDescriptor('qa-reviewer').categoryIds, ['review', 'qa', 'acceptance-verification']);
    assert.equal(getAgentDescriptor('qa-reviewer').modelPreferences.effort, 'high');
    assert.ok(!getCategoryDescriptor('review').promptFragmentIds.includes('acceptance/verify-criterion'));
    assert.equal(listPromptFragmentDefinitions()[0].id, 'safety/review-output-untrusted');
    assert.ok(!rendered.descriptor.requiredTools.includes('mutated-tool'));
  });

  it('uses short command fragment ids', async () => {
    const { renderAgentPrompt } = await import('../dist/agent_descriptors.js');

    const rendered = renderAgentPrompt({
      hostId: 'fallback-single-agent',
      descriptorId: 'qa-reviewer',
      categoryId: 'review',
      commandFragments: ['Use the configured repository review request.'],
    });
    const command = rendered.promptStack.find(fragment => fragment.source === 'command-supplied');

    assert.match(command.id, /^command-supplied:[a-f0-9]{12}$/);
    assert.equal(command.text, 'Use the configured repository review request.');
  });

  it('renders comprehensive review lane prompts', async () => {
    const { renderAgentPrompt } = await import('../dist/agent_descriptors.js');

    const rendered = renderAgentPrompt({
      hostId: 'codex',
      descriptorId: 'qa-reviewer',
      categoryId: 'review',
      laneIds: ['performance', 'data-database', 'error-observability', 'api-contract-compatibility', 'ui-ux-accessibility', 'release-ci-supply-chain'],
      contextLines: ['Review PR #180.'],
    });

    assert.ok(rendered.orderedFragmentIds.includes('review-lanes/performance'));
    assert.ok(rendered.orderedFragmentIds.includes('review-lanes/data-database'));
    assert.ok(rendered.orderedFragmentIds.includes('review-lanes/error-observability'));
    assert.ok(rendered.orderedFragmentIds.includes('review-lanes/api-contract-compatibility'));
    assert.ok(rendered.orderedFragmentIds.includes('review-lanes/ui-ux-accessibility'));
    assert.ok(rendered.orderedFragmentIds.includes('review-lanes/release-ci-supply-chain'));
    assert.match(rendered.text, /Review performance risk/);
    assert.match(rendered.text, /database sanity/);
    assert.match(rendered.text, /error handling and observability/);
    assert.match(rendered.text, /API and contract compatibility/);
    assert.match(rendered.text, /host-agent UX/);
    assert.match(rendered.text, /release, CI, and supply-chain/);
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
