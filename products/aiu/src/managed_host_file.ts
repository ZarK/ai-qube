import type { ContinuationAssetMerge, ContinuationAssetValidation } from "@tjalve/qube-core";

import { getAiuContinuationAdapter } from "./continuation_adapters.js";
import type { AiuManagedHostFile } from "./host_policy.js";

export const MANAGED_HOST_FILE_STATES = ["current", "missing", "duplicate", "malformed", "conflicting"] as const;

export type ManagedHostFileState = (typeof MANAGED_HOST_FILE_STATES)[number];
export type ManagedHostFileValidation = ContinuationAssetValidation;
export type SharedManagedHostFile = Extract<AiuManagedHostFile, { readonly ownership: "shared" }>;
export type ManagedHostFileMerge = ContinuationAssetMerge;

export function validateManagedHostFile(existing: string | undefined, file: AiuManagedHostFile): ManagedHostFileValidation {
  return getAiuContinuationAdapter(file.host).validateManagedAsset(file.id, existing, file);
}

export function mergeManagedHostFile(existing: string, file: SharedManagedHostFile): ManagedHostFileMerge {
  return getAiuContinuationAdapter(file.host).mergeManagedAsset(file.id, existing, file);
}
