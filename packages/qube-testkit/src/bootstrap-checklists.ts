import { LIVE_SUITE_PROVIDERS, type LiveSuiteProvider } from "./provisioner.js";

export type BootstrapChecklistKind = "workspace" | "token" | "permission" | "verify";

export interface BootstrapChecklistStep {
  readonly id: string;
  readonly kind: BootstrapChecklistKind;
  readonly text: string;
}

export interface ProviderBootstrapChecklist {
  readonly providerId: LiveSuiteProvider;
  readonly title: string;
  readonly summary: string;
  readonly envVars: readonly string[];
  readonly steps: readonly BootstrapChecklistStep[];
}

export const LIVE_SUITE_BOOTSTRAP_CHECKLISTS: readonly ProviderBootstrapChecklist[] = Object.freeze([
  Object.freeze({
    providerId: "linear",
    title: "Linear live suite bootstrap",
    summary: "Create a Linear team token and confirm the viewer probe before a live provisioner run.",
    envVars: Object.freeze(["LINEAR_API_KEY", "LINEAR_TEAM_ID", "QUBE_TESTKIT_LIVE"]),
    steps: Object.freeze([
      Object.freeze({ id: "linear-workspace", kind: "workspace", text: "Select a Linear workspace and team that may hold disposable qube-testkit labels and issues." }),
      Object.freeze({ id: "linear-token", kind: "token", text: "Create a Linear personal API key and set LINEAR_API_KEY. Set LINEAR_TEAM_ID to the team id." }),
      Object.freeze({ id: "linear-permission", kind: "permission", text: "Grant the key permission to create labels, create issues, create blocked-by relations, and archive issues." }),
      Object.freeze({ id: "linear-verify", kind: "verify", text: "Set QUBE_TESTKIT_LIVE=1 and run qube doctor --json. Then run the Linear adapter live suite." }),
    ]),
  }),
  Object.freeze({
    providerId: "gitlab",
    title: "GitLab live suite bootstrap",
    summary: "Create a GitLab token that can create private projects, issues, and merge requests.",
    envVars: Object.freeze(["GITLAB_TOKEN", "GITLAB_BASE_URL", "QUBE_TESTKIT_LIVE"]),
    steps: Object.freeze([
      Object.freeze({ id: "gitlab-workspace", kind: "workspace", text: "Select a GitLab user or group that may hold disposable private projects named qube-testkit-*." }),
      Object.freeze({ id: "gitlab-token", kind: "token", text: "Create a personal or project access token and set GITLAB_TOKEN. Set GITLAB_BASE_URL for a self-managed host." }),
      Object.freeze({ id: "gitlab-permission", kind: "permission", text: "Grant api scope so the token can create and delete projects, issues, issue links, branches, and merge requests." }),
      Object.freeze({ id: "gitlab-verify", kind: "verify", text: "Set QUBE_TESTKIT_LIVE=1 and run qube doctor --json. Then run the GitLab adapter live suite." }),
    ]),
  }),
  Object.freeze({
    providerId: "jira",
    title: "Jira live suite bootstrap",
    summary: "Create a Jira Cloud site token that can create a disposable project and issues.",
    envVars: Object.freeze(["JIRA_EMAIL", "JIRA_API_TOKEN", "JIRA_BASE_URL", "QUBE_TESTKIT_LIVE"]),
    steps: Object.freeze([
      Object.freeze({ id: "jira-workspace", kind: "workspace", text: "Select a Jira Cloud site that may hold disposable software projects named qube-testkit-*." }),
      Object.freeze({ id: "jira-token", kind: "token", text: "Create an Atlassian API token for the site account. Set JIRA_EMAIL, JIRA_API_TOKEN, and JIRA_BASE_URL." }),
      Object.freeze({ id: "jira-permission", kind: "permission", text: "Grant Administer Jira or equivalent permission to create and delete projects, create issues, set priority, transition status, and create Blocks links." }),
      Object.freeze({ id: "jira-verify", kind: "verify", text: "Set QUBE_TESTKIT_LIVE=1 and run qube doctor --json. Then run the Jira adapter live suite." }),
    ]),
  }),
  Object.freeze({
    providerId: "jenkins",
    title: "Jenkins live suite bootstrap",
    summary: "Create a Jenkins user token that can create a disposable folder and jobs.",
    envVars: Object.freeze(["JENKINS_USER", "JENKINS_API_TOKEN", "JENKINS_BASE_URL", "QUBE_TESTKIT_LIVE"]),
    steps: Object.freeze([
      Object.freeze({ id: "jenkins-workspace", kind: "workspace", text: "Select a Jenkins controller that may hold disposable folders named qube-testkit-*." }),
      Object.freeze({ id: "jenkins-token", kind: "token", text: "Create an API token for the Jenkins user. Set JENKINS_USER, JENKINS_API_TOKEN, and JENKINS_BASE_URL." }),
      Object.freeze({ id: "jenkins-permission", kind: "permission", text: "Grant Overall/Read, Job/Create, Job/Read, Job/Delete, and folder-plugin access so the suite can create and delete tagged folders and jobs." }),
      Object.freeze({ id: "jenkins-verify", kind: "verify", text: "Set QUBE_TESTKIT_LIVE=1 and run qube doctor --json. Then run the Jenkins adapter live suite." }),
    ]),
  }),
]);

export function bootstrapChecklistFor(providerId: string): ProviderBootstrapChecklist | undefined {
  return LIVE_SUITE_BOOTSTRAP_CHECKLISTS.find(checklist => checklist.providerId === providerId);
}

export function assertBootstrapChecklistsCoverLiveProviders(): void {
  for (const providerId of LIVE_SUITE_PROVIDERS) {
    const checklist = bootstrapChecklistFor(providerId);
    if (!checklist) {
      throw new Error(`Live suite bootstrap checklist is missing for ${providerId}.`);
    }
    const kinds = new Set(checklist.steps.map(step => step.kind));
    for (const kind of ["workspace", "token", "permission", "verify"] as const) {
      if (!kinds.has(kind)) {
        throw new Error(`Live suite bootstrap checklist for ${providerId} is missing a ${kind} step.`);
      }
    }
  }
}
