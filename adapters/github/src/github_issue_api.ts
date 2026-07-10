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

function isRestLabel(value: unknown): value is { name: string } | string {
  if (typeof value === 'string' && value.trim().length > 0) return true;
  return !!value && typeof value === 'object' && typeof (value as Record<string, unknown>).name === 'string'
    && String((value as Record<string, unknown>).name).trim().length > 0;
}

function isRestAssignee(value: unknown): value is { login: string } {
  return !!value && typeof value === 'object' && typeof (value as Record<string, unknown>).login === 'string'
    && String((value as Record<string, unknown>).login).trim().length > 0;
}

function isRestIssue(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const rest = value as Record<string, unknown>;
  const url = rest.html_url ?? rest.url;
  if (typeof rest.number !== 'number' || !Number.isInteger(rest.number) || rest.number <= 0) return false;
  if (typeof rest.title !== 'string' || rest.title.trim().length === 0) return false;
  if (!(typeof rest.body === 'string' || rest.body === null || rest.body === undefined)) return false;
  if (typeof rest.state !== 'string' || rest.state.trim().length === 0) return false;
  if (typeof url !== 'string' || url.trim().length === 0) return false;
  if (!Array.isArray(rest.labels) || !rest.labels.every(isRestLabel)) return false;
  if (rest.assignees !== undefined && (!Array.isArray(rest.assignees) || !rest.assignees.every(isRestAssignee))) return false;
  if (rest.milestone !== null && rest.milestone !== undefined) {
    if (!rest.milestone || typeof rest.milestone !== 'object') return false;
    const milestone = rest.milestone as Record<string, unknown>;
    if (typeof milestone.number !== 'number' || typeof milestone.title !== 'string') return false;
  }
  return true;
}

function isRestIssueArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isRestIssue);
}

function restIssueToRaw(rest: Record<string, unknown>): RawGhIssue {
  const labels = (rest.labels as unknown[]).map(label => {
    if (typeof label === 'string') return { name: label };
    return { name: String((label as Record<string, unknown>).name) };
  });
  const assignees = Array.isArray(rest.assignees)
    ? (rest.assignees as unknown[]).map(assignee => ({ login: String((assignee as Record<string, unknown>).login) }))
    : [];
  const milestoneRaw = rest.milestone;
  let milestone: RawGhMilestone | null = null;
  if (milestoneRaw && typeof milestoneRaw === 'object') {
    const milestoneRecord = milestoneRaw as Record<string, unknown>;
    milestone = {
      number: Number(milestoneRecord.number),
      title: String(milestoneRecord.title),
      state: typeof milestoneRecord.state === 'string' ? milestoneRecord.state : undefined,
      dueOn: (milestoneRecord.due_on as string | null | undefined) ?? (milestoneRecord.dueOn as string | null | undefined) ?? null,
    };
  }
  return {
    number: Number(rest.number),
    title: String(rest.title),
    body: typeof rest.body === 'string' ? rest.body : '',
    state: String(rest.state),
    labels,
    assignees,
    milestone,
    url: String(rest.html_url ?? rest.url),
  };
}

/**
 * List open issues. Default path uses a single high-limit `gh issue list`.
 * When pageSize is set, pages through the GitHub REST issues API until a short page.
 */
export async function listOpenIssues(options: {
  cwd?: string;
  exec?: GhExec;
  limit?: number;
  pageSize?: number;
  includeAssignees?: boolean;
} = {}): Promise<GitHubIssue[]> {
  const { cwd, exec, limit = 1000, pageSize } = options;
  if (pageSize !== undefined && pageSize > 0) {
    return listOpenIssuesPaged({ cwd, exec, pageSize, includeAssignees: options.includeAssignees });
  }
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

async function listOpenIssuesPaged(options: {
  cwd?: string;
  exec?: GhExec;
  pageSize: number;
  includeAssignees?: boolean;
}): Promise<GitHubIssue[]> {
  const { cwd, exec, pageSize } = options;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new GhMalformedOutputError(
      'gh api issues pageSize',
      `pageSize must be an integer from 1 to 100 (GitHub REST per_page limit); got ${String(pageSize)}.`,
    );
  }
  const repoResult = await runGh(['repo', 'view', '--json', 'nameWithOwner'], { cwd, exec });
  if (repoResult.exitCode !== 0) {
    throw new GhExecutionError('gh repo view', repoResult.exitCode, repoResult.stderr || repoResult.stdout);
  }
  const repo = parseGhJson<{ nameWithOwner: string }>(
    repoResult.stdout,
    'gh repo view',
    (value): value is { nameWithOwner: string } =>
      !!value && typeof value === 'object' && typeof (value as Record<string, unknown>).nameWithOwner === 'string',
  );
  const all: GitHubIssue[] = [];
  const maxPages = 100;
  for (let page = 1; page <= maxPages; page += 1) {
    const path = `repos/${repo.nameWithOwner}/issues?state=open&per_page=${pageSize}&page=${page}`;
    const result = await runGh(['api', path], { cwd, exec });
    if (result.exitCode !== 0) {
      throw new GhExecutionError(`gh api ${path}`, result.exitCode, result.stderr || result.stdout);
    }
    const restIssues = parseGhJson<Record<string, unknown>[]>(result.stdout, `gh api ${path}`, isRestIssueArray);
    // Issues API includes pull requests; keep only pure issues for work-queue mapping.
    const pureIssues = restIssues.filter(issue => !('pull_request' in issue && issue.pull_request));
    for (const rest of pureIssues) {
      all.push(normalizeIssue(restIssueToRaw(rest)));
    }
    if (restIssues.length < pageSize) return all;
    if (page === maxPages) {
      throw new GhMalformedOutputError(
        'gh api issues pagination',
        `Open issue pagination exceeded ${maxPages} pages of ${pageSize} items without a terminating short page.`,
      );
    }
  }
  return all;
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
