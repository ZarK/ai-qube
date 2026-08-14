export type {
  AdapterRole,
  CapabilityCaseInput,
  WorkRoleScenarios,
  ReviewRoleScenarios,
  CiRoleScenarios,
  RoleHarnessInput,
  ConnectionHarness,
  IgnoredCapability,
  MutationBoundary,
  RoleHarness,
  AdapterHarnessDescriptor,
} from "./types.js";

export {
  defineWorkProviderHarness,
  defineReviewForgeHarness,
  defineCiProviderHarness,
  defineAdapterHarness,
} from "./descriptor.js";

export {
  markFixtureTransport,
  bindFixtureSubject,
  FIXTURE_TRANSPORT_MARKER,
  FIXTURE_BOUND_TRANSPORT,
} from "./fixtures.js";

export {
  verifyAdapterHarness,
  runAdapterConformance,
} from "./verify.js";

export {
  LIVE_SUITE_ENV_VAR,
  RESOURCE_TAG_PREFIX,
  SHARED_SEED_MANIFEST,
  isResourceTag,
  resourceTag,
  seededTitle,
  renderSeedChecklist,
} from "./seed-manifest.js";
export type { SeedManifest, SeedReviewItem, SeedWorkItem } from "./seed-manifest.js";

export { RequestBudget, RequestBudgetExceededError, DEFAULT_LIVE_MAX_REQUESTS, DEFAULT_LIVE_TIMEOUT_MS } from "./request-budget.js";

export {
  LIVE_SUITE_AUTH_METHODS,
  LIVE_SUITE_PROVIDERS,
  evaluateLiveGate,
  isLiveSuiteAuthMethod,
  isLiveSuiteProvider,
  runProvisionerLifecycle,
  verifySeededWork,
} from "./provisioner.js";
export type {
  LiveSuiteContext,
  LiveSuiteOptions,
  LiveSuiteProvider,
  LiveSuiteReason,
  LiveSuiteResult,
  LiveSuiteStatus,
  ProviderProvisioner,
  ProvisionerSandbox,
  TaggedResource,
} from "./provisioner.js";

export {
  LIVE_SUITE_BOOTSTRAP_CHECKLISTS,
  assertBootstrapChecklistsCoverLiveProviders,
  bootstrapChecklistFor,
} from "./bootstrap-checklists.js";
export type {
  BootstrapChecklistKind,
  BootstrapChecklistStep,
  ProviderBootstrapChecklist,
} from "./bootstrap-checklists.js";

export { runLiveProvisionerSuite } from "./live-suite.js";
export { LIVE_COMBINATION_ARCHETYPES, liveProvidersForArchetype } from "./archetypes.js";
export type { LiveCombinationArchetype } from "./archetypes.js";
export { runLiveCombination, runLiveCombinationSuite } from "./combination-suite.js";
export { createLinearProvisioner } from "./provisioners/linear.js";
export { createGitLabProvisioner } from "./provisioners/gitlab.js";
export { createJiraProvisioner, jiraProjectKey } from "./provisioners/jira.js";
export { createJenkinsProvisioner } from "./provisioners/jenkins.js";

export type { QubeAdapterCapability } from "@tjalve/qube-core";
