import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { fixtureMetadata } from "../dist/fixtures/metadata.js";
import {
  CommandRegistryValidationError,
  createCommandRegistry,
  findCommand,
  findTopic,
  listCommands,
  listTopics,
  validateCommandRegistry
} from "../dist/index.js";

const validTopic = {
  kind: "topic",
  name: "cache",
  description: "Commands for inspecting and maintaining a local cache."
};

const validCommand = {
  kind: "command",
  name: "cache inspect",
  description: "Inspect cache entries without changing local state.",
  aliases: ["ci"],
  flags: [
    {
      name: "json",
      description: "Render machine-readable JSON output.",
      type: "boolean"
    }
  ],
  examples: [
    {
      description: "Inspect all cache entries.",
      command: "fixture cache inspect"
    }
  ],
  output: {
    formats: ["human", "json"],
    defaultFormat: "human"
  }
};

describe("command registry", () => {
  it("creates deterministic registry output from grouped metadata", () => {
    const registry = createCommandRegistry({
      topics: [
        { ...validTopic, name: "release", description: "Commands for publishing releases." },
        validTopic
      ],
      commands: [
        { ...validCommand, name: "cache clear", description: "Clear local cache entries.", aliases: ["cc"] },
        validCommand
      ]
    });

    assert.deepEqual(listTopics(registry).map((topic) => topic.name), ["cache", "release"]);
    assert.deepEqual(listCommands(registry).map((command) => command.name), ["cache clear", "cache inspect"]);
  });

  it("creates deterministic registry output from a definition list", () => {
    const registry = createCommandRegistry([
      { ...validCommand, name: "cache clear", description: "Clear local cache entries.", aliases: ["cc"] },
      validTopic,
      validCommand
    ]);

    assert.deepEqual(registry.topics.map((topic) => topic.name), ["cache"]);
    assert.deepEqual(registry.commands.map((command) => command.name), ["cache clear", "cache inspect"]);
  });

  it("finds commands and topics by exact name or explicit alias only", () => {
    const registry = createCommandRegistry({
      topics: [{ ...validTopic, aliases: ["c"] }],
      commands: [validCommand]
    });

    assert.equal(findCommand(registry, "cache inspect")?.name, "cache inspect");
    assert.equal(findCommand(registry, "ci")?.name, "cache inspect");
    assert.equal(findCommand(registry, "cache"), undefined);
    assert.equal(findTopic(registry, "cache")?.name, "cache");
    assert.equal(findTopic(registry, "c")?.name, "cache");
    assert.equal(findTopic(registry, "ca"), undefined);
  });

  it("validates the product-neutral fixture metadata", () => {
    assert.doesNotThrow(() => validateCommandRegistry(fixtureMetadata));
    assert.equal(findCommand(fixtureMetadata, "cc")?.name, "cache clear");
    assert.deepEqual(listCommands(fixtureMetadata).map((command) => command.name), ["cache clear", "cache explode", "cache inspect", "cache validate"]);
  });

  it("reports duplicate command names and aliases with deterministic context", () => {
    assert.throws(
      () =>
        createCommandRegistry({
          topics: [{ ...validTopic, aliases: ["ci"] }],
          commands: [
            validCommand,
            { ...validCommand, aliases: ["ci"] }
          ]
        }),
      (error) => {
        assert.ok(error instanceof CommandRegistryValidationError);
        assert.match(error.message, /commands\[1\]\.name: Duplicate command name "cache inspect"/);
        assert.match(error.message, /commands\[0\]\.aliases\[0\]: Duplicate alias "ci"; first defined at topics\[0\]\.aliases\[0\]/);
        assert.match(error.message, /commands\[1\]\.aliases\[0\]: Duplicate alias "ci"; first defined at topics\[0\]\.aliases\[0\]/);
        return true;
      }
    );
  });

  it("reports flag aliases that conflict with later flag names", () => {
    assert.throws(
      () =>
        createCommandRegistry({
          commands: [
            {
              ...validCommand,
              flags: [
                {
                  name: "json",
                  description: "Render machine-readable JSON output.",
                  type: "boolean",
                  aliases: ["format"]
                },
                {
                  name: "format",
                  description: "Select an output format.",
                  type: "option",
                  options: ["human", "json"]
                }
              ]
            }
          ]
        }),
      /commands\[0\]\.flags\[0\]\.aliases\[0\]: Alias "format" conflicts with commands\[0\]\.flags\[1\]\.name/
    );
  });

  it("reports missing descriptions, undocumented flags, unsupported flag types, and missing examples", () => {
    assert.throws(
      () =>
        createCommandRegistry({
          commands: [
            {
              kind: "command",
              name: "cache inspect",
              description: "",
              flags: [
                {
                  name: "format",
                  description: "",
                  type: "unsupported"
                }
              ],
              examples: []
            }
          ]
        }),
      (error) => {
        assert.ok(error instanceof CommandRegistryValidationError);
        assert.match(error.message, /commands\[0\]\.description: Value must not be empty/);
        assert.match(error.message, /commands\[0\]\.flags\[0\]\.description: Value must not be empty/);
        assert.match(error.message, /commands\[0\]\.flags\[0\]\.type: Unsupported flag type "unsupported"/);
        assert.match(error.message, /commands\[0\]\.examples: Command metadata must include at least one example/);
        return true;
      }
    );
  });

  it("reports blank identifiers during registry validation", () => {
    assert.throws(
      () =>
        createCommandRegistry({
          topics: [
            {
              kind: "topic",
              name: " ",
              description: "Topic with a blank name."
            }
          ],
          commands: [
            {
              ...validCommand,
              aliases: [" "],
              flags: [
                {
                  name: " ",
                  description: "Flag with a blank name.",
                  type: "boolean"
                }
              ]
            }
          ]
        }),
      (error) => {
        assert.ok(error instanceof CommandRegistryValidationError);
        assert.match(error.message, /topics\[0\]\.name: Empty topic name is not allowed/);
        assert.match(error.message, /commands\[0\]\.aliases\[0\]: Empty alias is not allowed/);
        assert.match(error.message, /commands\[0\]\.flags\[0\]\.name: Empty flag name is not allowed/);
        return true;
      }
    );
  });

  it("reports malformed runtime identifiers without crashing validation", () => {
    assert.throws(
      () =>
        createCommandRegistry({
          commands: [
            {
              ...validCommand,
              name: 123,
              flags: [
                {
                  name: 456,
                  description: "Flag with a malformed runtime name.",
                  type: "boolean"
                }
              ]
            }
          ]
        }),
      (error) => {
        assert.ok(error instanceof CommandRegistryValidationError);
        assert.match(error.message, /commands\[0\]\.name: command name must be a string/);
        assert.match(error.message, /commands\[0\]\.flags\[0\]\.name: flag name must be a string/);
        return true;
      }
    );
  });

  it("reports inconsistent mutation metadata", () => {
    assert.throws(
      () =>
        createCommandRegistry({
          commands: [
            {
              ...validCommand,
              mutation: {
                categories: ["local-files"]
              }
            }
          ]
        }),
      /commands\[0\]\.interactions\.dryRun: Mutating commands must declare dry-run support/
    );
  });

  it("reports default output formats that are not listed", () => {
    assert.throws(
      () =>
        createCommandRegistry({
          commands: [
            {
              ...validCommand,
              output: {
                formats: ["json"],
                defaultFormat: "human"
              }
            }
          ]
        }),
      /commands\[0\]\.output\.defaultFormat: Default output format must be listed in output\.formats/
    );
  });

  it("reports missing descriptions for services, errors, and exit codes", () => {
    assert.throws(
      () =>
        createCommandRegistry({
          commands: [
            {
              ...validCommand,
              externalServices: [{ name: "cache", description: "" }],
              errors: [{ kind: "cache-failed", description: "" }],
              exitCodes: [{ code: 2, category: "validation", description: "" }]
            }
          ]
        }),
      (error) => {
        assert.ok(error instanceof CommandRegistryValidationError);
        assert.match(error.message, /commands\[0\]\.externalServices\[0\]\.description: Value must not be empty/);
        assert.match(error.message, /commands\[0\]\.errors\[0\]\.description: Value must not be empty/);
        assert.match(error.message, /commands\[0\]\.exitCodes\[0\]\.description: Value must not be empty/);
        return true;
      }
    );
  });
});
