/**
 * AI Executor package entry point.
 * The primary interface is the `aie` CLI command.
 */
export const name = '@tjalve/aie';
export { validateConfig } from './config/schema.js';
export {
  getAgentHostProfile,
  getAgentHostProfileSync,
  getAgentHostProfiles,
  getAllAgentHostProfiles,
} from './agent_hosts.js';
export {
  buildModelRoutingFromSelections,
  defaultModelRoutingPolicy,
  detectInstalledRoutingHosts,
  isModelRoutingHost,
  resolveModelRouting,
} from './core/model_routing.js';
export { detectInstalledReviewHostsOnPath, detectInstalledRoutingHostsOnPath } from './app/model_routing_hosts.js';
export { listHostModels } from './app/model_catalog.js';
export { observeAgentHostReadiness } from '@tjalve/qube-core';
export { listInitExternalReviewers } from './init/review_selections.js';
export { isMissingAdapterPackage } from './missing_adapter_package.js';
export type {
  ModelRoutingPolicy,
  ModelRoutingResolution,
} from './core/model_routing.js';
export {
  composeProviderPermutation,
  compositionUsesSelectedKinds,
  resolveCompositionFixturePath,
} from './providers/compose.js';
export {
  GIT_CREDENTIALS_URL,
  GIT_DOWNLOADS_URL,
  GIT_SETUP_URL,
  MINIMUM_GIT_VERSION,
  classifyGitTransportFailure,
  evaluateGitPrerequisites,
  notRequiredGitPrerequisites,
  prerequisiteCheck,
  redactGitError,
  redactRemoteUrl,
  repositoryPrerequisiteStatusFor,
} from './providers/local/git_prerequisites.js';
export { evaluateConfiguredGitHubReadiness, selectedGitHubRoles } from './github_readiness.js';
export type { ConfiguredGitHubReadinessOptions } from './github_readiness.js';
export type { GitHubReadiness } from './providers/github_adapter_exports.js';
export type {
  EvaluateGitPrerequisitesOptions,
} from './providers/local/git_prerequisites.js';
export type {
  RepositoryPrerequisiteCheck,
  RepositoryPrerequisiteReasonCode,
  RepositoryPrerequisites,
  RepositoryPrerequisiteStage,
  RepositoryPrerequisiteStatus,
} from './core/repo_state.js';
export type {
  CapabilityObservation,
  CompositionRole,
  CompositionSupport,
  ProviderComposition,
} from './providers/compose.js';

export type {
  RiskCard,
  RiskCardCatalogValidation,
  RiskCardSelectionInput,
} from './risk_cards/index.js';

export {
  REPO_CONFIGURED_GUIDANCE_HEADING,
  REPO_CONFIGURED_GUIDANCE_PREFACE,
  repoConfiguredFragment,
  renderAgentPrompt,
} from './agent_descriptors.js';

export {
  IMPLEMENTER_LEARNINGS_CAP,
  IMPLEMENTER_LEARNINGS_FRAGMENT_ID,
  formatImplementerLearningsLines,
  selectImplementerLearnings,
} from './implementer_learnings.js';
export type {
  ImplementerLearning,
  ImplementerLearningsSection,
  ImplementerLearningsSelectionInput,
} from './implementer_learnings.js';

export {
  DEFAULT_MAX_RISK_CARDS,
  REQUIRED_RISK_CARD_IDS,
  formatRiskCardImplementerFragment,
  formatRiskCardReviewerFragment,
  implementerFaceHasTestObligation,
  loadRiskCardCatalog,
  pathsTouchPatterns,
  riskCardCatalogPath,
  riskCardFaceSha256,
  selectRiskCards,
  simpleGlobMatch,
  validateRiskCardCatalog,
} from './risk_cards/index.js';
