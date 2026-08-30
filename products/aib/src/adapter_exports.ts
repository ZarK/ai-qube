import type { WorkItemDraft } from "./contracts.js";
import { isMissingAdapterPackage } from "@tjalve/aie";

export type GitLabIssueDraft = import("@tjalve/qube-adapter-gitlab").GitLabIssueDraft;
export type JiraIssueDraft = import("@tjalve/qube-adapter-jira").JiraIssueDraft;
export type LinearIssueDraft = import("@tjalve/qube-adapter-linear").LinearIssueDraft;

type GitLabAdapter = typeof import("@tjalve/qube-adapter-gitlab");
type JiraAdapter = typeof import("@tjalve/qube-adapter-jira");
type LinearAdapter = typeof import("@tjalve/qube-adapter-linear");

let gitlabAdapterPromise: Promise<GitLabAdapter> | undefined;
let jiraAdapterPromise: Promise<JiraAdapter> | undefined;
let linearAdapterPromise: Promise<LinearAdapter> | undefined;

const ADAPTER_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  "@tjalve/qube-adapter-gitlab": "0.1.8",
  "@tjalve/qube-adapter-jira": "0.1.6",
  "@tjalve/qube-adapter-linear": "0.1.6",
});

function missingAdapterError(packageName: string, provider: string): Error {
  const version = ADAPTER_VERSIONS[packageName];
  const spec = version ? `${packageName}@${version}` : packageName;
  return new Error([
    `Work item rendering with provider ${provider} requires optional adapter ${packageName}.`,
    `Run \`npm install --save-exact --ignore-scripts ${spec}\` or \`pnpm add --save-exact --ignore-scripts ${spec}\` for the package placement that owns QUBE.`,
    `Then rerun \`qube init --work-provider ${provider}\`.`,
  ].join(" "));
}

async function loadGitLabAdapter(): Promise<GitLabAdapter> {
  if (!gitlabAdapterPromise) {
    gitlabAdapterPromise = import("@tjalve/qube-adapter-gitlab").catch((error: unknown) => {
      gitlabAdapterPromise = undefined;
      if (isMissingAdapterPackage(error, "@tjalve/qube-adapter-gitlab")) {
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
      if (isMissingAdapterPackage(error, "@tjalve/qube-adapter-jira")) {
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
      if (isMissingAdapterPackage(error, "@tjalve/qube-adapter-linear")) {
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
