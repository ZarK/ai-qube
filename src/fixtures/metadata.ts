import { defineArgument, defineCommand, defineExample, defineExtensions, defineFlag, defineTopic } from "../metadata/index.js";
import { defineMutationMetadata, dryRunSupported, mutationCategories } from "../mutation/index.js";
import { createCommandRegistry } from "../registry/index.js";

const fixtureExtensions = defineExtensions({
  fixture: true,
  owner: "toolkit-tests",
  nested: {
    beta: 2,
    alpha: 1
  }
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
      required: false,
      extensions: defineExtensions({
        fixtureRole: "lookup-key"
      })
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
      options: ["human", "json"],
      defaultValue: "human",
      extensions: defineExtensions({
        fixtureRole: "format-selector"
      })
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
    dryRun: dryRunSupported(),
    noColor: true,
    nonInteractive: true,
    ttyPrompt: true
  },
  mutation: defineMutationMetadata({
    categories: mutationCategories("local-files"),
    extensions: defineExtensions({
      fixtureMutation: "cache-cleanup"
    })
  }),
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

export const cacheInstallCommand = defineCommand({
  kind: "command",
  name: "cache install",
  description: "Prepare dependency cache entries after showing supply-chain-sensitive checks.",
  flags: [
    defineFlag({
      name: "dry-run",
      description: "Show dependency cache changes without writing fixture state.",
      type: "boolean"
    }),
    defineFlag({
      name: "json",
      description: "Render machine-readable JSON output.",
      type: "boolean"
    })
  ],
  examples: [
    defineExample({
      description: "Preview dependency cache preparation.",
      command: "fixture cache install --dry-run"
    })
  ],
  output: {
    formats: ["human", "json"],
    defaultFormat: "human"
  },
  interactions: {
    json: true,
    dryRun: dryRunSupported(),
    noColor: true,
    nonInteractive: true,
    ttyPrompt: false
  },
  mutation: defineMutationMetadata({
    categories: mutationCategories("dependency", "local-files"),
    extensions: defineExtensions({
      fixtureMutation: "dependency-cache"
    })
  }),
  supplyChain: {
    sensitive: true,
    kinds: ["dependency", "package-manager"],
    reason: "Dependency cache preparation depends on package-manager metadata supplied by the consuming package.",
    extensions: defineExtensions({
      fixtureSupplyChain: "dependency-cache"
    })
  },
  errors: [
    {
      kind: "supply-chain-blocked",
      description: "The dependency cache operation was blocked for supply-chain review.",
      exitCode: 5
    }
  ],
  exitCodes: [
    {
      code: 0,
      category: "success",
      description: "The command completed successfully."
    },
    {
      code: 5,
      category: "safety",
      description: "The command was blocked by supply-chain safety guidance."
    }
  ],
  extensions: fixtureExtensions
});

export const cacheValidateCommand = defineCommand({
  kind: "command",
  name: "cache validate",
  description: "Validate cache configuration and report actionable failures.",
  flags: [
    defineFlag({
      name: "json",
      description: "Render machine-readable JSON output.",
      type: "boolean"
    })
  ],
  examples: [
    defineExample({
      description: "Validate cache configuration.",
      command: "fixture cache validate --json"
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
  errors: [
    {
      kind: "cache-config-invalid",
      description: "The cache configuration failed validation.",
      exitCode: 3
    }
  ],
  exitCodes: [
    {
      code: 0,
      category: "success",
      description: "The command completed successfully."
    },
    {
      code: 3,
      category: "validation",
      description: "The cache configuration was invalid."
    }
  ],
  extensions: fixtureExtensions
});

export const cacheExplodeCommand = defineCommand({
  kind: "command",
  name: "cache explode",
  description: "Raise an unexpected fixture failure for runtime error tests.",
  flags: [
    defineFlag({
      name: "json",
      description: "Render machine-readable JSON output.",
      type: "boolean"
    })
  ],
  examples: [
    defineExample({
      description: "Raise an unexpected fixture failure.",
      command: "fixture cache explode --json"
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
  errors: [
    {
      kind: "unexpected-error",
      description: "The command failed unexpectedly.",
      exitCode: 70
    }
  ],
  exitCodes: [
    {
      code: 70,
      category: "unexpected",
      description: "The command failed unexpectedly."
    }
  ],
  extensions: fixtureExtensions
});

export const fixtureMetadata = createCommandRegistry({
  topics: [cacheTopic],
  commands: [cacheInspectCommand, cacheClearCommand, cacheInstallCommand, cacheValidateCommand, cacheExplodeCommand]
});
