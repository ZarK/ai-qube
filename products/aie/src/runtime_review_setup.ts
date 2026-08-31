import { createPrivateKey } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';

import {
  defineGuidedQuestion,
  renderGuidedFailure,
  renderGuidedSummary,
  type GuidedChoice,
  type GuidedPresenter,
  type GuidedPromptResult,
  type GuidedQuestion,
} from '@tjalve/qube-cli/guided';

import {
  configToFileShape,
  formatConfigFile,
  formatUserReviewPublisherFile,
  getDefaults,
  looksLikeReviewCredentialMaterial,
  userReviewPublisherPath,
  validateConfig,
  type Config,
  type GitHubReviewPublisherConfig,
  type ReviewPublisherConfigField,
  type ReviewPublisherConfigSource,
} from './config/index.js';
import {
  discoverGitHubAppInstallations,
  type GitHubAppInstallationCandidate,
} from './providers/github_adapter_exports.js';
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
export type ReviewSetupScope = 'repo' | 'global';

export type ReviewInstallationDiscoverer = typeof discoverGitHubAppInstallations;

export interface ReviewSetupDiscovery {
  readonly status: 'not-run' | 'selected' | 'multiple' | 'unavailable' | 'cancelled';
  readonly candidates: readonly GitHubAppInstallationCandidate[];
  readonly selectedInstallationId: string | null;
  readonly reason: string | null;
}

export interface ReviewInstallationIdentity {
  readonly appId: string;
  readonly privateKeyEnv?: string;
  readonly privateKeyPath?: string;
}

export interface RunReviewSetupOptions {
  readonly mode: ReviewSetupMode;
  readonly scope?: ReviewSetupScope;
  /** Effective config after global, repository, and overlay resolution. */
  readonly config: Config | null;
  readonly configPath: string;
  readonly root: string;
  readonly repositoryConfig?: Readonly<Record<string, unknown>> | null;
  readonly userPublisher?: Readonly<Record<string, unknown>> | null;
  readonly userConfigPath?: string;
  readonly publisherSource?: ReviewPublisherConfigSource;
  readonly publisherFieldSources?: Readonly<Partial<Record<ReviewPublisherConfigField, ReviewPublisherConfigSource>>>;
  readonly homeDirectory?: string;
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
  readonly presenter?: GuidedPresenter;
  readonly discoverInstallations?: ReviewInstallationDiscoverer;
  readonly matchRepositoryInstallations?: (
    candidates: readonly GitHubAppInstallationCandidate[],
    publisher: ReviewInstallationIdentity,
  ) => Promise<readonly GitHubAppInstallationCandidate[]>;
  readonly resolvePublisher?: ReviewPublisherResolver;
  readonly writeConfig?: (path: string, content: string) => Promise<void>;
}

export interface ReviewSetupResult {
  readonly ok: boolean;
  readonly command: 'review setup github-app';
  readonly mode: ReviewSetupMode;
  readonly scope: ReviewSetupScope;
  readonly applied: boolean;
  readonly changed: boolean;
  readonly dryRun: boolean;
  readonly configPath: string;
  readonly publisher: GitHubReviewPublisherConfig | null;
  readonly publisherSource: ReviewPublisherConfigSource;
  readonly publisherFieldSources: Readonly<Partial<Record<ReviewPublisherConfigField, ReviewPublisherConfigSource>>>;
  readonly secretReferences: Readonly<Record<string, string>>;
  readonly missingFields: readonly string[];
  readonly validationErrors: readonly string[];
  readonly guidance: ReviewSetupGuidance;
  readonly discovery: ReviewSetupDiscovery;
  readonly doctor: ReviewDoctorResult | null;
  readonly readiness: ReviewDoctorResult['readiness'] | 'not-checked';
  readonly nextAction: string;
  readonly roleBoundary: string;
}

type SetupValues = {
  appId?: string;
  installationId?: string;
  privateKeyEnv?: string;
  privateKeyPath?: string;
  login?: string;
};

const APP_DOCUMENTATION = {
  label: 'GitHub App registration settings',
  url: 'https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app',
} as const;
const INSTALLATION_DOCUMENTATION = {
  label: 'GitHub App installation authentication',
  url: 'https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation',
} as const;

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

function looksLikeCredentialMaterial(value: string): boolean {
  return looksLikeReviewCredentialMaterial(value);
}

function validateAppId(value: string | undefined): string | undefined {
  if (!value) return 'Enter the numeric App ID from the GitHub App settings.';
  if (/^Iv/i.test(value)) return 'This value looks like a GitHub Client ID. QUBE needs the numeric App ID from the App settings.';
  if (looksLikeCredentialMaterial(value) || value.length > 32 || !/^[1-9][0-9]*$/.test(value)) return 'The App ID must be a positive decimal GitHub identifier.';
  return undefined;
}

function validateInstallationId(value: string | undefined): string | undefined {
  if (value && /^Iv/i.test(value)) return 'This value looks like a GitHub Client ID. QUBE needs the numeric ID of an installed GitHub App instance.';
  if (!value || !/^[1-9][0-9]*$/.test(value) || value.length > 32) return 'The installation ID must be a positive decimal GitHub identifier.';
  return undefined;
}

function validateEnvironmentName(value: string | undefined): string | undefined {
  if (!value || looksLikeCredentialMaterial(value) || value.length > 128 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return 'Enter an environment variable name, never private-key or token material.';
  return undefined;
}

function validateLogin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (looksLikeCredentialMaterial(value) || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._\[\]-]*$/.test(value)) return 'The login must be a public bot login or other public identifier, never credential material.';
  return undefined;
}

export function normalizeReviewPrivateKeyPath(value: string, root: string, homeDirectory?: string): string {
  const input = value.trim();
  if (!input) throw new Error('Enter a local private-key path.');
  const startsQuote = input.startsWith('"') || input.startsWith("'");
  const endsQuote = input.endsWith('"') || input.endsWith("'");
  let unquoted = input;
  if (startsQuote || endsQuote) {
    if (!startsQuote || !endsQuote || input[0] !== input[input.length - 1]) throw new Error('The private-key path has unbalanced surrounding quotes. Remove or balance the quotes.');
    unquoted = input.slice(1, -1).trim();
  }
  if (!unquoted || looksLikeCredentialMaterial(unquoted) || unquoted.length > 1024) throw new Error('Enter a local filesystem path, never private-key or token material.');
  const home = resolve(homeDirectory ?? homedir());
  const expanded = unquoted === '~' ? home : /^~[\\/]/.test(unquoted) ? resolve(home, unquoted.slice(2)) : unquoted;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(root, expanded);
}

async function validatePrivateKeyReference(values: SetupValues, requireMaterial: boolean): Promise<string | undefined> {
  if (values.privateKeyEnv && values.privateKeyPath) return 'Choose one private-key reference: environment variable or local file.';
  if (!values.privateKeyEnv && !values.privateKeyPath) return 'Choose an environment variable or local private-key file.';
  if (values.privateKeyEnv) {
    const invalid = validateEnvironmentName(values.privateKeyEnv);
    if (invalid) return invalid;
    if (!requireMaterial) return undefined;
    const pem = process.env[values.privateKeyEnv];
    if (!pem?.trim()) return `Environment variable ${values.privateKeyEnv} is missing or empty.`;
    try { createPrivateKey(pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem); } catch { return `Environment variable ${values.privateKeyEnv} does not contain a valid private key.`; }
    return undefined;
  }
  if (!requireMaterial) return undefined;
  try {
    await access(values.privateKeyPath as string, constants.R_OK);
    createPrivateKey(await readFile(values.privateKeyPath as string, 'utf8'));
    return undefined;
  } catch {
    return 'The private-key file is missing, unreadable, or does not contain a valid private key.';
  }
}

function publisherFromUnknown(value: unknown): GitHubReviewPublisherConfig | null {
  if (!isRecord(value) || value.mode !== 'github-app' || !isRecord(value.githubApp)) return null;
  const app = value.githubApp;
  return { mode: 'github-app', githubApp: {
    appId: typeof app.appId === 'string' ? app.appId : '',
    installationId: typeof app.installationId === 'string' ? app.installationId : '',
    ...(typeof app.privateKeyEnv === 'string' ? { privateKeyEnv: app.privateKeyEnv } : {}),
    ...(typeof app.privateKeyPath === 'string' ? { privateKeyPath: app.privateKeyPath } : {}),
    ...(typeof app.login === 'string' ? { login: app.login } : {}),
  } };
}

function seedPublisher(options: RunReviewSetupOptions): GitHubReviewPublisherConfig | null {
  const global = publisherFromUnknown(options.userPublisher);
  if (options.scope === 'global') return global;
  const effective = options.config?.providers.review.publisher;
  return effective?.mode === 'github-app' ? effective : global;
}

function valuesFrom(options: RunReviewSetupOptions): SetupValues {
  const current = seedPublisher(options)?.githubApp;
  let privateKeyPath = trimmed(options.privateKeyPath) ?? current?.privateKeyPath;
  if (privateKeyPath) privateKeyPath = normalizeReviewPrivateKeyPath(privateKeyPath, options.root, options.homeDirectory);
  return {
    appId: trimmed(options.appId) ?? current?.appId,
    installationId: trimmed(options.installationId) ?? current?.installationId,
    privateKeyEnv: trimmed(options.privateKeyEnv) ?? (options.privateKeyPath ? undefined : current?.privateKeyEnv),
    privateKeyPath,
    login: trimmed(options.login) ?? current?.login,
  };
}

function buildPublisher(values: SetupValues): GitHubReviewPublisherConfig {
  return { mode: 'github-app', githubApp: {
    appId: values.appId ?? '', installationId: values.installationId ?? '',
    ...(values.privateKeyEnv ? { privateKeyEnv: values.privateKeyEnv } : {}),
    ...(values.privateKeyPath ? { privateKeyPath: values.privateKeyPath } : {}),
    ...(values.login ? { login: values.login } : {}),
  } };
}

function question<Value>(input: GuidedQuestion<Value>): Readonly<GuidedQuestion<Value>> {
  return defineGuidedQuestion<Value>(input);
}

async function askText(options: RunReviewSetupOptions, model: GuidedQuestion<string>): Promise<GuidedPromptResult<string> | undefined> {
  return options.presenter?.askText(model);
}

async function choose(options: RunReviewSetupOptions, model: GuidedQuestion<string>, choices: readonly GuidedChoice<string>[]): Promise<GuidedPromptResult<string> | undefined> {
  return options.presenter?.choose(model, choices);
}

function answerValue<Value>(result: GuidedPromptResult<Value> | undefined): Value | undefined { return result?.status === 'answered' ? result.value : undefined; }
function isCancelled(result: GuidedPromptResult<unknown> | undefined): boolean { return result?.status === 'cancelled'; }

async function collectInteractiveValues(options: RunReviewSetupOptions, values: SetupValues): Promise<{ cancelled: boolean }> {
  const interactive = options.isTTY === true && options.yes !== true && options.json !== true && Boolean(options.presenter);
  if (!interactive) return { cancelled: false };
  if (validateAppId(values.appId)) {
    const result = await askText(options, question({
      section: { number: 1, title: 'Identify the GitHub App' }, label: 'GitHub App ID',
      explanation: 'Use the numeric App ID. The Client ID starts with Iv and is a different value.',
      recommendation: { value: values.appId ?? '', reason: 'Preserve the current valid App ID when one is configured.' },
      documentation: APP_DOCUMENTATION,
      ...(values.appId ? { currentValue: values.appId, valueSource: options.publisherSource ?? 'current' } : {}),
      validation: { state: values.appId && !validateAppId(values.appId) ? 'valid' : 'unchecked', check: validateAppId },
    }));
    if (isCancelled(result)) return { cancelled: true };
    values.appId = answerValue(result);
  }
  if ((!values.privateKeyEnv && !values.privateKeyPath) || (values.privateKeyEnv && values.privateKeyPath)) {
    const result = await choose(options, question({
      section: { number: 2, title: 'Choose the private-key reference' }, label: 'Private-key reference',
      explanation: 'QUBE stores only a reference. It never stores or prints the private key.',
      recommendation: { value: 'environment', reason: 'An environment variable keeps the key outside repository and config files.' },
      validation: { state: 'unchecked' },
    }), [
      { value: 'environment', label: 'Environment variable', description: 'Recommended for local and automated use.', recommended: true },
      { value: 'local-file', label: 'Local file', description: 'Use a private key file outside the repository.' },
    ]);
    if (isCancelled(result)) return { cancelled: true };
    const source = answerValue(result);
    if (source === 'environment') {
      values.privateKeyPath = undefined;
      const envResult = await askText(options, question({
        section: { number: 2, title: 'Choose the private-key reference' }, label: 'Private-key environment variable',
        explanation: 'Enter the variable name. Do not enter PEM content.',
        recommendation: { value: 'QUBE_REVIEW_PUBLISHER_PRIVATE_KEY', reason: 'Use a specific variable for the Reviewer App key.' },
        validation: { state: 'unchecked', check: value => validatePrivateKeyReference({ privateKeyEnv: value }, true) },
      }));
      if (isCancelled(envResult)) return { cancelled: true };
      values.privateKeyEnv = answerValue(envResult);
    } else if (source === 'local-file') {
      values.privateKeyEnv = undefined;
      const pathResult = await askText(options, question({
        section: { number: 2, title: 'Choose the private-key reference' }, label: 'Local private-key path',
        explanation: 'Use a readable key file outside the repository. Balanced surrounding quotes are removed.',
        recommendation: { value: '~/.qube/keys/reviewer.pem', reason: 'Keep the key in a user-local QUBE directory.' },
        validation: { state: 'unchecked', check: async value => {
          try { return validatePrivateKeyReference({ privateKeyPath: normalizeReviewPrivateKeyPath(value, options.root, options.homeDirectory) }, true); }
          catch (error) { return error instanceof Error ? error.message : String(error); }
        } },
      }));
      if (isCancelled(pathResult)) return { cancelled: true };
      const path = answerValue(pathResult);
      if (path) values.privateKeyPath = normalizeReviewPrivateKeyPath(path, options.root, options.homeDirectory);
    }
  }
  const currentReferenceError = await validatePrivateKeyReference(values, true);
  if (currentReferenceError && values.privateKeyEnv) {
    const envResult = await askText(options, question({
      section: { number: 2, title: 'Choose the private-key reference' }, label: 'Private-key environment variable',
      explanation: 'The current variable is unavailable or does not contain a valid key. Enter a variable name that contains the Reviewer App private key.',
      recommendation: { value: values.privateKeyEnv, reason: 'Keep the current reference when its local key material is corrected.' },
      currentValue: values.privateKeyEnv, valueSource: options.publisherFieldSources?.['githubApp.privateKeyEnv'] ?? options.publisherSource ?? 'current',
      validation: { state: 'invalid', message: currentReferenceError, check: value => validatePrivateKeyReference({ privateKeyEnv: value }, true) },
    }));
    if (isCancelled(envResult)) return { cancelled: true };
    values.privateKeyEnv = answerValue(envResult);
  } else if (currentReferenceError && values.privateKeyPath) {
    const pathResult = await askText(options, question({
      section: { number: 2, title: 'Choose the private-key reference' }, label: 'Local private-key path',
      explanation: 'The current file is unavailable or invalid. Enter a readable Reviewer App private-key file.',
      recommendation: { value: values.privateKeyPath, reason: 'Keep the current normalized path when the local file is corrected.' },
      currentValue: values.privateKeyPath, valueSource: options.publisherFieldSources?.['githubApp.privateKeyPath'] ?? options.publisherSource ?? 'current',
      validation: { state: 'invalid', message: currentReferenceError, check: async value => {
        try { return validatePrivateKeyReference({ privateKeyPath: normalizeReviewPrivateKeyPath(value, options.root, options.homeDirectory) }, true); }
        catch (error) { return error instanceof Error ? error.message : String(error); }
      } },
    }));
    if (isCancelled(pathResult)) return { cancelled: true };
    const path = answerValue(pathResult);
    if (path) values.privateKeyPath = normalizeReviewPrivateKeyPath(path, options.root, options.homeDirectory);
  }
  return { cancelled: false };
}

async function discoverInstallation(options: RunReviewSetupOptions, values: SetupValues): Promise<ReviewSetupDiscovery> {
  if (values.installationId) return { status: 'not-run', candidates: [], selectedInstallationId: values.installationId, reason: 'An explicit or current installation ID is available.' };
  if (!values.appId || (!values.privateKeyEnv && !values.privateKeyPath)) return { status: 'not-run', candidates: [], selectedInstallationId: null, reason: 'App identity and private-key reference are required before discovery.' };
  let candidates: readonly GitHubAppInstallationCandidate[];
  try {
    const run = () => (options.discoverInstallations ?? discoverGitHubAppInstallations)({ appId: values.appId as string, ...(values.privateKeyEnv ? { privateKeyEnv: values.privateKeyEnv } : { privateKeyPath: values.privateKeyPath }) });
    candidates = options.presenter ? await options.presenter.progress({ action: 'Discovering GitHub App installations', success: 'GitHub App installations discovered' }, run) : await run();
  } catch (error) {
    return { status: 'unavailable', candidates: [], selectedInstallationId: null, reason: error instanceof Error ? error.message : String(error) };
  }
  if (options.matchRepositoryInstallations) {
    const matching = await options.matchRepositoryInstallations(candidates, {
      appId: values.appId,
      ...(values.privateKeyEnv ? { privateKeyEnv: values.privateKeyEnv } : {}),
      ...(values.privateKeyPath ? { privateKeyPath: values.privateKeyPath } : {}),
    });
    if ((options.scope ?? 'repo') === 'repo' || matching.length > 0) candidates = matching;
  }
  if (candidates.length === 0) return { status: 'unavailable', candidates, selectedInstallationId: null, reason: 'The GitHub App has no installation that can be selected for this scope.' };
  if (candidates.length === 1) {
    values.installationId = String(candidates[0]!.installationId);
    return { status: 'selected', candidates, selectedInstallationId: values.installationId, reason: 'One installation matched and was selected.' };
  }
  const choiceValues = new Map(candidates.map(candidate => [`installation-${candidate.installationId}`, candidate]));
  const result = await choose(options, question({
    section: { number: 3, title: 'Choose the App installation' }, label: 'GitHub App installation',
    explanation: 'Choose the named account or organization and repository scope. The numeric ID is secondary detail.',
    recommendation: { value: choiceValues.keys().next().value as string, reason: 'Use the installation that can access the current repository or intended owner.' },
    documentation: INSTALLATION_DOCUMENTATION,
    validation: { state: 'unchecked' },
  }), candidates.map(candidate => ({
    value: `installation-${candidate.installationId}`, label: candidate.label,
    description: candidate.repositorySelection === 'all' ? 'Can access all repositories for this account.' : 'Can access selected repositories.',
  })));
  if (isCancelled(result)) return { status: 'cancelled', candidates, selectedInstallationId: null, reason: 'Setup was cancelled before installation selection.' };
  const selected = answerValue(result);
  const candidate = selected ? choiceValues.get(selected) : undefined;
  if (!candidate) return { status: 'multiple', candidates, selectedInstallationId: null, reason: 'Several App installations are available.' };
  values.installationId = String(candidate.installationId);
  return { status: 'selected', candidates, selectedInstallationId: values.installationId, reason: 'The selected named installation will be used.' };
}

function sourceState(options: RunReviewSetupOptions, values: SetupValues): Pick<ReviewSetupResult, 'publisherSource' | 'publisherFieldSources'> {
  const sources: Partial<Record<ReviewPublisherConfigField, ReviewPublisherConfigSource>> = { ...(options.publisherFieldSources ?? {}) };
  const fields: readonly [keyof SetupValues, ReviewPublisherConfigField][] = [
    ['appId', 'githubApp.appId'], ['installationId', 'githubApp.installationId'], ['privateKeyEnv', 'githubApp.privateKeyEnv'], ['privateKeyPath', 'githubApp.privateKeyPath'], ['login', 'githubApp.login'],
  ];
  for (const [key, field] of fields) if (values[key] === undefined) delete sources[field];
  const explicit: readonly [keyof RunReviewSetupOptions, ReviewPublisherConfigField][] = [
    ['appId', 'githubApp.appId'], ['installationId', 'githubApp.installationId'], ['privateKeyEnv', 'githubApp.privateKeyEnv'], ['privateKeyPath', 'githubApp.privateKeyPath'], ['login', 'githubApp.login'],
  ];
  for (const [option, field] of explicit) if (options[option] !== undefined) sources[field] = 'explicit';
  sources.mode = options.scope === 'global' ? 'user-global' : (sources.mode ?? options.publisherSource ?? 'repository');
  for (const [key, field] of fields) if (values[key] !== undefined && sources[field] === undefined) sources[field] = options.scope === 'global' ? 'user-global' : (options.publisherSource ?? 'repository');
  const observed = Object.values(sources);
  const publisherSource: ReviewPublisherConfigSource = observed.includes('explicit') ? 'explicit'
    : observed.includes('machine-local') ? 'machine-local'
      : observed.includes('repository') ? 'repository'
        : observed.includes('user-global') ? 'user-global' : 'default';
  return { publisherSource, publisherFieldSources: Object.freeze(sources) };
}

function configWithPublisher(config: Config | null, publisher: GitHubReviewPublisherConfig): Config {
  const base = config ?? getDefaults();
  return { ...base, providers: { ...base.providers, review: { ...base.providers.review, kind: 'github', publisher } } };
}

function repositoryConfigContent(raw: Readonly<Record<string, unknown>> | null | undefined, publisher: GitHubReviewPublisherConfig): string {
  const base = raw ? JSON.parse(JSON.stringify(raw)) as Record<string, unknown> : configToFileShape(getDefaults()) as unknown as Record<string, unknown>;
  const providers = isRecord(base.providers) ? { ...base.providers } : {};
  const review = isRecord(providers.review) ? { ...providers.review } : {};
  providers.review = { ...review, kind: 'github', publisher };
  base.providers = providers;
  const validation = validateConfig(base);
  if (!validation.ok || !validation.config) throw new Error(validation.errors[0]?.message ?? 'Repository Executor config is invalid.');
  return formatConfigFile(validation.config);
}

function targetPublisher(options: RunReviewSetupOptions): GitHubReviewPublisherConfig | null {
  if ((options.scope ?? 'repo') === 'global') return publisherFromUnknown(options.userPublisher);
  const record = options.repositoryConfig;
  if (!record || !isRecord(record.providers) || !isRecord(record.providers.review)) return null;
  return publisherFromUnknown(record.providers.review.publisher);
}

function hasExplicitPublisherInput(options: RunReviewSetupOptions): boolean {
  return options.appId !== undefined || options.installationId !== undefined || options.privateKeyEnv !== undefined
    || options.privateKeyPath !== undefined || options.login !== undefined;
}

function samePublisher(left: GitHubReviewPublisherConfig | null, right: GitHubReviewPublisherConfig): boolean { return JSON.stringify(left) === JSON.stringify(right); }
async function defaultWriteConfig(path: string, content: string): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content, 'utf8'); }
function setupCommand(scope: ReviewSetupScope): string { return `qube review setup github-app${scope === 'global' ? ' --config-scope global' : ''}`; }
function incompleteNextAction(scope: ReviewSetupScope, fields: readonly string[]): string { return `Provide ${fields.join(', ')}. Re-run \`${setupCommand(scope)}\` with safe references only.`; }

function failureResult(input: { options: RunReviewSetupOptions; scope: ReviewSetupScope; configPath: string; guidance: ReviewSetupGuidance; publisher: GitHubReviewPublisherConfig | null; errors: readonly string[]; missingFields?: readonly string[]; discovery?: ReviewSetupDiscovery; nextAction: string; changed?: boolean; applied?: boolean }): ReviewSetupResult {
  const sources = input.publisher ? sourceState(input.options, input.publisher.githubApp ?? {}) : { publisherSource: 'default' as const, publisherFieldSources: {} };
  return {
    ok: false, command: 'review setup github-app', mode: 'github-app', scope: input.scope,
    applied: input.applied ?? false, changed: input.changed ?? false, dryRun: input.options.dryRun === true,
    configPath: input.configPath, publisher: input.publisher, ...sources,
    secretReferences: safeSecretReferences(input.publisher), missingFields: input.missingFields ?? [], validationErrors: input.errors,
    guidance: input.guidance, discovery: input.discovery ?? { status: 'not-run', candidates: [], selectedInstallationId: null, reason: null },
    doctor: null, readiness: 'not-checked', nextAction: input.nextAction, roleBoundary: REVIEW_PUBLISHER_ROLE_BOUNDARY,
  };
}

export async function runReviewSetup(options: RunReviewSetupOptions): Promise<ReviewSetupResult> {
  const scope = options.scope ?? 'repo';
  const guidance = buildGitHubAppSetupGuidance();
  const configPath = scope === 'global' ? (options.userConfigPath ?? userReviewPublisherPath(options.homeDirectory)) : options.configPath;
  let values: SetupValues;
  try { values = valuesFrom(options); }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return failureResult({ options, scope, configPath, guidance, publisher: null, errors: [reason], nextAction: `Correct the private-key path, then rerun \`${setupCommand(scope)}\`.` });
  }
  const earlyErrors = [validateAppId(values.appId), validateLogin(values.login)].filter((value): value is string => Boolean(value));
  if (options.appId !== undefined && earlyErrors.length > 0) return failureResult({ options, scope, configPath, guidance, publisher: null, errors: earlyErrors, nextAction: `Correct the App ID, then rerun \`${setupCommand(scope)}\`.` });

  const initialPublisher = buildPublisher(values);
  const initialTarget = targetPublisher(options);
  const initiallyUnchanged = publisherMissingFields(initialPublisher).length === 0
    && samePublisher(scope === 'repo' && !initialTarget && !hasExplicitPublisherInput(options) ? seedPublisher(options) : initialTarget, initialPublisher);
  if (options.presenter && !initiallyUnchanged) {
    options.presenter.summarize({
      title: 'Set up the QUBE Reviewer App publisher',
      scope: scope === 'global' ? 'user-global defaults for later repositories' : 'this repository only',
      decisions: [{ label: 'Publishing identity', value: 'QUBE Reviewer GitHub App', reason: 'Review compute stays on the configured local review hosts; only provider publishing uses the App.' }],
      applied: 'not-written',
      nextAction: 'Provide the public App identity and a safe private-key reference, then verify Pull requests read/write access.',
    });
  }

  const interaction = await collectInteractiveValues(options, values);
  if (interaction.cancelled) return failureResult({ options, scope, configPath, guidance, publisher: null, errors: ['Setup was cancelled before any config write.'], nextAction: `Rerun \`${setupCommand(scope)}\` when you are ready.` });

  const requireKeyMaterial = (!values.installationId && options.discoverInstallations === undefined)
    || (options.noProbe !== true && options.resolvePublisher === undefined);
  const appIdError = validateAppId(values.appId);
  const loginError = validateLogin(values.login);
  const privateKeyError = await validatePrivateKeyReference(values, requireKeyMaterial);
  const validationErrors = [appIdError, loginError, privateKeyError].filter((value): value is string => Boolean(value));
  const hasKeyReference = Boolean(values.privateKeyEnv || values.privateKeyPath);
  const invalidProvidedValue = Boolean((values.appId && appIdError) || (values.login && loginError) || (hasKeyReference && privateKeyError));
  if (validationErrors.length > 0 && invalidProvidedValue) {
    return failureResult({ options, scope, configPath, guidance, publisher: buildPublisher(values), errors: validationErrors, nextAction: `Correct the affected answer, then rerun \`${setupCommand(scope)}\`.` });
  }

  const discovery = validationErrors.length === 0 ? await discoverInstallation(options, values)
    : { status: 'not-run', candidates: [], selectedInstallationId: null, reason: 'Required App values are missing.' } as const;
  if (discovery.status === 'cancelled') {
    return failureResult({ options, scope, configPath, guidance, publisher: buildPublisher(values), errors: [discovery.reason ?? 'Setup was cancelled before installation selection.'], discovery, nextAction: `Rerun \`${setupCommand(scope)}\` when you are ready.` });
  }
  if (discovery.status === 'unavailable' || discovery.status === 'multiple') {
    const nextAction = discovery.status === 'multiple'
      ? `Rerun \`${setupCommand(scope)}\` in a terminal and choose the named installation, or pass the advanced --installation-id override.`
      : `Install the GitHub App for the required account or repository at https://github.com/settings/installations, then rerun \`${setupCommand(scope)}\`.`;
    return failureResult({ options, scope, configPath, guidance, publisher: buildPublisher(values), errors: [discovery.reason ?? 'Installation discovery failed.'], discovery, nextAction });
  }

  const publisher = buildPublisher(values);
  const missingFields = publisherMissingFields(publisher);
  const applyIntended = options.yes === true || (options.isTTY === true && Boolean(options.presenter));
  if (missingFields.length > 0) {
    if (applyIntended) return failureResult({ options, scope, configPath, guidance, publisher, errors: [], missingFields, discovery, nextAction: incompleteNextAction(scope, missingFields) });
    return { ...failureResult({ options, scope, configPath, guidance, publisher, errors: [], missingFields, discovery, nextAction: incompleteNextAction(scope, missingFields) }), ok: true };
  }
  if (validateInstallationId(values.installationId)) return failureResult({ options, scope, configPath, guidance, publisher, errors: [validateInstallationId(values.installationId) as string], discovery, nextAction: `Choose a valid installation, then rerun \`${setupCommand(scope)}\`.` });

  const target = targetPublisher(options);
  const existing = scope === 'repo' && !target && !hasExplicitPublisherInput(options) ? seedPublisher(options) : target;
  const changed = !samePublisher(existing, publisher);
  let confirmed = options.yes === true || options.dryRun === true;
  if (changed && !confirmed && options.isTTY === true && options.presenter) {
    options.presenter.summarize({
      title: 'Confirm QUBE Reviewer App setup',
      scope: scope === 'global' ? 'user-global defaults' : 'repository override',
      decisions: [
        { label: 'App ID', value: publisher.githubApp?.appId ?? '' },
        { label: 'Installation', value: publisher.githubApp?.installationId ?? '' },
        { label: 'Private key', value: Object.keys(safeSecretReferences(publisher)).join(', ') || 'not configured' },
      ],
      applied: 'not-written',
    });
    const result = await options.presenter.confirm(question({
      section: { number: 4, title: 'Confirm the config write' },
      label: `Write ${scope === 'global' ? 'user-global' : 'repository'} Reviewer App config?`,
      explanation: `Only the ${scope === 'global' ? 'user-global publisher file' : 'repository Executor config'} can change. Secret material is not stored.`,
      recommendation: { value: true, reason: 'The displayed values are public identifiers and safe references only.' },
      validation: { state: 'unchecked' },
    }));
    if (isCancelled(result) || answerValue(result) !== true) return failureResult({ options, scope, configPath, guidance, publisher, errors: ['Setup was cancelled before the config write.'], discovery, nextAction: `Rerun \`${setupCommand(scope)}\` when you are ready.` });
    confirmed = true;
  }

  const shouldWrite = changed && confirmed && options.dryRun !== true;
  if (shouldWrite) {
    const content = scope === 'global' ? formatUserReviewPublisherFile(publisher) : repositoryConfigContent(options.repositoryConfig, publisher);
    await (options.writeConfig ?? defaultWriteConfig)(configPath, content);
  }
  const sources = sourceState(options, values);
  const verify = () => runReviewDoctor({
      config: configWithPublisher(options.config, publisher), cwd: options.root,
      mintProbe: options.dryRun !== true && options.noProbe !== true, repositoryRequired: scope === 'repo',
      publisherSource: sources.publisherSource, publisherFieldSources: sources.publisherFieldSources,
      resolvePublisher: options.resolvePublisher,
    });
  const doctor = options.presenter
    ? await options.presenter.progress({ action: 'Checking review publisher readiness', success: 'Review publisher check complete' }, verify)
    : await verify();
  const applied = shouldWrite;
  const unavailable = doctor.readiness === 'unavailable';
  const nextAction = unavailable ? `Publisher verification is unavailable. Correct the reported problem, then rerun \`${setupCommand(scope)}\`.`
    : options.dryRun === true ? `Remove --dry-run and add --yes to write the planned ${scope === 'global' ? 'user-global' : 'repository'} publisher config.`
      : changed && !applied ? `Add --yes to write the planned ${scope === 'global' ? 'user-global' : 'repository'} publisher config.` : doctor.nextAction;
  return {
    ok: !unavailable, command: 'review setup github-app', mode: 'github-app', scope,
    applied, changed, dryRun: options.dryRun === true, configPath, publisher, ...sources,
    secretReferences: safeSecretReferences(publisher), missingFields: [], validationErrors: [], guidance, discovery,
    doctor, readiness: doctor.readiness, nextAction, roleBoundary: REVIEW_PUBLISHER_ROLE_BOUNDARY,
  };
}

export function formatReviewSetup(result: ReviewSetupResult): string {
  if (!result.ok) {
    const reason = result.validationErrors[0] ?? result.doctor?.fallbackReason ?? result.discovery.reason ?? (result.missingFields.length > 0 ? `Missing: ${result.missingFields.join(', ')}.` : 'Reviewer App setup failed.');
    return renderGuidedFailure({ action: 'Configure the QUBE Reviewer App', reason, nextAction: result.nextAction });
  }
  if (result.missingFields.length > 0) {
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
    lines.push('', `Config: ${result.configPath}`, 'Applied: no', `Missing flags: ${result.missingFields.join(', ')}`, `Setup next action: ${result.nextAction}`, result.roleBoundary);
    return lines.join('\n');
  }
  if (!result.changed) {
    return renderGuidedSummary({
      title: 'QUBE Reviewer App is already configured',
      scope: result.scope === 'global' ? 'user-global defaults' : 'repository override',
      applied: 'unchanged',
      readiness: result.readiness === 'not-checked' || result.readiness === 'unconfigured' ? undefined : result.readiness,
      nextAction: result.nextAction,
    });
  }
  const output = renderGuidedSummary({
    title: result.changed ? 'QUBE Reviewer App setup' : 'QUBE Reviewer App is already configured',
    scope: result.scope === 'global' ? 'user-global defaults' : 'repository override',
    decisions: result.publisher?.githubApp ? [
      { label: 'App ID', value: result.publisher.githubApp.appId, source: result.publisherFieldSources['githubApp.appId'] },
      { label: 'Installation', value: result.publisher.githubApp.installationId, source: result.publisherFieldSources['githubApp.installationId'] },
      { label: 'Private key', value: Object.keys(result.secretReferences).join(', ') || 'not configured', source: result.publisherSource },
    ] : [],
    applied: result.applied ? 'changed' : result.changed ? 'not-written' : 'unchanged',
    readiness: result.readiness === 'not-checked' || result.readiness === 'unconfigured' ? undefined : result.readiness,
    nextAction: result.nextAction,
  });
  return result.doctor ? `${output}\n${formatReviewDoctor(result.doctor)}` : `${output}${result.roleBoundary}`;
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
