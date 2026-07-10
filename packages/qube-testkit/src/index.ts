import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  ConnectionContract,
  ConnectionProbeFixture,
  ConnectionProbeOptions,
  ConnectionProbeResult,
  QubeAdapterCapability,
  QubeAdapterContract,
  ReviewForgeProvider,
  WorkProvider,
} from "@tjalve/qube-core";

export type AdapterRole = "work-provider" | "review-forge" | "ci-provider";

export interface CapabilityCaseInput<TSubject> {
  readonly capabilityId: string;
  readonly name: string;
  readonly run: (subject: TSubject) => void | Promise<void>;
  readonly unsupportedError?: RegExp;
}

export interface RoleHarnessInput<TTransport, TSubject> {
  readonly fixtureFiles: readonly string[];
  readonly createFixtureTransport: () => TTransport | Promise<TTransport>;
  readonly createSubject: (transport: TTransport) => TSubject | Promise<TSubject>;
  readonly capabilityCases: readonly CapabilityCaseInput<TSubject>[];
}

export interface ConnectionHarness {
  readonly fixtureFile: string;
  readonly fixture: ConnectionProbeFixture;
  readonly contract: ConnectionContract;
  readonly probe: (options?: ConnectionProbeOptions) => Promise<ConnectionProbeResult>;
  readonly live?: {
    readonly envVar: string;
    readonly options?: ConnectionProbeOptions;
  };
}

export interface IgnoredCapability {
  readonly id: string;
  readonly reason: string;
}

interface CapabilityCase {
  readonly capabilityId: string;
  readonly name: string;
  readonly run: (subject: unknown) => void | Promise<void>;
  readonly unsupportedError: RegExp;
}

export interface RoleHarness {
  readonly role: AdapterRole;
  readonly fixtureFiles: readonly string[];
  readonly createFixtureTransport: () => unknown | Promise<unknown>;
  readonly createSubject: (transport: unknown) => unknown | Promise<unknown>;
  readonly capabilityCases: readonly CapabilityCase[];
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

const WORK_CAPABILITIES = Object.freeze([
  "listOpenWork",
  "loadWork",
  "planStatusSync",
  "planLifecycleMutations",
  "applyLifecycleMutations",
  "commentMutations",
  "reviewIntegration",
  "ciMergeStatus",
] as const);

const REVIEW_CAPABILITIES = Object.freeze([
  "loadReview",
  "loadReviewSnapshot",
  "findCurrentBranchReview",
  "planReviewRequests",
  "applyReviewRequests",
] as const);

function defineRoleHarness<TTransport, TSubject>(
  role: AdapterRole,
  input: RoleHarnessInput<TTransport, TSubject>,
): RoleHarness {
  return Object.freeze({
    role,
    fixtureFiles: Object.freeze([...input.fixtureFiles]),
    createFixtureTransport: input.createFixtureTransport,
    createSubject: async (transport: unknown) => input.createSubject(transport as TTransport),
    capabilityCases: Object.freeze(input.capabilityCases.map(testCase => Object.freeze({
      capabilityId: testCase.capabilityId,
      name: testCase.name,
      run: async (subject: unknown) => testCase.run(subject as TSubject),
      unsupportedError: testCase.unsupportedError ?? /unsupported/i,
    }))),
  });
}

export function defineWorkProviderHarness<TTransport, TProvider extends WorkProvider>(
  input: RoleHarnessInput<TTransport, TProvider>,
): RoleHarness {
  return defineRoleHarness("work-provider", input);
}

export function defineReviewForgeHarness<TTransport, TProvider extends ReviewForgeProvider>(
  input: RoleHarnessInput<TTransport, TProvider>,
): RoleHarness {
  return defineRoleHarness("review-forge", input);
}

export function defineCiProviderHarness<TTransport, TProvider>(
  input: RoleHarnessInput<TTransport, TProvider>,
): RoleHarness {
  return defineRoleHarness("ci-provider", input);
}

export function defineAdapterHarness(descriptor: AdapterHarnessDescriptor): AdapterHarnessDescriptor {
  assertDescriptor(descriptor);
  return Object.freeze({
    adapter: descriptor.adapter,
    roles: Object.freeze({ ...descriptor.roles }),
    ignoredCapabilities: Object.freeze([...(descriptor.ignoredCapabilities ?? [])]),
  });
}

export async function verifyAdapterHarness(descriptor: AdapterHarnessDescriptor): Promise<void> {
  assertDescriptor(descriptor);
  for (const harness of roleHarnesses(descriptor)) {
    await verifyRoleShape(descriptor.adapter, harness);
    for (const testCase of harness.capabilityCases) {
      await verifyCapabilityCase(descriptor.adapter, harness, testCase);
    }
  }
  if (descriptor.roles.connection) await verifyConnection(descriptor.adapter, descriptor.roles.connection);
}

export function runAdapterConformance(descriptor: AdapterHarnessDescriptor): void {
  describe(`${descriptor.adapter.id} adapter conformance`, () => {
    it("covers every declared capability exactly once", () => assertDescriptor(descriptor));

    for (const harness of roleHarnesses(descriptor)) {
      describe(harness.role, () => {
        it("constructs the role through its fixture transport", async () => {
          await verifyRoleShape(descriptor.adapter, harness);
        });

        for (const testCase of harness.capabilityCases) {
          it(`${testCase.capabilityId}: ${testCase.name}`, async () => {
            await verifyCapabilityCase(descriptor.adapter, harness, testCase);
          });
        }
      });
    }

    const connection = descriptor.roles.connection;
    if (connection) {
      describe("connection-probe", () => {
        it("matches the adapter contract and passes from its fixture", async () => {
          await verifyConnection(descriptor.adapter, connection);
        });

        it("reports unverified without live access", async () => {
          const result = await connection.probe({ mode: "offline" });
          assert.equal(result.status, "unverified");
          assert.equal(result.readOnly, true);
        });

        if (connection.live) {
          it("runs live only when explicitly enabled", { skip: process.env[connection.live.envVar] !== "1" }, async () => {
            const result = await connection.probe({ ...connection.live?.options, mode: "live" });
            assert.equal(result.status, "pass");
            assert.equal(result.readOnly, true);
          });
        }
      });
    }
  });
}

function roleHarnesses(descriptor: AdapterHarnessDescriptor): RoleHarness[] {
  return [descriptor.roles.work, descriptor.roles.review, descriptor.roles.ci].filter((role): role is RoleHarness => role !== undefined);
}

function assertDescriptor(descriptor: AdapterHarnessDescriptor): void {
  const harnesses = roleHarnesses(descriptor);
  assert.ok(harnesses.length > 0 || descriptor.roles.connection, "Adapter harness must define at least one role suite.");
  assertRolePlacement(descriptor.roles.work, "work-provider", "work");
  assertRolePlacement(descriptor.roles.review, "review-forge", "review");
  assertRolePlacement(descriptor.roles.ci, "ci-provider", "ci");

  const declared = new Map((descriptor.adapter.capabilities ?? []).map(capability => [capability.id, capability]));
  const coverage = new Map<string, string>();
  for (const harness of harnesses) {
    assert.ok(harness.fixtureFiles.length > 0, `${harness.role} must name at least one fixture file.`);
    assert.ok(harness.capabilityCases.length > 0, `${harness.role} must define at least one capability case.`);
    for (const testCase of harness.capabilityCases) addCoverage(coverage, testCase.capabilityId, harness.role);
  }
  for (const ignored of descriptor.ignoredCapabilities ?? []) {
    assert.ok(ignored.reason.trim().length > 0, `Ignored capability ${ignored.id} must include a reason.`);
    const capability = declared.get(ignored.id);
    assert.ok(capability, `Harness excludes undeclared capability ${ignored.id}.`);
    assert.notEqual(capability.owner, descriptor.adapter.packageName, `Adapter-owned capability ${ignored.id} cannot be excluded from observed behavior.`);
    addCoverage(coverage, ignored.id, "ignored");
  }

  for (const capabilityId of coverage.keys()) {
    assert.ok(declared.has(capabilityId), `Harness covers undeclared capability ${capabilityId}.`);
  }
  for (const capabilityId of declared.keys()) {
    assert.ok(coverage.has(capabilityId), `Declared capability ${capabilityId} has no role case or explicit exclusion.`);
  }

  const connection = descriptor.roles.connection;
  if (connection) {
    assert.ok(connection.fixtureFile.trim().length > 0, "Connection harness must name its fixture file.");
    assert.equal(connection.contract.adapterId, descriptor.adapter.id);
    assert.deepEqual(connection.contract, descriptor.adapter.connection);
    assert.equal(connection.contract.probe.readOnly, true);
  }
}

function assertRolePlacement(harness: RoleHarness | undefined, expected: AdapterRole, field: string): void {
  if (harness) assert.equal(harness.role, expected, `Harness roles.${field} must use the ${expected} role contract.`);
}

function addCoverage(coverage: Map<string, string>, capabilityId: string, owner: string): void {
  assert.ok(capabilityId.trim().length > 0, "Capability case ids must be non-empty.");
  assert.equal(coverage.has(capabilityId), false, `Capability ${capabilityId} is covered more than once.`);
  coverage.set(capabilityId, owner);
}

async function createSubject(harness: RoleHarness): Promise<unknown> {
  const transport = await harness.createFixtureTransport();
  return harness.createSubject(transport);
}

async function verifyRoleShape(adapter: QubeAdapterContract, harness: RoleHarness): Promise<void> {
  const subject = await createSubject(harness);
  assert.ok(subject !== null && typeof subject === "object", `${harness.role} fixture must construct an object.`);
  if (harness.role === "work-provider") {
    const provider = subject as WorkProvider;
    assert.equal(provider.id, adapter.id);
    const capabilities = provider.capabilities();
    for (const capability of WORK_CAPABILITIES) assert.equal(typeof capabilities[capability], "boolean", `Work capability ${capability} must be boolean.`);
  }
  if (harness.role === "review-forge") {
    const provider = subject as ReviewForgeProvider;
    assert.equal(provider.id, adapter.id);
    const capabilities = provider.capabilities();
    for (const capability of REVIEW_CAPABILITIES) assert.equal(typeof capabilities[capability], "boolean", `Review capability ${capability} must be boolean.`);
  }
}

async function verifyCapabilityCase(adapter: QubeAdapterContract, harness: RoleHarness, testCase: CapabilityCase): Promise<void> {
  const declaration = adapter.capabilities?.find(capability => capability.id === testCase.capabilityId);
  assert.ok(declaration, `Capability ${testCase.capabilityId} is not declared by ${adapter.id}.`);
  const subject = await createSubject(harness);
  let failure: unknown;
  try {
    await testCase.run(subject);
  } catch (error: unknown) {
    failure = error;
  }

  if (declaration.support === "unsupported") {
    assert.ok(failure, `Capability ${declaration.id} is declared unsupported but its fixture case succeeded.`);
    assert.match(errorMessage(failure), testCase.unsupportedError, `Capability ${declaration.id} must fail with an explicit unsupported error.`);
    return;
  }
  if (!failure) return;
  testCase.unsupportedError.lastIndex = 0;
  if (testCase.unsupportedError.test(errorMessage(failure))) {
    assert.fail(`Capability ${declaration.id} is declared ${declaration.support} but fixture behavior reported unsupported.`);
  }
  throw failure;
}

async function verifyConnection(adapter: QubeAdapterContract, harness: ConnectionHarness): Promise<void> {
  assert.equal(harness.contract.adapterId, adapter.id);
  assert.deepEqual(harness.contract, adapter.connection);
  assert.equal(harness.contract.probe.readOnly, true);
  const result = await harness.probe({ mode: "fixture", fixture: harness.fixture });
  assert.equal(result.status, "pass");
  assert.equal(result.adapterId, adapter.id);
  assert.equal(result.probeId, harness.contract.probe.id);
  assert.equal(result.readOnly, true);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { QubeAdapterCapability };
