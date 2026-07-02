const assert = require('node:assert/strict');
const { readdirSync, readFileSync, statSync } = require('node:fs');
const { join, relative } = require('node:path');
const { describe, it } = require('node:test');

describe('work provider adapter boundary', () => {
  it('keeps optional GitHub adapter value imports behind provider boundaries', () => {
    const srcRoot = join(__dirname, '..', 'src');
    const allowed = new Set([
      join('providers', 'github_adapter_exports.ts'),
      join('providers', 'review_agent_adapters.ts'),
      join('providers', 'review_forge_adapters.ts'),
      join('providers', 'work_provider_adapters.ts'),
    ]);
    const offenders = [];
    const visit = dir => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          visit(path);
          continue;
        }
        if (!path.endsWith('.ts')) continue;
        const local = relative(srcRoot, path);
        if (allowed.has(local)) continue;
        const text = readFileSync(path, 'utf8');
        for (const line of text.split(/\r?\n/)) {
          if (line.includes("from '@tjalve/qube-adapter-github'") && !line.trimStart().startsWith('import type ')) {
            offenders.push(`${local}: ${line.trim()}`);
          }
        }
      }
    };
    visit(srcRoot);

    assert.deepEqual(offenders, []);
  });

  it('does not keep a copied GitHub runtime inside AIE', () => {
    const srcRoot = join(__dirname, '..', 'src');
    const runtimePath = join(srcRoot, 'github_adapter_runtime.ts');

    assert.throws(() => statSync(runtimePath), /ENOENT/);
  });

  it('lists built-in and optional work provider adapter contracts', () => {
    const { listWorkProviderAdapters, workProviderAdapterPackage } = require('../dist/providers/work_provider_adapters.js');
    const adapters = listWorkProviderAdapters();
    const byId = Object.fromEntries(adapters.map(adapter => [adapter.id, adapter]));

    assert.deepEqual(adapters.map(adapter => adapter.id), ['github', 'gitlab', 'linear', 'jira']);
    assert.equal(byId.github.installed, false);
    assert.equal(byId.github.capabilities.commentMutations, true);
    assert.equal(byId.github.capabilities.reviewIntegration, true);
    assert.equal(byId.github.capabilities.ciMergeStatus, true);
    assert.equal(byId.gitlab.installed, false);
    assert.equal(byId.gitlab.packageName, '@tjalve/qube-adapter-gitlab');
    assert.equal(byId.gitlab.capabilities.listOpenWork, true);
    assert.equal(byId.gitlab.capabilities.applyLifecycleMutations, false);
    assert.equal(byId.linear.installed, false);
    assert.equal(byId.linear.packageName, '@tjalve/qube-adapter-linear');
    assert.equal(byId.jira.installed, false);
    assert.equal(byId.jira.packageName, '@tjalve/qube-adapter-jira');
    assert.equal(workProviderAdapterPackage('linear'), '@tjalve/qube-adapter-linear');
    assert.equal(workProviderAdapterPackage('jira'), '@tjalve/qube-adapter-jira');
    assert.equal(workProviderAdapterPackage('github'), '@tjalve/qube-adapter-github');
  });

  it('lists and loads GitLab review forge through the optional adapter boundary', async () => {
    const { createReviewForgeProvider, listReviewForgeAdapters, reviewForgeAdapterPackage } = require('../dist/providers/review_forge_adapters.js');
    const adapters = listReviewForgeAdapters();
    const byId = Object.fromEntries(adapters.map(adapter => [adapter.id, adapter]));
    const previousToken = process.env.GITLAB_TOKEN;
    const previousProject = process.env.GITLAB_PROJECT_ID;
    try {
      process.env.GITLAB_TOKEN = 'fixture-token';
      process.env.GITLAB_PROJECT_ID = 'acme/qube';
      const provider = await createReviewForgeProvider('gitlab');

      assert.deepEqual(adapters.map(adapter => adapter.id), ['github', 'gitlab']);
      assert.equal(byId.gitlab.packageName, '@tjalve/qube-adapter-gitlab');
      assert.equal(byId.gitlab.capabilities.loadReview, true);
      assert.equal(byId.gitlab.capabilities.planReviewRequests, true);
      assert.equal(byId.gitlab.capabilities.publishLaneReview, true);
      assert.equal(byId.gitlab.capabilities.publishLaneReviewInline, false);
      assert.equal(byId.gitlab.capabilities.publishLocalReview, false);
      assert.equal(byId.gitlab.capabilities.ciDiagnostics, true);
      assert.equal(reviewForgeAdapterPackage('gitlab'), '@tjalve/qube-adapter-gitlab');
      assert.equal(provider.id, 'gitlab');
      assert.equal(provider.capabilities().publishLocalReview, false);
    } finally {
      if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
      else process.env.GITLAB_TOKEN = previousToken;
      if (previousProject === undefined) delete process.env.GITLAB_PROJECT_ID;
      else process.env.GITLAB_PROJECT_ID = previousProject;
    }
  });

  it('does not silently fall back to GitHub when an optional adapter is missing', async () => {
    const { createWorkProvider } = require('../dist/providers/work_provider_adapters.js');
    const provider = await createWorkProvider('linear');

    assert.equal(provider.id, 'linear');
    assert.deepEqual(provider.capabilities(), {
      listOpenWork: false,
      loadWork: false,
      planStatusSync: false,
      planLifecycleMutations: false,
      applyLifecycleMutations: false,
      commentMutations: false,
      reviewIntegration: false,
      ciMergeStatus: false,
    });
    await assert.rejects(
      () => provider.listOpenWorkItems(),
      /@tjalve\/qube-adapter-linear.*LINEAR_API_KEY.*qube install --work-provider linear/s,
    );
  });

  it('passes GitHub assignee reads through the optional adapter boundary', async () => {
    const { createWorkProvider } = require('../dist/providers/work_provider_adapters.js');
    const calls = [];
    const provider = await createWorkProvider('github', {
      includeAssignees: true,
      exec: async args => {
        calls.push(args);
        return {
          args,
          exitCode: 0,
          stdout: JSON.stringify([{
            number: 93,
            title: 'Assigned work',
            body: '',
            state: 'OPEN',
            labels: [],
            assignees: [{ login: 'octo' }],
            milestone: null,
            url: 'https://github.com/example/repo/issues/93',
          }]),
          stderr: '',
        };
      },
    });

    const items = await provider.listOpenWorkItems();

    assert.deepEqual(items[0].assignees, ['octo']);
    assert.ok(calls.some(args => args.includes('number,title,state,labels,assignees,body,milestone,url')));
  });

  it('passes Jira workflow schema through the optional adapter boundary', async () => {
    const { createWorkProvider } = require('../dist/providers/work_provider_adapters.js');
    let requestedFields = [];
    const provider = await createWorkProvider('jira', {
      jql: 'project = "ENG"',
      workflowSchema: {
        statusMap: { Queued: 'ready' },
        openStatusNames: ['Queued'],
        priorityMap: { P0: 'critical' },
        sprintField: 'customfield_10020',
      },
      client: {
        async listIssues(input) {
          requestedFields = input.fields;
          return [{
            id: '10001',
            key: 'ENG-1',
            fields: {
              summary: 'Queued Jira work',
              status: { name: 'Queued' },
              priority: { name: 'P0' },
              labels: [],
              components: [],
              project: { key: 'ENG' },
              comment: { comments: [], total: 0 },
              issuelinks: [],
            },
          }];
        },
        async getIssue() {
          throw new Error('not needed');
        },
      },
    });

    const items = await provider.listOpenWorkItems();

    assert.equal(items[0].status, 'ready');
    assert.equal(items[0].priority, 'critical');
    assert.ok(requestedFields.includes('customfield_10020'));
  });
});
