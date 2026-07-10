import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  defineAdapterHarness,
  defineCiProviderHarness,
  verifyAdapterHarness,
} from "../dist/index.js";

function adapter(support = "supported") {
  return {
    id: "github",
    packageName: "fixture-adapter",
    surface: "github",
    owns: ["fixture-behavior"],
    boundary: "Fixture-only adapter used to verify the test-support contract.",
    capabilities: [{ id: "read-fixture", support, owner: "fixture-adapter", summary: "Read deterministic fixture state." }],
    contractOnly: false,
  };
}

function ciHarness(run) {
  return defineCiProviderHarness({
    fixtureFiles: ["fixtures/check.json"],
    createFixtureTransport: () => ({ status: "success" }),
    createSubject: fixture => fixture,
    capabilityCases: [{ capabilityId: "read-fixture", name: "reads fixture state", run }],
  });
}

describe("adapter conformance testkit", () => {
  it("accepts observed behavior that matches the capability declaration", async () => {
    const harness = defineAdapterHarness({
      adapter: adapter(),
      roles: { ci: ciHarness(subject => assert.equal(subject.status, "success")) },
    });

    await verifyAdapterHarness(harness);
  });

  it("fails when a supported capability behaves as unsupported", async () => {
    const harness = defineAdapterHarness({
      adapter: adapter(),
      roles: { ci: ciHarness(() => { throw new Error("Unsupported fixture behavior"); }) },
    });

    await assert.rejects(
      () => verifyAdapterHarness(harness),
      /declared supported but fixture behavior reported unsupported/,
    );
  });

  it("fails when a declared capability has no case or explicit exclusion", () => {
    assert.throws(() => defineAdapterHarness({
      adapter: adapter(),
      roles: {
        ci: defineCiProviderHarness({
          fixtureFiles: ["fixtures/check.json"],
          createFixtureTransport: () => ({}),
          createSubject: fixture => fixture,
          capabilityCases: [{ capabilityId: "unknown-capability", name: "unknown", run: () => undefined }],
        }),
      },
    }), /undeclared capability unknown-capability/);
  });

  it("does not let adapters exclude capabilities they own", () => {
    const ownedAdapter = adapter();
    assert.throws(() => defineAdapterHarness({
      adapter: {
        ...ownedAdapter,
        capabilities: [
          ...ownedAdapter.capabilities,
          { id: "external-fixture", support: "supported", owner: "other-package", summary: "External fixture capability." },
        ],
      },
      roles: {
        ci: defineCiProviderHarness({
          fixtureFiles: ["fixtures/check.json"],
          createFixtureTransport: () => ({}),
          createSubject: fixture => fixture,
          capabilityCases: [{ capabilityId: "external-fixture", name: "external", run: () => undefined }],
        }),
      },
      ignoredCapabilities: [{ id: "read-fixture", reason: "skip" }],
    }), /Adapter-owned capability read-fixture cannot be excluded/);
  });
});
