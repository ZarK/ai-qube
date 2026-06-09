import { defineArgument, defineCommand, defineExample, defineFlag, defineTopic } from "@tjalve/qube-cli/metadata";
import { defineMutationMetadata, dryRunSupported, mutationCategories } from "@tjalve/qube-cli/mutation";
import { createCommandRegistry } from "@tjalve/qube-cli/registry";

export const planningTopic = defineTopic({
  kind: "topic",
  name: "planning",
  description: "Agent-facing bootstrap planning commands."
});

export const initCommand = defineCommand({
  kind: "command",
  name: "init",
  description: "Preview creation of a local agent-guided bootstrap planning workspace.",
  arguments: [
    defineArgument({
      name: "target",
      description: "Repository or project directory to bootstrap.",
      required: false,
      defaultValue: "."
    })
  ],
  flags: [
    defineFlag({
      name: "dry-run",
      description: "Show the bootstrap workspace changes without writing files.",
      type: "boolean"
    }),
    defineFlag({
      name: "json",
      description: "Render machine-readable JSON output.",
      short: "j",
      type: "boolean"
    }),
    defineFlag({
      name: "config",
      description: "Path to aib.config.json.",
      type: "string"
    }),
    defineFlag({
      name: "idea",
      description: "Short initial project idea to seed the spec discovery session.",
      type: "string"
    })
  ],
  examples: [
    defineExample({
      description: "Preview bootstrap planning files as JSON.",
      command: "aib init --dry-run --json"
    }),
    defineExample({
      description: "Preview bootstrap for a target repository.",
      command: "aib init ./my-project --dry-run"
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
    categories: mutationCategories("local-files", "local-config")
  }),
  supplyChain: {
    sensitive: false
  },
  errors: [
    {
      kind: "init-dry-run-required",
      description: "Init currently requires --dry-run so agents preview the bootstrap workspace before any mutation.",
      exitCode: 5
    },
    {
      kind: "init-config-invalid",
      description: "The provided bootstrap config could not be read or validated.",
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
      description: "The config file was missing or invalid."
    },
    {
      code: 5,
      category: "safety",
      description: "The command was blocked because dry-run was not requested."
    }
  ]
});

export const bootstrapRegistry = createCommandRegistry({
  topics: [planningTopic],
  commands: [initCommand]
});
