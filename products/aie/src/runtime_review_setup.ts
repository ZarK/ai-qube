import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { formatConfigFile, getDefaults, type Config, type GitHubReviewPublisherConfig } from './config/index.js';
import {
  buildGitHubAppSetupGuidance,
  buildTokenSetupGuidance,
  formatReviewDoctor,
  publisherMissingFields,
  REVIEW_PUBLISHER_ROLE_BOUNDARY,
  runReviewDoctor,
  safeSecretReferences,
  type ReviewDoctorResult,
  type ReviewPublisherResolver,
  type ReviewSetupGuidance,
} from './review_setup.js';

export type ReviewSetupMode = 'github-app' | 'token';

export interface ReviewSetupPrompt {
  readonly id: 'appId' | 'installationId' | 'privateKeyEnv' | 'privateKeyPath' | 'tokenEnv';
  readonly message: string;
}

export type ReviewSetupPromptFunction = (question: ReviewSetupPrompt) => Promise<string>;

export interface RunReviewSetupOptions {
  readonly mode: ReviewSetupMode;
  readonly config: Config | null;
  readonly configPath: string;
  readonly root: string;
  readonly appId?: string;
  readonly installationId?: string;
  readonly privateKeyEnv?: string;
  readonly privateKeyPath?: string;
  readonly tokenEnv?: string;
  readonly login?: string;
  readonly yes?: boolean;
  readonly dryRun?: boolean;
  readonly json?: boolean;
  readonly noProbe?: boolean;
  readonly isTTY?: boolean;
  readonly prompt?: ReviewSetupPromptFunction;
  readonly resolvePublisher?: ReviewPublisherResolver;
  readonly writeConfig?: (path: string, content: string) => Promise<void>;
}

export interface ReviewSetupResult {
  readonly ok: boolean;
  readonly command: 'review setup github-app' | 'review setup token';
  readonly mode: ReviewSetupMode;
  readonly applied: boolean;
  readonly dryRun: boolean;
  readonly configPath: string;
  readonly publisher: GitHubReviewPublisherConfig | null;
  readonly secretReferences: Readonly<Record<string, string>>;
  readonly missingFields: readonly string[];
  readonly validationErrors: readonly string[];
  readonly guidance: ReviewSetupGuidance;
  readonly doctor: ReviewDoctorResult | null;
  readonly nextAction: string;
  readonly roleBoundary: string;
}

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

function suspiciousSecretReference(value: string): boolean {
  return value.includes('\n')
    || value.includes('\r')
    || value.includes('BEGIN ')
    || value.startsWith('ghp_')
    || value.startsWith('github_pat_')
    || value.length > 128;
}

function validateEnvironmentName(value: string | undefined, flag: string): string[] {
  if (!value) return [];
  if (suspiciousSecretReference(value)) return [`${flag} must be an environment variable name, never token or private-key material.`];
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return [`${flag} must be a valid environment variable name.`];
  return [];
}

function validatePrivateKeyPath(value: string | undefined): string[] {
  if (!value) return [];
  if (suspiciousSecretReference(value)) return ['--private-key-path must be a local filesystem path, never private-key or token material.'];
  return [];
}

function validateInputs(input: {
  mode: ReviewSetupMode;
  privateKeyEnv?: string;
  privateKeyPath?: string;
  tokenEnv?: string;
}): string[] {
  const errors = [
    ...validateEnvironmentName(input.privateKeyEnv, '--private-key-env'),
    ...validatePrivateKeyPath(input.privateKeyPath),
    ...validateEnvironmentName(input.tokenEnv, '--token-env'),
  ];
  if (input.mode === 'github-app' && input.privateKeyEnv && input.privateKeyPath) {
    errors.push('Use exactly one of --private-key-env or --private-key-path.');
  }
  return errors;
}

function buildPublisher(input: {
  mode: ReviewSetupMode;
  appId?: string;
  installationId?: string;
  privateKeyEnv?: string;
  privateKeyPath?: string;
  tokenEnv?: string;
  login?: string;
}): GitHubReviewPublisherConfig {
  if (input.mode === 'github-app') {
    return {
      mode: 'github-app',
      githubApp: {
        appId: input.appId ?? '',
        installationId: input.installationId ?? '',
        ...(input.privateKeyEnv ? { privateKeyEnv: input.privateKeyEnv } : {}),
        ...(input.privateKeyPath ? { privateKeyPath: input.privateKeyPath } : {}),
        ...(input.login ? { login: input.login } : {}),
      },
    };
  }
  return {
    mode: 'token',
    token: {
      env: input.tokenEnv ?? '',
      ...(input.login ? { login: input.login } : {}),
    },
  };
}

async function promptForMissing(
  mode: ReviewSetupMode,
  values: { appId?: string; installationId?: string; privateKeyEnv?: string; privateKeyPath?: string; tokenEnv?: string },
  prompt: ReviewSetupPromptFunction,
): Promise<typeof values> {
  if (mode === 'token') {
    if (!values.tokenEnv) values.tokenEnv = trimmed(await prompt({ id: 'tokenEnv', message: 'Environment variable name containing the fine-grained token' }));
    return values;
  }
  if (!values.appId) values.appId = trimmed(await prompt({ id: 'appId', message: 'GitHub App id' }));
  if (!values.installationId) values.installationId = trimmed(await prompt({ id: 'installationId', message: 'GitHub App installation id' }));
  if (!values.privateKeyEnv && !values.privateKeyPath) {
    values.privateKeyEnv = trimmed(await prompt({ id: 'privateKeyEnv', message: 'Environment variable name containing the private key PEM (leave blank to use a path)' }));
    if (!values.privateKeyEnv) values.privateKeyPath = trimmed(await prompt({ id: 'privateKeyPath', message: 'Local private key path' }));
  }
  return values;
}

function configWithPublisher(config: Config | null, publisher: GitHubReviewPublisherConfig): Config {
  const base = config ?? getDefaults();
  return {
    ...base,
    providers: {
      ...base.providers,
      review: { kind: 'github', publisher },
    },
  };
}

async function defaultWriteConfig(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

function nextAction(input: { mode: ReviewSetupMode; missingFields: readonly string[]; applied: boolean; dryRun: boolean; yes: boolean }): string {
  if (input.missingFields.length > 0) return `Provide ${input.missingFields.join(', ')}. Re-run \`qube review setup ${input.mode}\` with those safe references; no secret material belongs in command flags or config.`;
  if (input.dryRun) return `Remove --dry-run and add --yes to write the planned ${input.mode} publisher config.`;
  if (!input.applied && !input.yes) return `Add --yes to write the planned ${input.mode} publisher config, or run interactively in a terminal.`;
  return 'Review publisher config is written. Follow the doctor next action to resolve any credential or permission finding.';
}

export async function runReviewSetup(options: RunReviewSetupOptions): Promise<ReviewSetupResult> {
  const command = `review setup ${options.mode}` as const;
  const guidance = options.mode === 'github-app' ? buildGitHubAppSetupGuidance() : buildTokenSetupGuidance();
  const values = {
    appId: trimmed(options.appId),
    installationId: trimmed(options.installationId),
    privateKeyEnv: trimmed(options.privateKeyEnv),
    privateKeyPath: trimmed(options.privateKeyPath),
    tokenEnv: trimmed(options.tokenEnv),
  };
  let validationErrors = validateInputs({ mode: options.mode, ...values });
  if (validationErrors.length > 0) {
    return {
      ok: false, command, mode: options.mode, applied: false, dryRun: options.dryRun === true, configPath: options.configPath,
      publisher: null, secretReferences: {}, missingFields: [], validationErrors, guidance, doctor: null,
      nextAction: 'Replace embedded credential material with an environment variable name or local key path, then rerun setup.',
      roleBoundary: REVIEW_PUBLISHER_ROLE_BOUNDARY,
    };
  }

  const interactive = options.isTTY === true && options.yes !== true && options.json !== true && options.prompt;
  const needsPrompt = options.mode === 'token'
    ? !values.tokenEnv
    : !values.appId || !values.installationId || (!values.privateKeyEnv && !values.privateKeyPath);
  const prompted = Boolean(interactive && needsPrompt);
  if (prompted) await promptForMissing(options.mode, values, options.prompt as ReviewSetupPromptFunction);
  validationErrors = validateInputs({ mode: options.mode, ...values });
  if (validationErrors.length > 0) {
    return {
      ok: false, command, mode: options.mode, applied: false, dryRun: options.dryRun === true, configPath: options.configPath,
      publisher: null, secretReferences: {}, missingFields: [], validationErrors, guidance, doctor: null,
      nextAction: 'Replace the invalid credential reference and rerun setup.', roleBoundary: REVIEW_PUBLISHER_ROLE_BOUNDARY,
    };
  }

  const publisher = buildPublisher({ mode: options.mode, ...values, login: trimmed(options.login) });
  const missingFields = publisherMissingFields(publisher);
  const shouldApply = missingFields.length === 0 && options.dryRun !== true && (options.yes === true || prompted);
  const plannedConfig = configWithPublisher(options.config, publisher);
  if (shouldApply) await (options.writeConfig ?? defaultWriteConfig)(options.configPath, formatConfigFile(plannedConfig));
  const doctor = missingFields.length === 0
    ? await runReviewDoctor({
      config: plannedConfig,
      cwd: options.root,
      mintProbe: shouldApply && options.noProbe !== true,
      resolvePublisher: options.resolvePublisher,
    })
    : null;
  const applied = shouldApply;
  return {
    ok: true,
    command,
    mode: options.mode,
    applied,
    dryRun: options.dryRun === true,
    configPath: options.configPath,
    publisher,
    secretReferences: safeSecretReferences(publisher),
    missingFields,
    validationErrors: [],
    guidance,
    doctor,
    nextAction: applied
      ? doctor?.nextAction ?? 'Run `qube review doctor --json` to validate publisher readiness.'
      : nextAction({ mode: options.mode, missingFields, applied, dryRun: options.dryRun === true, yes: options.yes === true }),
    roleBoundary: REVIEW_PUBLISHER_ROLE_BOUNDARY,
  };
}

export function formatReviewSetup(result: ReviewSetupResult): string {
  const lines = [
    result.guidance.title,
    result.guidance.summary,
    '',
    'Required repository permissions:',
    ...result.guidance.requiredPermissions.map(permission => `- ${permission}`),
    '',
    'Setup steps:',
    ...result.guidance.steps.map((step, index) => `${index + 1}. ${step}`),
  ];
  if (result.guidance.limitation) lines.push('', `Limitation: ${result.guidance.limitation}`);
  lines.push(
    '',
    `Config: ${result.configPath}`,
    `Applied: ${result.applied ? 'yes' : 'no'}${result.dryRun ? ' (dry-run)' : ''}`,
    `Missing flags: ${result.missingFields.join(', ') || 'none'}`,
    `Setup next action: ${result.nextAction}`,
  );
  if (result.validationErrors.length > 0) lines.push(...result.validationErrors.map(error => `Validation error: ${error}`));
  if (result.doctor) lines.push('', formatReviewDoctor(result.doctor));
  else lines.push(result.roleBoundary);
  return lines.join('\n');
}
