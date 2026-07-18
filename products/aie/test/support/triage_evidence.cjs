'use strict';

const { createHash } = require('node:crypto');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { localReviewEvidenceSha256, requiredLocalReviewLanes } = require('../../dist/local_review_evidence.js');

function safeSegment(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function promptStackHash(stack) {
  return createHash('sha256').update(JSON.stringify(stack.map(item => ({ id: item.id, sha256: item.sha256, source: item.source })))).digest('hex');
}

function laneEvidenceBody(repo, lane, findings, { issueNumber, prNumber, headSha, status, recommendation }) {
  const promptStack = [{ id: 'builtin:review-profile:local-standard', source: 'builtin', path: null, sha256: 'test-hash', trust: 'policy' }];
  const runnerProvenance = {
    runnerKind: 'local-host',
    host: 'codex',
    freshContext: true,
    promptOnly: false,
    taskId: `triage-task-${lane}`,
    sessionId: null,
    threadId: null,
    promptStackHash: promptStackHash(promptStack),
    headSha,
    providerPublishStatus: null,
  };
  return {
    version: 1,
    issueNumber,
    prNumber,
    headSha,
    profile: 'local-standard',
    adapter: 'local-host',
    lane,
    status,
    severity: 'none',
    recommendation,
    summary: `${lane} reviewed`,
    blockers: [],
    findings,
    artifacts: [{ kind: 'json', path: `.qube/aie/reviews/${issueNumber}/${prNumber}/${headSha}/${lane}.json`, sha256: 'test-hash' }],
    commands: [`qube aie view ${issueNumber}`],
    surfaces: ['PR'],
    contextReviewed: [
      { kind: 'agents', source: 'AGENTS.md', trust: 'policy', freshness: 'current' },
      { kind: 'diff', source: 'git diff origin/main...HEAD', trust: 'local-evidence', freshness: 'current' },
    ],
    promptStack,
    toolsUsed: ['codex'],
    completeness: `Inspected the complete ${lane} scope at the current head.`,
    preconditions: [],
    runnerProvenance,
  };
}

function writeValidLaneEvidence(repo, lane, findings, { issueNumber = 93, prNumber = 12, headSha = 'abc123', status = 'passed', recommendation = 'approve' } = {}) {
  const directory = join(repo, '.qube', 'aie', 'reviews', String(issueNumber), String(prNumber), headSha);
  mkdirSync(directory, { recursive: true });
  const body = laneEvidenceBody(repo, lane, findings, { issueNumber, prNumber, headSha, status, recommendation });
  writeFileSync(join(directory, `${lane}.json`), `${JSON.stringify(body, null, 2)}\n`);
  const provenanceDirectory = join(repo, '.git', 'qube', 'aie', 'host-provenance', String(issueNumber), String(prNumber), safeSegment(headSha));
  mkdirSync(provenanceDirectory, { recursive: true });
  writeFileSync(join(provenanceDirectory, `${lane}.json`), `${JSON.stringify({
    version: 1,
    issueNumber,
    prNumber,
    headSha,
    lane,
    evidenceSha256: localReviewEvidenceSha256(body),
    runnerKind: 'local-host',
    host: 'codex',
    freshContext: true,
    promptOnly: false,
    taskId: body.runnerProvenance.taskId,
    sessionId: null,
    threadId: null,
    promptStackHash: body.runnerProvenance.promptStackHash,
    model: null,
    effort: null,
    isolation: null,
    invocationId: null,
    recordedAt: '2026-07-18T00:00:00.000Z',
  }, null, 2)}\n`);
}

function writeApprovedHead(repo, codeQualityFindings, { except = [], headSha = 'abc123' } = {}) {
  for (const lane of requiredLocalReviewLanes('local-standard')) {
    if (except.includes(lane)) continue;
    writeValidLaneEvidence(repo, lane, lane === 'code-quality' ? codeQualityFindings : [], { headSha });
  }
}

module.exports = { writeApprovedHead, writeValidLaneEvidence };
