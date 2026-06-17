import { describe, expect, test } from "vitest";

import { buildBenchmarkOverview } from "./index.js";

describe("buildBenchmarkOverview", () => {
  test("summarizes benchmark samples", () => {
    const overview = buildBenchmarkOverview([
      { durationMs: 10, id: "lint" },
      { durationMs: 25, id: "typecheck" },
      { durationMs: 15, id: "coverage" },
    ]);

    expect(overview.average).toBe("16.7ms");
    expect(overview.total).toBe("50.0ms");
    expect(overview.slowest).toBe("typecheck:25.0ms");
    expect(overview.labels).toHaveLength(3);
    expect(overview.regressionSummary).toContain("typecheck");
  });
});
