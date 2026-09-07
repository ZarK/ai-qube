import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { gitDeltaPathsSync, laneArtifactViolation, localReviewEvidenceSha256 } from '../local_review_evidence.js';

export interface CriterionInput { kind: string; path: string; sha256: string }
export interface CriterionSnapshot { headSha: string; sha256: string }
export type CriterionRevision = { kind: 'pr'; headSha: string } | { kind: 'work-snapshot'; headSha: string; sha256: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validTimestamp(value: unknown, now = Date.now()): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value && time <= now;
}

export function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function criterionRepository(cwd: string): { repoRoot: string; headSha: string } {
  const repoRoot = realpathSync(git(cwd, ['rev-parse', '--show-toplevel']));
  return { repoRoot, headSha: git(repoRoot, ['rev-parse', '--verify', 'HEAD']) };
}

export function readCriterionInputs(value: unknown, repoRoot: string, label: string, allowEmpty = false): { inputs: CriterionInput[]; errors: string[] } {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) return { inputs: [], errors: [`${label} must contain ${allowEmpty ? 'an array of' : 'at least one'} file digest record.`] };
  const inputs: CriterionInput[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.kind !== 'string' || !entry.kind.trim() || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      errors.push(`${label} contains a malformed entry; kind, repository-relative path, and lowercase SHA-256 are required.`);
      continue;
    }
    const input = { kind: entry.kind, path: entry.path, sha256: entry.sha256 };
    if (input.path.includes('\\') || input.path.includes(':') || /[\u0000-\u001f]/.test(input.path) || input.path.split('/').some(part => !part || part === '.' || part === '..') || isAbsolute(input.path)) {
      errors.push(`${label} path must be a canonical repository-relative path: ${input.path}.`);
      continue;
    }
    if (input.kind === 'command' || input.path.toLowerCase().startsWith('.git/')) {
      errors.push(`${label} cannot use a command string or trusted-store path as ordinary file proof: ${input.path}.`);
      continue;
    }
    const violation = laneArtifactViolation(label, 'passed', [input], repoRoot);
    if (violation) { errors.push(violation); continue; }
    let current = repoRoot;
    let linked = false;
    for (const segment of input.path.split('/')) {
      current = join(current, segment);
      if (lstatSync(current).isSymbolicLink()) { linked = true; break; }
    }
    if (linked) { errors.push(`${label} cannot depend on a symlink or junction: ${input.path}.`); continue; }
    if (seen.has(input.path)) { errors.push(`${label} contains duplicate path ${input.path}.`); continue; }
    seen.add(input.path);
    inputs.push(input);
  }
  return { inputs, errors };
}

export function criterionInputDigest(inputs: readonly CriterionInput[]): string {
  return localReviewEvidenceSha256([...inputs].map(input => ({ path: input.path, sha256: input.sha256 })).sort((a, b) => a.path.localeCompare(b.path, 'en')));
}

export function currentInputDigest(repoRoot: string, inputs: readonly CriterionInput[]): string {
  const checked = readCriterionInputs(inputs, repoRoot, 'Required inputs');
  if (checked.errors.length) throw new Error(checked.errors.join(' '));
  return criterionInputDigest(checked.inputs);
}

export function buildCriterionSnapshot(repoRoot: string, headSha: string, inputs: readonly CriterionInput[]): CriterionSnapshot {
  const gitDirectory = realpathSync(resolve(repoRoot, git(repoRoot, ['rev-parse', '--git-common-dir'])));
  return { headSha, sha256: localReviewEvidenceSha256({ repository: gitDirectory, headSha, inputs: criterionInputDigest(inputs) }) };
}

export function validateCriterionRevision(value: unknown, repoRoot: string, currentHead: string, prHead: string | null, inputs: readonly CriterionInput[]): string[] {
  if (!isRecord(value) || !['pr', 'work-snapshot'].includes(String(value.kind)) || typeof value.headSha !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.headSha)) return ['Proof requires an explicit PR revision or reproducible work-snapshot binding with a full head SHA.'];
  if (prHead !== null && currentHead !== prHead) return [`Local HEAD ${currentHead} does not match current PR head ${prHead}.`];
  if (value.kind === 'pr' && prHead === null) return ['No PR exists; supply an explicit work-snapshot binding instead of omitting revision validation.'];
  try {
    git(repoRoot, ['merge-base', '--is-ancestor', value.headSha, currentHead]);
  } catch { return [`Proof head ${value.headSha} is not a verifiable ancestor of current HEAD ${currentHead}.`]; }
  const delta = value.headSha === currentHead ? [] : gitDeltaPathsSync(repoRoot, value.headSha, currentHead);
  if (delta === null) return ['The revision delta is unavailable; prior proof cannot be carried forward.'];
  const errors: string[] = [];
  if (value.kind === 'work-snapshot') {
    const expected = buildCriterionSnapshot(repoRoot, value.headSha, inputs);
    if (value.sha256 !== expected.sha256) errors.push(`Work snapshot SHA-256 must match the repository, bound head, and required input digests (${expected.sha256}).`);
    if (prHead === null) return errors;
  }
  for (const input of inputs) {
    if (value.kind === 'pr' && delta.includes(input.path)) errors.push(`Required input ${input.path} changed since proof revision ${value.headSha}; capture current proof.`);
    try {
      git(repoRoot, ['cat-file', '-e', `${currentHead}:${input.path}`]);
      git(repoRoot, ['diff', '--quiet', '--no-ext-diff', '--no-textconv', currentHead, '--', input.path]);
    } catch { errors.push(`Required input ${input.path} does not match current PR revision ${currentHead}; commit the required behavior before completing the criterion.`); }
  }
  return errors;
}

export function evidenceFilePath(path: string, repoRoot: string): string {
  const fullPath = resolve(repoRoot, path);
  const relativePath = relative(repoRoot, fullPath);
  if (relativePath === '' || lstatSync(fullPath).isSymbolicLink()) throw new Error('Criterion evidence must be a regular file, not a symlink.');
  // The explicit CLI evidence path may live outside the checkout; all files it
  // cites remain confined to the repository by readCriterionInputs.
  if (!relativePath.startsWith('..') && !isAbsolute(relativePath)) {
    let current = repoRoot;
    for (const segment of relativePath.split(/[\\/]/)) {
      current = join(current, segment);
      if (lstatSync(current).isSymbolicLink()) throw new Error('Criterion evidence cannot be read through a symlink or junction.');
    }
  }
  if (!lstatSync(fullPath).isFile()) throw new Error('Criterion evidence must be a regular file.');
  return fullPath;
}
