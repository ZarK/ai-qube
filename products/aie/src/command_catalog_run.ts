import {
  RUN_START_FLAG_DETAILS,
  RUN_STATUS_FLAG_DETAILS,
  RUN_STOP_FLAG_DETAILS,
  RUN_WAIT_FLAG_DETAILS,
} from './command_flag_details.js';
import type { ExecutorCommandDefinition } from './command_definition.js';

const CONFIG_ERROR_KINDS = ['missing', 'invalid', 'unknown', 'duplicate'];
export const RUN_COMMAND_ARGS = ['command', ...Array.from({ length: 12 }, (_, index) => `commandArg${index + 1}`)];

export const RUN_COMMAND_DEFINITIONS: ExecutorCommandDefinition[] = [
  {
    name: 'run',
    description: 'Manage local long-running app processes for UI audits with persistent metadata, logs, bounded waits, and stop support.',
    args: [],
    flags: ['--help'],
    mutationTargets: [],
    supportsJson: false,
    supportsDryRun: false,
    examples: ['aie run start --name ui-audit -- npm run dev', 'aie run wait --name ui-audit --url http://127.0.0.1:3000 --timeout 30', 'aie run status --name ui-audit', 'aie run stop --name ui-audit'],
  },
  {
    name: 'run start',
    description: 'Start a local app process with hidden Windows-safe spawn options, persistent metadata, and deterministic stdout/stderr logs.',
    args: RUN_COMMAND_ARGS,
    flags: RUN_START_FLAG_DETAILS.map(flag => flag.name),
    flagDetails: RUN_START_FLAG_DETAILS,
    mutationTargets: ['local-process', 'local-files'],
    supportsJson: true,
    supportsDryRun: true,
    stableErrorKinds: ['parse-error', 'local-runner-error', ...CONFIG_ERROR_KINDS],
    examples: ['aie run start --name ui-audit -- npm run dev', 'aie run start --name ui-audit --cwd apps/web -- pnpm dev', 'aie run start --name ui-audit --dry-run -- npm start'],
  },
  {
    name: 'run wait',
    description: 'Poll one local readiness URL for a named local app process with a hard timeout and captured log tails on failure.',
    args: [],
    flags: RUN_WAIT_FLAG_DETAILS.map(flag => flag.name),
    flagDetails: RUN_WAIT_FLAG_DETAILS,
    mutationTargets: [],
    supportsJson: true,
    supportsDryRun: false,
    externalServices: ['local-http'],
    stableErrorKinds: ['parse-error', 'local-runner-error', 'readiness-timeout', ...CONFIG_ERROR_KINDS],
    examples: ['aie run wait --name ui-audit --url http://127.0.0.1:3000 --timeout 30', 'aie run wait --url http://localhost:5173 --json'],
  },
  {
    name: 'run status',
    description: 'Inspect a named local app process from persisted runner metadata and show recent stdout/stderr log tails.',
    args: [],
    flags: RUN_STATUS_FLAG_DETAILS.map(flag => flag.name),
    flagDetails: RUN_STATUS_FLAG_DETAILS,
    mutationTargets: [],
    supportsJson: true,
    supportsDryRun: false,
    stableErrorKinds: ['parse-error', 'local-runner-error', ...CONFIG_ERROR_KINDS],
    examples: ['aie run status --name ui-audit', 'aie run status --name ui-audit --json'],
  },
  {
    name: 'run stop',
    description: 'Stop a named local app process tree and remove persisted runner metadata while keeping logs for audit/debugging.',
    args: [],
    flags: RUN_STOP_FLAG_DETAILS.map(flag => flag.name),
    flagDetails: RUN_STOP_FLAG_DETAILS,
    mutationTargets: ['local-process', 'local-files'],
    supportsJson: true,
    supportsDryRun: true,
    stableErrorKinds: ['parse-error', 'local-runner-error', ...CONFIG_ERROR_KINDS],
    examples: ['aie run stop --name ui-audit', 'aie run stop --name ui-audit --dry-run', 'aie run stop --name ui-audit --json'],
  },
];
