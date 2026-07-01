import type { RuntimeCommandHandler } from '@tjalve/qube-cli/runtime';
import { buildPrBodyService, formatPrBody, parsePrBodyIssueNumber } from './app/pr_body.js';
import { formatChecklistVerify, verifyIssueChecklist } from './app/checklist_verify.js';
import { formatChecklistUpdate, updateIssueChecklist } from './app/issue_checklist.js';
import { formatPrGate, parsePrNumber, runPrGateService } from './app/pr_gate.js';
import { formatPrReviewPublish, runPrReviewPublishService } from './app/pr_review_publish.js';
import { formatPrView, runPrViewService } from './app/pr_view.js';
import { buildStatus, createStatusContext } from './app/status_service.js';
import { formatUiAudit, parseAuditIssueNumber, runUiAudit } from './audit.js';
import { runBranchCommand } from './branch.js';
import { branchCommandError, formatBranchResult, parseBranchIssue, shouldShowBranchHelp, usage as branchUsage, usageJson as branchUsageJson } from './branch_command.js';
import { commandDescription, commandExamples, isHelpToken } from './command_metadata.js';
import { completeIssue } from './complete/index.js';
import { getDefaults, loadConfig, loadConfigFile, type ValidationError } from './config/index.js';
import { buildDoctorDiagnostics } from './doctor.js';
import { buildGatePlan, buildGateStatus, formatGatePlan, formatGateStatus, isGateStage } from './gates/index.js';
import { runInit } from './init/index.js';
import { parseLifecycleIssueSelection } from './lifecycle.js';
import { buildMigrationMap, formatMigrationMap, formatMigrationPlan, runMigration } from './migrate/index.js';
import { computeQueue, getNextIssue } from './queue/index.js';
import { buildRepoPrimePlan } from './repo/index.js';
import { formatDoctorHuman } from './renderers/doctor_renderer.js';
import { formatInitHuman } from './renderers/init_renderer.js';
import { formatCompleteHuman, formatStartHuman, formatSwitchHuman } from './renderers/lifecycle_renderer.js';
import { formatRepoPrimeHuman } from './renderers/repo_renderer.js';
import { formatStatusHuman } from './renderers/status_renderer.js';
import { formatViewHuman } from './renderers/view_renderer.js';
import { COMPREHENSIVE_LOCAL_REVIEW_LANES, type LocalReviewLaneId } from './local_review_evidence.js';
import { formatReviewGate, parseReviewIssueNumber, runReviewGate } from './review.js';
import { startIssue } from './start/index.js';
import { switchIssue } from './switch/index.js';
import { viewIssue } from './view.js';
import { commandFailure, commandResult, numberFlag, readBooleanFlag, stringArg, stringFlag, stringListFlag } from './runtime_result.js';
import { policyFromRuntimeFlags } from './runtime_init_policy.js';
import { handleDepsFix } from './runtime_deps_fix.js';
import { handleDepsBlocked, handleDepsBlockers, handleDepsBlocking, handleDepsChain, handleDepsGraph, handleDepsReady } from './runtime_deps_handlers.js';
import { handleLabelsSetup } from './runtime_labels_setup.js';
import { handleSchema } from './runtime_schema.js';
import { handleRunStart, handleRunStatus, handleRunStop, handleRunWait } from './runtime_run_handlers.js';
function formatConfigErrors(errors: ValidationError[]): string { return errors.map(error => `${error.path}: ${error.message}`).join('\n'); }
function lineOutput(lines: string[]): string { return `${lines.join('\n')}\n`; }
function workDisplayId(issue: { number: number | null; displayId?: string }): string {
  return issue.displayId ?? (issue.number === null ? 'unknown work item' : `#${issue.number}`);
}
function parseIssueNumber(input: string | undefined, command: string, role = 'issue'): number {
  if (!input || isHelpToken(input)) throw new Error(`Missing ${role} number.`);
  const cleaned = input.replace(/^#/, '').trim();
  if (!/^[1-9]\d*$/.test(cleaned)) throw new Error(`Invalid ${role} selector "${input}". Use a positive number such as 93 or shell-safe #93.`);
  const issueNumber = Number(cleaned);
  if (!Number.isSafeInteger(issueNumber)) throw new Error(`Invalid ${role} selector "${input}". Use a safe positive integer.`);
  return issueNumber;
}

function topic(lines: string[]): RuntimeCommandHandler {
  return () => ({ stdout: lineOutput(lines) });
}

function usageResult(context: Parameters<RuntimeCommandHandler>[0], command: string, usage: string, lines: string[]) {
  return commandResult(context, { ok: true, command, usage, examples: commandExamples(command) }, lineOutput(lines));
}

function configLoadFailure(context: Parameters<RuntimeCommandHandler>[0], command: string, loaded: { errors: ValidationError[] }, nextAction: string) {
  return commandFailure(context, { ok: false, command, errors: loaded.errors, nextAction }, `Failed to load trusted Executor config:\n${formatConfigErrors(loaded.errors)}\nNext action: ${nextAction}`);
}
async function handleStart(context: Parameters<RuntimeCommandHandler>[0]) {
  const issue = stringArg(context, 'issue');
  const examples = commandExamples('start');
  if (!issue || isHelpToken(issue)) {
    return usageResult(context, 'start', 'aie start [next|<issue>]', [
      'Usage: aie start [next|<issue>]',
      commandDescription('start'),
      '',
      'Behavior:',
      '  aie start shows this usage; aie start next resumes the single active issue before selecting ready work.',
      '  aie start <issue> starts one specific issue only when blockers and active-issue rules allow it.',
      '  Starting new work is blocked by linked worktrees, blocking open pull requests, or stale base branch state.',
      '',
      'Examples:',
      ...examples.map(example => `  ${example}`),
    ]);
  }
  let selection: ReturnType<typeof parseLifecycleIssueSelection>;
  try {
    selection = parseLifecycleIssueSelection(issue);
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    const message = `Failed to parse start selector. Likely cause: ${cause}. Next action: run \`aie start next\`, \`aie start 93\`, or \`aie start --help\`.`;
    return commandFailure(context, { ok: false, command: 'start', error: message }, message);
  }
  try {
    const result = await startIssue({
      selection,
      dryRun: readBooleanFlag(context, 'dry-run'),
      assign: readBooleanFlag(context, 'assign', true),
      comment: readBooleanFlag(context, 'comment', true),
    });
    return commandResult(context, result, formatStartHuman(result), result.ok ? 0 : 1);
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    const message = `Failed to run \`aie start\`. Likely cause: ${cause}. Next action: verify GitHub authentication, issue state, repository config, and rerun \`aie start ${issue ?? 'next'} --dry-run\`.`;
    return commandFailure(context, { ok: false, command: 'start', error: message }, message);
  }
}

async function handleComplete(context: Parameters<RuntimeCommandHandler>[0]) {
  const issue = stringArg(context, 'issue');
  const examples = commandExamples('complete');
  if (!issue || isHelpToken(issue)) {
    return usageResult(context, 'complete', 'aie complete <issue> [--check-only] [--dry-run] [--force] [--json]', [
      'Usage: aie complete <issue> [--check-only] [--dry-run] [--force] [--json]',
      commandDescription('complete'),
      '',
      'Behavior:',
      '  aie complete <issue> runs after a pull request has merged, even when the PR already closed the issue.',
      '  --check-only verifies checklist and completion readiness without mutating GitHub.',
      '  --dry-run shows status cleanup, close, and dependent refresh actions without applying them.',
      '  --force permits completion with unchecked checklist items when repository policy allows it.',
      '',
      'Examples:',
      ...examples.map(example => `  ${example}`),
    ]);
  }
  let issueNumber: number;
  try {
    issueNumber = parseIssueNumber(issue, 'complete');
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    const message = `Failed to parse complete selector. Likely cause: ${cause}. Next action: run \`aie complete 93 --check-only\`, \`aie complete 93 --dry-run\`, or \`aie complete --help\`.`;
    return commandFailure(context, { ok: false, command: 'complete', error: message }, message);
  }
  try {
    const result = await completeIssue({ issueNumber, dryRun: readBooleanFlag(context, 'dry-run'), checkOnly: readBooleanFlag(context, 'check-only'), force: readBooleanFlag(context, 'force') });
    return commandResult(context, result, formatCompleteHuman(result), result.ok ? 0 : 1);
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    const message = `Failed to run \`aie complete\`. Likely cause: ${cause}. Next action: verify GitHub authentication, issue state, repository config, and rerun \`aie complete ${issue} --check-only\`.`;
    return commandFailure(context, { ok: false, command: 'complete', error: message }, message);
  }
}

function parseChecklistState(input: string | undefined): 'checked' | 'unchecked' {
  if (input === undefined) return 'checked';
  if (input === 'checked' || input === 'unchecked') return input;
  throw new Error(`Invalid checklist state "${input}". Use checked or unchecked.`);
}

async function handleChecklistUpdate(context: Parameters<RuntimeCommandHandler>[0]) {
  const issue = stringArg(context, 'issue');
  if (isHelpToken(issue)) return usageResult(context, 'checklist update', 'aie checklist update <issue> [--item <text>|--index <n>] [--state checked|unchecked] [--dry-run] [--json]', [
    'Usage: aie checklist update <issue> [--item <text>|--index <n>] [--state checked|unchecked] [--dry-run] [--json]',
    commandDescription('checklist update'),
    '',
    'Behavior:',
    '  Updates one GitHub issue task-list checkbox in the issue body while preserving unrelated text.',
    '  Use --item for exact unique checklist text or --index for a 1-based checklist item index.',
    '  --dry-run shows the planned body mutation without editing the issue.',
    '',
    'Examples:',
    ...commandExamples('checklist update').map(example => `  ${example}`),
  ]);
  let issueNumber: number;
  let state: 'checked' | 'unchecked';
  try {
    issueNumber = parseIssueNumber(issue, 'checklist update');
    state = parseChecklistState(stringFlag(context, 'state'));
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    const message = `Failed to parse checklist update. Likely cause: ${cause}. Next action: run \`aie checklist update 93 --index 1 --dry-run\` or \`aie checklist update --help\`.`;
    return commandFailure(context, { ok: false, command: 'checklist update', error: message }, message);
  }
  try {
    const result = await updateIssueChecklist({
      issueNumber,
      selector: { index: numberFlag(context, 'index'), text: stringFlag(context, 'item') },
      state,
      dryRun: readBooleanFlag(context, 'dry-run'),
    });
    return commandResult(context, result, formatChecklistUpdate(result));
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    const message = `Failed to update checklist for issue #${issueNumber}. Likely cause: ${cause}. Next action: run \`aie view ${issueNumber}\`, choose an unambiguous checklist selector, then rerun with --dry-run.`;
    return commandFailure(context, { ok: false, command: 'checklist update', issue: issueNumber, error: message }, message);
  }
}

async function handleChecklistVerify(context: Parameters<RuntimeCommandHandler>[0]) {
  const issue = stringArg(context, 'issue');
  if (isHelpToken(issue)) return usageResult(context, 'checklist verify', 'aie checklist verify <issue> --index <n> [--prompt|--dry-run|--evidence <path>] [--state checked] [--json]', [
    'Usage: aie checklist verify <issue> --index <n> [--prompt|--dry-run|--evidence <path>] [--state checked] [--json]',
    commandDescription('checklist verify'),
    '',
    'Behavior:',
    '  Renders or validates evidence for exactly one acceptance checklist criterion.',
    '  --prompt prints a criterion-specific verifier prompt without mutating GitHub.',
    '  --evidence validates a JSON evidence file before checking the selected criterion.',
    '  --dry-run validates and plans the single checkbox mutation without editing the issue.',
    '',
    'Examples:',
    ...commandExamples('checklist verify').map(example => `  ${example}`),
  ]);
  let issueNumber: number;
  try {
    issueNumber = parseIssueNumber(issue, 'checklist verify');
    const state = stringFlag(context, 'state');
    if (state !== undefined && state !== 'checked') throw new Error('checklist verify only supports --state checked.');
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    const message = `Failed to parse checklist verification. Likely cause: ${cause}. Next action: run \`aie checklist verify 93 --index 1 --prompt\` or \`aie checklist verify --help\`.`;
    return commandFailure(context, { ok: false, command: 'checklist verify', error: message }, message);
  }
  try {
    const result = await verifyIssueChecklist({
      issueNumber,
      index: numberFlag(context, 'index'),
      state: 'checked',
      evidencePath: stringFlag(context, 'evidence'),
      dryRun: readBooleanFlag(context, 'dry-run'),
      promptOnly: readBooleanFlag(context, 'prompt'),
    });
    return commandResult(context, result, formatChecklistVerify(result), result.ok ? 0 : 1);
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    const message = `Failed to verify checklist criterion for issue #${issueNumber}. Likely cause: ${cause}. Next action: run \`aie checklist verify ${issueNumber} --index <n> --prompt\`, collect evidence, then rerun with --evidence.`;
    return commandFailure(context, { ok: false, command: 'checklist verify', issue: issueNumber, error: message }, message);
  }
}

async function handleSwitch(context: Parameters<RuntimeCommandHandler>[0]) {
  const issue = stringArg(context, 'issue');
  const examples = commandExamples('switch');
  if (!issue || isHelpToken(issue)) {
    return usageResult(context, 'switch', 'aie switch <issue> [--from <issue>]', [
      'Usage: aie switch <issue> [--from <issue>]',
      commandDescription('switch'),
      '',
      'Behavior:',
      '  aie switch <issue> pauses the current S-InProgress issue and starts the target issue.',
      '  Without --from, exactly one S-InProgress source issue must be present.',
      '  With --from, the named source issue must be S-InProgress and no unrelated issue can remain active.',
      '  Switching to new work is blocked by target blockers, linked worktrees, blocking open pull requests, or stale base branch state.',
      '',
      'Examples:',
      ...examples.map(example => `  ${example}`),
    ]);
  }
  let targetIssueNumber: number;
  let fromIssueNumber: number | undefined;
  try {
    targetIssueNumber = parseIssueNumber(issue, 'switch', 'target issue');
    const from = stringFlag(context, 'from');
    fromIssueNumber = from === undefined ? undefined : parseIssueNumber(from, 'switch', 'source issue');
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    const message = `Failed to parse switch selector. Likely cause: ${cause}. Next action: run \`aie switch 93\`, \`aie switch 93 --from 92\`, or \`aie switch --help\`.`;
    return commandFailure(context, { ok: false, command: 'switch', error: message }, message);
  }
  try {
    const result = await switchIssue({ targetIssueNumber, fromIssueNumber, dryRun: readBooleanFlag(context, 'dry-run'), assign: readBooleanFlag(context, 'assign', true), comment: readBooleanFlag(context, 'comment', true) });
    return commandResult(context, result, formatSwitchHuman(result), result.ok ? 0 : 1);
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    const message = `Failed to run \`aie switch\`. Likely cause: ${cause}. Next action: verify GitHub authentication, issue state, repository config, and rerun \`aie switch ${issue} --dry-run\`.`;
    return commandFailure(context, { ok: false, command: 'switch', error: message }, message);
  }
}

async function handleBranch(context: Parameters<RuntimeCommandHandler>[0], command: 'branch suggest' | 'branch check' | 'branch create') {
  const issue = stringArg(context, 'issue');
  if (shouldShowBranchHelp(issue)) return commandResult(context, branchUsageJson(command, commandExamples(command)), branchUsage(command, commandExamples(command)));
  try {
    const result = await runBranchCommand({ command, issueNumber: parseBranchIssue(issue ?? ''), dryRun: readBooleanFlag(context, 'dry-run') });
    return commandResult(context, result, formatBranchResult(result), result.ok ? 0 : 1);
  } catch (err: unknown) {
    const message = branchCommandError(command, issue, err);
    return commandFailure(context, { ok: false, command, error: message }, message);
  }
}

async function handleView(context: Parameters<RuntimeCommandHandler>[0]) {
  const issue = stringArg(context, 'issue');
  if (isHelpToken(issue)) return usageResult(context, 'view', 'aie view <issue>', ['Usage: aie view <issue>', commandDescription('view'), '', 'Examples:', ...commandExamples('view').map(example => `  ${example}`)]);
  let issueNumber: number;
  try {
    issueNumber = parseIssueNumber(issue, 'view');
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    const message = issue ? `Failed to run \`aie view\`. Likely cause: invalid issue number ${issue}: ${cause}. Next action: provide a positive issue number such as \`aie view 93\` or \`aie view #93\`.` : 'Failed to run `aie view`. Likely cause: missing issue number argument. Next action: run `aie view <issue>` with a bare number or shell-safe form such as `aie view 93` or `aie view #93`.';
    return commandFailure(context, { ok: false, command: 'view', error: message, usage: 'aie view <issue>', examples: commandExamples('view') }, message);
  }
  try {
    const result = await viewIssue(issueNumber);
    return commandResult(context, { command: 'view', ...result }, formatViewHuman(result));
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    const message = `Failed to load issue context for #${issueNumber}. Likely cause: ${cause}. Next action: verify the issue number, repository access, and GitHub authentication, then retry \`aie view ${issueNumber}\`.`;
    return commandFailure(context, { ok: false, command: 'view', issue: issueNumber, error: message }, message);
  }
}

async function handleInit(context: Parameters<RuntimeCommandHandler>[0]) {
  const target = stringArg(context, 'target');
  if (!target || isHelpToken(target)) {
    return usageResult(context, 'init', 'aie init <target> [--tool opencode|codex|claude-code|all] [--defaults] [--yes] [--dry-run] [--force] [--json]', [
      'Usage: aie init <target> [--tool opencode|codex|claude-code|all] [--defaults] [--yes] [--dry-run] [--force] [--json]',
      commandDescription('init'),
      '',
      'Behavior:',
      '  Builds one init plan for config and instruction-file updates before writing anything.',
      '  Managed sections preserve user-authored content outside Executor markers.',
      '  Unmanaged conflicts are blocked unless --force is supplied.',
      '  --dry-run shows planned local-file changes without writing.',
      '',
      'Examples:',
      ...commandExamples('init').map(example => `  ${example}`),
    ]);
  }
  try {
    const result = await runInit({ target, tool: (stringFlag(context, 'tool') ?? 'opencode') as 'opencode' | 'codex' | 'claude-code' | 'all', dryRun: readBooleanFlag(context, 'dry-run'), force: readBooleanFlag(context, 'force'), policy: policyFromRuntimeFlags(context) });
    return commandResult(context, result, formatInitHuman(result), result.ok ? 0 : 1);
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    const message = `Failed to run \`aie init\`. Likely cause: ${cause}. Next action: rerun \`aie init ${target} --dry-run --json\` and resolve blocked file actions.`;
    return commandFailure(context, { ok: false, command: 'init', error: message }, message);
  }
}

async function handleConfigCommand(context: Parameters<RuntimeCommandHandler>[0], command: 'audit ui' | 'review gate' | 'pr view' | 'pr body' | 'pr gate') {
  if (command === 'audit ui') return handleAuditUi(context);
  if (command === 'review gate') return handleReviewGate(context);
  if (command === 'pr view') return handlePrView(context);
  if (command === 'pr body') return handlePrBody(context);
  return handlePrGate(context);
}

async function handleAuditUi(context: Parameters<RuntimeCommandHandler>[0]) {
  const issue = stringArg(context, 'issue');
  if (isHelpToken(issue)) return usageResult(context, 'audit ui', 'aie audit ui <issue> [--prepare] [--check] [--dry-run] [--json]', ['Usage: aie audit ui <issue> [--prepare] [--check] [--dry-run] [--json]', '', 'Plan and inspect a manual UI audit for a real running application.', 'Examples:', ...commandExamples('audit ui').map(example => `  ${example}`)]);
  let issueNumber: number | null;
  try {
    issueNumber = parseAuditIssueNumber(issue);
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    const message = `Failed to parse audit issue. Likely cause: ${cause}. Next action: run \`aie audit ui 93 --dry-run\` or \`aie audit ui --help\`.`;
    return commandFailure(context, { ok: false, command: 'audit ui', error: message }, message);
  }
  if (issueNumber === null) {
    const message = 'Failed to run `aie audit ui`: missing issue number. Likely cause: no issue argument was provided. Next action: run `aie audit ui 93 --dry-run` or `aie audit ui --help`.';
    return commandFailure(context, { ok: false, command: 'audit ui', error: message, usage: 'aie audit ui <issue> [--prepare] [--check] [--dry-run] [--json]', examples: commandExamples('audit ui') }, message);
  }
  const loaded = await loadConfigFile();
  if (!loaded.ok) return configLoadFailure(context, 'audit ui', loaded, 'Fix the selected Executor config, then run the UI audit helper again.');
  const result = runUiAudit(loaded.config ?? getDefaults(), { issueNumber, repoRoot: loaded.root, dryRun: readBooleanFlag(context, 'dry-run'), prepare: readBooleanFlag(context, 'prepare'), check: readBooleanFlag(context, 'check') });
  return commandResult(context, result, formatUiAudit(result));
}

async function handleReviewGate(context: Parameters<RuntimeCommandHandler>[0]) {
  const issue = stringArg(context, 'issue');
  if (isHelpToken(issue)) return usageResult(context, 'review gate', 'aie review gate <issue> [--prompt] [--dry-run] [--json]', ['Usage: aie review gate <issue> [--prompt] [--dry-run] [--json]', '', 'Render the configured review-agent gate prompt and evidence requirements without invoking a reviewer.', 'Examples:', ...commandExamples('review gate').map(example => `  ${example}`)]);
  let issueNumber: number | null;
  try {
    issueNumber = parseReviewIssueNumber(issue);
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    const message = `Failed to parse review issue. Likely cause: ${cause}. Next action: run \`aie review gate 93 --prompt\` or \`aie review gate --help\`.`;
    return commandFailure(context, { ok: false, command: 'review gate', error: message }, message);
  }
  if (issueNumber === null) {
    const message = 'Failed to run `aie review gate`: missing issue number. Likely cause: no issue argument was provided. Next action: run `aie review gate 93 --prompt` or `aie review gate --help`.';
    return commandFailure(context, { ok: false, command: 'review gate', error: message, usage: 'aie review gate <issue> [--prompt] [--dry-run] [--json]', examples: commandExamples('review gate') }, message);
  }
  const loaded = await loadConfigFile();
  if (!loaded.ok) return configLoadFailure(context, 'review gate', loaded, 'Fix the selected Executor config, then run the review gate again.');
  const promptOnly = readBooleanFlag(context, 'prompt');
  const result = runReviewGate(loaded.config ?? getDefaults(), { issueNumber, repoRoot: loaded.root, dryRun: readBooleanFlag(context, 'dry-run'), promptOnly });
  return commandResult(context, result, promptOnly ? result.prompt : formatReviewGate(result));
}

async function handlePrView(context: Parameters<RuntimeCommandHandler>[0]) {
  const pr = stringArg(context, 'pr');
  if (isHelpToken(pr)) return usageResult(context, 'pr view', 'aie pr view <pr> [--json]', ['Usage: aie pr view <pr> [--json]', '', 'Show concise pull request state for agents without raw PR comment or review payloads.', 'Examples:', ...commandExamples('pr view').map(example => `  ${example}`)]);
  let prNumber: number | null;
  try {
    prNumber = parsePrNumber(pr);
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    const message = `Failed to parse pull request. Likely cause: ${cause}. Next action: run \`aie pr view 12 --json\` or \`aie pr view --help\`.`;
    return commandFailure(context, { ok: false, command: 'pr view', error: message }, message);
  }
  if (prNumber === null) {
    const message = 'Failed to run `aie pr view`: missing pull request number. Likely cause: no PR argument was provided. Next action: run `aie pr view 12 --json` or `aie pr view --help`.';
    return commandFailure(context, { ok: false, command: 'pr view', error: message, usage: 'aie pr view <pr> [--json]', examples: commandExamples('pr view') }, message);
  }
  const loaded = await loadConfigFile();
  if (!loaded.ok) return configLoadFailure(context, 'pr view', loaded, 'Fix the selected Executor config, then inspect PR state again.');
  try {
    const result = await runPrViewService({ prNumber, repoRoot: loaded.root });
    return commandResult(context, result, formatPrView(result));
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    const message = `Failed to inspect pull request #${prNumber}. Likely cause: ${cause}. Next action: verify GitHub CLI authentication, PR number, and repository permissions, then rerun \`aie pr view ${prNumber} --json\`.`;
    return commandFailure(context, { ok: false, command: 'pr view', pr: prNumber, error: message }, message);
  }
}

async function handlePrBody(context: Parameters<RuntimeCommandHandler>[0]) {
  const issue = stringArg(context, 'issue');
  if (isHelpToken(issue)) return usageResult(context, 'pr body', 'aie pr body <issue> [--json]', ['Usage: aie pr body <issue> [--json]', '', 'Draft a pull request body and merge-readiness summary from configured gates, UI audit state, and review-agent evidence.', 'Examples:', ...commandExamples('pr body').map(example => `  ${example}`)]);
  let issueNumber: number | null;
  try {
    issueNumber = parsePrBodyIssueNumber(issue);
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    const message = `Failed to parse issue. Likely cause: ${cause}. Next action: run \`aie pr body 93\` or \`aie pr body --help\`.`;
    return commandFailure(context, { ok: false, command: 'pr body', error: message }, message);
  }
  if (issueNumber === null) {
    const message = 'Failed to run `aie pr body`: missing issue number. Likely cause: no issue argument was provided. Next action: run `aie pr body 93` or `aie pr body --help`.';
    return commandFailure(context, { ok: false, command: 'pr body', error: message, usage: 'aie pr body <issue> [--json]', examples: commandExamples('pr body') }, message);
  }
  const loaded = await loadConfigFile();
  if (!loaded.ok) return configLoadFailure(context, 'pr body', loaded, 'Fix the selected Executor config, then draft the PR body again.');
  try {
    const result = await buildPrBodyService(loaded.config ?? getDefaults(), { issueNumber, repoRoot: loaded.root });
    return commandResult(context, result, formatPrBody(result));
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    const message = `Failed to draft PR body for issue #${issueNumber}. Likely cause: ${cause}. Next action: verify repository state and config, then rerun \`aie pr body ${issueNumber} --json\`.`;
    return commandFailure(context, { ok: false, command: 'pr body', issue: issueNumber, error: message }, message);
  }
}

async function handlePrReviewPublish(context: Parameters<RuntimeCommandHandler>[0]) {
  const pr = stringArg(context, 'pr');
  const lane = stringFlag(context, 'lane');
  if (isHelpToken(pr) || isHelpToken(lane)) {
    return usageResult(context, 'pr review publish', 'aie pr review publish <pr> --lane <lane> [--issue <n>] [--dry-run] [--json]', [
      'Usage: aie pr review publish <pr> --lane <lane> [--issue <n>] [--dry-run] [--json]',
      '',
      'Publish one host-run lane review comment to the configured review provider for the current PR head.',
      'Examples:',
      '  aie pr review publish 12 --lane issue-compliance',
      '  aie pr review publish 12 --lane code-quality --json',
    ]);
  }
  let prNumber: number | null;
  try {
    prNumber = parsePrNumber(pr);
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    return commandFailure(context, { ok: false, command: 'pr review publish', error: cause }, cause);
  }
  const laneTrimmed = (lane ?? '').trim();
  if (prNumber === null || laneTrimmed === '') {
    const message = 'Failed to run `aie pr review publish`: missing pull request number or lane.';
    return commandFailure(context, { ok: false, command: 'pr review publish', error: message }, message);
  }
  const laneId = COMPREHENSIVE_LOCAL_REVIEW_LANES.includes(laneTrimmed as LocalReviewLaneId) ? laneTrimmed as LocalReviewLaneId : null;
  if (laneId === null) {
    const message = `Failed to run \`aie pr review publish\`: unknown lane "${laneTrimmed}".`;
    return commandFailure(context, { ok: false, command: 'pr review publish', error: message }, message);
  }
  const issueArg = stringFlag(context, 'issue');
  const parsedIssue = issueArg && !isHelpToken(issueArg) ? Number(issueArg.startsWith('#') ? issueArg.slice(1) : issueArg) : NaN;
  const issueNumber = typeof parsedIssue === 'number' && Number.isSafeInteger(parsedIssue) && parsedIssue > 0 ? parsedIssue : undefined;
  const loaded = await loadConfigFile();
  if (!loaded.ok) return configLoadFailure(context, 'pr review publish', loaded, 'Fix the selected Executor config, then rerun lane publish.');
  try {
    const result = await runPrReviewPublishService(loaded.config ?? getDefaults(), {
      prNumber,
      lane: laneId,
      issueNumber,
      dryRun: readBooleanFlag(context, 'dry-run'),
      repoRoot: loaded.root,
    });
    return commandResult(context, result, formatPrReviewPublish(result));
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    const message = `Failed to publish lane review for #${prNumber} lane ${laneId}. Likely cause: ${cause}.`;
    return commandFailure(context, { ok: false, command: 'pr review publish', pr: prNumber, lane: laneId, error: message }, message);
  }
}

async function handlePrGate(context: Parameters<RuntimeCommandHandler>[0]) {
  const pr = stringArg(context, 'pr');
  if (isHelpToken(pr)) return usageResult(context, 'pr gate', 'aie pr gate <pr> [--dry-run] [--local-review-prompts] [--json]', [
    'Usage: aie pr gate <pr> [--dry-run] [--local-review-prompts] [--json]',
    '',
    'Request configured PR reviewers idempotently, wait the configured duration, and inspect review state before merge.',
    'Required local review quality depends on independent fresh-context reviewer execution; prompt rendering alone is fallback guidance and cannot satisfy required local review gates.',
    'Use --local-review-prompts to include explicit lane prompt bodies for a host subagent/task/session, then record local-host evidence with matching provenance.',
    'Examples:',
    ...commandExamples('pr gate').map(example => `  ${example}`),
  ]);
  let prNumber: number | null;
  try {
    prNumber = parsePrNumber(pr);
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    const message = `Failed to parse pull request. Likely cause: ${cause}. Next action: run \`aie pr gate 12 --dry-run\` or \`aie pr gate --help\`.`;
    return commandFailure(context, { ok: false, command: 'pr gate', error: message }, message);
  }
  if (prNumber === null) {
    const message = 'Failed to run `aie pr gate`: missing pull request number. Likely cause: no PR argument was provided. Next action: run `aie pr gate 12 --dry-run` or `aie pr gate --help`.';
    return commandFailure(context, { ok: false, command: 'pr gate', error: message, usage: 'aie pr gate <pr> [--dry-run] [--local-review-prompts] [--json]', examples: commandExamples('pr gate') }, message);
  }
  const loaded = await loadConfigFile();
  if (!loaded.ok) return configLoadFailure(context, 'pr gate', loaded, 'Fix the selected Executor config, then run the PR gate again.');
  try {
    const warnings: string[] = [];
    const result = await runPrGateService(loaded.config ?? getDefaults(), {
      prNumber,
      dryRun: readBooleanFlag(context, 'dry-run'),
      includeLocalReviewPrompts: readBooleanFlag(context, 'local-review-prompts'),
      repoRoot: loaded.root,
      onBeforeMutate: message => {
        warnings.push(message);
      },
    });
    const rendered = `${warnings.map(warning => `Warning: ${warning}`).join('\n')}${warnings.length > 0 ? '\n' : ''}${formatPrGate(result)}`;
    return commandResult(context, result, rendered);
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    const message = `Failed to run PR review gate for #${prNumber}. Likely cause: ${cause}. Next action: verify GitHub CLI authentication, PR number, and repository permissions, then rerun \`aie pr gate ${prNumber} --dry-run\`.`;
    return commandFailure(context, { ok: false, command: 'pr gate', pr: prNumber, error: message }, message);
  }
}

export const RUNTIME_HANDLERS: Readonly<Record<string, RuntimeCommandHandler>> = {
  audit: topic(['Use `aie audit ui <issue> --dry-run`, `aie audit ui <issue> --prepare`, or `aie audit ui <issue> --check --json`.', 'Audit helpers render manual guidance and local evidence paths; they never upload screenshots or claim pass/fail from instructions alone.']),
  'audit ui': context => handleConfigCommand(context, 'audit ui'),
  branch: topic(['Use `aie branch suggest <issue>`, `aie branch check <issue>`, or `aie branch create <issue> --dry-run`.', '`suggest` and `check` are read-only. `create` mutates git state only after worktree, dirty checkout, and base branch checks pass.']),
  'branch suggest': context => handleBranch(context, 'branch suggest'),
  'branch check': context => handleBranch(context, 'branch check'),
  'branch create': context => handleBranch(context, 'branch create'),
  checklist: topic(['Use `aie checklist verify <issue> --index <n> --prompt` to verify acceptance criteria, then rerun with criterion evidence and `--state checked`.', 'Use `aie checklist update <issue> --index <n> --state unchecked` only for direct checklist maintenance.']),
  'checklist update': handleChecklistUpdate,
  'checklist verify': handleChecklistVerify,
  complete: handleComplete,
  deps: topic(['Use `aie deps blockers <issue>`, `aie deps blocking <issue>`, `aie deps chain <issue>`, `aie deps ready`, `aie deps blocked`, `aie deps graph --json`, or `aie deps fix --dry-run`.', 'Read-only commands explain the dependency state from "Blocked by: #N" lines in issue bodies. `aie deps fix` plans and applies S-Ready/S-Blocked/S-Blocking label changes (S-InProgress issues are never changed).']),
  doctor: async context => {
    const diagnostics = await buildDoctorDiagnostics();
    return commandResult(context, diagnostics, formatDoctorHuman(diagnostics));
  },
  'deps blocked': handleDepsBlocked,
  'deps blockers': handleDepsBlockers,
  'deps blocking': handleDepsBlocking,
  'deps chain': handleDepsChain,
  'deps fix': handleDepsFix,
  'deps graph': handleDepsGraph,
  'deps ready': handleDepsReady,
  gates: topic(['Use `aie gates plan --dry-run`, `aie gates plan --stage pre-pr --json`, or `aie gates status --json`.', 'Gate commands are read from trusted repository config and are never executed by Executor.']),
  'gates plan': async context => {
    const loaded = await loadConfigFile();
    if (!loaded.ok) return configLoadFailure(context, 'gates plan', loaded, 'Fix the selected Executor config, then run the gate plan again.');
    const stage = stringFlag(context, 'stage');
    const result = buildGatePlan(loaded.config ?? getDefaults(), { stage: isGateStage(stage) ? stage : undefined, dryRun: readBooleanFlag(context, 'dry-run') });
    return commandResult(context, result, formatGatePlan(result));
  },
  'gates status': async context => {
    const loaded = await loadConfigFile();
    if (!loaded.ok) return configLoadFailure(context, 'gates status', loaded, 'Fix the selected Executor config, then run the gate status again.');
    const stage = stringFlag(context, 'stage');
    const result = buildGateStatus(loaded.config ?? getDefaults(), { stage: isGateStage(stage) ? stage : undefined, evidenceRoot: loaded.root });
    return commandResult(context, result, formatGateStatus(result));
  },
  init: handleInit,
  labels: topic(['Use `aie labels setup` to create or update labels defined in the selected Executor config (or the built-in defaults) idempotently.', 'This command and its subcommands can mutate GitHub labels when not in --dry-run mode.']),
  'labels setup': handleLabelsSetup,
  migrate: topic(['Use `aie migrate map` to inspect legacy command mappings, or `aie migrate legacy --dry-run` to inspect legacy Executor state without mutation.', 'Migration planning preserves repository files, git history, branches, issue state, labels, and GitHub milestone assignments while reporting inventory and planned changes.']),
  'migrate legacy': async context => {
    const plan = await runMigration({ dryRun: readBooleanFlag(context, 'dry-run'), apply: readBooleanFlag(context, 'apply'), force: readBooleanFlag(context, 'force'), instructionPaths: stringListFlag(context, 'instruction'), legacyPaths: stringListFlag(context, 'path'), cleanup: readBooleanFlag(context, 'cleanup'), installWrappers: readBooleanFlag(context, 'install-wrappers') });
    return commandResult(context, plan, formatMigrationPlan(plan), plan.ok ? 0 : 1);
  },
  'migrate map': context => {
    const map = buildMigrationMap();
    return commandResult(context, map, formatMigrationMap(map));
  },
  next: async context => {
    const next = await getNextIssue();
    return commandResult(context, { ok: true, command: 'next', ...next }, next.issue ? lineOutput([`Next: ${workDisplayId(next.issue)} "${next.issue.title}" (${next.issue.state})`, `Reason: ${next.reason}`, ...(next.multipleInProgress ? ['WARNING: Multiple in-progress work items - fix before starting new work.'] : []), ...(next.driftCount > 0 ? [`Drift: ${next.driftCount} work item(s) - consider \`aie deps fix --dry-run\` then \`aie deps fix\`.`] : [])]) : `${next.reason}\n`);
  },
  pr: topic(['Use `aie pr view <pr> --json` for concise PR state before reaching for raw GitHub CLI review data.', 'Use `aie pr body <issue>` to draft PR text and readiness guidance before opening a pull request.', 'Use `aie pr gate <pr> --dry-run`, `aie pr gate <pr> --json`, or `aie pr gate <pr>` before merge.', 'Use `aie pr review publish <pr> --lane <lane> --issue <issue>` from host review subagents to post lane feedback to the provider.', 'PR helpers coordinate body drafting, configured reviewer requests, and review-state inspection; they never merge pull requests for you.']),
  'pr body': context => handleConfigCommand(context, 'pr body'),
  'pr gate': context => handleConfigCommand(context, 'pr gate'),
  'pr review publish': handlePrReviewPublish,
  'pr view': context => handleConfigCommand(context, 'pr view'),
  queue: async context => {
    const q = await computeQueue();
    const lines = ['Issue Queue', `In-Progress: ${q.inProgressCount} | Ready: ${q.readyCount} | Blocked: ${q.blockedCount} | Drift: ${q.driftCount}`];
    if (q.multipleInProgress) lines.push('WARNING: Multiple S-InProgress issues detected. Run `aie deps fix --dry-run` then `aie deps fix`.');
    lines.push('');
    for (const status of ['InProgress', 'Ready', 'Blocked'] as const) {
      const list = q.items.filter(item => item.effectiveStatus === status);
      if (list.length === 0) continue;
      lines.push(`${status}:`);
      for (const item of list) lines.push(`  ${workDisplayId(item.issue)} "${item.issue.title}" (${item.issue.state})${item.drifted ? ' (drift)' : ''}${status === 'Blocked' && item.openBlockers.length > 0 ? ` blocked by: ${item.openBlockers.map(number => `#${number}`).join(', ')}` : ''}`);
      lines.push('');
    }
    if (q.driftCount > 0) lines.push('Drift detected - labels disagree with dependency state. Run `aie deps fix --dry-run` then `aie deps fix`.');
    return commandResult(context, { ok: true, command: 'queue', ...q }, lineOutput(lines));
  },
  repo: topic(['Use `aie repo prime --dry-run` to inspect repository readiness before issue execution.', '`aie repo prime` can create or update Executor labels and can write a minimal .qube/aie/config.json only with --yes. It never creates specs, GitHub milestones, issue batches, or agent instructions.']),
  'repo prime': async context => {
    const config = (await loadConfig()) || getDefaults();
    const dryRun = readBooleanFlag(context, 'dry-run');
    const plan = await buildRepoPrimePlan({ config, dryRun, yes: readBooleanFlag(context, 'yes') });
    return commandResult(context, { ...plan, command: 'repo prime', dryRun }, formatRepoPrimeHuman(plan, dryRun));
  },
  run: topic(['Use `aie run start --name ui-audit -- <command>` for long-running local app servers.', 'Use `aie run wait --name ui-audit --url <url> --timeout 30`, `aie run status --name ui-audit`, and `aie run stop --name ui-audit` for bounded readiness and cleanup.']),
  'run start': handleRunStart,
  'run wait': handleRunWait,
  'run status': handleRunStatus,
  'run stop': handleRunStop,
  review: topic(['Use `aie review gate <issue> --prompt`, `aie review gate <issue> --dry-run`, or `aie review gate <issue> --json`.', 'Review helpers render prompts and evidence requirements; Executor never invokes host-only reviewers or treats review output as policy.']),
  'review gate': context => handleConfigCommand(context, 'review gate'),
  schema: handleSchema,
  start: handleStart,
  status: async context => {
    const result = await buildStatus(await createStatusContext());
    return commandResult(context, result, formatStatusHuman(result), result.ok ? 0 : 1);
  },
  switch: handleSwitch,
  view: handleView,
};
