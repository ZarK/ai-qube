export type GitLabPipelineCheckResult = "passed" | "failed" | "pending" | "unknown";

export interface GitLabPipelineCheckInput {
  readonly id?: number | string | null;
  readonly status?: string | null;
  readonly sha?: string | null;
  readonly web_url?: string | null;
  readonly name?: string | null;
  readonly headSha?: string | null;
}

export interface GitLabPipelineCheckStatus {
  readonly key: string;
  readonly name: string;
  readonly result: GitLabPipelineCheckResult;
  readonly reasonCode: string;
  readonly summary: string;
  readonly url: string | null;
  readonly runId: string | null;
  readonly artifact: string | null;
  readonly workflowName: string | null;
}

export interface GitLabCiProviderCapabilities {
  readonly readStatus: true;
  readonly diagnoseStatus: true;
  readonly readArtifacts: true;
  readonly triggerRun: false;
}

export interface GitLabCiProviderOptions {
  readonly headSha?: string;
}

const PENDING_STATUSES = new Set(["created", "waiting_for_resource", "preparing", "pending", "running"]);
const FAILED_STATUSES = new Set(["failed", "canceled", "cancelled", "manual"]);

export function mapGitLabPipelineStatus(input: GitLabPipelineCheckInput, headSha?: string | null): GitLabPipelineCheckStatus {
  const status = typeof input.status === "string" ? input.status.toLowerCase() : "";
  const expectedHead = normalizeSha(headSha ?? input.headSha);
  const pipelineSha = normalizeSha(input.sha);
  const matchesHead = expectedHead === null || pipelineSha === null || expectedHead === pipelineSha;
  const runId = input.id === undefined || input.id === null ? null : String(input.id);
  const url = typeof input.web_url === "string" && input.web_url.trim() !== "" ? input.web_url : null;
  const name = typeof input.name === "string" && input.name.trim() !== "" ? input.name : "GitLab pipeline";

  if (!status) {
    return checkStatus({
      runId,
      name,
      result: "unknown",
      reasonCode: "ci-mapping-unknown",
      summary: "GitLab pipeline status is missing.",
      url,
    });
  }

  if (!matchesHead) {
    return checkStatus({
      runId,
      name,
      result: "unknown",
      reasonCode: "stale-head-pipeline",
      summary: `GitLab pipeline status=${input.status}, but pipeline sha ${input.sha ?? "unknown"} does not match head ${expectedHead}.`,
      url,
    });
  }

  if (status === "success") {
    return checkStatus({
      runId,
      name,
      result: "passed",
      reasonCode: "current-head-workflow-run-found",
      summary: `GitLab pipeline status=${input.status}.`,
      url,
    });
  }
  if (FAILED_STATUSES.has(status)) {
    return checkStatus({
      runId,
      name,
      result: "failed",
      reasonCode: "current-head-check-run-failed",
      summary: `GitLab pipeline status=${input.status}.`,
      url,
    });
  }
  if (PENDING_STATUSES.has(status)) {
    return checkStatus({
      runId,
      name,
      result: "pending",
      reasonCode: "current-head-check-run-pending",
      summary: `GitLab pipeline status=${input.status}.`,
      url,
    });
  }
  return checkStatus({
    runId,
    name,
    result: "unknown",
    reasonCode: "ci-mapping-unknown",
    summary: `GitLab pipeline status=${input.status}.`,
    url,
  });
}

export class GitLabCiProvider {
  readonly id = "gitlab" as const;
  private readonly headSha: string | undefined;

  constructor(options: GitLabCiProviderOptions = {}) {
    this.headSha = options.headSha;
  }

  capabilities(): GitLabCiProviderCapabilities {
    return {
      readStatus: true,
      diagnoseStatus: true,
      readArtifacts: true,
      triggerRun: false,
    };
  }

  mapCheck(check: GitLabPipelineCheckInput): GitLabPipelineCheckStatus {
    return mapGitLabPipelineStatus(check, this.headSha ?? check.headSha);
  }

  async triggerRun(): Promise<never> {
    throw new Error("unsupported GitLab CI capability trigger-workflow-run");
  }
}

export function createGitLabCiProvider(options: GitLabCiProviderOptions = {}): GitLabCiProvider {
  return new GitLabCiProvider(options);
}

export function unsupportedGitLabCiMutation(operation: string): { readonly supported: false; readonly operation: string; readonly nextAction: string } {
  return {
    supported: false,
    operation,
    nextAction: "GitLab adapter reads pipeline evidence only. Add a separate tested mutation capability before triggering pipelines.",
  };
}

function checkStatus(input: {
  readonly runId: string | null;
  readonly name: string;
  readonly result: GitLabPipelineCheckResult;
  readonly reasonCode: string;
  readonly summary: string;
  readonly url: string | null;
}): GitLabPipelineCheckStatus {
  return {
    key: `gitlab-pipeline:${input.runId ?? "unknown"}`,
    name: input.name,
    result: input.result,
    reasonCode: input.reasonCode,
    summary: input.summary,
    url: input.url,
    runId: input.runId,
    artifact: input.url,
    workflowName: input.name,
  };
}

function normalizeSha(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}
