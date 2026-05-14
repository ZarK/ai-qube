/**
 * Shared command metadata model for Executor CLI.
 *
 * This is the single source of truth for:
 * - human help text (root landing, topic/incomplete, mutation labels)
 * - aie schema --json (agent contract)
 * - completion suggestions and "did you mean"
 * - error kinds and predictable exit codes
 * - dry-run / JSON capability
 *
 * Commands extend BaseCommand and import their spec from here.
 * Adding a new command requires only:
 * 1. Add CommandSpec entry here.
 * 2. Create thin src/commands/<id>.ts (or nested for topics) that extends BaseCommand.
 *
 * No generated code, no ad-hoc string parsing, no hidden global state.
 */

export const EXIT_CODES = {
  SUCCESS: 0,
  INTERNAL_ERROR: 1,
  USER_ERROR: 2,
  NOT_IMPLEMENTED: 3,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export interface CommandSpec {
  /** Stable command id, e.g. "doctor", "labels setup", "pr gate" */
  id: string;
  /** One-line summary for topic lists and root landing */
  summary: string;
  /** Full description shown in command help */
  description: string;
  /** Usage examples, each line starts with $ aie ... */
  examples: string[];
  /** True if command mutates local files, git state, or GitHub state */
  mutates: boolean;
  /** Whether --dry-run is supported (only for mutating commands) */
  supportsDryRun: boolean;
  /** Whether --json is supported for agent use */
  supportsJson: boolean;
  /** Stable error kinds this command can emit (for schema and tests) */
  errorKinds: string[];
  /** Default exit code on success */
  exitCode: ExitCode;
}

/** All known commands and topics. Order here affects root landing and schema output. */
export const COMMANDS: CommandSpec[] = [
  {
    id: 'doctor',
    summary: 'Check local environment, git, GitHub auth, and Executor config health',
    description:
      'Runs a series of non-mutating checks for Node version, git repository state, gh auth, linked worktree detection, base branch freshness, config presence and validity, and other prerequisites. Use before aie start or when troubleshooting.',
    examples: [
      '$ aie doctor',
      '$ aie doctor --json',
    ],
    mutates: false,
    supportsDryRun: false,
    supportsJson: true,
    errorKinds: ['MISSING_GIT', 'MISSING_GH', 'AUTH_FAILED', 'LINKED_WORKTREE', 'CONFIG_INVALID', 'BASE_BRANCH_MISMATCH'],
    exitCode: EXIT_CODES.SUCCESS,
  },
  {
    id: 'schema',
    summary: 'Emit machine-readable description of all commands, flags, and contracts',
    description:
      'Prints the complete command registry as JSON. Agents and tools use this instead of scraping --help. Includes mutation, dry-run, JSON support, examples, and stable error kinds for every command.',
    examples: [
      '$ aie schema --json',
    ],
    mutates: false,
    supportsDryRun: false,
    supportsJson: true,
    errorKinds: [],
    exitCode: EXIT_CODES.SUCCESS,
  },
  {
    id: 'completion',
    summary: 'Print shell completion installation instructions or scripts',
    description:
      'Outputs instructions for installing tab completion for bash, zsh, or fish. Completion covers command names, subcommands, and flags. No shell profile is modified by the package.',
    examples: [
      '$ aie completion --shell bash',
      '$ aie completion --shell zsh > ~/.zfunc/_aie',
    ],
    mutates: false,
    supportsDryRun: false,
    supportsJson: false,
    errorKinds: ['UNSUPPORTED_SHELL'],
    exitCode: EXIT_CODES.SUCCESS,
  },
  {
    id: 'init',
    summary: 'Initialize current repository for Executor issue workflow (creates config and installs instructions)',
    description:
      'Interactive (or --defaults) setup that appends Executor sections to AGENTS.md / CLAUDE.md, installs .opencode/commands/make-it-so.md when targeting OpenCode, writes aie.config.json with chosen policy, and optionally creates seed labels via aie labels setup.',
    examples: [
      '$ aie init .',
      '$ aie init . --tool opencode --defaults',
    ],
    mutates: true,
    supportsDryRun: true,
    supportsJson: true,
    errorKinds: ['ALREADY_INITIALIZED', 'INVALID_TOOL', 'WRITE_FAILED'],
    exitCode: EXIT_CODES.SUCCESS,
  },
  {
    id: 'labels',
    summary: 'Manage GitHub labels for priority, status, and components (topic)',
    description:
      'Parent topic for label operations. Use aie labels setup to create or update the required P1-Critical, S-Ready, C-Tooling etc. labels. Later subcommands will support listing and syncing.',
    examples: [
      '$ aie labels setup',
      '$ aie labels --help',
    ],
    mutates: true,
    supportsDryRun: true,
    supportsJson: true,
    errorKinds: ['LABEL_CREATE_FAILED', 'GH_AUTH_REQUIRED'],
    exitCode: EXIT_CODES.SUCCESS,
  },
  {
    id: 'labels setup',
    summary: 'Create or update required priority, status, and component labels in GitHub',
    description:
      'Idempotent: creates missing labels with correct color and description, updates existing ones that drifted, leaves unrelated labels untouched. Safe to run multiple times.',
    examples: [
      '$ aie labels setup',
      '$ aie labels setup --dry-run',
    ],
    mutates: true,
    supportsDryRun: true,
    supportsJson: true,
    errorKinds: ['GH_API_ERROR', 'MISSING_PERMISSIONS'],
    exitCode: EXIT_CODES.SUCCESS,
  },
  {
    id: 'repo prime',
    summary: 'Prepare repository for issue execution (labels + minimal config + instruction check)',
    description:
      'Verifies gh auth, ensures required labels exist, checks for existing issues and installed instructions, writes a minimal aie.config.json if missing, and reports what Bootstrap artifacts are still needed. Does not generate specs or milestones.',
    examples: [
      '$ aie repo prime',
      '$ aie repo prime --dry-run',
    ],
    mutates: true,
    supportsDryRun: true,
    supportsJson: true,
    errorKinds: ['GH_AUTH_REQUIRED', 'REPO_NOT_FOUND'],
    exitCode: EXIT_CODES.SUCCESS,
  },
  {
    id: 'queue',
    summary: 'Display the ordered GitHub issue execution queue',
    description:
      'Shows ready, in-progress, and blocked issues in priority order with blockers, sequence numbers, and recommended next action. Use --json for Umpire or agent consumption.',
    examples: [
      '$ aie queue',
      '$ aie queue --json',
    ],
    mutates: false,
    supportsDryRun: false,
    supportsJson: true,
    errorKinds: ['CONFIG_MISSING', 'GH_API_ERROR'],
    exitCode: EXIT_CODES.SUCCESS,
  },
  {
    id: 'next',
    summary: 'Return the next issue Executor would start or resume',
    description:
      'Non-mutating. Returns the single S-InProgress issue if one exists, otherwise the highest-priority S-Ready issue whose blockers are all closed. Used by autonomous loops.',
    examples: [
      '$ aie next --json',
    ],
    mutates: false,
    supportsDryRun: false,
    supportsJson: true,
    errorKinds: ['NO_READY_ISSUES', 'MULTIPLE_IN_PROGRESS'],
    exitCode: EXIT_CODES.SUCCESS,
  },
  {
    id: 'start',
    summary: 'Start or resume work on a specific issue or the next ready one',
    description:
      'Validates pre-start policy (no linked worktree, no blocking open PRs, base branch current), removes S-Ready/S-Blocked labels, adds S-InProgress, optionally assigns, and creates a standard "started work" comment when enabled. Requires issue number or "next".',
    examples: [
      '$ aie start next',
      '$ aie start 42',
      '$ aie start 42 --dry-run',
    ],
    mutates: true,
    supportsDryRun: true,
    supportsJson: true,
    errorKinds: ['BLOCKED_BY_OPEN_PR', 'LINKED_WORKTREE', 'BASE_BRANCH_MISMATCH', 'ISSUE_NOT_FOUND', 'ALREADY_IN_PROGRESS'],
    exitCode: EXIT_CODES.SUCCESS,
  },
  {
    id: 'view',
    summary: 'Show issue title, body, labels, blockers, acceptance criteria, and next action',
    description:
      'Renders a focused view of one issue including computed blocker graph and recommended Executor command to run next. Use before starting or when context switching.',
    examples: [
      '$ aie view 42',
      '$ aie view 42 --json',
    ],
    mutates: false,
    supportsDryRun: false,
    supportsJson: true,
    errorKinds: ['ISSUE_NOT_FOUND'],
    exitCode: EXIT_CODES.SUCCESS,
  },
  {
    id: 'switch',
    summary: 'Pause current work and start a different eligible issue',
    description:
      'Moves the current S-InProgress issue back to appropriate ready/blocked state, then starts the target issue. Preserves queue integrity.',
    examples: [
      '$ aie switch 67',
      '$ aie switch 67 --dry-run',
    ],
    mutates: true,
    supportsDryRun: true,
    supportsJson: true,
    errorKinds: ['NO_CURRENT_IN_PROGRESS', 'TARGET_BLOCKED'],
    exitCode: EXIT_CODES.SUCCESS,
  },
  {
    id: 'complete',
    summary: 'Mark issue complete after PR merge, unblock dependents, update queue',
    description:
      'Must be run after the PR for the issue is merged. Closes or labels the issue complete, removes S-InProgress, reconciles S-Ready/S-Blocked on all affected issues whose blockers are now satisfied, and reports the newly ready work.',
    examples: [
      '$ aie complete 42',
      '$ aie complete 42 --dry-run',
    ],
    mutates: true,
    supportsDryRun: true,
    supportsJson: true,
    errorKinds: ['PR_NOT_MERGED', 'ISSUE_ALREADY_COMPLETE'],
    exitCode: EXIT_CODES.SUCCESS,
  },
  {
    id: 'deps',
    summary: 'Inspect and repair issue dependency graph (blockers, chains, ready list)',
    description:
      'Topic for dependency helpers. Subcommands expose the blocker graph that drives queue ordering and label sync. aie deps fix reconciles stale S-Ready/S-Blocked labels from live GitHub state.',
    examples: [
      '$ aie deps blockers 42',
      '$ aie deps ready',
      '$ aie deps fix --dry-run',
    ],
    mutates: false,
    supportsDryRun: true,
    supportsJson: true,
    errorKinds: ['ISSUE_NOT_FOUND'],
    exitCode: EXIT_CODES.SUCCESS,
  },
  {
    id: 'deps blockers',
    summary: 'List open issues that block the given issue',
    description: 'Shows the direct open blockers for a specific issue. Use to understand why an issue is S-Blocked or to plan fixes.',
    examples: [
      '$ aie deps blockers 42 --json',
    ],
    mutates: false,
    supportsDryRun: false,
    supportsJson: true,
    errorKinds: ['ISSUE_NOT_FOUND'],
    exitCode: EXIT_CODES.SUCCESS,
  },
  {
    id: 'deps blocking',
    summary: 'List open issues blocked by the given issue',
    description: 'Shows issues that cannot start until the given issue is resolved. Useful for impact analysis before completing work.',
    examples: [
      '$ aie deps blocking 42 --json',
    ],
    mutates: false,
    supportsDryRun: false,
    supportsJson: true,
    errorKinds: ['ISSUE_NOT_FOUND'],
    exitCode: EXIT_CODES.SUCCESS,
  },
  {
    id: 'deps chain',
    summary: 'Show full dependency chain for an issue (transitive blockers)',
    description: 'Renders the transitive closure of blockers for an issue, helping agents understand deep prerequisite chains.',
    examples: [
      '$ aie deps chain 42',
    ],
    mutates: false,
    supportsDryRun: false,
    supportsJson: true,
    errorKinds: ['ISSUE_NOT_FOUND'],
    exitCode: EXIT_CODES.SUCCESS,
  },
  {
    id: 'deps ready',
    summary: 'List all issues that are ready to start (no open blockers, S-Ready)',
    description: 'The authoritative list of issues an agent can pick up next without violating blocker or priority rules.',
    examples: [
      '$ aie deps ready --json',
    ],
    mutates: false,
    supportsDryRun: false,
    supportsJson: true,
    errorKinds: [],
    exitCode: EXIT_CODES.SUCCESS,
  },
  {
    id: 'deps blocked',
    summary: 'List all open issues that are blocked by at least one other open issue',
    description: 'All issues currently prevented from starting by open blockers. Complements aie queue for planning.',
    examples: [
      '$ aie deps blocked',
    ],
    mutates: false,
    supportsDryRun: false,
    supportsJson: true,
    errorKinds: [],
    exitCode: EXIT_CODES.SUCCESS,
  },
  {
    id: 'deps graph',
    summary: 'Print the full dependency graph in human or JSON form',
    description: 'Dumps the complete directed graph of issue blockers for advanced analysis or Umpire integration.',
    examples: [
      '$ aie deps graph --json',
    ],
    mutates: false,
    supportsDryRun: false,
    supportsJson: true,
    errorKinds: [],
    exitCode: EXIT_CODES.SUCCESS,
  },
  {
    id: 'deps fix',
    summary: 'Reconcile S-Ready and S-Blocked labels from the live blocker graph',
    description:
      'Non-mutating by default with --dry-run. Updates labels so that issues whose blockers are all closed become S-Ready, and issues with open blockers become S-Blocked. Never touches S-InProgress issues.',
    examples: [
      '$ aie deps fix --dry-run',
      '$ aie deps fix',
    ],
    mutates: true,
    supportsDryRun: true,
    supportsJson: true,
    errorKinds: ['LABEL_SYNC_FAILED'],
    exitCode: EXIT_CODES.SUCCESS,
  },
  {
    id: 'pr',
    summary: 'Pull request helpers (topic)',
    description:
      'Parent for PR-related commands. Primary subcommand is aie pr gate <number> which requests configured review agents, waits, and inspects results before merge.',
    examples: [
      '$ aie pr gate 123',
      '$ aie pr --help',
    ],
    mutates: true,
    supportsDryRun: true,
    supportsJson: true,
    errorKinds: ['PR_NOT_FOUND', 'REVIEW_TIMEOUT'],
    exitCode: EXIT_CODES.SUCCESS,
  },
  {
    id: 'pr gate',
    summary: 'Request review agents, wait, and report review state for a PR',
    description:
      'Triggers the repository-configured PR review agents (Copilot, CodeRabbit, custom, etc.), waits the configured duration (default 10 min), then fetches and summarizes review comments, approvals, and requested changes. Fails the gate if material issues remain.',
    examples: [
      '$ aie pr gate 123',
      '$ aie pr gate 123 --wait 5m --dry-run',
    ],
    mutates: true,
    supportsDryRun: true,
    supportsJson: true,
    errorKinds: ['PR_NOT_FOUND', 'REVIEW_GATE_FAILED', 'NO_REVIEWERS_CONFIGURED'],
    exitCode: EXIT_CODES.SUCCESS,
  },
  {
    id: 'migrate legacy',
    summary: 'Audit and migrate a repository that previously used copied shell scripts',
    description:
      'Detects legacy gh-*.sh helpers, old AGENTS.md Executor blocks, and .opencode/commands that call the old scripts. Offers dry-run plan, compatibility wrappers, or full replacement with package-backed aie commands and instructions.',
    examples: [
      '$ aie migrate legacy --dry-run',
      '$ aie migrate legacy',
    ],
    mutates: true,
    supportsDryRun: true,
    supportsJson: true,
    errorKinds: ['LEGACY_NOT_DETECTED', 'MIGRATION_REFUSED'],
    exitCode: EXIT_CODES.SUCCESS,
  },
];

/** Map for fast lookup by id */
export const COMMAND_BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));

/** All command ids (for suggestions, schema, completion) */
export const ALL_COMMAND_IDS: string[] = COMMANDS.map((c) => c.id);

/**
 * Return the spec for a command id, or undefined if unknown.
 */
export function getCommandSpec(id: string): CommandSpec | undefined {
  return COMMAND_BY_ID.get(id);
}

/**
 * Simple similarity for "did you mean" suggestions.
 * Returns up to 3 close ids when confidence is reasonable.
 * No external deps; pure stdlib.
 */
export function suggestSimilarCommands(unknownId: string, limit = 3): string[] {
  const input = unknownId.toLowerCase();
  const scored: Array<{ id: string; score: number }> = [];

  for (const id of ALL_COMMAND_IDS) {
    const lower = id.toLowerCase();
    let score = similarity(input, lower);

    // Boost for prefix or first-word match (e.g. "labl" -> "labels")
    const firstWord = lower.split(/[\s/]+/)[0];
    if (lower.includes(input) || input.includes(firstWord) || firstWord.includes(input)) {
      score = Math.max(score, 0.75);
    }

    // Levenshtein-based for typos
    const dist = levenshtein(input, lower);
    const maxLen = Math.max(input.length, lower.length, 1);
    const levScore = 1 - dist / maxLen;
    if (levScore > 0.6) {
      score = Math.max(score, levScore);
    }

    if (score > 0.55) {
      scored.push({ id, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.id);
}

/** Jaccard-ish token overlap + length diff penalty. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const tokensA = new Set(a.split(/[\s/]+/));
  const tokensB = new Set(b.split(/[\s/]+/));
  const intersect = new Set([...tokensA].filter((x) => tokensB.has(x)));
  const union = new Set([...tokensA, ...tokensB]);
  const jaccard = union.size === 0 ? 0 : intersect.size / union.size;
  const lenPenalty = Math.abs(a.length - b.length) / Math.max(a.length, b.length, 1);
  return jaccard * (1 - lenPenalty * 0.3);
}

/** Tiny Levenshtein for short-string typo detection (stdlib only). */
function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const m = b.length + 1;
  const n = a.length + 1;
  const dp: number[] = new Array(m * n);
  for (let i = 0; i < n; i++) dp[i] = i;
  for (let j = 0; j < m; j++) dp[j * n] = j;
  for (let j = 1; j < m; j++) {
    for (let i = 1; i < n; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const idx = j * n + i;
      dp[idx] = Math.min(
        dp[j * n + (i - 1)] + 1,
        dp[(j - 1) * n + i] + 1,
        dp[(j - 1) * n + (i - 1)] + cost
      );
    }
  }
  return dp[m * n - 1];
}
