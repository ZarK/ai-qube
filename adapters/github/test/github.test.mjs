import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { githubAdapter, githubIssueReference } from "../dist/index.js";

describe("github adapter contract", () => {
  it("keeps GitHub integration behavior at the adapter boundary", () => {
    assert.equal(githubAdapter.id, "github");
    assert.ok(githubAdapter.owns.includes("pull-requests"));
    assert.match(githubAdapter.boundary, /adapter edge/);
    assert.equal(githubIssueReference(42), "#42");
    assert.throws(() => githubIssueReference(0), /positive safe integers/);
  });
});
