import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { describeToolkitBoundary, toolkitBoundary } from "../dist/index.js";

describe("package foundation", () => {
  it("exposes a real root API that states the toolkit boundary", () => {
    assert.deepEqual(toolkitBoundary, {
      packageKind: "cli-infrastructure",
      consumesCommandBehavior: false,
      mutatesConsumerState: false
    });

    assert.match(describeToolkitBoundary(), /consuming packages own command behavior/);
  });
});
