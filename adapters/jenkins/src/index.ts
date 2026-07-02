import { jenkinsAdapterContract } from "@tjalve/qube-core";

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

export const jenkinsAdapter = jenkinsAdapterContract;
