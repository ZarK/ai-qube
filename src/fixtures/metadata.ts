import { defineArgument, defineCommand, defineExample, defineExtensions, defineFlag, defineTopic } from "../metadata/index.js";
import { createCommandRegistry } from "../registry/index.js";

const fixtureExtensions = defineExtensions({
  fixture: true,
  owner: "toolkit-tests"
});

export const cacheTopic = defineTopic({
  kind: "topic",
  name: "cache",
  description: "Commands for inspecting and maintaining a local cache.",
  extensions: fixtureExtensions
});

export const cacheInspectCommand = defineCommand({
  kind: "command",
  name: "cache inspect",
  description: "Inspect cache entries without changing local state.",
  arguments: [
    defineArgument({
      name: "key",
      description: "Cache key to inspect.",
      required: false
    })
  ],
  flags: [
    defineFlag({
      name: "json",
      description: "Render machine-readable JSON output.",
      type: "boolean"
    }),
    defineFlag({
      name: "output",
      description: "Select the output format.",
      type: "option",
      options: ["human", "json"]
    })
  ],
  examples: [
    defineExample({
      description: "Inspect all cache entries.",
      command: "fixture cache inspect"
    })
  ],
  output: {
    formats: ["human", "json"],
    defaultFormat: "human"
  },
  interactions: {
    json: true,
    noColor: true,
    nonInteractive: true,
    ttyPrompt: false
  },
  externalServices: [],
  errors: [
    {
      kind: "cache-read-failed",
      description: "The cache could not be read.",
      exitCode: 2
    }
  ],
  exitCodes: [
    {
      code: 0,
      category: "success",
      description: "The command completed successfully."
    },
    {
      code: 2,
      category: "validation",
      description: "The cache key or cache state was invalid."
    }
  ],
  extensions: fixtureExtensions
});

export const cacheClearCommand = defineCommand({
  kind: "command",
  name: "cache clear",
  description: "Clear cache entries after showing the planned local file changes.",
  aliases: ["cc"],
  flags: [
    defineFlag({
      name: "dry-run",
      description: "Show cache entries that would be removed without deleting them.",
      type: "boolean"
    }),
    defineFlag({
      name: "yes",
      description: "Run without interactive confirmation.",
      type: "boolean"
    })
  ],
  examples: [
    defineExample({
      description: "Preview cache cleanup.",
      command: "fixture cache clear --dry-run"
    })
  ],
  output: {
    formats: ["human", "json"],
    defaultFormat: "human"
  },
  interactions: {
    json: true,
    dryRun: {
      supported: true
    },
    noColor: true,
    nonInteractive: true,
    ttyPrompt: true
  },
  mutation: {
    categories: ["local-files"]
  },
  exitCodes: [
    {
      code: 0,
      category: "success",
      description: "The command completed successfully."
    },
    {
      code: 5,
      category: "safety",
      description: "The command was blocked by a safety policy."
    }
  ],
  extensions: fixtureExtensions
});

export const fixtureMetadata = createCommandRegistry({
  topics: [cacheTopic],
  commands: [cacheInspectCommand, cacheClearCommand]
});
