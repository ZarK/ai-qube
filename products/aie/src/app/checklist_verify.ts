import { renderAgentPrompt, type RenderedAgentPrompt } from '../agent_descriptors.js';
import { getCriterionIdentity, parseChecklist, planChecklistUpdate, type ChecklistItem, type ChecklistState, type ChecklistSummary, type CriterionIdentity } from '../checklist.js';
import { loadConfigFile, type Config } from '../config/index.js';
import { getIssue, ghFailureMessage, isGhExecutionError, runGh, type GhExec, type GitHubIssue } from '../providers/github_adapter_exports.js';
import { prepareCriterionEvidence, verifyPreparedCriterion, type CriterionEvidence, type CriterionEvidenceContext, type ExecutionReference } from './criterion_evidence.js';
import { captureCriterionExecution } from './criterion_execution.js';
import { criterionRepository, currentInputDigest, isRecord } from './criterion_inputs.js';
import { changedReviewPaths, type PrGateExec } from './pr_gate.js';

export interface ChecklistVerifyIssue { number: number; title: string; state: GitHubIssue['state']; url: string }
export interface ChecklistVerifyPrContext { number: number; title: string; url: string; headSha: string; body: string }
export type ChecklistVerifyEvidence = CriterionEvidence;
export type ChecklistVerifyPrompt = Pick<RenderedAgentPrompt, 'category' | 'promptStack' | 'text' | 'outputContract'>;
export interface ChecklistVerifyResult {
  ok: boolean;
  command: 'checklist verify';
  issue: ChecklistVerifyIssue;
  dryRun: boolean;
  promptOnly: boolean;
  state: ChecklistState;
  criterion: ChecklistItem;
  identity: CriterionIdentity;
  checklist: ChecklistSummary;
  pr: ChecklistVerifyPrContext | null;
  prompt: ChecklistVerifyPrompt;
  evidence: ChecklistVerifyEvidence;
  mutation: { status: 'planned' | 'completed' | 'skipped' | 'blocked'; description: string };
  nextAction: string;
}
export interface ChecklistVerifyOptions {
  issueNumber: number;
  index: number | undefined;
  state: ChecklistState;
  evidencePath?: string;
  runGate?: string;
  dryRun: boolean;
  promptOnly: boolean;
  cwd?: string;
  exec?: GhExec;
  commandExec?: PrGateExec;
  config?: Config;
}

function issueSummary(issue: GitHubIssue): ChecklistVerifyIssue {
  return { number: issue.number, title: issue.title, state: issue.state, url: issue.url };
}

function selectCriterion(summary: ChecklistSummary, index: number | undefined): ChecklistItem {
  if (!Number.isInteger(index) || index === undefined || index <= 0) throw new Error('Acceptance verification requires a positive checklist index. Run `aie view <issue>` and pass --index <n>.');
  const match = summary.items.find(item => item.index === index);
  if (!match) throw new Error(`Checklist criterion #${index} does not exist. Run \`aie view <issue>\` and select an existing index.`);
  return match;
}

async function currentPrContext(cwd?: string, exec?: GhExec): Promise<ChecklistVerifyPrContext | null> {
  const args = ['pr', 'view', '--json', 'number,title,url,headRefOid,body'];
  let result: Awaited<ReturnType<typeof runGh>>;
  try { result = await runGh(args, { cwd, exec }); }
  catch (error: unknown) {
    if (isGhExecutionError(error) && /no pull requests? found for branch/i.test(`${error.stderr ?? ''} ${error.message}`)) return null;
    throw error;
  }
  if (result.exitCode !== 0) {
    if (/no pull requests? found for branch/i.test(result.stderr || result.stdout)) return null;
    throw new Error(ghFailureMessage(`gh ${args.join(' ')}`, result.exitCode, result.stderr || result.stdout));
  }
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout); }
  catch { throw new Error(`Failed to parse current PR context. Next action: inspect \`gh ${args.join(' ')}\` and retry.`); }
  if (!isRecord(parsed) || !Number.isSafeInteger(parsed.number) || Number(parsed.number) < 1 || typeof parsed.title !== 'string' || typeof parsed.url !== 'string' || typeof parsed.headRefOid !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(parsed.headRefOid) || typeof parsed.body !== 'string') throw new Error('Failed to validate current PR context from gh pr view. Required PR identity, full head SHA, or body is missing. Inspect the PR and retry.');
  return { number: Number(parsed.number), title: parsed.title, url: parsed.url, headSha: parsed.headRefOid, body: parsed.body };
}

export function evidenceJsonTemplate(issue: GitHubIssue, criterion: ChecklistItem, pr: ChecklistVerifyPrContext | null): string {
  return `${JSON.stringify({
    version: 1,
    criterion: getCriterionIdentity(issue.number, criterion),
    revision: pr ? { kind: 'pr', headSha: pr.headSha } : { kind: 'work-snapshot', headSha: '<current-git-head>', sha256: '<relevant-input-snapshot-sha256>' },
    criterionToProof: `## Criterion-to-proof map\n\n### Criterion ${criterion.index}: ${criterion.text}\n- Implemented at: [UNFILLED: cite required source files]\n- Proven by: [UNFILLED: cite suitable inspection, test, or observation]\n- Negative case: [UNFILLED: cite the counterexample or explain why none applies]`,
    inputs: [{ kind: 'source', path: '<repository-relative-file>', sha256: '<file-sha256>' }],
    artifacts: [],
    proof: { kind: 'source-inspection', observation: '<actual criterion-specific observation>' },
    recommendation: 'approve',
    recordedAt: '<utc-iso-timestamp>',
  }, null, 2)}\n`;
}

function buildPrompt(issue: GitHubIssue, criterion: ChecklistItem, pr: ChecklistVerifyPrContext | null): ChecklistVerifyPrompt {
  const rendered = renderAgentPrompt({ hostId: 'codex', descriptorId: 'qa-reviewer', categoryId: 'acceptance-verification' });
  // Acceptance can reuse ordinary inspection and execution evidence. Host review
  // orchestration and independent-review descriptors are not this command's role.
  const promptStack = rendered.promptStack.filter(fragment => fragment.id.startsWith('safety/') || fragment.id === 'acceptance/verify-criterion');
  const outputContract = 'Return acceptance verification evidence JSON for exactly this issue checklist criterion.';
  const text = [
    ...promptStack.map(fragment => `## ${fragment.id}\n${fragment.text}`),
    `Issue #${issue.number}: ${issue.title}`,
    `Criterion #${criterion.index}: ${criterion.text}`,
    pr ? `Current PR: #${pr.number}; head ${pr.headSha}` : 'No PR: bind a reproducible current work snapshot.',
    'Reuse the existing criterion-to-proof entry and evidence appropriate to it. A separate evidence plan, reviewer, or approval is not required.',
    'Use source-inspection for inspected structural requirements; direct-observation needs an artifact; test-result needs the cited test inputs and an observed execution receipt. Prompted-review must reference an existing trusted issue-compliance review and its exact executed prompt stack.',
    'List every source, test, configuration, and dependency input needed by the proof with its SHA-256. File citations and descriptive text never prove that a command ran.',
    'Keep criterionToProof equal to the selected existing PR entry. Before a PR, retain that same Markdown entry in the evidence document.',
    'Use --dry-run --json to inspect the current relevant-input snapshot. A missing or stale snapshot remains inconclusive and never skips revision validation.',
    'For test-result proof, set proof.gateName to the suitable configured gate and proof.execution to {path,sha256} for an existing trusted execution receipt. Use --run-gate <name> only when a new observed run of that same gate is needed; dry-run and prompt-only never run commands. The result reports evidence.execution for reuse.',
    'Evidence timestamps use UTC ISO form YYYY-MM-DDTHH:mm:ss.sssZ. Record the inspected inputs and actual result; never invent execution or independent-review provenance.',
    evidenceJsonTemplate(issue, criterion, pr),
    `Issue body:\n${issue.body}`,
    outputContract,
  ].join('\n\n');
  return { category: rendered.category, promptStack, outputContract, text };
}

async function evidenceConfig(options: ChecklistVerifyOptions): Promise<Config | null> {
  if (options.config) return options.config;
  const loaded = await loadConfigFile(options.cwd);
  return loaded.config ?? null;
}

async function inspectProof(options: ChecklistVerifyOptions, identity: CriterionIdentity, pr: ChecklistVerifyPrContext | null, issueText: string): Promise<{ evidence: CriterionEvidence; sha256: string | null; captured?: ExecutionReference; proofKind?: string; repoRoot?: string }> {
  let repository: ReturnType<typeof criterionRepository>;
  try { repository = criterionRepository(options.cwd ?? process.cwd()); }
  catch (error: unknown) {
    const cause = error instanceof Error ? error.message : String(error);
    return {
      evidence: { path: options.evidencePath ?? null, status: 'inconclusive', recommendation: null, summary: 'The current repository revision could not be reproduced.', errors: [`Current Git snapshot is unavailable: ${cause}`], snapshot: null, execution: null },
      sha256: null,
    };
  }
  let context: CriterionEvidenceContext = { path: options.evidencePath, ...repository, criterion: identity, pr, issueText };
  const prepared = prepareCriterionEvidence(context);
  if (prepared.result.errors.length) return { evidence: prepared.result, sha256: prepared.sha256 };
  const proof = prepared.record?.proof;
  const usesConfig = isRecord(proof) && (proof.kind === 'test-result' || proof.kind === 'prompted-review');
  const config = usesConfig ? await evidenceConfig(options) : null;
  if (isRecord(proof) && proof.kind === 'prompted-review' && config) {
    context = { ...context, changedPaths: await changedReviewPaths(config, repository.repoRoot) };
  }
  let captured: ExecutionReference | undefined;
  if (options.runGate && !options.dryRun && !options.promptOnly) {
    if (!isRecord(proof) || proof.kind !== 'test-result') prepared.result.errors.push('--run-gate is only applicable to a test-result proof.');
    else if (options.runGate !== proof.gateName) prepared.result.errors.push('--run-gate must match the configured gate named by this criterion proof.');
    else if (!config) prepared.result.errors.push('A valid repository configuration is required to capture a configured gate.');
    else {
      try {
        captured = await captureCriterionExecution({ repoRoot: repository.repoRoot, config, gateName: options.runGate, headSha: repository.headSha, inputs: prepared.inputs, readInputDigest: () => currentInputDigest(repository.repoRoot, prepared.inputs), exec: options.commandExec });
      } catch (error: unknown) {
        const cause = error instanceof Error ? error.message : String(error);
        prepared.result.errors.push(`Configured gate execution is inconclusive: ${cause}`);
      }
    }
  }
  const evidence = verifyPreparedCriterion(prepared, context, config, captured);
  return { evidence, sha256: prepared.sha256, captured, proofKind: isRecord(proof) && typeof proof.kind === 'string' ? proof.kind : undefined, repoRoot: repository.repoRoot };
}

export async function verifyIssueChecklist(options: ChecklistVerifyOptions): Promise<ChecklistVerifyResult> {
  if (options.state !== 'checked') throw new Error('Checklist verification only supports state checked; use checklist update for unchecked maintenance.');
  let issue = await getIssue(options.issueNumber, { cwd: options.cwd, exec: options.exec });
  let checklist = parseChecklist(issue.body);
  const criterion = selectCriterion(checklist, options.index);
  const identity = getCriterionIdentity(issue.number, criterion);
  let pr = await currentPrContext(options.cwd, options.exec);
  const prompt = buildPrompt(issue, criterion, pr);
  let evidence: CriterionEvidence = { path: options.evidencePath ?? null, status: 'missing', recommendation: null, summary: 'Prompt rendered; no proof was validated.', errors: [], snapshot: null, execution: null };
  let plan: ReturnType<typeof planChecklistUpdate> | null = null;
  if (!options.promptOnly) {
    const initial = await inspectProof(options, identity, pr, `${issue.title}\n\n${issue.body}`);
    evidence = initial.evidence;
    if (evidence.status === 'verified') {
      pr = await currentPrContext(options.cwd, options.exec);
      const usesConfig = initial.proofKind === 'test-result' || initial.proofKind === 'prompted-review';
      const config = usesConfig ? await evidenceConfig(options) : null;
      const changedPaths = initial.proofKind === 'prompted-review' && config && initial.repoRoot ? await changedReviewPaths(config, initial.repoRoot) : undefined;
      issue = await getIssue(options.issueNumber, { cwd: options.cwd, exec: options.exec });
      checklist = parseChecklist(issue.body);
      const latest = checklist.items.find(item => item.index === identity.index);
      if (issue.number !== identity.issueNumber || !latest || latest.text !== identity.text) {
        evidence = { ...evidence, status: 'inconclusive', errors: ['The selected criterion changed during verification; refresh its identity and proof before retrying.'] };
      } else {
        let repository: ReturnType<typeof criterionRepository> | null = null;
        try { repository = criterionRepository(options.cwd ?? process.cwd()); }
        catch (error: unknown) {
          const cause = error instanceof Error ? error.message : String(error);
          evidence = { ...evidence, status: 'inconclusive', summary: 'The current repository revision could not be reproduced.', errors: [`Current Git snapshot is unavailable during final validation: ${cause}`], snapshot: null };
        }
        if (repository) {
          const context: CriterionEvidenceContext = { path: options.evidencePath, ...repository, criterion: identity, pr, issueText: `${issue.title}\n\n${issue.body}`, changedPaths };
          const current = prepareCriterionEvidence(context);
          if (current.sha256 !== initial.sha256) current.result.errors.push('The evidence document changed during verification.');
          evidence = verifyPreparedCriterion(current, context, config, initial.captured);
          if (evidence.status === 'verified') plan = planChecklistUpdate(issue.body, { index: identity.index }, 'checked');
        }
      }
    }
  }
  if (plan?.changed && !options.dryRun) {
    const written = await runGh(['issue', 'edit', String(issue.number), '--body', plan.updatedBody], { cwd: options.cwd, exec: options.exec });
    if (written.exitCode !== 0) throw new Error(ghFailureMessage('gh issue edit', written.exitCode, written.stderr || written.stdout));
  }
  const status = options.promptOnly ? 'skipped' : !plan ? 'blocked' : !plan.changed ? 'skipped' : options.dryRun ? 'planned' : 'completed';
  const remaining = plan?.after.unchecked ?? checklist.unchecked;
  return {
    ok: status !== 'blocked', command: 'checklist verify', issue: issueSummary(issue), dryRun: options.dryRun, promptOnly: options.promptOnly, state: options.state,
    criterion, identity, checklist, pr, prompt, evidence,
    mutation: { status, description: status === 'completed' ? `Checked criterion #${identity.index} on issue #${identity.issueNumber}.` : status === 'planned' ? `Would check criterion #${identity.index} on issue #${identity.issueNumber}.` : status === 'blocked' ? 'No checkbox was changed because criterion proof was not verified.' : 'No provider update was needed.' },
    nextAction: status === 'blocked' ? 'Resolve the specific proof errors, then rerun checklist verify with current criterion evidence.' : remaining > 0 ? 'Verify the next unchecked criterion one checkbox at a time.' : `Run \`aie complete ${issue.number} --check-only\` after the pull request is merged.`,
  };
}

export function formatChecklistVerify(result: ChecklistVerifyResult): string {
  if (result.promptOnly) return result.prompt.text;
  return [
    `Checklist verification for issue #${result.issue.number} criterion #${result.criterion.index}: ${result.mutation.status}.`,
    `Criterion: ${result.criterion.text}`,
    `PR head: ${result.pr?.headSha ?? 'no PR; work snapshot required'}`,
    `Evidence: ${result.evidence.status}; ${result.evidence.summary}`,
    ...result.evidence.errors.map(error => `- ${error}`),
    ...(result.evidence.execution ? [`Execution receipt: ${result.evidence.execution.path}`] : []),
    `Mutation: ${result.mutation.description}`,
    `Next action: ${result.nextAction}`,
  ].join('\n');
}
