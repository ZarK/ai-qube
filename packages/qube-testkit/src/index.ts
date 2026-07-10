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

export type { QubeAdapterCapability } from "@tjalve/qube-core";
