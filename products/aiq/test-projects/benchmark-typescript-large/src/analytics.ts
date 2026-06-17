export interface BenchmarkSample {
  durationMs: number;
  id: string;
}

export function averageDuration(samples: readonly BenchmarkSample[]): number {
  if (samples.length === 0) {
    return 0;
  }

  const total = samples.reduce((sum, sample) => sum + sample.durationMs, 0);
  return total / samples.length;
}

export function slowestScenario(samples: readonly BenchmarkSample[]): BenchmarkSample | undefined {
  return [...samples].sort((left, right) => right.durationMs - left.durationMs)[0];
}
