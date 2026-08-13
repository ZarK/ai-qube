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
  createLinearWorkProvider,
  linearAdapter,
  probeLinearConnection,
  renderLinearIssueDraft,
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
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function pageIssues(all, pageSize, after) {
  const start = after ? Number(after) : 0;
  const slice = all.slice(start, start + pageSize);
  const next = start + pageSize;
  const hasNextPage = next < all.length;
  return {
    data: {
      team: {
        issues: {
          nodes: slice,
          pageInfo: {
            hasNextPage,
            endCursor: hasNextPage ? String(next) : null,
          },
        },
      },
    },
  };
}

function createLinearFetchTransport(allIssues, { pageSize = 100, malformed = false } = {}) {
  const state = { listRequests: 0 };
  const fetchImpl = async (_url, init = {}) => {
    if (malformed) {
      state.listRequests += 1;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        async json() {
          return { not: "linear-graphql" };
        },
        async text() {
          return "{not-json";
        },
      };
    }
    const payload = typeof init.body === "string" ? JSON.parse(init.body) : {};
    const query = String(payload.query ?? "");
    if (query.includes("QubeLinearIssues")) {
      state.listRequests += 1;
      const first = Number(payload.variables?.first ?? pageSize);
      const after = payload.variables?.after ?? null;
      return jsonResponse(pageIssues(allIssues, first, after));
    }
    if (query.includes("QubeLinearIssue")) {
      const id = String(payload.variables?.id ?? "");
      const issue = allIssues.find(item => item.identifier === id || item.id === id);
      if (!issue) {
        return jsonResponse({ errors: [{ message: `issue ${id} not found` }] }, { status: 200 });
      }
      return jsonResponse({ data: { issue } });
    }
    return jsonResponse({ errors: [{ message: `unexpected fixture query` }] }, { status: 200 });
  };
  fetchImpl.listRequests = () => state.listRequests;
  fetchImpl.pageSize = pageSize;
  return markFixtureTransport(fetchImpl);
}

function createLinearProvider(transport) {
  return createLinearWorkProvider({
    teamId: corpus.teamId,
    apiKey: "fixture-linear-key",
    fetch: transport,
    pageSize: transport.pageSize,
    limit: 1000,
  });
}

const work = defineWorkProviderHarness({
  fixtureRoot,
  fixtureFiles: ["fixtures/conformance-work-items.json"],
  mutationBoundary: "fixture-only",
  createFixtureTransport: () => createLinearFetchTransport(issues),
  createSubject: transport => bindFixtureSubject(createLinearProvider(transport), transport),
  getListRequestCount: transport => transport.listRequests(),
  workScenarios: {
    statusPolicy: { provider: "linear" },
    createLargeResultTransport: () => createLinearFetchTransport(issues, { pageSize: 100 }),
    expectedLargeResultCount: 5,
    maxListRequests: 3,
    singleShotHighLimit: true,
    createMultiPageTransport: () => createLinearFetchTransport(issues, { pageSize: 2 }),
    expectedMultiPageItemCount: 5,
    minMultiPageRequests: 3,
    createMalformedTransport: () => createLinearFetchTransport(issues, { malformed: true }),
    expectedWorkById: {
      "ENG-101": { status: "ready", priority: "high", title: "Fixture ready issue" },
      "ENG-102": { status: "in-progress", priority: "critical", title: "Fixture in-progress issue" },
      "ENG-103": { status: "ready", priority: "medium", title: "Fixture medium-priority issue" },
      "ENG-104": { status: "in-progress", priority: "high", title: "Fixture blocking issue" },
      "ENG-105": { status: "ready", priority: "low", title: "Fixture low-priority issue" },
    },
  },
  capabilityCases: [
    {
      capabilityId: "render-work-items",
      name: "renders Linear drafts without mutation",
      run: () => {
        const draft = renderLinearIssueDraft({
          title: "Fixture draft",
          priority: "high",
          status: "ready",
          components: ["fixture"],
          bodySections: [{ heading: "Context", body: "Recorded fixture draft body." }],
        });
        assert.equal(draft.title, "Fixture draft");
        assert.match(draft.description, /Recorded fixture draft body/);
        assert.equal(draft.priority, 2);
      },
    },
    {
      capabilityId: "sync-issue-status",
      name: "reports lifecycle sync as unsupported",
      unsupportedError: /unsupported|not implemented/i,
      run: async provider => {
        const items = await provider.listOpenWorkItems();
        assert.ok(items.length > 0);
        const plan = provider.planStart(items[0], {});
        const result = (await provider.apply(plan))[0];
        assert.equal(result.status, "failed");
        throw new Error(`unsupported Linear lifecycle mutation: ${result.failure.cause}`);
      },
    },
  ],
});

export const linearHarness = defineAdapterHarness({
  adapter: linearAdapter,
  roles: {
    work,
    connection: {
      fixtureRoot,
      fixtureFile: "fixtures/connection-pass.json",
      fixture: connectionFixture,
      contract: linearAdapter.connection,
      probe: options => probeLinearConnection({
        ...options,
        env: { LINEAR_API_KEY: "fixture-key", ...(options.env ?? {}) },
        config: { teamId: "fixture-team", ...(options.config ?? {}) },
      }),
      live: { envVar: "QUBE_LIVE_PROBES" },
      negativeFixtures: {
        badCredential: { http: { status: 401, body: { errors: [{ message: "authentication failed" }] } } },
        unreachable: { error: "network" },
        timeout: { error: "timeout" },
      },
    },
  },
});

function readFixture(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8"));
}
