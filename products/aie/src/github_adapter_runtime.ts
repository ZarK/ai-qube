import { execFile } from 'child_process';
import { promisify } from 'util';
import type { GitHubIssue, GitHubMilestone, GhExec, GhRunResult } from '@tjalve/qube-adapter-github';

export type { GitHubIssue, GitHubMilestone, GhExec, GhRunResult };

const execFileAsync = promisify(execFile);

const TOKEN_PATTERNS: RegExp[] = [
  /\b(ghp_[A-Za-z0-9_]{10,})\b/g,
  /\b(github_pat_[A-Za-z0-9_]{10,})\b/g,
  /\b(ghs_[A-Za-z0-9_]{10,})\b/g,
  /\b(gho_[A-Za-z0-9_]{10,})\b/g,
  /\b(ghu_[A-Za-z0-9_]{10,})\b/g,
];

export function redact(text: string): string {
  let out = text;
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, '[REDACTED]');
  }
  return out.replace(/\b([A-Za-z0-9_-]{40,})\b/g, (match) => {
    if (/[A-Z]/.test(match) && /[a-z]/.test(match) && /[0-9]/.test(match)) {
      return '[REDACTED]';
    }
    return match;
  });
}

export class GhExecutionError extends Error {
  readonly kind = 'execution' as const;
  readonly exitCode: number;
  readonly stderr: string;
  constructor(operation: string, exitCode: number, stderr: string) {
    super(`Failed to execute ${operation}: exit code ${exitCode}. ${stderr || 'Unknown error'}. Verify gh version and repository state.`);
    this.name = 'GhExecutionError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export class GhNotFoundError extends Error {
  readonly kind = 'not-found' as const;
  constructor(operation: string) {
    super(`Failed to execute ${operation}: gh CLI not found on PATH. Install GitHub CLI and ensure it is on your PATH.`);
    this.name = 'GhNotFoundError';
  }
}

export class GhAuthError extends Error {
  readonly kind = 'auth' as const;
  constructor(operation: string, details: string) {
    super(`Failed to execute ${operation}: not authenticated with GitHub. ${details} Run "gh auth login" and try again.`);
    this.name = 'GhAuthError';
  }
}

export class NotGitHubRepositoryError extends Error {
  readonly kind = 'not-repo' as const;
  constructor(operation: string, details: string) {
    super(`Failed to execute ${operation}: not a GitHub repository or no github.com remote. ${details} Run from a git repository with a GitHub remote, or use --repo owner/repo.`);
    this.name = 'NotGitHubRepositoryError';
  }
}

export class GhNetworkError extends Error {
  readonly kind = 'network' as const;
  constructor(operation: string, details: string) {
    super(`Failed to execute ${operation}: network or GitHub API error. ${details} Check your connection, proxy settings, or GitHub status page.`);
    this.name = 'GhNetworkError';
  }
}

export class GhMalformedOutputError extends Error {
  readonly kind = 'malformed' as const;
  constructor(operation: string, details: string) {
    super(`Failed to execute ${operation}: malformed or unexpected output. ${details} Update gh CLI or report the redacted error.`);
    this.name = 'GhMalformedOutputError';
  }
}

interface GhExecErrorShape {
  code?: string | number;
  status?: number;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  message?: string;
}

function isGhExecError(value: unknown): value is GhExecErrorShape {
  return !!value && typeof value === 'object';
}

async function defaultGhExec(args: string[], cwd = process.cwd()): Promise<GhRunResult> {
  const redactedArgs = args.map(arg => redact(arg));
  const operation = `gh ${redactedArgs.join(' ')}`;

  try {
    const { stdout, stderr } = await execFileAsync('gh', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        GH_PAGER: '',
        CLICOLOR: '0',
        NO_COLOR: '1',
      },
    });
    return {
      args: redactedArgs,
      exitCode: 0,
      stdout: redact(stdout),
      stderr: redact(stderr),
    };
  } catch (err: unknown) {
    const e = isGhExecError(err) ? err : {};
    const stdoutRaw = e.stdout;
    const stderrRaw = e.stderr;
    const stdout = redact(typeof stdoutRaw === 'string' ? stdoutRaw : (Buffer.isBuffer(stdoutRaw) ? stdoutRaw.toString('utf8') : ''));
    const stderr = redact(typeof stderrRaw === 'string' ? stderrRaw : (Buffer.isBuffer(stderrRaw) ? stderrRaw.toString('utf8') : (e.message || '')));
    const code = e.code === 'ENOENT' ? -1 : (e.status ?? (typeof e.code === 'number' ? e.code : 1));

    if (e.code === 'ENOENT' || code === -1) throw new GhNotFoundError(operation);

    const combined = `${stderr} ${stdout}`.toLowerCase();
    if (combined.includes('authentication') || combined.includes('not logged in') || combined.includes('bad credentials') || code === 4) {
      throw new GhAuthError(operation, stderr || stdout);
    }
    if (combined.includes('not a git repository') || combined.includes('no git repository') || combined.includes('unknown repository') || combined.includes('not a github repository')) {
      throw new NotGitHubRepositoryError(operation, stderr || stdout);
    }
    if (combined.includes('network') || combined.includes('timeout') || combined.includes('econn') || combined.includes('getaddrinfo') || combined.includes('socket hang') || combined.includes('connection reset')) {
      throw new GhNetworkError(operation, stderr || stdout);
    }

    throw new GhExecutionError(operation, code, stderr || stdout);
  }
}

export async function runGh(args: string[], options: { cwd?: string; exec?: GhExec } = {}): Promise<GhRunResult> {
  const runner = options.exec ?? defaultGhExec;
  const result = await runner(args, options.cwd);
  return {
    args: result.args,
    exitCode: result.exitCode,
    stdout: redact(result.stdout),
    stderr: redact(result.stderr),
  };
}

export function parseGhJson<T>(stdout: string, operation: string, shapeCheck?: (value: unknown) => value is T): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new GhMalformedOutputError(operation, `JSON parse failed: ${detail}`);
  }
  if (shapeCheck && !shapeCheck(parsed)) {
    throw new GhMalformedOutputError(operation, 'gh JSON did not match expected shape');
  }
  return parsed as T;
}

interface RawGhLabel {
  name: string;
}

interface RawGhAssignee {
  login: string;
}

interface RawGhMilestone {
  number: number;
  title: string;
  state?: string;
  dueOn: string | null;
}

interface RawGhIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: RawGhLabel[];
  assignees?: RawGhAssignee[];
  milestone: RawGhMilestone | null;
  url: string;
}

const ISSUE_JSON_FIELDS = 'number,title,state,labels,body,milestone,url';
const ISSUE_JSON_FIELDS_WITH_ASSIGNEES = 'number,title,state,labels,assignees,body,milestone,url';

function isRawGhLabel(value: unknown): value is RawGhLabel {
  return !!value && typeof value === 'object' && typeof (value as Record<string, unknown>).name === 'string';
}

function isRawGhAssignee(value: unknown): value is RawGhAssignee {
  return !!value && typeof value === 'object' && typeof (value as Record<string, unknown>).login === 'string';
}

function isRawGhMilestone(value: unknown): value is RawGhMilestone | null {
  if (value === null) return true;
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.number === 'number' && typeof record.title === 'string' && (record.state === undefined || typeof record.state === 'string');
}

function isRawGhIssue(value: unknown): value is RawGhIssue {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const assignees = record.assignees;
  return typeof record.number === 'number'
    && typeof record.title === 'string'
    && typeof record.body === 'string'
    && typeof record.state === 'string'
    && Array.isArray(record.labels)
    && record.labels.every(isRawGhLabel)
    && (assignees === undefined || (Array.isArray(assignees) && assignees.every(isRawGhAssignee)))
    && isRawGhMilestone(record.milestone)
    && typeof record.url === 'string';
}

function isRawGhIssueArray(value: unknown): value is RawGhIssue[] {
  return Array.isArray(value) && value.every(isRawGhIssue);
}

function normalizeState(raw: string): GitHubIssue['state'] {
  const state = raw.toUpperCase();
  if (state === 'OPEN' || state === 'CLOSED') return state;
  throw new GhMalformedOutputError('gh issue data', `Unexpected issue state value: ${raw}`);
}

function normalizeMilestone(raw: RawGhMilestone | null): GitHubMilestone | null {
  if (!raw) return null;
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state ?? 'UNKNOWN',
    dueOn: raw.dueOn ?? null,
  };
}

export function parseDeclaredBlockers(body: string): number[] {
  if (!body) return [];
  const nums: number[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:[-*+]\s*)?Blocked by:\s+(.+)$/i);
    if (!match) continue;
    for (const blocker of match[1].matchAll(/#(\d+)/g)) {
      const n = parseInt(blocker[1], 10);
      if (n > 0) nums.push(n);
    }
  }
  return [...new Set(nums)].sort((a, b) => a - b);
}

function normalizeIssue(raw: RawGhIssue): GitHubIssue {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? '',
    state: normalizeState(raw.state),
    labels: (raw.labels ?? []).map(label => label.name),
    assignees: (raw.assignees ?? []).map(assignee => assignee.login),
    milestone: normalizeMilestone(raw.milestone),
    url: raw.url,
    declaredBlockers: parseDeclaredBlockers(raw.body ?? ''),
  };
}

export async function listOpenIssues(options: { cwd?: string; exec?: GhExec; limit?: number; includeAssignees?: boolean } = {}): Promise<GitHubIssue[]> {
  const args = [
    'issue',
    'list',
    '--state',
    'open',
    '--json',
    options.includeAssignees ? ISSUE_JSON_FIELDS_WITH_ASSIGNEES : ISSUE_JSON_FIELDS,
    '--limit',
    String(options.limit ?? 1000),
  ];
  const result = await runGh(args, { cwd: options.cwd, exec: options.exec });
  if (result.exitCode !== 0) {
    throw new GhExecutionError('gh issue list', result.exitCode, result.stderr);
  }
  return parseGhJson<RawGhIssue[]>(result.stdout, 'gh issue list', isRawGhIssueArray).map(normalizeIssue);
}

export async function getIssue(issueNumber: number, options: { cwd?: string; exec?: GhExec; includeAssignees?: boolean } = {}): Promise<GitHubIssue> {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new GhMalformedOutputError(`gh issue view ${issueNumber}`, 'issueNumber must be a positive integer');
  }
  const args = [
    'issue',
    'view',
    String(issueNumber),
    '--json',
    options.includeAssignees ? ISSUE_JSON_FIELDS_WITH_ASSIGNEES : ISSUE_JSON_FIELDS,
  ];
  const result = await runGh(args, { cwd: options.cwd, exec: options.exec });
  if (result.exitCode !== 0) {
    throw new GhExecutionError(`gh issue view ${issueNumber}`, result.exitCode, result.stderr);
  }
  return normalizeIssue(parseGhJson<RawGhIssue>(result.stdout, `gh issue view ${issueNumber}`, isRawGhIssue));
}
