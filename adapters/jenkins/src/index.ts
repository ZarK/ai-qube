import { defineQubeAdapter } from "@tjalve/qube-core";

export {
  JenkinsCiProvider,
  createJenkinsCiProvider,
  jenkinsBuildToGateEvidence,
  jenkinsQueueItemToGateEvidence,
  unsupportedJenkinsMutation,
} from "./jenkins_ci_provider.js";
export type {
  JenkinsArtifact,
  JenkinsBuild,
  JenkinsBuildEvidenceInput,
  JenkinsBuildResult,
  JenkinsBuildSelector,
  JenkinsCiProviderCapabilities,
  JenkinsCiProviderOptions,
  JenkinsQueueItem,
  JenkinsRestClient,
} from "./jenkins_ci_provider.js";

export const jenkinsAdapter = defineQubeAdapter({
  id: "jenkins",
  packageName: "@tjalve/qube-adapter-jenkins",
  surface: "jenkins",
  owns: [
    "jenkins-rest-client",
    "jenkins-build-evidence",
    "jenkins-folder-job-paths",
    "jenkins-artifact-and-log-pointers",
    "unsupported-ci-mutation-reporting",
    "credential-diagnostics",
  ],
  boundary: "Jenkins API access, job/build state mapping, artifact and log pointers, credential diagnostics, and unsupported CI mutation reporting live in this optional adapter package.",
  capabilities: [
    {
      id: "read-ci-status",
      support: "supported",
      owner: "@tjalve/qube-adapter-jenkins",
      summary: "Read Jenkins classic job and folder job build state and normalize it into QUBE gate evidence.",
    },
    {
      id: "diagnose-ci-status",
      support: "supported",
      owner: "@tjalve/qube-adapter-jenkins",
      summary: "Report missing Jenkins configuration, missing credentials, inaccessible jobs, queued builds, unstable builds, and unknown build state explicitly.",
    },
    {
      id: "read-ci-artifacts",
      support: "supported",
      owner: "@tjalve/qube-adapter-jenkins",
      summary: "Attach Jenkins build URL, console log URL, build id, timestamp, and artifact URLs to provider gate evidence metadata when Jenkins exposes them.",
    },
    {
      id: "trigger-ci-run",
      support: "unsupported",
      owner: "@tjalve/qube-adapter-jenkins",
      summary: "Jenkins build trigger and rerun mutations are not supported until a separate mutation capability is designed and tested.",
    },
  ],
  contractOnly: false,
});
