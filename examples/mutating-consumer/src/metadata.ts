import { defineArgument, defineCommand, defineExample, defineFlag, defineTopic } from "@tjalve/cube-cli/metadata";
import { defineMutationMetadata, dryRunSupported, mutationCategories } from "@tjalve/cube-cli/mutation";
import { createCommandRegistry } from "@tjalve/cube-cli/registry";

export const catalogTopic = defineTopic({
  kind: "topic",
  name: "catalog",
  description: "Catalog maintenance commands that own local consumer state."
});

export const catalogPruneCommand = defineCommand({
  kind: "command",
  name: "catalog prune",
  description: "Remove archived catalog items from the consumer-owned local state file.",
  arguments: [
    defineArgument({
      name: "state-file",
      description: "Path to the consumer-owned catalog state file.",
      required: false
    })
  ],
  flags: [
    defineFlag({
      name: "dry-run",
      description: "Show archived items that would be removed without writing state.",
      type: "boolean"
    }),
    defineFlag({
      name: "json",
      description: "Render machine-readable JSON output.",
      type: "boolean"
    }),
    defineFlag({
      name: "yes",
      description: "Apply the local-file mutation without interactive confirmation.",
      type: "boolean"
    })
  ],
  examples: [
    defineExample({
      description: "Preview archived catalog cleanup.",
      command: "mutating-consumer catalog prune --dry-run"
    }),
    defineExample({
      description: "Apply archived catalog cleanup after approval.",
      command: "mutating-consumer catalog prune --yes"
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
    categories: mutationCategories("local-files")
  }),
  errors: [
    {
      kind: "catalog-prune-approval-required",
      description: "Catalog pruning was blocked until the consumer approval policy is satisfied.",
      exitCode: 5
    },
    {
      kind: "catalog-state-invalid",
      description: "The catalog state file could not be read or validated.",
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
      description: "The catalog state file was missing or invalid."
    },
    {
      code: 5,
      category: "safety",
      description: "The command was blocked until explicit approval was provided."
    }
  ]
});

export const consumerRegistry = createCommandRegistry({
  topics: [catalogTopic],
  commands: [catalogPruneCommand]
});
