import { randomBytes } from "node:crypto";

import type { LiveSuiteContext, ProviderProvisioner, ProvisionerSandbox, TaggedResource } from "../provisioner.js";
import { resourceTag, renderSeedChecklist, seededTitle, type SeedManifest } from "../seed-manifest.js";

interface JiraMyself {
  readonly accountId?: string;
}

interface JiraProject {
  readonly id?: string | number;
  readonly key?: string;
  readonly name?: string;
}

interface JiraProjectSearch {
  readonly values?: readonly JiraProject[];
  readonly isLast?: boolean;
  readonly nextPage?: string;
  readonly startAt?: number;
  readonly maxResults?: number;
  readonly total?: number;
}

interface JiraIssueType {
  readonly id?: string;
  readonly name?: string;
  readonly subtask?: boolean;
}

interface JiraPriority {
  readonly id?: string;
  readonly name?: string;
}

interface JiraIssue {
  readonly id: string;
  readonly key: string;
}

interface JiraTransition {
  readonly id: string;
  readonly name?: string;
  readonly to?: {
    readonly name?: string;
    readonly statusCategory?: { readonly key?: string | null } | null;
  };
}

export function createJiraProvisioner(context: LiveSuiteContext): ProviderProvisioner {
  const email = required(context.env.JIRA_EMAIL, "JIRA_EMAIL");
  const apiToken = required(context.env.JIRA_API_TOKEN, "JIRA_API_TOKEN");
  const baseUrl = normalizeBaseUrl(required(
    stringValue(context.config.baseUrl) ?? context.env.JIRA_BASE_URL,
    "JIRA_BASE_URL",
  ));
  const client = new JiraProvisionerClient(context.fetchImpl, baseUrl, email, apiToken, context.budget.timeoutMs);

  return {
    providerId: "jira",
    mapsBlockedStatus: false,
    async construct(): Promise<ProvisionerSandbox> {
      const runId = randomBytes(4).toString("hex");
      const tag = resourceTag(runId);
      const projectKey = jiraProjectKey(runId);
      const myself = await client.getMyself();
      const leadAccountId = required(myself.accountId, "Jira accountId");
      const project = await client.createProject({
        key: projectKey,
        name: tag,
        leadAccountId,
      });
      const key = required(project.key ?? projectKey, "created project key");
      return {
        providerId: "jira",
        runId,
        tag,
        projectId: key,
        workIds: {},
        resources: [{ kind: "project", id: key, tag }],
      };
    },
    async seed(sandbox: ProvisionerSandbox, manifest: SeedManifest): Promise<ProvisionerSandbox> {
      const projectKey = required(sandbox.projectId, "sandbox.projectId");
      const issueTypeId = await client.firstIssueTypeId(projectKey);
      const priorities = await client.listPriorities();
      const workIds: Record<string, string> = {};
      const resources: TaggedResource[] = [...sandbox.resources];
      const created: Record<string, JiraIssue> = {};
      for (const seed of manifest.workItems) {
        const issue = await client.createIssue({
          projectKey,
          summary: seededTitle(sandbox.tag, seed.title),
          issueTypeId,
          priorityId: jiraPriorityId(priorities, seed.priority),
          labels: [sandbox.tag],
          description: checklistDescription(seed.checklist),
        });
        created[seed.id] = issue;
        workIds[seed.id] = issue.key;
        resources.push({ kind: "issue", id: issue.key, tag: sandbox.tag });
        if (seed.status === "in-progress") {
          await client.transitionIssue(issue.key, ["in progress"], ["indeterminate"]);
        }
      }
      for (const seed of manifest.workItems) {
        const issue = created[seed.id];
        if (!issue || seed.blockedBy.length === 0) continue;
        const lines: string[] = [];
        for (const blockerId of seed.blockedBy) {
          const blocker = created[blockerId];
          if (!blocker) throw new Error(`Jira seed blockedBy ${blockerId} is missing for ${seed.id}.`);
          await client.createBlocksLink(blocker.key, issue.key);
          lines.push(`Blocked by: ${blocker.key}`);
        }
        await client.updateIssueDescription(issue.key, `${lines.join("\n")}\n\n${renderSeedChecklist(seed.checklist)}`);
      }
      return { ...sandbox, workIds, resources };
    },
    async deconstruct(sandbox: ProvisionerSandbox): Promise<void> {
      if (sandbox.projectId) await client.deleteProject(sandbox.projectId);
    },
    async sweep(tagPrefix = "qube-testkit-"): Promise<readonly TaggedResource[]> {
      const projects = await client.searchProjects(tagPrefix);
      const leftover: TaggedResource[] = [];
      for (const project of projects) {
        const key = project.key ?? String(project.id ?? "");
        const name = project.name ?? "";
        if (!name.startsWith(tagPrefix) && !key.toUpperCase().startsWith("Q")) continue;
        if (!name.startsWith(tagPrefix)) continue;
        if (key) await client.deleteProject(key);
        const still = (await client.searchProjects(tagPrefix)).some(candidate => {
          const candidateKey = candidate.key ?? String(candidate.id ?? "");
          return candidateKey === key || candidate.id === project.id;
        });
        if (still) leftover.push({ kind: "project", id: key || String(project.id ?? name), tag: name || key });
      }
      return leftover;
    },
  };
}

class JiraProvisionerClient {
  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly baseUrl: string,
    private readonly email: string,
    private readonly apiToken: string,
    private readonly timeoutMs: number,
  ) {}

  async getMyself(): Promise<JiraMyself> {
    return this.request<JiraMyself>("GET", "/rest/api/3/myself");
  }

  async createProject(input: { readonly key: string; readonly name: string; readonly leadAccountId: string }): Promise<JiraProject> {
    try {
      return await this.request<JiraProject>("POST", "/rest/api/3/project", {
        key: input.key,
        name: input.name,
        projectTypeKey: "software",
        projectTemplateKey: "com.pyxis.greenhopper.jira:gh-simplified-agility-kanban",
        leadAccountId: input.leadAccountId,
      });
    } catch (error) {
      if (!isHttpError(error, 400)) throw error;
      return this.request<JiraProject>("POST", "/rest/api/3/project", {
        key: input.key,
        name: input.name,
        projectTypeKey: "software",
        leadAccountId: input.leadAccountId,
      });
    }
  }

  async deleteProject(projectKey: string): Promise<void> {
    await this.request("DELETE", `/rest/api/3/project/${encodeURIComponent(projectKey)}?enableUndo=false`, undefined, {
      allowMissing: true,
    });
  }

  async searchProjects(query: string): Promise<JiraProject[]> {
    const projects: JiraProject[] = [];
    let startAt = 0;
    for (let page = 0; page < 20; page += 1) {
      const payload = await this.request<JiraProjectSearch>(
        "GET",
        `/rest/api/3/project/search?query=${encodeURIComponent(query)}&startAt=${startAt}&maxResults=50`,
      );
      const values = payload.values ?? [];
      const maxResults = payload.maxResults ?? 50;
      projects.push(...values);
      if (values.length === 0 || payload.isLast === true) return projects;
      if (typeof payload.total === "number" && projects.length >= payload.total) return projects;
      if (payload.isLast !== false && values.length < maxResults) return projects;
      startAt += values.length;
    }
    throw new Error("Jira provisioner sweep exceeded the project page bound.");
  }

  async firstIssueTypeId(projectKey: string): Promise<string> {
    const project = await this.request<{ issueTypes?: readonly JiraIssueType[] }>(
      "GET",
      `/rest/api/3/project/${encodeURIComponent(projectKey)}`,
    );
    const types = project.issueTypes ?? [];
    const preferred = types.find(type => !type.subtask && /^task$/i.test(type.name ?? ""))
      ?? types.find(type => !type.subtask && /^story$/i.test(type.name ?? ""))
      ?? types.find(type => !type.subtask);
    const id = preferred?.id;
    if (!id) throw new Error("Jira provisioner did not find a non-subtask issue type in the sandbox project.");
    return id;
  }

  async listPriorities(): Promise<readonly JiraPriority[]> {
    return this.request<JiraPriority[]>("GET", "/rest/api/3/priority");
  }

  async createIssue(input: {
    readonly projectKey: string;
    readonly summary: string;
    readonly issueTypeId: string;
    readonly priorityId: string | undefined;
    readonly labels: readonly string[];
    readonly description: unknown;
  }): Promise<JiraIssue> {
    const fields: Record<string, unknown> = {
      project: { key: input.projectKey },
      summary: input.summary,
      issuetype: { id: input.issueTypeId },
      labels: [...input.labels],
      description: input.description,
    };
    if (input.priorityId) fields.priority = { id: input.priorityId };
    try {
      return await this.request<JiraIssue>("POST", "/rest/api/3/issue", { fields });
    } catch (error) {
      if (!input.priorityId || !isHttpError(error, 400)) throw error;
      delete fields.priority;
      return this.request<JiraIssue>("POST", "/rest/api/3/issue", { fields });
    }
  }

  async updateIssueDescription(issueKey: string, text: string): Promise<void> {
    await this.request("PUT", `/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
      fields: { description: checklistDescriptionFromText(text) },
    });
  }

  async createBlocksLink(blockerKey: string, blockedKey: string): Promise<void> {
    await this.request("POST", "/rest/api/3/issueLink", {
      type: { name: "Blocks" },
      inwardIssue: { key: blockedKey },
      outwardIssue: { key: blockerKey },
    });
  }

  async transitionIssue(issueKey: string, wantedNames: readonly string[], wantedCategories: readonly string[]): Promise<void> {
    const payload = await this.request<{ transitions?: readonly JiraTransition[] }>(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
    );
    const transition = (payload.transitions ?? []).find(candidate => {
      const name = (candidate.to?.name ?? candidate.name ?? "").trim().toLowerCase();
      const category = (candidate.to?.statusCategory?.key ?? "").trim().toLowerCase();
      return wantedNames.includes(name) || wantedCategories.includes(category);
    });
    if (!transition?.id) return;
    await this.request("POST", `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
      transition: { id: transition.id },
    });
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { readonly allowMissing?: boolean } = {},
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.email}:${this.apiToken}`, "utf8").toString("base64")}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (options.allowMissing && (response.status === 404 || response.status === 204)) {
      return undefined as T;
    }
    if (!response.ok) {
      const error = new Error(`Jira provisioner ${method} ${path} failed with HTTP ${response.status}.`);
      (error as Error & { status: number }).status = response.status;
      throw error;
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }
}

function checklistDescription(items: SeedManifest["workItems"][number]["checklist"]): unknown {
  return checklistDescriptionFromText(renderSeedChecklist(items));
}

function checklistDescriptionFromText(text: string): unknown {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

function jiraPriorityId(priorities: readonly JiraPriority[], priority: string): string | undefined {
  const wanted = priority === "critical"
    ? ["highest", "critical", "blocker"]
    : priority === "high"
      ? ["high"]
      : priority === "medium"
        ? ["medium", "normal"]
        : priority === "low"
          ? ["low", "lowest"]
          : [];
  return priorities.find(item => wanted.includes((item.name ?? "").trim().toLowerCase()))?.id;
}

export function jiraProjectKey(runId: string): string {
  const hex = runId.replace(/[^a-fA-F0-9]/g, "").toUpperCase();
  if (hex.length < 4) throw new Error("Jira provisioner run id must include at least 4 hex characters.");
  return `Q${hex}`.slice(0, 10);
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error("Jira provisioner requires JIRA_BASE_URL to use https when sending JIRA_EMAIL and JIRA_API_TOKEN.");
  }
  return url.toString().replace(/\/+$/u, "");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Jira provisioner requires ${name}.`);
  return value;
}

function isHttpError(error: unknown, status: number): boolean {
  return error instanceof Error && "status" in error && (error as Error & { status?: number }).status === status;
}
