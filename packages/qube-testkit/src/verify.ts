import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  QubeAdapterContract,
  ReviewForgeCapabilities,
  ReviewForgeProvider,
  WorkProvider,
} from "@tjalve/qube-core";

import {
  REVIEW_DECLARATION_FLAGS,
  WORK_DECLARATION_FLAGS,
} from "./capabilities.js";
import { verifyCiRoleSuite } from "./ci-suite.js";
import { verifyConnection } from "./connection-suite.js";
import {
  assertDescriptor,
  createSubject,
  roleHarnesses,
  verifyRoleShape,
} from "./descriptor.js";
import { errorMessage, matchesPattern } from "./fixtures.js";
import { verifyReviewRoleSuite } from "./review-suite.js";
import type {
  AdapterHarnessDescriptor,
  CapabilityCase,
  RoleHarness,
} from "./types.js";
import { verifyWorkRoleSuite } from "./work-suite.js";

export async function verifyAdapterHarness(descriptor: AdapterHarnessDescriptor): Promise<void> {
  assertDescriptor(descriptor);
  for (const harness of roleHarnesses(descriptor)) {
    await verifyRoleShape(descriptor.adapter, harness);
    await verifySharedRoleSuite(descriptor.adapter, harness);
    for (const testCase of harness.capabilityCases) {
      await verifyCapabilityCase(descriptor.adapter, harness, testCase);
    }
  }
  if (descriptor.roles.connection) await verifyConnection(descriptor.adapter, descriptor.roles.connection);
}

export async function verifySharedRoleSuite(adapter: QubeAdapterContract, harness: RoleHarness): Promise<void> {
  if (harness.role === "work-provider") await verifyWorkRoleSuite(adapter, harness);
  if (harness.role === "review-forge") await verifyReviewRoleSuite(adapter, harness);
  if (harness.role === "ci-provider") await verifyCiRoleSuite(adapter, harness);
}

export async function verifyCapabilityCase(adapter: QubeAdapterContract, harness: RoleHarness, testCase: CapabilityCase): Promise<void> {
  const declaration = adapter.capabilities?.find(capability => capability.id === testCase.capabilityId);
  assert.ok(declaration, `Capability ${testCase.capabilityId} is not declared by ${adapter.id}.`);
  const subject = await createSubject(harness);

  // Refuse false success: supported declarations must not run against all-false role flags.
  if (declaration.support === "supported") {
    if (harness.role === "work-provider") {
      const caps = (subject as WorkProvider).capabilities();
      const flags = WORK_DECLARATION_FLAGS[declaration.id] ?? [];
      for (const flag of flags) {
        assert.equal(caps[flag], true, `Capability ${declaration.id} is supported but work flag ${flag} is false.`);
      }
    }
    if (harness.role === "review-forge") {
      const caps = (subject as ReviewForgeProvider).capabilities();
      const flags = REVIEW_DECLARATION_FLAGS[declaration.id] ?? [];
      for (const flag of flags) {
        assert.equal(
          caps[flag as keyof ReviewForgeCapabilities],
          true,
          `Capability ${declaration.id} is supported but review flag ${String(flag)} is false.`,
        );
      }
    }
  }

  let failure: unknown;
  try {
    await testCase.run(subject);
  } catch (error: unknown) {
    failure = error;
  }

  const message = failure === undefined ? "" : errorMessage(failure);
  if (declaration.support === "unsupported") {
    assert.ok(failure, `Capability ${declaration.id} is declared unsupported but its fixture case succeeded.`);
    assert.ok(
      matchesPattern(message, testCase.unsupportedError),
      `Capability ${declaration.id} must fail with an explicit unsupported error.`,
    );
    return;
  }
  if (!failure) return;
  if (matchesPattern(message, testCase.unsupportedError)) {
    assert.fail(`Capability ${declaration.id} is declared ${declaration.support} but fixture behavior reported unsupported.`);
  }
  throw failure;
}

export function runAdapterConformance(descriptor: AdapterHarnessDescriptor): void {
  describe(`${descriptor.adapter.id} adapter conformance`, () => {
    it("covers every declared capability exactly once", () => assertDescriptor(descriptor));

    for (const harness of roleHarnesses(descriptor)) {
      describe(harness.role, () => {
        it("constructs the role through its fixture transport", async () => {
          await verifyRoleShape(descriptor.adapter, harness);
        });

        it("runs the shared role-contract suite", async () => {
          await verifySharedRoleSuite(descriptor.adapter, harness);
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

        it("fails bad-credential fixture probes", async () => {
          const fixture = connection.negativeFixtures?.badCredential ?? {
            command: { exitCode: 1, stdout: "", stderr: "authentication failed" },
          };
          const result = await connection.probe({ mode: "fixture", fixture });
          assert.equal(result.status, "fail");
          assert.equal(result.readOnly, true);
        });

        it("classifies unreachable fixture probes without pass", async () => {
          const fixture = connection.negativeFixtures?.unreachable ?? { error: "network" as const };
          const result = await connection.probe({ mode: "fixture", fixture });
          assert.notEqual(result.status, "pass");
          assert.equal(result.readOnly, true);
        });

        it("fails timeout fixture probes", async () => {
          const fixture = connection.negativeFixtures?.timeout ?? { error: "timeout" as const };
          const result = await connection.probe({ mode: "fixture", fixture });
          assert.equal(result.status, "fail");
          assert.match(result.summary, /timed out/i);
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
