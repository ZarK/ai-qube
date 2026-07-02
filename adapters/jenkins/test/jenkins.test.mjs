import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createJenkinsCiProvider,
  jenkinsAdapter,
  jenkinsBuildToGateEvidence,
  jenkinsQueueItemToGateEvidence,
  unsupportedJenkinsMutation,
} from "../dist/index.js";

function build(overrides = {}) {
  return {
    id: "42",
    number: 42,
    result: "SUCCESS",
    building: false,
    queueId: 9,
    timestamp: Date.UTC(2026, 0, 2, 3, 4, 5),
    duration: 1200,
    url: "https://jenkins.example.com/job/folder/job/app/42/",
    fullDisplayName: "folder/app #42",
    artifacts: [{ fileName: "report.xml", relativePath: "reports/report.xml" }],
    ...overrides,
  };
}

describe("Jenkins CI adapter", () => {
  const originalEnv = {
    JENKINS_BASE_URL: process.env.JENKINS_BASE_URL,
    JENKINS_USER: process.env.JENKINS_USER,
    JENKINS_API_TOKEN: process.env.JENKINS_API_TOKEN,
  };
  const originalFetch = globalThis.fetch;

  function restoreEnv() {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    globalThis.fetch = originalFetch;
  }

  it("exposes Jenkins CI capability discovery without mutation support", () => {
    assert.equal(jenkinsAdapter.id, "jenkins");
    assert.equal(jenkinsAdapter.packageName, "@tjalve/qube-adapter-jenkins");
    assert.ok(jenkinsAdapter.capabilities.some(capability => capability.id === "read-ci-status" && capability.support === "supported"));
    assert.ok(jenkinsAdapter.capabilities.some(capability => capability.id === "trigger-ci-run" && capability.support === "unsupported"));
    assert.equal(unsupportedJenkinsMutation("trigger-build").supported, false);
  });

  it("normalizes successful Jenkins folder job builds into gate evidence", () => {
    const evidence = jenkinsBuildToGateEvidence({
      jobPath: "folder/app",
      build: 42,
      buildRecord: build(),
      required: true,
    });

    assert.equal(evidence.key, "jenkins:folder/app:42");
    assert.equal(evidence.result, "passed");
    assert.equal(evidence.source, "provider-check");
    assert.equal(evidence.trust, "trusted-provider");
    assert.equal(evidence.providerRunId, "42");
    assert.equal(evidence.recordedAt, "2026-01-02T03:04:05.000Z");
    assert.equal(evidence.metadata.jobPath, "folder/app");
    assert.equal(evidence.metadata.logUrl, "https://jenkins.example.com/job/folder/job/app/42/console");
    assert.deepEqual(evidence.metadata.artifactUrls, ["https://jenkins.example.com/job/folder/job/app/42/artifact/reports/report.xml"]);
    assert.equal(evidence.metadata.artifactCount, 1);
    assert.equal(evidence.metadata.artifactUrlsTruncated, false);
    assert.equal(evidence.metadata.providerTextTrust, "untrusted");
  });

  it("reports failed, unstable, queued, missing, and unknown Jenkins states", async () => {
    assert.equal(jenkinsBuildToGateEvidence({ jobPath: "app", build: 1, buildRecord: build({ result: "FAILURE" }) }).result, "failed");
    assert.equal(jenkinsBuildToGateEvidence({ jobPath: "app", build: 1, buildRecord: build({ result: "UNSTABLE" }) }).result, "needs-work");
    assert.equal(jenkinsBuildToGateEvidence({ jobPath: "app", build: 1, buildRecord: build({ result: null, building: true }) }).result, "unknown");
    assert.equal(jenkinsBuildToGateEvidence({ jobPath: "app", build: 1, buildRecord: build({ result: "WEIRD" }) }).result, "unknown");

    const queued = jenkinsQueueItemToGateEvidence({
      jobPath: "app",
      queueItem: { id: 5, why: "Waiting for next available executor", task: { name: "app", url: "https://jenkins.example.com/job/app/" } },
    });
    assert.equal(queued.result, "unknown");
    assert.equal(queued.summary, "Jenkins job app is queued.");
    assert.equal(queued.metadata.queueWhy, "Waiting for next available executor");
    assert.equal(queued.metadata.providerTextTrust, "untrusted");

    const missing = await createJenkinsCiProvider().readBuildEvidence({ jobPath: "app" });
    assert.equal(missing.result, "missing");
    assert.equal(missing.metadata.missingCredentials, true);
  });

  it("bounds Jenkins artifact URLs in gate evidence metadata", () => {
    const artifacts = Array.from({ length: 55 }, (_, index) => ({
      fileName: `report-${index}.xml`,
      relativePath: `reports/report-${index}.xml`,
    }));
    const evidence = jenkinsBuildToGateEvidence({
      jobPath: "folder/app",
      build: 42,
      buildRecord: build({ artifacts }),
    });

    assert.equal(evidence.metadata.artifactCount, 55);
    assert.equal(evidence.metadata.artifactUrls.length, 50);
    assert.equal(evidence.metadata.artifactUrlsTruncated, true);
  });

  it("reads classic Jenkins and folder job paths without assuming one naming convention", async () => {
    const requests = [];
    const provider = createJenkinsCiProvider({
      client: {
        async getBuild(input) {
          requests.push(input);
          return build({ id: input.jobPath, number: input.jobPath === "classic" ? 10 : 11 });
        },
      },
    });

    const classic = await provider.readBuildEvidence({ jobPath: "classic", build: "lastCompletedBuild" });
    const folder = await provider.readBuildEvidence({ jobPath: "team/folder/app", build: 11 });

    assert.equal(provider.capabilities().readBuildEvidence, true);
    assert.equal(provider.capabilities().normalizeQueueItems, true);
    assert.equal(provider.capabilities().triggerBuilds, false);
    assert.equal(classic.result, "passed");
    assert.equal(folder.result, "passed");
    assert.deepEqual(requests, [
      { jobPath: "classic", build: "lastCompletedBuild" },
      { jobPath: "team/folder/app", build: 11 },
    ]);
  });

  it("reports inaccessible Jenkins jobs from provider HTTP status", async () => {
    const provider = createJenkinsCiProvider({
      client: {
        async getBuild() {
          const error = new Error("Jenkins REST request failed with HTTP 403.");
          error.status = 403;
          throw error;
        },
      },
    });

    const evidence = await provider.readBuildEvidence({ jobPath: "private/app", build: "lastBuild" });

    assert.equal(evidence.result, "unknown");
    assert.match(evidence.summary, /inaccessible/);
    assert.equal(evidence.metadata.inaccessible, true);
    assert.equal(evidence.metadata.nextAction.includes("JENKINS_BASE_URL"), true);
  });

  it("uses environment credentials when Jenkins URL is supplied in options", async () => {
    restoreEnv();
    process.env.JENKINS_USER = "build-user";
    process.env.JENKINS_API_TOKEN = "secret-token";
    let authorization = null;
    let requestedUrl = null;
    globalThis.fetch = async (url, init) => {
      requestedUrl = String(url);
      authorization = init.headers.Authorization;
      return new Response(JSON.stringify(build()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      const provider = createJenkinsCiProvider({ baseUrl: "https://jenkins.example.com/" });
      const evidence = await provider.readBuildEvidence({ jobPath: "folder/app", build: 42 });

      assert.equal(evidence.result, "passed");
      assert.equal(requestedUrl, "https://jenkins.example.com/job/folder/job/app/42/api/json?tree=id%2Cnumber%2Cresult%2Cbuilding%2CqueueId%2Ctimestamp%2Cduration%2Curl%2CfullDisplayName%2Cartifacts%5BfileName%2CrelativePath%5D");
      assert.equal(authorization, `Basic ${Buffer.from("build-user:secret-token", "utf8").toString("base64")}`);
    } finally {
      restoreEnv();
    }
  });

  it("rejects credential-bearing Jenkins URLs without leaking secrets into evidence", async () => {
    restoreEnv();
    const provider = createJenkinsCiProvider({ baseUrl: "https://build-user:secret-token@jenkins.example.com/" });

    const evidence = await provider.readBuildEvidence({ jobPath: "folder/app", build: 42 });

    assert.equal(evidence.result, "missing");
    assert.match(evidence.summary, /evidence is missing/);
    assert.doesNotMatch(evidence.summary, /build-user|secret-token|jenkins\.example\.com/);
    assert.equal(evidence.metadata.missingCredentials, true);
  });
});
