import { readFileSync, statSync } from 'node:fs';
import type { CriterionIdentity } from '../checklist.js';
import type { Config } from '../config/index.js';
import { localReviewEvidenceSha256 } from '../local_review_evidence.js';
import { readCriterionProof, type CriterionProofEntry } from './criterion_proof.js';
import { validateCriterionExecution } from './criterion_execution.js';
import { buildCriterionSnapshot, criterionInputDigest, evidenceFilePath, hashFile, isRecord, readCriterionInputs, validTimestamp, validateCriterionRevision, type CriterionInput, type CriterionSnapshot } from './criterion_inputs.js';
import { verifyPromptedReview } from './prompted_review.js';

export interface ExecutionReference { path: string; sha256: string }
export interface CriterionEvidence {
  path: string | null;
  status: 'missing' | 'invalid' | 'inconclusive' | 'rejected' | 'verified';
  recommendation: string | null;
  summary: string;
  errors: string[];
  snapshot: CriterionSnapshot | null;
  execution: ExecutionReference | null;
}

export interface PreparedCriterionEvidence {
  result: CriterionEvidence;
  record: Record<string, unknown> | null;
  sha256: string | null;
  inputs: CriterionInput[];
  entry: CriterionProofEntry | null;
}

export interface CriterionEvidenceContext {
  path?: string;
  repoRoot: string;
  headSha: string;
  criterion: CriterionIdentity;
  pr: { number: number; headSha: string; body: string } | null;
  issueText?: string;
  changedPaths?: readonly string[];
  now?: number;
}

function initialResult(path?: string): CriterionEvidence {
  return { path: path ?? null, status: 'missing', recommendation: null, summary: 'No criterion proof was validated.', errors: [], snapshot: null, execution: null };
}

export function prepareCriterionEvidence(context: CriterionEvidenceContext): PreparedCriterionEvidence {
  const result = initialResult(context.path);
  const prepared: PreparedCriterionEvidence = { result, record: null, sha256: null, inputs: [], entry: null };
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
        for (const path of mapping.entry.citedPaths) if (!cited.has(path)) result.errors.push(`The cited proof input ${path} is missing its required file integrity binding.`);
        for (const input of inputs.inputs) if (!mapping.entry.citedPaths.includes(input.path) && input.kind !== 'config' && input.kind !== 'dependency') result.errors.push(`Required input ${input.path} is not cited by the criterion-to-proof entry.`);
      }
      if (proof.kind === 'direct-observation' && artifacts.inputs.length === 0) result.errors.push('Direct observation needs at least one current observation artifact.');
      if (proof.kind === 'test-result' && !inputs.inputs.some(input => input.kind === 'test')) result.errors.push('Test-result proof must bind the cited behavioral test as a required input.');
      if (proof.kind === 'test-result' && (typeof proof.gateName !== 'string' || !proof.gateName.trim())) result.errors.push('Test-result proof must name the configured gate whose observed result proves the criterion.');
      if (proof.kind !== 'prompted-review' && (proof.promptStack !== undefined || proof.review !== undefined)) result.errors.push('Prompt-dependent evidence must use prompted-review and its trusted execution contract.');
      if (proof.kind !== 'test-result' && proof.execution !== undefined) result.errors.push('A command execution claim must use test-result proof and an observed execution receipt.');
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
    result.summary = 'Evidence structure, criterion identity, and current input integrity are valid; proof validation remains.';
    return prepared;
  } catch (error: unknown) {
    result.status = 'invalid';
    result.errors.push(error instanceof Error ? error.message : String(error));
    return prepared;
  }
}

function executionReference(value: unknown): ExecutionReference | null {
  return isRecord(value) && typeof value.path === 'string' && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256) ? { path: value.path, sha256: value.sha256 } : null;
}

export function verifyPreparedCriterion(prepared: PreparedCriterionEvidence, context: CriterionEvidenceContext, config: Config | null, captured?: ExecutionReference): CriterionEvidence {
  const result = prepared.result;
  if (result.errors.length || !prepared.record || !isRecord(prepared.record.proof)) return result;
  const proof = prepared.record.proof;
  if (proof.kind === 'test-result') {
    const reference = captured ?? executionReference(proof.execution);
    if (!reference) result.errors.push('A test execution is not established. Reference an existing observed execution receipt, or use --run-gate <name> to capture the configured test command.');
    else if (!config) result.errors.push('The configured test command cannot be verified without valid repository configuration.');
    else {
      result.execution = reference;
      result.errors.push(...validateCriterionExecution({ repoRoot: context.repoRoot, config, reference, expectedGateName: String(proof.gateName), headSha: context.headSha, inputs: prepared.inputs, inputDigest: criterionInputDigest(prepared.inputs), recordedAt: captured ? new Date().toISOString() : String(prepared.record.recordedAt) }));
    }
  } else if (proof.kind === 'prompted-review') result.errors.push(...verifyPromptedReview({ record: prepared.record, repoRoot: context.repoRoot, issueNumber: context.criterion.issueNumber, pr: context.pr, issueText: context.issueText, changedPaths: context.changedPaths, config }));
  if (result.errors.length) {
    result.status = 'inconclusive';
    result.summary = 'The supplied proof does not establish this criterion; no checkbox was changed.';
  } else {
    result.status = 'verified';
    result.summary = `Criterion ${context.criterion.index} has current ${String(proof.kind)} proof tied to its exact identity and required inputs. Source and observation semantics remain the recorded inspection; citations alone are preparation.`;
  }
  return result;
}
