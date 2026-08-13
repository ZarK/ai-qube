import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  defineAdapterHarness,
  defineCiProviderHarness,
} from "@tjalve/qube-testkit";
import {
  jenkinsAdapter,
  jenkinsBuildToGateEvidence,
  jenkinsQueueItemToGateEvidence,
  probeJenkinsConnection,
  unsupportedJenkinsMutation,
} from "../dist/index.js";

const fixtureRoot = dirname(fileURLToPath(import.meta.url));
const checkFixture = readFixture("./fixtures/conformance-checks.json");
const connectionFixture = readFixture("./fixtures/connection-pass.json");

function mapJenkinsCheck(check) {
  if (check.queueItem) {
    const evidence = jenkinsQueueItemToGateEvidence(check);
    return {
      result: "pending",
      reasonCode: "jenkins-queued",
      summary: evidence.summary,
      name: evidence.name,
      key: evidence.key,
      url: evidence.path,
      artifact: evidence.metadata?.logUrl ?? evidence.path,
    };
  }
  const evidence = jenkinsBuildToGateEvidence(check);
  let result = evidence.result;
  if (result === "needs-work") result = "failed";
  if (evidence.metadata?.building === true && (result === "unknown" || result === "missing")) {
    result = "pending";
  }
  return {
    result,
    reasonCode: String(evidence.metadata?.jenkinsResult ?? evidence.result),
    summary: evidence.summary,
    name: evidence.name,
    key: evidence.key,
    url: evidence.path,
    runId: evidence.providerRunId,
    artifact: evidence.metadata?.logUrl ?? evidence.path,
  };
}

const ci = defineCiProviderHarness({
  fixtureRoot,
  fixtureFiles: ["fixtures/conformance-checks.json"],
  createFixtureTransport: () => checkFixture,
  createSubject: fixture => ({
    fixture,
    mapCheck: mapJenkinsCheck,
  }),
  ciScenarios: {
    passedCheck: checkFixture.passed,
    failedCheck: checkFixture.failed,
    pendingCheck: checkFixture.pending,
  },
  capabilityCases: [
    {
      capabilityId: "read-ci-artifacts",
      name: "attaches Jenkins artifact and log pointers",
      run: () => {
        const mapped = mapJenkinsCheck(checkFixture.passed);
        assert.ok(mapped.artifact && String(mapped.artifact).includes("console"));
        const evidence = jenkinsBuildToGateEvidence(checkFixture.passed);
        assert.ok(Array.isArray(evidence.metadata.artifactUrls));
        assert.ok(evidence.metadata.artifactUrls.length > 0);
      },
    },
    {
      capabilityId: "trigger-ci-run",
      name: "reports trigger mutations as unsupported",
      unsupportedError: /unsupported/i,
      run: () => {
        const result = unsupportedJenkinsMutation("trigger-build");
        assert.equal(result.supported, false);
        throw new Error(`unsupported Jenkins capability trigger-ci-run: ${result.nextAction}`);
      },
    },
  ],
});

export const jenkinsHarness = defineAdapterHarness({
  adapter: jenkinsAdapter,
  roles: {
    ci,
    connection: {
      fixtureRoot,
      fixtureFile: "fixtures/connection-pass.json",
      fixture: connectionFixture,
      contract: jenkinsAdapter.connection,
      probe: options => probeJenkinsConnection({
        ...options,
        env: {
          JENKINS_API_TOKEN: "fixture-token",
          JENKINS_USER: "fixture-user",
          ...(options.env ?? {}),
        },
        config: {
          baseUrl: "https://jenkins.example.com",
          user: "fixture-user",
          ...(options.config ?? {}),
        },
      }),
      live: { envVar: "QUBE_LIVE_PROBES" },
      negativeFixtures: {
        badCredential: { http: { status: 401, body: { message: "authentication failed" } } },
        unreachable: { error: "network" },
        timeout: { error: "timeout" },
      },
    },
  },
});

function readFixture(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8"));
}

