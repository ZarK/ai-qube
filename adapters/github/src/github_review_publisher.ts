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
}

export interface ResolvedGitHubReviewPublisher {
  readonly identity: GitHubReviewPublisherIdentity;
  /** Short-lived token for API calls; never serialize this object into JSON output. */
  readonly accessToken: string | null;
}

export interface ResolvePublisherOptions {
  readonly cwd?: string;
  readonly exec?: GhExec;
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

function readPrivateKeyPem(config: GitHubAppPublisherConfig): { pem: string | null; error: string | null } {
  if (config.privateKeyEnv) {
    const value = process.env[config.privateKeyEnv];
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
      text = await new Promise<string>((resolve, reject) => {
        const onBodyAbort = () => {
          try { response.body?.cancel(); } catch { /* ignore */ }
          reject(new Error('GitHub App installation token response body timed out or was aborted.'));
        };
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
              reject(new Error('GitHub App installation token response body timed out or was aborted.'));
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

async function fetchInstallationIdentity(
  token: string,
  cwd?: string,
  exec?: GhExec,
  limits: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ login: string | null; type: string | null }> {
  // Installation tokens cannot call /user; resolve the bot identity from /installation.
  try {
    const installation = await runGh(['api', 'installation', '-H', 'Accept: application/vnd.github+json'], {
      cwd,
      exec,
      token,
      signal: limits.signal,
      timeoutMs: limits.timeoutMs,
    });
    if (installation.exitCode !== 0) return { login: null, type: null };
    const parsed = JSON.parse(installation.stdout) as unknown;
    if (!isRecord(parsed)) return { login: null, type: null };
    // Installation tokens act as the GitHub App bot, not the installation target
    // account (user/org). Prefer app_slug for the bot actor login.
    const slug = typeof parsed.app_slug === 'string' ? parsed.app_slug.trim() : '';
    if (slug !== '') return { login: `${slug}[bot]`, type: 'Bot' };
    const account = isRecord(parsed.account) ? parsed.account : null;
    const accountLogin = account && typeof account.login === 'string' ? account.login : null;
    return { login: accountLogin, type: 'Bot' };
  } catch {
    return { login: null, type: null };
  }
}

async function defaultFetchTokenIdentity(
  token: string,
  cwd?: string,
  exec?: GhExec,
  limits: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ login: string | null; type: string | null }> {
  // Production runGh throws on HTTP failures instead of returning exitCode != 0.
  // Catch expected /user failures so installation-token minting can fall back cleanly.
  try {
    const result = await runGh(['api', 'user', '-H', 'Accept: application/vnd.github+json'], {
      cwd,
      exec,
      token,
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
  limits: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string | null> {
  const result = await runGh(['api', 'user', '-H', 'Accept: application/vnd.github+json'], {
    cwd,
    exec,
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
  };
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
      ? await currentGhLogin(options.cwd, options.exec, { signal: options.signal, timeoutMs: options.timeoutMs })
      : null;
    return {
      accessToken: null,
      identity: finalizeIdentity({
        mode: 'user',
        identityClass: 'user',
        login,
        permissionStatus: mint ? (login ? 'ok' : 'unknown') : 'unknown',
        formalEventCapability: true,
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

    const key = readPrivateKeyPem(app);
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
      const probeLimits = { signal: options.signal, timeoutMs: options.timeoutMs };
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

      // Installation tokens cannot call /user; resolve bot identity directly.
      const identityLookup = options.fetchTokenIdentity
        ? await options.fetchTokenIdentity(minted.token)
        : await fetchInstallationIdentity(minted.token, options.cwd, options.exec, probeLimits);
      const login = normalizeLogin(identityLookup.login ?? minted.accountLogin ?? null);
      const hasPermission = installationHasReviewPermission(minted.permissions);

      return {
        accessToken: minted.token,
        identity: finalizeIdentity({
          mode: 'github-app',
          identityClass: 'github-app-installation',
          login,
          permissionStatus: hasPermission ? 'ok' : 'missing',
          formalEventCapability: hasPermission,
          fallbackReason: hasPermission
            ? null
            : 'GitHub App installation lacks pull_requests write permission; formal review events are unavailable.',
          publishTransport: hasPermission ? 'pull-request-review' : 'issue-comment',
          authSource: 'github-app-installation',
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

  const tokenValue = process.env[tokenEnv];
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
  };
}

export function emptyPublisherIdentity(): GitHubReviewPublisherIdentity {
  return unconfiguredIdentity();
}

export type { GhRunResult };
