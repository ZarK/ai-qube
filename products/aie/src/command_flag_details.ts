import type { CommandFlagSchema } from './command_metadata.js';

export const GATE_STAGE_OPTIONS = ['all', 'pre-pr', 'pre-merge'];
export const PR_REVIEW_AGENT_VALUES = ['copilot', 'cubic', 'coderabbit', 'custom', 'local'];
export const REVIEW_AGENT_VALUES = ['oracle', 'opencode-oracle', 'fallback-oracle', 'custom', 'local'];

export const INIT_FLAG_DETAILS: CommandFlagSchema[] = [
  { name: '--json', type: 'boolean', description: 'Emit machine-readable init plan or result', default: false },
  { name: '--dry-run', type: 'boolean', description: 'Show planned local file changes without writing', default: false },
  { name: '--force', type: 'boolean', description: 'Replace blocked managed sections or known fields intentionally', default: false },
  { name: '--yes', type: 'boolean', description: 'Run non-interactively using provided values and defaults', default: false },
  { name: '--defaults', type: 'boolean', description: 'Use default repository policy values without prompting', default: false },
  { name: '--tool', type: 'string', description: 'Agent host projection to install', options: ['opencode', 'codex', 'claude-code', 'all'], default: 'opencode' },
  { name: '--branch-naming', type: 'string', description: 'Issue branch naming pattern containing <number> and <slug>' },
  { name: '--base-branch', type: 'string', description: 'Configured base branch for freshness checks', default: 'main' },
  { name: '--base-remote', type: 'string', description: 'Configured base remote for freshness checks', default: 'origin' },
  { name: '--worktree', type: 'boolean', description: 'Allow linked git worktrees' },
  { name: '--no-worktree', type: 'boolean', description: 'Disallow linked git worktrees' },
  { name: '--block-open-prs', type: 'boolean', description: 'Block new issue work while non-automation PRs are open' },
  { name: '--no-block-open-prs', type: 'boolean', description: 'Do not block new issue work for open PRs' },
  { name: '--base-branch-freshness', type: 'boolean', description: 'Require the local base branch to match the configured remote' },
  { name: '--no-base-branch-freshness', type: 'boolean', description: 'Disable local base branch freshness policy' },
  { name: '--autonomous', type: 'boolean', description: 'Authorize autonomous issue shipping under repository policy' },
  { name: '--no-autonomous', type: 'boolean', description: 'Disable autonomous shipping authority' },
  { name: '--assign-on-start', type: 'boolean', description: 'Assign issues when starting work' },
  { name: '--no-assign-on-start', type: 'boolean', description: 'Do not assign issues when starting work' },
  { name: '--comment-on-start', type: 'boolean', description: 'Comment on issues when starting work' },
  { name: '--no-comment-on-start', type: 'boolean', description: 'Do not comment on issues when starting work' },
  { name: '--ignored-automation-author', type: 'string', description: 'Open PR author ignored by the blocking policy', multiple: true },
  { name: '--priority-label', type: 'string', description: 'Priority label to manage', multiple: true },
  { name: '--status-label', type: 'string', description: 'Status label to manage', multiple: true },
  { name: '--component-label', type: 'string', description: 'Component label to manage', multiple: true },
  { name: '--milestone-ordering', type: 'boolean', description: 'Enable GitHub milestone ordering hints' },
  { name: '--no-milestone-ordering', type: 'boolean', description: 'Disable GitHub milestone ordering hints' },
  { name: '--milestone-order', type: 'string', description: 'Configured GitHub milestone title order', multiple: true },
  { name: '--missing-milestone', type: 'string', description: 'Policy for issues missing milestones when milestone ordering is enabled', options: ['ignore', 'warn', 'block'], default: 'warn' },
  { name: '--manual-ui-audit', type: 'boolean', description: 'Require manual audit for user-facing UI changes' },
  { name: '--no-manual-ui-audit', type: 'boolean', description: 'Disable manual UI audit policy' },
  { name: '--ui-audit-app-launch', type: 'string', description: 'Command agents should run to start the app for manual UI audit evidence' },
  { name: '--ui-audit-target', type: 'string', description: 'URL, route, or screen agents should inspect during manual UI audits' },
  { name: '--opencode-command-alias', type: 'boolean', description: 'Install optional makeitso OpenCode command alias' },
  { name: '--no-opencode-command-alias', type: 'boolean', description: 'Do not install optional makeitso OpenCode command alias' },
  { name: '--quality-gate', type: 'string', description: 'Agent-run quality gate command', multiple: true },
  { name: '--review-agent', type: 'string', description: 'Configured review agent', multiple: true },
  { name: '--review-request-text', type: 'string', description: 'Custom review request text for configured review agents' },
  { name: '--review-wait-minutes', type: 'integer', description: 'Minutes to wait for configured review gates', default: 10 },
  { name: '--quality-control', type: 'boolean', description: 'Record intent to run Quality Control gates when available' },
  { name: '--no-quality-control', type: 'boolean', description: 'Do not record Quality Control gate intent' },
  { name: '--naming-rules', type: 'boolean', description: 'Include optional naming-rules instructions' },
  { name: '--no-naming-rules', type: 'boolean', description: 'Disable optional naming-rules instructions' },
  { name: '--prompt-injection-warning', type: 'boolean', description: 'Include prompt-injection safety instructions' },
  { name: '--no-prompt-injection-warning', type: 'boolean', description: 'Disable prompt-injection safety instructions' },
  { name: '--credit-warning', type: 'boolean', description: 'Include no-credit safety instructions' },
  { name: '--no-credit-warning', type: 'boolean', description: 'Disable no-credit safety instructions' },
  { name: '--implementation-guardrails', type: 'boolean', description: 'Include implementation guardrail instructions' },
  { name: '--no-implementation-guardrails', type: 'boolean', description: 'Disable implementation guardrail instructions' },
  { name: '--supply-chain-safety', type: 'boolean', description: 'Include supply-chain safety instructions' },
  { name: '--no-supply-chain-safety', type: 'boolean', description: 'Disable supply-chain safety instructions' },
  { name: '--exact-dependency-versions', type: 'boolean', description: 'Require exact dependency versions in supply-chain policy' },
  { name: '--no-exact-dependency-versions', type: 'boolean', description: 'Disable exact dependency version policy' },
  { name: '--intentional-lockfile-changes', type: 'boolean', description: 'Require intentional lockfile changes in supply-chain policy' },
  { name: '--no-intentional-lockfile-changes', type: 'boolean', description: 'Disable intentional lockfile change policy' },
  { name: '--disable-lifecycle-scripts', type: 'boolean', description: 'Disable dependency lifecycle scripts where supported' },
  { name: '--no-disable-lifecycle-scripts', type: 'boolean', description: 'Do not disable dependency lifecycle scripts by policy' },
  { name: '--pin-ci-actions', type: 'boolean', description: 'Pin third-party CI actions to immutable full-length commit SHAs where supported' },
  { name: '--no-pin-ci-actions', type: 'boolean', description: 'Disable third-party CI action pinning policy' },
  { name: '--package-age-days', type: 'integer', description: 'Normal package age gate in full days', default: 7 },
  { name: '--high-risk-package-age-days', type: 'integer', description: 'High-risk package or tooling age gate in full days', default: 14 },
  { name: '--unverified-risk-approval', type: 'boolean', description: 'Require approval for unverifiable package age, identity, source/provenance, integrity, or execution risk' },
  { name: '--no-unverified-risk-approval', type: 'boolean', description: 'Follow repository policy for unverifiable package risk' },
  { name: '--package-manager-defaults', type: 'boolean', description: 'Write project-level npm secure defaults' },
  { name: '--no-package-manager-defaults', type: 'boolean', description: 'Do not write project-level package-manager defaults' },
  { name: '--help', type: 'boolean', description: 'Show command help' },
];

export const GATES_PLAN_FLAG_DETAILS: CommandFlagSchema[] = [
  { name: '--json', type: 'boolean', description: 'Emit machine-readable gate plan', default: false },
  { name: '--dry-run', type: 'boolean', description: 'Show the gate plan without running configured commands', default: false },
  { name: '--stage', type: 'string', description: 'Filter gates by stage; all-stage gates are included when filtering', options: GATE_STAGE_OPTIONS },
  { name: '--help', type: 'boolean', description: 'Show command help' },
];

export const GATES_STATUS_FLAG_DETAILS: CommandFlagSchema[] = [
  { name: '--json', type: 'boolean', description: 'Emit machine-readable gate status', default: false },
  { name: '--stage', type: 'string', description: 'Filter gates by stage; all-stage gates are included when filtering', options: GATE_STAGE_OPTIONS },
  { name: '--help', type: 'boolean', description: 'Show command help' },
];

export const MIGRATE_LEGACY_FLAG_DETAILS: CommandFlagSchema[] = [
  { name: '--json', type: 'boolean', description: 'Emit machine-readable legacy migration plan', default: false },
  { name: '--dry-run', type: 'boolean', description: 'Show the full legacy migration plan without writing files', default: false },
  { name: '--apply', type: 'boolean', description: 'Apply explicitly requested migration writes, wrapper installs, or cleanup removals', default: false },
  { name: '--cleanup', type: 'boolean', description: 'Plan or apply cleanup for known legacy helper files', default: false },
  { name: '--install-wrappers', type: 'boolean', description: 'Plan or install compatibility wrappers for known legacy helper files', default: false },
  { name: '--force', type: 'boolean', description: 'Allow selected unmanaged instruction files or explicit cleanup paths after review', default: false },
  { name: '--instruction', type: 'string', description: 'Instruction or command file path to migrate; repeat or comma-separate', multiple: true },
  { name: '--path', type: 'string', description: 'Legacy helper file path to include in cleanup; repeat or comma-separate', multiple: true },
  { name: '--help', type: 'boolean', description: 'Show command help' },
];

export const MIGRATE_MAP_FLAG_DETAILS: CommandFlagSchema[] = [
  { name: '--json', type: 'boolean', description: 'Emit machine-readable legacy command mapping', default: false },
  { name: '--help', type: 'boolean', description: 'Show command help' },
];

export const AUDIT_UI_FLAG_DETAILS: CommandFlagSchema[] = [
  { name: '--json', type: 'boolean', description: 'Emit machine-readable manual UI audit guidance', default: false },
  { name: '--dry-run', type: 'boolean', description: 'Show the audit plan without writing local evidence directories', default: false },
  { name: '--prepare', type: 'boolean', description: 'Create the local evidence directory and screenshots directory if missing', default: false },
  { name: '--check', type: 'boolean', description: 'Check whether local audit evidence files or notes exist without claiming pass/fail', default: false },
  { name: '--help', type: 'boolean', description: 'Show command help' },
];

export const REVIEW_GATE_FLAG_DETAILS: CommandFlagSchema[] = [
  { name: '--json', type: 'boolean', description: 'Emit machine-readable review gate guidance', default: false },
  { name: '--dry-run', type: 'boolean', description: 'Show the review gate plan without invoking reviewers or writing evidence', default: false },
  { name: '--prompt', type: 'boolean', description: 'Print only the configured review prompt', default: false },
  { name: '--help', type: 'boolean', description: 'Show command help' },
];

export const PR_GATE_FLAG_DETAILS: CommandFlagSchema[] = [
  { name: '--json', type: 'boolean', description: 'Emit machine-readable PR review gate output', default: false },
  { name: '--dry-run', type: 'boolean', description: 'Show reviewer request, comment, and wait plans without mutating GitHub or sleeping', default: false },
  { name: '--local-review-prompts', type: 'boolean', description: 'Include full local review lane promptText and spawnPrompt bodies for independent host subagent execution; paste spawnPrompt verbatim when spawning reviewers', default: false },
  { name: '--help', type: 'boolean', description: 'Show command help' },
];

export const PR_REVIEW_PUBLISH_FLAG_DETAILS: CommandFlagSchema[] = [
  { name: '--json', type: 'boolean', description: 'Emit machine-readable lane review publish output', default: false },
  { name: '--dry-run', type: 'boolean', description: 'Show the provider-visible lane pull request review without mutating GitHub', default: false },
  { name: '--lane', type: 'string', description: 'Local review lane id to publish for the current PR head' },
  { name: '--issue', type: 'integer', description: 'Linked issue number for the lane evidence when the PR does not expose one' },
  { name: '--help', type: 'boolean', description: 'Show command help' },
];

export const PR_VIEW_FLAG_DETAILS: CommandFlagSchema[] = [
  { name: '--json', type: 'boolean', description: 'Emit machine-readable concise PR state', default: false },
  { name: '--help', type: 'boolean', description: 'Show command help' },
];

export const PR_BODY_FLAG_DETAILS: CommandFlagSchema[] = [
  { name: '--json', type: 'boolean', description: 'Emit machine-readable PR body draft and merge-readiness output', default: false },
  { name: '--help', type: 'boolean', description: 'Show command help' },
];

export const RUN_START_FLAG_DETAILS: CommandFlagSchema[] = [
  { name: '--json', type: 'boolean', description: 'Emit machine-readable local app runner start output', default: false },
  { name: '--dry-run', type: 'boolean', description: 'Show spawn options and metadata paths without starting a process', default: false },
  { name: '--name', type: 'string', description: 'Stable runner name used by later status, wait, and stop commands', default: 'ui-audit' },
  { name: '--cwd', type: 'string', description: 'Working directory for the app command, resolved relative to the repository root', default: '.' },
  { name: '--help', type: 'boolean', description: 'Show command help' },
];

export const RUN_WAIT_FLAG_DETAILS: CommandFlagSchema[] = [
  { name: '--json', type: 'boolean', description: 'Emit machine-readable local app readiness output', default: false },
  { name: '--name', type: 'string', description: 'Stable runner name to inspect', default: 'ui-audit' },
  { name: '--url', type: 'string', description: 'HTTP URL to poll until a bounded readiness result is reached' },
  { name: '--timeout', type: 'integer', description: 'Maximum readiness wait in seconds', default: 30 },
  { name: '--help', type: 'boolean', description: 'Show command help' },
];

export const RUN_STATUS_FLAG_DETAILS: CommandFlagSchema[] = [
  { name: '--json', type: 'boolean', description: 'Emit machine-readable local app runner status output', default: false },
  { name: '--name', type: 'string', description: 'Stable runner name to inspect', default: 'ui-audit' },
  { name: '--help', type: 'boolean', description: 'Show command help' },
];

export const RUN_STOP_FLAG_DETAILS: CommandFlagSchema[] = [
  { name: '--json', type: 'boolean', description: 'Emit machine-readable local app runner stop output', default: false },
  { name: '--dry-run', type: 'boolean', description: 'Show the process that would be stopped without killing it or removing metadata', default: false },
  { name: '--name', type: 'string', description: 'Stable runner name to stop', default: 'ui-audit' },
  { name: '--help', type: 'boolean', description: 'Show command help' },
];

export const CHECKLIST_UPDATE_FLAG_DETAILS: CommandFlagSchema[] = [
  { name: '--json', type: 'boolean', description: 'Emit machine-readable issue checklist mutation output', default: false },
  { name: '--dry-run', type: 'boolean', description: 'Plan the issue checklist body update without mutating GitHub', default: false },
  { name: '--item', type: 'string', description: 'Exact checklist item text to update' },
  { name: '--index', type: 'integer', description: '1-based checklist item index to update' },
  { name: '--state', type: 'string', description: 'Target checklist state', options: ['checked', 'unchecked'], default: 'checked' },
  { name: '--help', type: 'boolean', description: 'Show command help' },
];

export const CHECKLIST_VERIFY_FLAG_DETAILS: CommandFlagSchema[] = [
  { name: '--json', type: 'boolean', description: 'Emit machine-readable acceptance verification output', default: false },
  { name: '--dry-run', type: 'boolean', description: 'Validate evidence and plan the single checkbox mutation without editing GitHub', default: false },
  { name: '--prompt', type: 'boolean', description: 'Print only the criterion-specific acceptance verification prompt', default: false },
  { name: '--index', type: 'integer', description: '1-based checklist item index to verify' },
  { name: '--evidence', type: 'string', description: 'Path to criterion-specific acceptance verification evidence JSON' },
  { name: '--state', type: 'string', description: 'Target checklist state after evidence validation', options: ['checked'], default: 'checked' },
  { name: '--help', type: 'boolean', description: 'Show command help' },
];
