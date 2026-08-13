import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bindFixtureSubject,
  defineAdapterHarness,
  defineCiProviderHarness,
  defineReviewForgeHarness,
  defineWorkProviderHarness,
  markFixtureTransport,
} from "@tjalve/qube-testkit";
import {
  createGitLabReviewForgeProvider,
  createGitLabWorkProvider,
  gitLabAdapter,
  mapGitLabPipelineStatus,
  probeGitLabConnection,
  renderGitLabIssueDraft,
} from "../dist/index.js";

const fixtureRoot = dirname(fileURLToPath(import.meta.url));
const workCorpus = readFixture("./fixtures/conformance-work-items.json");
const reviewCorpus = readFixture("./fixtures/conformance-review.json");
const checkFixture = readFixture("./fixtures/conformance-checks.json");
const connectionFixture = readFixture("./fixtures/connection-pass.json");
const issues = workCorpus.issues;
const currentHeadSha = reviewCorpus.mergeRequest.sha;

function headerMap(headers = {}) {
  return {
    get(name) {
      const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === String(name).toLowerCase());
      return key ? headers[key] : null;
    },
  };
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headerMap(headers),
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

function createGitLabWorkFetchTransport(allIssues, { pageSize = 100, malformed = false } = {}) {
  const state = { listRequests: 0 };
  const linksByIid = new Map(allIssues.map(issue => [String(issue.iid), issue.issue_links ?? []]));
  const fetchImpl = async (url) => {
    const href = String(url);
    if (malformed && href.includes("/issues")) {
      state.listRequests += 1;
      return {
        ok: true,
        status: 200,
        headers: headerMap(),
        async json() { throw new Error("Unexpected token in JSON"); },
        async text() { return "{not-json"; },
      };
    }
    const linksMatch = href.match(/\/issues\/([^/?]+)\/links/);
    if (linksMatch) {
      const iid = decodeURIComponent(linksMatch[1]);
      return jsonResponse(linksByIid.get(iid) ?? []);
    }
    const parsed = new URL(href);
    const path = parsed.pathname;
    if (/\/issues\/?$/.test(path) || /\/issues$/.test(path)) {
      state.listRequests += 1;
      const page = Number(parsed.searchParams.get("page") || "1");
      const perPage = Number(parsed.searchParams.get("per_page") || String(pageSize));
      const start = (page - 1) * perPage;
      const slice = allIssues.slice(start, start + perPage).map(issue => {
        const { issue_links, ...rest } = issue;
        return rest;
      });
      const hasNext = start + perPage < allIssues.length;
      return jsonResponse(slice, { headers: { "x-next-page": hasNext ? String(page + 1) : "" } });
    }
    const iidMatch = path.match(/\/issues\/([^/]+)$/);
    if (iidMatch) {
      const iid = decodeURIComponent(iidMatch[1]);
      const issue = allIssues.find(item => String(item.iid) === iid);
      if (!issue) return jsonResponse({ message: "404" }, { status: 404 });
      const { issue_links, ...rest } = issue;
      return jsonResponse(rest);
    }
    return jsonResponse({ message: `unexpected fixture url ${href}` }, { status: 404 });
  };
  fetchImpl.listRequests = () => state.listRequests;
  fetchImpl.pageSize = pageSize;
  return markFixtureTransport(fetchImpl);
}

function createGitLabWorkProviderFromTransport(transport) {
  return createGitLabWorkProvider({
    projectId: workCorpus.projectId,
    token: "fixture-token",
    baseUrl: "https://gitlab.example.com",
    fetch: transport,
    pageSize: transport.pageSize,
    limit: 1000,
    includeIssueLinks: true,
  });
}

const work = defineWorkProviderHarness({
  fixtureRoot,
  fixtureFiles: ["fixtures/conformance-work-items.json"],
  mutationBoundary: "fixture-only",
  createFixtureTransport: () => createGitLabWorkFetchTransport(issues),
  createSubject: transport => bindFixtureSubject(createGitLabWorkProviderFromTransport(transport), transport),
  getListRequestCount: transport => transport.listRequests(),
  workScenarios: {
    statusPolicy: { provider: "gitlab" },
    createLargeResultTransport: () => createGitLabWorkFetchTransport(issues, { pageSize: 100 }),
    expectedLargeResultCount: 6,
    maxListRequests: 3,
    singleShotHighLimit: true,
    createMultiPageTransport: () => createGitLabWorkFetchTransport(issues, { pageSize: 2 }),
    expectedMultiPageItemCount: 6,
    minMultiPageRequests: 3,
    createMalformedTransport: () => createGitLabWorkFetchTransport(issues, { malformed: true }),
    expectedWorkById: {
      "301": { status: "ready", priority: "high", title: "Fixture ready issue" },
      "302": { status: "in-progress", priority: "critical", title: "Fixture in-progress issue" },
      "303": { status: "ready", priority: "medium", title: "Fixture medium-priority issue" },
      "305": { status: "ready", priority: "low", title: "Fixture low-priority issue" },
      "306": { status: "blocked", priority: "high", title: "Fixture blocked issue" },
    },
  },
  capabilityCases: [
    {
      capabilityId: "render-work-items",
      name: "renders GitLab drafts without mutation",
      run: () => {
        const draft = renderGitLabIssueDraft({
          title: "Fixture draft",
          priority: "high",
          status: "ready",
          components: ["fixture"],
          bodySections: [{ heading: "Context", body: "Recorded fixture draft body." }],
        });
        assert.equal(draft.title, "Fixture draft");
        assert.match(draft.description, /Recorded fixture draft body/);
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
        throw new Error(`unsupported GitLab lifecycle mutation: ${result.failure.cause}`);
      },
    },
  ],
});

function createGitLabReviewClient(fixture) {
  const notes = [...fixture.notes];
  const discussions = fixture.discussions.map(discussion => ({
    ...discussion,
    notes: (discussion.notes ?? []).map(note => ({ ...note })),
  }));
  const mr = fixture.mergeRequest;
  const client = {
    async getMergeRequest() { return mr; },
    async findMergeRequestForBranch(input) {
      return input.sourceBranch === fixture.currentBranch ? mr : null;
    },
    async listMergeRequestNotes() { return notes; },
    async listMergeRequestDiscussions() { return discussions; },
    async resolveMergeRequestDiscussion(input) {
      const discussion = discussions.find(item => item.id === input.discussionId);
      if (!discussion) throw new Error(`missing discussion ${input.discussionId}`);
      for (const note of discussion.notes ?? []) {
        if (note.resolvable) note.resolved = true;
      }
      return discussion;
    },
    async createMergeRequestNote(input) {
      const note = {
        id: notes.length + 1000,
        body: input.body,
        author: fixture.currentUser,
        system: false,
        web_url: `https://gitlab.example.com/acme/qube/-/merge_requests/${mr.iid}#note_${notes.length + 1000}`,
      };
      notes.push(note);
      return note;
    },
    async updateMergeRequestNote(input) {
      const note = notes.find(item => String(item.id) === String(input.noteId));
      if (!note) throw new Error(`missing note ${input.noteId}`);
      note.body = input.body;
      return note;
    },
    async getCurrentUser() { return fixture.currentUser; },
  };
  return markFixtureTransport(client);
}

const review = defineReviewForgeHarness({
  fixtureRoot,
  fixtureFiles: ["fixtures/conformance-review.json"],
  mutationBoundary: "fixture-only",
  createFixtureTransport: () => createGitLabReviewClient(reviewCorpus),
  createSubject: client => bindFixtureSubject(
    createGitLabReviewForgeProvider({
      projectId: reviewCorpus.projectId,
      token: "fixture-token",
      baseUrl: "https://gitlab.example.com",
      currentBranch: reviewCorpus.currentBranch,
      client,
    }),
    client,
  ),

  reviewScenarios: {
    reviewPolicy: { adapter: "gitlab", reviewers: ["@fixture-reviewer"], requestText: "" },
    fixtureReviewKey: { providerId: "gitlab", id: String(reviewCorpus.mergeRequest.iid) },
    sampleFindings: [
      { severity: "blocking", message: "inline blocker", location: { path: "src/a.ts", line: 10, side: "destination" } },
      { severity: "advisory", message: "body-only note" },
    ],
    diffPathsWithLines: { "src/a.ts": [10] },
    resolveThreadIds: ["discussion-fixture-1"],
    markerExpectations: {
      currentHeadSha,
      forgedMarkerSnippets: ["forged-current-marker"],
      staleMarkerSnippets: ["stale-head-marker"],
    },
  },

  capabilityCases: [
    {
      capabilityId: "load-merge-request",
      name: "loads merge request review state from fixtures",
      run: async provider => {
        const item = await provider.getReviewItem({ providerId: "gitlab", id: String(reviewCorpus.mergeRequest.iid) });
        assert.equal(item.key.providerId, "gitlab");
        assert.equal(item.key.id, String(reviewCorpus.mergeRequest.iid));
        assert.ok(item.conversations.length > 0);
        assert.ok(item.checks.length > 0);
        assert.equal(item.checks[0].result, "passed");
      },
    },
    {
      capabilityId: "publish-lane-review",
      name: "plans provider-visible lane review notes",
      run: async provider => {
        assert.equal(provider.capabilities().publishLaneReview, true);
        const item = await provider.getReviewItem({ providerId: "gitlab", id: String(reviewCorpus.mergeRequest.iid) });
        const published = await provider.publishLaneReviewFeedback(item, {
          dryRun: true,
          prNumber: reviewCorpus.mergeRequest.iid,
          headSha: currentHeadSha,
          lane: "code-quality",
          expectedLanes: ["code-quality"],
          round: "conformance-round",
          profile: "local",
          status: "needs-work",
          recommendation: "request-changes",
          host: "codex",
          issueNumber: 301,
          summary: "Conformance dry-run publish payload.",
          findings: ["Shared suite publish payload finding."],
          completeness: "Shared suite dry-run publish.",
          evidencePath: null,
        });
        assert.equal(published.status, "planned");
      },
    },
  ],
});

const ci = defineCiProviderHarness({
  fixtureRoot,
  fixtureFiles: ["fixtures/conformance-checks.json"],
  createFixtureTransport: () => checkFixture,
  createSubject: fixture => ({
    fixture,
    mapCheck: check => mapGitLabPipelineStatus(check, check.headSha ?? currentHeadSha),
  }),
  ciScenarios: {
    passedCheck: checkFixture.passed,
    failedCheck: checkFixture.failed,
    pendingCheck: checkFixture.pending,
  },
});

export const gitlabHarness = defineAdapterHarness({
  adapter: gitLabAdapter,
  roles: {
    work,
    review,
    ci,
    connection: {
      fixtureRoot,
      fixtureFile: "fixtures/connection-pass.json",
      fixture: connectionFixture,
      contract: gitLabAdapter.connection,
      probe: options => probeGitLabConnection({
        ...options,
        env: { GITLAB_TOKEN: "fixture-token", ...(options.env ?? {}) },
        config: {
          projectId: "acme/qube",
          baseUrl: "https://gitlab.example.com",
          ...(options.config ?? {}),
        },
      }),
      live: { envVar: "QUBE_LIVE_PROBES" },
      negativeFixtures: {
        badCredential: { http: { status: 401, body: { message: "authentication failed" } } },
        unreachable: { error: "network" },
        timeout: { error: "timeout" },
      },
    },
  },
});

function readFixture(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8"));
}
