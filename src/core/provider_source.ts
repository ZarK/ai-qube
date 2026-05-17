import type { JsonObject } from './json_value';

export type ProviderResourceKind = 'work-item' | 'review-item' | 'repository' | 'gate-evidence' | 'policy' | 'action-plan';

export interface ProviderSource {
  providerId: string;
  resourceKind: ProviderResourceKind;
  resourceId: string | null;
  url: string | null;
  metadata: JsonObject;
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized === '') {
    throw new Error(`normalize provider source failed: ${field} was empty or whitespace-only; provide a non-empty ${field} value.`);
  }
  return normalized;
}

export function normalizeProviderSource(input: {
  providerId: string;
  resourceKind: ProviderResourceKind;
  resourceId?: string | null;
  url?: string | null;
  metadata?: JsonObject;
}): ProviderSource {
  return {
    providerId: nonEmpty(input.providerId, 'providerId'),
    resourceKind: input.resourceKind,
    resourceId: input.resourceId === undefined || input.resourceId === null ? null : nonEmpty(input.resourceId, 'resourceId'),
    url: input.url === undefined ? null : input.url,
    metadata: input.metadata ?? {},
  };
}

export function sourceKey(source: ProviderSource): string {
  return JSON.stringify([source.providerId, source.resourceKind, source.resourceId]);
}
