export type {
  AdapterRole,
  CapabilityCaseInput,
  WorkRoleScenarios,
  ReviewRoleScenarios,
  CiRoleScenarios,
  RoleHarnessInput,
  ConnectionHarness,
  IgnoredCapability,
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
  verifyAdapterHarness,
  runAdapterConformance,
} from "./verify.js";

export type { QubeAdapterCapability } from "@tjalve/qube-core";
