import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fixtureMetadata } from "../dist/fixtures/metadata.js";

describe("metadata implementation", () => {
  it("correctly defines the fixture metadata", () => {
    assert.equal(fixtureMetadata.topics.length, 1);
    assert.equal(fixtureMetadata.commands.length, 4);

    const [cacheTopic] = fixtureMetadata.topics;
    assert.equal(cacheTopic.name, "cache");
    assert.equal(cacheTopic.kind, "topic");

    assert.deepEqual(fixtureMetadata.commands.map((command) => command.name), ["cache clear", "cache explode", "cache inspect", "cache validate"]);
    for (const command of fixtureMetadata.commands) {
      assert.equal(command.kind, "command");
    }
  });

  it("preserves extension metadata", () => {
    const [cacheTopic] = fixtureMetadata.topics;
    assert.equal(cacheTopic.extensions?.fixture, true);
    assert.equal(cacheTopic.extensions?.owner, "toolkit-tests");
  });

  it("validates command structure", () => {
    const cacheInspect = fixtureMetadata.commands.find((command) => command.name === "cache inspect");
    assert.ok(cacheInspect);
    assert.ok(cacheInspect.arguments.length > 0);
    assert.ok(cacheInspect.flags.length > 0);
    assert.ok(cacheInspect.examples.length > 0);
    assert.equal(cacheInspect.interactions?.json, true);
  });

  it("defines structured error fixture commands", () => {
    const cacheValidate = fixtureMetadata.commands.find((command) => command.name === "cache validate");
    const cacheExplode = fixtureMetadata.commands.find((command) => command.name === "cache explode");
    assert.equal(cacheValidate?.errors?.[0]?.kind, "cache-config-invalid");
    assert.equal(cacheValidate?.exitCodes?.[1]?.category, "validation");
    assert.equal(cacheExplode?.errors?.[0]?.kind, "unexpected-error");
    assert.equal(cacheExplode?.exitCodes?.[0]?.category, "unexpected");
  });

  it("validates mutation metadata and dry-run support", () => {
    const cacheClear = fixtureMetadata.commands.find((command) => command.name === "cache clear");
    assert.ok(cacheClear);
    assert.deepEqual(cacheClear.mutation?.categories, ["local-files"]);
    assert.equal(cacheClear.interactions?.dryRun?.supported, true);
  });
});
