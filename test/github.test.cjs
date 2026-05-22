const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  runGh,
  redact,
  GhNotFoundError,
  GhAuthError,
  NotGitHubRepositoryError,
  GhNetworkError,
  GhMalformedOutputError,
  parseGhJson,
} = require('../dist/gh.js');
const {
  listOpenIssues,
  getIssue,
  parseDeclaredBlockers,
  extractPriorityLabel,
  extractStatusLabel,
  extractComponentLabels,
} = require('../dist/github.js');

function makeFixtureExec(responses) {
  return async (args) => {
    const key = args.join(' ');
    if (responses[key]) {
      return responses[key];
    }
    // Default error for unexpected calls in tests
    return { args, exitCode: 1, stdout: '', stderr: 'unexpected gh call in test fixture' };
  };
}

const sampleIssueJson = JSON.stringify({
  number: 42,
  title: 'Fix login bug',
  body: 'Details here.\nBlocked by: #17\nBlocked by: #23\nSequence: auth-v2',
  state: 'OPEN',
  labels: [{ name: 'P1-Critical' }, { name: 'S-InProgress' }, { name: 'C-Backend' }],
  milestone: { number: 3, title: 'Q2', state: 'OPEN', dueOn: '2026-06-01T00:00:00Z' },
  url: 'https://github.com/example/repo/issues/42',
});

const sampleListJson = JSON.stringify([
  {
    number: 42,
    title: 'Fix login bug',
    body: 'Blocked by: #17',
    state: 'OPEN',
    labels: [{ name: 'P1-Critical' }, { name: 'S-InProgress' }],
    milestone: null,
    url: 'https://github.com/example/repo/issues/42',
  },
  {
    number: 43,
    title: 'Docs update',
    body: '',
    state: 'OPEN',
    labels: [{ name: 'P3-Medium' }, { name: 'S-Ready' }, { name: 'C-Docs' }],
    milestone: { number: 3, title: 'Q2', dueOn: null },
    url: 'https://github.com/example/repo/issues/43',
  },
]);

describe('gh execution layer', () => {
  it('runGh uses explicit args and redacts tokens from custom exec results', async () => {
    const exec = makeFixtureExec({
      'issue list --state open --json number --limit 5': {
        args: ['issue', 'list', '--state', 'open', '--json', 'number', '--limit', '5'],
        exitCode: 0,
        stdout: 'token ghp_abc123def456ghi789jkl here',
        stderr: 'github_pat_xyz9876543210fedcba9876543210 leaked',
      },
    });
    const res = await runGh(['issue', 'list', '--state', 'open', '--json', 'number', '--limit', '5'], { exec });
    assert.equal(res.exitCode, 0);
    assert.ok(!res.stdout.includes('ghp_'));
    assert.ok(res.stdout.includes('[REDACTED]'));
    assert.ok(!res.stderr.includes('github_pat'));
  });

  it('redact helper removes common GitHub token patterns', () => {
    const input = 'ghp_1234567890abcdef1234567890abcdef1234 and github_pat_9876543210fedcba9876543210fedcba9876';
    const out = redact(input);
    assert.ok(!out.includes('ghp_'));
    assert.ok(!out.includes('github_pat_'));
    assert.ok(out.includes('[REDACTED]'));
  });

  it('throws GhNotFoundError when gh is missing (via injected exec)', async () => {
    const exec = async () => {
      throw new GhNotFoundError('gh issue list');
    };
    await assert.rejects(
      () => runGh(['issue', 'list'], { exec }),
      (e) => e instanceof GhNotFoundError && e.message.includes('gh CLI not found')
    );
  });

  it('throws GhAuthError on auth failure (via injected exec)', async () => {
    const exec = async () => {
      throw new GhAuthError('gh auth status', 'You are not logged in to github.com');
    };
    await assert.rejects(
      () => runGh(['auth', 'status'], { exec }),
      (e) => e instanceof GhAuthError && e.message.includes('not authenticated') && e.message.includes('gh auth login')
    );
  });

  it('throws NotGitHubRepositoryError for non-GitHub repo (via injected exec)', async () => {
    const exec = async () => {
      throw new NotGitHubRepositoryError('gh issue list', 'not a git repository');
    };
    await assert.rejects(
      () => runGh(['issue', 'list', '--state', 'open'], { exec }),
      (e) => e instanceof NotGitHubRepositoryError && e.message.includes('not a GitHub repository')
    );
  });

  it('throws GhNetworkError on connection failure (via injected exec)', async () => {
    const exec = async () => {
      throw new GhNetworkError('gh api user', 'getaddrinfo ENOTFOUND');
    };
    await assert.rejects(
      () => runGh(['api', 'user'], { exec }),
      (e) => e instanceof GhNetworkError && e.message.includes('network or GitHub API error')
    );
  });

  it('parseGhJson throws GhMalformedOutputError on bad JSON', () => {
    assert.throws(
      () => parseGhJson('not json', 'gh test'),
      (e) => e instanceof GhMalformedOutputError && e.message.includes('malformed or unexpected output')
    );
  });
});

describe('GitHub issue model', () => {
  it('listOpenIssues normalizes issues, labels, milestones, and declared blockers', async () => {
    const exec = makeFixtureExec({
      'issue list --state open --json number,title,state,labels,body,milestone,url --limit 1000': {
        args: ['issue', 'list', '--state', 'open', '--json', 'number,title,state,labels,body,milestone,url', '--limit', '1000'],
        exitCode: 0,
        stdout: sampleListJson,
        stderr: '',
      },
    });
    const issues = await listOpenIssues({ exec });
    assert.equal(issues.length, 2);
    assert.equal(issues[0].number, 42);
    assert.deepEqual(issues[0].declaredBlockers, [17]);
    assert.equal(issues[0].labels.includes('P1-Critical'), true);
    assert.equal(issues[1].milestone.title, 'Q2');
    assert.equal(issues[1].milestone.state, 'UNKNOWN');
    assert.equal(issues[1].declaredBlockers.length, 0);
  });

  it('getIssue returns normalized single issue with blockers', async () => {
    const exec = makeFixtureExec({
      'issue view 42 --json number,title,state,labels,body,milestone,url': {
        args: ['issue', 'view', '42', '--json', 'number,title,state,labels,body,milestone,url'],
        exitCode: 0,
        stdout: sampleIssueJson,
        stderr: '',
      },
    });
    const issue = await getIssue(42, { exec });
    assert.equal(issue.number, 42);
    assert.deepEqual(issue.declaredBlockers, [17, 23]);
    assert.equal(issue.milestone.title, 'Q2');
  });

  it('parseDeclaredBlockers extracts multiple blockers and ignores noise', () => {
    const body = 'Foo\nBlocked by: #9\nBar\nblocked by: #42\nBlocked by: #0\nBaz';
    const blockers = parseDeclaredBlockers(body);
    assert.deepEqual(blockers, [9, 42]);
  });

  it('extractPriorityLabel, extractStatusLabel, extractComponentLabels work', () => {
    const labels = ['P2-High', 'S-Blocked', 'C-Tooling', 'C-Security', 'random'];
    assert.equal(extractPriorityLabel(labels), 'P2-High');
    assert.equal(extractStatusLabel(labels), 'S-Blocked');
    assert.deepEqual(extractComponentLabels(labels), ['C-Tooling', 'C-Security']);
  });

  it('getIssue rejects invalid issue numbers', async () => {
    await assert.rejects(
      () => getIssue(0),
      /positive integer/
    );
    await assert.rejects(
      () => getIssue(-5),
      /positive integer/
    );

  });

  it('parseDeclaredBlockers is line-based and ignores mid-line mentions (per FR-05-007)', () => {
    const body = 'See note "Blocked by: #99 example" in paragraph.\n- Blocked by: #17\nBlocked by: #42';
    const blockers = parseDeclaredBlockers(body);
    assert.deepEqual(blockers, [17, 42]); // 99 must not be extracted (mid-line)
  });

  it('listOpenIssues and getIssue forward cwd and surface non-zero exit as GhExecutionError', async () => {
    const cwd = '/tmp/nested/subdir';
    const exec = async (args, receivedCwd) => {
      assert.equal(receivedCwd, cwd);
      if (args.includes('issue') && args.includes('list')) {
        return { args, exitCode: 1, stdout: '', stderr: 'transient gh failure' };
      }
      return { args, exitCode: 0, stdout: sampleListJson, stderr: '' };
    };
    const GhExecutionError = require('../dist/gh.js').GhExecutionError;
    await assert.rejects(
      () => listOpenIssues({ exec, cwd }),
      (e) => e instanceof GhExecutionError && e.exitCode === 1 && e.message.includes('gh issue list')
    );
  });

  it('getIssue rejects non-integer / wrong-type issue numbers', async () => {
    await assert.rejects(() => getIssue('foo'), /positive integer/);
    await assert.rejects(() => getIssue(3.14), /positive integer/);
  });
});
