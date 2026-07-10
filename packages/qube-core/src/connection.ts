export type ConnectionAuthMethod = "cli-delegated" | "token-env" | "basic-env" | "oauth";
export type ConnectionProbeStatus = "pass" | "fail" | "unverified";
export type ConnectionProbeMode = "live" | "offline" | "fixture";

export interface ConnectionEnvVar {
  readonly name: string;
  readonly sensitive: boolean;
  readonly purpose: string;
}

export interface ConnectionConfigField {
  readonly name: string;
  readonly required: boolean;
  readonly purpose: string;
  readonly envFallback?: string;
  readonly defaultValue?: string;
}

export interface ConnectionValueSource {
  readonly configField?: string;
  readonly envVar?: string;
  readonly defaultValue?: string;
}

export interface ConnectionHeader {
  readonly name: string;
  readonly value: ConnectionValueSource;
  readonly prefix?: string;
}

export interface ConnectionBasicAuth {
  readonly username: ConnectionValueSource;
  readonly password: ConnectionValueSource;
}

export interface ConnectionCommandProbe {
  readonly kind: "command";
  readonly command: string;
  readonly args: readonly string[];
}

export interface ConnectionHttpProbe {
  readonly kind: "http";
  readonly method: "GET" | "POST";
  readonly baseUrl: ConnectionValueSource;
  readonly path: string;
  readonly headers?: readonly ConnectionHeader[];
  readonly basicAuth?: ConnectionBasicAuth;
  readonly body?: string;
  readonly successJsonPath?: readonly string[];
  readonly successBooleanPath?: readonly string[];
}

export interface ConnectionProbeContract {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly readOnly: true;
  readonly timeoutMs: number;
  readonly verifyCommand: string;
  readonly transport: ConnectionCommandProbe | ConnectionHttpProbe;
}

export interface ConnectionContract {
  readonly adapterId: string;
  readonly authMethod: ConnectionAuthMethod;
  readonly envVars: readonly ConnectionEnvVar[];
  readonly configFields: readonly ConnectionConfigField[];
  readonly credentialUrl: string;
  readonly scopes: readonly string[];
  readonly probe: ConnectionProbeContract;
}

export interface ConnectionCommandResult {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface ConnectionHttpRequest {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly basicAuth?: { readonly username: string; readonly password: string };
  readonly body?: string;
  readonly timeoutMs: number;
}

export interface ConnectionHttpResponse {
  readonly status: number;
  readonly body?: unknown;
}

export interface ConnectionProbeFixture {
  readonly command?: ConnectionCommandResult;
  readonly http?: ConnectionHttpResponse;
  readonly error?: "timeout" | "network";
}

export interface ConnectionProbeOptions {
  readonly mode?: ConnectionProbeMode;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly fixture?: ConnectionProbeFixture;
  readonly timeoutMs?: number;
  readonly exec?: (command: string, args: readonly string[], timeoutMs: number) => Promise<ConnectionCommandResult>;
  readonly fetch?: (request: ConnectionHttpRequest) => Promise<ConnectionHttpResponse>;
}

export interface ConnectionProbeResult {
  readonly adapterId: string;
  readonly probeId: string;
  readonly status: ConnectionProbeStatus;
  readonly authMethod: ConnectionAuthMethod;
  readonly summary: string;
  readonly verifyCommand: string;
  readonly readOnly: true;
}

class ConnectionConfigurationError extends Error {
  constructor() {
    super("Connection configuration is invalid.");
    this.name = "ConnectionConfigurationError";
  }
}

export async function runConnectionProbe(
  contract: ConnectionContract,
  options: ConnectionProbeOptions = {},
): Promise<ConnectionProbeResult> {
  const mode = options.mode ?? "live";
  if (mode === "offline") {
    return probeResult(contract, "unverified", "Connection probe was skipped in offline mode; no connection was verified.");
  }
  if (mode === "fixture" && !options.fixture) {
    return probeResult(contract, "unverified", "Connection probe fixture was not provided; no connection was verified.");
  }

  const env = options.env ?? {};
  const config = options.config ?? {};
  const missingEnv = contract.envVars.filter(variable => !environmentValue(env, variable.name));
  const missingConfig = contract.configFields.filter(field => field.required && !resolveConfigField(field, config, env));
  if (missingEnv.length > 0 || missingConfig.length > 0) {
    const missing = [
      ...missingEnv.map(variable => variable.name),
      ...missingConfig.map(field => field.name),
    ];
    return probeResult(contract, "fail", `Connection configuration is incomplete; missing ${missing.join(", ")}.`);
  }

  let timeoutMs: number;
  try {
    timeoutMs = positiveTimeout(options.timeoutMs ?? contract.probe.timeoutMs);
  } catch {
    return probeResult(contract, "fail", "Connection probe timeout must be a positive number of milliseconds.");
  }
  try {
    if (options.fixture?.error === "timeout") {
      return probeResult(contract, "fail", `Read-only connection probe timed out after ${timeoutMs}ms.`);
    }
    if (options.fixture?.error === "network") {
      return probeResult(contract, "unverified", "Read-only connection probe could not reach the provider; connection status is unverified.");
    }
    if (contract.probe.transport.kind === "command") {
      return probeCommand(contract, timeoutMs, mode, options);
    }
    return probeHttp(contract, timeoutMs, mode, env, config, options);
  } catch (error) {
    if (error instanceof ConnectionConfigurationError) {
      return probeResult(contract, "fail", "Connection configuration is invalid; verify the documented environment and config fields.");
    }
    if (isTimeout(error)) {
      return probeResult(contract, "fail", `Read-only connection probe timed out after ${timeoutMs}ms.`);
    }
    return probeResult(contract, "unverified", "Read-only connection probe could not reach the provider; connection status is unverified.");
  }
}

async function probeCommand(
  contract: ConnectionContract,
  timeoutMs: number,
  mode: ConnectionProbeMode,
  options: ConnectionProbeOptions,
): Promise<ConnectionProbeResult> {
  const transport = contract.probe.transport as ConnectionCommandProbe;
  if (mode === "fixture") {
    if (!options.fixture?.command) {
      return probeResult(contract, "fail", "Fixture mode requires a command result for this connection probe; live transport was not used.");
    }
    const execution = options.fixture.command;
    if (execution.exitCode === 0) {
      return probeResult(contract, "pass", `${contract.probe.name} passed.`);
    }
    return probeResult(contract, "fail", `${contract.probe.name} failed; run the verify command for provider-safe details.`);
  }
  if (!options.exec) {
    return probeResult(contract, "unverified", "Connection command transport is unavailable; no connection was verified.");
  }
  const execution = await options.exec(transport.command, transport.args, timeoutMs);
  if (execution.exitCode === 0) {
    return probeResult(contract, "pass", `${contract.probe.name} passed.`);
  }
  return probeResult(contract, "fail", `${contract.probe.name} failed; run the verify command for provider-safe details.`);
}

async function probeHttp(
  contract: ConnectionContract,
  timeoutMs: number,
  mode: ConnectionProbeMode,
  env: Readonly<Record<string, string | undefined>>,
  config: Readonly<Record<string, unknown>>,
  options: ConnectionProbeOptions,
): Promise<ConnectionProbeResult> {
  const transport = contract.probe.transport as ConnectionHttpProbe;
  if (mode === "fixture") {
    if (!options.fixture?.http) {
      return probeResult(contract, "fail", "Fixture mode requires an HTTP result for this connection probe; live transport was not used.");
    }
    const response = options.fixture.http;
    if (response.status < 200 || response.status >= 300) {
      return probeResult(contract, "fail", `${contract.probe.name} failed with HTTP ${response.status}.`);
    }
    if (!matchesSuccessPayload(transport, response.body)) {
      return probeResult(contract, "fail", `${contract.probe.name} returned an unexpected read-only response.`);
    }
    return probeResult(contract, "pass", `${contract.probe.name} passed.`);
  }
  const request = createHttpRequest(transport, timeoutMs, env, config);
  if (!options.fetch) {
    return probeResult(contract, "unverified", "Connection HTTP transport is unavailable; no connection was verified.");
  }
  const response = await options.fetch(request);
  if (response.status < 200 || response.status >= 300) {
    return probeResult(contract, "fail", `${contract.probe.name} failed with HTTP ${response.status}.`);
  }
  if (!matchesSuccessPayload(transport, response.body)) {
    return probeResult(contract, "fail", `${contract.probe.name} returned an unexpected read-only response.`);
  }
  return probeResult(contract, "pass", `${contract.probe.name} passed.`);
}

function createHttpRequest(
  transport: ConnectionHttpProbe,
  timeoutMs: number,
  env: Readonly<Record<string, string | undefined>>,
  config: Readonly<Record<string, unknown>>,
): ConnectionHttpRequest {
  const baseUrl = resolveValue(transport.baseUrl, config, env);
  if (!baseUrl) throw new ConnectionConfigurationError();
  if (!/^https:\/\//iu.test(baseUrl)) throw new ConnectionConfigurationError();
  if (/^https:\/\/[^/]*@/iu.test(baseUrl) || /[?#]/u.test(baseUrl)) throw new ConnectionConfigurationError();
  const url = transport.path === "" ? baseUrl : `${baseUrl.replace(/\/+$/u, "")}/${transport.path.replace(/^\/+/, "")}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  for (const header of transport.headers ?? []) {
    const value = resolveValue(header.value, config, env);
    if (!value) throw new ConnectionConfigurationError();
    headers[header.name] = `${header.prefix ?? ""}${value}`;
  }
  let basicAuth: ConnectionHttpRequest["basicAuth"];
  if (transport.basicAuth) {
    const username = resolveValue(transport.basicAuth.username, config, env);
    const password = resolveValue(transport.basicAuth.password, config, env);
    if (!username || !password) throw new ConnectionConfigurationError();
    basicAuth = Object.freeze({ username, password });
  }
  if (transport.body !== undefined) headers["Content-Type"] = "application/json";
  return Object.freeze({
    url,
    method: transport.method,
    headers: Object.freeze(headers),
    ...(basicAuth === undefined ? {} : { basicAuth }),
    ...(transport.body === undefined ? {} : { body: transport.body }),
    timeoutMs,
  });
}

function matchesSuccessPayload(transport: ConnectionHttpProbe, body: unknown): boolean {
  if (transport.successJsonPath && valueAtPath(body, transport.successJsonPath) === undefined) return false;
  if (transport.successBooleanPath && valueAtPath(body, transport.successBooleanPath) !== true) return false;
  return true;
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!current || typeof current !== "object" || !(segment in current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function resolveConfigField(
  field: ConnectionConfigField,
  config: Readonly<Record<string, unknown>>,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return resolveValue({ configField: field.name, envVar: field.envFallback, defaultValue: field.defaultValue }, config, env);
}

function resolveValue(
  source: ConnectionValueSource,
  config: Readonly<Record<string, unknown>>,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const configured = source.configField ? config[source.configField] : undefined;
  if (typeof configured === "string" && configured.trim() !== "") return configured.trim();
  if (source.envVar) {
    const environment = environmentValue(env, source.envVar);
    if (environment) return environment;
  }
  return source.defaultValue?.trim() || undefined;
}

function environmentValue(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function positiveTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error("Connection probe timeout must be a positive number of milliseconds.");
  return value;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError" || "killed" in error);
}

function probeResult(
  contract: ConnectionContract,
  status: ConnectionProbeStatus,
  summary: string,
): ConnectionProbeResult {
  return Object.freeze({
    adapterId: contract.adapterId,
    probeId: contract.probe.id,
    status,
    authMethod: contract.authMethod,
    summary,
    verifyCommand: contract.probe.verifyCommand,
    readOnly: true,
  });
}
