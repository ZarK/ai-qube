export interface WorkItemKey {
  readonly providerId: string;
  readonly id: string;
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${field} must be a non-empty string.`);
  return normalized;
}

export function normalizeWorkItemKey(providerId: string, id: string): WorkItemKey {
  return { providerId: nonEmpty(providerId, "providerId"), id: nonEmpty(id, "id") };
}

export function uniqueWorkItemKeys(keys: readonly WorkItemKey[]): WorkItemKey[] {
  const seen = new Set<string>();
  const unique: WorkItemKey[] = [];
  for (const key of keys) {
    const normalizedKey = normalizeWorkItemKey(key.providerId, key.id);
    const stableKey = JSON.stringify([normalizedKey.providerId, normalizedKey.id]);
    if (!seen.has(stableKey)) {
      seen.add(stableKey);
      unique.push(normalizedKey);
    }
  }
  return unique;
}