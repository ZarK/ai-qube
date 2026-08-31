import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const TOKEN_PATTERNS: RegExp[] = [
  /\b(ghp_[A-Za-z0-9_]{10,})\b/g,
  /\b(github_pat_[A-Za-z0-9_]{10,})\b/g,
  /\b(ghs_[A-Za-z0-9_]{10,})\b/g,
  /\b(gho_[A-Za-z0-9_]{10,})\b/g,
  /\b(ghu_[A-Za-z0-9_]{10,})\b/g,
];

export function redact(text: string): string {
  let out = text;
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, '[REDACTED]');
  }
  // Catch long mixed-alphanumeric strings that look like tokens
  out = out.replace(/\b([A-Za-z0-9_-]{40,})\b/g, (match) => {
    if (/[A-Z]/.test(match) && /[a-z]/.test(match) && /[0-9]/.test(match)) {
      return '[REDACTED]';
    }
    return match;
  });
  return out;
}

export interface GhRunResult {
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class GhExecutionError extends Error {
  readonly kind = 'execution' as const;
  readonly exitCode: number;
  readonly stderr: string;
  constructor(operation: string, exitCode: number, stderr: string) {
    super(`Failed to execute ${operation}: exit code ${exitCode}. ${stderr || 'Unknown error'}. Verify gh version and repository state.`);
    this.name = 'GhExecutionError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

interface GhExecErrorShape {
  code?: string | number;
  status?: number;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  message?: string;
}

function isGhExecError(e: unknown): e is GhExecErrorShape {
  return !!e && typeof e === 'object';
}

export class GhNotFoundError extends Error {
  readonly kind = 'not-found' as const;
  constructor(operation: string) {
    super(
      `Failed to execute ${operation}: gh CLI not found on PATH. Install GitHub CLI and ensure it is on your PATH.`
    );
    this.name = 'GhNotFoundError';
  }
}

export class GhAuthError extends Error {
  readonly kind = 'auth' as const;
  constructor(operation: string, details: string) {
    super(
      `Failed to execute ${operation}: not authenticated with GitHub. ${details} Run "gh auth login" and try again.`
    );
    this.name = 'GhAuthError';
  }
}

export class NotGitHubRepositoryError extends Error {
  readonly kind = 'not-repo' as const;
  constructor(operation: string, details: string) {
    super(
      `Failed to execute ${operation}: not a GitHub repository or no github.com remote. ${details} Run from a git repository with a GitHub remote, or use --repo owner/repo.`
    );
    this.name = 'NotGitHubRepositoryError';
  }
}

export class GhNetworkError extends Error {
  readonly kind = 'network' as const;
  constructor(operation: string, details: string) {
    super(
      `Failed to execute ${operation}: network or GitHub API error. ${details} Check your connection, proxy settings, or GitHub status page.`
    );
    this.name = 'GhNetworkError';
  }
}

export class GhMalformedOutputError extends Error {
  readonly kind = 'malformed' as const;
  constructor(operation: string, details: string) {
    super(
      `Failed to execute ${operation}: malformed or unexpected output. ${details} Update gh CLI or report the redacted error.`
    );
    this.name = 'GhMalformedOutputError';
  }
}

export interface RunGhOptions {
  cwd?: string;
  exec?: GhExec;
  /** Environment used by the child process. Values are never returned or logged. */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * Optional short-lived token for this invocation only.
   * Sets GH_TOKEN in the process environment for the child call when the default
   * exec is used. Never include this value in returned args or logs.
   * Pass null to force the default gh authentication (clears GH_TOKEN for the child).
   */
  token?: string | null;
  /** Hard deadline for the gh child process; kills the process when exceeded. */
  timeoutMs?: number;
  /** AbortSignal that terminates the gh child when aborted. */
  signal?: AbortSignal;
}

export type GhExecOptions = {
  token?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: Readonly<Record<string, string | undefined>>;
};

export type GhExec = (args: string[], cwd?: string, options?: GhExecOptions) => Promise<GhRunResult>;

async function defaultGhExec(args: string[], cwd = process.cwd(), options: GhExecOptions = {}): Promise<GhRunResult> {
  const redactedArgs = args.map((a) => redact(a));
  const operation = `gh ${redactedArgs.join(' ')}`;

  try {
    const env: NodeJS.ProcessEnv = {
      ...(options.env ?? process.env),
      GH_PAGER: '',
      CLICOLOR: '0',
      NO_COLOR: '1',
    };
    if (options.token === null) {
      delete env.GH_TOKEN;
      delete env.GITHUB_TOKEN;
      delete env.GH_ENTERPRISE_TOKEN;
      delete env.GITHUB_ENTERPRISE_TOKEN;
    } else if (typeof options.token === 'string' && options.token.trim() !== '') {
      const hostIndex = args.indexOf('--hostname');
      const host = hostIndex >= 0 ? args[hostIndex + 1]?.toLowerCase() : undefined;
      if (host && host !== 'github.com' && !host.endsWith('.ghe.com')) {
        env.GH_ENTERPRISE_TOKEN = options.token;
        delete env.GITHUB_ENTERPRISE_TOKEN;
        delete env.GH_TOKEN;
        delete env.GITHUB_TOKEN;
      } else {
        env.GH_TOKEN = options.token;
        delete env.GITHUB_TOKEN;
        delete env.GH_ENTERPRISE_TOKEN;
        delete env.GITHUB_ENTERPRISE_TOKEN;
      }
    }
    const execOptions: {
      cwd: string;
      encoding: 'utf8';
      maxBuffer: number;
      env: NodeJS.ProcessEnv;
      timeout?: number;
      killSignal?: NodeJS.Signals;
      signal?: AbortSignal;
    } = {
      cwd,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      env,
    };
    if (typeof options.timeoutMs === 'number' && options.timeoutMs > 0) {
      execOptions.timeout = options.timeoutMs;
      execOptions.killSignal = 'SIGTERM';
    }
    if (options.signal) {
      execOptions.signal = options.signal;
    }
    const { stdout, stderr } = await execFileAsync('gh', args, execOptions);
    return {
      args: redactedArgs,
      exitCode: 0,
      stdout: redact(stdout),
      stderr: redact(stderr),
    };
  } catch (err: unknown) {
    const e = isGhExecError(err) ? err : {};
    const stdoutRaw = e.stdout;
    const stderrRaw = e.stderr;
    const stdout = redact(typeof stdoutRaw === 'string' ? stdoutRaw : (Buffer.isBuffer(stdoutRaw) ? stdoutRaw.toString('utf8') : ''));
    const stderr = redact(typeof stderrRaw === 'string' ? stderrRaw : (Buffer.isBuffer(stderrRaw) ? stderrRaw.toString('utf8') : (e.message || '')));
    const code = e.code === 'ENOENT' ? -1 : (e.status ?? (typeof e.code === 'number' ? e.code : 1));

    // Timed-out or aborted children surface as ETXTBSY/AbortError/ETIMEDOUT depending on platform.
    if (
      e.code === 'ABORT_ERR'
      || e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
      || e.code === 'ETIMEDOUT'
      || (typeof e.message === 'string' && /aborted|timed? ?out/i.test(e.message))
    ) {
      throw new GhNetworkError(operation, stderr || stdout || 'gh invocation timed out or was aborted');
    }

    if (e.code === 'ENOENT' || code === -1) {
      throw new GhNotFoundError(operation);
    }

    const combined = `${stderr} ${stdout}`.toLowerCase();

    if (
      combined.includes('authentication') ||
      combined.includes('not logged in') ||
      combined.includes('bad credentials') ||
      code === 4
    ) {
      throw new GhAuthError(operation, stderr || stdout);
    }

    if (
      combined.includes('not a git repository') ||
      combined.includes('no git repository') ||
      combined.includes('unknown repository') ||
      combined.includes('not a github repository')
    ) {
      throw new NotGitHubRepositoryError(operation, stderr || stdout);
    }

    if (
      combined.includes('network') ||
      combined.includes('timeout') ||
      combined.includes('econn') ||
      combined.includes('getaddrinfo') ||
      combined.includes('socket hang') ||
      combined.includes('connection reset')
    ) {
      throw new GhNetworkError(operation, stderr || stdout);
    }

    throw new GhExecutionError(operation, code, stderr || stdout);
  }
}

export async function runGh(
  args: string[],
  options: RunGhOptions = {}
): Promise<GhRunResult> {
  const { cwd, exec, token, timeoutMs, signal, env } = options;
  const runner = exec ?? defaultGhExec;
  const execOptions: GhExecOptions | undefined =
    token === undefined && timeoutMs === undefined && signal === undefined && env === undefined
      ? undefined
      : { token, timeoutMs, signal, env };
  const result = await runner(args, cwd, execOptions);
  return {
    args: result.args,
    exitCode: result.exitCode,
    stdout: redact(result.stdout),
    stderr: redact(result.stderr),
  };
}

export function parseGhJson<T>(stdout: string, operation: string, shapeCheck?: (v: unknown) => v is T): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new GhMalformedOutputError(operation, `JSON parse failed: ${detail}`);
  }
  if (shapeCheck && !shapeCheck(parsed)) {
    throw new GhMalformedOutputError(operation, 'gh JSON did not match expected shape');
  }
  return parsed as T;
}
