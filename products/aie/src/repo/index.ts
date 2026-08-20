import { existsSync, readFileSync, readdirSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { AIE_CONFIG_FILENAME, Config, formatConfigFile, getDefaults } from '../config/index.js';
import { configToExecutorPolicy } from '../config_policy.js';
import { parseJsonOutput } from '../json_parse.js';
import { listOpenIssues, runGh, type GhExec, type GitHubIssue } from '../providers/github_adapter_exports.js';
import { applyLabelPlan, computeLabelPlan, getDesiredLabels, LabelPlan, parseGhLabelList } from '../labels.js';
import { getManagedSectionHealth } from '../managed_file.js';
import { inspectBaseRef, inspectRepoRoot, inspectWorktree } from '../providers/local/local_git_provider.js';
import { AGENT_HOST_IDS, type AgentHostId } from '@tjalve/qube-core';
import { getAgentHostProfileSync } from '../agent_host_adapters.js';
import { reviewModeOf } from '../review_mode.js';
export type { RepoAffectedCommandResult, RepoInspectCommandResult } from './layout.js';
export { inspectAffected, inspectRepoLayout, runRepoAffected, runRepoInspect } from './layout.js';

export interface RepositoryIdentity {
  nameWithOwner: string;
  url: string;
}

export interface PullRequestSummary {
  number: number;
  title: string;
  author: string;
  isDraft: boolean;
  url: string;
  headRefName: string;
  ignored: boolean;
}

export interface BaseRefStatus {
  remote: string;
  branch: string;
  resolved: boolean;
  localRevision?: string;
  remoteRevision?: string;
  upToDate: boolean;
  error?: string;
}

export interface WorktreeStatus {
  isWorktree: boolean;
  gitDir?: string;
  error?: string;
}

export interface MilestoneSummary {
  number: number;
  title: string;
  state: string;
  dueOn: string | null;
  openIssues: number;
  closedIssues: number;
}

export interface IssueMilestoneWarning {
  issueNumber: number;
  title: string;
  kind: 'missing-assignment' | 'ordering-drift' | 'unknown-order';
  message: string;
  blockerNumber?: number;
  issueMilestone?: string;
  blockerMilestone?: string;
}

export interface InstructionStatus {
  harnesses: AgentHarnessInstructionStatus[];
  targets: InstructionTargetStatus[];
}

export interface InstructionStatusOptions {
  reviewMode?: 'external' | 'host' | 'isolated';
  localReviewAgents?: readonly string[];
}

export interface AgentHarnessInstructionStatus {
  host: AgentHostId;
  displayName: string;
  installed: boolean;
  healthy: boolean;
  targets: InstructionTargetStatus[];
}

export interface InstructionTargetStatus {
  host: AgentHostId;
  kind: 'instructions' | 'make-it-so' | 'review-agent';
  id: string;
  path: string;
  required: boolean;
  present: boolean;
  managed: boolean;
  checksumValid: boolean;
  healthy: boolean;
}

export interface PlanningStatus {
  spec: boolean;
  milestones: string[];
}

export interface RepoPrimePlan {
  ok: boolean;
  repository?: RepositoryIdentity;
  configPath: string;
  configPresent: boolean;
  configWillWrite: boolean;
  labelPlan?: LabelPlan;
  labelError?: string;
  openIssueCount?: number;
  openIssueError?: string;
  pullRequests: PullRequestSummary[];
  blockingPullRequests: PullRequestSummary[];
  pullRequestError?: string;
  worktree: WorktreeStatus;
  baseRef: BaseRefStatus;
  milestones: MilestoneSummary[];
  milestoneWarnings: IssueMilestoneWarning[];
  milestoneError?: string;
  instructions: InstructionStatus;
  planning: PlanningStatus;
  plannedChanges: string[];
  completedChanges: string[];
  skippedActions: string[];
  warnings: string[];
}

interface RawRepoView {
  nameWithOwner: string;
  url: string;
}

interface RawPrAuthor {
  login: string;
}

interface RawPr {
  number: number;
  title: string;
  author: RawPrAuthor;
  isDraft: boolean;
  url: string;
  headRefName: string;
}

interface RawMilestone {
  number: number;
  title: string;
  state: string;
  due_on?: string | null;
  dueOn?: string | null;
  open_issues?: number;
  closed_issues?: number;
}

function isRawRepoView(value: unknown): value is RawRepoView {
  if (!value || typeof value !== 'object') return false;
  const repo = value as Record<string, unknown>;
  return typeof repo.nameWithOwner === 'string' && typeof repo.url === 'string';
}

function isRawPr(value: unknown): value is RawPr {
  if (!value || typeof value !== 'object') return false;
  const pr = value as Record<string, unknown>;
  const author = pr.author as Record<string, unknown> | undefined;
  return typeof pr.number === 'number' &&
    typeof pr.title === 'string' &&
    !!author &&
    typeof author.login === 'string' &&
    typeof pr.isDraft === 'boolean' &&
    typeof pr.url === 'string' &&
    typeof pr.headRefName === 'string';
}

function isRawPrArray(value: unknown): value is RawPr[] {
  return Array.isArray(value) && value.every(isRawPr);
}

function isRawMilestone(value: unknown): value is RawMilestone {
  if (!value || typeof value !== 'object') return false;
  const milestone = value as Record<string, unknown>;
  return typeof milestone.number === 'number' && typeof milestone.title === 'string' && typeof milestone.state === 'string';
}

function isRawMilestoneArray(value: unknown): value is RawMilestone[] {
  return Array.isArray(value) && value.every(isRawMilestone);
}

export function getRepoRoot(startDir = process.cwd()): string | null {
  return inspectRepoRoot(startDir);
}

export function getWorktreeStatus(repoRoot: string | null): WorktreeStatus {
  const worktree = inspectWorktree(repoRoot);
  return { isWorktree: worktree.linked, gitDir: worktree.gitDir ?? undefined, error: worktree.error ?? undefined };
}

export function getBaseRefStatus(config: Config, repoRoot: string | null): BaseRefStatus {
  const baseRef = inspectBaseRef(configToExecutorPolicy(config), repoRoot);
  return {
    remote: config.baseRemote,
    branch: config.baseBranch,
    resolved: baseRef.revision !== null,
    localRevision: baseRef.revision ?? undefined,
    remoteRevision: baseRef.remoteRevision,
    upToDate: baseRef.upToDate ?? false,
    error: baseRef.error,
  };
}

export async function getRepositoryIdentity(options: { exec?: GhExec; cwd?: string } = {}): Promise<RepositoryIdentity> {
  const result = await runGh(['repo', 'view', '--json', 'nameWithOwner,url'], options);
  return parseJsonOutput<RawRepoView>(result.stdout, 'gh repo view', isRawRepoView);
}

export async function listOpenPullRequests(config: Config, options: { exec?: GhExec; cwd?: string } = {}): Promise<PullRequestSummary[]> {
  const result = await runGh(['pr', 'list', '--state', 'open', '--json', 'number,title,author,isDraft,url,headRefName', '--limit', '1000'], options);
  const raw = parseJsonOutput<RawPr[]>(result.stdout, 'gh pr list', isRawPrArray);
  return raw.map(pr => ({
    number: pr.number,
    title: pr.title,
    author: pr.author.login,
    isDraft: pr.isDraft,
    url: pr.url,
    headRefName: pr.headRefName,
    ignored: config.ignoredAutomationAuthors.includes(pr.author.login),
  }));
}

export async function listMilestones(repository: RepositoryIdentity, options: { exec?: GhExec; cwd?: string } = {}): Promise<MilestoneSummary[]> {
  const result = await runGh(['api', `repos/${repository.nameWithOwner}/milestones`, '--method', 'GET', '-F', 'state=all', '-F', 'per_page=100'], options);
  const raw = parseJsonOutput<RawMilestone[]>(result.stdout, 'gh api milestones', isRawMilestoneArray);
  return raw.map(milestone => ({
    number: milestone.number,
    title: milestone.title,
    state: milestone.state,
    dueOn: milestone.dueOn ?? milestone.due_on ?? null,
    openIssues: milestone.open_issues ?? 0,
    closedIssues: milestone.closed_issues ?? 0,
  }));
}

export function findMissingMilestones(issues: GitHubIssue[]): IssueMilestoneWarning[] {
  return issues.filter(issue => !issue.milestone).map(issue => ({
    issueNumber: issue.number,
    title: issue.title,
    kind: 'missing-assignment',
    message: 'Issue has no GitHub milestone assignment.',
  }));
}

function milestoneIndex(title: string | undefined, orderedTitles: string[]): number | null {
  if (!title) return null;
  const index = orderedTitles.indexOf(title);
  return index === -1 ? null : index;
}

function findMilestoneOrderWarnings(issues: GitHubIssue[], config: Config): IssueMilestoneWarning[] {
  if (!config.milestoneOrdering.enabled || config.milestoneOrdering.order.length === 0) return [];
  const warnings: IssueMilestoneWarning[] = [];
  const issueByNumber = new Map(issues.map(issue => [issue.number, issue]));
  for (const issue of issues) {
    if (!issue.milestone) continue;
    const issueOrder = milestoneIndex(issue.milestone.title, config.milestoneOrdering.order);
    if (issueOrder === null) {
      warnings.push({
        issueNumber: issue.number,
        title: issue.title,
        kind: 'unknown-order',
        message: `Issue milestone "${issue.milestone.title}" is not in configured milestone order.`,
        issueMilestone: issue.milestone.title,
      });
      continue;
    }
    for (const blockerNumber of issue.declaredBlockers) {
      const blocker = issueByNumber.get(blockerNumber);
      if (!blocker?.milestone) continue;
      const blockerOrder = milestoneIndex(blocker.milestone.title, config.milestoneOrdering.order);
      if (blockerOrder === null) {
        warnings.push({
          issueNumber: issue.number,
          title: issue.title,
          kind: 'unknown-order',
          message: `Blocker #${blocker.number} milestone "${blocker.milestone.title}" is not in configured milestone order, so issue milestone ordering cannot be validated.`,
          blockerNumber: blocker.number,
          issueMilestone: issue.milestone.title,
          blockerMilestone: blocker.milestone.title,
        });
        continue;
      }
      if (issueOrder < blockerOrder) {
        warnings.push({
          issueNumber: issue.number,
          title: issue.title,
          kind: 'ordering-drift',
          message: `Issue milestone "${issue.milestone.title}" is ordered before blocker #${blocker.number} milestone "${blocker.milestone.title}".`,
          blockerNumber: blocker.number,
          issueMilestone: issue.milestone.title,
          blockerMilestone: blocker.milestone.title,
        });
      }
    }
  }
  return warnings;
}

export function findMilestoneWarnings(issues: GitHubIssue[], config: Config): IssueMilestoneWarning[] {
  const missing = config.milestoneOrdering.missingAssignment === 'ignore' ? [] : findMissingMilestones(issues);
  return [...missing, ...findMilestoneOrderWarnings(issues, config)];
}

export function getInstructionStatus(repoRoot: string | null, options: InstructionStatusOptions = {}): InstructionStatus {
  if (!repoRoot) return { harnesses: [], targets: [] };
  const requiredReviewHosts = new Set(options.reviewMode === 'host' ? options.localReviewAgents ?? [] : []);
  const harnesses = AGENT_HOST_IDS.map((host) => {
    const profile = getAgentHostProfileSync(host);
    const reviewAssetsRequired = requiredReviewHosts.has(host);
    const targets = [
      instructionTarget(repoRoot, host, 'instructions', profile.instructionTarget.id, profile.instructionTarget.path, true),
      instructionTarget(repoRoot, host, 'make-it-so', profile.makeItSo.id, profile.makeItSo.path, true),
      ...profile.review.local.agents.map((agent) => instructionTarget(repoRoot, host, 'review-agent', agent.id, agent.path, reviewAssetsRequired)),
    ];
    const required = targets.filter((target) => target.required);
    return {
      host,
      displayName: profile.displayName,
      installed: required.every((target) => target.present),
      healthy: required.every((target) => target.healthy),
      targets,
    };
  });
  return { harnesses, targets: harnesses.flatMap((harness) => harness.targets) };
}

function instructionTarget(repoRoot: string, host: AgentHostId, kind: InstructionTargetStatus['kind'], id: string, path: string, required: boolean): InstructionTargetStatus {
  const fullPath = join(repoRoot, path);
  if (!existsSync(fullPath)) return { host, kind, id, path, required, present: false, managed: false, checksumValid: false, healthy: false };
  try {
    const health = getManagedSectionHealth(readFileSync(fullPath, 'utf8'));
    return { host, kind, id, path, required, present: true, managed: health.managedFound, checksumValid: health.checksumValid, healthy: health.managedFound && health.checksumValid };
  } catch {
    return { host, kind, id, path, required, present: true, managed: false, checksumValid: false, healthy: false };
  }
}

export function getPlanningStatus(repoRoot: string | null): PlanningStatus {
  if (!repoRoot) return { spec: false, milestones: [] };
  const docsPath = join(repoRoot, 'docs');
  const milestones = existsSync(docsPath)
    ? readdirSync(docsPath).filter(name => /^M\d+-.+\.md$/.test(name)).sort()
    : [];
  return { spec: existsSync(join(docsPath, 'spec.md')), milestones };
}

export function formatMinimalConfig(): string {
  return formatConfigFile(getDefaults());
}

export async function writeMinimalConfig(configPath: string): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, formatMinimalConfig(), { encoding: 'utf8', flag: 'wx' });
}

export async function buildRepoPrimePlan(options: { config: Config; dryRun: boolean; yes: boolean; exec?: GhExec; cwd?: string }): Promise<RepoPrimePlan> {
  const repoRoot = getRepoRoot(options.cwd);
  const configPath = join(repoRoot ?? options.cwd ?? process.cwd(), AIE_CONFIG_FILENAME);
  const configPresent = existsSync(configPath);
  const warnings: string[] = [];
  const plannedChanges: string[] = [];
  const completedChanges: string[] = [];
  const skippedActions: string[] = [];
  let repository: RepositoryIdentity | undefined;
  let labelPlan: LabelPlan | undefined;
  let labelError: string | undefined;
  let openIssues: GitHubIssue[] = [];
  let openIssueError: string | undefined;
  let pullRequests: PullRequestSummary[] = [];
  let pullRequestError: string | undefined;
  let milestones: MilestoneSummary[] = [];
  let milestoneError: string | undefined;

  try {
    repository = await getRepositoryIdentity({ exec: options.exec, cwd: repoRoot ?? options.cwd });
  } catch (err: unknown) {
    warnings.push(`Repository identity check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const desired = getDesiredLabels(options.config);
    const labelResult = await runGh(['label', 'list', '--json', 'name,color,description', '--limit', '1000'], { exec: options.exec, cwd: repoRoot ?? options.cwd });
    labelPlan = computeLabelPlan(parseGhLabelList(labelResult.stdout), desired);
    if (labelPlan.created.length > 0 || labelPlan.updated.length > 0) plannedChanges.push('Create or update Executor labels');
  } catch (err: unknown) {
    labelError = err instanceof Error ? err.message : String(err);
    warnings.push(`Label check failed: ${labelError}`);
  }

  try {
    openIssues = await listOpenIssues({ exec: options.exec, cwd: repoRoot ?? options.cwd });
  } catch (err: unknown) {
    openIssueError = err instanceof Error ? err.message : String(err);
    warnings.push(`Open issue scan failed: ${openIssueError}`);
  }

  try {
    pullRequests = await listOpenPullRequests(options.config, { exec: options.exec, cwd: repoRoot ?? options.cwd });
  } catch (err: unknown) {
    pullRequestError = err instanceof Error ? err.message : String(err);
    warnings.push(`Open pull request check failed: ${pullRequestError}`);
  }

  if (repository) {
    try {
      milestones = await listMilestones(repository, { exec: options.exec, cwd: repoRoot ?? options.cwd });
    } catch (err: unknown) {
      milestoneError = err instanceof Error ? err.message : String(err);
      warnings.push(`Milestone inventory check failed: ${milestoneError}`);
    }
  }

  const worktree = getWorktreeStatus(repoRoot);
  const baseRef = getBaseRefStatus(options.config, repoRoot);
  const blockingPullRequests = pullRequests.filter(pr => !pr.ignored);
  if (options.config.noWorktree && worktree.isWorktree) {
    warnings.push('Linked git worktree detected. Use the primary checkout before starting issue work.');
  }
  if (!baseRef.resolved || !baseRef.upToDate) {
    warnings.push(`Base branch ${baseRef.remote}/${baseRef.branch} is ${baseRef.resolved ? 'not current locally' : 'not resolved'}. Update the local base branch from the configured remote before starting issue work.`);
  }
  if (options.config.blockOnOpenPRs && blockingPullRequests.length > 0) {
    warnings.push(`Open pull requests block new issue work: ${blockingPullRequests.map(pr => `#${pr.number}`).join(', ')}.`);
  }

  const configWillWrite = !configPresent && !options.dryRun && options.yes;
  if (!configPresent) {
    plannedChanges.push(`Write minimal Executor config to ${configPath}`);
    if (!options.yes) skippedActions.push('Config write requires --yes');
  }

  if (!options.dryRun && labelPlan && (labelPlan.created.length > 0 || labelPlan.updated.length > 0)) {
    await applyLabelPlan(labelPlan, options.exec);
    completedChanges.push('Created or updated Executor labels');
  }
  if (configWillWrite) {
    await writeMinimalConfig(configPath);
    completedChanges.push(`Wrote ${configPath}`);
  }

  return {
    ok: warnings.length === 0,
    repository,
    configPath,
    configPresent,
    configWillWrite,
    labelPlan,
    labelError,
    openIssueCount: openIssueError ? undefined : openIssues.length,
    openIssueError,
    pullRequests,
    blockingPullRequests,
    pullRequestError,
    worktree,
    baseRef,
    milestones,
    milestoneWarnings: findMilestoneWarnings(openIssues, options.config),
    milestoneError,
    instructions: getInstructionStatus(repoRoot, {
      reviewMode: reviewModeOf(options.config),
      localReviewAgents: options.config.localReviewAgents,
    }),
    planning: getPlanningStatus(repoRoot),
    plannedChanges,
    completedChanges,
    skippedActions,
    warnings,
  };
}
