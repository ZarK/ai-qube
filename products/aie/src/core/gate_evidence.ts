import type { JsonObject } from './json_value.js';

export type GateStage = 'all' | 'pre-pr' | 'pre-merge';
export type GateResult = 'passed' | 'failed' | 'skipped' | 'needs-work' | 'unknown' | 'stale' | 'missing';
export type EvidenceSource = 'configured-gate' | 'manual-audit' | 'review-agent' | 'provider-check' | 'quality-control';
export type EvidenceTrust = 'unverified' | 'agent-reported' | 'local-evidence' | 'trusted-provider';
export type GateEvidenceReasonCode =
  | 'agent-reported-result'
  | 'local-evidence-found'
  | 'trusted-provider-result'
  | 'missing-evidence'
  | 'malformed-evidence'
  | 'unverified-notes'
  | 'stale-evidence'
  | 'manual-audit-disabled'
  | 'manual-audit-incomplete'
  | 'review-not-recorded'
  | 'review-needs-work'
  | 'provider-check-pending'
  | 'provider-check-skipped'
  | 'provider-check-stale';

export interface GateDefinition {
  key: string;
  name: string;
  stage: GateStage;
  required: boolean;
  command: string | null;
  externalService: boolean;
  supplyChainSensitive: boolean;
}

export interface GateEvidence {
  key: string;
  name: string;
  stage: GateStage;
  result: GateResult;
  source: EvidenceSource;
  trust: EvidenceTrust;
  command: string | null;
  providerRunId: string | null;
  path: string | null;
  summary: string;
  recordedAt: string | null;
  reasonCode: GateEvidenceReasonCode;
  stale: boolean;
  metadata: JsonObject;
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized === '') throw new Error(`${field} must be a non-empty string.`);
  return normalized;
}

function defaultReasonCode(input: Pick<GateEvidence, 'result' | 'source' | 'trust'>): GateEvidenceReasonCode {
  if (input.result === 'missing') return 'missing-evidence';
  if (input.result === 'stale') return input.source === 'provider-check' ? 'provider-check-stale' : 'stale-evidence';
  if (input.source === 'provider-check') {
    if (input.result === 'skipped') return 'provider-check-skipped';
    if (input.result === 'unknown') return 'provider-check-pending';
    return input.trust === 'trusted-provider' ? 'trusted-provider-result' : 'agent-reported-result';
  }
  if (input.source === 'manual-audit') return input.trust === 'local-evidence' ? 'local-evidence-found' : 'missing-evidence';
  if (input.source === 'review-agent') return input.result === 'needs-work' ? 'review-needs-work' : 'agent-reported-result';
  return input.trust === 'trusted-provider' ? 'trusted-provider-result' : 'agent-reported-result';
}

export function normalizeGateEvidence(input: Omit<GateEvidence, 'metadata' | 'reasonCode' | 'stale'> & { metadata?: JsonObject; reasonCode?: GateEvidenceReasonCode; stale?: boolean }): GateEvidence {
  const stale = input.stale ?? input.result === 'stale';
  const result = stale ? 'stale' : input.result;
  return {
    ...input,
    result,
    key: nonEmpty(input.key, 'key'),
    name: nonEmpty(input.name, 'name'),
    summary: nonEmpty(input.summary, 'summary'),
    reasonCode: input.reasonCode ?? defaultReasonCode({ ...input, result }),
    stale,
    metadata: input.metadata ?? {},
  };
}

export function isVerifiedGateEvidence(evidence: GateEvidence): boolean {
  return !evidence.stale && evidence.result === 'passed' && (evidence.trust === 'trusted-provider' || evidence.trust === 'local-evidence');
}
