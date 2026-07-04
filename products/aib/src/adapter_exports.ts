import type { WorkItemDraft } from "./contracts.js";

export type GitLabIssueDraft = import("@tjalve/qube-adapter-gitlab").GitLabIssueDraft;
export type JiraIssueDraft = import("@tjalve/qube-adapter-jira").JiraIssueDraft;
export type LinearIssueDraft = import("@tjalve/qube-adapter-linear").LinearIssueDraft;

type GitLabAdapter = typeof import("@tjalve/qube-adapter-gitlab");
type JiraAdapter = typeof import("@tjalve/qube-adapter-jira");
type LinearAdapter = typeof import("@tjalve/qube-adapter-linear");

let gitlabAdapterPromise: Promise<GitLabAdapter> | undefined;
let jiraAdapterPromise: Promise<JiraAdapter> | undefined;
let linearAdapterPromise: Promise<LinearAdapter> | undefined;

function isModuleMissing(error: unknown, packageName: string): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String((error as { code?: unknown }).code) : "";
  return code === "ERR_MODULE_NOT_FOUND" && error.message.includes(packageName);
}

function missingAdapterError(packageName: string, provider: string): Error {
  return new Error([
    `Work item rendering with provider ${provider} requires optional adapter ${packageName}.`,
    `Install ${packageName} before using --provider ${provider}.`,
    `Run qube install --work-provider ${provider} --yes --dry-run to review the adapter-backed install plan.`,
  ].join(" "));
}

async function loadGitLabAdapter(): Promise<GitLabAdapter> {
  if (!gitlabAdapterPromise) {
    gitlabAdapterPromise = import("@tjalve/qube-adapter-gitlab").catch((error: unknown) => {
      gitlabAdapterPromise = undefined;
      if (isModuleMissing(error, "@tjalve/qube-adapter-gitlab")) {
        throw missingAdapterError("@tjalve/qube-adapter-gitlab", "gitlab");
      }
      throw error;
    });
  }
  return gitlabAdapterPromise;
}

async function loadJiraAdapter(): Promise<JiraAdapter> {
  if (!jiraAdapterPromise) {
    jiraAdapterPromise = import("@tjalve/qube-adapter-jira").catch((error: unknown) => {
      jiraAdapterPromise = undefined;
      if (isModuleMissing(error, "@tjalve/qube-adapter-jira")) {
        throw missingAdapterError("@tjalve/qube-adapter-jira", "jira");
      }
      throw error;
    });
  }
  return jiraAdapterPromise;
}

async function loadLinearAdapter(): Promise<LinearAdapter> {
  if (!linearAdapterPromise) {
    linearAdapterPromise = import("@tjalve/qube-adapter-linear").catch((error: unknown) => {
      linearAdapterPromise = undefined;
      if (isModuleMissing(error, "@tjalve/qube-adapter-linear")) {
        throw missingAdapterError("@tjalve/qube-adapter-linear", "linear");
      }
      throw error;
    });
  }
  return linearAdapterPromise;
}

export async function renderGitLabIssueDraft(draft: WorkItemDraft): Promise<GitLabIssueDraft> {
  const adapter = await loadGitLabAdapter();
  return adapter.renderGitLabIssueDraft(draft);
}

export async function renderJiraIssueDraft(draft: WorkItemDraft): Promise<JiraIssueDraft> {
  const adapter = await loadJiraAdapter();
  return adapter.renderJiraIssueDraft(draft);
}

export async function renderLinearIssueDraft(draft: WorkItemDraft): Promise<LinearIssueDraft> {
  const adapter = await loadLinearAdapter();
  return adapter.renderLinearIssueDraft(draft);
}