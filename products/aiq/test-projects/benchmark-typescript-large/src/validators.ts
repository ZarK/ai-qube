export function hasBudgetFailures(durations: readonly number[], budgetMs: number): boolean {
  return durations.some((duration) => duration > budgetMs);
}

export function validateScenarioIds(ids: readonly string[]): boolean {
  return ids.every((id) => /^[a-z0-9-]+$/u.test(id));
}
