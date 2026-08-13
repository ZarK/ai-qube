import { randomBytes } from "node:crypto";

import type { LiveSuiteContext, ProviderProvisioner, ProvisionerSandbox, TaggedResource } from "../provisioner.js";
import { resourceTag, renderSeedChecklist, seededTitle, type SeedManifest } from "../seed-manifest.js";

const GITLAB_BASE_URL = "https://gitlab.com";

interface GitLabProject {
  readonly id: number;
  readonly path?: string;
  readonly path_with_namespace?: string;
  readonly default_branch?: string | null;
}

interface GitLabIssue {
  readonly id: number;
  readonly iid: number;
  readonly title: string;
}

interface GitLabMergeRequest {
  readonly iid: number;
  readonly title: string;
}

export function createGitLabProvisioner(context: LiveSuiteContext): ProviderProvisioner {
  const token = required(context.env.GITLAB_TOKEN, "GITLAB_TOKEN");
  const baseUrl = (stringValue(context.config.baseUrl) ?? context.env.GITLAB_BASE_URL ?? GITLAB_BASE_URL).replace(/\/+$/, "");
  const client = new GitLabProvisionerClient(context.fetchImpl, baseUrl, token, context.budget.timeoutMs);

  return {
    providerId: "gitlab",
    mapsBlockedStatus: true,
    async construct(): Promise<ProvisionerSandbox> {
      const runId = randomBytes(4).toString("hex");
      const tag = resourceTag(runId);
      const project = await client.createProject(tag);
      return {
        providerId: "gitlab",
        runId,
        tag,
        projectId: String(project.id),
        workIds: {},
        resources: [{ kind: "project", id: String(project.id), tag }],
      };
    },
    async seed(sandbox: ProvisionerSandbox, manifest: SeedManifest): Promise<ProvisionerSandbox> {
      const projectId = required(sandbox.projectId, "sandbox.projectId");
      const workIds: Record<string, string> = {};
      const resources: TaggedResource[] = [...sandbox.resources];
      const created: Record<string, GitLabIssue> = {};
      for (const seed of manifest.workItems) {
        const labels = [sandbox.tag, gitlabStatusLabel(seed.status), gitlabPriorityLabel(seed.priority)].filter(Boolean);
        const issue = await client.createIssue(projectId, {
          title: seededTitle(sandbox.tag, seed.title),
          description: renderSeedChecklist(seed.checklist),
          labels: labels.join(","),
        });
        created[seed.id] = issue;
        workIds[seed.id] = String(issue.iid);
        resources.push({ kind: "issue", id: `${projectId}:${issue.iid}`, tag: sandbox.tag });
      }
      for (const seed of manifest.workItems) {
        const issue = created[seed.id];
        if (!issue || seed.blockedBy.length === 0) continue;
        const lines: string[] = [];
        for (const blockerId of seed.blockedBy) {
          const blocker = created[blockerId];
          if (!blocker) throw new Error(`GitLab seed blockedBy ${blockerId} is missing for ${seed.id}.`);
          await client.createIssueLink(projectId, issue.iid, projectId, blocker.iid);
          lines.push(`Blocked by: #${blocker.iid}`);
        }
        await client.updateIssue(projectId, issue.iid, `${lines.join("\n")}\n\n${renderSeedChecklist(seed.checklist)}`);
      }
      const review = await seedReview(client, projectId, sandbox.tag, manifest);
      if (review) {
        resources.push({ kind: "merge-request", id: String(review.iid), tag: sandbox.tag });
      }
      return { ...sandbox, workIds, resources, reviewId: review ? String(review.iid) : undefined };
    },
    async deconstruct(sandbox: ProvisionerSandbox): Promise<void> {
      if (sandbox.projectId) await client.deleteProject(sandbox.projectId);
    },
    async sweep(tagPrefix = "qube-testkit-"): Promise<readonly TaggedResource[]> {
      const projects = await client.searchProjects(tagPrefix);
      const leftover: TaggedResource[] = [];
      for (const project of projects) {
        const tag = project.path ?? project.path_with_namespace ?? String(project.id);
        if (!tag.startsWith(tagPrefix) && !(project.path_with_namespace ?? "").includes(tagPrefix)) continue;
        await client.deleteProject(String(project.id));
        const still = (await client.searchProjects(tagPrefix)).some(candidate => candidate.id === project.id);
        if (still) leftover.push({ kind: "project", id: String(project.id), tag });
      }
      return leftover;
    },
  };
}

async function seedReview(
  client: GitLabProvisionerClient,
  projectId: string,
  tag: string,
  manifest: SeedManifest,
): Promise<GitLabMergeRequest | undefined> {
  const project = await client.getProject(projectId);
  const defaultBranch = project.default_branch ?? "main";
  const branch = `${tag}-review`;
  await client.createBranch(projectId, branch, defaultBranch);
  await client.commitFile(projectId, branch, "README.md", `# ${tag}\n`, `Seed ${tag} review`);
  const mergeRequest = await client.createMergeRequest(projectId, {
    sourceBranch: branch,
    targetBranch: defaultBranch,
    title: seededTitle(tag, manifest.reviewItem.title),
  });
  await client.createMergeRequestNote(projectId, mergeRequest.iid, manifest.reviewItem.comment);
  return mergeRequest;
}

class GitLabProvisionerClient {
  private readonly apiBase: string;

  constructor(
    private readonly fetchImpl: typeof fetch,
    baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs: number,
  ) {
    this.apiBase = `${baseUrl}/api/v4`;
  }

  async createProject(tag: string): Promise<GitLabProject> {
    return this.request<GitLabProject>("POST", "/projects", {
      name: tag,
      path: tag,
      visibility: "private",
      initialize_with_readme: true,
    });
  }

  async getProject(projectId: string): Promise<GitLabProject> {
    return this.request<GitLabProject>("GET", `/projects/${encodeURIComponent(projectId)}`);
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.request("DELETE", `/projects/${encodeURIComponent(projectId)}`, undefined, { allowMissing: true });
  }

  async searchProjects(search: string): Promise<GitLabProject[]> {
    const projects: GitLabProject[] = [];
    let page: string | null = "1";
    for (let pages = 0; page && pages < 20; pages += 1) {
      const result: { value: GitLabProject[]; nextPage: string | null } = await this.requestPage<GitLabProject[]>(
        "GET",
        `/projects?owned=true&simple=true&search=${encodeURIComponent(search)}&per_page=100&page=${page}`,
      );
      projects.push(...(result.value ?? []));
      page = result.nextPage;
    }
    if (page) throw new Error("GitLab provisioner sweep exceeded the project page bound.");
    return projects;
  }

  async createIssue(projectId: string, input: { readonly title: string; readonly description: string; readonly labels: string }): Promise<GitLabIssue> {
    return this.request<GitLabIssue>("POST", `/projects/${encodeURIComponent(projectId)}/issues`, input);
  }

  async updateIssue(projectId: string, iid: number, description: string): Promise<void> {
    await this.request("PUT", `/projects/${encodeURIComponent(projectId)}/issues/${iid}`, { description });
  }

  async createIssueLink(projectId: string, iid: number, targetProjectId: string, targetIid: number): Promise<void> {
    await this.request("POST", `/projects/${encodeURIComponent(projectId)}/issues/${iid}/links`, {
      target_project_id: targetProjectId,
      target_issue_iid: String(targetIid),
      link_type: "is_blocked_by",
    });
  }

  async createBranch(projectId: string, branch: string, ref: string): Promise<void> {
    await this.request("POST", `/projects/${encodeURIComponent(projectId)}/repository/branches`, { branch, ref });
  }

  async commitFile(projectId: string, branch: string, filePath: string, content: string, message: string): Promise<void> {
    await this.request("POST", `/projects/${encodeURIComponent(projectId)}/repository/commits`, {
      branch,
      commit_message: message,
      actions: [{ action: "update", file_path: filePath, content }],
    });
  }

  async createMergeRequest(projectId: string, input: { readonly sourceBranch: string; readonly targetBranch: string; readonly title: string }): Promise<GitLabMergeRequest> {
    return this.request<GitLabMergeRequest>("POST", `/projects/${encodeURIComponent(projectId)}/merge_requests`, {
      source_branch: input.sourceBranch,
      target_branch: input.targetBranch,
      title: input.title,
    });
  }

  async createMergeRequestNote(projectId: string, iid: number, body: string): Promise<void> {
    await this.request("POST", `/projects/${encodeURIComponent(projectId)}/merge_requests/${iid}/notes`, { body });
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { readonly allowMissing?: boolean } = {},
  ): Promise<T> {
    return (await this.requestPage<T>(method, path, body, options)).value;
  }

  private async requestPage<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { readonly allowMissing?: boolean } = {},
  ): Promise<{ value: T; nextPage: string | null }> {
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers: {
        "PRIVATE-TOKEN": this.token,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (options.allowMissing && (response.status === 404 || response.status === 204)) {
      return { value: undefined as T, nextPage: null };
    }
    if (!response.ok) {
      throw new Error(`GitLab provisioner ${method} ${path} failed with HTTP ${response.status}.`);
    }
    if (response.status === 204) return { value: undefined as T, nextPage: null };
    return {
      value: await response.json() as T,
      nextPage: response.headers.get("x-next-page")?.trim() || null,
    };
  }
}

function gitlabStatusLabel(status: string): string {
  if (status === "in-progress") return "S-InProgress";
  if (status === "blocked") return "S-Blocked";
  return "S-Ready";
}

function gitlabPriorityLabel(priority: string): string {
  if (priority === "critical") return "P1-Critical";
  if (priority === "high") return "P2-High";
  if (priority === "medium") return "P3-Medium";
  if (priority === "low") return "P4-Low";
  return "";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`GitLab provisioner requires ${name}.`);
  return value;
}
