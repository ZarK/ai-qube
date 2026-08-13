import { randomBytes } from "node:crypto";

import type { LiveSuiteContext, ProviderProvisioner, ProvisionerSandbox, TaggedResource } from "../provisioner.js";
import { resourceTag, type SeedManifest } from "../seed-manifest.js";

interface JenkinsJob {
  readonly name?: string;
  readonly url?: string;
  readonly _class?: string;
}

interface JenkinsCrumb {
  readonly crumb?: string;
  readonly crumbRequestField?: string;
}

const FOLDER_XML = `<?xml version='1.1' encoding='UTF-8'?>
<com.cloudbees.hudson.plugins.folder.Folder>
  <description>QUBE live suite sandbox folder</description>
  <properties/>
  <folderViews class="com.cloudbees.hudson.plugins.folder.views.DefaultFolderViewHolder">
    <views/>
    <tabBar class="hudson.views.DefaultViewsTabBar"/>
  </folderViews>
  <healthMetrics/>
</com.cloudbees.hudson.plugins.folder.Folder>
`;

function jobXml(description: string): string {
  return `<?xml version='1.1' encoding='UTF-8'?>
<project>
  <description>${escapeXml(description)}</description>
  <keepDependencies>false</keepDependencies>
  <properties/>
  <scm class="hudson.scm.NullSCM"/>
  <canRoam>true</canRoam>
  <disabled>true</disabled>
  <blockBuildWhenDownstreamBuilding>false</blockBuildWhenDownstreamBuilding>
  <blockBuildWhenUpstreamBuilding>false</blockBuildWhenUpstreamBuilding>
  <triggers/>
  <concurrentBuild>false</concurrentBuild>
  <builders/>
  <publishers/>
  <buildWrappers/>
</project>
`;
}

export function createJenkinsProvisioner(context: LiveSuiteContext): ProviderProvisioner {
  const user = required(stringValue(context.config.user) ?? context.env.JENKINS_USER, "JENKINS_USER");
  const apiToken = required(context.env.JENKINS_API_TOKEN, "JENKINS_API_TOKEN");
  const baseUrl = normalizeBaseUrl(required(
    stringValue(context.config.baseUrl) ?? context.env.JENKINS_BASE_URL,
    "JENKINS_BASE_URL",
  ));
  const client = new JenkinsProvisionerClient(context.fetchImpl, baseUrl, user, apiToken, context.budget.timeoutMs);

  return {
    providerId: "jenkins",
    mapsBlockedStatus: false,
    async construct(): Promise<ProvisionerSandbox> {
      const runId = randomBytes(4).toString("hex");
      const tag = resourceTag(runId);
      await client.createFolder(tag);
      return {
        providerId: "jenkins",
        runId,
        tag,
        folderPath: tag,
        workIds: {},
        resources: [{ kind: "folder", id: tag, tag }],
      };
    },
    async seed(sandbox: ProvisionerSandbox, _manifest: SeedManifest): Promise<ProvisionerSandbox> {
      const folderPath = required(sandbox.folderPath ?? sandbox.tag, "sandbox.folderPath");
      const jobNames = ["seed-ready", "seed-review"] as const;
      const resources: TaggedResource[] = [...sandbox.resources];
      const jobPaths: string[] = [];
      for (const name of jobNames) {
        const jobPath = `${folderPath}/${name}`;
        await client.createJob(folderPath, name, `QUBE live suite ${sandbox.tag} ${name}`);
        jobPaths.push(jobPath);
        resources.push({ kind: "job", id: jobPath, tag: sandbox.tag });
      }
      return { ...sandbox, folderPath, jobPaths, resources };
    },
    async verify(sandbox: ProvisionerSandbox): Promise<readonly string[]> {
      const folderPath = required(sandbox.folderPath ?? sandbox.tag, "sandbox.folderPath");
      await client.getItem(folderPath);
      const verified: string[] = [];
      for (const resource of sandbox.resources) {
        if (resource.kind !== "job") continue;
        await client.getItem(resource.id);
        verified.push(resource.id);
      }
      if (verified.length < 2) {
        throw new Error("Live verify did not observe seeded Jenkins jobs.");
      }
      return verified;
    },
    async deconstruct(sandbox: ProvisionerSandbox): Promise<void> {
      const folderPath = sandbox.folderPath ?? sandbox.tag;
      if (folderPath) await client.deleteItem(folderPath);
    },
    async sweep(tagPrefix = "qube-testkit-"): Promise<readonly TaggedResource[]> {
      const jobs = await client.listRootJobs();
      const leftover: TaggedResource[] = [];
      for (const job of jobs) {
        const name = job.name ?? "";
        if (!name.startsWith(tagPrefix)) continue;
        await client.deleteItem(name);
        const still = (await client.listRootJobs()).some(candidate => candidate.name === name);
        if (still) leftover.push({ kind: "folder", id: name, tag: name });
      }
      return leftover;
    },
  };
}

class JenkinsProvisionerClient {
  private crumbField: string | undefined;
  private crumbValue: string | undefined;
  private cookie: string | undefined;

  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly baseUrl: string,
    private readonly user: string,
    private readonly apiToken: string,
    private readonly timeoutMs: number,
  ) {}

  async createFolder(name: string): Promise<void> {
    await this.ensureCrumb();
    await this.request("POST", `/createItem?name=${encodeURIComponent(name)}`, FOLDER_XML, { contentType: "application/xml; charset=UTF-8" });
  }

  async createJob(folder: string, name: string, description: string): Promise<void> {
    await this.ensureCrumb();
    await this.request(
      "POST",
      `${itemPath(folder)}/createItem?name=${encodeURIComponent(name)}`,
      jobXml(description),
      { contentType: "application/xml; charset=UTF-8" },
    );
  }

  async getItem(jobPath: string): Promise<JenkinsJob> {
    return this.request<JenkinsJob>("GET", `${itemPath(jobPath)}/api/json`);
  }

  async deleteItem(jobPath: string): Promise<void> {
    await this.ensureCrumb();
    await this.request("POST", `${itemPath(jobPath)}/doDelete`, undefined, { allowMissing: true });
  }

  async listRootJobs(): Promise<readonly JenkinsJob[]> {
    const payload = await this.request<{ jobs?: readonly JenkinsJob[] }>("GET", "/api/json?tree=jobs[name,url,_class]");
    return payload.jobs ?? [];
  }

  private async ensureCrumb(): Promise<void> {
    if (this.crumbValue) return;
    const response = await this.raw("GET", "/crumbIssuer/api/json");
    if (response.status === 404) return;
    if (!response.ok) {
      throw new Error(`Jenkins provisioner GET /crumbIssuer/api/json failed with HTTP ${response.status}.`);
    }
    const payload = await response.json() as JenkinsCrumb;
    this.crumbField = payload.crumbRequestField || "Jenkins-Crumb";
    this.crumbValue = payload.crumb;
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0];
  }

  private async request<T>(
    method: string,
    path: string,
    body?: string,
    options: { readonly allowMissing?: boolean; readonly contentType?: string } = {},
  ): Promise<T> {
    const response = await this.raw(method, path, body, options.contentType);
    if (options.allowMissing && (response.status === 404 || response.status === 204)) {
      return undefined as T;
    }
    if (!response.ok) {
      throw new Error(`Jenkins provisioner ${method} ${path} failed with HTTP ${response.status}.`);
    }
    if (response.status === 204 || method === "POST" && !response.headers.get("content-type")?.includes("json")) {
      const text = await response.text();
      if (text.trim() === "") return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        return undefined as T;
      }
    }
    return await response.json() as T;
  }

  private async raw(method: string, path: string, body?: string, contentType?: string): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Basic ${Buffer.from(`${this.user}:${this.apiToken}`, "utf8").toString("base64")}`,
      Accept: "application/json",
    };
    if (this.cookie) headers.Cookie = this.cookie;
    if (this.crumbField && this.crumbValue) headers[this.crumbField] = this.crumbValue;
    if (body !== undefined) headers["Content-Type"] = contentType ?? "application/xml; charset=UTF-8";
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }
}

function itemPath(jobPath: string): string {
  const segments = jobPath.split(/[\\/]+/u).map(segment => segment.trim()).filter(segment => segment !== "");
  if (segments.length === 0) throw new Error("Jenkins provisioner job path must include at least one segment.");
  if (segments.some(segment => segment === "." || segment === "..")) {
    throw new Error("Jenkins provisioner job path must not include dot path segments.");
  }
  return `/${segments.flatMap(segment => ["job", encodeURIComponent(segment)]).join("/")}`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error("Jenkins provisioner requires JENKINS_BASE_URL to use https when credentials may be sent.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("Jenkins provisioner requires JENKINS_BASE_URL to omit credentials. Set JENKINS_USER and JENKINS_API_TOKEN separately.");
  }
  return url.toString().replace(/\/+$/u, "");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Jenkins provisioner requires ${name}.`);
  return value;
}
