'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const { buildImplementationBrief, formatBriefLines } = require('../dist/brief/index.js');
const { buildImplementerSelfCheck, formatImplementerSelfCheck } = require('../dist/app/implementer_self_check.js');
const { getDefaults } = require('../dist/config/index.js');
const {
  IMPLEMENTER_LEARNINGS_CAP,
  IMPLEMENTER_LEARNINGS_FRAGMENT_ID,
  selectImplementerLearnings,
} = require('../dist/implementer_learnings.js');
const { selectImplementerLearnings: exportedSelector } = require('../dist/index.js');

function tempRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aie-implementer-learnings-'));
  fs.mkdirSync(path.join(repo, '.qube', 'aie'), { recursive: true });
  return repo;
}

function writeLearnings(repo, entries) {
  fs.writeFileSync(
    path.join(repo, '.qube', 'aie', 'review-learnings.json'),
    `${JSON.stringify({ version: 1, entries }, null, 2)}\n`,
  );
}

function accepted(id, recordedAt, paths, extras = {}) {
  return {
    id,
    disposition: 'accepted',
    findingId: extras.findingId ?? null,
    lane: extras.lane ?? 'code-quality',
    message: extras.message ?? `Accepted ${id}`,
    guidance: extras.guidance ?? `Design against ${id}.`,
    paths,
    prNumber: extras.prNumber ?? 12,
    headSha: extras.headSha ?? 'abc',
    recordedAt,
  };
}

function briefConfig() {
  const config = structuredClone(getDefaults());
  config.reviewProfile = 'local-focused';
  config.reviewLanes = [
    { id: 'issue-compliance', required: 'always', match: ['**/*'], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host', rereview: 'delta' },
  ];
  return config;
}

describe('implementer learnings', () => {
  it('injects accepted matching learnings into the brief and self-check with repo-doc trust', () => {
    const repo = tempRepo();
    writeLearnings(repo, [
      accepted('learning:match', '2026-08-13T12:00:00.000Z', ['products/aie/**'], {
        message: 'Keep brief and self-check labels distinct from built-in cards.',
        guidance: 'Render repo-configured learnings in their own subsection.',
      }),
    ]);
    const brief = buildImplementationBrief({
      title: 'Touch the brief builder',
      body: 'Change `products/aie/src/brief/build.ts`.\n\n- [ ] Unit test covers the learnings subsection.',
      config: briefConfig(),
      repoRoot: repo,
    });
    assert.equal(brief.repoLearnings.status, 'ok');
    assert.equal(brief.repoLearnings.trust, 'repo-doc');
    assert.equal(brief.repoLearnings.source, 'repo-configured');
    assert.equal(brief.repoLearnings.fragmentId, IMPLEMENTER_LEARNINGS_FRAGMENT_ID);
    assert.equal(typeof brief.repoLearnings.sha256, 'string');
    assert.equal(brief.repoLearnings.entries.length, 1);
    assert.equal(brief.repoLearnings.entries[0].id, 'learning:match');
    assert.equal(brief.repoLearnings.entries[0].trust, 'repo-doc');
    const briefText = formatBriefLines(brief).join('\n');
    assert.match(briefText, /Repo-configured learnings \(repo-doc; not built-in policy\):/);
    assert.match(briefText, /learning:match/);
    assert.match(briefText, /Render repo-configured learnings in their own subsection/);

    const selfCheck = buildImplementerSelfCheck({
      config: briefConfig(),
      changedPaths: ['products/aie/src/brief/build.ts'],
      repoRoot: repo,
    });
    assert.equal(selfCheck.repoLearnings.entries[0].id, 'learning:match');
    assert.equal(selfCheck.repoLearnings.trust, 'repo-doc');
    assert.match(formatImplementerSelfCheck(selfCheck).join('\n'), /Repo-configured learnings \(repo-doc; not built-in policy\):/);
  });

  it('renders none when accepted learnings do not match the issue scope', () => {
    const repo = tempRepo();
    writeLearnings(repo, [
      accepted('learning:docs', '2026-08-13T12:00:00.000Z', ['docs/**']),
    ]);
    const brief = buildImplementationBrief({
      title: 'Touch the brief builder',
      body: 'Change `products/aie/src/brief/build.ts`.\n\n- [ ] Unit test covers the learnings subsection.',
      config: briefConfig(),
      repoRoot: repo,
    });
    assert.equal(brief.repoLearnings.status, 'ok');
    assert.deepEqual(brief.repoLearnings.entries, []);
    assert.match(formatBriefLines(brief).join('\n'), /none matching/);

    const selfCheck = buildImplementerSelfCheck({
      config: briefConfig(),
      changedPaths: ['products/aie/src/brief/build.ts'],
      repoRoot: repo,
    });
    assert.deepEqual(selfCheck.repoLearnings.entries, []);
  });

  it('treats accepted learnings with no path triggers as candidates for every issue', () => {
    const repo = tempRepo();
    writeLearnings(repo, [
      accepted('learning:global', '2026-08-13T12:00:00.000Z', [], { message: 'Always design for truthful status.' }),
    ]);
    const brief = buildImplementationBrief({
      title: 'Wording pass',
      body: 'contestant latest errorship pretest wording improvements.',
      config: briefConfig(),
      repoRoot: repo,
    });
    assert.equal(brief.repoLearnings.entries.map(entry => entry.id).join(','), 'learning:global');
    assert.equal(brief.minimal, false);
  });

  it('caps matching accepted learnings by recency independently of risk cards', () => {
    const repo = tempRepo();
    const entries = [];
    for (let index = 1; index <= 8; index += 1) {
      entries.push(accepted(`learning:${String(index).padStart(2, '0')}`, `2026-08-13T0${index}:00:00.000Z`, []));
    }
    writeLearnings(repo, entries);
    const selected = selectImplementerLearnings({ repoRoot: repo, paths: ['products/aie/src/x.ts'] });
    assert.equal(IMPLEMENTER_LEARNINGS_CAP, 5);
    assert.equal(selected.entries.length, 5);
    assert.equal(selected.omitted, 3);
    assert.deepEqual(selected.entries.map(entry => entry.id), [
      'learning:08',
      'learning:07',
      'learning:06',
      'learning:05',
      'learning:04',
    ]);
    const brief = buildImplementationBrief({
      title: 'Keyword soup',
      body: [
        'auth token cache head page limit lock session status result provider adapter.',
        '- [ ] Unit test keeps risk cards and learnings independently capped.',
      ].join('\n'),
      config: briefConfig(),
      repoRoot: repo,
    });
    assert.equal(brief.riskCards.length, 5);
    assert.equal(brief.repoLearnings.entries.length, 5);
    assert.equal(brief.repoLearnings.omitted, 3);
    assert.match(formatBriefLines(brief).join('\n'), /\(\+3 older matching entries omitted\)/);
  });

  it('breaks recency ties by id so truncation is deterministic', () => {
    const repo = tempRepo();
    const stamp = '2026-08-13T12:00:00.000Z';
    writeLearnings(repo, [
      accepted('learning:b', stamp, []),
      accepted('learning:a', stamp, []),
      accepted('learning:c', stamp, []),
    ]);
    const first = selectImplementerLearnings({ repoRoot: repo, maxEntries: 2 });
    const second = selectImplementerLearnings({ repoRoot: repo, maxEntries: 2 });
    assert.deepEqual(first.entries.map(entry => entry.id), ['learning:a', 'learning:b']);
    assert.deepEqual(first, second);
  });

  it('never injects rejected findings, guidance notes, or suppression-shaped entries', () => {
    const repo = tempRepo();
    writeLearnings(repo, [
      { ...accepted('learning:rejected', '2026-08-13T12:00:00.000Z', []), disposition: 'rejected', message: 'Brace style nit.' },
      { ...accepted('learning:guide', '2026-08-13T12:00:00.000Z', []), disposition: 'guidance', message: 'Team note for reviewers.' },
      {
        id: 'learning:suppress',
        disposition: 'rejected',
        findingId: 'suppress:style',
        lane: 'code-quality',
        message: 'Stop reporting this path.',
        guidance: '',
        paths: ['products/aie/**'],
        prNumber: 1,
        headSha: null,
        recordedAt: '2026-08-13T12:00:00.000Z',
      },
    ]);
    const selected = selectImplementerLearnings({ repoRoot: repo, paths: ['products/aie/src/brief/build.ts'] });
    assert.deepEqual(selected.entries, []);
    const brief = buildImplementationBrief({
      title: 'Touch the brief builder',
      body: 'Change `products/aie/src/brief/build.ts`.',
      config: briefConfig(),
      repoRoot: repo,
    });
    const rendered = formatBriefLines(brief).join('\n');
    assert.doesNotMatch(rendered, /Brace style nit/);
    assert.doesNotMatch(rendered, /Team note for reviewers/);
    assert.doesNotMatch(rendered, /Stop reporting this path/);
  });

  it('reports invalid instead of injecting entries when the learnings file is malformed', () => {
    const repo = tempRepo();
    fs.writeFileSync(path.join(repo, '.qube', 'aie', 'review-learnings.json'), '{not-json');
    const selected = selectImplementerLearnings({ repoRoot: repo, paths: ['products/aie/src/x.ts'] });
    assert.equal(selected.status, 'invalid');
    assert.deepEqual(selected.entries, []);
    assert.match(formatBriefLines(buildImplementationBrief({
      title: 'Touch the brief builder',
      body: 'Change `products/aie/src/brief/build.ts`.',
      config: briefConfig(),
      repoRoot: repo,
    })).join('\n'), /file is invalid/);
  });

  it('reports missing when no learnings file exists', () => {
    const repo = tempRepo();
    const selected = selectImplementerLearnings({ repoRoot: repo });
    assert.equal(selected.status, 'missing');
    assert.deepEqual(selected.entries, []);
  });

  it('exports the selector from the shipped package surface', () => {
    assert.equal(typeof exportedSelector, 'function');
    assert.equal(exportedSelector, selectImplementerLearnings);
  });
});
