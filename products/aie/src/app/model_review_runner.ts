import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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
  timeoutMs: number;
}

export interface ModelRouteProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
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
  resolveExecutable?: (host: RoutedReviewHostId) => Promise<string>;
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

export async function resolveModelHostExecutable(host: RoutedReviewHostId): Promise<string> {
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
    'Do not include runnerProvenance or promptStack; QUBE records those from the trusted invocation.',
    'Do not write files, publish feedback, modify provider state, use subagents, use web tools, or reveal hidden reasoning.',
  ].join('\n');
}

export function buildModelReviewPrompt(input: ModelReviewRunInput): string {
  return [
    'You are an isolated read-only QUBE review lane runner.',
    reviewResultContract(input),
    '',
    '--- EXACT QUBE LANE PROMPT START ---',
    input.promptText,
    '--- EXACT QUBE LANE PROMPT END ---',
  ].join('\n');
}

function grokReviewSchema(input: ModelReviewRunInput): string {
  const stringArray = { type: 'array', items: { type: 'string' } } as const;
  return JSON.stringify({
    type: 'object',
    additionalProperties: false,
    required: ['issueNumber', 'prNumber', 'headSha', 'lane', 'status', 'severity', 'recommendation', 'summary', 'blockers', 'findings', 'artifacts', 'commands', 'surfaces', 'contextReviewed', 'toolsUsed', 'completeness', 'preconditions'],
    properties: {
      issueNumber: { const: input.issueNumber },
      prNumber: { const: input.prNumber },
      headSha: { const: input.headSha },
      lane: { const: input.lane },
      status: { enum: ['passed', 'failed', 'needs-work', 'pending', 'missing', 'stale', 'unavailable', 'malformed', 'inconclusive'] },
      severity: { enum: ['none', 'low', 'medium', 'high', 'critical'] },
      recommendation: { enum: ['approve', 'request-changes', 'pending', 'inconclusive'] },
      summary: { type: 'string', minLength: 1 },
      blockers: stringArray,
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['severity', 'message'],
          properties: {
            id: { type: 'string' },
            severity: { enum: ['blocking', 'advisory'] },
            message: { type: 'string', minLength: 1 },
            suggestion: { type: 'string' },
            location: {
              type: 'object',
              additionalProperties: false,
              required: ['path'],
              properties: {
                path: { type: 'string', minLength: 1 },
                line: { type: 'integer', minimum: 1 },
                endLine: { type: 'integer', minimum: 1 },
                side: { enum: ['source', 'destination'] },
              },
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
          required: ['kind', 'path'],
          properties: {
            kind: { type: 'string', minLength: 1 },
            path: { type: 'string', minLength: 1 },
            sha256: { type: ['string', 'null'] },
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
            kind: { type: 'string' },
            source: { type: 'string' },
            trust: { type: 'string' },
            freshness: { type: 'string' },
          },
        },
      },
      toolsUsed: stringArray,
      completeness: { type: 'string', minLength: 1 },
      preconditions: stringArray,
    },
  });
}

export function buildModelRouteInvocation(input: ModelReviewRunInput, executable: string, prompt: string, promptPath: string | null): ModelRouteInvocation {
  const args: string[] = [];
  let stdin: string | null = null;
  if (input.plan.host === 'codex') {
    args.push('exec');
    if (input.plan.model) args.push('--model', input.plan.model);
    if (input.plan.effort) args.push('--config', `model_reasoning_effort="${input.plan.effort}"`);
    args.push('--sandbox', 'read-only', '--cd', input.repoRoot, '--skip-git-repo-check', '--ephemeral', '--json', '-');
    stdin = prompt;
  } else {
    if (!promptPath) throw new Error('Grok review routing requires a private prompt file.');
    args.push('--cwd', input.repoRoot, '--permission-mode', 'plan', '--no-subagents', '--disable-web-search', '--no-memory', '--max-turns', String(input.plan.maxTurns), '--json-schema', grokReviewSchema(input));
    if (input.plan.effort) args.push('--reasoning-effort', input.plan.effort);
    if (input.plan.model) args.push('--model', input.plan.model);
    args.push('--verbatim', '--prompt-file', promptPath);
  }
  return { executable, args, cwd: input.repoRoot, stdin, promptPath, timeoutMs: input.plan.timeoutSeconds * 1000 };
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
    const append = (current: string, chunk: Buffer): string => (current + chunk.toString('utf8')).slice(-MAX_OUTPUT_BYTES);
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    child.stdin.on('error', error => { stderr = `${stderr}\n${error.message}`; });
    child.on('error', error => { stderr = `${stderr}\n${error.message}`; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, invocation.timeoutMs);
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ exitCode: typeof code === 'number' ? code : 1, stdout, stderr, timedOut });
    });
    if (invocation.stdin !== null) child.stdin.end(invocation.stdin, 'utf8');
    else child.stdin.end();
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

function parseGrokOutput(stdout: string): { text: string; sessionId: string | null } | null {
  try {
    const value: unknown = JSON.parse(stdout);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return typeof record.text === 'string'
      ? { text: record.text, sessionId: typeof record.sessionId === 'string' ? record.sessionId : null }
      : null;
  } catch {
    return null;
  }
}

function failureReason(result: ModelRouteProcessResult): { reasonCode: string; error: string } {
  if (result.timedOut) return { reasonCode: 'model-route-timeout', error: 'Model review route exceeded its configured timeout and was terminated.' };
  const diagnostic = sanitizedDiagnostic(result.stderr);
  if (/auth|login|credential|unauthor/i.test(`${result.stderr}\n${result.stdout}`)) return { reasonCode: 'model-route-authentication', error: 'Model review route is not authenticated. Authenticate the configured host outside QUBE, then rerun.' };
  if (/model.*(?:not found|unknown|unavailable|invalid)/i.test(`${result.stderr}\n${result.stdout}`)) return { reasonCode: 'model-route-model-unavailable', error: 'Configured review model is unavailable for this host. Refresh the host model list and update trusted review config.' };
  return { reasonCode: 'model-route-process-failed', error: `Model review route exited with code ${result.exitCode}.${diagnostic ? ` Diagnostic: ${diagnostic}` : ''}` };
}

export async function runModelReview(input: ModelReviewRunInput): Promise<ModelReviewRunResult> {
  const invocationId = randomUUID();
  const prompt = buildModelReviewPrompt(input);
  let promptPath: string | null = null;
  try {
    const executable = await (input.resolveExecutable ?? resolveModelHostExecutable)(input.plan.host);
    if (input.plan.host === 'grok') {
      promptPath = join(input.repoRoot, '.git', 'qube', 'aie', 'model-route', `${invocationId}.prompt`);
      mkdirSync(dirname(promptPath), { recursive: true });
      writeFileSync(promptPath, prompt, { encoding: 'utf8', mode: 0o600 });
    }
    const invocation = buildModelRouteInvocation(input, executable, prompt, promptPath);
    const result = await (input.runProcess ?? runModelRouteProcess)(invocation);
    if (result.exitCode !== 0 || result.timedOut) {
      const failure = failureReason(result);
      return { evidence: null, ...failure };
    }
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
    const candidate = modelResult && typeof modelResult === 'object' && !Array.isArray(modelResult)
      ? { ...(modelResult as Record<string, unknown>), promptStack: input.promptStack, runnerProvenance: provenance }
      : modelResult;
    const evidence = normalizeExternalLane(candidate, input.lane, input.issueNumber, input.prNumber, input.headSha);
    if (!evidence) return { evidence: null, reasonCode: 'model-route-contract-mismatch', error: 'Model review result did not match the requested issue, pull request, head, lane, or evidence contract.' };
    if (evidence.completeness === '' || evidence.contextReviewed.length === 0 || evidence.artifacts.length === 0) {
      return { evidence: null, reasonCode: 'model-route-incomplete-evidence', error: 'Model review result omitted required completeness, contextReviewed, or artifacts evidence.' };
    }
    return { evidence, reasonCode: null, error: null };
  } catch (error: unknown) {
    return { evidence: null, reasonCode: 'model-route-unavailable', error: sanitizedDiagnostic(error instanceof Error ? error.message : String(error)) };
  } finally {
    if (promptPath) rmSync(promptPath, { force: true });
  }
}
