import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bindFixtureSubject,
  defineAdapterHarness,
  defineWorkProviderHarness,
  markFixtureTransport,
} from "@tjalve/qube-testkit";
import {
  createJiraWorkProvider,
  jiraAdapter,
  probeJiraConnection,
  renderJiraIssueDraft,
} from "../dist/index.js";

const fixtureRoot = dirname(fileURLToPath(import.meta.url));
const corpus = readFixture("./fixtures/conformance-work-items.json");
const connectionFixture = readFixture("./fixtures/connection-pass.json");
const issues = corpus.issues;

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

function createJiraFetchTransport(allIssues, { pageSize = 100, malformed = false } = {}) {
  const state = { listRequests: 0 };
  const byKey = new Map(allIssues.map(issue => [issue.key, issue]));
  const fetchImpl = async (url) => {
    const href = String(url);
    if (malformed && href.includes("/rest/api/3/search")) {
      state.listRequests += 1;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        async json() { throw new Error("Unexpected token in JSON"); },
        async text() { return "{not-json"; },
      };
    }
    if (href.includes("/rest/api/3/search")) {
      state.listRequests += 1;
      const parsed = new URL(href);
      const startAt = Number(parsed.searchParams.get("startAt") || "0");
      const maxResults = Number(parsed.searchParams.get("maxResults") || String(pageSize));
      const slice = allIssues.slice(startAt, startAt + maxResults);
      return jsonResponse({
        startAt,
        maxResults,
        total: allIssues.length,
        issues: slice,
      });
    }
    const issueMatch = href.match(/\/rest\/api\/3\/issue\/([^?/]+)/);
    if (issueMatch) {
      const key = decodeURIComponent(issueMatch[1]);
      const issue = byKey.get(key);
      if (!issue) return jsonResponse({ errorMessages: [`Issue ${key} not found`] }, { status: 404 });
      return jsonResponse(issue);
    }
    return jsonResponse({ errorMessages: [`unexpected fixture url ${href}`] }, { status: 404 });
  };
  fetchImpl.listRequests = () => state.listRequests;
  fetchImpl.pageSize = pageSize;
  return markFixtureTransport(fetchImpl);
}

function createJiraProvider(transport) {
  return createJiraWorkProvider({
    baseUrl: "https://acme.atlassian.net",
    email: "fixture@example.com",
    apiToken: "fixture-token",
    projectKey: "ENG",
    jql: corpus.jql,
    fetch: transport,
    pageSize: transport.pageSize,
    limit: 1000,
  });
}

const work = defineWorkProviderHarness({
  fixtureRoot,
  fixtureFiles: ["fixtures/conformance-work-items.json"],
  mutationBoundary: "fixture-only",
  createFixtureTransport: () => createJiraFetchTransport(issues),
  createSubject: transport => bindFixtureSubject(createJiraProvider(transport), transport),
  getListRequestCount: transport => transport.listRequests(),
  workScenarios: {
    statusPolicy: { provider: "jira" },
    createLargeResultTransport: () => createJiraFetchTransport(issues, { pageSize: 100 }),
    expectedLargeResultCount: 6,
    maxListRequests: 3,
    singleShotHighLimit: true,
    createMultiPageTransport: () => createJiraFetchTransport(issues, { pageSize: 2 }),
    expectedMultiPageItemCount: 6,
    minMultiPageRequests: 3,
    createMalformedTransport: () => createJiraFetchTransport(issues, { malformed: true }),
    expectedWorkById: {
      "ENG-201": { status: "ready", priority: "high", title: "Fixture ready issue" },
      "ENG-202": { status: "in-progress", priority: "critical", title: "Fixture in-progress issue" },
      "ENG-203": { status: "ready", priority: "medium", title: "Fixture medium-priority issue" },
      "ENG-205": { status: "ready", priority: "low", title: "Fixture low-priority issue" },
      "ENG-206": { status: "blocked", priority: "high", title: "Fixture blocked issue" },
    },
  },
  capabilityCases: [
    {
      capabilityId: "render-work-items",
      name: "renders Jira drafts without mutation",
      run: () => {
        const draft = renderJiraIssueDraft({
          title: "Fixture draft",
          priority: "high",
          status: "ready",
          components: ["fixture"],
          bodySections: [{ heading: "Context", body: "Recorded fixture draft body." }],
        });
        assert.equal(draft.summary, "Fixture draft");
        assert.match(draft.description, /Recorded fixture draft body/);
      },
    },
    {
      capabilityId: "workflow-schema",
      name: "keeps status mapping schema-driven",
      run: async () => {
        const transport = createJiraFetchTransport(issues);
        const provider = createJiraWorkProvider({
          baseUrl: "https://acme.atlassian.net",
          email: "fixture@example.com",
          apiToken: "fixture-token",
          projectKey: "ENG",
          jql: corpus.jql,
          fetch: transport,
          workflowSchema: {
            statusMap: { "To Do": "ready", "In Progress": "in-progress", Blocked: "blocked" },
          },
        });
        const item = await provider.getWorkItem({ providerId: "jira", id: "ENG-206" });
        assert.equal(item.status, "blocked");
      },
    },
    {
      capabilityId: "sync-issue-status",
      name: "reports lifecycle sync as unsupported",
      unsupportedError: /unsupported|not implemented/i,
      run: async provider => {
        const items = await provider.listOpenWorkItems();
        const plan = provider.planStart(items[0], {});
        const result = (await provider.apply(plan))[0];
        assert.equal(result.status, "failed");
        throw new Error(`unsupported Jira lifecycle mutation: ${result.failure.cause}`);
      },
    },
  ],
});

export const jiraHarness = defineAdapterHarness({
  adapter: jiraAdapter,
  roles: {
    work,
    connection: {
      fixtureRoot,
      fixtureFile: "fixtures/connection-pass.json",
      fixture: connectionFixture,
      contract: jiraAdapter.connection,
      probe: options => probeJiraConnection({
        ...options,
        env: {
          JIRA_EMAIL: "fixture@example.com",
          JIRA_API_TOKEN: "fixture-token",
          ...(options.env ?? {}),
        },
        config: {
          baseUrl: "https://acme.atlassian.net",
          projectKey: "ENG",
          ...(options.config ?? {}),
        },
      }),
      live: { envVar: "QUBE_LIVE_PROBES" },
      negativeFixtures: {
        badCredential: { http: { status: 401, body: { errorMessages: ["authentication failed"] } } },
        unreachable: { error: "network" },
        timeout: { error: "timeout" },
      },
    },
  },
});

function readFixture(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8"));
}

