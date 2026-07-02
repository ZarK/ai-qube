import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { Config, GateConfig, GateKind, GateStage } from '../config/index.js';
import { isVerifiedGateEvidence, normalizeGateEvidence, type EvidenceSource, type EvidenceTrust, type GateEvidence, type GateEvidenceReasonCode, type GateResult } from '../core/gate_evidence.js';
import type { JsonObject } from '../core/json_value.js';
import { expandGateConfigs } from '../gate_config.js';
import { isSupplyChainSensitive } from '../gate_sensitivity.js';
import { redact } from '@tjalve/qube-adapter-github';
import { SUPPLY_CHAIN_GUARD_NAME, SUPPLY_CHAIN_GUARD_SKILL_PATH, SUPPLY_CHAIN_GUARD_URL } from '../supply_chain_guard.js';

export type GateRequirement = 'required' | 'advisory';
export type GateEvidenceSource = 'not-recorded' | 'agent-reported' | 'evidence-found' | 'verified-from-trusted-state';
export type GateRecordedStatus = 'passed' | 'failed' | 'skipped' | 'unknown';

export interface GatePlanEntry {
  name: string;
  kind: GateKind;
  stage: GateStage;
  command: string;
  requirement: GateRequirement;
  timeoutSeconds: number;
  workingDirectory: string;
  env: Record<string, string>;
  externalService: boolean;
  supplyChainSensitive: boolean;
  evidenceExpected: string[];
  nextAction: string;
}

export interface GatePlanResult {
  ok: true;
  command: 'gates plan';
  dryRun: boolean;
  stage: GateStage | null;
  gates: GatePlanEntry[];
  summary: {
    total: number;
    required: number;
    advisory: number;
    supplyChainSensitive: number;
  };
  warnings: string[];
}

export interface GateStatusEntry extends GatePlanEntry {
  status: GateRecordedStatus;
  evidenceSource: GateEvidenceSource;
  evidencePath: string | null;
  evidenceSummary: string;
  source: EvidenceSource;
  trust: EvidenceTrust;
  reasonCode: GateEvidenceReasonCode;
  verified: boolean;
  evidence: GateEvidence;
}

export interface GateStatusResult {
  ok: true;
  command: 'gates status';
  stage: GateStage | null;
  gates: GateStatusEntry[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    unknown: number;
    notRecorded: number;
    verified: number;
    stale: number;
  };
}

interface EvidenceRecord {
  status: GateRecordedStatus;
  source: GateEvidenceSource;
  path: string | null;
  summary: string;
  evidence: GateEvidence;
}

const STAGE_ORDER: GateStage[] = ['pre-pr', 'pre-merge', 'all'];

const STANDARD_EVIDENCE = [
  'Command exit code and redacted output summary.',
  'Relevant failure details or confirmation from the agent-run command.',
  'Whether the result is required for PR creation, merge, or both.',
];

const SUPPLY_CHAIN_EVIDENCE = [
  `Canonical guard: use ${SUPPLY_CHAIN_GUARD_NAME} (${SUPPLY_CHAIN_GUARD_URL}) and follow ${SUPPLY_CHAIN_GUARD_SKILL_PATH} before execution when installed.`,
  'Need: why this dependency/tool command is necessary before execution.',
  'Exact package, source, version, registry, action, generator, tool, or binary identity.',
  'Lockfile, manifest, workflow, generated-file, or release-artifact impact.',
  'Package or tool age gate result and source trust signal.',
  'Lifecycle script, native binary, network, installer, generator, or credential exposure risk.',
  'Integrity, checksum, signature, provenance, or pinned immutable reference signal where available.',
  'Dependency/tooling scope and rollback plan if execution changes repository state.',
];

export function isGateStage(value: string | undefined): value is GateStage {
  return value === 'all' || value === 'pre-pr' || value === 'pre-merge';
}

export function gateSlug(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug === '' ? 'gate' : slug;
}

function redactRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [redact(key), redact(value)]));
}

function redactEvidencePath(rawPath: string, gate: GateConfig): string {
  const rawSlug = gateSlug(gate.name);
  const redactedSlug = gateSlug(redact(gate.name));
  return redact(rawPath.replace(rawSlug, redactedSlug));
}

export function configuredGates(config: Config): GateConfig[] {
  return expandGateConfigs(config.gates, config.qualityGates, config.qualityControl);
}

function stageMatches(gate: GateConfig, stage: GateStage | null): boolean {
  return stage === null || gate.stage === stage || gate.stage === 'all';
}

function compareGates(left: GateConfig, right: GateConfig): number {
  return STAGE_ORDER.indexOf(left.stage) - STAGE_ORDER.indexOf(right.stage);
}

function planEntry(gate: GateConfig): GatePlanEntry {
  const command = redact(gate.command);
  const supplyChainSensitive = isSupplyChainSensitive(gate.command);
  const evidenceExpected = supplyChainSensitive ? [...STANDARD_EVIDENCE, ...SUPPLY_CHAIN_EVIDENCE] : [...STANDARD_EVIDENCE];
  return {
    name: redact(gate.name),
    kind: gate.kind,
    stage: gate.stage,
    command,
    requirement: gate.required ? 'required' : 'advisory',
    timeoutSeconds: gate.timeoutSeconds,
    workingDirectory: redact(gate.workingDirectory),
    env: redactRecord(gate.env),
    externalService: gate.externalService,
    supplyChainSensitive,
    evidenceExpected,
    nextAction: supplyChainSensitive
      ? `Use ${SUPPLY_CHAIN_GUARD_NAME}'s required evidence model, then run \`${command}\` manually and record the result.`
      : `Run \`${command}\` manually and record the result.`,
  };
}

export function buildGatePlan(config: Config, options: { stage?: GateStage; dryRun?: boolean } = {}): GatePlanResult {
  const stage = options.stage ?? null;
  const gates = configuredGates(config).filter(gate => stageMatches(gate, stage)).sort(compareGates).map(planEntry);
  return {
    ok: true,
    command: 'gates plan',
    dryRun: options.dryRun ?? false,
    stage,
    gates,
    summary: summarizePlan(gates),
    warnings: gates.some(gate => gate.supplyChainSensitive)
      ? [`Supply-chain-sensitive gates require ${SUPPLY_CHAIN_GUARD_NAME} dependency/tool review evidence before the agent runs the command.`]
      : [],
  };
}

function summarizePlan(gates: GatePlanEntry[]): GatePlanResult['summary'] {
  return {
    total: gates.length,
    required: gates.filter(gate => gate.requirement === 'required').length,
    advisory: gates.filter(gate => gate.requirement === 'advisory').length,
    supplyChainSensitive: gates.filter(gate => gate.supplyChainSensitive).length,
  };
}

function readEvidence(root: string, gate: GateConfig): EvidenceRecord {
  const base = join(root, '.qube', 'aie', 'gates', gateSlug(gate.name));
  const jsonPath = `${base}.json`;
  const displayJsonPath = redactEvidencePath(jsonPath, gate);
  if (existsSync(jsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(jsonPath, 'utf8')) as unknown;
      if (isJsonObject(parsed)) {
        const record = parsed;
        const result = readGateResult(record);
        const status = result === 'passed' || result === 'failed' || result === 'skipped' ? result : 'unknown';
        const summary = typeof record.summary === 'string' ? redact(record.summary) : 'Gate evidence JSON was found; no summary was supplied.';
        const trust = readEvidenceTrust(record.trust);
        const stale = result === 'stale' || record.stale === true;
        const evidenceResult = stale ? 'stale' : result;
        const evidence = normalizeGateEvidence({
          key: gateSlug(gate.name),
          name: redact(gate.name),
          stage: gate.stage,
          result: evidenceResult,
          source: 'configured-gate',
          trust,
          command: redact(gate.command),
          providerRunId: null,
          path: displayJsonPath,
          summary,
          recordedAt: typeof record.recordedAt === 'string' ? record.recordedAt : null,
          reasonCode: readReasonCode(record.reasonCode, evidenceResult),
          stale,
          metadata: withGateMetadata(gate, readMetadata(record.metadata)),
        });
        return { status: evidence.stale ? 'unknown' : status, source: trust === 'trusted-provider' || trust === 'local-evidence' ? 'verified-from-trusted-state' : 'agent-reported', path: displayJsonPath, summary, evidence };
      }
      const evidence = gateEvidence(gate, 'unknown', 'configured-gate', 'unverified', displayJsonPath, 'Gate evidence JSON exists but is not an object. Treat the gate as unverified.', 'malformed-evidence');
      return { status: 'unknown', source: 'evidence-found', path: displayJsonPath, summary: evidence.summary, evidence };
    } catch {
      const evidence = gateEvidence(gate, 'unknown', 'configured-gate', 'unverified', displayJsonPath, 'Gate evidence JSON exists but could not be parsed. Treat the gate as unverified.', 'malformed-evidence');
      return { status: 'unknown', source: 'evidence-found', path: displayJsonPath, summary: evidence.summary, evidence };
    }
  }
  const markdownPath = `${base}.md`;
  if (existsSync(markdownPath)) {
    const path = redactEvidencePath(markdownPath, gate);
    const evidence = gateEvidence(gate, 'unknown', 'configured-gate', 'unverified', path, 'Gate evidence notes were found. Executor has not verified the result.', 'unverified-notes');
    return { status: 'unknown', source: 'evidence-found', path, summary: evidence.summary, evidence };
  }
  const evidence = gateEvidence(gate, 'missing', 'configured-gate', 'unverified', null, 'No gate evidence is recorded. Executor cannot claim this gate passed.', 'missing-evidence');
  return { status: 'unknown', source: 'not-recorded', path: null, summary: evidence.summary, evidence };
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readMetadata(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

function readGateResult(record: Record<string, unknown>): GateResult {
  const raw = typeof record.result === 'string' ? record.result : typeof record.status === 'string' ? record.status : 'unknown';
  if (raw === 'passed' || raw === 'failed' || raw === 'skipped' || raw === 'needs-work' || raw === 'unknown' || raw === 'stale' || raw === 'missing') return raw;
  return 'unknown';
}

function readEvidenceTrust(value: unknown): EvidenceTrust {
  if (value === 'unverified' || value === 'agent-reported' || value === 'local-evidence' || value === 'trusted-provider') return value;
  return 'agent-reported';
}

function readReasonCode(value: unknown, result: GateResult): GateEvidenceReasonCode {
  if (value === 'agent-reported-result' || value === 'local-evidence-found' || value === 'trusted-provider-result' || value === 'missing-evidence' || value === 'malformed-evidence' || value === 'unverified-notes' || value === 'stale-evidence' || value === 'manual-audit-disabled' || value === 'manual-audit-incomplete' || value === 'review-not-recorded' || value === 'review-needs-work' || value === 'provider-check-pending' || value === 'provider-check-skipped' || value === 'provider-check-stale') return value;
  if (result === 'stale') return 'stale-evidence';
  if (result === 'missing') return 'missing-evidence';
  return 'agent-reported-result';
}

function withGateMetadata(gate: GateConfig, metadata: JsonObject = {}): JsonObject {
  return { ...metadata, supplyChainSensitive: isSupplyChainSensitive(gate.command) };
}

function gateEvidence(gate: GateConfig, result: GateResult, source: EvidenceSource, trust: EvidenceTrust, path: string | null, summary: string, reasonCode: GateEvidenceReasonCode, metadata: JsonObject = {}): GateEvidence {
  const safeMetadata = withGateMetadata(gate, metadata);
  return normalizeGateEvidence({
    key: gateSlug(gate.name),
    name: redact(gate.name),
    stage: gate.stage,
    result,
    source,
    trust,
    command: redact(gate.command),
    providerRunId: null,
    path,
    summary,
    recordedAt: null,
    reasonCode,
    stale: result === 'stale',
    metadata: safeMetadata,
  });
}

export function buildGateStatus(config: Config, options: { stage?: GateStage; evidenceRoot?: string } = {}): GateStatusResult {
  const stage = options.stage ?? null;
  const root = options.evidenceRoot ?? process.cwd();
  const gates = configuredGates(config).filter(gate => stageMatches(gate, stage)).sort(compareGates).map(rawGate => {
    const gate = planEntry(rawGate);
    const evidence = readEvidence(root, rawGate);
    return {
      ...gate,
      status: evidence.status,
      evidenceSource: evidence.source,
      evidencePath: evidence.path,
      evidenceSummary: evidence.summary,
      source: evidence.evidence.source,
      trust: evidence.evidence.trust,
      reasonCode: evidence.evidence.reasonCode,
      verified: isVerifiedGateEvidence(evidence.evidence),
      evidence: evidence.evidence,
      nextAction: evidence.source === 'not-recorded' ? `Run \`${gate.command}\` manually and record evidence for ${gate.name}.` : 'Inspect the recorded evidence before claiming this gate is satisfied.',
    };
  });
  return { ok: true, command: 'gates status', stage, gates, summary: summarizeStatus(gates) };
}

function summarizeStatus(gates: GateStatusEntry[]): GateStatusResult['summary'] {
  return {
    total: gates.length,
    passed: gates.filter(gate => gate.status === 'passed').length,
    failed: gates.filter(gate => gate.status === 'failed').length,
    skipped: gates.filter(gate => gate.status === 'skipped').length,
    unknown: gates.filter(gate => gate.status === 'unknown').length,
    notRecorded: gates.filter(gate => gate.evidenceSource === 'not-recorded').length,
    verified: gates.filter(gate => gate.verified).length,
    stale: gates.filter(gate => gate.evidence.stale).length,
  };
}

export function formatGatePlan(result: GatePlanResult): string {
  const lines = [`Gate plan: ${result.summary.total} to check, ${result.summary.supplyChainSensitive} supply-chain-sensitive.`];
  if (result.stage) lines.push(`Stage filter: ${result.stage} (includes all-stage gates).`);
  if (result.gates.length === 0) lines.push('No configured gates matched. Executor did not run any commands.');
  for (const gate of result.gates) {
    const markers = [gate.requirement, gate.supplyChainSensitive ? 'supply-chain-sensitive' : null, gate.externalService ? 'external-service' : null].filter(Boolean).join(', ');
    lines.push(`- ${gate.name} [${gate.kind}/${gate.stage}; ${markers}]: ${gate.command}`);
    lines.push(`  Evidence: ${gate.evidenceExpected.join(' ')}`);
  }
  lines.push('Executor never runs gate commands; the agent runs them manually and records evidence.');
  return lines.join('\n');
}

export function formatGateStatus(result: GateStatusResult): string {
  const lines = [`Gate status: ${result.summary.total} configured, ${result.summary.notRecorded} not recorded, ${result.summary.failed} failed, ${result.summary.verified} verified.`];
  if (result.stage) lines.push(`Stage filter: ${result.stage} (includes all-stage gates).`);
  if (result.gates.length === 0) lines.push('No configured gates matched.');
  for (const gate of result.gates) {
    lines.push(`- ${gate.name}: ${gate.status} (${gate.evidenceSource}; ${gate.source}/${gate.trust}; ${gate.reasonCode})`);
    lines.push(`  ${gate.evidenceSummary}`);
  }
  lines.push('Executor reports evidence state only; it does not claim unverified success.');
  return lines.join('\n');
}
