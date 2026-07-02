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
const GITLAB_PAGE_LIMIT = 100;
const DEFAULT_MAX_REVIEW_PAGES = 10;
const DEFAULT_MAX_REVIEW_ITEMS = 1_000;
const DEFAULT_MAX_RESPONSE_BYTES = 5_000_000;

export function required(value: string | undefined, name: string): string {
  if (value && value.trim() !== "") return value.trim();
  throw new Error(`GitLab review forge requires ${name}. Set it explicitly in provider options or the documented environment variable before reading GitLab merge requests.`);
}

function requestTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) throw new Error("GitLab review forge requestTimeoutMs must be a positive number of milliseconds.");
  return value;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`GitLab review forge ${name} must be a positive integer.`);
  return value;
}

function encodeProjectId(projectId: string): string {
  return encodeURIComponent(projectId);
}

function isAbortTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || error.name === "AbortError";
}

export function normalizeMergeRequestIid(value: string | number): string {
  return String(value).replace(/^!/, "");
}

export class FetchGitLabReviewRestClient implements GitLabReviewRestClient {
  private readonly apiBaseUrl: string;
  private readonly token: string;
  private readonly requestTimeoutMs: number;
  private readonly maxReviewPages: number;
  private readonly maxReviewItems: number;
  private readonly maxResponseBytes: number;

  constructor(options: GitLabReviewProviderOptions) {
    this.apiBaseUrl = `${(options.baseUrl ?? process.env.GITLAB_BASE_URL ?? GITLAB_BASE_URL).replace(/\/+$/, "")}/api/v4`;
    this.token = required(options.token ?? process.env.GITLAB_TOKEN, "GITLAB_TOKEN");
    this.requestTimeoutMs = requestTimeoutMs(options.requestTimeoutMs);
    this.maxReviewPages = positiveInteger(options.maxReviewPages, DEFAULT_MAX_REVIEW_PAGES, "maxReviewPages");
    this.maxReviewItems = positiveInteger(options.maxReviewItems, DEFAULT_MAX_REVIEW_ITEMS, "maxReviewItems");
    this.maxResponseBytes = positiveInteger(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, "maxResponseBytes");
  }

  async getMergeRequest(input: { projectId: string; iid: string }): Promise<GitLabMergeRequest> {
    return this.get(`/projects/${encodeProjectId(input.projectId)}/merge_requests/${encodeURIComponent(normalizeMergeRequestIid(input.iid))}`);
  }

  async findMergeRequestForBranch(input: { projectId: string; sourceBranch: string }): Promise<GitLabMergeRequest | null> {
    const requests = await this.get<GitLabMergeRequest[]>(`/projects/${encodeProjectId(input.projectId)}/merge_requests`, { state: "opened", source_branch: input.sourceBranch, per_page: "1" });
    return requests[0] ?? null;
  }

  async listMergeRequestNotes(input: { projectId: string; iid: string }): Promise<GitLabNote[]> {
    return this.getPages(`/projects/${encodeProjectId(input.projectId)}/merge_requests/${encodeURIComponent(normalizeMergeRequestIid(input.iid))}/notes`);
  }

  async listMergeRequestDiscussions(input: { projectId: string; iid: string }): Promise<GitLabDiscussion[]> {
    return this.getPages(`/projects/${encodeProjectId(input.projectId)}/merge_requests/${encodeURIComponent(normalizeMergeRequestIid(input.iid))}/discussions`);
  }

  async createMergeRequestNote(input: { projectId: string; iid: string; body: string }): Promise<GitLabNote> {
    return this.post(`/projects/${encodeProjectId(input.projectId)}/merge_requests/${encodeURIComponent(normalizeMergeRequestIid(input.iid))}/notes`, { body: input.body });
  }

  async getCurrentUser(): Promise<GitLabUser> {
    return this.get("/user");
  }

  private async get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    return (await this.getPage<T>(path, query)).value;
  }

  private async getPages<T>(path: string): Promise<T[]> {
    const values: T[] = [];
    let page: string | null = "1";
    let pagesRead = 0;
    while (page && pagesRead < this.maxReviewPages && values.length < this.maxReviewItems) {
      const result: { value: T[]; nextPage: string | null } = await this.getPage<T[]>(path, {
        per_page: String(GITLAB_PAGE_LIMIT),
        page,
      });
      pagesRead += 1;
      if (values.length + result.value.length > this.maxReviewItems) {
        throw new Error(`GitLab review forge read for ${path} exceeded maxReviewItems=${this.maxReviewItems}. Next action: raise the configured bound only after confirming the merge request review history is expected, or archive old review noise before rerunning.`);
      }
      values.push(...result.value);
      page = result.nextPage;
    }
    if (page) {
      throw new Error(`GitLab review forge read for ${path} exceeded maxReviewPages=${this.maxReviewPages}. Next action: raise the configured bound only after confirming the merge request review history is expected, or archive old review noise before rerunning.`);
    }
    return values;
  }

  private async getPage<T>(path: string, query: Record<string, string> = {}): Promise<{ value: T; nextPage: string | null }> {
    const url = new URL(`${this.apiBaseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await this.request(url, { method: "GET" });
    return { value: await this.readJson<T>(response, path), nextPage: response.headers.get("x-next-page")?.trim() || null };
  }

  private async post<T>(path: string, body: Record<string, string>): Promise<T> {
    const response = await this.request(new URL(`${this.apiBaseUrl}${path}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return this.readJson(response, path);
  }

  private async request(url: URL, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          "PRIVATE-TOKEN": this.token,
          Accept: "application/json",
          ...init.headers,
        },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      if (isAbortTimeout(error)) {
        throw new Error(`GitLab API request timed out after ${this.requestTimeoutMs}ms. Service may be stalling or unreachable. Verify GITLAB_TOKEN, GITLAB_BASE_URL, and GITLAB_PROJECT_ID, then retry.`);
      }
      throw error;
    }
    if (!response.ok) {
      throw new Error(`GitLab API request failed while reading ${url.pathname}. Cause: HTTP ${response.status}. Next action: verify GITLAB_TOKEN, GITLAB_BASE_URL, GITLAB_PROJECT_ID, and project permissions, then retry.`);
    }
    return response;
  }

  private async readJson<T>(response: Response, path: string): Promise<T> {
    const chunks: string[] = [];
    const decoder = new TextDecoder();
    let bytesRead = 0;
    if (!response.body) {
      throw new Error(`GitLab API response for ${path} had no readable body. Next action: retry the request, then verify GitLab API compatibility if the response remains empty.`);
    }
    const reader = response.body.getReader();
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      bytesRead += result.value.byteLength;
      if (bytesRead > this.maxResponseBytes) {
        await reader.cancel();
        throw new Error(`GitLab API response for ${path} exceeded maxResponseBytes=${this.maxResponseBytes}. Next action: raise the configured bound only after confirming the provider payload size is expected, or narrow the merge request review history before rerunning.`);
      }
      chunks.push(decoder.decode(result.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    const body = chunks.join("");
    return JSON.parse(body) as T;
  }
}
