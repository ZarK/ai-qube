import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fixtureMetadata } from "../dist/fixtures/metadata.js";

describe("metadata implementation", () => {
  it("correctly defines the fixture metadata", () => {
    assert.equal(fixtureMetadata.topics.length, 1);
    assert.equal(fixtureMetadata.commands.length, 2);

    const [cacheTopic] = fixtureMetadata.topics;
    assert.equal(cacheTopic.name, "cache");
    assert.equal(cacheTopic.kind, "topic");

    const [cacheInspect, cacheClear] = fixtureMetadata.commands;
    assert.equal(cacheInspect.name, "cache inspect");
    assert.equal(cacheInspect.kind, "command");
    assert.equal(cacheClear.name, "cache clear");
    assert.equal(cacheClear.kind, "command");
  });

  it("preserves extension metadata", () => {
    const [cacheTopic] = fixtureMetadata.topics;
    assert.equal(cacheTopic.extensions?.fixture, true);
    assert.equal(cacheTopic.extensions?.owner, "toolkit-tests");
  });

  it("validates command structure", () => {
    const [cacheInspect] = fixtureMetadata.commands;
    assert.ok(cacheInspect.arguments.length > 0);
    assert.ok(cacheInspect.flags.length > 0);
    assert.ok(cacheInspect.examples.length > 0);
    assert.equal(cacheInspect.interactions?.json, true);
  });

  it("validates mutation metadata and dry-run support", () => {
    const [, cacheClear] = fixtureMetadata.commands;
    assert.deepEqual(cacheClear.mutation?.categories, ["local-files"]);
    assert.equal(cacheClear.interactions?.dryRun?.supported, true);
  });
});
