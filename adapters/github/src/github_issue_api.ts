import { runGh, parseGhJson, type GhExec, GhMalformedOutputError, GhExecutionError } from './gh.js';

function isRawGhLabel(v: unknown): v is RawGhLabel {
  return !!v && typeof v === 'object' && 'name' in (v as object);
}
function isRawGhAssignee(v: unknown): v is RawGhAssignee {
  return !!v && typeof v === 'object' && typeof (v as Record<string, unknown>).login === 'string';
}
function isRawGhMilestone(v: unknown): v is RawGhMilestone | null {
  if (v === null) return true;
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.number === 'number' && typeof o.title === 'string' && (o.state === undefined || typeof o.state === 'string');
}
function isRawGhIssue(v: unknown): v is RawGhIssue {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const assignees = o.assignees;
  return typeof o.number === 'number' && typeof o.title === 'string' && typeof o.body === 'string' && typeof o.state === 'string' && Array.isArray(o.labels) && o.labels.every(isRawGhLabel) && (assignees === undefined || (Array.isArray(assignees) && assignees.every(isRawGhAssignee))) && isRawGhMilestone(o.milestone) && typeof o.url === 'string';
}
function isRawGhIssueArray(v: unknown): v is RawGhIssue[] {
  return Array.isArray(v) && v.every(isRawGhIssue);
}

export interface GitHubLabel {
  name: string;
}

export interface GitHubMilestone {
  number: number;
  title: string;
  state: string;
  dueOn: string | null;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED';
  labels: string[];
  assignees: string[];
  milestone: GitHubMilestone | null;
  url: string;
  declaredBlockers: number[];
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

function normalizeState(raw: string): 'OPEN' | 'CLOSED' {
  const s = raw.toUpperCase();
  if (s === 'OPEN') return 'OPEN';
  if (s === 'CLOSED') return 'CLOSED';
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
    // True line-based: optional leading list bullet + whitespace, then exact "Blocked by:" prefix.
    const m = line.match(/^\s*(?:[-*+]\s*)?Blocked by:\s+(.+)$/i);
    if (!m) continue;
    for (const blocker of m[1].matchAll(/#(\d+)/g)) {
      const n = parseInt(blocker[1], 10);
      if (n > 0) nums.push(n);
    }
  }
  // Deduplicate + sort for canonical form (per FR-05-007 line-based blocker metadata)
  return [...new Set(nums)].sort((a, b) => a - b);
}

function normalizeIssue(raw: RawGhIssue): GitHubIssue {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? '',
    state: normalizeState(raw.state),
    labels: (raw.labels ?? []).map((l) => l.name),
    assignees: (raw.assignees ?? []).map((assignee) => assignee.login),
    milestone: normalizeMilestone(raw.milestone),
    url: raw.url,
    declaredBlockers: parseDeclaredBlockers(raw.body ?? ''),
  };
}

export async function listOpenIssues(options: { cwd?: string; exec?: GhExec; limit?: number; includeAssignees?: boolean } = {}): Promise<GitHubIssue[]> {
  const { cwd, exec, limit = 1000 } = options;
  const args = [
    'issue',
    'list',
    '--state',
    'open',
    '--json',
    options.includeAssignees ? ISSUE_JSON_FIELDS_WITH_ASSIGNEES : ISSUE_JSON_FIELDS,
    '--limit',
    String(limit),
  ];
  const result = await runGh(args, { cwd, exec });
  // runGh throws on non-zero via default; custom exec non-zero is converted for contract uniformity
  if (result.exitCode !== 0) {
    throw new GhExecutionError('gh issue list', result.exitCode, result.stderr);
  }
  const raw = parseGhJson<RawGhIssue[]>(result.stdout, 'gh issue list', isRawGhIssueArray);
  return raw.map(normalizeIssue);
}

export async function getIssue(
  issueNumber: number,
  options: { cwd?: string; exec?: GhExec; includeAssignees?: boolean } = {}
): Promise<GitHubIssue> {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new GhMalformedOutputError(`gh issue view ${issueNumber}`, 'issueNumber must be a positive integer');
  }
  const { cwd, exec } = options;
  const args = [
    'issue',
    'view',
    String(issueNumber),
    '--json',
    options.includeAssignees ? ISSUE_JSON_FIELDS_WITH_ASSIGNEES : ISSUE_JSON_FIELDS,
  ];
  const result = await runGh(args, { cwd, exec });
  if (result.exitCode !== 0) {
    throw new GhExecutionError(`gh issue view ${issueNumber}`, result.exitCode, result.stderr);
  }
  const raw = parseGhJson<RawGhIssue>(result.stdout, `gh issue view ${issueNumber}`, isRawGhIssue);
  return normalizeIssue(raw);
}

export function extractPriorityLabel(labels: string[]): string | undefined {
  const order = ['P1-Critical', 'P2-High', 'P3-Medium', 'P4-Low'];
  for (const p of order) {
    if (labels.includes(p)) return p;
  }
  return undefined;
}

export function extractStatusLabel(labels: string[]): string | undefined {
  const statuses = ['S-Ready', 'S-InProgress', 'S-Blocked', 'S-Blocking'];
  for (const s of statuses) {
    if (labels.includes(s)) return s;
  }
  return undefined;
}

export function extractComponentLabels(labels: string[]): string[] {
  const comps = [
    'C-Architecture',
    'C-Backend',
    'C-Frontend',
    'C-Testing',
    'C-Tooling',
    'C-Docs',
    'C-DevEx',
    'C-CI',
    'C-Security',
    'C-Data',
  ];
  return labels.filter((l) => comps.includes(l));
}
