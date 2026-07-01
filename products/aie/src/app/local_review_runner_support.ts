import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { renderAgentPrompt } from '../agent_descriptors.js';
import { COMPREHENSIVE_LOCAL_REVIEW_LANES, type LocalReviewContextReviewed, type LocalReviewLaneId, type LocalReviewProfile, type LocalReviewRecommendation, type LocalReviewRunnerProvenance, type LocalReviewSeverity, type LocalReviewStatus } from '../local_review_evidence.js';
import type { PrGateExec, PrGateExecResult } from './pr_gate.js';

const execFileAsync = promisify(execFile);

export interface LaneEvidence {
  id: LocalReviewLaneId;
  status: LocalReviewStatus;
  severity: LocalReviewSeverity;
  recommendation: LocalReviewRecommendation;
  summary: string;
  blockers: string[];
  artifacts: Array<{ kind: string; path: string; sha256: string }>;
  commands: string[];
  surfaces: string[];
  contextReviewed: LocalReviewContextReviewed[];
  promptStack: Array<{ id: string; source: string; sourceCategory?: string; path: string | null; sha256: string | null; trust: string }>;
  toolsUsed: string[];
  runnerProvenance: LocalReviewRunnerProvenance | null;
}

function safeSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function laneEvidenceDirectory(repoRoot: string, issueNumber: number, prNumber: number, headSha: string): string {
  return join(repoRoot, '.qube', 'aie', 'reviews', String(issueNumber), String(prNumber), safeSegment(headSha));
}

export function laneEvidencePath(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, lane: LocalReviewLaneId): string {
  return join(laneEvidenceDirectory(repoRoot, issueNumber, prNumber, headSha), `${lane}.json`);
}

export function reviewSessionLockPath(repoRoot: string, issueNumber: number, prNumber: number, headSha: string): string {
  return join(laneEvidenceDirectory(repoRoot, issueNumber, prNumber, headSha), '.review-lock.json');
}

export function reviewSessionLockLines(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, evidencePaths: readonly string[]): string[] {
  const lockPath = reviewSessionLockPath(repoRoot, issueNumber, prNumber, headSha);
  return [
    `Review session lock: ${lockPath}.`,
    'The main agent creates this lock before spawning review subagents and must delete it after publishing provider-visible feedback.',
    'While the lock exists, review subagents must not edit source, tests, docs, config, package metadata, PR body, or issue content.',
    'Do not run git restore, git checkout, git reset, or other commands that revert another agent\'s in-progress work in the shared checkout.',
    `Subagents may write only these lane evidence paths plus matching host-provenance JSON: ${evidencePaths.join(', ')}.`,
    'Provider-visible pull request comments are the human audit trail; local JSON under .qube/aie/reviews/ is optional audit evidence.',
  ];
}

export function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function hostProvenancePath(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, lane: LocalReviewLaneId): string {
  return join(repoRoot, '.git', 'qube', 'aie', 'host-provenance', String(issueNumber), String(prNumber), safeSegment(headSha), `${lane}.json`);
}

export function laneContextLines(lane: LocalReviewLaneId, issueNumbers: readonly number[], prNumber: number, headSha: string, evidencePaths: readonly string[], extraContext: readonly string[], repoRoot: string): string[] {
  const primaryIssue = issueNumbers[0] ?? 0;
  const primaryEvidencePath = evidencePaths[0] ?? '';
  return [
    `Run local review lane ${lane}.`,
    `Issue: #${primaryIssue}.`,
    `Linked issues for this PR-level lane: ${issueNumbers.map(issueNumber => `#${issueNumber}`).join(', ')}.`,
    `Pull request: #${prNumber}.`,
    `PR head SHA: ${headSha}.`,
    `Record the resulting local-host evidence JSON at this exact issue evidence path: ${primaryEvidencePath}.`,
    `The evidence JSON must include issueNumber ${primaryIssue}, prNumber ${prNumber}, headSha ${headSha}, lane ${lane}, profile, adapter local-host, status, severity, recommendation, summary, blockers, artifacts, commands, surfaces, contextReviewed, promptStack, toolsUsed, runnerProvenance, and recordedAt.`,
    'Include runnerProvenance with runnerKind local-host, host codex, freshContext true, promptOnly false, the current PR head SHA, promptStackHash, and the subagent task/session/thread id when the host exposes one.',
    `Bind local-host evidence to same-user host provenance at this exact path: ${hostProvenancePath(repoRoot, primaryIssue, prNumber, headSha, lane)}.`,
    ...reviewSessionLockLines(repoRoot, primaryIssue, prNumber, headSha, evidencePaths),
    'The host provenance JSON must include version 1, issueNumber, prNumber, headSha, lane, evidenceSha256, runnerKind local-host, host, freshContext, promptOnly, taskId, sessionId, threadId, promptStackHash, and recordedAt. evidenceSha256 is the canonical SHA-256 digest of the evidence JSON object using QUBE localReviewEvidenceSha256 semantics: object keys sorted recursively, arrays ordered as written, JSON string escaping, and no trailing newline.',
    'This is audit evidence for a separate host task/session/thread, not a cryptographic attestation against same-user repo code.',
    'Writing the requested evidence and host-provenance files is allowed; do not edit source, tests, docs, config, package metadata, PR body, or issue content from inside the reviewer lane.',
    'Return evidence for this lane only; publish provider-visible lane review with `qube aie pr review publish <pr> --lane <lane> --issue <issue>` (or `aie pr review publish` in this repository) after writing lane evidence.',
    'Return evidence for this lane only; the main agent waits for all lane reviews on the pull request before addressing feedback.',
    ...extraContext,
  ];
}

export function promptStack(lane: LocalReviewLaneId, contextLines: readonly string[] = [`Run local review lane ${lane}.`]) {
  return renderAgentPrompt({
    hostId: 'codex',
    descriptorId: 'qa-reviewer',
    categoryId: 'review',
    laneIds: [lane],
    contextLines,
    outputContract: 'Return JSON local review lane evidence for the requested lane, including runnerProvenance for the fresh independent reviewer context.',
  });
}

export interface LocalReviewSpawnContract {
  agentType: string;
  forkContext: false;
  modelTier: 'review' | 'economy';
  lane: LocalReviewLaneId;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  taskPrompt: string;
  publishCommand: string;
}

export function buildLocalReviewPublishCommand(prNumber: number, lane: LocalReviewLaneId, issueNumber: number, workspaceRunner = 'node products/aie/bin/run'): string {
  return `${workspaceRunner} pr review publish ${prNumber} --lane ${lane} --issue ${issueNumber}`;
}

export function buildLocalReviewSpawnPrompt(input: {
  hostAgentType: string;
  lane: LocalReviewLaneId;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  promptText: string;
  publishCommand: string;
}): string {
  const promptText = input.promptText.trim();
  return [
    `You are the QUBE ${input.hostAgentType} subagent for review lane "${input.lane}".`,
    `Issue #${input.issueNumber}, PR #${input.prNumber}, head ${input.headSha}.`,
    'Read-only focused PR review: inspect only what this lane requires; do not edit source, tests, docs, config, package metadata, PR body, or issue content.',
    'The complete lane instructions are inline below. Do not read external prompt files and do not follow paths under .qube/aie/reviews/.../prompts/.',
    '',
    '--- LANE PROMPT START ---',
    promptText,
    '--- LANE PROMPT END ---',
    '',
    `When complete, publish provider-visible feedback with: ${input.publishCommand}`,
    'Report recommendation, blockers, evidence path, runner provenance path, and provider comment URL if published.',
  ].join('\n');
}

export function buildLocalReviewSpawnContract(input: {
  hostAgentType: string;
  lane: LocalReviewLaneId;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  promptText: string;
  publishCommand: string;
}): LocalReviewSpawnContract {
  return {
    agentType: input.hostAgentType,
    forkContext: false,
    modelTier: 'review',
    lane: input.lane,
    issueNumber: input.issueNumber,
    prNumber: input.prNumber,
    headSha: input.headSha,
    taskPrompt: buildLocalReviewSpawnPrompt(input),
    publishCommand: input.publishCommand,
  };
}

function promptStackEvidence(lane: LocalReviewLaneId): LaneEvidence['promptStack'] {
  return promptStack(lane).promptStack.map(fragment => ({
    id: fragment.id,
    source: fragment.source,
    sourceCategory: fragment.sourceCategory,
    path: fragment.path,
    sha256: fragment.sha256,
    trust: fragment.trust,
  }));
}

function defaultContext(issueNumber: number, prNumber: number): LocalReviewContextReviewed[] {
  return [
    { kind: 'issue-body', source: `issue:${issueNumber}`, trust: 'untrusted-task-input', freshness: 'current' },
    { kind: 'pr-body', source: `pr:${prNumber}`, trust: 'untrusted-task-input', freshness: 'current' },
    { kind: 'diff', source: `pr:${prNumber}:diff`, trust: 'untrusted-task-input', freshness: 'current' },
    { kind: 'ci', source: `pr:${prNumber}:checks`, trust: 'trusted-provider', freshness: 'current' },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function readArtifacts(value: unknown): LaneEvidence['artifacts'] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map(item => ({
    kind: typeof item.kind === 'string' ? item.kind : 'json',
    path: typeof item.path === 'string' ? item.path : '',
    sha256: typeof item.sha256 === 'string' ? item.sha256 : '',
  }));
}

function readLaneId(value: unknown): LocalReviewLaneId | null {
  return COMPREHENSIVE_LOCAL_REVIEW_LANES.includes(value as LocalReviewLaneId) ? value as LocalReviewLaneId : null;
}

function readStatus(value: unknown): LocalReviewStatus {
  return value === 'passed' || value === 'failed' || value === 'needs-work' || value === 'pending' || value === 'missing' || value === 'stale' || value === 'unavailable' || value === 'malformed' || value === 'inconclusive' ? value : 'malformed';
}

function readSeverity(value: unknown): LocalReviewSeverity {
  return value === 'none' || value === 'low' || value === 'medium' || value === 'high' || value === 'critical' ? value : 'none';
}

function readRecommendation(value: unknown, status: LocalReviewStatus): LocalReviewRecommendation {
  if (value === 'approve' || value === 'request-changes' || value === 'pending' || value === 'inconclusive') return value;
  if (status === 'passed') return 'approve';
  if (status === 'failed' || status === 'needs-work') return 'request-changes';
  if (status === 'pending') return 'pending';
  return 'inconclusive';
}

function normalizeExternalLane(value: unknown, lane: LocalReviewLaneId, issueNumber: number, prNumber: number, headSha: string): LaneEvidence | null {
  if (!isRecord(value)) return null;
  const id = readLaneId(value.lane ?? value.id);
  if (id !== lane) return null;
  if (value.issueNumber !== issueNumber || value.prNumber !== prNumber || value.headSha !== headSha) return null;
  if (!isRecord(value.runnerProvenance)) return null;
  const status = readStatus(value.status);
  return {
    id,
    status,
    severity: readSeverity(value.severity),
    recommendation: readRecommendation(value.recommendation, status),
    summary: typeof value.summary === 'string' && value.summary.trim() !== '' ? value.summary.trim() : `${id} local review completed.`,
    blockers: readStringArray(value.blockers),
    artifacts: readArtifacts(value.artifacts),
    commands: readStringArray(value.commands),
    surfaces: readStringArray(value.surfaces),
    contextReviewed: Array.isArray(value.contextReviewed) ? value.contextReviewed.filter(isRecord).map(item => ({
      kind: typeof item.kind === 'string' ? item.kind as LocalReviewContextReviewed['kind'] : 'diff',
      source: typeof item.source === 'string' ? item.source : 'local-command',
      trust: typeof item.trust === 'string' ? item.trust as LocalReviewContextReviewed['trust'] : 'local-evidence',
      freshness: typeof item.freshness === 'string' ? item.freshness as LocalReviewContextReviewed['freshness'] : 'current',
    })) : [],
    promptStack: Array.isArray(value.promptStack) ? value.promptStack.filter(isRecord).map(item => ({
      id: typeof item.id === 'string' ? item.id : 'unknown-prompt-fragment',
      source: typeof item.source === 'string' ? item.source : 'evidence',
      sourceCategory: typeof item.sourceCategory === 'string' ? item.sourceCategory : undefined,
      path: typeof item.path === 'string' ? item.path : null,
      sha256: typeof item.sha256 === 'string' ? item.sha256 : null,
      trust: typeof item.trust === 'string' ? item.trust : 'local-evidence',
    })) : [],
    toolsUsed: readStringArray(value.toolsUsed),
    runnerProvenance: {
      runnerKind: value.runnerProvenance.runnerKind === 'local-command' || value.runnerProvenance.runnerKind === 'local-host' || value.runnerProvenance.runnerKind === 'manual-evidence' || value.runnerProvenance.runnerKind === 'prompt-only' ? value.runnerProvenance.runnerKind : 'manual-evidence',
      host: typeof value.runnerProvenance.host === 'string' ? value.runnerProvenance.host : 'unknown-host',
      freshContext: value.runnerProvenance.freshContext === true,
      promptOnly: value.runnerProvenance.promptOnly === true,
      taskId: typeof value.runnerProvenance.taskId === 'string' ? value.runnerProvenance.taskId : null,
      sessionId: typeof value.runnerProvenance.sessionId === 'string' ? value.runnerProvenance.sessionId : null,
      threadId: typeof value.runnerProvenance.threadId === 'string' ? value.runnerProvenance.threadId : null,
      promptStackHash: typeof value.runnerProvenance.promptStackHash === 'string' ? value.runnerProvenance.promptStackHash : null,
      headSha: typeof value.runnerProvenance.headSha === 'string' ? value.runnerProvenance.headSha : headSha,
      providerPublishStatus: typeof value.runnerProvenance.providerPublishStatus === 'string' ? value.runnerProvenance.providerPublishStatus : null,
    },
  };
}

function splitCommand(command: string): string[] {
  const parts: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|[^\s]+/g;
  for (const match of command.matchAll(pattern)) parts.push(match[1] ?? match[2] ?? match[0]);
  return parts;
}

async function defaultExec(args: string[], cwd?: string): Promise<PrGateExecResult> {
  const [file, ...rest] = args;
  try {
    const result = await execFileAsync(file, rest, {
      cwd,
      encoding: 'utf8',
      timeout: 600_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { args, exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    const err = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return { args, exitCode: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message ?? 'local command failed' };
  }
}

async function gitQuiet(repoRoot: string, args: readonly string[]): Promise<boolean> {
  try {
    await execFileAsync('git', [...args], { cwd: repoRoot, timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

export async function executableReviewCommandsTrusted(repoRoot: string, baseRef: string): Promise<boolean> {
  if (!await gitQuiet(repoRoot, ['rev-parse', '--is-inside-work-tree'])) return false;
  if (!existsSync(join(repoRoot, '.qube', 'aie', 'config.json'))) return false;
  if (!await gitQuiet(repoRoot, ['rev-parse', '--verify', baseRef])) return false;
  if (!await gitQuiet(repoRoot, ['diff', '--quiet', '--', '.qube/aie/config.json'])) return false;
  if (!await gitQuiet(repoRoot, ['diff', '--quiet', '--cached', '--', '.qube/aie/config.json'])) return false;
  return gitQuiet(repoRoot, ['diff', '--quiet', `${baseRef}...HEAD`, '--', '.qube/aie/config.json']);
}

function reviewBundlePath(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, lane: LocalReviewLaneId): string {
  return join(repoRoot, '.git', 'qube', 'aie', 'review-inputs', String(issueNumber), String(prNumber), safeSegment(headSha), `${lane}.json`);
}

function rawOutputPath(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, lane: LocalReviewLaneId): string {
  return join(laneEvidenceDirectory(repoRoot, issueNumber, prNumber, headSha), `${lane}.raw-output.json`);
}

function writeReviewBundle(input: {
  repoRoot: string;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  lane: LocalReviewLaneId;
  profile: LocalReviewProfile;
  runnerKind: 'local-command' | 'local-host';
  promptText: string;
  outputContract: string;
  promptFragmentIds: readonly string[];
  promptStackHash: string;
  evidencePath: string;
}): string {
  const path = reviewBundlePath(input.repoRoot, input.issueNumber, input.prNumber, input.headSha, input.lane);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    version: 1,
    issueNumber: input.issueNumber,
    prNumber: input.prNumber,
    headSha: input.headSha,
    lane: input.lane,
    profile: input.profile,
    runnerKind: input.runnerKind,
    promptStackHash: input.promptStackHash,
    promptFragmentIds: input.promptFragmentIds,
    evidencePath: input.evidencePath,
    promptText: input.promptText,
    outputContract: input.outputContract,
    recordedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  return path;
}

export async function runExternalLane(command: string, lane: LocalReviewLaneId, issueNumber: number, prNumber: number, headSha: string, profile: LocalReviewProfile, runnerKind: 'local-command' | 'local-host', expectedPromptStackHash: string, repoRoot: string, evidencePath: string, contextLines: readonly string[], exec?: PrGateExec): Promise<LaneEvidence | null> {
  const rendered = promptStack(lane, laneContextLines(lane, [issueNumber], prNumber, headSha, [evidencePath], contextLines, repoRoot));
  const bundlePath = writeReviewBundle({
    repoRoot,
    issueNumber,
    prNumber,
    headSha,
    lane,
    profile,
    runnerKind,
    promptText: rendered.text,
    outputContract: rendered.outputContract,
    promptFragmentIds: rendered.orderedFragmentIds,
    promptStackHash: expectedPromptStackHash,
    evidencePath,
  });
  const args = [...splitCommand(command), '--lane', lane, '--issue', String(issueNumber), '--pr', String(prNumber), '--head', headSha, '--profile', profile, '--runner-kind', runnerKind, '--prompt-stack-hash', expectedPromptStackHash, '--review-bundle', bundlePath];
  const result = await (exec ?? defaultExec)(args, repoRoot);
  const rawBody = {
    version: 1,
    issueNumber,
    prNumber,
    headSha,
    lane,
    runnerKind,
    args,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    recordedAt: new Date().toISOString(),
  };
  const rawBodyText = `${JSON.stringify(rawBody, null, 2)}\n`;
  const rawPath = rawOutputPath(repoRoot, issueNumber, prNumber, headSha, lane);
  mkdirSync(dirname(rawPath), { recursive: true });
  writeFileSync(rawPath, rawBodyText);
  if (result.exitCode !== 0) return null;
  try {
    const evidence = normalizeExternalLane(JSON.parse(result.stdout), lane, issueNumber, prNumber, headSha);
    if (!evidence) return null;
    const rawRelativePath = relative(repoRoot, rawPath).replace(/\\/g, '/');
    return {
      ...evidence,
      artifacts: [
        ...evidence.artifacts,
        { kind: 'json', path: rawRelativePath, sha256: hash(rawBodyText) },
      ],
    };
  } catch {
    return null;
  }
}

export function writeLane(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, profile: LocalReviewProfile, lane: LaneEvidence, adapter: 'local-command' | 'local-host'): string {
  const directory = laneEvidenceDirectory(repoRoot, issueNumber, prNumber, headSha);
  mkdirSync(directory, { recursive: true });
  const path = laneEvidencePath(repoRoot, issueNumber, prNumber, headSha, lane.id);
  const body = {
    version: 1,
    issueNumber,
    prNumber,
    headSha,
    profile,
    adapter,
    reviewer: adapter === 'local-host'
      ? { id: 'codex', name: 'Codex', adapterKind: 'local' }
      : { id: 'local-command', name: 'local-command', adapterKind: 'local' },
    lane: lane.id,
    ...lane,
    runnerProvenance: lane.runnerProvenance,
    recordedAt: new Date().toISOString(),
  };
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
  return path;
}

export function blockedLane(lane: LocalReviewLaneId, status: LocalReviewStatus, summary: string, blocker: string, command: string | null, issueNumber: number, prNumber: number, _repoRoot: string, _headSha: string, runner: 'local-command' | 'local-host'): LaneEvidence {
  return {
    id: lane,
    status,
    severity: status === 'failed' || status === 'malformed' ? 'high' : 'none',
    recommendation: status === 'pending' || status === 'missing' || status === 'stale' ? 'pending' : 'request-changes',
    summary,
    blockers: [blocker],
    artifacts: [],
    commands: command ? [command] : [],
    surfaces: ['PR'],
    contextReviewed: defaultContext(issueNumber, prNumber),
    promptStack: promptStackEvidence(lane),
    toolsUsed: runner === 'local-host' ? ['codex', 'local-host'] : ['local-command'],
    runnerProvenance: null,
  };
}
