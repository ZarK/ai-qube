import { renderAgentPrompt, type RenderedAgentPrompt } from '../agent_descriptors.js';
import { getCriterionIdentity, parseChecklist, planChecklistUpdate, type ChecklistItem, type ChecklistState, type ChecklistSummary, type CriterionIdentity } from '../checklist.js';
import { loadConfigFile, type Config } from '../config/index.js';
import { getIssue, ghFailureMessage, isGhExecutionError, runGh, type GhExec, type GitHubIssue } from '../providers/github_adapter_exports.js';
import { prepareCriterionEvidence, verifyPreparedCriterion, type CriterionEvidence, type CriterionEvidenceContext } from './criterion_evidence.js';
import { criterionRepository, isRecord } from './criterion_inputs.js';

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
  dryRun: boolean;
  promptOnly: boolean;
  cwd?: string;
  exec?: GhExec;
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
  // Acceptance can reuse ordinary inspection and recorded gate evidence. Host review
  // orchestration and independent-review descriptors are not this command's role.
  const promptStack = rendered.promptStack.filter(fragment => fragment.id.startsWith('safety/') || fragment.id === 'acceptance/verify-criterion');
  const outputContract = 'Return acceptance verification evidence JSON for exactly this issue checklist criterion.';
  const text = [
    ...promptStack.map(fragment => `## ${fragment.id}\n${fragment.text}`),
    `Issue #${issue.number}: ${issue.title}`,
    `Criterion #${criterion.index}: ${criterion.text}`,
    pr ? `Current PR: #${pr.number}; head ${pr.headSha}` : 'No PR exists. Record the current Git revision and relevant file hashes.',
    'If a PR exists, reuse its exact criterion-to-proof entry.',
    'Choose source inspection, direct observation, an existing gate result, or an existing prompted review.',
    'For a test result, name the configured gate and include its evidence file as a hashed artifact.',
    'List every required source, test, configuration, dependency, and observation file with its SHA-256.',
    'Record the current PR revision or the current work snapshot.',
    'Record the actual observation and a UTC timestamp. Do not invent execution or review evidence.',
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

async function inspectProof(options: ChecklistVerifyOptions, identity: CriterionIdentity, pr: ChecklistVerifyPrContext | null): Promise<{ evidence: CriterionEvidence; sha256: string | null; proofKind?: string }> {
  let repository: ReturnType<typeof criterionRepository>;
  try { repository = criterionRepository(options.cwd ?? process.cwd()); }
  catch (error: unknown) {
    const cause = error instanceof Error ? error.message : String(error);
    return {
      evidence: { path: options.evidencePath ?? null, status: 'inconclusive', recommendation: null, summary: 'The current repository revision could not be reproduced.', errors: [`Current Git snapshot is unavailable: ${cause}`], snapshot: null },
      sha256: null,
    };
  }
  const context: CriterionEvidenceContext = { path: options.evidencePath, ...repository, criterion: identity, pr };
  const prepared = prepareCriterionEvidence(context);
  if (prepared.result.errors.length) return { evidence: prepared.result, sha256: prepared.sha256 };
  const proof = prepared.record?.proof;
  const config = isRecord(proof) && proof.kind === 'test-result' ? await evidenceConfig(options) : null;
  const evidence = verifyPreparedCriterion(prepared, context, config);
  return { evidence, sha256: prepared.sha256, proofKind: isRecord(proof) && typeof proof.kind === 'string' ? proof.kind : undefined };
}

export async function verifyIssueChecklist(options: ChecklistVerifyOptions): Promise<ChecklistVerifyResult> {
  if (options.state !== 'checked') throw new Error('Checklist verification only supports state checked; use checklist update for unchecked maintenance.');
  let issue = await getIssue(options.issueNumber, { cwd: options.cwd, exec: options.exec });
  let checklist = parseChecklist(issue.body);
  const criterion = selectCriterion(checklist, options.index);
  const identity = getCriterionIdentity(issue.number, criterion);
  let pr = await currentPrContext(options.cwd, options.exec);
  const prompt = buildPrompt(issue, criterion, pr);
  let evidence: CriterionEvidence = { path: options.evidencePath ?? null, status: 'missing', recommendation: null, summary: 'Prompt rendered; no proof was validated.', errors: [], snapshot: null };
  let plan: ReturnType<typeof planChecklistUpdate> | null = null;
  if (!options.promptOnly) {
    const initial = await inspectProof(options, identity, pr);
    evidence = initial.evidence;
    if (evidence.status === 'verified') {
      pr = await currentPrContext(options.cwd, options.exec);
      const config = initial.proofKind === 'test-result' ? await evidenceConfig(options) : null;
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
          const context: CriterionEvidenceContext = { path: options.evidencePath, ...repository, criterion: identity, pr };
          const current = prepareCriterionEvidence(context);
          if (current.sha256 !== initial.sha256) current.result.errors.push('The evidence document changed during verification.');
          evidence = verifyPreparedCriterion(current, context, config);
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
    `Mutation: ${result.mutation.description}`,
    `Next action: ${result.nextAction}`,
  ].join('\n');
}
