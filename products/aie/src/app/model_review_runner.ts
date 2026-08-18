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
  progressLabel?: string;
  progressIntervalMs?: number;
  onProgress?: (progress: ModelRouteProcessProgress) => void;
}

export interface ModelRouteProcessProgress {
  phase: 'started' | 'waiting' | 'completed' | 'timed-out';
  label: string;
  elapsedMs: number;
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
  const environment = Object.fromEntries(Object.entries(source).filter(([key, value]) => value !== undefined && ROUTE_ENVIRONMENT_KEYS.has(key.toUpperCase())));
  return process.platform === 'win32' ? windowsPowerShellRouteEnvironment(environment).environment : environment;
}

export interface WindowsPowerShellRouteHealth {
  status: 'ready' | 'blocked';
  environment: NodeJS.ProcessEnv;
  removedPathEntries: string[];
  diagnostic: string | null;
}

type PathExists = (path: string) => boolean;

function unquotePathEntry(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}

function healthyPowerShellCoreDirectory(directory: string, pathExists: PathExists): boolean {
  return pathExists(join(directory, 'pwsh.exe'))
    && pathExists(join(directory, 'Modules', 'Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Management.psd1'))
    && pathExists(join(directory, 'Modules', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1'));
}

function healthyWindowsPowerShellDirectory(directory: string, pathExists: PathExists): boolean {
  return pathExists(join(directory, 'powershell.exe'))
    && pathExists(join(directory, 'Modules', 'Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Management.psd1'))
    && pathExists(join(directory, 'Modules', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1'));
}

export function windowsPowerShellRouteEnvironment(
  source: NodeJS.ProcessEnv,
  pathExists: PathExists = existsSync,
): WindowsPowerShellRouteHealth {
  const pathKey = Object.keys(source).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
  const modulePathKey = Object.keys(source).find(key => key.toUpperCase() === 'PSMODULEPATH') ?? 'PSModulePath';
  const pathEntries = String(source[pathKey] ?? '').split(';').map(unquotePathEntry).filter(Boolean);
  const removedPathEntries: string[] = [];
  const modulePaths: string[] = [];
  const keptPathEntries = pathEntries.filter(entry => {
    if (!pathExists(join(entry, 'pwsh.exe'))) return true;
    if (healthyPowerShellCoreDirectory(entry, pathExists)) {
      modulePaths.push(join(entry, 'Modules'));
      return true;
    }
    removedPathEntries.push(entry);
    return false;
  });
  const systemRoot = source.SYSTEMROOT ?? source.SystemRoot ?? source.WINDIR ?? source.WinDir;
  const windowsPowerShellDirectory = systemRoot
    ? join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')
    : null;
  const healthyFallback = windowsPowerShellDirectory !== null && healthyWindowsPowerShellDirectory(windowsPowerShellDirectory, pathExists);
  if (healthyFallback && windowsPowerShellDirectory) {
    modulePaths.push(join(windowsPowerShellDirectory, 'Modules'));
    if (!keptPathEntries.some(entry => entry.toLowerCase() === windowsPowerShellDirectory.toLowerCase())) keptPathEntries.push(windowsPowerShellDirectory);
  }
  const environment = { ...source, [pathKey]: keptPathEntries.join(';'), [modulePathKey]: [...new Set(modulePaths)].join(';') };
  if (modulePaths.length > 0) {
    return { status: 'ready', environment, removedPathEntries, diagnostic: null };
  }
  const incomplete = removedPathEntries.length > 0
    ? ' PowerShell Core is present on PATH but its built-in module directory is incomplete.'
    : '';
  return {
    status: 'blocked',
    environment,
    removedPathEntries,
    diagnostic: `No healthy PowerShell is available for the routed Windows host.${incomplete} Install a complete PowerShell distribution or restore Windows PowerShell before running review lanes.`,
  };
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
  resolveCheckoutState?: (repoRoot: string) => Promise<string>;
  runProcess?: ModelRouteProcess;
  onProgress?: (progress: ModelRouteProcessProgress) => void;
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
  const commandName = adapter.executableNames[0] ?? host;
  if (process.platform === 'win32') {
    for (const executableName of adapter.executableNames) {
      const shim = findOnPathSync(`${executableName}.cmd`);
      if (!shim) continue;
      const adapterResolved = adapter.resolveWindowsShim?.(shim);
      if (adapterResolved) return adapterResolved;
      const resolvedShim = resolveWindowsNodeShimSync(shim);
      if (resolvedShim) return resolvedShim;
      const script = adapter.windowsNodeModulesScriptPath(dirname(shim));
      if (script) {
        const node = findOnPathSync('node.exe');
        if (node && existsSync(script)) return { executable: node, prefixArgs: [script] };
      }
    }
  }
  const names = process.platform === 'win32' ? adapter.windowsExecutableNames : adapter.executableNames;
  for (const name of names) {
    const resolved = findOnPathSync(name);
    if (resolved) return resolved;
  }
  const fallback = process.platform === 'win32' ? adapter.windowsFallbackExecutablePath() : null;
  if (fallback && existsSync(fallback)) return fallback;
  throw new Error(`${host} review route is unavailable. Expose the authenticated ${commandName} CLI on PATH; QUBE does not install or authenticate model hosts.`);
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
    'Verdict consistency is validated after generation: recommendation derives from status (passed maps to approve; failed and needs-work map to request-changes; inconclusive maps to inconclusive). blockers entries, blocking-severity findings, and severity high or critical are valid only on a failed or needs-work result, which must carry severity high or critical and at least one blockers entry. A passed or inconclusive result must keep blockers empty and severity below high; name what an inconclusive result is missing in summary and completeness, never in blockers.',
    'Do not emit JSON progress, pending envelopes, or interim verdicts. Host progress is transient; emit exactly one JSON object only when the review is complete.',
    LANE_ARTIFACT_REQUIREMENT,
    'Artifact file paths must be existing repository-relative paths with no traversal. Command observations use kind "command" and a path beginning "command:". Set every artifact sha256 field to null; QUBE validates artifact paths and does not ask the model to transcribe file digests.',
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
      status: { type: 'string', enum: ['passed', 'failed', 'needs-work', 'inconclusive'] },
      severity: { type: 'string', enum: ['none', 'low', 'medium', 'high', 'critical'] },
      recommendation: { type: 'string', enum: ['approve', 'request-changes', 'inconclusive'] },
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
            sha256: { type: 'null' },
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

const STATUS_VALUES = new Set(['passed', 'failed', 'needs-work', 'inconclusive']);
const SEVERITY_VALUES = new Set(['none', 'low', 'medium', 'high', 'critical']);
const RECOMMENDATION_VALUES = new Set(['approve', 'request-changes', 'inconclusive']);
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

function strictRoutedLane(value: unknown, input: ModelReviewRunInput, provenance: LocalReviewRunnerProvenance): LaneEvidence | null {
  const required = ['issueNumber', 'prNumber', 'headSha', 'lane', 'status', 'severity', 'recommendation', 'summary', 'blockers', 'findings', 'artifacts', 'commands', 'surfaces', 'contextReviewed', 'toolsUsed', 'completeness', 'coverage', 'preconditions'];
  if (!isRecord(value) || !hasExactKeys(value, required)) return null;
  if (value.issueNumber !== input.issueNumber || value.prNumber !== input.prNumber || value.headSha !== input.headSha || value.lane !== input.lane) return null;
  // Coverage attestation: exactly one entry per expected inspection area, and the
  // attested states must be consistent with the reported findings.
  const areas = expectedCoverageAreas(input);
  let anyNotInspected = false;
  let allClear = false;
  if (!Array.isArray(value.coverage)) return null;
  const coverage = value.coverage;
  if (!coverage.every(entry => isRecord(entry)
    && hasExactKeys(entry, ['area', 'status'])
    && typeof entry.area === 'string' && areas.includes(entry.area)
    && (entry.status === 'clear' || entry.status === 'finding' || entry.status === 'not-inspected'))) return null;
  const attestedAreas = coverage.map(entry => (entry as { area: string }).area);
  if (attestedAreas.length !== areas.length || new Set(attestedAreas).size !== areas.length || !areas.every(area => attestedAreas.includes(area))) return null;
  anyNotInspected = coverage.some(entry => (entry as { status: string }).status === 'not-inspected');
  allClear = coverage.length > 0 && coverage.every(entry => (entry as { status: string }).status === 'clear');
  if (typeof value.status !== 'string' || !STATUS_VALUES.has(value.status) || typeof value.severity !== 'string' || !SEVERITY_VALUES.has(value.severity) || typeof value.recommendation !== 'string' || !RECOMMENDATION_VALUES.has(value.recommendation)) return null;
  const expectedRecommendation = value.status === 'passed'
    ? 'approve'
    : value.status === 'failed' || value.status === 'needs-work'
      ? 'request-changes'
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
  if (!Array.isArray(value.artifacts)
    || value.status !== 'inconclusive' && value.artifacts.length === 0
    || !value.artifacts.every(item => isRecord(item)
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
  if (value.findings.length > 0 && allClear) return null;
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
  return {
    executable: executablePath,
    args: [...prefixArgs, ...built.args],
    cwd: input.repoRoot,
    stdin: built.stdin,
    promptPath,
    schemaPath,
    timeoutMs: input.plan.timeoutSeconds * 1000,
    progressLabel: `${input.lane} via ${input.plan.host}`,
    onProgress: input.onProgress,
  };
}

function artifactDigestViolation(value: unknown, repoRoot: string): string | null {
  if (!isRecord(value) || !Array.isArray(value.artifacts)) return null;
  for (const artifact of value.artifacts) {
    if (!isRecord(artifact) || typeof artifact.path !== 'string' || typeof artifact.sha256 !== 'string') continue;
    if (!validArtifactDigest(repoRoot, artifact.path, artifact.sha256)) {
      return `Model review artifact "${sanitizedDiagnostic(artifact.path)}" reported an invalid digest; routed reviewers must set sha256 to null.`;
    }
  }
  return null;
}

export async function runModelRouteProcess(invocation: ModelRouteInvocation): Promise<ModelRouteProcessResult> {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const label = invocation.progressLabel ?? invocation.executable;
    const notify = (phase: ModelRouteProcessProgress['phase']): void => {
      try { invocation.onProgress?.({ phase, label, elapsedMs: Math.max(0, Date.now() - startedAt), timeoutMs: invocation.timeoutMs }); }
      catch { /* Progress reporting must never alter review execution. */ }
    };
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
    const progressTimer = setInterval(() => notify('waiting'), Math.max(250, invocation.progressIntervalMs ?? 30_000));
    progressTimer.unref();
    notify('started');
    const append = (current: string, chunk: Buffer): string => (current + chunk.toString('utf8')).slice(-MAX_OUTPUT_BYTES);
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(progressTimer);
      if (forceTimer) clearTimeout(forceTimer);
      if (forceCommandTimer) clearTimeout(forceCommandTimer);
      if (!timedOut) notify('completed');
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
      notify('timed-out');
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

function inspectionPolicyHaystack(result: ModelRouteProcessResult): string {
  const parts = [result.stderr];
  for (const line of result.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const event: unknown = JSON.parse(trimmed);
      if (isRecord(event)) {
        if (event.type === 'item.completed' && isRecord(event.item) && event.item.type === 'agent_message') continue;
        if (typeof event.text === 'string' && (typeof event.sessionId === 'string' || event.sessionId === null)) continue;
        if (
          event.type === 'item.completed'
          && isRecord(event.item)
          && event.item.type === 'command_execution'
        ) {
          if (event.item.exit_code === 0) continue;
          if (typeof event.item.aggregated_output === 'string') parts.push(event.item.aggregated_output);
          continue;
        }
        if (event.type !== 'error' && event.type !== 'turn.failed') continue;
        for (const field of ['message', 'error', 'detail'] as const) {
          if (typeof event[field] === 'string') parts.push(event[field]);
        }
        continue;
      }
    } catch {
      // Keep non-JSON host diagnostics, including command-rejection text.
    }
    parts.push(trimmed);
  }
  return parts.join('\n');
}

function inspectionPolicyBlocked(result: ModelRouteProcessResult): boolean {
  return /blocked by policy|rejected:\s*blocked/i.test(inspectionPolicyHaystack(result));
}

function failureReason(result: ModelRouteProcessResult): { reasonCode: string; error: string } {
  if (result.timedOut) return { reasonCode: 'model-route-timeout', error: 'Model review route exceeded its configured timeout and was terminated.' };
  if (inspectionPolicyBlocked(result)) {
    return {
      reasonCode: 'model-route-policy-blocked',
      error: 'The isolated host rejected a required read-only inspection command. The lane counts this as a host fault and fails over to the configured second host.',
    };
  }
  const diagnostic = sanitizedDiagnostic(result.stderr);
  if (/auth|login|credential|unauthor/i.test(result.stderr)) return { reasonCode: 'model-route-authentication', error: 'Model review route is not authenticated. Authenticate the configured host outside QUBE, then rerun.' };
  if (/model.*(?:not found|unknown|unavailable|invalid)/i.test(result.stderr)) return { reasonCode: 'model-route-model-unavailable', error: 'Configured review model is unavailable for this host. Refresh the host model list and update trusted review config.' };
  return { reasonCode: 'model-route-process-failed', error: `Model review route exited with code ${result.exitCode}.${diagnostic ? ` Diagnostic: ${diagnostic}` : ''}` };
}

export async function resolveModelReviewHead(repoRoot: string): Promise<string> {
  const result = await execFileAsync('git', ['-C', repoRoot, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  return result.stdout.trim();
}

export async function resolveModelReviewCheckoutState(repoRoot: string): Promise<string> {
  const result = await execFileAsync('git', ['-C', repoRoot, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  return createHash('sha256').update(result.stdout).digest('hex');
}

export async function runModelReview(input: ModelReviewRunInput): Promise<ModelReviewRunResult> {
  const invocationId = randomUUID();
  const prompt = buildModelReviewPrompt(input);
  let promptPath: string | null = null;
  let schemaPath: string | null = null;
  try {
    const resolveHead = input.resolveHead ?? resolveModelReviewHead;
    const resolveCheckoutState = input.resolveCheckoutState
      ?? (input.resolveHead ? async () => 'test-checkout-state' : resolveModelReviewCheckoutState);
    if (await resolveHead(input.repoRoot) !== input.headSha) return { evidence: null, reasonCode: 'model-route-checkout-mismatch', error: 'Local checkout HEAD does not match the requested pull request head.' };
    const checkoutState = await resolveCheckoutState(input.repoRoot);
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
    if (inspectionPolicyBlocked(result)) {
      return captureRawOutput(
        input,
        result,
        'model-route-policy-blocked',
        'The isolated host rejected a required read-only inspection command. The lane counts this as a host fault and fails over to the configured second host.',
      );
    }
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
    if ('transientTexts' in parsedHostOutput || 'priorTexts' in parsedHostOutput) {
      const transientTexts = parsedHostOutput.transientTexts ?? parsedHostOutput.priorTexts;
      if (!Array.isArray(transientTexts) || !transientTexts.every((text): text is string => typeof text === 'string')) {
        return captureRawOutput(input, result, 'model-route-output-envelope', 'Model review route returned invalid transient host messages.');
      }
      if (transientTexts.length >= input.plan.maxTurns) {
        return captureRawOutput(input, result, 'model-route-contract-mismatch', 'Model review route returned more transient host messages than the configured turn bound.');
      }
      for (const priorText of transientTexts) {
        let priorResult: unknown;
        try { priorResult = JSON.parse(priorText); } catch { continue; }
        if (strictRoutedLane(normalizeSchemaOptionals(priorResult), input, provenance)) {
          return captureRawOutput(input, result, 'model-route-multiple-terminal', 'Model review route returned more than one terminal result.');
        }
      }
    }
    if (await resolveHead(input.repoRoot) !== input.headSha) return { evidence: null, reasonCode: 'model-route-checkout-mismatch', error: 'Local checkout HEAD changed during isolated review execution.' };
    if (await resolveCheckoutState(input.repoRoot) !== checkoutState) return { evidence: null, reasonCode: 'model-route-checkout-mismatch', error: 'Local checkout contents changed during isolated review execution.' };
    // strictRoutedLane already rejects empty completeness, contextReviewed,
    // and artifacts for every status, so no post-validation gap check exists.
    const evidence = strictRoutedLane(normalizeSchemaOptionals(modelResult), input, provenance);
    if (!evidence) {
      if (isRecord(modelResult) && typeof modelResult.status === 'string' && !STATUS_VALUES.has(modelResult.status)) {
        return captureRawOutput(input, result, 'model-route-nonterminal-result', `Model review route ended with nonterminal status "${sanitizedDiagnostic(modelResult.status)}"; expected passed, failed, needs-work, or inconclusive.`);
      }
      const digestViolation = artifactDigestViolation(modelResult, input.repoRoot);
      if (digestViolation) return captureRawOutput(input, result, 'model-route-artifact-digest', digestViolation);
      return captureRawOutput(input, result, 'model-route-contract-mismatch', 'Model review result did not match the requested issue, pull request, head, lane, or evidence contract.');
    }
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
