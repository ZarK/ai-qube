import { defineArgument, defineCommand, defineExample, defineFlag, defineTopic } from "@tjalve/cube-cli/metadata";
import { createCommandRegistry } from "@tjalve/cube-cli/registry";

export const catalogTopic = defineTopic({
  kind: "topic",
  name: "catalog",
  description: "Read-only catalog inspection commands."
});

export const catalogInspectCommand = defineCommand({
  kind: "command",
  name: "catalog inspect",
  description: "Inspect a catalog item without changing consumer state.",
  arguments: [
    defineArgument({
      name: "id",
      description: "Catalog item identifier to inspect.",
      required: true
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
      defaultValue: "human"
    })
  ],
  examples: [
    defineExample({
      description: "Inspect a catalog item as JSON.",
      command: "consumer catalog inspect alpha --json"
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
      kind: "catalog-item-not-found",
      description: "The requested catalog item was not found.",
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
      description: "The catalog item identifier was invalid or unknown."
    }
  ]
});

export const consumerRegistry = createCommandRegistry({
  topics: [catalogTopic],
  commands: [catalogInspectCommand]
});
