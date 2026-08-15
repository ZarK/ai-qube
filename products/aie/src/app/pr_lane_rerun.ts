import type { Config } from '../config/index.js';
import { gitDeltaPathsSync, type LocalReviewLaneId, isLocalReviewLaneId } from '../local_review_evidence.js';
import { createReviewForgeProvider } from '../providers/review_forge_adapters.js';
import { activeLocalReviewFocusesForConfig } from '../review_focus.js';
import { runLocalReviewRunner } from './local_review_runner.js';
import type { PrGateExec } from './pr_gate.js';

export interface PrLaneRerunResult {
  ok: boolean;
  command: 'pr lane rerun';
  dryRun: boolean;
  prNumber: number;
  lane: string;
  headSha: string;
  executions: number;
  lanesRun: string[];
  reusedLanes: string[];
  errors: string[];
  nextAction: string;
}

export async function runPrLaneRerun(input: {
  config: Config;
  repoRoot: string;
  prNumber: number;
  lane: string;
  headSha: string;
  issueNumbers: readonly number[];
  dryRun?: boolean;
  exec?: PrGateExec;
  changedPaths?: readonly string[];
}): Promise<PrLaneRerunResult> {
  const dryRun = input.dryRun === true;
  if (!isLocalReviewLaneId(input.lane)) {
    return {
      ok: false,
      command: 'pr lane rerun',
      dryRun,
      prNumber: input.prNumber,
      lane: input.lane,
      headSha: input.headSha,
      executions: 0,
      lanesRun: [],
      reusedLanes: [],
      errors: [`Unknown review lane "${input.lane}".`],
      nextAction: 'Pass a configured lane id such as issue-compliance or code-quality.',
    };
  }
  const lane = input.lane as LocalReviewLaneId;
  const active = activeLocalReviewFocusesForConfig(input.config, input.changedPaths);
  if (!active.includes(lane)) {
    return {
      ok: false,
      command: 'pr lane rerun',
      dryRun,
      prNumber: input.prNumber,
      lane,
      headSha: input.headSha,
      executions: 0,
      lanesRun: [],
      reusedLanes: [],
      errors: [`Lane ${lane} is not active for the current change set.`],
      nextAction: `Choose an active lane (${active.join(', ') || 'none'}) and rerun \`aie pr lane rerun ${input.prNumber} <lane>\`.`,
    };
  }
  const runner = await runLocalReviewRunner(input.config, {
    repoRoot: input.repoRoot,
    issueNumbers: input.issueNumbers,
    prNumber: input.prNumber,
    headSha: input.headSha,
    required: true,
    shadow: false,
    dryRun,
    exec: input.exec,
    changedPaths: input.changedPaths,
    onlyLanes: [lane],
    forceLanes: [lane],
  });
  const lanesRun = [...new Set(runner.lanes.filter(item => item.evidenceSource === 'fresh-run' || item.status === 'planned').map(item => item.lane))];
  const reusedLanes = [...new Set(runner.lanes.filter(item => item.evidenceSource === 'local' || item.evidenceSource === 'trusted-provider').map(item => item.lane))];
  const executions = runner.lanes.filter(item => item.lane === lane && (item.evidenceSource === 'fresh-run' || item.status === 'planned')).length;
  const ok = runner.unavailable.length === 0 && executions === 1;
  return {
    ok,
    command: 'pr lane rerun',
    dryRun,
    prNumber: input.prNumber,
    lane,
    headSha: input.headSha,
    executions,
    lanesRun,
    reusedLanes,
    errors: ok ? [] : (runner.unavailable.length > 0 ? runner.unavailable : [`Lane ${lane} did not execute exactly once.`]),
    nextAction: ok
      ? `Reran ${lane} once. Rerun \`aie pr gate ${input.prNumber}\` to publish and inspect the current head.`
      : `Fix the lane runner error, then run \`aie pr lane rerun ${input.prNumber} ${lane}\` again.`,
  };
}

export async function runPrLaneRerunService(config: Config, options: {
  prNumber: number;
  lane: string;
  repoRoot: string;
  dryRun?: boolean;
  exec?: PrGateExec;
}): Promise<PrLaneRerunResult> {
  const provider = await createReviewForgeProvider(config.providers.review.kind, {
    exec: options.exec,
    cwd: options.repoRoot,
    reviewAgents: config.reviewAgents,
    publisher: config.providers.review.publisher ?? null,
    ...config.providers.connections[config.providers.review.kind],
    ...config.providers.review.connection,
  });
  const snapshot = await provider.loadPullRequestReview(options.prNumber);
  const changedPaths = gitDeltaPathsSync(options.repoRoot, `${config.baseRemote}/${config.baseBranch}`, 'HEAD');
  return runPrLaneRerun({
    config,
    repoRoot: options.repoRoot,
    prNumber: options.prNumber,
    lane: options.lane,
    headSha: snapshot.pr.headRefOid,
    issueNumbers: snapshot.closingIssueNumbers,
    dryRun: options.dryRun,
    exec: options.exec,
    changedPaths: changedPaths ?? undefined,
  });
}

export function formatPrLaneRerun(result: PrLaneRerunResult): string {
  const lines = [
    `PR lane rerun for #${result.prNumber} ${result.lane}: ${result.ok ? 'ok' : 'failed'}.`,
    `Executions: ${result.executions}.`,
    `Lanes run: ${result.lanesRun.join(', ') || 'none'}.`,
  ];
  for (const error of result.errors) lines.push(`- ${error}`);
  lines.push(`Next action: ${result.nextAction}`);
  return `${lines.join('\n')}\n`;
}
