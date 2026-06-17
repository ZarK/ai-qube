import { describe, expect, test } from "vitest";

import { validateScenarioIds } from "./validators.js";
import { collectRegressionSummary } from "./workflow.js";

describe("collectRegressionSummary", () => {
  test("returns a stable summary string", () => {
    const summary = collectRegressionSummary([
      { durationMs: 11, id: "lint-fast" },
      { durationMs: 19, id: "typecheck-slower" },
      { durationMs: 13, id: "coverage" },
    ]);

    expect(summary).toContain("typecheck-slower");
  });
});

describe("validateScenarioIds", () => {
  test("accepts normalized ids", () => {
    expect(validateScenarioIds(["lint-fast", "typecheck-slower"])).toBe(true);
    expect(validateScenarioIds(["bad id"])).toBe(false);
  });
});
