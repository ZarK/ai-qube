import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { resolveExecutable } from '@tjalve/qube-core';
import type { ReviewModelEffort, ReviewModelTierId, RoutedReviewHostId } from '../core/policy.js';
import { LANE_ARTIFACT_REQUIREMENT, type LocalReviewLaneId, type LocalReviewProfile, type LocalReviewRunnerProvenance } from '../local_review_evidence.js';
import { redact } from '../redact.js';
import { laneEvidencePath, mkdirTrustedStoreSync, normalizeExternalLane, writeReviewFileGuarded, type LaneEvidence } from './local_review_runner_support.js';
import { getReviewHostAdapter, type ModelHostExecutable, type ReviewHostInvocationContext } from './review_host_adapters.js';
import { buildDeltaPromptSection, type ReviewScopeSelection } from './review_delta_scope.js';

export type { ModelHostExecutable } from './review_host_adapters.js';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const FORCE_KILL_GRACE_MS = 500;
const FORCE_KILL_COMMAND_MS = 1_000;
const ROUTE_ENVIRONMENT_KEYS = new Set([
  'APPDATA', 'CODEX_HOME', 'COMSPEC', 'HOME', 'LANG', 'LC_ALL', 'LOCALAPPDATA', 'LOGNAME',
  'PATH', 'PATHEXT', 'SHELL', 'SYSTEMROOT', 'TEMP', 'TERM', 'TMP', 'TMPDIR', 'USER',
  'USERPROFILE', 'USERNAME', 'WINDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
]);

export interface ModelReviewRoutePlan {
  host: RoutedReviewHostId;
  tier: ReviewModelTierId;
  model: string | null;
  effort: ReviewModelEffort | null;
  isolation: 'read-only';
  timeoutSeconds: number;
  maxTurns: number;
  substitution: string | null;
}

export interface ModelRouteInvocation {
  executable: string;
  args: string[];
  cwd: string;
  stdin: string | null;
  promptPath: string | null;
  schemaPath: string | null;
  timeoutMs: number;
}

export interface ModelRouteProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stdinDelivered: boolean;
}

export type ModelRouteProcess = (invocation: ModelRouteInvocation) => Promise<ModelRouteProcessResult>;

export function modelRouteEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => value !== undefined && ROUTE_ENVIRONMENT_KEYS.has(key.toUpperCase())));
}

export interface ModelReviewRunInput {
  plan: ModelReviewRoutePlan;
  repoRoot: string;
  lane: LocalReviewLaneId;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  profile: LocalReviewProfile;
  promptStackHash: string;
  promptText: string;
  promptStack: LaneEvidence['promptStack'];
  coverageAreas?: readonly string[];
  reviewScope?: ReviewScopeSelection;
  routeSource?: 'configured' | 'fallback';
  resolveExecutable?: (host: RoutedReviewHostId) => Promise<ModelHostExecutable>;
  resolveHead?: (repoRoot: string) => Promise<string>;
  runProcess?: ModelRouteProcess;
}

export function expectedCoverageAreas(input: Pick<ModelReviewRunInput, 'lane' | 'coverageAreas'>): string[] {
  return [...new Set([input.lane as string, ...(input.coverageAreas ?? [])])];
}

export interface ModelReviewRunResult {
  evidence: LaneEvidence | null;
  error: string | null;
  reasonCode: string | null;
}

function sanitizedDiagnostic(value: string): string {
  return redact(value).trim().slice(0, 600);
}

function findOnPathSync(name: string): string | null {
  return resolveExecutable(name).resolvedPath;
}

async function findOnPath(name: string): Promise<string | null> {
  return findOnPathSync(name);
}

export function resolveWindowsNodeShimSync(shim: string): ModelHostExecutable | null {
  let contents: string;
  try {
    contents = readFileSync(shim, 'utf8');
  } catch {
    return null;
  }
  const scriptMatch = contents.match(/%dp0%[\\/]([^"\r\n]*?\.js)/i);
  if (!scriptMatch) return null;
  const script = resolve(dirname(shim), scriptMatch[1].replace(/[\\/]/g, process.platform === 'win32' ? '\\' : '/'));
  const scriptRelative = relative(dirname(shim), script);
  if (scriptRelative === '..' || scriptRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(scriptRelative)) return null;
  const adjacentNode = join(dirname(shim), 'node.exe');
  const node = existsSync(adjacentNode) ? adjacentNode : findOnPathSync(process.platform === 'win32' ? 'node.exe' : 'node');
  return node && existsSync(script) ? { executable: node, prefixArgs: [script] } : null;
}

export async function resolveWindowsNodeShim(shim: string): Promise<ModelHostExecutable | null> {
  return resolveWindowsNodeShimSync(shim);
}

// Probe and execution must resolve hosts identically; both paths share this
// synchronous core so a probe verdict always reflects the executable that
// routed execution would actually spawn.
export function resolveModelHostExecutableSync(host: RoutedReviewHostId): ModelHostExecutable {
  const adapter = getReviewHostAdapter(host);
  if (process.platform === 'win32') {
    const shim = findOnPathSync(`${host}.cmd`);
    if (shim) {
      const resolvedShim = resolveWindowsNodeShimSync(shim);
      if (resolvedShim) return resolvedShim;
      const script = adapter.windowsNodeModulesScriptPath(dirname(shim));
      if (script) {
        const node = findOnPathSync('node.exe');
        if (node && existsSync(script)) return { executable: node, prefixArgs: [script] };
      }
    }
  }
  const names = process.platform === 'win32' ? adapter.windowsExecutableNames : [host];
  for (const name of names) {
    const resolved = findOnPathSync(name);
    if (resolved) return resolved;
  }
  const fallback = process.platform === 'win32' ? adapter.windowsFallbackExecutablePath() : null;
  if (fallback && existsSync(fallback)) return fallback;
  throw new Error(`${host} review route is unavailable. Expose the authenticated ${host} CLI on PATH; QUBE does not install or authenticate model hosts.`);
}

export async function resolveModelHostExecutable(host: RoutedReviewHostId): Promise<ModelHostExecutable> {
  return resolveModelHostExecutableSync(host);
}

function reviewResultContract(input: ModelReviewRunInput): string {
  const areas = expectedCoverageAreas(input);
  return [
    'Return exactly one JSON object and no Markdown or commentary.',
    `The object must contain issueNumber ${input.issueNumber}, prNumber ${input.prNumber}, headSha "${input.headSha}", lane "${input.lane}", status, severity, recommendation, summary, blockers, findings, artifacts, commands, surfaces, contextReviewed, toolsUsed, completeness, coverage, and preconditions.`,
    `Attest coverage for exactly these areas: ${areas.join(', ')}. Each coverage entry is {"area":"...","status":"clear"|"finding"|"not-inspected"} with one entry per area. Use "finding" for every area where you report findings, "clear" only after genuinely inspecting the area's complete scope at this head, and "not-inspected" whenever you ran out of capacity — a "not-inspected" attestation makes the lane inconclusive instead of approved, and a false "clear" is a contract violation. Establish your findings before attesting.`,
    'Blocker admissibility: a blocking finding must either name a violated acceptance criterion of the active issue with a concrete failing scenario, or demonstrate a correctness or security defect introduced by this diff with a concrete input and wrong outcome. Findings on pre-existing code adjacent to the diff, architecture preferences, and speculative hardening are advisory at most. Favor passed once the diff definitely improves the system and satisfies its acceptance criteria; a diff does not need to be perfect.',
    'Finding locations must prefer a tight destination-side span: set line to the first changed statement and endLine to at most line+9. Wider evidence belongs in the message, not in a 10-plus-line selection. When a safe one-hunk replacement exists, set suggestion to the exact replacement text for those anchored lines only, with the same line count as line..endLine. Set suggestion to null when the fix is prose, spans files, or cannot replace the anchored lines exactly. Never put English instructions in suggestion.',
    'When provider-visible lane feedback shows this lane already reviewed this pull request in an earlier round, verify whether the previously reported blockers are fixed and whether those fixes introduced new defects; do not re-open the full review surface or raise new blockers outside that fix delta.',
    'Verdict consistency is validated after generation: recommendation derives from status (passed maps to approve; failed and needs-work map to request-changes; pending, missing, and stale map to pending; inconclusive maps to inconclusive). blockers entries, blocking-severity findings, and severity high or critical are valid only on a failed or needs-work result, which must carry severity high or critical and at least one blockers entry. A passed or inconclusive result must keep blockers empty and severity below high; name what an inconclusive result is missing in summary and completeness, never in blockers.',
    'Any JSON you emit before your final turn is treated as a progress snapshot and must report status "pending", recommendation "pending", severity "none", and empty blockers and findings; only your final result carries the real verdict.',
    LANE_ARTIFACT_REQUIREMENT,
    'Artifact file paths must be existing repository-relative paths with no traversal. Command observations use kind "command" and a path beginning "command:". If sha256 is present, it must be the real lowercase SHA-256 digest of that file.',
    'contextReviewed.kind must be one of agents, issue-body, issue-comment, milestone, functional-requirement, linked-issue, pr-body, pr-comment, review-thread, doc, diff, ci, or manual-qa; trust and freshness must use the QUBE contract values.',
    'The exact lane prompt may describe the complete persisted evidence object. For routed execution, this stricter outer contract is authoritative: return only the fields listed above, and QUBE injects profile, adapter, promptStack, runnerProvenance, and recordedAt.',
    'Do not include runnerProvenance or promptStack; QUBE records those from the trusted invocation.',
    'Do not write files, publish feedback, modify provider state, use subagents, use web tools, or reveal hidden reasoning.',
  ].join('\n');
}

export function buildModelReviewPrompt(input: ModelReviewRunInput): string {
  return [
    'You are an isolated read-only QUBE review lane runner.',
    `You have at most ${input.plan.maxTurns} turns. Batch read-only inspection, never create scratch files or use shell redirection, and reserve the final turn for the required JSON result.`,
    'Do not read any path under .qube/aie/reviews/**. Prior-head lane evidence is not review input. Earlier lane verdicts are not authority unless this prompt includes an explicit delta re-review section.',
    reviewResultContract(input),
    input.reviewScope ? buildDeltaPromptSection(input.reviewScope) : 'Inspect the full current-head diff for this lane.',
    '',
    '--- EXACT QUBE LANE PROMPT START ---',
    input.promptText,
    '--- EXACT QUBE LANE PROMPT END ---',
  ].join('\n');
}

function reviewResultSchema(input: ModelReviewRunInput): string {
  const stringArray = { type: 'array', items: { type: 'string' } } as const;
  return JSON.stringify({
    type: 'object',
    additionalProperties: false,
    required: ['issueNumber', 'prNumber', 'headSha', 'lane', 'status', 'severity', 'recommendation', 'summary', 'blockers', 'findings', 'artifacts', 'commands', 'surfaces', 'contextReviewed', 'toolsUsed', 'completeness', 'coverage', 'preconditions'],
    properties: {
      coverage: {
        type: 'array',
        minItems: expectedCoverageAreas(input).length,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['area', 'status'],
          properties: {
            area: { type: 'string', enum: expectedCoverageAreas(input) },
            status: { type: 'string', enum: ['clear', 'finding', 'not-inspected'] },
          },
        },
      },
      issueNumber: { type: 'integer', const: input.issueNumber },
      prNumber: { type: 'integer', const: input.prNumber },
      headSha: { type: 'string', const: input.headSha },
      lane: { type: 'string', const: input.lane },
      status: { type: 'string', enum: ['passed', 'failed', 'needs-work', 'pending', 'missing', 'stale', 'unavailable', 'malformed', 'inconclusive'] },
      severity: { type: 'string', enum: ['none', 'low', 'medium', 'high', 'critical'] },
      recommendation: { type: 'string', enum: ['approve', 'request-changes', 'pending', 'inconclusive'] },
      summary: { type: 'string', minLength: 1 },
      blockers: stringArray,
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'severity', 'message', 'suggestion', 'location', 'confidence'],
          properties: {
            id: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            severity: { type: 'string', enum: ['blocking', 'advisory'] },
            message: { type: 'string', minLength: 1 },
            suggestion: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            confidence: { anyOf: [{ type: 'number', minimum: 0, maximum: 1 }, { type: 'null' }] },
            location: {
              anyOf: [{ type: 'null' }, {
                type: 'object',
                additionalProperties: false,
                required: ['path', 'line', 'endLine', 'side'],
                properties: {
                  path: { type: 'string', minLength: 1 },
                  line: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
                  endLine: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
                  side: { anyOf: [{ type: 'string', enum: ['source', 'destination'] }, { type: 'null' }] },
                },
              }],
            },
          },
        },
      },
      artifacts: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'path', 'sha256'],
          properties: {
            kind: { type: 'string', minLength: 1 },
            path: { type: 'string', minLength: 1 },
            sha256: { anyOf: [{ type: 'string', pattern: '^[a-fA-F0-9]{64}$' }, { type: 'null' }] },
          },
        },
      },
      commands: stringArray,
      surfaces: stringArray,
      contextReviewed: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'source', 'trust', 'freshness'],
          properties: {
            kind: { type: 'string', enum: [...CONTEXT_KIND_VALUES] },
            source: { type: 'string' },
            trust: { type: 'string', enum: [...CONTEXT_TRUST_VALUES] },
            freshness: { type: 'string', enum: [...CONTEXT_FRESHNESS_VALUES] },
          },
        },
      },
      toolsUsed: stringArray,
      completeness: { type: 'string', minLength: 1 },
      preconditions: stringArray,
    },
  });
}

const STATUS_VALUES = new Set(['passed', 'failed', 'needs-work', 'pending', 'missing', 'stale', 'unavailable', 'malformed', 'inconclusive']);
const SEVERITY_VALUES = new Set(['none', 'low', 'medium', 'high', 'critical']);
const RECOMMENDATION_VALUES = new Set(['approve', 'request-changes', 'pending', 'inconclusive']);
const FINDING_SEVERITY_VALUES = new Set(['blocking', 'advisory']);
const CONTEXT_KIND_VALUES = new Set(['agents', 'issue-body', 'issue-comment', 'milestone', 'functional-requirement', 'linked-issue', 'pr-body', 'pr-comment', 'review-thread', 'doc', 'diff', 'ci', 'manual-qa']);
const CONTEXT_TRUST_VALUES = new Set(['policy', 'trusted-provider', 'repo-doc', 'untrusted-task-input', 'local-evidence']);
const CONTEXT_FRESHNESS_VALUES = new Set(['current', 'stale', 'unknown', 'missing', 'unavailable', 'not-configured']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => allowed.has(key));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function safeArtifactPath(repoRoot: string, kind: string, path: string): boolean {
  if (path.trim() === '' || path.includes('\0')) return false;
  // The shared lane artifact contract accepts exactly one non-file shape:
  // kind "command" with a "command:" path. Routed acceptance holds the same
  // line so model evidence can never pass here and then fail gate or publish.
  if (/^(command|terminal|test-output):/i.test(path)) return path.startsWith('command:') && kind === 'command';
  if (isAbsolute(path)) return false;
  try {
    const resolvedRoot = realpathSync(repoRoot);
    const resolvedPath = realpathSync(resolve(repoRoot, path));
    const relativePath = relative(resolvedRoot, resolvedPath);
    return relativePath !== ''
      && relativePath !== '..'
      && !relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
      && !isAbsolute(relativePath)
      && statSync(resolvedPath).isFile();
  } catch {
    return false;
  }
}

function validArtifactDigest(repoRoot: string, path: string, sha256: unknown): boolean {
  if (sha256 === null) return true;
  // Lowercase-only, matching laneArtifactViolation: a digest the gate and
  // publish validators would reject must not be accepted at the routed layer.
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256) || path.startsWith('command:')) return false;
  try {
    return createHash('sha256').update(readFileSync(resolve(repoRoot, path))).digest('hex') === sha256;
  } catch {
    return false;
  }
}

function strictRoutedLane(value: unknown, input: ModelReviewRunInput, provenance: LocalReviewRunnerProvenance, mode: 'final' | 'interim' = 'final'): LaneEvidence | null {
  // Coverage attestation is a final-result contract: schema-constrained hosts must
  // attest the final object, while free-form interim progress snapshots may omit it.
  const required = ['issueNumber', 'prNumber', 'headSha', 'lane', 'status', 'severity', 'recommendation', 'summary', 'blockers', 'findings', 'artifacts', 'commands', 'surfaces', 'contextReviewed', 'toolsUsed', 'completeness', 'preconditions', ...(mode === 'final' ? ['coverage'] : [])];
  if (!isRecord(value) || !hasExactKeys(value, required, mode === 'interim' ? ['coverage'] : undefined)) return null;
  if (value.issueNumber !== input.issueNumber || value.prNumber !== input.prNumber || value.headSha !== input.headSha || value.lane !== input.lane) return null;
  // Coverage attestation: exactly one entry per expected inspection area, and the
  // attested states must be consistent with the reported findings.
  const areas = expectedCoverageAreas(input);
  let anyNotInspected = false;
  let allClear = false;
  // Interim snapshots are free-form model emissions: coverage is neither required
  // nor validated there, so partial or freeform interim attestations cannot fail
  // the run. Only the schema-constrained final result is bound to the contract.
  if (mode === 'final') {
    if (!Array.isArray(value.coverage)) return null;
    const coverage = value.coverage;
    if (!coverage.every(entry => isRecord(entry)
      && hasExactKeys(entry, ['area', 'status'])
      && typeof entry.area === 'string' && areas.includes(entry.area)
      && (entry.status === 'clear' || entry.status === 'finding' || entry.status === 'not-inspected'))) return null;
    if (mode === 'final') {
      const attestedAreas = coverage.map(entry => (entry as { area: string }).area);
      if (attestedAreas.length !== areas.length || new Set(attestedAreas).size !== areas.length || !areas.every(area => attestedAreas.includes(area))) return null;
    }
    anyNotInspected = coverage.some(entry => (entry as { status: string }).status === 'not-inspected');
    allClear = coverage.length > 0 && coverage.every(entry => (entry as { status: string }).status === 'clear');
  }
  if (typeof value.status !== 'string' || !STATUS_VALUES.has(value.status) || typeof value.severity !== 'string' || !SEVERITY_VALUES.has(value.severity) || typeof value.recommendation !== 'string' || !RECOMMENDATION_VALUES.has(value.recommendation)) return null;
  const expectedRecommendation = value.status === 'passed'
    ? 'approve'
    : value.status === 'failed' || value.status === 'needs-work'
      ? 'request-changes'
      : value.status === 'pending' || value.status === 'missing' || value.status === 'stale'
        ? 'pending'
        : 'inconclusive';
  if (value.recommendation !== expectedRecommendation) return null;
  if (typeof value.summary !== 'string' || value.summary.trim() === '' || typeof value.completeness !== 'string' || value.completeness.trim() === '') return null;
  if (!isStringArray(value.blockers) || !isStringArray(value.commands) || !isStringArray(value.surfaces) || !isStringArray(value.toolsUsed) || !isStringArray(value.preconditions)) return null;
  if (!Array.isArray(value.findings) || !value.findings.every(item => isRecord(item)
    && hasExactKeys(item, ['severity', 'message'], ['id', 'suggestion', 'location', 'confidence'])
    && typeof item.severity === 'string' && FINDING_SEVERITY_VALUES.has(item.severity)
    && typeof item.message === 'string' && item.message.trim() !== ''
    && (item.id === undefined || typeof item.id === 'string')
    && (item.suggestion === undefined || typeof item.suggestion === 'string')
    && (item.confidence === undefined || (typeof item.confidence === 'number' && Number.isFinite(item.confidence) && item.confidence >= 0 && item.confidence <= 1))
    && (item.location === undefined || (isRecord(item.location)
      && hasExactKeys(item.location, ['path'], ['line', 'endLine', 'side'])
      && typeof item.location.path === 'string' && item.location.path.trim() !== ''
      && (item.location.line === undefined || (Number.isSafeInteger(item.location.line) && Number(item.location.line) > 0))
      && (item.location.endLine === undefined || (Number.isSafeInteger(item.location.endLine) && Number(item.location.endLine) > 0))
      && (item.location.side === undefined || item.location.side === 'source' || item.location.side === 'destination'))))) return null;
  const hasBlockingFinding = value.findings.some(item => isRecord(item) && item.severity === 'blocking');
  const requestsChanges = value.status === 'failed' || value.status === 'needs-work';
  const hasBlockingVerdict = hasBlockingFinding
    || value.blockers.length > 0
    || value.severity === 'high'
    || value.severity === 'critical';
  if (hasBlockingVerdict && (!requestsChanges
    || value.recommendation !== 'request-changes'
    || value.severity !== 'high' && value.severity !== 'critical'
    || value.blockers.length === 0)) return null;
  if (requestsChanges && (value.blockers.length === 0
    || value.severity !== 'high' && value.severity !== 'critical')) return null;
  if (!Array.isArray(value.artifacts) || value.artifacts.length === 0 || !value.artifacts.every(item => isRecord(item)
    && hasExactKeys(item, ['kind', 'path', 'sha256'])
    && typeof item.kind === 'string' && item.kind.trim() !== ''
    && typeof item.path === 'string' && safeArtifactPath(input.repoRoot, item.kind, item.path)
    && validArtifactDigest(input.repoRoot, item.path, item.sha256))) return null;
  if (!Array.isArray(value.contextReviewed) || value.contextReviewed.length === 0 || !value.contextReviewed.every(item => isRecord(item)
    && hasExactKeys(item, ['kind', 'source', 'trust', 'freshness'])
    && typeof item.kind === 'string' && CONTEXT_KIND_VALUES.has(item.kind)
    && typeof item.source === 'string' && item.source.trim() !== ''
    && typeof item.trust === 'string' && CONTEXT_TRUST_VALUES.has(item.trust)
    && typeof item.freshness === 'string' && CONTEXT_FRESHNESS_VALUES.has(item.freshness))) return null;
  if (mode === 'final' && Array.isArray(value.findings) && value.findings.length > 0 && allClear) return null;
  const candidate: Record<string, unknown> = { ...value, promptStack: input.promptStack, runnerProvenance: provenance };
  delete candidate.coverage;
  if (anyNotInspected && candidate.status === 'passed') {
    // An unfinished inspection can never approve; fail closed to inconclusive so
    // the gate reruns the lane instead of accepting a partial pass.
    candidate.status = 'inconclusive';
    candidate.recommendation = 'inconclusive';
  }
  return normalizeExternalLane(candidate, input.lane, input.issueNumber, input.prNumber, input.headSha);
}

function normalizeSchemaOptionals(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.findings)) return value;
  return {
    ...value,
    findings: value.findings.map(finding => {
      if (!isRecord(finding)) return finding;
      const normalized = { ...finding };
      if (normalized.id === null) delete normalized.id;
      if (normalized.suggestion === null) delete normalized.suggestion;
      if (normalized.confidence === null) delete normalized.confidence;
      if (normalized.location === null) delete normalized.location;
      else if (isRecord(normalized.location)) {
        const location = { ...normalized.location };
        if (location.line === null) delete location.line;
        if (location.endLine === null) delete location.endLine;
        if (location.side === null) delete location.side;
        normalized.location = location;
      }
      return normalized;
    }),
  };
}

export function buildModelRouteInvocation(input: ModelReviewRunInput, executable: ModelHostExecutable, prompt: string, promptPath: string | null, schemaPath: string | null = null): ModelRouteInvocation {
  const adapter = getReviewHostAdapter(input.plan.host);
  const executablePath = typeof executable === 'string' ? executable : executable.executable;
  const prefixArgs = typeof executable === 'string' ? [] : [...executable.prefixArgs];
  const context: ReviewHostInvocationContext = {
    repoRoot: input.repoRoot,
    model: input.plan.model,
    effort: input.plan.effort,
    maxTurns: input.plan.maxTurns,
    prompt,
    promptPath,
    schemaPath,
    schemaJson: reviewResultSchema(input),
  };
  const built = adapter.buildInvocation(context, executable);
  return { executable: executablePath, args: [...prefixArgs, ...built.args], cwd: input.repoRoot, stdin: built.stdin, promptPath, schemaPath, timeoutMs: input.plan.timeoutSeconds * 1000 };
}

export async function runModelRouteProcess(invocation: ModelRouteInvocation): Promise<ModelRouteProcessResult> {
  return new Promise(resolve => {
    const child = spawn(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      detached: process.platform !== 'win32',
      env: modelRouteEnvironment(),
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let stdinDelivered = false;
    let stdinFailed = false;
    let settled = false;
    let forceTimer: NodeJS.Timeout | null = null;
    let forceCommandTimer: NodeJS.Timeout | null = null;
    const append = (current: string, chunk: Buffer): string => (current + chunk.toString('utf8')).slice(-MAX_OUTPUT_BYTES);
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (forceCommandTimer) clearTimeout(forceCommandTimer);
      resolve({ exitCode: typeof code === 'number' ? code : 1, stdout, stderr, timedOut, stdinDelivered });
    };
    const killPosixGroup = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); }
      catch {
        try { child.kill(signal); } catch { /* process already exited */ }
      }
    };
    const forceKill = (): void => {
      if (process.platform !== 'win32' || !child.pid) {
        killPosixGroup('SIGKILL');
        finish(1);
        return;
      }
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        shell: false,
        stdio: 'ignore',
      });
      const finishKill = (): void => {
        try { child.kill('SIGKILL'); } catch { /* process already exited */ }
        finish(1);
      };
      killer.once('error', finishKill);
      killer.once('close', finishKill);
      killer.unref();
      forceCommandTimer = setTimeout(() => {
        try { killer.kill(); } catch { /* taskkill already exited */ }
        finishKill();
      }, FORCE_KILL_COMMAND_MS);
    };
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    child.stdin.on('error', error => { stdinFailed = true; stdinDelivered = false; stderr = `${stderr}\n${error.message}`; });
    child.on('error', error => { stderr = `${stderr}\n${error.message}`; });
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform !== 'win32') killPosixGroup('SIGTERM');
      forceTimer = setTimeout(forceKill, FORCE_KILL_GRACE_MS);
    }, invocation.timeoutMs);
    child.on('close', finish);
    if (invocation.stdin !== null) child.stdin.end(invocation.stdin, 'utf8', () => { stdinDelivered = !stdinFailed; });
    else child.stdin.end(() => { stdinDelivered = !stdinFailed; });
  });
}

export function isolatedRawOutputPath(
  repoRoot: string,
  issueNumber: number,
  prNumber: number,
  headSha: string,
  lane: LocalReviewLaneId,
): string {
  return join(dirname(laneEvidencePath(repoRoot, issueNumber, prNumber, headSha, lane)), `${lane}.raw-output.json`);
}

function captureRawOutput(
  input: ModelReviewRunInput,
  result: ModelRouteProcessResult | null,
  reasonCode: string,
  error: string,
): ModelReviewRunResult {
  if (!result) return { evidence: null, reasonCode, error };
  try {
    const path = isolatedRawOutputPath(input.repoRoot, input.issueNumber, input.prNumber, input.headSha, input.lane);
    mkdirTrustedStoreSync(dirname(path), { repoRoot: input.repoRoot, subtree: ['.qube', 'aie', 'reviews'] });
    writeReviewFileGuarded(path, `${JSON.stringify({
      version: 1,
      issueNumber: input.issueNumber,
      prNumber: input.prNumber,
      headSha: input.headSha,
      lane: input.lane,
      host: input.plan.host,
      reasonCode,
      stdout: redact(result.stdout).slice(0, MAX_OUTPUT_BYTES),
      stderr: redact(result.stderr).slice(0, MAX_OUTPUT_BYTES),
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      recordedAt: new Date().toISOString(),
    }, null, 2)}\n`, { repoRoot: input.repoRoot, subtree: ['.qube', 'aie', 'reviews'] });
    const relativePath = relative(input.repoRoot, path).replace(/\\/g, '/');
    return { evidence: null, reasonCode, error: `${error} Raw output: ${relativePath}.` };
  } catch {
    return { evidence: null, reasonCode, error };
  }
}

function failureReason(result: ModelRouteProcessResult): { reasonCode: string; error: string } {
  if (result.timedOut) return { reasonCode: 'model-route-timeout', error: 'Model review route exceeded its configured timeout and was terminated.' };
  const diagnostic = sanitizedDiagnostic(result.stderr);
  if (/auth|login|credential|unauthor/i.test(result.stderr)) return { reasonCode: 'model-route-authentication', error: 'Model review route is not authenticated. Authenticate the configured host outside QUBE, then rerun.' };
  if (/model.*(?:not found|unknown|unavailable|invalid)/i.test(result.stderr)) return { reasonCode: 'model-route-model-unavailable', error: 'Configured review model is unavailable for this host. Refresh the host model list and update trusted review config.' };
  return { reasonCode: 'model-route-process-failed', error: `Model review route exited with code ${result.exitCode}.${diagnostic ? ` Diagnostic: ${diagnostic}` : ''}` };
}

export async function resolveModelReviewHead(repoRoot: string): Promise<string> {
  const result = await execFileAsync('git', ['-C', repoRoot, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  return result.stdout.trim();
}

export async function runModelReview(input: ModelReviewRunInput): Promise<ModelReviewRunResult> {
  const invocationId = randomUUID();
  const prompt = buildModelReviewPrompt(input);
  let promptPath: string | null = null;
  let schemaPath: string | null = null;
  try {
    const resolveHead = input.resolveHead ?? resolveModelReviewHead;
    if (await resolveHead(input.repoRoot) !== input.headSha) return { evidence: null, reasonCode: 'model-route-checkout-mismatch', error: 'Local checkout HEAD does not match the requested pull request head.' };
    const adapter = getReviewHostAdapter(input.plan.host);
    const executable = await (input.resolveExecutable ?? resolveModelHostExecutable)(input.plan.host);
    const routeDirectory = join(input.repoRoot, '.git', 'qube', 'aie', 'model-route');
    mkdirSync(routeDirectory, { recursive: true });
    if (adapter.requiresPromptFile) {
      promptPath = join(routeDirectory, `${invocationId}.prompt`);
      writeFileSync(promptPath, prompt, { encoding: 'utf8', mode: 0o600 });
    }
    if (adapter.requiresSchemaFile) {
      schemaPath = join(routeDirectory, `${invocationId}.schema.json`);
      writeFileSync(schemaPath, reviewResultSchema(input), { encoding: 'utf8', mode: 0o600 });
    }
    const invocation = buildModelRouteInvocation(input, executable, prompt, promptPath, schemaPath);
    const result = await (input.runProcess ?? runModelRouteProcess)(invocation);
    if (result.exitCode !== 0 || result.timedOut) {
      const failure = failureReason(result);
      return captureRawOutput(input, result, failure.reasonCode, failure.error);
    }
    if (!result.stdinDelivered) return captureRawOutput(input, result, 'model-route-prompt-delivery', 'Model review route did not confirm complete prompt delivery.');
    const parsedHostOutput = adapter.parseEnvelope(result.stdout);
    if (!parsedHostOutput) return captureRawOutput(input, result, 'model-route-output-envelope', 'Model review route returned no supported final-response envelope.');
    let modelResult: unknown;
    try { modelResult = JSON.parse(parsedHostOutput.text); } catch {
      return captureRawOutput(input, result, 'model-route-malformed-json', 'Model review route final response was not exactly one JSON object.');
    }
    const provenance: LocalReviewRunnerProvenance = {
      runnerKind: 'local-host',
      host: input.plan.host,
      freshContext: true,
      promptOnly: false,
      taskId: invocationId,
      sessionId: parsedHostOutput.sessionId,
      threadId: null,
      promptStackHash: input.promptStackHash,
      headSha: input.headSha,
      providerPublishStatus: null,
      model: input.plan.model,
      effort: input.plan.effort,
      isolation: 'read-only',
      invocationId,
      routeSource: input.routeSource ?? 'configured',
    };
    if ('priorTexts' in parsedHostOutput) {
      const priorTexts = parsedHostOutput.priorTexts;
      if (!Array.isArray(priorTexts) || !priorTexts.every((text): text is string => typeof text === 'string')) {
        return captureRawOutput(input, result, 'model-route-output-envelope', 'Grok review route returned an invalid structured snapshot envelope.');
      }
      if (priorTexts.length >= input.plan.maxTurns) {
        return captureRawOutput(input, result, 'model-route-contract-mismatch', 'Grok review route returned more structured snapshots than the configured turn bound.');
      }
      for (const priorText of priorTexts) {
        let priorResult: unknown;
        try { priorResult = JSON.parse(priorText); } catch {
          return captureRawOutput(input, result, 'model-route-malformed-json', 'Grok review route returned a malformed structured progress snapshot.');
        }
        const priorEvidence = strictRoutedLane(normalizeSchemaOptionals(priorResult), input, provenance, 'interim');
        if (!priorEvidence
          || priorEvidence.status !== 'pending'
          || priorEvidence.recommendation !== 'pending'
          || priorEvidence.severity !== 'none'
          || priorEvidence.blockers.length > 0
          || priorEvidence.findings.length > 0) {
          return captureRawOutput(input, result, 'model-route-contract-mismatch', 'Grok review route returned a contradictory or non-pending progress snapshot before its final result.');
        }
      }
    }
    if (await resolveHead(input.repoRoot) !== input.headSha) return { evidence: null, reasonCode: 'model-route-checkout-mismatch', error: 'Local checkout HEAD changed during isolated review execution.' };
    // strictRoutedLane already rejects empty completeness, contextReviewed,
    // and artifacts for every status, so no post-validation gap check exists.
    const evidence = strictRoutedLane(normalizeSchemaOptionals(modelResult), input, provenance);
    if (!evidence) return captureRawOutput(input, result, 'model-route-contract-mismatch', 'Model review result did not match the requested issue, pull request, head, lane, or evidence contract.');
    return {
      evidence: {
        ...evidence,
        modelTier: input.plan.tier,
        ...(parsedHostOutput.usage ? { usage: parsedHostOutput.usage } : {}),
      },
      reasonCode: null,
      error: null,
    };
  } catch (error: unknown) {
    return { evidence: null, reasonCode: 'model-route-unavailable', error: sanitizedDiagnostic(error instanceof Error ? error.message : String(error)) };
  } finally {
    if (promptPath) rmSync(promptPath, { force: true });
    if (schemaPath) rmSync(schemaPath, { force: true });
  }
}
