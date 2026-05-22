import { Args, Command, Flags } from '@oclif/core';
import { resolve } from 'path';
import { commandDescription, commandExamples, isHelpToken } from '../command_metadata.js';
import { Config, getDefaults, loadConfig } from '../config/index.js';
import { InitPolicyOptions, runInit } from '../init/index.js';
import { getRepoRoot } from '../repo/index.js';
import { formatInitHuman } from '../renderers/init_renderer.js';

const INIT_USAGE = 'aie init <target> [--tool opencode|codex|claude-code|all] [--defaults] [--yes] [--dry-run] [--force] [--json]';
const TOOL_OPTIONS = ['opencode', 'codex', 'claude-code', 'all'] as const;
const MISSING_MILESTONE_OPTIONS = ['ignore', 'warn', 'block'] as const;

type InitToolFlag = typeof TOOL_OPTIONS[number];
type MissingMilestoneFlag = typeof MISSING_MILESTONE_OPTIONS[number];

interface PromptOption<T extends string | boolean> {
  value: T;
  label: string;
  hint?: string;
}

interface PromptModule {
  intro(message: string): void;
  outro(message: string): void;
  cancel(message: string): void;
  isCancel(value: unknown): boolean;
  confirm(options: { message: string; initialValue?: boolean }): Promise<unknown>;
  select<T extends string>(options: { message: string; options: PromptOption<T>[]; initialValue?: T }): Promise<unknown>;
  text(options: { message: string; placeholder?: string; initialValue?: string; validate?: (value: string) => string | undefined }): Promise<unknown>;
}

function usageLines(): string[] {
  return [
    `Usage: ${INIT_USAGE}`,
    Init.description,
    '',
    'Behavior:',
    '  Builds one init plan for config and instruction-file updates before writing anything.',
    '  Managed sections preserve user-authored content outside Executor markers.',
    '  Unmanaged conflicts are blocked unless --force is supplied.',
    '  --dry-run shows planned local-file changes without writing.',
    '',
    'Examples:',
    ...Init.examples.map(example => `  ${example}`),
  ];
}

function splitList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap(item => item.split(',')).map(item => item.trim()).filter(item => item.length > 0);
}

function readBooleanFlag(value: boolean | undefined): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function isPromptModule(value: unknown): value is PromptModule {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return ['intro', 'outro', 'cancel', 'isCancel', 'confirm', 'select', 'text'].every(key => typeof candidate[key] === 'function');
}

async function loadPrompts(): Promise<PromptModule> {
  const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;
  const prompts = await importModule('@clack/prompts');
  if (!isPromptModule(prompts)) {
    throw new Error('Failed to load interactive prompt module. Likely cause: @clack/prompts exports changed or the dependency is missing. Next action: verify package installation and rerun `pnpm install --frozen-lockfile --ignore-scripts`.');
  }
  return prompts;
}

function requirePromptString(prompts: PromptModule, value: unknown): string {
  if (prompts.isCancel(value)) throw new Error('Initialization was cancelled. Next action: rerun `aie init` with flags, --defaults --yes, or complete the prompt flow.');
  return typeof value === 'string' ? value : String(value);
}

function requirePromptBoolean(prompts: PromptModule, value: unknown): boolean {
  if (prompts.isCancel(value)) throw new Error('Initialization was cancelled. Next action: rerun `aie init` with flags, --defaults --yes, or complete the prompt flow.');
  if (typeof value !== 'boolean') throw new Error('Prompt returned a non-boolean value. Next action: rerun `aie init` non-interactively with explicit flags.');
  return value;
}

function listPromptValue(value: string): string[] {
  return splitList(value) ?? [];
}

function argvRequestsJson(argv: string[]): boolean {
  return argv.includes('--json') || argv.includes('-j');
}

function targetIsGitRepository(target: string): boolean {
  return getRepoRoot(resolve(process.cwd(), target)) !== null;
}

function policyFromFlags(flags: Record<string, unknown>): InitPolicyOptions {
  const policy: InitPolicyOptions = {};
  const worktree = readBooleanFlag(flags.worktree as boolean | undefined);
  if (worktree !== undefined) policy.noWorktree = !worktree;
  const blockOpenPrs = readBooleanFlag(flags['block-open-prs'] as boolean | undefined);
  if (blockOpenPrs !== undefined) policy.blockOnOpenPRs = blockOpenPrs;
  const baseFreshness = readBooleanFlag(flags['base-branch-freshness'] as boolean | undefined);
  if (baseFreshness !== undefined) policy.requireBaseBranchFreshness = baseFreshness;
  const autonomous = readBooleanFlag(flags.autonomous as boolean | undefined);
  if (autonomous !== undefined) policy.autonomousMode = autonomous;
  const assignOnStart = readBooleanFlag(flags['assign-on-start'] as boolean | undefined);
  if (assignOnStart !== undefined) policy.assignOnStart = assignOnStart;
  const commentOnStart = readBooleanFlag(flags['comment-on-start'] as boolean | undefined);
  if (commentOnStart !== undefined) policy.commentOnStart = commentOnStart;
  const manualUiAudit = readBooleanFlag(flags['manual-ui-audit'] as boolean | undefined);
  if (manualUiAudit !== undefined) policy.manualUiAudit = manualUiAudit;
  if (typeof flags['ui-audit-app-launch'] === 'string') policy.uiAuditAppLaunch = flags['ui-audit-app-launch'];
  if (typeof flags['ui-audit-target'] === 'string') policy.uiAuditTarget = flags['ui-audit-target'];
  const opencodeCommandAlias = readBooleanFlag(flags['opencode-command-alias'] as boolean | undefined);
  if (opencodeCommandAlias !== undefined) policy.opencodeCommandAlias = opencodeCommandAlias;
  const qualityControl = readBooleanFlag(flags['quality-control'] as boolean | undefined);
  if (qualityControl !== undefined) policy.qualityControl = qualityControl;

  if (typeof flags['branch-naming'] === 'string') policy.branchNaming = flags['branch-naming'];
  if (typeof flags['base-branch'] === 'string') policy.baseBranch = flags['base-branch'];
  if (typeof flags['base-remote'] === 'string') policy.baseRemote = flags['base-remote'];
  if (typeof flags['review-wait-minutes'] === 'number') policy.reviewWaitMinutes = flags['review-wait-minutes'];
  if (typeof flags['review-request-text'] === 'string') policy.reviewRequestText = flags['review-request-text'];

  const priorityLabels = splitList(flags['priority-label'] as string[] | undefined);
  if (priorityLabels !== undefined) policy.priorityLabels = priorityLabels;
  const statusLabels = splitList(flags['status-label'] as string[] | undefined);
  if (statusLabels !== undefined) policy.statusLabels = statusLabels;
  const componentLabels = splitList(flags['component-label'] as string[] | undefined);
  if (componentLabels !== undefined) policy.componentLabels = componentLabels;
  const ignoredAutomationAuthors = splitList(flags['ignored-automation-author'] as string[] | undefined);
  if (ignoredAutomationAuthors !== undefined) policy.ignoredAutomationAuthors = ignoredAutomationAuthors;
  const qualityGates = splitList(flags['quality-gate'] as string[] | undefined);
  if (qualityGates !== undefined) policy.qualityGates = qualityGates;
  const reviewAgents = splitList(flags['review-agent'] as string[] | undefined);
  if (reviewAgents !== undefined) policy.reviewAgents = reviewAgents;

  const milestoneEnabled = readBooleanFlag(flags['milestone-ordering'] as boolean | undefined);
  const milestoneOrder = splitList(flags['milestone-order'] as string[] | undefined);
  const missingMilestone = flags['missing-milestone'] as MissingMilestoneFlag | undefined;
  if (milestoneEnabled !== undefined || milestoneOrder !== undefined || missingMilestone !== undefined) {
    policy.milestoneOrdering = {};
    if (milestoneEnabled !== undefined) policy.milestoneOrdering.enabled = milestoneEnabled;
    if (milestoneOrder !== undefined) policy.milestoneOrdering.order = milestoneOrder;
    if (missingMilestone !== undefined) policy.milestoneOrdering.missingAssignment = missingMilestone;
  }

  const namingRules = readBooleanFlag(flags['naming-rules'] as boolean | undefined);
  const promptInjectionWarning = readBooleanFlag(flags['prompt-injection-warning'] as boolean | undefined);
  const creditWarning = readBooleanFlag(flags['credit-warning'] as boolean | undefined);
  const implementationGuardrails = readBooleanFlag(flags['implementation-guardrails'] as boolean | undefined);
  const supplyChainSafety = readBooleanFlag(flags['supply-chain-safety'] as boolean | undefined);
  if (namingRules !== undefined || promptInjectionWarning !== undefined || creditWarning !== undefined || implementationGuardrails !== undefined || supplyChainSafety !== undefined) {
    policy.instructions = {};
    if (namingRules !== undefined) policy.instructions.namingRules = namingRules;
    if (promptInjectionWarning !== undefined) policy.instructions.promptInjectionWarning = promptInjectionWarning;
    if (creditWarning !== undefined) policy.instructions.noCreditWarning = creditWarning;
    if (implementationGuardrails !== undefined) policy.instructions.implementationGuardrails = implementationGuardrails;
    if (supplyChainSafety !== undefined) policy.instructions.supplyChainSafety = supplyChainSafety;
  }

  const exactVersions = readBooleanFlag(flags['exact-dependency-versions'] as boolean | undefined);
  const intentionalLockfiles = readBooleanFlag(flags['intentional-lockfile-changes'] as boolean | undefined);
  const disableLifecycleScripts = readBooleanFlag(flags['disable-lifecycle-scripts'] as boolean | undefined);
  const pinCiActions = readBooleanFlag(flags['pin-ci-actions'] as boolean | undefined);
  const unverifiedRiskApproval = readBooleanFlag(flags['unverified-risk-approval'] as boolean | undefined);
  const packageManagerDefaults = readBooleanFlag(flags['package-manager-defaults'] as boolean | undefined);
  const packageAgeDays = flags['package-age-days'] as number | undefined;
  const highRiskPackageAgeDays = flags['high-risk-package-age-days'] as number | undefined;
  if (exactVersions !== undefined || intentionalLockfiles !== undefined || disableLifecycleScripts !== undefined || pinCiActions !== undefined || unverifiedRiskApproval !== undefined || packageManagerDefaults !== undefined || packageAgeDays !== undefined || highRiskPackageAgeDays !== undefined) {
    policy.supplyChain = {};
    if (exactVersions !== undefined) policy.supplyChain.exactVersions = exactVersions;
    if (intentionalLockfiles !== undefined) policy.supplyChain.intentionalLockfileChanges = intentionalLockfiles;
    if (disableLifecycleScripts !== undefined) policy.supplyChain.disableLifecycleScripts = disableLifecycleScripts;
    if (pinCiActions !== undefined) policy.supplyChain.pinCiActions = pinCiActions;
    if (unverifiedRiskApproval !== undefined) policy.supplyChain.requireApprovalForUnverifiedRisk = unverifiedRiskApproval;
    if (packageManagerDefaults !== undefined) policy.supplyChain.writePackageManagerDefaults = packageManagerDefaults;
    if (packageAgeDays !== undefined) policy.supplyChain.packageAgeDays = packageAgeDays;
    if (highRiskPackageAgeDays !== undefined) policy.supplyChain.highRiskPackageAgeDays = highRiskPackageAgeDays;
  }

  return policy;
}

async function promptForPolicy(existingPolicy: InitPolicyOptions, selectedTool: string | undefined, baseConfig: Config): Promise<{ tool: InitToolFlag; policy: InitPolicyOptions }> {
  const prompts = await loadPrompts();
  prompts.intro('Configure Executor repository policy');
  const tool = selectedTool ?? requirePromptString(prompts, await prompts.select({
    message: 'Target agent host?',
    options: [
      { value: 'opencode', label: 'OpenCode', hint: 'default' },
      { value: 'codex', label: 'Codex' },
      { value: 'claude-code', label: 'Claude Code' },
      { value: 'all', label: 'All supported hosts' },
    ],
    initialValue: 'opencode',
  }));
  const policy: InitPolicyOptions = { ...existingPolicy };
  policy.branchNaming = policy.branchNaming ?? requirePromptString(prompts, await prompts.text({ message: 'Issue branch naming pattern?', initialValue: baseConfig.branchNaming }));
  policy.baseBranch = policy.baseBranch ?? requirePromptString(prompts, await prompts.text({ message: 'Base branch?', initialValue: baseConfig.baseBranch }));
  policy.baseRemote = policy.baseRemote ?? requirePromptString(prompts, await prompts.text({ message: 'Base remote?', initialValue: baseConfig.baseRemote }));
  policy.noWorktree = policy.noWorktree ?? requirePromptBoolean(prompts, await prompts.confirm({ message: 'Disable linked worktrees for issue execution?', initialValue: baseConfig.noWorktree }));
  policy.blockOnOpenPRs = policy.blockOnOpenPRs ?? requirePromptBoolean(prompts, await prompts.confirm({ message: 'Block new issue work when non-automation pull requests are open?', initialValue: baseConfig.blockOnOpenPRs }));
  policy.requireBaseBranchFreshness = policy.requireBaseBranchFreshness ?? requirePromptBoolean(prompts, await prompts.confirm({ message: 'Require local base branch freshness before new issue work?', initialValue: baseConfig.requireBaseBranchFreshness }));
  policy.autonomousMode = policy.autonomousMode ?? requirePromptBoolean(prompts, await prompts.confirm({ message: 'Enable autonomous shipping mode under repository policy?', initialValue: baseConfig.autonomousMode }));
  policy.assignOnStart = policy.assignOnStart ?? requirePromptBoolean(prompts, await prompts.confirm({ message: 'Assign issues on start?', initialValue: baseConfig.assignOnStart }));
  policy.commentOnStart = policy.commentOnStart ?? requirePromptBoolean(prompts, await prompts.confirm({ message: 'Comment on issues when starting work?', initialValue: baseConfig.commentOnStart }));
  policy.ignoredAutomationAuthors = policy.ignoredAutomationAuthors ?? listPromptValue(requirePromptString(prompts, await prompts.text({ message: 'Ignored automation PR authors?', initialValue: baseConfig.ignoredAutomationAuthors.join(',') })));
  policy.priorityLabels = policy.priorityLabels ?? listPromptValue(requirePromptString(prompts, await prompts.text({ message: 'Priority labels?', initialValue: baseConfig.priorityLabels.join(',') })));
  policy.statusLabels = policy.statusLabels ?? listPromptValue(requirePromptString(prompts, await prompts.text({ message: 'Status labels?', initialValue: baseConfig.statusLabels.join(',') })));
  policy.componentLabels = policy.componentLabels ?? listPromptValue(requirePromptString(prompts, await prompts.text({ message: 'Component labels?', initialValue: baseConfig.componentLabels.join(',') })));
  const milestoneEnabled = policy.milestoneOrdering?.enabled ?? requirePromptBoolean(prompts, await prompts.confirm({ message: 'Enable GitHub milestone ordering as queue context?', initialValue: baseConfig.milestoneOrdering.enabled }));
  const missingAssignment = policy.milestoneOrdering?.missingAssignment ?? requirePromptString(prompts, await prompts.select({
    message: 'How should missing milestone assignments be treated?',
    options: [
      { value: 'ignore', label: 'Ignore' },
      { value: 'warn', label: 'Warn', hint: 'default' },
      { value: 'block', label: 'Block' },
    ],
    initialValue: baseConfig.milestoneOrdering.missingAssignment,
  })) as MissingMilestoneFlag;
  policy.milestoneOrdering = {
    enabled: milestoneEnabled,
    missingAssignment,
    order: policy.milestoneOrdering?.order ?? (milestoneEnabled ? listPromptValue(requirePromptString(prompts, await prompts.text({ message: 'Milestone title order?', placeholder: 'M1,M2,M3', initialValue: baseConfig.milestoneOrdering.order.join(',') }))) : baseConfig.milestoneOrdering.order),
  };
  policy.manualUiAudit = policy.manualUiAudit ?? requirePromptBoolean(prompts, await prompts.confirm({ message: 'Require manual UI audit for user-facing UI changes?', initialValue: baseConfig.manualUiAudit }));
  policy.qualityGates = policy.qualityGates ?? listPromptValue(requirePromptString(prompts, await prompts.text({ message: 'Agent-run quality gate commands?', placeholder: 'pnpm test,pnpm run typecheck', initialValue: baseConfig.qualityGates.join(',') })));
  policy.reviewAgents = policy.reviewAgents ?? listPromptValue(requirePromptString(prompts, await prompts.text({ message: 'Third-party review agents to enable? Leave blank for none.', placeholder: 'review-bot', initialValue: baseConfig.reviewAgents.join(',') })));
  policy.reviewRequestText = policy.reviewRequestText ?? requirePromptString(prompts, await prompts.text({ message: 'Custom review request text?', placeholder: 'Please review policy-sensitive changes.', initialValue: baseConfig.reviewRequestText }));
  const supportsOpenCodeCommand = tool === 'opencode' || tool === 'all';
  policy.opencodeCommandAlias = policy.opencodeCommandAlias ?? (supportsOpenCodeCommand ? requirePromptBoolean(prompts, await prompts.confirm({ message: 'Install optional OpenCode makeitso command alias?', initialValue: baseConfig.opencodeCommandAlias })) : baseConfig.opencodeCommandAlias);
  if (policy.reviewWaitMinutes === undefined) {
    const reviewWaitText = requirePromptString(prompts, await prompts.text({ message: 'PR review wait duration in minutes?', initialValue: String(baseConfig.reviewWaitMinutes), validate: value => Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 120 ? undefined : 'Use an integer from 0 to 120.' }));
    policy.reviewWaitMinutes = Number(reviewWaitText);
  }
  policy.qualityControl = policy.qualityControl ?? requirePromptBoolean(prompts, await prompts.confirm({ message: 'Record intent to run a Quality Control gate when available?', initialValue: baseConfig.qualityControl }));
  const instructions = { ...(policy.instructions ?? {}) };
  instructions.namingRules = instructions.namingRules ?? requirePromptBoolean(prompts, await prompts.confirm({ message: 'Include optional naming-rules instructions? Recommended for code-writing agents.', initialValue: baseConfig.instructions.namingRules }));
  instructions.promptInjectionWarning = instructions.promptInjectionWarning ?? requirePromptBoolean(prompts, await prompts.confirm({ message: 'Include prompt-injection warning block?', initialValue: baseConfig.instructions.promptInjectionWarning }));
  instructions.noCreditWarning = instructions.noCreditWarning ?? requirePromptBoolean(prompts, await prompts.confirm({ message: 'Include no-credit warning block?', initialValue: baseConfig.instructions.noCreditWarning }));
  instructions.implementationGuardrails = instructions.implementationGuardrails ?? requirePromptBoolean(prompts, await prompts.confirm({ message: 'Include implementation guardrails?', initialValue: baseConfig.instructions.implementationGuardrails }));
  instructions.supplyChainSafety = instructions.supplyChainSafety ?? requirePromptBoolean(prompts, await prompts.confirm({ message: 'Include supply-chain safety instructions?', initialValue: baseConfig.instructions.supplyChainSafety }));
  policy.instructions = instructions;
  const supplyChain = { ...(policy.supplyChain ?? {}) };
  supplyChain.exactVersions = supplyChain.exactVersions ?? requirePromptBoolean(prompts, await prompts.confirm({ message: 'Require exact dependency versions?', initialValue: baseConfig.supplyChain.exactVersions }));
  supplyChain.intentionalLockfileChanges = supplyChain.intentionalLockfileChanges ?? requirePromptBoolean(prompts, await prompts.confirm({ message: 'Require intentional lockfile changes?', initialValue: baseConfig.supplyChain.intentionalLockfileChanges }));
  supplyChain.disableLifecycleScripts = supplyChain.disableLifecycleScripts ?? requirePromptBoolean(prompts, await prompts.confirm({ message: 'Disable dependency lifecycle scripts where supported?', initialValue: baseConfig.supplyChain.disableLifecycleScripts }));
  supplyChain.pinCiActions = supplyChain.pinCiActions ?? requirePromptBoolean(prompts, await prompts.confirm({ message: 'Pin third-party CI actions to immutable commit SHAs where supported?', initialValue: baseConfig.supplyChain.pinCiActions }));
  if (supplyChain.packageAgeDays === undefined) {
    const packageAgeText = requirePromptString(prompts, await prompts.text({ message: 'Package age gate in days?', initialValue: String(baseConfig.supplyChain.packageAgeDays), validate: value => Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 365 ? undefined : 'Use an integer from 0 to 365.' }));
    supplyChain.packageAgeDays = Number(packageAgeText);
  }
  if (supplyChain.highRiskPackageAgeDays === undefined) {
    const highRiskAgeText = requirePromptString(prompts, await prompts.text({ message: 'High-risk package age gate in days?', initialValue: String(baseConfig.supplyChain.highRiskPackageAgeDays), validate: value => Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 365 ? undefined : 'Use an integer from 0 to 365.' }));
    supplyChain.highRiskPackageAgeDays = Number(highRiskAgeText);
  }
  supplyChain.requireApprovalForUnverifiedRisk = supplyChain.requireApprovalForUnverifiedRisk ?? requirePromptBoolean(prompts, await prompts.confirm({ message: 'Require approval for unverifiable package risk?', initialValue: baseConfig.supplyChain.requireApprovalForUnverifiedRisk }));
  supplyChain.writePackageManagerDefaults = supplyChain.writePackageManagerDefaults ?? requirePromptBoolean(prompts, await prompts.confirm({ message: 'Write project-level npm secure defaults now?', initialValue: baseConfig.supplyChain.writePackageManagerDefaults }));
  policy.supplyChain = supplyChain;
  prompts.outro('Executor policy captured.');
  if (tool === 'opencode' || tool === 'codex' || tool === 'claude-code' || tool === 'all') return { tool, policy };
  throw new Error(`Unsupported init tool "${tool}". Next action: use opencode, codex, claude-code, or all.`);
}

export default class Init extends Command {
  static description = commandDescription('init');

  static args = {
    target: Args.string({ required: false, description: 'Repository path to initialize, usually .' }),
  };

  static flags = {
    json: Flags.boolean({ char: 'j', description: 'Emit machine-readable init plan and result', default: false }),
    'dry-run': Flags.boolean({ char: 'd', description: 'Show planned local-file changes without writing', default: false }),
    force: Flags.boolean({ char: 'f', description: 'Replace conflicted managed sections or unmanaged command files intentionally', default: false }),
    yes: Flags.boolean({ char: 'y', description: 'Accept defaults for omitted init policy choices and never prompt', default: false }),
    defaults: Flags.boolean({ description: 'Use Executor defaults for omitted init policy choices and never prompt', default: false }),
    tool: Flags.string({ char: 't', description: 'Agent host target: opencode, codex, claude-code, or all', options: TOOL_OPTIONS }),
    'branch-naming': Flags.string({ description: 'Issue branch naming pattern' }),
    'base-branch': Flags.string({ description: 'Local base branch name' }),
    'base-remote': Flags.string({ description: 'Base branch remote name' }),
    worktree: Flags.boolean({ description: 'Allow linked worktree execution; use --no-worktree to enforce primary checkout execution', allowNo: true }),
    'block-open-prs': Flags.boolean({ description: 'Block new issue work while non-automation pull requests are open', allowNo: true }),
    'base-branch-freshness': Flags.boolean({ description: 'Require local base branch freshness against the configured remote', allowNo: true }),
    autonomous: Flags.boolean({ description: 'Enable autonomous shipping authority in generated instructions', allowNo: true }),
    'assign-on-start': Flags.boolean({ description: 'Assign issues when starting work', allowNo: true }),
    'comment-on-start': Flags.boolean({ description: 'Comment on issues when starting work', allowNo: true }),
    'ignored-automation-author': Flags.string({ description: 'Automation PR author ignored by pre-start open-PR blocking; repeat or comma-separate', multiple: true, delimiter: ',' }),
    'priority-label': Flags.string({ description: 'Priority label; repeat or comma-separate', multiple: true, delimiter: ',' }),
    'status-label': Flags.string({ description: 'Status label; repeat or comma-separate', multiple: true, delimiter: ',' }),
    'component-label': Flags.string({ description: 'Component label; repeat or comma-separate', multiple: true, delimiter: ',' }),
    'milestone-ordering': Flags.boolean({ description: 'Use GitHub milestone ordering as queue context', allowNo: true }),
    'milestone-order': Flags.string({ description: 'Configured GitHub milestone title order; repeat or comma-separate', multiple: true, delimiter: ',' }),
    'missing-milestone': Flags.string({ description: 'Policy for issues missing milestones when milestone ordering is enabled', options: MISSING_MILESTONE_OPTIONS }),
    'manual-ui-audit': Flags.boolean({ description: 'Require manual audit for user-facing UI changes', allowNo: true }),
    'ui-audit-app-launch': Flags.string({ description: 'Command agents should run to start the app for manual UI audit evidence' }),
    'ui-audit-target': Flags.string({ description: 'URL, route, or screen agents should inspect during manual UI audits' }),
    'opencode-command-alias': Flags.boolean({ description: 'Install optional .opencode/commands/makeitso.md alias when OpenCode is selected', allowNo: true }),
    'quality-gate': Flags.string({ description: 'Agent-run quality gate command; repeat or comma-separate', multiple: true, delimiter: ',' }),
    'review-agent': Flags.string({ description: 'Opt-in third-party review agent; repeat or comma-separate', multiple: true, delimiter: ',' }),
    'review-request-text': Flags.string({ description: 'Custom review request text for configured review agents' }),
    'review-wait-minutes': Flags.integer({ description: 'Minutes to wait for configured review gates', min: 0, max: 120 }),
    'quality-control': Flags.boolean({ description: 'Record intent to run Quality Control gates when available', allowNo: true }),
    'naming-rules': Flags.boolean({ description: 'Include optional naming-rules instructions', allowNo: true }),
    'prompt-injection-warning': Flags.boolean({ description: 'Include prompt-injection safety instructions', allowNo: true }),
    'credit-warning': Flags.boolean({ description: 'Include no-credit safety instructions; use --no-credit-warning to disable', allowNo: true }),
    'implementation-guardrails': Flags.boolean({ description: 'Include implementation guardrail instructions', allowNo: true }),
    'supply-chain-safety': Flags.boolean({ description: 'Include supply-chain safety instructions', allowNo: true }),
    'exact-dependency-versions': Flags.boolean({ description: 'Require exact dependency versions in supply-chain policy', allowNo: true }),
    'intentional-lockfile-changes': Flags.boolean({ description: 'Require intentional lockfile changes in supply-chain policy', allowNo: true }),
    'disable-lifecycle-scripts': Flags.boolean({ description: 'Disable dependency lifecycle scripts where supported', allowNo: true }),
    'pin-ci-actions': Flags.boolean({ description: 'Pin third-party CI actions to immutable full-length commit SHAs where supported', allowNo: true }),
    'package-age-days': Flags.integer({ description: 'Normal package age gate in full days', min: 0, max: 365 }),
    'high-risk-package-age-days': Flags.integer({ description: 'High-risk package/tooling age gate in full days', min: 0, max: 365 }),
    'unverified-risk-approval': Flags.boolean({ description: 'Require approval for unverifiable package age, identity, source/provenance, integrity, or execution risk', allowNo: true }),
    'package-manager-defaults': Flags.boolean({ description: 'Write project-level npm secure defaults; never writes user-level configuration', allowNo: true }),
  };

  static examples = commandExamples('init');

  async run(): Promise<void> {
    const parsed = await this.parse(Init).catch((err: unknown) => {
      if (argvRequestsJson(this.argv)) {
        const cause = err instanceof Error ? err.message : String(err);
        this.logJson({ ok: false, command: 'init', error: `Failed to parse init arguments. Likely cause: ${cause}. Next action: run \`aie init --help\` and use a supported flag value.` });
        process.exitCode = 1;
        return null;
      }
      throw err;
    });
    if (parsed === null) return;
    const { args, flags } = parsed;
    if (!args.target || isHelpToken(args.target)) {
      if (flags.json) {
        this.logJson({ ok: true, command: 'init', usage: INIT_USAGE, examples: Init.examples });
        return;
      }
      this.log(usageLines().join('\n'));
      return;
    }

    try {
      const flagPolicy = policyFromFlags(flags);
      const prompted = !flags.json && !flags.yes && !flags.defaults && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY) && targetIsGitRepository(args.target);
      const promptBaseConfig = prompted ? await loadConfig(args.target) ?? getDefaults() : getDefaults();
      const captured = prompted ? await promptForPolicy(flagPolicy, flags.tool, promptBaseConfig) : { tool: (flags.tool ?? 'opencode') as InitToolFlag, policy: flagPolicy };
      const result = await runInit({ target: args.target, tool: captured.tool, dryRun: flags['dry-run'], force: flags.force, policy: captured.policy });
      if (flags.json) this.logJson(result);
      else this.log(formatInitHuman(result));
      if (!result.ok) process.exitCode = 1;
    } catch (err: unknown) {
      const cause = err instanceof Error ? err.message : String(err);
      const message = `Failed to run \`aie init\`. Likely cause: ${cause}. Next action: rerun \`aie init ${args.target} --dry-run --json\` and resolve blocked file actions.`;
      if (flags.json) {
        this.logJson({ ok: false, command: 'init', error: message });
        process.exitCode = 1;
        return;
      }
      this.error(message, { exit: 1 });
    }
  }
}
