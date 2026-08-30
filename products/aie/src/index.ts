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
