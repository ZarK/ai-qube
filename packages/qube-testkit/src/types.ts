import type {
  ConnectionContract,
  ConnectionProbeFixture,
  ConnectionProbeOptions,
  ConnectionProbeResult,
  QubeAdapterContract,
  ReviewItemKey,
  WorkItem,
  WorkItemKey,
} from "@tjalve/qube-core";

export type AdapterRole = "work-provider" | "review-forge" | "ci-provider";

/**
 * Offline suites that call provider.apply must declare fixture-only mutation.
 * Live mutation suites must opt in explicitly and gate with an environment variable.
 */
export type MutationBoundary = "fixture-only" | "live-opt-in";

export interface CapabilityCaseInput<TSubject> {
  readonly capabilityId: string;
  readonly name: string;
  readonly run: (subject: TSubject) => void | Promise<void>;
  readonly unsupportedError?: RegExp;
}

/** Shared work-provider scenario inputs consumed by the reusable suite. */
export interface WorkRoleScenarios {
  /**
   * Policy object passed to planStatusSync / lifecycle planners.
   * Adapters supply their native policy shape; the suite only requires a non-null object.
   */
  readonly statusPolicy: object;
  /**
   * Optional multi-page / large-result transport. When set, the shared suite
   * constructs the subject from this transport and asserts list completeness
   * and request-count bounds.
   */
  readonly createLargeResultTransport?: () => unknown | Promise<unknown>;
  readonly expectedLargeResultCount?: number;
  readonly maxListRequests?: number;
  /**
   * When true, the large-result path uses one high-limit list request.
   * This is not a substitute for multi-page pagination coverage.
   */
  readonly singleShotHighLimit?: boolean;
  /**
   * Multi-page transport that must produce at least two list requests and exact
   * unique aggregation. Required when work-item-queue is supported.
   */
  readonly createMultiPageTransport?: () => unknown | Promise<unknown>;
  readonly expectedMultiPageItemCount?: number;
  readonly minMultiPageRequests?: number;
  /** Optional malformed list payload transport; suite expects non-silent failure. */
  readonly createMalformedTransport?: () => unknown | Promise<unknown>;
  /**
   * Fixture work keys used when map-work-item is supported without work-item-queue.
   * When omitted, expectedWorkById keys are used as the map-only corpus.
   */
  readonly fixtureWorkKeys?: readonly WorkItemKey[];
  /** Expected provider-neutral mappings keyed by work item id. */
  readonly expectedWorkById?: Readonly<Record<string, {
    readonly status?: WorkItem["status"];
    readonly priority?: WorkItem["priority"];
    readonly title?: string;
  }>>;
}

/** Shared review-forge scenario inputs. */
export interface ReviewRoleScenarios {
  readonly reviewPolicy: {
    readonly adapter: "github" | "remote" | "local" | "mixed" | "shadow";
    readonly reviewers: readonly string[];
    readonly requestText: string;
  };
  /**
   * Fixture review key used when findCurrentBranchReview is false or when load
   * paths should not require current-branch discovery.
   */
  readonly fixtureReviewKey?: ReviewItemKey;
  /** Optional findings used to exercise partitionReviewFindings. */
  readonly sampleFindings?: readonly {
    readonly severity: "blocking" | "advisory";
    readonly message: string;
    readonly location?: { readonly path: string; readonly line?: number; readonly side?: "source" | "destination" };
  }[];
  readonly diffPathsWithLines?: Readonly<Record<string, readonly number[]>>;
  /**
   * Thread ids used when resolveReviewThreads is advertised. Required non-empty so
   * the suite cannot pass on the empty-id skipped short-circuit.
   */
  readonly resolveThreadIds?: readonly string[];
}

/** Shared CI scenario inputs. */
export interface CiRoleScenarios {
  readonly mapCheck: (subject: unknown, check: unknown) => {
    readonly result: string;
    readonly reasonCode?: string;
    readonly summary?: string;
    readonly key?: string;
    readonly name?: string;
    readonly url?: string | null;
    readonly path?: string | null;
    readonly workflowName?: string | null;
    readonly runId?: string | null;
    readonly artifact?: string | null;
  };
  readonly passedCheck: unknown;
  readonly failedCheck: unknown;
  readonly pendingCheck: unknown;
  /** Required when trigger-workflow-run is declared unsupported. */
  readonly unsupportedTrigger?: () => void | Promise<void>;
}

export interface RoleHarnessInput<TTransport, TSubject> {
  /** Directory used to resolve and bind fixtureFiles on disk. */
  readonly fixtureRoot: string;
  readonly fixtureFiles: readonly string[];
  readonly createFixtureTransport: () => TTransport | Promise<TTransport>;
  readonly createSubject: (transport: TTransport) => TSubject | Promise<TSubject>;
  /**
   * Declares how provider mutations are isolated for offline conformance.
   * Required for work-provider and review-forge harnesses.
   */
  readonly mutationBoundary?: MutationBoundary;
  /** Required when mutationBoundary is live-opt-in. */
  readonly liveMutationEnvVar?: string;
  /**
   * Adapter-authored cases supplement the shared role suite for declared
   * capabilities that need provider-specific assertions. Shared suite cases
   * cover role-contract semantics so a new adapter does not start from zero.
   */
  readonly capabilityCases?: readonly CapabilityCaseInput<TSubject>[];
  readonly workScenarios?: WorkRoleScenarios;
  readonly reviewScenarios?: ReviewRoleScenarios;
  readonly ciScenarios?: CiRoleScenarios;
  /** Counts fixture-transport list invocations for pagination/large-result checks. */
  readonly getListRequestCount?: (transport: TTransport) => number;
}

export interface ConnectionHarness {
  /** Directory used to resolve fixtureFile on disk. */
  readonly fixtureRoot?: string;
  readonly fixtureFile: string;
  readonly fixture: ConnectionProbeFixture;
  readonly contract: ConnectionContract;
  readonly probe: (options?: ConnectionProbeOptions) => Promise<ConnectionProbeResult>;
  readonly live?: {
    readonly envVar: string;
    readonly options?: ConnectionProbeOptions;
  };
  /** Deterministic negative probe fixtures for auth/trust-boundary coverage. */
  readonly negativeFixtures?: {
    readonly badCredential?: ConnectionProbeFixture;
    readonly unreachable?: ConnectionProbeFixture;
    readonly timeout?: ConnectionProbeFixture;
  };
}

export interface IgnoredCapability {
  readonly id: string;
  readonly reason: string;
}

export interface CapabilityCase {
  readonly capabilityId: string;
  readonly name: string;
  readonly run: (subject: unknown) => void | Promise<void>;
  readonly unsupportedError: RegExp;
  readonly shared: boolean;
}

export interface RoleHarness {
  readonly role: AdapterRole;
  readonly fixtureRoot: string;
  readonly fixtureFiles: readonly string[];
  readonly createFixtureTransport: () => unknown | Promise<unknown>;
  readonly createSubject: (transport: unknown) => unknown | Promise<unknown>;
  readonly mutationBoundary?: MutationBoundary;
  readonly liveMutationEnvVar?: string;
  readonly capabilityCases: readonly CapabilityCase[];
  readonly workScenarios?: WorkRoleScenarios;
  readonly reviewScenarios?: ReviewRoleScenarios;
  readonly ciScenarios?: CiRoleScenarios;
  readonly getListRequestCount?: (transport: unknown) => number;
}

export interface AdapterHarnessDescriptor {
  readonly adapter: QubeAdapterContract;
  readonly roles: {
    readonly work?: RoleHarness;
    readonly review?: RoleHarness;
    readonly ci?: RoleHarness;
    readonly connection?: ConnectionHarness;
  };
  readonly ignoredCapabilities?: readonly IgnoredCapability[];
}
