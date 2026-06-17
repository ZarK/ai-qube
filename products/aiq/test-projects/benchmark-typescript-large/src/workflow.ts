import type { BenchmarkSample } from "./analytics.js";
import { slowestScenario } from "./analytics.js";
import { failedBudgetCount } from "./reports.js";
import { padMetric, slugify } from "./strings.js";

export function collectRegressionSummary(samples: readonly BenchmarkSample[]): string {
  const slowest = slowestScenario(samples);
  if (slowest === undefined) {
    return "no-scenarios";
  }

  const regressions = failedBudgetCount(
    samples.map((sample) => sample.durationMs),
    slowest.durationMs - 1,
  );

  return `${slugify(slowest.id)}:${padMetric(String(regressions))}`;
}
