import type { CiProviderKind } from '../config/types.js';

export type CiCheckResult = 'passed' | 'failed' | 'pending' | 'skipped' | 'unknown';
export type CiCapabilitySupport = 'supported' | 'unsupported' | 'unknown';

export interface CiProviderCapabilities {
  readStatus: boolean;
  diagnoseStatus: boolean;
  readArtifacts: boolean;
  triggerRun: boolean;
}

export type CiProviderId = CiProviderKind;

export interface CiCheckStatus {
  key: string;
  name: string;
  result: CiCheckResult;
  reasonCode: string;
  summary: string;
  url: string | null;
  runId: string | null;
  artifact: string | null;
  workflowName: string | null;
}

export interface CiProvider {
  readonly id: CiProviderId;
  capabilities(): CiProviderCapabilities;
  mapCheck(check: unknown): CiCheckStatus;
  triggerRun(): Promise<never>;
}

export const MISSING_CI_CAPABILITIES: CiProviderCapabilities = Object.freeze({
  readStatus: false,
  diagnoseStatus: false,
  readArtifacts: false,
  triggerRun: false,
});
