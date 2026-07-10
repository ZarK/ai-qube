import assert from "node:assert/strict";

import type {
  QubeAdapterCapability,
  QubeAdapterContract,
  ReviewForgeCapabilities,
  WorkProviderCapabilities,
} from "@tjalve/qube-core";

import type { AdapterRole, RoleHarness } from "./types.js";

export const WORK_CAPABILITIES = Object.freeze([
  "listOpenWork",
  "loadWork",
  "planStatusSync",
  "planLifecycleMutations",
  "applyLifecycleMutations",
  "commentMutations",
  "reviewIntegration",
  "ciMergeStatus",
] as const satisfies readonly (keyof WorkProviderCapabilities)[]);

export const REVIEW_CAPABILITIES = Object.freeze([
  "loadReview",
  "loadReviewSnapshot",
  "findCurrentBranchReview",
  "planReviewRequests",
  "applyReviewRequests",
  "publishLaneReview",
  "publishLaneReviewInline",
  "publishLocalReview",
  "resolveReviewThreads",
  "ciDiagnostics",
] as const satisfies readonly (keyof ReviewForgeCapabilities)[]);

/**
 * Maps adapter capability declarations to the role flags they uniquely own.
 * Shared flags (for example listOpenWork for both map and queue) are attributed
 * to the more general capability so unsupported partial overlaps stay coherent.
 */
export const WORK_DECLARATION_FLAGS: Readonly<Record<string, readonly (keyof WorkProviderCapabilities)[]>> = Object.freeze({
  "map-work-item": Object.freeze(["loadWork"] as const),
  "work-item-queue": Object.freeze(["listOpenWork"] as const),
  "sync-issue-status": Object.freeze(["planStatusSync"] as const),
});

export const REVIEW_DECLARATION_FLAGS: Readonly<Record<string, readonly (keyof ReviewForgeCapabilities)[]>> = Object.freeze({
  "load-pull-request": Object.freeze(["loadReview", "findCurrentBranchReview"] as const),
  "request-review-gate": Object.freeze(["planReviewRequests"] as const),
  "read-merge-blockers": Object.freeze(["loadReview"] as const),
  "read-review-threads": Object.freeze(["loadReview"] as const),
  "resolve-review-threads": Object.freeze(["resolveReviewThreads"] as const),
});

export function declarationMap(adapter: QubeAdapterContract): Map<string, QubeAdapterCapability> {
  return new Map((adapter.capabilities ?? []).map(capability => [capability.id, capability]));
}

export function isSupported(declared: Map<string, QubeAdapterCapability>, id: string): boolean {
  return declared.get(id)?.support === "supported";
}

export function isUnsupported(declared: Map<string, QubeAdapterCapability>, id: string): boolean {
  return declared.get(id)?.support === "unsupported";
}

export function sharedCapabilityIds(harness: RoleHarness): string[] {
  if (harness.role === "work-provider") return ["map-work-item", "work-item-queue", "sync-issue-status"];
  if (harness.role === "review-forge") {
    return ["load-pull-request", "request-review-gate", "read-merge-blockers", "read-review-threads", "resolve-review-threads"];
  }
  if (harness.role === "ci-provider") return ["read-ci-status", "diagnose-ci-status", "trigger-workflow-run"];
  return [];
}

export function assertCapabilityFlagsMatchDeclarations(
  adapter: QubeAdapterContract,
  role: AdapterRole,
  flags: WorkProviderCapabilities | ReviewForgeCapabilities,
  mapping: Readonly<Record<string, readonly string[]>>,
): void {
  const flagRecord = flags as unknown as Record<string, boolean | undefined>;
  for (const declaration of adapter.capabilities ?? []) {
    const requiredFlags = mapping[declaration.id];
    if (!requiredFlags) continue;
    if (declaration.support === "supported") {
      for (const flag of requiredFlags) {
        assert.equal(
          flagRecord[flag],
          true,
          `${role} capability flag ${flag} must be true when adapter declares ${declaration.id} as supported.`,
        );
      }
    }
    if (declaration.support === "unsupported") {
      // Shared flags may remain true when another supported declaration still requires them.
      // Only reject flags that no supported declaration still owns.
      for (const flag of requiredFlags) {
        const stillRequired = (adapter.capabilities ?? []).some(other =>
          other.id !== declaration.id
          && other.support === "supported"
          && (mapping[other.id] ?? []).includes(flag),
        );
        if (stillRequired) continue;
        assert.notEqual(
          flagRecord[flag],
          true,
          `${role} capability flag ${flag} must not be true when adapter declares ${declaration.id} unsupported.`,
        );
      }
    }
  }
}
