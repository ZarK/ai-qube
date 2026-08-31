import { createSign, createPrivateKey } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { redact, runGh, type GhExec, type GhRunResult } from './gh.js';

export type GitHubReviewPublisherMode = 'user' | 'github-app' | 'token';
export type GitHubReviewPublisherIdentityClass = 'user' | 'github-app-installation' | 'fine-grained-token' | 'none';
export type GitHubReviewPublisherPermissionStatus =
  | 'ok'
  | 'missing'
  | 'unknown'
  | 'same-author'
  | 'unconfigured'
  | 'misconfigured';
export type GitHubReviewPublisherTransport = 'pull-request-review' | 'issue-comment';

export interface GitHubAppPublisherConfig {
  readonly appId: string;
  readonly installationId: string;
  readonly privateKeyPath?: string;
  readonly privateKeyEnv?: string;
  /** Optional public bot login used only for trust matching on load paths (never a secret). */
  readonly login?: string;
}

export interface GitHubAppInstallationDiscoveryConfig {
  readonly appId: string;
  readonly privateKeyPath?: string;
  readonly privateKeyEnv?: string;
}

/** Public installation details that are safe to show in setup output. */
export interface GitHubAppInstallationCandidate {
  readonly installationId: number;
  readonly accountLogin: string;
  readonly accountType: string;
  readonly targetType: string;
  readonly repositorySelection: string;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly label: string;
}

export interface DiscoverGitHubAppInstallationsOptions {
  readonly nowSeconds?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly request?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export interface GitHubTokenPublisherConfig {
  readonly env: string;
  /** Optional public login used only for trust matching on load paths (never a secret). */
  readonly login?: string;
}

export interface GitHubReviewPublisherConfig {
  readonly mode: GitHubReviewPublisherMode;
  readonly githubApp?: GitHubAppPublisherConfig;
  readonly token?: GitHubTokenPublisherConfig;
}

/** Public, secret-free publisher status for JSON output. */
export interface GitHubReviewPublisherIdentity {
  readonly mode: GitHubReviewPublisherMode;
  readonly identityClass: GitHubReviewPublisherIdentityClass;
  readonly login: string | null;
  readonly permissionStatus: GitHubReviewPublisherPermissionStatus;
  readonly formalEventCapability: boolean;
  readonly fallbackReason: string | null;
  readonly publishTransport: GitHubReviewPublisherTransport;
  readonly authSource: 'gh-user' | 'github-app-installation' | 'token-env' | 'none';
  /** True only when the login was derived by exercising the configured credential. */
  readonly credentialVerified: boolean;
  /** Contents permission observed from a minted github-app installation token. */
  readonly contentsPermission?: 'write' | 'read' | 'missing' | 'unknown' | 'not-run';
}

export interface ResolvedGitHubReviewPublisher {
  readonly identity: GitHubReviewPublisherIdentity;
  /** Short-lived token for API calls; never serialize this object into JSON output. */
  readonly accessToken: string | null;
}

export interface ResolvePublisherOptions {
  readonly cwd?: string;
  readonly exec?: GhExec;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly prAuthorLogin?: string | null;
  readonly nowSeconds?: number;
  /**
   * When false, report configured publisher status without minting installation tokens
   * or calling identity endpoints with publisher credentials. Used by pr view/gate JSON.
   */
  readonly mint?: boolean;
  /** AbortSignal for live mint/identity probes. */
  readonly signal?: AbortSignal;
  /** Hard deadline (ms) for live mint/identity I/O. */
  readonly timeoutMs?: number;
  readonly fetchInstallationToken?: (input: {
    appId: string;
    installationId: string;
    privateKeyPem: string;
    jwt: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  }) => Promise<{ token: string; permissions?: Record<string, string>; accountLogin?: string | null }>;
  readonly fetchTokenIdentity?: (token: string) => Promise<{ login: string | null; type: string | null }>;
  readonly fetchAppIdentity?: (input: {
    jwt: string;
    appId: string;
    installationId: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  }) => Promise<{ login: string | null; type: string | null }>;
}

const DEFAULT_PUBLISHER_CONFIG: GitHubReviewPublisherConfig = Object.freeze({ mode: 'user' });

export function defaultGitHubReviewPublisherConfig(): GitHubReviewPublisherConfig {
  return { ...DEFAULT_PUBLISHER_CONFIG };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeLogin(login: string | null | undefined): string | null {
  if (typeof login !== 'string') return null;
  const trimmed = login.trim().replace(/^@/, '');
  return trimmed === '' ? null : trimmed;
}

function loginsEqual(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = normalizeLogin(left);
  const b = normalizeLogin(right);
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

function base64Url(input: Buffer | string): string {
  const buffer = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buffer.toString('base64url');
}

export function createGitHubAppJwt(appId: string, privateKeyPem: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iat: nowSeconds - 60,
    exp: nowSeconds + 9 * 60,
    iss: appId,
  };
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const key = createPrivateKey(privateKeyPem);
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(key);
  return `${signingInput}.${base64Url(signature)}`;
}

function readPrivateKeyPem(config: GitHubAppPublisherConfig, env: Readonly<Record<string, string | undefined>> = process.env): { pem: string | null; error: string | null } {
  if (config.privateKeyEnv) {
    const value = env[config.privateKeyEnv];
    if (typeof value === 'string' && value.trim() !== '') {
      return { pem: value.includes('\\n') ? value.replace(/\\n/g, '\n') : value, error: null };
    }
    return { pem: null, error: `GitHub App private key env ${config.privateKeyEnv} is missing or empty.` };
  }
  if (config.privateKeyPath) {
    if (!existsSync(config.privateKeyPath)) {
      return { pem: null, error: `GitHub App private key path does not exist.` };
    }
    try {
      return { pem: readFileSync(config.privateKeyPath, 'utf8'), error: null };
    } catch (error: unknown) {
      return { pem: null, error: `GitHub App private key path could not be read: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { pem: null, error: 'GitHub App publisher requires privateKeyPath or privateKeyEnv.' };
}

const DEFAULT_INSTALLATION_DISCOVERY_TIMEOUT_MS = 10_000;
const SAFE_INSTALLATION_PERMISSION = new Set(['read', 'write', 'admin']);

function installationDiscoveryKey(
  config: GitHubAppInstallationDiscoveryConfig,
): { pem: string | null; error: string | null } {
  const privateKeyEnv = typeof config.privateKeyEnv === 'string' && config.privateKeyEnv.trim() !== ''
    ? config.privateKeyEnv.trim()
    : undefined;
  const privateKeyPath = typeof config.privateKeyPath === 'string' && config.privateKeyPath.trim() !== ''
    ? config.privateKeyPath
    : undefined;
  if ((privateKeyEnv ? 1 : 0) + (privateKeyPath ? 1 : 0) !== 1) {
    return {
      pem: null,
      error: 'GitHub App installation discovery requires exactly one private-key environment variable or local path reference.',
    };
  }
  return readPrivateKeyPem({
    appId: config.appId,
    installationId: '',
    ...(privateKeyEnv ? { privateKeyEnv } : { privateKeyPath }),
  });
}

function publicInstallationCandidate(value: unknown): GitHubAppInstallationCandidate | null {
  if (!isRecord(value) || !Number.isSafeInteger(value.id) || Number(value.id) <= 0) return null;
  if (!isRecord(value.account)) return null;
  const accountLogin = typeof value.account.login === 'string' ? value.account.login.trim() : '';
  const accountType = typeof value.account.type === 'string' ? value.account.type.trim() : '';
  const targetType = typeof value.target_type === 'string' ? value.target_type.trim() : '';
  const repositorySelection = typeof value.repository_selection === 'string'
    ? value.repository_selection.trim().toLowerCase()
    : '';
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(accountLogin)) return null;
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(accountType)) return null;
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(targetType)) return null;
  if (repositorySelection !== 'all' && repositorySelection !== 'selected') return null;

  let permissions: Record<string, string> | undefined;
  if (value.permissions !== undefined) {
    if (!isRecord(value.permissions)) return null;
    permissions = Object.fromEntries(
      Object.entries(value.permissions).filter(
        (entry): entry is [string, string] => (
          /^[a-z][a-z0-9_]{0,63}$/.test(entry[0])
          && typeof entry[1] === 'string'
          && SAFE_INSTALLATION_PERMISSION.has(entry[1])
        ),
      ),
    );
  }

  const scopeLabel = repositorySelection === 'all' ? 'all repositories' : 'selected repositories';
  return {
    installationId: Number(value.id),
    accountLogin,
    accountType,
    targetType,
    repositorySelection,
    ...(permissions ? { permissions } : {}),
    label: `${accountLogin} (${accountType}) - ${scopeLabel} - installation ${String(value.id)}`,
  };
}

/**
 * List installations for a GitHub App without returning credential material.
 * The private key and signed JWT stay in memory for the authenticated request.
 */
export async function discoverGitHubAppInstallations(
  config: GitHubAppInstallationDiscoveryConfig,
  options: DiscoverGitHubAppInstallationsOptions = {},
): Promise<readonly GitHubAppInstallationCandidate[]> {
  const appId = typeof config.appId === 'string' ? config.appId.trim() : '';
  if (!/^\d+$/.test(appId) || BigInt(appId) <= 0n) {
    throw new Error('GitHub App installation discovery requires a positive numeric App ID.');
  }
  if (options.signal?.aborted) {
    throw new Error('GitHub App installation discovery request timed out or was aborted.');
  }

  const key = installationDiscoveryKey(config);
  if (!key.pem) throw new Error(key.error ?? 'GitHub App private key reference is unavailable.');

  let jwt: string;
  try {
    jwt = createGitHubAppJwt(appId, key.pem, options.nowSeconds);
  } catch {
    throw new Error('GitHub App private key reference does not contain a valid RSA private key.');
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true });
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_INSTALLATION_DISCOVERY_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const request = options.request ?? fetch;
  try {
    let response: Response;
    try {
      response = await request('https://api.github.com/app/installations?per_page=100', {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${jwt}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'qube-github-review-publisher',
        },
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) {
        throw new Error('GitHub App installation discovery request timed out or was aborted.');
      }
      throw new Error('GitHub App installation discovery request failed.');
    }
    if (!response.ok) {
      throw new Error(`GitHub App installation discovery request failed with status ${response.status}.`);
    }

    let text: string;
    try {
      text = await new Promise<string>((resolve, reject) => {
        const onBodyAbort = () => reject(new Error('GitHub App installation discovery response timed out or was aborted.'));
        if (controller.signal.aborted) {
          onBodyAbort();
          return;
        }
        controller.signal.addEventListener('abort', onBodyAbort, { once: true });
        response.text()
          .then((body) => {
            controller.signal.removeEventListener('abort', onBodyAbort);
            resolve(body);
          })
          .catch(() => {
            controller.signal.removeEventListener('abort', onBodyAbort);
            reject(new Error('GitHub App installation discovery response could not be read.'));
          });
      });
    } catch {
      if (controller.signal.aborted) {
        throw new Error('GitHub App installation discovery response timed out or was aborted.');
      }
      throw new Error('GitHub App installation discovery response could not be read.');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('GitHub App installation discovery response was not valid JSON.');
    }
    if (!Array.isArray(parsed)) {
      throw new Error('GitHub App installation discovery response was malformed.');
    }
    const candidates = parsed.map(publicInstallationCandidate);
    if (candidates.some((candidate) => candidate === null)) {
      throw new Error('GitHub App installation discovery response was malformed.');
    }
    return candidates as GitHubAppInstallationCandidate[];
  } finally {
    clearTimeout(timer);
    if (options.signal) options.signal.removeEventListener('abort', onAbort);
  }
}

async function defaultFetchInstallationToken(input: {
  appId: string;
  installationId: string;
  privateKeyPem: string;
  jwt: string;
  cwd?: string;
  exec?: GhExec;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ token: string; permissions?: Record<string, string>; accountLogin?: string | null }> {
  // Mint outside runGh so the installation token is not redacted from stdout
  // (runGh redacts ghs_ tokens before returning). Tokens stay in-memory only.
  void input.appId;
  void input.privateKeyPem;
  void input.cwd;
  void input.exec;
  // Combine caller signal with a local deadline so hung mint requests cannot block the process.
  // Keep the controller active through response body consumption so stalled bodies are abortable.
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (input.signal) {
    if (input.signal.aborted) controller.abort();
    else input.signal.addEventListener('abort', onAbort, { once: true });
  }
  if (typeof input.timeoutMs === 'number' && input.timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(), input.timeoutMs);
  }
  try {
    let response: Response;
    try {
      response = await fetch(`https://api.github.com/app/installations/${input.installationId}/access_tokens`, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${input.jwt}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'qube-github-review-publisher',
        },
        signal: controller.signal,
      });
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        throw new Error('GitHub App installation token request timed out or was aborted.');
      }
      throw error;
    }
    let text: string;
    try {
      // Race body consumption against the same abort controller so stalled bodies
      // cannot outlive the probe deadline after headers have already arrived.
      // Do not call response.body.cancel() after response.text() starts: Node's
      // Fetch marks the stream locked and cancel() then rejects asynchronously.
      text = await new Promise<string>((resolve, reject) => {
        const abortError = () => new Error('GitHub App installation token response body timed out or was aborted.');
        const onBodyAbort = () => reject(abortError());
        if (controller.signal.aborted) {
          onBodyAbort();
          return;
        }
        controller.signal.addEventListener('abort', onBodyAbort, { once: true });
        response.text()
          .then((value) => {
            controller.signal.removeEventListener('abort', onBodyAbort);
            resolve(value);
          })
          .catch((error: unknown) => {
            controller.signal.removeEventListener('abort', onBodyAbort);
            if (controller.signal.aborted) {
              reject(abortError());
              return;
            }
            reject(error);
          });
      });
    } catch (error: unknown) {
      if (controller.signal.aborted || (error instanceof Error && /timed out or was aborted/i.test(error.message))) {
        throw new Error('GitHub App installation token response body timed out or was aborted.');
      }
      throw error;
    }
    if (!response.ok) {
      throw new Error(redact(text || `GitHub App installation token request failed with status ${response.status}`));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('GitHub App installation token response was not valid JSON.');
    }
    if (!isRecord(parsed) || typeof parsed.token !== 'string' || parsed.token.trim() === '') {
      throw new Error('GitHub App installation token response did not include a token.');
    }
    const permissions = isRecord(parsed.permissions)
      ? Object.fromEntries(Object.entries(parsed.permissions).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      : undefined;
    const accountLogin = isRecord(parsed.account) && typeof parsed.account.login === 'string'
      ? parsed.account.login
      : null;
    return { token: parsed.token, permissions, accountLogin };
  } finally {
    if (timer) clearTimeout(timer);
    if (input.signal) input.signal.removeEventListener('abort', onAbort);
  }
}

function botLoginFromSlug(slug: string | null | undefined): { login: string; type: 'Bot' } | null {
  const trimmed = typeof slug === 'string' ? slug.trim() : '';
  if (trimmed === '') return null;
  return { login: `${trimmed}[bot]`, type: 'Bot' };
}

async function defaultFetchAppIdentity(
  jwt: string,
  limits: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ login: string | null; type: string | null }> {
  // Installation tokens cannot call /user or GET /installation (404). The signed
  // app JWT can read GET /app, whose slug is the live bot actor.
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (limits.signal) {
    if (limits.signal.aborted) controller.abort();
    else limits.signal.addEventListener('abort', onAbort, { once: true });
  }
  if (typeof limits.timeoutMs === 'number' && limits.timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  }
  try {
    const response = await fetch('https://api.github.com/app', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'qube-github-review-publisher',
      },
      signal: controller.signal,
    });
    if (!response.ok) return { login: null, type: null };
    const parsed: unknown = JSON.parse(await response.text());
    if (!isRecord(parsed)) return { login: null, type: null };
    return botLoginFromSlug(typeof parsed.slug === 'string' ? parsed.slug : null) ?? { login: null, type: null };
  } catch {
    return { login: null, type: null };
  } finally {
    if (timer) clearTimeout(timer);
    if (limits.signal) limits.signal.removeEventListener('abort', onAbort);
  }
}

async function resolveAppBotIdentity(
  jwt: string,
  token: string,
  app: GitHubAppPublisherConfig,
  options: ResolvePublisherOptions,
  limits: { signal?: AbortSignal; timeoutMs?: number; env?: Readonly<Record<string, string | undefined>> },
): Promise<{ login: string | null; type: string | null }> {
  const fromApp = options.fetchAppIdentity
    ? await options.fetchAppIdentity({
      jwt,
      appId: app.appId,
      installationId: app.installationId,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    })
    : await defaultFetchAppIdentity(jwt, limits);
  if (fromApp.login) return fromApp;
  return fetchInstallationIdentity(token, options.cwd, options.exec, limits);
}

async function fetchInstallationIdentity(
  token: string,
  cwd?: string,
  exec?: GhExec,
  limits: { signal?: AbortSignal; timeoutMs?: number; env?: Readonly<Record<string, string | undefined>> } = {},
): Promise<{ login: string | null; type: string | null }> {
  // Fallback only: GET /installation is 404 for current installation tokens.
  try {
    const installation = await runGh(['api', 'installation', '-H', 'Accept: application/vnd.github+json'], {
      cwd,
      exec,
      token,
      env: limits.env,
      signal: limits.signal,
      timeoutMs: limits.timeoutMs,
    });
    if (installation.exitCode !== 0) return { login: null, type: null };
    const parsed = JSON.parse(installation.stdout) as unknown;
    if (!isRecord(parsed)) return { login: null, type: null };
    const fromSlug = botLoginFromSlug(typeof parsed.app_slug === 'string' ? parsed.app_slug : null);
    if (fromSlug) return fromSlug;
    // Never use the installation target account login. That login cannot
    // match the bot's own review events, so using it as trustedMarkerAuthor
    // fails open and duplicates every republish.
    return { login: null, type: null };
  } catch {
    return { login: null, type: null };
  }
}

async function defaultFetchTokenIdentity(
  token: string,
  cwd?: string,
  exec?: GhExec,
  limits: { signal?: AbortSignal; timeoutMs?: number; env?: Readonly<Record<string, string | undefined>> } = {},
): Promise<{ login: string | null; type: string | null }> {
  // Production runGh throws on HTTP failures instead of returning exitCode != 0.
  // Catch expected /user failures so installation-token minting can fall back cleanly.
  try {
    const result = await runGh(['api', 'user', '-H', 'Accept: application/vnd.github+json'], {
      cwd,
      exec,
      token,
      env: limits.env,
      signal: limits.signal,
      timeoutMs: limits.timeoutMs,
    });
    if (result.exitCode !== 0) return fetchInstallationIdentity(token, cwd, exec, limits);
    try {
      const parsed = JSON.parse(result.stdout) as unknown;
      if (isRecord(parsed) && (typeof parsed.login === 'string' || typeof parsed.type === 'string')) {
        return {
          login: typeof parsed.login === 'string' ? parsed.login : null,
          type: typeof parsed.type === 'string' ? parsed.type : null,
        };
      }
    } catch {
      // ignore parse failures
    }
    return fetchInstallationIdentity(token, cwd, exec, limits);
  } catch {
    return fetchInstallationIdentity(token, cwd, exec, limits);
  }
}

async function currentGhLogin(
  cwd?: string,
  exec?: GhExec,
  limits: { signal?: AbortSignal; timeoutMs?: number; env?: Readonly<Record<string, string | undefined>> } = {},
): Promise<string | null> {
  const result = await runGh(['api', 'user', '-H', 'Accept: application/vnd.github+json'], {
    cwd,
    exec,
    env: limits.env,
    signal: limits.signal,
    timeoutMs: limits.timeoutMs,
  });
  if (result.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (isRecord(parsed) && typeof parsed.login === 'string') return parsed.login;
  } catch {
    // ignore
  }
  return null;
}

function unconfiguredIdentity(fallbackReason: string | null = null): GitHubReviewPublisherIdentity {
  return {
    mode: 'user',
    identityClass: 'user',
    login: null,
    permissionStatus: 'unconfigured',
    formalEventCapability: false,
    fallbackReason: fallbackReason ?? 'No distinct reviewer identity is configured; publishing uses the authenticated gh user.',
    publishTransport: 'pull-request-review',
    authSource: 'gh-user',
    credentialVerified: false,
  };
}

function finalizeIdentity(input: {
  mode: GitHubReviewPublisherMode;
  identityClass: GitHubReviewPublisherIdentityClass;
  login: string | null;
  permissionStatus: GitHubReviewPublisherPermissionStatus;
  formalEventCapability: boolean;
  fallbackReason: string | null;
  publishTransport: GitHubReviewPublisherTransport;
  authSource: GitHubReviewPublisherIdentity['authSource'];
  credentialVerified?: boolean;
  contentsPermission?: GitHubReviewPublisherIdentity['contentsPermission'];
  prAuthorLogin?: string | null;
}): GitHubReviewPublisherIdentity {
  let permissionStatus = input.permissionStatus;
  let formalEventCapability = input.formalEventCapability;
  let fallbackReason = input.fallbackReason;
  let publishTransport = input.publishTransport;

  if (input.login && input.prAuthorLogin && loginsEqual(input.login, input.prAuthorLogin)) {
    permissionStatus = 'same-author';
    formalEventCapability = false;
    publishTransport = 'issue-comment';
    fallbackReason = 'Configured reviewer identity is the pull request author; formal PR review events are unavailable, so publishing degrades to comment-state publication.';
  } else if (permissionStatus === 'missing') {
    formalEventCapability = false;
    publishTransport = 'issue-comment';
    fallbackReason = fallbackReason ?? 'Configured reviewer identity lacks pull request review permissions; publishing degrades to comment-state publication.';
  }

  return {
    mode: input.mode,
    identityClass: input.identityClass,
    login: input.login ? redact(input.login) : null,
    permissionStatus,
    formalEventCapability,
    fallbackReason,
    publishTransport,
    authSource: input.authSource,
    credentialVerified: input.credentialVerified === true,
    contentsPermission: input.contentsPermission ?? 'not-run',
  };
}

function installationContentsPermission(permissions: Record<string, string> | undefined): 'write' | 'read' | 'missing' {
  if (!permissions) return 'missing';
  const contents = permissions.contents;
  if (contents === 'write' || contents === 'admin') return 'write';
  if (contents === 'read') return 'read';
  return 'missing';
}

function installationHasReviewPermission(permissions: Record<string, string> | undefined): boolean {
  // Installation-token responses only list granted permissions. Missing
  // permissions are not granted, so treat an absent pull_requests key as missing.
  if (!permissions) return false;
  const pullRequests = permissions.pull_requests ?? permissions.pullRequests;
  if (!pullRequests) return false;
  return pullRequests === 'write' || pullRequests === 'admin';
}

export async function resolveGitHubReviewPublisher(
  config: GitHubReviewPublisherConfig | null | undefined,
  options: ResolvePublisherOptions = {},
): Promise<ResolvedGitHubReviewPublisher> {
  const resolvedConfig = config ?? defaultGitHubReviewPublisherConfig();
  const mode = resolvedConfig.mode ?? 'user';
  const mint = options.mint !== false;

  if (mode === 'user') {
    const login = mint
      ? await currentGhLogin(options.cwd, options.exec, { signal: options.signal, timeoutMs: options.timeoutMs, env: options.env })
      : null;
    return {
      accessToken: null,
      identity: finalizeIdentity({
        mode: 'user',
        identityClass: 'user',
        login,
        permissionStatus: mint ? (login ? 'ok' : 'unknown') : 'unknown',
        formalEventCapability: true,
        credentialVerified: Boolean(mint && login),
        fallbackReason: 'No distinct reviewer identity is configured; publishing uses the authenticated gh user.',
        publishTransport: 'pull-request-review',
        authSource: 'gh-user',
        prAuthorLogin: options.prAuthorLogin,
      }),
    };
  }

  if (mode === 'github-app') {
    const app = resolvedConfig.githubApp;
    if (!app?.appId || !app.installationId) {
      return {
        accessToken: null,
        identity: finalizeIdentity({
          mode: 'github-app',
          identityClass: 'none',
          login: null,
          permissionStatus: 'misconfigured',
          formalEventCapability: false,
          fallbackReason: 'GitHub App publisher is selected but appId/installationId are incomplete; falling back to authenticated gh user comment publication.',
          publishTransport: 'issue-comment',
          authSource: 'none',
          prAuthorLogin: options.prAuthorLogin,
        }),
      };
    }

    // Status-only probes never read private-key material.
    if (!mint) {
      const configuredLogin = normalizeLogin(app.login ?? null);
      return {
        accessToken: null,
        identity: finalizeIdentity({
          mode: 'github-app',
          identityClass: 'github-app-installation',
          login: configuredLogin,
          permissionStatus: 'unknown',
          formalEventCapability: true,
          fallbackReason: null,
          publishTransport: 'pull-request-review',
          authSource: 'github-app-installation',
          prAuthorLogin: options.prAuthorLogin,
        }),
      };
    }

    const key = readPrivateKeyPem(app, options.env ?? process.env);
    if (!key.pem) {
      return {
        accessToken: null,
        identity: finalizeIdentity({
          mode: 'github-app',
          identityClass: 'none',
          login: null,
          permissionStatus: 'misconfigured',
          formalEventCapability: false,
          fallbackReason: key.error ?? 'GitHub App private key is unavailable.',
          publishTransport: 'issue-comment',
          authSource: 'none',
          prAuthorLogin: options.prAuthorLogin,
        }),
      };
    }

    try {
      const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
      const jwt = createGitHubAppJwt(app.appId, key.pem, nowSeconds);
      const probeLimits = { signal: options.signal, timeoutMs: options.timeoutMs, env: options.env };
      const minted = options.fetchInstallationToken
        ? await options.fetchInstallationToken({
          appId: app.appId,
          installationId: app.installationId,
          privateKeyPem: key.pem,
          jwt,
          signal: options.signal,
          timeoutMs: options.timeoutMs,
        })
        : await defaultFetchInstallationToken({
          appId: app.appId,
          installationId: app.installationId,
          privateKeyPem: key.pem,
          jwt,
          cwd: options.cwd,
          exec: options.exec,
          signal: options.signal,
          timeoutMs: options.timeoutMs,
        });

      // Prefer the signed /app slug. Installation tokens cannot call /user and
      // GET /installation returns 404, so that path is only a fallback.
      const identityLookup = options.fetchTokenIdentity
        ? await options.fetchTokenIdentity(minted.token)
        : await resolveAppBotIdentity(jwt, minted.token, app, options, probeLimits);
      const configuredLogin = normalizeLogin(app.login ?? null);
      const lookedUpLogin = normalizeLogin(identityLookup.login);
      const login = lookedUpLogin ?? configuredLogin;
      if (!login) {
        return {
          accessToken: minted.token,
          identity: finalizeIdentity({
            mode: 'github-app',
            identityClass: 'github-app-installation',
            login: null,
            permissionStatus: 'unknown',
            formalEventCapability: false,
            credentialVerified: false,
            fallbackReason: 'GitHub App publisher identity lookup did not resolve the bot login; formal review events are withheld.',
            publishTransport: 'issue-comment',
            authSource: 'github-app-installation',
            contentsPermission: installationContentsPermission(minted.permissions),
            prAuthorLogin: options.prAuthorLogin,
          }),
        };
      }
      const hasPermission = installationHasReviewPermission(minted.permissions);

      return {
        accessToken: minted.token,
        identity: finalizeIdentity({
          mode: 'github-app',
          identityClass: 'github-app-installation',
          login,
          permissionStatus: hasPermission ? 'ok' : 'missing',
          formalEventCapability: hasPermission,
          credentialVerified: lookedUpLogin !== null,
          fallbackReason: hasPermission
            ? null
            : 'GitHub App installation lacks pull_requests write permission; formal review events are unavailable.',
          publishTransport: hasPermission ? 'pull-request-review' : 'issue-comment',
          authSource: 'github-app-installation',
          contentsPermission: installationContentsPermission(minted.permissions),
          prAuthorLogin: options.prAuthorLogin,
        }),
      };
    } catch (error: unknown) {
      return {
        accessToken: null,
        identity: finalizeIdentity({
          mode: 'github-app',
          identityClass: 'none',
          login: null,
          permissionStatus: 'missing',
          formalEventCapability: false,
          fallbackReason: redact(error instanceof Error ? error.message : String(error)),
          publishTransport: 'issue-comment',
          authSource: 'none',
          prAuthorLogin: options.prAuthorLogin,
        }),
      };
    }
  }

  // mode === 'token'
  const tokenEnv = resolvedConfig.token?.env;
  if (!tokenEnv) {
    return {
      accessToken: null,
      identity: finalizeIdentity({
        mode: 'token',
        identityClass: 'none',
        login: null,
        permissionStatus: 'misconfigured',
        formalEventCapability: false,
        fallbackReason: 'Fine-grained token publisher is selected but token.env is missing.',
        publishTransport: 'issue-comment',
        authSource: 'none',
        prAuthorLogin: options.prAuthorLogin,
      }),
    };
  }

  // Status-only probes never read token secret material from the environment.
  if (!mint) {
    const configuredLogin = normalizeLogin(resolvedConfig.token?.login ?? null);
    return {
      accessToken: null,
      identity: finalizeIdentity({
        mode: 'token',
        identityClass: 'fine-grained-token',
        login: configuredLogin,
        permissionStatus: 'unknown',
        formalEventCapability: true,
        fallbackReason: null,
        publishTransport: 'pull-request-review',
        authSource: 'token-env',
        prAuthorLogin: options.prAuthorLogin,
      }),
    };
  }

  const tokenValue = (options.env ?? process.env)[tokenEnv];
  if (typeof tokenValue !== 'string' || tokenValue.trim() === '') {
    return {
      accessToken: null,
      identity: finalizeIdentity({
        mode: 'token',
        identityClass: 'none',
        login: null,
        permissionStatus: 'missing',
        formalEventCapability: false,
        fallbackReason: `Fine-grained token env ${tokenEnv} is missing or empty.`,
        publishTransport: 'issue-comment',
        authSource: 'none',
        prAuthorLogin: options.prAuthorLogin,
      }),
    };
  }

  try {
    const identityLookup = options.fetchTokenIdentity
      ? await options.fetchTokenIdentity(tokenValue)
      : await defaultFetchTokenIdentity(tokenValue, options.cwd, options.exec, {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        env: options.env,
      });
    const login = normalizeLogin(identityLookup.login);
    return {
      accessToken: tokenValue,
      identity: finalizeIdentity({
        mode: 'token',
        identityClass: 'fine-grained-token',
        login,
        permissionStatus: login ? 'ok' : 'unknown',
        formalEventCapability: true,
        credentialVerified: Boolean(login),
        fallbackReason: null,
        publishTransport: 'pull-request-review',
        authSource: 'token-env',
        prAuthorLogin: options.prAuthorLogin,
      }),
    };
  } catch (error: unknown) {
    return {
      accessToken: null,
      identity: finalizeIdentity({
        mode: 'token',
        identityClass: 'none',
        login: null,
        permissionStatus: 'missing',
        formalEventCapability: false,
        fallbackReason: redact(error instanceof Error ? error.message : String(error)),
        publishTransport: 'issue-comment',
        authSource: 'none',
        prAuthorLogin: options.prAuthorLogin,
      }),
    };
  }
}

export function publicPublisherIdentity(identity: GitHubReviewPublisherIdentity): GitHubReviewPublisherIdentity {
  return {
    mode: identity.mode,
    identityClass: identity.identityClass,
    login: identity.login,
    permissionStatus: identity.permissionStatus,
    formalEventCapability: identity.formalEventCapability,
    fallbackReason: identity.fallbackReason,
    publishTransport: identity.publishTransport,
    authSource: identity.authSource,
    credentialVerified: identity.credentialVerified,
  };
}

export function emptyPublisherIdentity(): GitHubReviewPublisherIdentity {
  return unconfiguredIdentity();
}

export type { GhRunResult };
