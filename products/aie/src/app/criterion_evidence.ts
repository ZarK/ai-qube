import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import type { CriterionIdentity } from '../checklist.js';
import type { Config } from '../config/index.js';
import { localReviewEvidenceSha256, readLocalReviewGate } from '../local_review_evidence.js';
import { buildGateStatus } from '../gates/index.js';
import { readCriterionProof, type CriterionProofEntry } from './criterion_proof.js';
import { buildCriterionSnapshot, evidenceFilePath, hashFile, isRecord, readCriterionInputs, validTimestamp, validateCriterionRevision, type CriterionInput, type CriterionSnapshot } from './criterion_inputs.js';

export interface CriterionEvidence {
  path: string | null;
  status: 'missing' | 'invalid' | 'inconclusive' | 'rejected' | 'verified';
  recommendation: string | null;
  summary: string;
  errors: string[];
  snapshot: CriterionSnapshot | null;
}

export interface PreparedCriterionEvidence {
  result: CriterionEvidence;
  record: Record<string, unknown> | null;
  sha256: string | null;
  inputs: CriterionInput[];
  artifacts: CriterionInput[];
  entry: CriterionProofEntry | null;
}

export interface CriterionEvidenceContext {
  path?: string;
  repoRoot: string;
  headSha: string;
  criterion: CriterionIdentity;
  pr: { number: number; headSha: string; body: string } | null;
  now?: number;
}

function initialResult(path?: string): CriterionEvidence {
  return { path: path ?? null, status: 'missing', recommendation: null, summary: 'No criterion proof was validated.', errors: [], snapshot: null };
}

export function prepareCriterionEvidence(context: CriterionEvidenceContext): PreparedCriterionEvidence {
  const result = initialResult(context.path);
  const prepared: PreparedCriterionEvidence = { result, record: null, sha256: null, inputs: [], artifacts: [], entry: null };
  if (!context.path) { result.errors.push('Pass --evidence <path> with criterion-specific proof.'); return prepared; }
  try {
    const fullPath = evidenceFilePath(context.path, context.repoRoot);
    if (statSync(fullPath).size > 1024 * 1024) throw new Error('Criterion evidence exceeds the 1 MiB limit.');
    const record: unknown = JSON.parse(readFileSync(fullPath, 'utf8'));
    prepared.sha256 = hashFile(fullPath);
    if (!isRecord(record)) throw new Error('Criterion evidence must be a JSON object.');
    prepared.record = record;
    result.status = 'invalid';
    result.recommendation = typeof record.recommendation === 'string' ? record.recommendation : null;
    if (record.version !== 1) result.errors.push('Criterion evidence version must be 1.');
    if (!isRecord(record.criterion) || record.criterion.issueNumber !== context.criterion.issueNumber || record.criterion.index !== context.criterion.index || record.criterion.text !== context.criterion.text) result.errors.push('Proof criterion must match the exact issue number, checklist index, and full text.');
    if (!validTimestamp(record.recordedAt, context.now)) result.errors.push('Proof recordedAt must be a valid UTC ISO timestamp and cannot be in the future.');
    if (!['approve', 'request-changes', 'inconclusive'].includes(String(record.recommendation))) result.errors.push('Proof recommendation must be approve, request-changes, or inconclusive.');
    const inputs = readCriterionInputs(record.inputs, context.repoRoot, 'Required inputs');
    const artifacts = readCriterionInputs(record.artifacts, context.repoRoot, 'Observation artifacts', true);
    prepared.inputs = inputs.inputs;
    prepared.artifacts = artifacts.inputs;
    result.errors.push(...inputs.errors, ...artifacts.errors);
    for (const input of inputs.inputs) if (!['source', 'test', 'config', 'dependency'].includes(input.kind)) result.errors.push(`Unsupported required input kind ${input.kind}.`);
    for (const artifact of artifacts.inputs) if (!['observation', 'test-output', 'review'].includes(artifact.kind)) result.errors.push(`Artifact ${artifact.path} is a required implementation input; bind it in inputs rather than as ${artifact.kind} observation evidence.`);
    let revisionErrors: string[] = [];
    if (inputs.errors.length === 0) {
      result.snapshot = buildCriterionSnapshot(context.repoRoot, context.headSha, inputs.inputs);
      revisionErrors = validateCriterionRevision(record.revision, context.repoRoot, context.headSha, context.pr?.headSha ?? null, inputs.inputs);
    }
    if (!isRecord(record.proof)) result.errors.push('Proof must identify its evidence kind, observed result, and criterion-to-proof entry.');
    else {
      const proof = record.proof;
      if (!['source-inspection', 'direct-observation', 'test-result', 'prompted-review'].includes(String(proof.kind))) result.errors.push('Unsupported proof kind; use source-inspection, direct-observation, test-result, or prompted-review.');
      if (typeof proof.observation !== 'string' || !proof.observation.trim() || /\[(?:UNFILLED|TODO)|^<.*>$/.test(proof.observation)) result.errors.push('Proof needs the actual observation that establishes this criterion.');
      const mapping = typeof record.criterionToProof === 'string' ? readCriterionProof(record.criterionToProof, context.criterion) : { entry: null, errors: ['Proof must retain the existing criterion-to-proof entry in criterionToProof.'] };
      prepared.entry = mapping.entry;
      result.errors.push(...mapping.errors);
      if (context.pr) {
        const current = readCriterionProof(context.pr.body, context.criterion);
        result.errors.push(...current.errors);
        if (mapping.entry && current.entry && localReviewEvidenceSha256(mapping.entry) !== localReviewEvidenceSha256(current.entry)) result.errors.push('Proof criterion-to-proof entry does not match the current PR entry.');
      }
      if (mapping.entry) {
        if (mapping.entry.citedPaths.length === 0) result.errors.push('The criterion-to-proof entry must cite its supporting source or observation files.');
        const cited = new Set([...inputs.inputs, ...artifacts.inputs].map(input => input.path));
        for (const path of mapping.entry.citedPaths) if (!cited.has(path)) result.errors.push(`The cited file ${path} is missing its required hash.`);
        for (const input of inputs.inputs) if (!mapping.entry.citedPaths.includes(input.path) && input.kind !== 'config' && input.kind !== 'dependency') result.errors.push(`Required input ${input.path} is not cited by the criterion-to-proof entry.`);
      }
      if (proof.kind === 'direct-observation' && artifacts.inputs.length === 0) result.errors.push('Direct observation needs at least one current observation artifact.');
      if (proof.kind === 'test-result' && !inputs.inputs.some(input => input.kind === 'test')) result.errors.push('Test-result proof must bind the cited behavioral test as a required input.');
      if (proof.kind === 'test-result' && (typeof proof.gateName !== 'string' || !proof.gateName.trim())) result.errors.push('Test-result proof must name the configured gate whose observed result proves the criterion.');
      if (proof.kind !== 'prompted-review' && (proof.promptStack !== undefined || proof.review !== undefined)) result.errors.push('Review evidence must use prompted-review and reference an existing review result.');
      if (proof.execution !== undefined || proof.runner !== undefined || proof.reviewer !== undefined) result.errors.push('Proof cannot claim an unverified execution, runner, or reviewer record.');
    }
    if (result.errors.length > 0) { result.errors.push(...revisionErrors); return prepared; }
    if (revisionErrors.length > 0) {
      result.status = 'inconclusive';
      result.summary = 'The criterion proof has no verified current revision or work snapshot.';
      result.errors.push(...revisionErrors);
      return prepared;
    }
    if (record.recommendation !== 'approve') {
      result.status = record.recommendation === 'inconclusive' ? 'inconclusive' : 'rejected';
      result.errors.push(`Proof recommendation is ${record.recommendation}; the criterion cannot be completed.`);
      return prepared;
    }
    result.status = 'inconclusive';
    result.summary = 'The record matches the criterion, revision, and current files. Its result still needs validation.';
    return prepared;
  } catch (error: unknown) {
    result.status = 'invalid';
    result.errors.push(error instanceof Error ? error.message : String(error));
    return prepared;
  }
}

function verifyGateResult(prepared: PreparedCriterionEvidence, context: CriterionEvidenceContext, gateName: string, config: Config): { errors: string[]; trust: string | null } {
  const errors: string[] = [];
  const matches = buildGateStatus(config, { evidenceRoot: context.repoRoot }).gates.filter(gate => gate.name === gateName);
  if (matches.length !== 1) return { errors: [`Configured gate ${JSON.stringify(gateName)} was not found exactly once.`], trust: null };
  const gate = matches[0];
  if (gate.status !== 'passed' || gate.evidence.stale) errors.push(`Configured gate ${JSON.stringify(gateName)} does not have a current passing result.`);
  if (gate.trust === 'unverified') errors.push(`Configured gate ${JSON.stringify(gateName)} is unverified; recorded trust is ${gate.trust}.`);
  const criterionTime = Date.parse(String(prepared.record?.recordedAt));
  const gateTime = Date.parse(gate.evidence.recordedAt ?? '');
  if (!Number.isFinite(gateTime) || gateTime > criterionTime) errors.push(`Configured gate ${JSON.stringify(gateName)} must have a valid recordedAt no later than the criterion evidence.`);
  const revision = prepared.record?.revision;
  if (!isRecord(revision) || gate.evidence.metadata.headCommit !== revision.headSha) errors.push(`Configured gate ${JSON.stringify(gateName)} does not match the proof revision head.`);
  const evidencePath = gate.evidence.path
    ? (isAbsolute(gate.evidence.path) ? relative(context.repoRoot, gate.evidence.path) : gate.evidence.path).replace(/\\/gu, '/')
    : null;
  if (!evidencePath || !prepared.artifacts.some(artifact => artifact.path === evidencePath)) errors.push(`Include the result file and its SHA-256 for configured gate ${JSON.stringify(gateName)}.`);
  return { errors, trust: gate.trust };
}

function verifyPromptedReview(prepared: PreparedCriterionEvidence, context: CriterionEvidenceContext): string[] {
  const proof = prepared.record?.proof;
  if (!isRecord(proof) || !context.pr || !isRecord(proof.review) || proof.review.lane !== 'issue-compliance') return ['Prompted criterion proof requires an existing current-PR issue-compliance review.'];
  const stack = proof.promptStack;
  if (!Array.isArray(stack) || stack.length === 0 || !stack.every(fragment => isRecord(fragment) && typeof fragment.id === 'string' && typeof fragment.sha256 === 'string' && /^[a-f0-9]{64}$/.test(fragment.sha256))) return ['Prompted proof requires the exact reviewed prompt stack IDs and SHA-256 digests.'];
  const gate = readLocalReviewGate({ repoRoot: context.repoRoot, issueNumbers: [context.criterion.issueNumber], prNumber: context.pr.number, headSha: context.pr.headSha, reviewers: [], required: true, profile: 'local-focused', activeFocuses: ['issue-compliance'] });
  if (gate.status !== 'passed') return [`Referenced issue-compliance review is not trusted and current: ${gate.summary}`];
  const lane = gate.evidence.flatMap(evidence => evidence.lanes).find(candidate => candidate.id === 'issue-compliance');
  if (!lane || lane.runnerProvenance?.runnerKind !== 'local-host' || !lane.runnerProvenance.freshContext || lane.runnerProvenance.promptOnly) return ['Prompted proof requires an executed trusted issue-compliance review.'];
  if (localReviewEvidenceSha256(stack) !== localReviewEvidenceSha256(lane.promptStack.map(fragment => ({ id: fragment.id, sha256: fragment.sha256 })))) return ['Prompt stack does not match the referenced issue-compliance review.'];
  if (proof.review.headSha !== context.pr.headSha || proof.review.prNumber !== context.pr.number) return ['Prompted proof reference must match the current PR and head.'];
  const path = `.qube/aie/reviews/${context.criterion.issueNumber}/${context.pr.number}/${context.pr.headSha}/issue-compliance.json`;
  const evidenceSha256 = proof.review.evidenceSha256;
  if (typeof evidenceSha256 !== 'string' || !prepared.artifacts.some(artifact => artifact.path === path && artifact.sha256 === evidenceSha256)) return ['Include the referenced review file and its SHA-256 in artifacts.'];
  return [];
}

export function verifyPreparedCriterion(prepared: PreparedCriterionEvidence, context: CriterionEvidenceContext, config: Config | null): CriterionEvidence {
  const result = prepared.result;
  if (result.errors.length || !prepared.record || !isRecord(prepared.record.proof)) return result;
  const proof = prepared.record.proof;
  let trust: string | null = null;
  if (proof.kind === 'test-result') {
    if (!config) result.errors.push('The configured gate result cannot be verified without valid repository configuration.');
    else {
      const gate = verifyGateResult(prepared, context, String(proof.gateName), config);
      result.errors.push(...gate.errors);
      trust = gate.trust;
    }
  } else if (proof.kind === 'prompted-review') result.errors.push(...verifyPromptedReview(prepared, context));
  if (result.errors.length) {
    result.status = 'inconclusive';
    result.summary = 'The supplied proof does not establish this criterion; no checkbox was changed.';
  } else {
    result.status = 'verified';
    result.summary = `Criterion ${context.criterion.index} has valid ${String(proof.kind)} evidence for the current files.${trust ? ` The gate result is ${trust}.` : ''}`;
  }
  return result;
}
