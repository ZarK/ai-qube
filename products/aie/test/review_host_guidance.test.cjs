'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const {
  renderClaudeReviewFocusAgent,
  renderCodexReviewFocusAgent,
  renderGrokReviewFocusAgent,
  renderOpenCodeReviewFocusAgent,
} = require('../dist/init_content.js');
const { listAgentHostAdapters, reviewerDisplayName } = require('../dist/agent_host_adapters.js');
const { writeLane } = require('../dist/app/local_review_runner_support.js');
const { readFileSync } = require('node:fs');

const CONTRACT = [
  /runnerProvenance/,
  /review session lock/,
  /do not run git restore/,
  /pr review publish/,
  /Do not approve stale evidence/,
];

describe('host review subagent guidance', () => {
  it('renders the same operational contract on every host review-focus asset', () => {
    const rendered = [
      renderCodexReviewFocusAgent(),
      renderClaudeReviewFocusAgent(),
      renderOpenCodeReviewFocusAgent(),
      renderGrokReviewFocusAgent(),
    ];
    for (const body of rendered) {
      for (const pattern of CONTRACT) assert.match(body, pattern);
      assert.doesNotMatch(body, /host codex/);
    }
  });

  it('does not attribute missing provenance host to a vendor', () => {
    const root = mkdtempSync(join(tmpdir(), 'aie-host-identity-'));
    const path = writeLane(root, 461, 512, 'abc123', 'local-focused', {
      id: 'code-quality',
      status: 'passed',
      severity: 'none',
      recommendation: 'approve',
      summary: 'ok',
      blockers: [],
      findings: [],
      artifacts: [],
      commands: [],
      surfaces: [],
      contextReviewed: [],
      promptStack: [],
      toolsUsed: [],
      completeness: 'inspected',
      preconditions: [],
      runnerProvenance: {
        runnerKind: 'local-host',
        host: '',
        freshContext: true,
        promptOnly: false,
        taskId: 't',
        sessionId: 's',
        threadId: null,
        promptStackHash: 'a'.repeat(64),
        headSha: 'abc123',
        providerPublishStatus: null,
        model: null,
        effort: null,
        isolation: 'read-only',
        invocationId: 'i',
        routeSource: 'configured',
      },
    }, 'local-host');
    const body = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(body.reviewer.id, 'unknown-host');
    assert.equal(body.reviewer.name, 'unknown-host');
    assert.doesNotMatch(body.reviewer.id, /codex/i);
    assert.doesNotMatch(body.reviewer.name, /codex/i);
  });

  it('resolves reviewer display names for every registered host', () => {
    for (const adapter of listAgentHostAdapters()) {
      assert.equal(reviewerDisplayName(adapter.id), adapter.displayName);
    }
    assert.equal(reviewerDisplayName('grok'), 'Grok Build');
    assert.equal(reviewerDisplayName(''), 'unknown-host');
    assert.equal(reviewerDisplayName(null), 'unknown-host');
  });
});
