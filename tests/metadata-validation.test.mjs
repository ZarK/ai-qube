import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defineCommand, defineTopic, defineFlag } from "../dist/index.js";

describe("metadata validation", () => {
  it("throws on empty name", () => {
    assert.throws(() => defineTopic({
      kind: "topic",
      name: "",
      description: "Valid description"
    }), /topic.name must not be empty/);
  });

  it("throws on invalid name pattern", () => {
    assert.throws(() => defineTopic({
      kind: "topic",
      name: "Invalid Name",
      description: "Valid description"
    }), /topic.name must use lowercase words separated by single spaces or hyphens/);
  });

  it("throws on short description", () => {
    assert.throws(() => defineTopic({
      kind: "topic",
      name: "valid",
      description: "a"
    }), /topic.description must be descriptive/);
  });

  it("throws on missing dry-run for mutating commands", () => {
    assert.throws(() => defineCommand({
      kind: "command",
      name: "mutate",
      description: "Mutating command",
      mutation: {
        categories: ["local-files"]
      }
    }), /command.interactions.dryRun is required when command.mutation.categories is not empty/);
  });

  it("throws on missing dry-run reason when unsupported", () => {
    assert.throws(() => defineCommand({
      kind: "command",
      name: "mutate",
      description: "Mutating command",
      mutation: {
        categories: ["local-files"]
      },
      interactions: {
        dryRun: {
          supported: false,
          reason: ""
        }
      }
    }), /command.interactions.dryRun.reason must not be empty/);
  });

  it("throws on option flag without options", () => {
    assert.throws(() => defineFlag({
      name: "format",
      description: "Output format",
      type: "option",
      options: []
    }), /flag.options must include at least one value when flag.type is "option"/);
  });

  it("throws on flag names that include leading dashes", () => {
    assert.throws(() => defineFlag({
      name: "--json",
      description: "Render JSON output.",
      type: "boolean"
    }), /flag.name must use a lowercase flag name without leading dashes/);
  });

  it("accepts one-character short flags and rejects rendered or multi-character shorthand", () => {
    assert.doesNotThrow(() => defineFlag({
      name: "dry-run",
      short: "d",
      description: "Preview changes.",
      type: "boolean"
    }));
    for (const short of ["-d", "--dry-run", "dry"]) {
      assert.throws(() => defineFlag({
        name: "dry-run",
        short,
        description: "Preview changes.",
        type: "boolean"
      }), /flag.short must be exactly one letter without leading dashes/);
    }
  });

  it("throws on supply-chain-sensitive metadata without reason or kind", () => {
    assert.throws(() => defineCommand({
      kind: "command",
      name: "install deps",
      description: "Install dependencies",
      supplyChain: {
        sensitive: true,
        kinds: ["dependency"]
      }
    }), /command\.supplyChain\.reason must not be empty/);
    assert.throws(() => defineCommand({
      kind: "command",
      name: "install deps",
      description: "Install dependencies",
      supplyChain: {
        sensitive: true,
        reason: "Dependency operations need review."
      }
    }), /command\.supplyChain\.kinds must include at least one kind/);
  });
});
