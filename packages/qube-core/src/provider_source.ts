import type { JsonObject } from "./json_value.js";

export type ProviderResourceKind = "work-item" | "review-item" | "repository" | "gate-evidence" | "policy" | "action-plan";

export interface ProviderSource {
  readonly providerId: string;
  readonly resourceKind: ProviderResourceKind;
  readonly resourceId: string | null;
  readonly url: string | null;
  readonly metadata: JsonObject;
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${field} was empty or whitespace-only.`);
  return normalized;
}

export function normalizeProviderSource(input: {
  readonly providerId: string;
  readonly resourceKind: ProviderResourceKind;
  readonly resourceId?: string | null;
  readonly url?: string | null;
  readonly metadata?: JsonObject;
}): ProviderSource {
  return {
    providerId: nonEmpty(input.providerId, "providerId"),
    resourceKind: input.resourceKind,
    resourceId: input.resourceId === undefined || input.resourceId === null ? null : nonEmpty(input.resourceId, "resourceId"),
    url: input.url === undefined ? null : input.url,
    metadata: input.metadata ?? {},
  };
}
