import { createLinearProvisioner, runLiveProvisionerSuite } from "@tjalve/qube-testkit";
import { createLinearWorkProvider, linearAdapter, probeLinearConnection } from "../dist/index.js";

const connectionFixture = {
  http: {
    status: 200,
    body: { data: { viewer: { id: "user-fixture", name: "Fixture" } } },
  },
};

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

function createLinearFixtureFetch() {
  const store = {
    labels: [],
    states: [
      { id: "state-unstarted", name: "Todo", type: "unstarted" },
      { id: "state-started", name: "In Progress", type: "started" },
    ],
    issues: [],
    next: 1,
  };

  return async (_url, init = {}) => {
    const payload = typeof init.body === "string" ? JSON.parse(init.body) : {};
    const query = String(payload.query ?? "");
    const vars = payload.variables ?? {};

    if (query.includes("issueLabelCreate")) {
      const label = { id: `label-${store.next++}`, name: vars.input.name };
      store.labels.push(label);
      return jsonResponse({ data: { issueLabelCreate: { issueLabel: label } } });
    }
    if (query.includes("issueLabelDelete")) {
      store.labels = store.labels.filter(label => label.id !== vars.id);
      return jsonResponse({ data: { issueLabelDelete: { success: true } } });
    }
    if (query.includes("QubeTestkitLabels") || (query.includes("labels(first") && query.includes("team(id"))) {
      return jsonResponse({ data: { team: { labels: { nodes: store.labels } } } });
    }
    if (query.includes("QubeTestkitStates") || query.includes("states { nodes")) {
      return jsonResponse({ data: { team: { states: { nodes: store.states } } } });
    }
    if (query.includes("issueCreate")) {
      const state = store.states.find(candidate => candidate.id === vars.input.stateId) ?? store.states[0];
      const issue = {
        id: `lin-${store.next}`,
        identifier: `ENG-${100 + store.next}`,
        number: 100 + store.next,
        title: vars.input.title,
        description: vars.input.description ?? "",
        url: `https://linear.app/fixture/issue/ENG-${100 + store.next}`,
        priority: vars.input.priority ?? 0,
        archivedAt: null,
        team: { id: vars.input.teamId ?? "team-fixture", key: "ENG", name: "Engineering" },
        state,
        labels: { nodes: store.labels.filter(label => (vars.input.labelIds ?? []).includes(label.id)) },
        relations: { nodes: [] },
      };
      store.next += 1;
      store.issues.push(issue);
      return jsonResponse({ data: { issueCreate: { issue: { id: issue.id, identifier: issue.identifier, title: issue.title } } } });
    }
    if (query.includes("issueUpdate")) {
      const issue = store.issues.find(candidate => candidate.id === vars.id);
      if (issue && vars.input?.description) issue.description = vars.input.description;
      return jsonResponse({ data: { issueUpdate: { success: true } } });
    }
    if (query.includes("issueRelationCreate")) {
      const issue = store.issues.find(candidate => candidate.id === vars.input.issueId);
      const related = store.issues.find(candidate => candidate.id === vars.input.relatedIssueId);
      if (issue && related) {
        issue.relations.nodes.push({ type: "blockedBy", relatedIssue: { id: related.id, identifier: related.identifier } });
      }
      return jsonResponse({ data: { issueRelationCreate: { success: true } } });
    }
    if (query.includes("issueArchive")) {
      const issue = store.issues.find(candidate => candidate.id === vars.id);
      if (issue) issue.archivedAt = "2026-08-13T00:00:00.000Z";
      return jsonResponse({ data: { issueArchive: { success: true } } });
    }
    if (query.includes("QubeTestkitLabeled") || query.includes("labels: { id:")) {
      const labelId = vars.labelId;
      const nodes = store.issues
        .filter(issue => !issue.archivedAt && issue.labels.nodes.some(label => label.id === labelId))
        .map(issue => ({ id: issue.id }));
      return jsonResponse({ data: { team: { issues: { nodes } } } });
    }
    if (query.includes("QubeLinearIssues")) {
      const nodes = store.issues.filter(issue => !issue.archivedAt);
      return jsonResponse({
        data: {
          team: {
            issues: {
              nodes,
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    }
    if (query.includes("QubeLinearIssue")) {
      const issue = store.issues.find(candidate => candidate.identifier === vars.id || candidate.id === vars.id);
      return jsonResponse({ data: { issue: issue ?? null } });
    }
    return jsonResponse({ errors: [{ message: `unexpected linear fixture query` }] });
  };
}

const fixtureFetch = createLinearFixtureFetch();

runLiveProvisionerSuite({
  adapter: linearAdapter,
  createProvisioner: context => createLinearProvisioner(context),
  createWorkProvider: (sandbox, context) => createLinearWorkProvider({
    teamId: sandbox.teamId ?? "team-fixture",
    apiKey: context.env.LINEAR_API_KEY ?? "fixture-key",
    fetch: context.fetchImpl,
    pageSize: 50,
    limit: 100,
  }),
  probe: options => probeLinearConnection({
    ...options,
    env: { LINEAR_API_KEY: "fixture-key", ...(options.env ?? {}) },
    config: { teamId: "team-fixture", ...(options.config ?? {}) },
  }),
  env: {
    QUBE_TESTKIT_LIVE: "1",
    LINEAR_API_KEY: "fixture-key",
    LINEAR_TEAM_ID: "team-fixture",
  },
  config: { teamId: "team-fixture" },
  fetchImpl: fixtureFetch,
  probeOptions: { mode: "fixture", fixture: connectionFixture },
});
