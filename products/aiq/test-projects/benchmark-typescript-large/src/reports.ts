import type { BenchmarkSample } from "./analytics.js";
import { sumDurations } from "./math.js";

export function totalRuntime(samples: readonly BenchmarkSample[]): number {
  return sumDurations(samples.map((sample) => sample.durationMs));
}

export function failedBudgetCount(durations: readonly number[], budgetMs: number): number {
  return durations.filter((duration) => duration > budgetMs).length;
}
