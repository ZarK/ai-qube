import type {
  GitLabDiscussion,
  GitLabMergeRequest,
  GitLabNote,
  GitLabReviewProviderOptions,
  GitLabReviewRestClient,
  GitLabUser,
} from "./gitlab_review_types.js";

const GITLAB_BASE_URL = "https://gitlab.com";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export function required(value: string | undefined, name: string): string {
  if (value && value.trim() !== "") return value.trim();
  throw new Error(`GitLab review forge requires ${name}. Set it explicitly in provider options or the documented environment variable before reading GitLab merge requests.`);
}

function requestTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) throw new Error("GitLab review forge requestTimeoutMs must be a positive number of milliseconds.");
  return value;
}

function encodeProjectId(projectId: string): string {
  return encodeURIComponent(projectId);
}

export function normalizeMergeRequestIid(value: string | number): string {
  return String(value).replace(/^!/, "");
}

export class FetchGitLabReviewRestClient implements GitLabReviewRestClient {
  private readonly apiBaseUrl: string;
  private readonly token: string;
  private readonly requestTimeoutMs: number;

  constructor(options: GitLabReviewProviderOptions) {
    this.apiBaseUrl = `${(options.baseUrl ?? process.env.GITLAB_BASE_URL ?? GITLAB_BASE_URL).replace(/\/+$/, "")}/api/v4`;
    this.token = required(options.token ?? process.env.GITLAB_TOKEN, "GITLAB_TOKEN");
    this.requestTimeoutMs = requestTimeoutMs(options.requestTimeoutMs);
  }

  async getMergeRequest(input: { projectId: string; iid: string }): Promise<GitLabMergeRequest> {
    return this.get(`/projects/${encodeProjectId(input.projectId)}/merge_requests/${encodeURIComponent(normalizeMergeRequestIid(input.iid))}`);
  }

  async findMergeRequestForBranch(input: { projectId: string; sourceBranch: string }): Promise<GitLabMergeRequest | null> {
    const requests = await this.get<GitLabMergeRequest[]>(`/projects/${encodeProjectId(input.projectId)}/merge_requests`, { state: "opened", source_branch: input.sourceBranch, per_page: "1" });
    return requests[0] ?? null;
  }

  async listMergeRequestNotes(input: { projectId: string; iid: string }): Promise<GitLabNote[]> {
    return this.get(`/projects/${encodeProjectId(input.projectId)}/merge_requests/${encodeURIComponent(normalizeMergeRequestIid(input.iid))}/notes`, { per_page: "100" });
  }

  async listMergeRequestDiscussions(input: { projectId: string; iid: string }): Promise<GitLabDiscussion[]> {
    return this.get(`/projects/${encodeProjectId(input.projectId)}/merge_requests/${encodeURIComponent(normalizeMergeRequestIid(input.iid))}/discussions`, { per_page: "100" });
  }

  async createMergeRequestNote(input: { projectId: string; iid: string; body: string }): Promise<GitLabNote> {
    return this.post(`/projects/${encodeProjectId(input.projectId)}/merge_requests/${encodeURIComponent(normalizeMergeRequestIid(input.iid))}/notes`, { body: input.body });
  }

  async getCurrentUser(): Promise<GitLabUser> {
    return this.get("/user");
  }

  private async get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.apiBaseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await this.request(url, { method: "GET" });
    return response.json() as Promise<T>;
  }

  private async post<T>(path: string, body: Record<string, string>): Promise<T> {
    const response = await this.request(new URL(`${this.apiBaseUrl}${path}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.json() as Promise<T>;
  }

  private async request(url: URL, init: RequestInit): Promise<Response> {
    const response = await fetch(url, {
      ...init,
      headers: {
        "PRIVATE-TOKEN": this.token,
        Accept: "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`GitLab API request failed while reading ${url.pathname}. Cause: HTTP ${response.status}. Next action: verify GITLAB_TOKEN, GITLAB_BASE_URL, GITLAB_PROJECT_ID, and project permissions, then retry.`);
    }
    return response;
  }
}
