export function formatScenarioLabel(id: string, tags: readonly string[]): string {
  const suffix = tags.length === 0 ? "default" : tags.join("+");
  return `${id}:${suffix}`;
}

export function joinTags(tags: readonly string[]): string {
  return tags.length === 0 ? "none" : tags.join(",");
}

export function formatDuration(durationMs: number): string {
  return `${durationMs.toFixed(1)}ms`;
}
