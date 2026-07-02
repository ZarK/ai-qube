import { normalizeGateEvidence, type GateEvidence, type GateResult, type JsonObject } from "@tjalve/qube-core";

export type JenkinsBuildSelector = number | "lastBuild" | "lastCompletedBuild" | "lastSuccessfulBuild" | "lastFailedBuild" | string;
export type JenkinsBuildResult = "SUCCESS" | "FAILURE" | "UNSTABLE" | "ABORTED" | "NOT_BUILT" | string | null;

export interface JenkinsArtifact {
  readonly fileName?: string | null;
  readonly relativePath?: string | null;
}

export interface JenkinsBuild {
  readonly id?: string | null;
  readonly number?: number | null;
  readonly result?: JenkinsBuildResult;
  readonly building?: boolean | null;
  readonly queueId?: number | null;
  readonly timestamp?: number | null;
  readonly duration?: number | null;
  readonly url?: string | null;
  readonly fullDisplayName?: string | null;
  readonly artifacts?: readonly JenkinsArtifact[] | null;
}

export interface JenkinsQueueItem {
  readonly id?: number | null;
  readonly why?: string | null;
  readonly cancelled?: boolean | null;
  readonly executable?: JenkinsBuild | null;
  readonly task?: {
    readonly name?: string | null;
    readonly url?: string | null;
  } | null;
  readonly inQueueSince?: number | null;
}

export interface JenkinsRestClient {
  getBuild(input: { readonly jobPath: string; readonly build: JenkinsBuildSelector }): Promise<JenkinsBuild>;
}

export interface JenkinsCiProviderOptions {
  readonly client?: JenkinsRestClient;
  readonly baseUrl?: string;
  readonly user?: string;
  readonly apiToken?: string;
  readonly requestTimeoutMs?: number;
}

export interface JenkinsBuildEvidenceInput {
  readonly jobPath: string;
  readonly build?: JenkinsBuildSelector;
  readonly required?: boolean;
}

export interface JenkinsCiProviderCapabilities {
  readonly readBuildEvidence: boolean;
  readonly normalizeQueueItems: boolean;
  readonly triggerBuilds: false;
  readonly rerunBuilds: false;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_ARTIFACT_URLS = 50;

class JenkinsRequestError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = "JenkinsRequestError";
  }
}

function required(value: string | undefined, name: string): string {
  if (value && value.trim() !== "") return value.trim();
  throw new Error(`Jenkins CI provider requires ${name}. Set it explicitly in provider options or the documented environment variable before reading Jenkins build evidence.`);
}

function requestTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Jenkins CI provider requestTimeoutMs must be a positive number of milliseconds.");
  }
  return value;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error("Jenkins CI provider requires JENKINS_BASE_URL to use https when credentials may be sent.");
  }
  return url.toString().replace(/\/+$/u, "");
}

function normalizeJobPath(value: string): string {
  const segments = value.split(/[\\/]+/u).map(segment => segment.trim()).filter(segment => segment !== "");
  if (segments.length === 0) {
    throw new Error("Jenkins jobPath must include at least one job or folder segment.");
  }
  return segments.join("/");
}

function buildSelector(value: JenkinsBuildSelector): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("Jenkins build number must be a positive safe integer.");
    }
    return String(value);
  }
  const normalized = value.trim();
  if (normalized === "") throw new Error("Jenkins build selector must not be empty.");
  return normalized;
}

function isAbortTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function buildApiUrl(baseUrl: string, jobPath: string, build: JenkinsBuildSelector): URL {
  const url = new URL(baseUrl);
  const root = url.pathname.replace(/\/+$/u, "");
  const jobSegments = normalizeJobPath(jobPath)
    .split("/")
    .flatMap(segment => ["job", encodeURIComponent(segment)]);
  url.pathname = `${root}/${jobSegments.join("/")}/${encodeURIComponent(buildSelector(build))}/api/json`;
  url.searchParams.set("tree", "id,number,result,building,queueId,timestamp,duration,url,fullDisplayName,artifacts[fileName,relativePath]");
  return url;
}

class FetchJenkinsRestClient implements JenkinsRestClient {
  private readonly baseUrl: string;
  private readonly user: string | undefined;
  private readonly apiToken: string | undefined;
  private readonly requestTimeoutMs: number;

  constructor(options: JenkinsCiProviderOptions) {
    const readsEnvAuth = options.baseUrl === undefined;
    this.baseUrl = normalizeBaseUrl(required(options.baseUrl ?? process.env.JENKINS_BASE_URL, "JENKINS_BASE_URL"));
    this.user = options.user ?? (readsEnvAuth ? process.env.JENKINS_USER : undefined);
    this.apiToken = options.apiToken ?? (readsEnvAuth ? process.env.JENKINS_API_TOKEN : undefined);
    if ((this.user === undefined) !== (this.apiToken === undefined)) {
      throw new Error("Jenkins CI provider requires both JENKINS_USER and JENKINS_API_TOKEN when either credential is present.");
    }
    this.requestTimeoutMs = requestTimeoutMs(options.requestTimeoutMs);
  }

  async getBuild(input: { readonly jobPath: string; readonly build: JenkinsBuildSelector }): Promise<JenkinsBuild> {
    const url = buildApiUrl(this.baseUrl, input.jobPath, input.build);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.user !== undefined && this.apiToken !== undefined) {
      headers.Authorization = `Basic ${Buffer.from(`${this.user}:${this.apiToken}`, "utf8").toString("base64")}`;
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      if (isAbortTimeout(error)) {
        throw new JenkinsRequestError(`Jenkins REST request timed out after ${this.requestTimeoutMs}ms. Verify JENKINS_BASE_URL, credentials, job path, and network reachability, then retry.`, null);
      }
      throw error;
    }
    if (!response.ok) {
      throw new JenkinsRequestError(`Jenkins REST request failed with HTTP ${response.status}.`, response.status);
    }
    return response.json() as Promise<JenkinsBuild>;
  }
}

export class JenkinsCiProvider {
  readonly id = "jenkins" as const;
  private readonly options: JenkinsCiProviderOptions;

  constructor(options: JenkinsCiProviderOptions = {}) {
    this.options = options;
  }

  capabilities(): JenkinsCiProviderCapabilities {
    return {
      readBuildEvidence: true,
      normalizeQueueItems: true,
      triggerBuilds: false,
      rerunBuilds: false,
    };
  }

  async readBuildEvidence(input: JenkinsBuildEvidenceInput): Promise<GateEvidence> {
    const jobPath = normalizeJobPath(input.jobPath);
    const build = input.build ?? "lastBuild";
    try {
      const client = this.options.client ?? new FetchJenkinsRestClient(this.options);
      return jenkinsBuildToGateEvidence({
        jobPath,
        build,
        buildRecord: await client.getBuild({ jobPath, build }),
        required: input.required,
      });
    } catch (error) {
      return jenkinsReadFailureToGateEvidence({ jobPath, build, error, required: input.required });
    }
  }
}

export function createJenkinsCiProvider(options: JenkinsCiProviderOptions = {}): JenkinsCiProvider {
  return new JenkinsCiProvider(options);
}

export function jenkinsBuildToGateEvidence(input: {
  readonly jobPath: string;
  readonly build: JenkinsBuildSelector;
  readonly buildRecord: JenkinsBuild;
  readonly required?: boolean;
}): GateEvidence {
  const jobPath = normalizeJobPath(input.jobPath);
  const build = input.buildRecord;
  const result = mapBuildResult(build);
  const buildId = normalizeOptionalText(build.id) ?? (typeof build.number === "number" ? String(build.number) : buildSelector(input.build));
  const buildArtifactUrls = artifactUrls(build);
  const artifactCount = Array.isArray(build.artifacts) ? build.artifacts.length : 0;
  return normalizeGateEvidence({
    key: `jenkins:${jobPath}:${buildId}`,
    name: `Jenkins ${jobPath}`,
    stage: "pre-merge",
    result,
    source: "provider-check",
    trust: "trusted-provider",
    command: null,
    providerRunId: buildId,
    path: normalizeOptionalText(build.url),
    summary: buildSummary(jobPath, build, result),
    recordedAt: recordedAt(build.timestamp),
    metadata: {
      provider: "jenkins",
      jobPath,
      build: buildSelector(input.build),
      buildId,
      buildNumber: typeof build.number === "number" ? build.number : null,
      jenkinsResult: build.result ?? null,
      building: build.building === true,
      queueId: typeof build.queueId === "number" ? build.queueId : null,
      durationMs: typeof build.duration === "number" ? build.duration : null,
      logUrl: build.url ? `${build.url.replace(/\/+$/u, "")}/console` : null,
      artifactUrls: buildArtifactUrls,
      artifactCount,
      artifactUrlsTruncated: artifactCount > buildArtifactUrls.length,
      required: input.required === true,
      providerTextTrust: "untrusted",
    },
  });
}

export function jenkinsQueueItemToGateEvidence(input: {
  readonly jobPath: string;
  readonly queueItem: JenkinsQueueItem;
  readonly required?: boolean;
}): GateEvidence {
  const jobPath = normalizeJobPath(input.jobPath);
  const queueId = typeof input.queueItem.id === "number" ? String(input.queueItem.id) : "queued";
  const summary = input.queueItem.cancelled === true
    ? `Jenkins job ${jobPath} queue item ${queueId} was cancelled.`
    : `Jenkins job ${jobPath} is queued.`;
  return normalizeGateEvidence({
    key: `jenkins:${jobPath}:queue:${queueId}`,
    name: `Jenkins ${jobPath}`,
    stage: "pre-merge",
    result: input.queueItem.cancelled === true ? "failed" : "unknown",
    source: "provider-check",
    trust: "trusted-provider",
    command: null,
    providerRunId: queueId,
    path: normalizeOptionalText(input.queueItem.task?.url),
    summary,
    recordedAt: recordedAt(input.queueItem.inQueueSince),
    metadata: {
      provider: "jenkins",
      jobPath,
      queueId,
      queueWhy: input.queueItem.why ?? null,
      cancelled: input.queueItem.cancelled === true,
      taskName: input.queueItem.task?.name ?? null,
      required: input.required === true,
      providerTextTrust: "untrusted",
    },
  });
}

function jenkinsReadFailureToGateEvidence(input: {
  readonly jobPath: string;
  readonly build: JenkinsBuildSelector;
  readonly error: unknown;
  readonly required?: boolean;
}): GateEvidence {
  const status = input.error instanceof JenkinsRequestError
    ? input.error.status
    : input.error instanceof Error && "status" in input.error && typeof input.error.status === "number"
      ? input.error.status
      : null;
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const inaccessible = status === 401 || status === 403;
  const missing = status === 404 || /requires JENKINS_|requires both JENKINS_/u.test(message);
  const summary = inaccessible
    ? `Jenkins job ${input.jobPath} is inaccessible; verify credentials and job permissions.`
    : missing
      ? `Jenkins job ${input.jobPath} evidence is missing; verify Jenkins configuration, credentials, and job path.`
      : `Jenkins job ${input.jobPath} could not be read: ${message}`;
  return normalizeGateEvidence({
    key: `jenkins:${input.jobPath}:${buildSelector(input.build)}:read`,
    name: `Jenkins ${input.jobPath}`,
    stage: "pre-merge",
    result: missing ? "missing" : "unknown",
    source: "provider-check",
    trust: status === null ? "unverified" : "trusted-provider",
    command: null,
    providerRunId: null,
    path: null,
    summary,
    recordedAt: null,
    metadata: {
      provider: "jenkins",
      jobPath: input.jobPath,
      build: buildSelector(input.build),
      httpStatus: status,
      inaccessible,
      missingCredentials: /requires JENKINS_|requires both JENKINS_/u.test(message) || (inaccessible && !hasCredentialsConfigured()),
      required: input.required === true,
      providerTextTrust: "untrusted",
      nextAction: "Verify JENKINS_BASE_URL, optional JENKINS_USER/JENKINS_API_TOKEN, and the Jenkins job or folder path, then rerun the gate evidence read.",
    },
  });
}

function mapBuildResult(build: JenkinsBuild): GateResult {
  if (build.building === true || build.result === null || build.result === undefined) return "unknown";
  const result = build.result.toUpperCase();
  if (result === "SUCCESS") return "passed";
  if (result === "UNSTABLE") return "needs-work";
  if (result === "NOT_BUILT") return "skipped";
  if (result === "FAILURE" || result === "ABORTED") return "failed";
  return "unknown";
}

function buildSummary(jobPath: string, build: JenkinsBuild, result: GateResult): string {
  const id = normalizeOptionalText(build.id) ?? (typeof build.number === "number" ? String(build.number) : "unknown");
  if (build.building === true) return `Jenkins job ${jobPath} build ${id} is still running or queued.`;
  if (build.result === "UNSTABLE") return `Jenkins job ${jobPath} build ${id} is unstable and needs review.`;
  if (result === "passed") return `Jenkins job ${jobPath} build ${id} passed.`;
  if (result === "failed") return `Jenkins job ${jobPath} build ${id} failed with result ${build.result ?? "unknown"}.`;
  if (result === "skipped") return `Jenkins job ${jobPath} build ${id} was not built.`;
  return `Jenkins job ${jobPath} build ${id} has unknown result ${build.result ?? "none"}.`;
}

function artifactUrls(build: JenkinsBuild): readonly string[] {
  const base = normalizeOptionalText(build.url)?.replace(/\/+$/u, "");
  if (!base || !Array.isArray(build.artifacts)) return [];
  return build.artifacts
    .map(artifact => normalizeOptionalText(artifact.relativePath))
    .filter((relativePath): relativePath is string => relativePath !== null)
    .slice(0, MAX_ARTIFACT_URLS)
    .map(relativePath => `${base}/artifact/${relativePath.split("/").map(encodeURIComponent).join("/")}`);
}

function recordedAt(timestamp: number | null | undefined): string | null {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return null;
  return new Date(timestamp).toISOString();
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function hasCredentialsConfigured(): boolean {
  return typeof process.env.JENKINS_USER === "string" && process.env.JENKINS_USER !== "" && typeof process.env.JENKINS_API_TOKEN === "string" && process.env.JENKINS_API_TOKEN !== "";
}

export function unsupportedJenkinsMutation(operation: string): JsonObject {
  return {
    provider: "jenkins",
    operation,
    supported: false,
    nextAction: "Jenkins adapter reads build evidence only. Add a separate tested mutation capability before triggering or rerunning Jenkins jobs.",
  };
}
