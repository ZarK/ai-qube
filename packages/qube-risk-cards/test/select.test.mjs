import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_MAX_RISK_CARDS,
  formatRiskCardReviewerFragment,
  loadRiskCardCatalog,
  pathsTouchPatterns,
  selectRiskCards,
  simpleGlobMatch,
  validateRiskCardCatalog,
} from "../dist/index.js";

describe("qube-risk-cards", () => {
  it("validates the shipped catalog", () => {
    const validation = validateRiskCardCatalog();
    assert.equal(validation.ok, true, validation.errors.join("; "));
    assert.ok(validation.cardCount >= 10);
    assert.equal(loadRiskCardCatalog().length, validation.cardCount);
  });

  it("matches path globs with the shared simple glob dialect", () => {
    assert.equal(simpleGlobMatch("packages/foo/src/a.ts", "**/src/**"), true);
    assert.equal(simpleGlobMatch("docs/readme.md", "**/src/**"), false);
    assert.equal(pathsTouchPatterns(["adapters/github/src/x.ts"], ["**/adapters/**"]), true);
  });

  it("returns zero cards when issue text and paths do not match", () => {
    const selected = selectRiskCards({
      issueText: "purely unrelated prose about gardening",
      paths: ["docs/notes/unrelated.md"],
    });
    assert.deepEqual(selected, []);
  });

  it("selects deterministically and bounds to at most five cards", () => {
    const input = {
      issueText: "provider capability trust marker stale pagination fixture test oracle false success",
      paths: [
        "packages/qube-testkit/src/work-suite.ts",
        "adapters/github/src/github_issue_api.ts",
        "products/aie/src/app/local_review_runner.ts",
        "packages/qube-testkit/test/testkit.test.mjs",
      ],
    };
    const first = selectRiskCards(input);
    const second = selectRiskCards(input);
    assert.deepEqual(first.map(card => card.id), second.map(card => card.id));
    assert.ok(first.length > 0);
    assert.ok(first.length <= DEFAULT_MAX_RISK_CARDS);
    assert.ok(first.every(card => formatRiskCardReviewerFragment(card).includes(card.id)));
  });

  it("honors an explicit maxCards bound of zero", () => {
    assert.deepEqual(selectRiskCards({
      issueText: "provider capability trust",
      paths: ["src/x.ts"],
      maxCards: 0,
    }), []);
  });
});
