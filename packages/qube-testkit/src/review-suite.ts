import assert from "node:assert/strict";

import type { QubeAdapterContract, ReviewForgeCapabilities, ReviewForgeProvider, ReviewItem } from "@tjalve/qube-core";
import {
  normalizeReviewFinding,
  normalizeReviewItem,
  partitionReviewFindings,
} from "@tjalve/qube-core";

import {
  declarationMap,
  isSupported,
  REVIEW_DECLARATION_FLAGS,
} from "./capabilities.js";
import { assertMutationAllowed, assertReviewItemShape } from "./fixtures.js";
import type { RoleHarness } from "./types.js";

async function loadReviewItem(
  provider: ReviewForgeProvider,
  caps: ReviewForgeCapabilities,
  scenarios: NonNullable<RoleHarness["reviewScenarios"]>,
): Promise<ReviewItem> {
  if (scenarios.fixtureReviewKey) {
    return provider.getReviewItem(scenarios.fixtureReviewKey);
  }
  if (caps.findCurrentBranchReview === true) {
    const item = await provider.findReviewForCurrentBranch();
    assert.ok(item, "Supported review load must yield a review item for the current branch or fixtureReviewKey.");
    return item;
  }
  assert.fail("Review suite requires reviewScenarios.fixtureReviewKey when findCurrentBranchReview is false.");
}

export async function verifyReviewRoleSuite(adapter: QubeAdapterContract, harness: RoleHarness): Promise<void> {
  const scenarios = harness.reviewScenarios;
  assert.ok(scenarios, "Review forge harness must supply reviewScenarios.");
  const transport = await harness.createFixtureTransport();
  const provider = await harness.createSubject(transport) as ReviewForgeProvider;
  const caps = provider.capabilities();
  const declared = declarationMap(adapter);

  if (isSupported(declared, "load-pull-request")) {
    assert.equal(caps.findCurrentBranchReview, true, "load-pull-request requires findCurrentBranchReview=true.");
    assert.equal(caps.loadReview, true, "load-pull-request requires loadReview=true.");
    const item = await provider.findReviewForCurrentBranch();
    assert.ok(item, "Supported review load fixture must yield a review item for the current branch.");
    assertReviewItemShape(item, adapter.id);
    const loaded = await provider.getReviewItem(item.key);
    assertReviewItemShape(loaded, adapter.id);
    assert.equal(loaded.key.id, item.key.id);
    const roundTrip = normalizeReviewItem(loaded);
    assert.equal(roundTrip.key.id, loaded.key.id);
    assert.equal(roundTrip.title, loaded.title);
    assert.equal(roundTrip.mergeability, loaded.mergeability);
    assert.equal(roundTrip.reviewDecision, loaded.reviewDecision);

    for (const feedback of loaded.feedback) {
      assert.ok(feedback.source, "Review feedback must classify its source.");
      assert.ok(feedback.trust === "untrusted" || feedback.trust === "trusted-provider", "Review feedback must classify trust.");
      assert.ok(feedback.summary.trim().length > 0, "Review feedback summary must be non-empty.");
    }
  }

  // Independent read capabilities use loadReview + fixture or discovery keys, not forced current-branch discovery.
  if (isSupported(declared, "read-merge-blockers") || isSupported(declared, "read-review-threads")) {
    assert.equal(caps.loadReview, true, "read-merge-blockers/read-review-threads require loadReview=true.");
    const loaded = await loadReviewItem(provider, caps, scenarios);
    assertReviewItemShape(loaded, adapter.id);

    if (isSupported(declared, "read-merge-blockers")) {
      assert.ok(Array.isArray(loaded.mergeBlockers), "Review item must expose mergeBlockers array.");
      assert.ok(loaded.mergeBlockers.length > 0, "read-merge-blockers requires at least one merge blocker in the fixture corpus.");
      for (const blocker of loaded.mergeBlockers) {
        assert.ok(blocker.reason, "Merge blocker must include a reason.");
        assert.ok(blocker.summary.trim().length > 0, "Merge blocker summary must be non-empty.");
      }
    }
    if (isSupported(declared, "read-review-threads")) {
      assert.ok(Array.isArray(loaded.conversations), "Review item must expose conversations array.");
      assert.ok(
        loaded.conversations.length > 0,
        "read-review-threads requires at least one recorded conversation in the fixture corpus.",
      );
      for (const conversation of loaded.conversations) {
        assert.ok(conversation.id.trim().length > 0, "Review conversation id must be non-empty.");
        assert.equal(typeof conversation.resolved, "boolean");
        assert.equal(typeof conversation.outdated, "boolean");
        assert.ok(conversation.summary.trim().length > 0, "Review conversation summary must be non-empty.");
      }
    }
  }

  if (isSupported(declared, "request-review-gate")) {
    assert.equal(caps.planReviewRequests, true);
    const item = await loadReviewItem(provider, caps, scenarios);
    assert.ok(item, "request-review-gate suite requires a loadable review item.");
    const plan = provider.planReviewRequest(item, scenarios.reviewPolicy);
    assert.ok(plan && Array.isArray(plan.actions), "planReviewRequest must return an action plan.");
    assert.ok(plan.actions.length > 0, "request-review-gate plan must include at least one action.");
    for (const action of plan.actions) {
      assert.ok(action.kind, "Review request plan actions must declare a kind.");
    }
    if (caps.applyReviewRequests === true) {
      assertMutationAllowed(harness.mutationBoundary, transport, harness.role, harness.liveMutationEnvVar, provider);
      assert.ok(plan.actions.length > 0, "applyReviewRequests observation requires a non-empty plan.");
      const applied = await provider.apply(plan);
      assert.ok(Array.isArray(applied), "applyReviewRequests=true requires apply() to return action results.");
      assert.equal(applied.length, plan.actions.length, "apply must return one result per planned action.");
      assert.ok(
        applied.every(result => result.status === "completed"),
        "applyReviewRequests must complete planned actions through the fixture transport.",
      );
      assert.ok(
        applied.some(result => result.status === "completed"),
        "applyReviewRequests must complete at least one planned action.",
      );
    }
  }

  if (isSupported(declared, "resolve-review-threads") || caps.resolveReviewThreads === true) {
    assert.equal(caps.resolveReviewThreads, true, "resolveReviewThreads flag must be true when resolution is advertised.");
    assert.equal(typeof provider.resolveReviewThreads, "function", "resolve-review-threads requires a resolveReviewThreads method.");
    const item = await loadReviewItem(provider, caps, scenarios);
    const prNumber = Number(item.key.id);
    assert.ok(Number.isInteger(prNumber) && prNumber > 0, "resolveReviewThreads suite requires a numeric review item id.");
    const fromItem = item.conversations.filter(conversation => !conversation.resolved).map(conversation => conversation.id);
    const threadIds = [...fromItem, ...(scenarios.resolveThreadIds ?? [])].filter(id => id.trim().length > 0);
    assert.ok(
      fromItem.length > 0,
      "resolveReviewThreads suite requires unresolved conversations loaded from the fixture, not only synthetic resolveThreadIds.",
    );
    const result = await provider.resolveReviewThreads!({
      prNumber,
      threadIds,
      dryRun: true,
    });
    assert.ok(result && typeof result.status === "string", "resolveReviewThreads dry-run must return a status.");
    assert.equal(result.status, "planned", "resolveReviewThreads dry-run must return planned, not failed/skipped.");
    assert.equal(result.prNumber, prNumber);
    assert.ok(Array.isArray(result.resolvedThreadIds), "resolveReviewThreads must report resolvedThreadIds.");
    assert.ok(Array.isArray(result.skippedThreadIds), "resolveReviewThreads must report skippedThreadIds.");
  }

  if (caps.publishLaneReview === true || caps.publishLaneReviewInline === true) {
    assert.equal(typeof provider.publishLaneReviewFeedback, "function", "publish flags require publishLaneReviewFeedback().");
    const item = await loadReviewItem(provider, caps, scenarios);
    assert.ok(item, "publishLaneReview suite requires a loadable review item.");
    const prNumber = Number(item.key.id);
    assert.ok(Number.isInteger(prNumber) && prNumber > 0, "publishLaneReview requires a numeric review item id.");
    const published = await provider.publishLaneReviewFeedback!(item, {
      dryRun: true,
      prNumber,
      headSha: "conformance-head",
      lane: "code-quality",
      profile: "local",
      status: "needs-work",
      recommendation: "request-changes",
      host: "codex",
      issueNumber: 1,
      summary: "Conformance dry-run publish payload.",
      findings: [
        "Shared suite publish payload finding.",
      ],
      completeness: "Shared suite dry-run publish.",
      evidencePath: null,
    });
    assert.ok(published && typeof published.status === "string", "publishLaneReviewFeedback must return a status.");
    assert.equal(
      published.status,
      "planned",
      "publishLaneReviewFeedback dry-run must return planned; published indicates a mutating dry-run false success.",
    );
    assert.ok(typeof published.body === "string" && published.body.trim().length > 0, "publish payload body must be a non-empty string.");
    assert.ok(published.marker === null || (typeof published.marker === "string" && published.marker.trim().length > 0), "publish payload marker must be null or non-empty.");
  }

  if (caps.loadReviewSnapshot === true) {
    const item = await loadReviewItem(provider, caps, scenarios);
    assert.ok(item, "loadReviewSnapshot suite requires a loadable review item.");
    const snapshot = await provider.loadReviewSnapshot(item.key);
    assert.ok(snapshot?.item, "loadReviewSnapshot must return a review item.");
    assertReviewItemShape(snapshot.item, adapter.id);
    assert.ok(Array.isArray(snapshot.unavailable), "loadReviewSnapshot must report unavailable fields.");
    assert.ok(snapshot.item.feedback.length > 0, "loadReviewSnapshot must surface at least one feedback row from fixtures.");
    for (const feedback of snapshot.item.feedback) {
      assert.ok(feedback.trust === "untrusted" || feedback.trust === "trusted-provider");
      assert.ok(feedback.summary.trim().length > 0);
    }

    if (scenarios.markerExpectations) {
      const { forgedMarkerSnippets, staleMarkerSnippets } = scenarios.markerExpectations;
      assert.ok(forgedMarkerSnippets.length > 0, "markerExpectations.forgedMarkerSnippets must be non-empty.");
      assert.ok(staleMarkerSnippets.length > 0, "markerExpectations.staleMarkerSnippets must be non-empty.");
      const feedbackText = snapshot.item.feedback.map(row => `${row.summary}\n${row.author ?? ""}`);
      for (const snippet of forgedMarkerSnippets) {
        const matches = snapshot.item.feedback.filter(row =>
          row.summary.includes(snippet) || (row.author ?? "").includes(snippet),
        );
        assert.ok(matches.length > 0, `Forged marker snippet ${snippet} must appear in loaded review feedback.`);
        assert.ok(
          matches.every(row => row.trust === "untrusted"),
          `Forged marker snippet ${snippet} must never be classified as trusted-provider.`,
        );
      }
      for (const snippet of staleMarkerSnippets) {
        const matches = snapshot.item.feedback.filter(row => row.summary.includes(snippet));
        assert.ok(matches.length > 0, `Stale marker snippet ${snippet} must appear in loaded review feedback.`);
        assert.ok(
          matches.every(row => row.trust === "untrusted"),
          `Stale-head marker snippet ${snippet} must never be classified as trusted-provider for the current head.`,
        );
      }
      assert.ok(feedbackText.length > 0);
    }
  }

  assert.ok(
    scenarios.sampleFindings && scenarios.sampleFindings.length >= 2,
    "Review harness must supply sampleFindings with at least two findings for partition coverage.",
  );
  {
    const paths = scenarios.diffPathsWithLines ?? {};
    const diffIndex = {
      hasLine(path: string, line: number): boolean {
        return (paths[path] ?? []).includes(line);
      },
    };
    const partitioned = partitionReviewFindings(
      scenarios.sampleFindings.map(finding => normalizeReviewFinding(finding)),
      diffIndex,
    );
    assert.equal(partitioned.inline.length + partitioned.body.length, scenarios.sampleFindings.length);
    assert.ok(partitioned.inline.length > 0, "sampleFindings must partition at least one inline finding.");
    assert.ok(partitioned.body.length > 0, "sampleFindings must partition at least one body finding.");
  }

  for (const declaration of adapter.capabilities ?? []) {
    const flags = REVIEW_DECLARATION_FLAGS[declaration.id];
    if (!flags || declaration.support !== "supported") continue;
    for (const flag of flags) {
      const value = caps[flag as keyof ReviewForgeCapabilities];
      assert.equal(value, true, `Supported ${declaration.id} requires review capability flag ${String(flag)}=true.`);
    }
  }
}
