import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { formatConfigFile, getDefaults, type Config, type GitHubReviewPublisherConfig } from './config/index.js';
import {
  buildGitHubAppSetupGuidance,
  formatReviewDoctor,
  publisherMissingFields,
  REVIEW_PUBLISHER_ROLE_BOUNDARY,
  runReviewDoctor,
  safeSecretReferences,
  type ReviewDoctorResult,
  type ReviewPublisherResolver,
  type ReviewSetupGuidance,
} from './review_setup.js';

export type ReviewSetupMode = 'github-app';

export interface ReviewSetupPrompt {
  readonly id: 'appId' | 'installationId' | 'privateKeyEnv' | 'privateKeyPath';
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
  readonly command: 'review setup github-app';
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

const GITHUB_TOKEN_PREFIX = /(?:^|[^A-Za-z0-9_])(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/;

function looksLikeCredentialMaterial(value: string): boolean {
  return value.includes('\n')
    || value.includes('\r')
    || /BEGIN [A-Z ]*PRIVATE KEY|BEGIN CERTIFICATE/i.test(value)
    || GITHUB_TOKEN_PREFIX.test(value)
    || /^(?:github_pat_|gh[pousr]_)/i.test(value);
}

function validateEnvironmentName(value: string | undefined, flag: string): string[] {
  if (!value) return [];
  if (looksLikeCredentialMaterial(value) || value.length > 128) {
    return [`${flag} must be an environment variable name, never token or private-key material.`];
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return [`${flag} must be a valid environment variable name.`];
  return [];
}

function validatePrivateKeyPath(value: string | undefined): string[] {
  if (!value) return [];
  if (looksLikeCredentialMaterial(value) || value.length > 1024) {
    return ['--private-key-path must be a local filesystem path, never private-key or token material.'];
  }
  return [];
}

function validatePublicIdentifier(value: string | undefined, flag: string): string[] {
  if (!value) return [];
  if (looksLikeCredentialMaterial(value) || value.length > 128) {
    return [`${flag} must be a public identifier, never token or private-key material.`];
  }
  // Logins may include [bot] and alphanumerics; app/installation ids are validated separately.
  if (!/^[A-Za-z0-9][A-Za-z0-9._\[\]-]*$/.test(value)) {
    return [`${flag} must be a public identifier such as a login or bot slug.`];
  }
  return [];
}

function validateNumericIdentifier(value: string | undefined, flag: string): string[] {
  if (!value) return [];
  if (looksLikeCredentialMaterial(value) || value.length > 32) {
    return [`${flag} must be a numeric identifier, never token or private-key material.`];
  }
  if (!/^[1-9][0-9]*$/.test(value)) {
    return [`${flag} must be a positive decimal GitHub identifier.`];
  }
  return [];
}

function validateInputs(input: {
  mode: ReviewSetupMode;
  appId?: string;
  installationId?: string;
  privateKeyEnv?: string;
  privateKeyPath?: string;
  login?: string;
}): string[] {
  const errors = [
    ...validateNumericIdentifier(input.appId, '--app-id'),
    ...validateNumericIdentifier(input.installationId, '--installation-id'),
    ...validatePublicIdentifier(input.login, '--login'),
    ...validateEnvironmentName(input.privateKeyEnv, '--private-key-env'),
    ...validatePrivateKeyPath(input.privateKeyPath),
  ];
  if (input.privateKeyEnv && input.privateKeyPath) {
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
  login?: string;
}): GitHubReviewPublisherConfig {
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

async function promptForMissing(
  values: { appId?: string; installationId?: string; privateKeyEnv?: string; privateKeyPath?: string },
  prompt: ReviewSetupPromptFunction,
): Promise<typeof values> {
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
  const guidance = buildGitHubAppSetupGuidance();
  const values = {
    appId: trimmed(options.appId),
    installationId: trimmed(options.installationId),
    privateKeyEnv: trimmed(options.privateKeyEnv),
    privateKeyPath: trimmed(options.privateKeyPath),
  };
  const login = trimmed(options.login);
  let validationErrors = validateInputs({ mode: options.mode, ...values, login });
  if (validationErrors.length > 0) {
    return {
      ok: false, command, mode: options.mode, applied: false, dryRun: options.dryRun === true, configPath: options.configPath,
      publisher: null, secretReferences: {}, missingFields: [], validationErrors, guidance, doctor: null,
      nextAction: 'Replace embedded credential material with an environment variable name or local key path, then rerun setup.',
      roleBoundary: REVIEW_PUBLISHER_ROLE_BOUNDARY,
    };
  }

  const interactive = options.isTTY === true && options.yes !== true && options.json !== true && options.prompt;
  const needsPrompt = !values.appId || !values.installationId || (!values.privateKeyEnv && !values.privateKeyPath);
  const prompted = Boolean(interactive && needsPrompt);
  if (prompted) await promptForMissing(values, options.prompt as ReviewSetupPromptFunction);
  validationErrors = validateInputs({ mode: options.mode, ...values, login });
  if (validationErrors.length > 0) {
    return {
      ok: false, command, mode: options.mode, applied: false, dryRun: options.dryRun === true, configPath: options.configPath,
      publisher: null, secretReferences: {}, missingFields: [], validationErrors, guidance, doctor: null,
      nextAction: 'Replace the invalid credential reference and rerun setup.', roleBoundary: REVIEW_PUBLISHER_ROLE_BOUNDARY,
    };
  }

  const publisher = buildPublisher({ mode: options.mode, ...values, login });
  const missingFields = publisherMissingFields(publisher);
  const applyIntended = options.yes === true || prompted;
  // Guidance-only invocations succeed without apply. Explicit apply intent that cannot
  // produce a complete publisher config is a false-success and must fail.
  if (missingFields.length > 0 && applyIntended) {
    return {
      ok: false,
      command,
      mode: options.mode,
      applied: false,
      dryRun: options.dryRun === true,
      configPath: options.configPath,
      publisher,
      secretReferences: safeSecretReferences(publisher),
      missingFields,
      validationErrors: [],
      guidance,
      doctor: null,
      nextAction: nextAction({ mode: options.mode, missingFields, applied: false, dryRun: options.dryRun === true, yes: options.yes === true }),
      roleBoundary: REVIEW_PUBLISHER_ROLE_BOUNDARY,
    };
  }
  const shouldApply = missingFields.length === 0 && options.dryRun !== true && applyIntended;
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
