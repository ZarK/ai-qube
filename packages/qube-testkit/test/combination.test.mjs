import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LIVE_COMBINATION_ARCHETYPES,
  LIVE_SUITE_ENV_VAR,
  createGitLabProvisioner,
  createJenkinsProvisioner,
  createJiraProvisioner,
  createLinearProvisioner,
  liveProvidersForArchetype,
  runLiveCombination,
  runLiveCombinationSuite,
} from "../dist/index.js";

const gitlabAdapter = {
  id: "gitlab",
  packageName: "@tjalve/qube-adapter-gitlab",
  connection: {
    adapterId: "gitlab",
    configPath: "providers.connections.gitlab",
    authMethod: "token-env",
    envVars: [{ name: "GITLAB_TOKEN", sensitive: true, purpose: "token" }],
    configFields: [],
    credentialUrl: "https://gitlab.com/-/user_settings/personal_access_tokens",
    scopes: [],
    probe: {
      id: "gitlab-user",
      name: "GitLab user",
      summary: "user",
      readOnly: true,
      timeoutMs: 5000,
      verifyCommand: "qube doctor --json",
      transport: { kind: "http", method: "GET", baseUrl: { defaultValue: "https://gitlab.com/api/v4" }, path: "/user" },
    },
  },
};

function memoryProvisioner() {
  return {
    providerId: "gitlab",
    mapsBlockedStatus: false,
    async construct() {
      return { providerId: "gitlab", runId: "run", tag: "tag", resources: [], workIds: { ready: "1", blocked: "2" } };
    },
    async seed(sandbox) {
      return sandbox;
    },
    async verify() {
      return ["1", "2"];
    },
    async deconstruct() {},
    async sweep() {
      return [];
    },
  };
}

describe("curated live combinations", () => {
  it("names the four required archetypes", () => {
    assert.deepEqual(LIVE_COMBINATION_ARCHETYPES.map(entry => [entry.id, entry.work, entry.review, entry.ci]), [
      ["github-all-in-one", "github", "github", "github"],
      ["gitlab-all-in-one", "gitlab", "gitlab", "gitlab"],
      ["enterprise-split", "jira", "gitlab", "jenkins"],
      ["saas-split", "linear", "github", "github"],
    ]);
    assert.deepEqual(liveProvidersForArchetype("enterprise-split"), ["jira", "gitlab", "jenkins"]);
  });

  it("skips every archetype without live credentials and never reports passed", async () => {
    for (const archetype of LIVE_COMBINATION_ARCHETYPES) {
      const result = await runLiveCombination(archetype, {
        adapters: { gitlab: gitlabAdapter },
        createProvisioner: () => memoryProvisioner(),
        env: {},
      });
      assert.equal(result.status, "skipped", archetype.id);
      assert.notEqual(result.status, "passed");
    }
  });

  it("rejects Jira as CI", async () => {
    const result = await runLiveCombination({
      id: "enterprise-split",
      work: "jira",
      review: "gitlab",
      ci: "jira",
      liveProviders: ["jira"],
    }, {
      adapters: { gitlab: gitlabAdapter },
      createProvisioner: () => memoryProvisioner(),
      env: { [LIVE_SUITE_ENV_VAR]: "1" },
    });
    assert.equal(result.status, "error");
    assert.match(result.summary, /Jira cannot be selected as review or CI/);
  });

  it("passes GitHub all-in-one only after a live work-cycle probe", async () => {
    const skipped = await runLiveCombination(LIVE_COMBINATION_ARCHETYPES[0], {
      adapters: {},
      createProvisioner: () => memoryProvisioner(),
      env: { [LIVE_SUITE_ENV_VAR]: "1", GITHUB_TOKEN: "token" },
    });
    assert.equal(skipped.status, "skipped");

    const passed = await runLiveCombination(LIVE_COMBINATION_ARCHETYPES[0], {
      adapters: {},
      createProvisioner: () => memoryProvisioner(),
      env: { [LIVE_SUITE_ENV_VAR]: "1", GITHUB_TOKEN: "token" },
      probeGithub: async () => ({ ok: true, workIds: ["queue", "review"] }),
    });
    assert.equal(passed.status, "passed");
    assert.deepEqual(passed.verifiedWork, ["queue", "review"]);
  });
});

const linearAdapter = {
  id: "linear",
  packageName: "@tjalve/qube-adapter-linear",
  connection: {
    adapterId: "linear",
    configPath: "providers.connections.linear",
    authMethod: "token-env",
    envVars: [{ name: "LINEAR_API_KEY", sensitive: true, purpose: "key" }],
    configFields: [{ name: "teamId", valueType: "string", required: true, purpose: "team", envFallback: "LINEAR_TEAM_ID" }],
    credentialUrl: "https://linear.app/settings/api",
    scopes: [],
    probe: {
      id: "linear-viewer",
      name: "Linear viewer",
      summary: "viewer",
      readOnly: true,
      timeoutMs: 5000,
      verifyCommand: "qube doctor --json",
      transport: { kind: "http", method: "POST", baseUrl: { defaultValue: "https://api.linear.app/graphql" }, path: "" },
    },
  },
};

const jiraAdapter = {
  id: "jira",
  packageName: "@tjalve/qube-adapter-jira",
  connection: {
    adapterId: "jira",
    configPath: "providers.connections.jira",
    authMethod: "basic-env",
    envVars: [
      { name: "JIRA_EMAIL", sensitive: false, purpose: "user" },
      { name: "JIRA_API_TOKEN", sensitive: true, purpose: "token" }
    ],
    configFields: [{ name: "baseUrl", valueType: "string", required: true, purpose: "url", envFallback: "JIRA_BASE_URL" }],
    credentialUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
    scopes: [],
    probe: {
      id: "jira-myself",
      name: "Jira myself",
      summary: "myself",
      readOnly: true,
      timeoutMs: 5000,
      verifyCommand: "qube doctor --json",
      transport: { kind: "http", method: "GET", baseUrl: { env: "JIRA_BASE_URL" }, path: "/rest/api/3/myself" },
    },
  },
};

const jenkinsAdapter = {
  id: "jenkins",
  packageName: "@tjalve/qube-adapter-jenkins",
  connection: {
    adapterId: "jenkins",
    configPath: "providers.connections.jenkins",
    authMethod: "basic-env",
    envVars: [
      { name: "JENKINS_USER", sensitive: false, purpose: "user" },
      { name: "JENKINS_TOKEN", sensitive: true, purpose: "token" }
    ],
    configFields: [{ name: "baseUrl", valueType: "string", required: true, purpose: "url", envFallback: "JENKINS_BASE_URL" }],
    credentialUrl: "https://www.jenkins.io/doc/book/system-administration/authenticating-scripted-clients/",
    scopes: [],
    probe: {
      id: "jenkins-whoami",
      name: "Jenkins whoami",
      summary: "whoami",
      readOnly: true,
      timeoutMs: 5000,
      verifyCommand: "qube doctor --json",
      transport: { kind: "http", method: "GET", baseUrl: { env: "JENKINS_BASE_URL" }, path: "/whoAmI/api/json" },
    },
  },
};

runLiveCombinationSuite({
  adapters: {
    gitlab: gitlabAdapter,
    linear: linearAdapter,
    jira: jiraAdapter,
    jenkins: jenkinsAdapter,
  },
  createProvisioner(providerId, context) {
    if (providerId === "gitlab") return createGitLabProvisioner(context);
    if (providerId === "linear") return createLinearProvisioner(context);
    if (providerId === "jira") return createJiraProvisioner(context);
    return createJenkinsProvisioner(context);
  },
  env: process.env,
});
