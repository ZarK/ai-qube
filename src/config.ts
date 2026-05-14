/**
 * Executor repository config model (M1.3).
 *
 * Discovers aie.config.json from the current repository root.
 * Provides defaults matching the spec, validation, and stable error kinds for JSON output.
 * Later commands (doctor, init, start, labels, pr gate) consume this.
 *
 * No mutation. No external deps.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ExecutorConfig {
  version: 1;
  priorities: string[];
  statuses: string[];
  components: string[];
  branchNaming: string;
  baseBranch: string;
  baseRemote: string;
  noWorktree: boolean;
  blockOnOpenPRs: boolean;
  ignoredAutomationPRAuthors: string[];
  reviewAgents: string[];
  reviewWaitMinutes: number;
  manualUIAudit: boolean;
  qualityGateCommands: string[];
  autonomousShipping: boolean;
  promptInjectionWarning: boolean;
  noCreditWarning: boolean;
}

export const DEFAULT_CONFIG: ExecutorConfig = {
  version: 1,
  priorities: ['P1-Critical', 'P2-High', 'P3-Medium', 'P4-Low'],
  statuses: ['S-Ready', 'S-InProgress', 'S-Blocked', 'S-Blocking'],
  components: [
    'C-Architecture', 'C-Backend', 'C-Frontend', 'C-Testing',
    'C-Tooling', 'C-Docs', 'C-DevEx', 'C-CI', 'C-Security', 'C-Data',
  ],
  branchNaming: 'issue/<number>-<slug>',
  baseBranch: 'main',
  baseRemote: 'origin',
  noWorktree: true,
  blockOnOpenPRs: true,
  ignoredAutomationPRAuthors: ['dependabot[bot]', 'renovate[bot]', 'github-actions[bot]'],
  reviewAgents: ['copilot', 'coderabbit', 'custom'],
  reviewWaitMinutes: 10,
  manualUIAudit: true,
  qualityGateCommands: [],
  autonomousShipping: true,
  promptInjectionWarning: true,
  noCreditWarning: true,
};

export type ConfigErrorKind =
  | 'CONFIG_NOT_FOUND'
  | 'CONFIG_PARSE_ERROR'
  | 'CONFIG_INVALID_VERSION'
  | 'CONFIG_INVALID_LABELS'
  | 'CONFIG_INVALID_BRANCH'
  | 'CONFIG_INVALID_WAIT';

export interface ConfigLoadResult {
  config: ExecutorConfig | null;
  path: string | null;
  error?: { kind: ConfigErrorKind; message: string; cause?: string; nextAction: string };
}

/**
 * Find repository root by walking up for .git or package.json.
 */
function findRepoRoot(startDir: string = process.cwd()): string | null {
  let dir = startDir;
  while (dir !== path.parse(dir).root) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Load and validate Executor config from the repo root.
 * Returns structured result with error info for --json and doctor.
 */
export function loadConfig(cwd: string = process.cwd()): ConfigLoadResult {
  const root = findRepoRoot(cwd);
  if (!root) {
    return {
      config: null,
      path: null,
      error: {
        kind: 'CONFIG_NOT_FOUND',
        message: 'Not inside a git repository',
        nextAction: 'cd to the repository root or run aie init . to create scaffolding',
      },
    };
  }

  const configPath = path.join(root, 'aie.config.json');
  if (!fs.existsSync(configPath)) {
    return {
      config: { ...DEFAULT_CONFIG },
      path: null,
      error: {
        kind: 'CONFIG_NOT_FOUND',
        message: 'aie.config.json not found; using defaults',
        nextAction: 'Run aie init . or aie repo prime to create the config file',
      },
    };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (e: unknown) {
    return {
      config: null,
      path: configPath,
      error: {
        kind: 'CONFIG_PARSE_ERROR',
        message: 'Failed to read aie.config.json',
        cause: String(e),
        nextAction: 'Check file permissions and retry',
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: unknown) {
    return {
      config: null,
      path: configPath,
      error: {
        kind: 'CONFIG_PARSE_ERROR',
        message: 'aie.config.json is not valid JSON',
        cause: String(e),
        nextAction: 'Fix the JSON syntax or delete the file and run aie init',
      },
    };
  }

  const validation = validateConfig(parsed as Partial<ExecutorConfig>);
  if (validation.error) {
    return {
      config: null,
      path: configPath,
      error: validation.error,
    };
  }

  return {
    config: validation.config!,
    path: configPath,
  };
}

function validateConfig(input: Partial<ExecutorConfig>): { config?: ExecutorConfig; error?: ConfigLoadResult['error'] } {
  if (!input || typeof input !== 'object') {
    return { error: { kind: 'CONFIG_PARSE_ERROR', message: 'Config must be an object', nextAction: 'Ensure aie.config.json contains a JSON object' } };
  }

  const version = input.version ?? 1;
  if (version !== 1) {
    return {
      error: {
        kind: 'CONFIG_INVALID_VERSION',
        message: `Unsupported config version: ${version}`,
        nextAction: 'Update to version 1 or delete the file and re-initialize',
      },
    };
  }

  const cfg: ExecutorConfig = {
    version: 1,
    priorities: Array.isArray(input.priorities) && input.priorities.length > 0 ? input.priorities as string[] : DEFAULT_CONFIG.priorities,
    statuses: Array.isArray(input.statuses) && input.statuses.length > 0 ? input.statuses as string[] : DEFAULT_CONFIG.statuses,
    components: Array.isArray(input.components) && input.components.length > 0 ? input.components as string[] : DEFAULT_CONFIG.components,
    branchNaming: typeof input.branchNaming === 'string' && input.branchNaming.length > 0 ? input.branchNaming : DEFAULT_CONFIG.branchNaming,
    baseBranch: typeof input.baseBranch === 'string' && input.baseBranch.length > 0 ? input.baseBranch : DEFAULT_CONFIG.baseBranch,
    baseRemote: typeof input.baseRemote === 'string' && input.baseRemote.length > 0 ? input.baseRemote : DEFAULT_CONFIG.baseRemote,
    noWorktree: typeof input.noWorktree === 'boolean' ? input.noWorktree : DEFAULT_CONFIG.noWorktree,
    blockOnOpenPRs: typeof input.blockOnOpenPRs === 'boolean' ? input.blockOnOpenPRs : DEFAULT_CONFIG.blockOnOpenPRs,
    ignoredAutomationPRAuthors: Array.isArray(input.ignoredAutomationPRAuthors) ? input.ignoredAutomationPRAuthors as string[] : DEFAULT_CONFIG.ignoredAutomationPRAuthors,
    reviewAgents: Array.isArray(input.reviewAgents) ? input.reviewAgents as string[] : DEFAULT_CONFIG.reviewAgents,
    reviewWaitMinutes: typeof input.reviewWaitMinutes === 'number' && input.reviewWaitMinutes > 0 ? input.reviewWaitMinutes : DEFAULT_CONFIG.reviewWaitMinutes,
    manualUIAudit: typeof input.manualUIAudit === 'boolean' ? input.manualUIAudit : DEFAULT_CONFIG.manualUIAudit,
    qualityGateCommands: Array.isArray(input.qualityGateCommands) ? input.qualityGateCommands as string[] : DEFAULT_CONFIG.qualityGateCommands,
    autonomousShipping: typeof input.autonomousShipping === 'boolean' ? input.autonomousShipping : DEFAULT_CONFIG.autonomousShipping,
    promptInjectionWarning: typeof input.promptInjectionWarning === 'boolean' ? input.promptInjectionWarning : DEFAULT_CONFIG.promptInjectionWarning,
    noCreditWarning: typeof input.noCreditWarning === 'boolean' ? input.noCreditWarning : DEFAULT_CONFIG.noCreditWarning,
  };

  // Basic validation for unsafe patterns
  if (cfg.branchNaming.includes('..') || cfg.branchNaming.includes('/../')) {
    return {
      error: {
        kind: 'CONFIG_INVALID_BRANCH',
        message: 'branchNaming contains unsafe path traversal',
        nextAction: 'Use a safe pattern such as "issue/<number>-<slug>"',
      },
    };
  }

  if (cfg.reviewWaitMinutes > 1440) {
    return {
      error: {
        kind: 'CONFIG_INVALID_WAIT',
        message: 'reviewWaitMinutes exceeds 24 hours',
        nextAction: 'Use a value between 1 and 1440 minutes',
      },
    };
  }

  // Label duplicates check (simple)
  const allLabels = [...cfg.priorities, ...cfg.statuses, ...cfg.components];
  const seen = new Set<string>();
  for (const l of allLabels) {
    if (seen.has(l)) {
      return {
        error: {
          kind: 'CONFIG_INVALID_LABELS',
          message: `Duplicate label "${l}" across families`,
          nextAction: 'Ensure priority, status, and component label sets are disjoint',
        },
      };
    }
    seen.add(l);
  }

  return { config: cfg };
}

/**
 * Convenience for commands: throws structured error or returns the config.
 */
export function requireConfig(): ExecutorConfig {
  const res = loadConfig();
  if (res.error && !res.config) {
    // For non-JSON paths, the caller can use the error
    throw new Error(`${res.error.kind}: ${res.error.message}; next: ${res.error.nextAction}`);
  }
  return res.config!;
}
