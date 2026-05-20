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
});
