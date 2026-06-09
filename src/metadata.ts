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
    }),
    defineFlag({
      name: "agent",
      description: "Agent host that will operate aib.",
      type: "option",
      options: ["codex", "opencode", "claude-code", "gemini", "other"]
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
      description: "Init was blocked by local-file safety policy.",
      exitCode: 5
    },
    {
      kind: "init-config-invalid",
      description: "The provided bootstrap config could not be read or validated.",
      exitCode: 3
    },
    {
      kind: "init-write-failed",
      description: "The bootstrap state file could not be written.",
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

const stateCommandErrors = [
  {
    kind: "state-invalid",
    description: "The bootstrap state file could not be read or validated.",
    exitCode: 3
  }
];

const stateCommandExitCodes = [
  {
    code: 0,
    category: "success",
    description: "The command completed successfully."
  },
  {
    code: 3,
    category: "validation",
    description: "The state file was missing or invalid."
  }
];

export const statusCommand = defineCommand({
  kind: "command",
  name: "status",
  description: "Read bootstrap state and report current phase, missing decisions, artifact paths, and next command.",
  flags: [
    defineFlag({
      name: "json",
      description: "Render machine-readable JSON output.",
      short: "j",
      type: "boolean"
    }),
    defineFlag({
      name: "state",
      description: "Path to the bootstrap session JSON file.",
      type: "string",
      defaultValue: ".bootstrap/session.json"
    })
  ],
  examples: [
    defineExample({
      description: "Inspect current bootstrap status.",
      command: "aib status --json"
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
  errors: stateCommandErrors,
  exitCodes: stateCommandExitCodes
});

export const nextCommand = defineCommand({
  kind: "command",
  name: "next",
  description: "Return the next deterministic agent action for the current bootstrap state.",
  flags: [
    defineFlag({
      name: "json",
      description: "Render machine-readable JSON output.",
      short: "j",
      type: "boolean"
    }),
    defineFlag({
      name: "state",
      description: "Path to the bootstrap session JSON file.",
      type: "string",
      defaultValue: ".bootstrap/session.json"
    })
  ],
  examples: [
    defineExample({
      description: "Get the next agent action.",
      command: "aib next --json"
    })
  ],
  output: {
    formats: ["human", "json"],
    defaultFormat: "json"
  },
  interactions: {
    json: true,
    noColor: true,
    nonInteractive: true,
    ttyPrompt: false
  },
  errors: stateCommandErrors,
  exitCodes: stateCommandExitCodes
});

export const answerCommand = defineCommand({
  kind: "command",
  name: "answer",
  description: "Record a human answer into bootstrap state so planning can resume without transcript memory.",
  flags: [
    defineFlag({
      name: "json",
      description: "Render machine-readable JSON output.",
      short: "j",
      type: "boolean"
    }),
    defineFlag({
      name: "state",
      description: "Path to the bootstrap session JSON file.",
      type: "string",
      defaultValue: ".bootstrap/session.json"
    }),
    defineFlag({
      name: "dry-run",
      description: "Preview the state update without writing the session file.",
      type: "boolean"
    }),
    defineFlag({
      name: "field",
      description: "State field answered by the human or recorded by the agent, such as project.audience or spec.acceptedSectionIds.",
      type: "string",
      required: true
    }),
    defineFlag({
      name: "value",
      description: "Answer text to record.",
      type: "string",
      required: true
    }),
    defineFlag({
      name: "assumption",
      description: "Record the answer as an explicit assumption.",
      type: "boolean"
    })
  ],
  examples: [
    defineExample({
      description: "Record who the project is for.",
      command: "aib answer --field project.audience --value \"Solo developers\" --json"
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
    categories: mutationCategories("local-files")
  }),
  supplyChain: {
    sensitive: false
  },
  errors: [
    ...stateCommandErrors,
    {
      kind: "answer-field-invalid",
      description: "The answer field is not a supported discovery field.",
      exitCode: 3
    },
    {
      kind: "answer-value-invalid",
      description: "The answer value was empty or invalid.",
      exitCode: 3
    },
    {
      kind: "answer-transition-invalid",
      description: "The current bootstrap phase does not allow answer mutations.",
      exitCode: 3
    }
  ],
  exitCodes: stateCommandExitCodes
});

export const bootstrapRegistry = createCommandRegistry({
  topics: [planningTopic],
  commands: [initCommand, statusCommand, nextCommand, answerCommand]
});
