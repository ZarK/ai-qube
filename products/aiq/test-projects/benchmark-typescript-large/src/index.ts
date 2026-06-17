import { type BenchmarkSample, averageDuration, slowestScenario } from "./analytics.js";
import { createScenarioCatalog, listScenarioIds } from "./catalog.js";
import { formatDuration, formatScenarioLabel } from "./formatters.js";
import { totalRuntime } from "./reports.js";
import { collectRegressionSummary } from "./workflow.js";

export interface BenchmarkOverview {
  average: string;
  labels: string[];
  regressionSummary: string;
  scenarioIds: string[];
  slowest?: string;
  total: string;
}

export function buildBenchmarkOverview(samples: readonly BenchmarkSample[]): BenchmarkOverview {
  const catalog = createScenarioCatalog(samples.map((sample) => sample.id));
  const labels = catalog.map((scenario) => formatScenarioLabel(scenario.id, scenario.tags));
  const slowest = slowestScenario(samples);

  return {
    average: formatDuration(averageDuration(samples)),
    labels,
    regressionSummary: collectRegressionSummary(samples),
    scenarioIds: listScenarioIds(catalog),
    ...(slowest === undefined
      ? {}
      : { slowest: `${slowest.id}:${formatDuration(slowest.durationMs)}` }),
    total: formatDuration(totalRuntime(samples)),
  };
}
