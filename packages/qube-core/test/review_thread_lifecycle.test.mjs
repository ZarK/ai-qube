import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FINDING_MARKER_PREFIX,
  extractFindingFingerprints,
  planReviewThreadLifecycle,
  reviewFindingFingerprint,
} from "../dist/index.js";

function finding(overrides = {}) {
  return {
    id: overrides.id ?? "finding-1",
    severity: overrides.severity ?? "advisory",
    message: overrides.message ?? "Fix the parser.",
    location: overrides.location === undefined
      ? { path: "src/a.ts", line: 4, side: "destination" }
      : overrides.location,
  };
}

function thread(overrides = {}) {
  return {
    threadId: overrides.threadId ?? "PRRT_1",
    resolved: overrides.resolved ?? false,
    outdated: overrides.outdated ?? false,
    canResolve: overrides.canResolve ?? true,
    authorLogin: overrides.authorLogin ?? "qube-review[bot]",
    fingerprints: overrides.fingerprints ?? ["deadbeefdeadbeef"],
    replyToDatabaseId: overrides.replyToDatabaseId ?? 11,
    minimizeSubjectId: overrides.minimizeSubjectId ?? "IC_1",
  };
}

describe("extractFindingFingerprints", () => {
  it("reads one or more finding markers from a comment body", () => {
    assert.deepEqual(extractFindingFingerprints("no marker"), []);
    assert.deepEqual(
      extractFindingFingerprints(`claim\n<!-- ${FINDING_MARKER_PREFIX}:aaaaaaaaaaaaaaaa -->`),
      ["aaaaaaaaaaaaaaaa"],
    );
  });
});

describe("planReviewThreadLifecycle", () => {
  it("replies in the existing publisher thread instead of opening a second thread", () => {
    const current = finding();
    const fingerprint = reviewFindingFingerprint(current);
    const actions = planReviewThreadLifecycle({
      findings: [current],
      threads: [thread({ fingerprints: [fingerprint] })],
      publisherLogins: ["qube-review[bot]"],
      headSha: "abc1234567890",
      round: "2",
    });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].kind, "reply-still-present");
    assert.equal(actions[0].threadId, "PRRT_1");
    assert.match(actions[0].body ?? "", /Still present at `abc123456789` \(round 2\)\./);
    assert.equal(actions.some((action) => action.kind === "new-inline"), false);
  });

  it("unresolves a returning fingerprint on a previously resolved publisher thread", () => {
    const current = finding();
    const fingerprint = reviewFindingFingerprint(current);
    const [action] = planReviewThreadLifecycle({
      findings: [current],
      threads: [thread({ fingerprints: [fingerprint], resolved: true })],
      publisherLogins: ["qube-review[bot]"],
      headSha: "defdefdefdef",
      round: "3",
    });
    assert.equal(action.kind, "reply-still-present");
    assert.equal(action.unresolve, true);
  });

  it("resolves a missing fingerprint with the commit and round named", () => {
    const [action] = planReviewThreadLifecycle({
      findings: [],
      threads: [thread({ fingerprints: ["aaaaaaaaaaaaaaaa"] })],
      publisherLogins: ["qube-review[bot]"],
      headSha: "feedfacecafe",
      round: "4",
    });
    assert.equal(action.kind, "resolve");
    assert.match(action.body ?? "", /Fixed in `feedfacecafe` — resolved by round 4\./);
  });

  it("resolves a dropped fingerprint with its disposition", () => {
    const [action] = planReviewThreadLifecycle({
      findings: [],
      threads: [thread({ fingerprints: ["bbbbbbbbbbbbbbbb"] })],
      publisherLogins: ["qube-review[bot]"],
      headSha: "cafebabecafe",
      round: "5",
      dispositions: { bbbbbbbbbbbbbbbb: "Dropped: advisory, folded into #489." },
    });
    assert.equal(action.kind, "resolve");
    assert.match(action.body ?? "", /Dropped: advisory, folded into #489\. — resolved by round 5\./);
  });

  it("never plans automatic resolve or minimize for another author's thread", () => {
    const actions = planReviewThreadLifecycle({
      findings: [],
      threads: [thread({ authorLogin: "human-reviewer" })],
      publisherLogins: ["qube-review[bot]"],
      headSha: "abc1234567890",
      round: "2",
    });
    assert.deepEqual(actions, []);
  });

  it("minimizes a stale publisher comment that cannot be resolved", () => {
    const [action] = planReviewThreadLifecycle({
      findings: [],
      threads: [thread({
        fingerprints: ["cccccccccccccccc"],
        canResolve: false,
        outdated: true,
        minimizeSubjectId: "IC_stale",
      })],
      publisherLogins: ["qube-review[bot]"],
      headSha: "abc1234567890",
      round: "2",
    });
    assert.equal(action.kind, "minimize-outdated");
    assert.equal(action.minimizeSubjectId, "IC_stale");
  });

  it("opens a new inline only when no publisher thread owns the fingerprint", () => {
    const current = finding();
    const [action] = planReviewThreadLifecycle({
      findings: [current],
      threads: [thread({ fingerprints: ["dddddddddddddddd"] })],
      publisherLogins: ["qube-review[bot]"],
      headSha: "abc1234567890",
      round: "2",
    });
    assert.equal(action.kind, "new-inline");
    assert.equal(action.finding?.message, "Fix the parser.");
  });
});
