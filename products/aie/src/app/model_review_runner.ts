import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import type { ReviewModelEffort, ReviewModelTierId, RoutedReviewHostId } from '../core/policy.js';
import type { LocalReviewLaneId, LocalReviewProfile, LocalReviewRunnerProvenance } from '../local_review_evidence.js';
import { normalizeExternalLane, type LaneEvidence } from './local_review_runner_support.js';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

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

export type ModelHostExecutable = string | { executable: string; prefixArgs: string[] };

export interface ModelRouteProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stdinDelivered: boolean;
}

export type ModelRouteProcess = (invocation: ModelRouteInvocation) => Promise<ModelRouteProcessResult>;

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
  resolveExecutable?: (host: RoutedReviewHostId) => Promise<ModelHostExecutable>;
  resolveHead?: (repoRoot: string) => Promise<string>;
  runProcess?: ModelRouteProcess;
}

export interface ModelReviewRunResult {
  evidence: LaneEvidence | null;
  error: string | null;
  reasonCode: string | null;
}

function sanitizedDiagnostic(value: string): string {
  return value
    .replace(/\b(?:gh[pousr]_|github_pat_|ghs_|glpat-|sk-)[A-Za-z0-9_-]+\b/giu, '[REDACTED]')
    .replace(/[A-Za-z0-9_\-]{40,}/g, '[REDACTED]')
    .trim()
    .slice(0, 600);
}

async function findOnPath(name: string): Promise<string | null> {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const result = await execFileAsync(locator, [name], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    return result.stdout.split(/\r?\n/).map(line => line.trim()).find(line => line !== '') ?? null;
  } catch {
    return null;
  }
}

export async function resolveWindowsNodeShim(shim: string): Promise<ModelHostExecutable | null> {
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
  const node = existsSync(adjacentNode) ? adjacentNode : await findOnPath(process.platform === 'win32' ? 'node.exe' : 'node');
  return node && existsSync(script) ? { executable: node, prefixArgs: [script] } : null;
}

export async function resolveModelHostExecutable(host: RoutedReviewHostId): Promise<ModelHostExecutable> {
  if (process.platform === 'win32') {
    const shim = await findOnPath(`${host}.cmd`);
    if (shim) {
      const resolvedShim = await resolveWindowsNodeShim(shim);
      if (resolvedShim) return resolvedShim;
      if (host === 'codex') {
        const script = join(dirname(shim), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
        const node = await findOnPath('node.exe');
        if (node && existsSync(script)) return { executable: node, prefixArgs: [script] };
      }
    }
  }
  const names = process.platform === 'win32'
    ? host === 'codex' ? ['codex.exe'] : ['grok.exe']
    : [host];
  for (const name of names) {
    const resolved = await findOnPath(name);
    if (resolved) return resolved;
  }
  const fallback = process.platform === 'win32' && host === 'grok' ? join(homedir(), '.grok', 'bin', 'grok.exe') : null;
  if (fallback && existsSync(fallback)) return fallback;
  throw new Error(`${host} review route is unavailable. Expose the authenticated ${host} CLI on PATH; QUBE does not install or authenticate model hosts.`);
}

function reviewResultContract(input: ModelReviewRunInput): string {
  return [
    'Return exactly one JSON object and no Markdown or commentary.',
    `The object must contain issueNumber ${input.issueNumber}, prNumber ${input.prNumber}, headSha "${input.headSha}", lane "${input.lane}", status, severity, recommendation, summary, blockers, findings, artifacts, commands, surfaces, contextReviewed, toolsUsed, completeness, and preconditions.`,
    'Every artifact must identify a real repository source, test, command result, or other inspected surface using {"kind":"...","path":"...","sha256":null}.',
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
    reviewResultContract(input),
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
    required: ['issueNumber', 'prNumber', 'headSha', 'lane', 'status', 'severity', 'recommendation', 'summary', 'blockers', 'findings', 'artifacts', 'commands', 'surfaces', 'contextReviewed', 'toolsUsed', 'completeness', 'preconditions'],
    properties: {
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
          required: ['id', 'severity', 'message', 'suggestion', 'location'],
          properties: {
            id: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            severity: { type: 'string', enum: ['blocking', 'advisory'] },
            message: { type: 'string', minLength: 1 },
            suggestion: { anyOf: [{ type: 'string' }, { type: 'null' }] },
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
  if (/^(command|terminal|test-output):/i.test(path)) return /command|terminal|test/i.test(kind);
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
  if (sha256 === null || sha256 === undefined) return true;
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256) || /^(command|terminal|test-output):/i.test(path)) return false;
  try {
    return createHash('sha256').update(readFileSync(resolve(repoRoot, path))).digest('hex') === sha256.toLowerCase();
  } catch {
    return false;
  }
}

function strictRoutedLane(value: unknown, input: ModelReviewRunInput, provenance: LocalReviewRunnerProvenance): LaneEvidence | null {
  const required = ['issueNumber', 'prNumber', 'headSha', 'lane', 'status', 'severity', 'recommendation', 'summary', 'blockers', 'findings', 'artifacts', 'commands', 'surfaces', 'contextReviewed', 'toolsUsed', 'completeness', 'preconditions'];
  if (!isRecord(value) || !hasExactKeys(value, required)) return null;
  if (value.issueNumber !== input.issueNumber || value.prNumber !== input.prNumber || value.headSha !== input.headSha || value.lane !== input.lane) return null;
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
    && hasExactKeys(item, ['severity', 'message'], ['id', 'suggestion', 'location'])
    && typeof item.severity === 'string' && FINDING_SEVERITY_VALUES.has(item.severity)
    && typeof item.message === 'string' && item.message.trim() !== ''
    && (item.id === undefined || typeof item.id === 'string')
    && (item.suggestion === undefined || typeof item.suggestion === 'string')
    && (item.location === undefined || (isRecord(item.location)
      && hasExactKeys(item.location, ['path'], ['line', 'endLine', 'side'])
      && typeof item.location.path === 'string' && item.location.path.trim() !== ''
      && (item.location.line === undefined || (Number.isSafeInteger(item.location.line) && Number(item.location.line) > 0))
      && (item.location.endLine === undefined || (Number.isSafeInteger(item.location.endLine) && Number(item.location.endLine) > 0))
      && (item.location.side === undefined || item.location.side === 'source' || item.location.side === 'destination'))))) return null;
  const hasBlockingFinding = value.findings.some(item => isRecord(item) && item.severity === 'blocking');
  if (hasBlockingFinding && (value.status !== 'failed' && value.status !== 'needs-work'
    || value.recommendation !== 'request-changes'
    || value.severity !== 'high' && value.severity !== 'critical'
    || value.blockers.length === 0)) return null;
  if (!Array.isArray(value.artifacts) || value.artifacts.length === 0 || !value.artifacts.every(item => isRecord(item)
    && hasExactKeys(item, ['kind', 'path'], ['sha256'])
    && typeof item.kind === 'string' && item.kind.trim() !== ''
    && typeof item.path === 'string' && safeArtifactPath(input.repoRoot, item.kind, item.path)
    && validArtifactDigest(input.repoRoot, item.path, item.sha256))) return null;
  if (!Array.isArray(value.contextReviewed) || value.contextReviewed.length === 0 || !value.contextReviewed.every(item => isRecord(item)
    && hasExactKeys(item, ['kind', 'source', 'trust', 'freshness'])
    && typeof item.kind === 'string' && CONTEXT_KIND_VALUES.has(item.kind)
    && typeof item.source === 'string' && item.source.trim() !== ''
    && typeof item.trust === 'string' && CONTEXT_TRUST_VALUES.has(item.trust)
    && typeof item.freshness === 'string' && CONTEXT_FRESHNESS_VALUES.has(item.freshness))) return null;
  const candidate = { ...value, promptStack: input.promptStack, runnerProvenance: provenance };
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
  const executablePath = typeof executable === 'string' ? executable : executable.executable;
  const args: string[] = typeof executable === 'string' ? [] : [...executable.prefixArgs];
  let stdin: string | null = null;
  if (input.plan.host === 'codex') {
    if (!schemaPath) throw new Error('Codex review routing requires a private output schema file.');
    args.push('exec');
    if (input.plan.model) args.push('--model', input.plan.model);
    if (input.plan.effort) args.push('--config', `model_reasoning_effort="${input.plan.effort}"`);
    args.push(
      '--ignore-user-config', '--strict-config', '--config', 'mcp_servers={}', '--config', 'web_search="disabled"',
      '--disable', 'apps', '--disable', 'browser_use', '--disable', 'browser_use_external', '--disable', 'computer_use',
      '--disable', 'in_app_browser', '--disable', 'standalone_web_search', '--disable', 'multi_agent', '--disable', 'hooks', '--disable', 'plugins',
      '--sandbox', 'read-only', '--cd', input.repoRoot, '--skip-git-repo-check', '--ephemeral', '--output-schema', schemaPath, '--json', '-',
    );
    stdin = prompt;
  } else {
    if (!promptPath) throw new Error('Grok review routing requires a private prompt file.');
    args.push(
      '--cwd', input.repoRoot,
      '--permission-mode', 'dontAsk',
      '--sandbox', 'strict',
      '--allow', 'Read',
      '--allow', 'Grep',
      '--deny', 'Bash(*)',
      '--deny', 'Edit',
      '--deny', 'WebFetch',
      '--deny', 'MCPTool(*)',
      '--no-plan',
      '--no-subagents',
      '--disable-web-search',
      '--no-memory',
      '--max-turns', String(input.plan.maxTurns),
      '--json-schema', reviewResultSchema(input),
    );
    if (input.plan.effort) args.push('--reasoning-effort', input.plan.effort);
    if (input.plan.model) args.push('--model', input.plan.model);
    args.push('--verbatim', '--prompt-file', promptPath);
  }
  return { executable: executablePath, args, cwd: input.repoRoot, stdin, promptPath, schemaPath, timeoutMs: input.plan.timeoutSeconds * 1000 };
}

export async function runModelRouteProcess(invocation: ModelRouteInvocation): Promise<ModelRouteProcessResult> {
  return new Promise(resolve => {
    const child = spawn(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let stdinDelivered = false;
    let stdinFailed = false;
    const append = (current: string, chunk: Buffer): string => (current + chunk.toString('utf8')).slice(-MAX_OUTPUT_BYTES);
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    child.stdin.on('error', error => { stdinFailed = true; stdinDelivered = false; stderr = `${stderr}\n${error.message}`; });
    child.on('error', error => { stderr = `${stderr}\n${error.message}`; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, invocation.timeoutMs);
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ exitCode: typeof code === 'number' ? code : 1, stdout, stderr, timedOut, stdinDelivered });
    });
    if (invocation.stdin !== null) child.stdin.end(invocation.stdin, 'utf8', () => { stdinDelivered = !stdinFailed; });
    else child.stdin.end(() => { stdinDelivered = !stdinFailed; });
  });
}

function parseCodexOutput(stdout: string): { text: string; sessionId: string | null } | null {
  let text: string | null = null;
  let sessionId: string | null = null;
  for (const line of stdout.split(/\r?\n/).filter(line => line.trim() !== '')) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
    const record = event as Record<string, unknown>;
    if (record.type === 'thread.started' && typeof record.thread_id === 'string') sessionId = record.thread_id;
    if (record.type === 'item.completed' && record.item && typeof record.item === 'object' && !Array.isArray(record.item)) {
      const item = record.item as Record<string, unknown>;
      if (item.type === 'agent_message' && typeof item.text === 'string') text = item.text;
    }
  }
  return text ? { text, sessionId } : null;
}

function finalJsonObjectText(text: string): string | null {
  let index = 0;
  let finalObject: string | null = null;
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index])) index += 1;
    if (index >= text.length) break;
    if (text[index] !== '{') return null;
    const start = index;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          index += 1;
          break;
        }
      }
    }
    if (depth !== 0 || inString) return null;
    const candidate = text.slice(start, index);
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (!isRecord(parsed)) return null;
    } catch {
      return null;
    }
    finalObject = candidate;
  }
  return finalObject;
}

function parseGrokOutput(stdout: string): { text: string; sessionId: string | null } | null {
  try {
    const value: unknown = JSON.parse(stdout);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.text !== 'string') return null;
    const text = finalJsonObjectText(record.text);
    return text ? { text, sessionId: typeof record.sessionId === 'string' ? record.sessionId : null } : null;
  } catch {
    return null;
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
    const executable = await (input.resolveExecutable ?? resolveModelHostExecutable)(input.plan.host);
    const routeDirectory = join(input.repoRoot, '.git', 'qube', 'aie', 'model-route');
    mkdirSync(routeDirectory, { recursive: true });
    if (input.plan.host === 'grok') {
      promptPath = join(routeDirectory, `${invocationId}.prompt`);
      writeFileSync(promptPath, prompt, { encoding: 'utf8', mode: 0o600 });
    } else {
      schemaPath = join(routeDirectory, `${invocationId}.schema.json`);
      writeFileSync(schemaPath, reviewResultSchema(input), { encoding: 'utf8', mode: 0o600 });
    }
    const invocation = buildModelRouteInvocation(input, executable, prompt, promptPath, schemaPath);
    const result = await (input.runProcess ?? runModelRouteProcess)(invocation);
    if (result.exitCode !== 0 || result.timedOut) {
      const failure = failureReason(result);
      return { evidence: null, ...failure };
    }
    if (!result.stdinDelivered) return { evidence: null, reasonCode: 'model-route-prompt-delivery', error: 'Model review route did not confirm complete prompt delivery.' };
    const parsedHostOutput = input.plan.host === 'codex' ? parseCodexOutput(result.stdout) : parseGrokOutput(result.stdout);
    if (!parsedHostOutput) return { evidence: null, reasonCode: 'model-route-output-envelope', error: 'Model review route returned no supported final-response envelope.' };
    let modelResult: unknown;
    try { modelResult = JSON.parse(parsedHostOutput.text); } catch {
      return { evidence: null, reasonCode: 'model-route-malformed-json', error: 'Model review route final response was not exactly one JSON object.' };
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
    };
    if (await resolveHead(input.repoRoot) !== input.headSha) return { evidence: null, reasonCode: 'model-route-checkout-mismatch', error: 'Local checkout HEAD changed during isolated review execution.' };
    const evidence = strictRoutedLane(normalizeSchemaOptionals(modelResult), input, provenance);
    if (!evidence) return { evidence: null, reasonCode: 'model-route-contract-mismatch', error: 'Model review result did not match the requested issue, pull request, head, lane, or evidence contract.' };
    if (evidence.completeness === '' || evidence.contextReviewed.length === 0 || evidence.artifacts.length === 0) {
      return { evidence: null, reasonCode: 'model-route-incomplete-evidence', error: 'Model review result omitted required completeness, contextReviewed, or artifacts evidence.' };
    }
    return { evidence, reasonCode: null, error: null };
  } catch (error: unknown) {
    return { evidence: null, reasonCode: 'model-route-unavailable', error: sanitizedDiagnostic(error instanceof Error ? error.message : String(error)) };
  } finally {
    if (promptPath) rmSync(promptPath, { force: true });
    if (schemaPath) rmSync(schemaPath, { force: true });
  }
}
