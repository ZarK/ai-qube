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
      defaultValue: ".qube/aib/session.json"
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
      defaultValue: ".qube/aib/session.json"
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

export const specDraftCommand = defineCommand({
  kind: "command",
  name: "spec draft",
  description: "Draft docs/spec.md from recorded discovery state and move into section-aware spec acceptance.",
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
      defaultValue: ".qube/aib/session.json"
    }),
    defineFlag({
      name: "dry-run",
      description: "Preview the spec draft without writing docs/spec.md or the session file.",
      type: "boolean"
    })
  ],
  examples: [
    defineExample({
      description: "Draft the spec artifact from current state.",
      command: "aib spec draft --json"
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
  errors: stateCommandErrors,
  exitCodes: stateCommandExitCodes
});

export const specValidateCommand = defineCommand({
  kind: "command",
  name: "spec validate",
  description: "Validate the spec artifact for required sections and placeholder content.",
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
      defaultValue: ".qube/aib/session.json"
    }),
    defineFlag({
      name: "dry-run",
      description: "Preview validation without updating the session file.",
      type: "boolean"
    })
  ],
  examples: [
    defineExample({
      description: "Validate the current spec artifact.",
      command: "aib spec validate --json"
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
  errors: stateCommandErrors,
  exitCodes: stateCommandExitCodes
});

export const specAcceptCommand = defineCommand({
  kind: "command",
  name: "spec accept",
  description: "Accept one required spec section or all required sections after validation.",
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
      defaultValue: ".qube/aib/session.json"
    }),
    defineFlag({
      name: "dry-run",
      description: "Preview acceptance without updating the session file.",
      type: "boolean"
    }),
    defineFlag({
      name: "section",
      description: "Spec section id to accept, or all for every required section.",
      type: "string",
      required: true
    })
  ],
  examples: [
    defineExample({
      description: "Accept a reviewed spec section.",
      command: "aib spec accept --section purpose --json"
    }),
    defineExample({
      description: "Accept all required sections after review.",
      command: "aib spec accept --section all --json"
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
      kind: "spec-section-invalid",
      description: "The requested spec section id is not selected for this project.",
      exitCode: 3
    },
    {
      kind: "spec-validation-failed",
      description: "The spec artifact is missing required sections or contains placeholder content.",
      exitCode: 3
    }
  ],
  exitCodes: stateCommandExitCodes
});

export const specReopenCommand = defineCommand({
  kind: "command",
  name: "spec reopen",
  description: "Explicitly reopen an accepted spec section for revision.",
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
      defaultValue: ".qube/aib/session.json"
    }),
    defineFlag({
      name: "dry-run",
      description: "Preview reopening without updating the session file.",
      type: "boolean"
    }),
    defineFlag({
      name: "section",
      description: "Spec section id to reopen.",
      type: "string",
      required: true
    })
  ],
  examples: [
    defineExample({
      description: "Reopen an accepted section for revision.",
      command: "aib spec reopen --section purpose --json"
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
      kind: "spec-section-invalid",
      description: "The requested spec section id is not selected for this project.",
      exitCode: 3
    }
  ],
  exitCodes: stateCommandExitCodes
});

export const milestonesGenerateCommand = defineCommand({
  kind: "command",
  name: "milestones generate",
  description: "Generate milestone planning docs from an accepted spec before work-item drafting.",
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
      defaultValue: ".qube/aib/session.json"
    }),
    defineFlag({
      name: "dry-run",
      description: "Preview milestone plans without writing docs or updating the session file.",
      type: "boolean"
    })
  ],
  examples: [
    defineExample({
      description: "Check whether milestone generation is allowed.",
      command: "aib milestones generate --json"
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
      kind: "spec-not-accepted",
      description: "Milestone generation is blocked until all required spec sections are accepted.",
      exitCode: 3
    }
  ],
  exitCodes: stateCommandExitCodes
});

export const workItemsGenerateCommand = defineCommand({
  kind: "command",
  name: "work-items generate",
  description: "Guard work-item generation until at least one milestone doc exists.",
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
      defaultValue: ".qube/aib/session.json"
    }),
    defineFlag({
      name: "dry-run",
      description: "Preview work-item drafts without writing docs or updating the session file.",
      type: "boolean"
    }),
    defineFlag({
      name: "milestone",
      description: "Milestone id or path to use for work-item drafting.",
      type: "string"
    })
  ],
  examples: [
    defineExample({
      description: "Check whether work-item generation is allowed.",
      command: "aib work-items generate --json"
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
      kind: "spec-not-accepted",
      description: "Work item generation is blocked until all required spec sections are accepted.",
      exitCode: 3
    },
    {
      kind: "milestone-required",
      description: "Work item generation is blocked until at least one milestone doc exists.",
      exitCode: 3
    },
    {
      kind: "work-item-order-invalid",
      description: "Generated work-item sequence metadata conflicts with blocker ordering.",
      exitCode: 3
    },
    {
      kind: "work-item-write-failed",
      description: "The work-item draft artifacts could not be written.",
      exitCode: 3
    }
  ],
  exitCodes: stateCommandExitCodes
});

export const workItemsRenderCommand = defineCommand({
  kind: "command",
  name: "work-items render",
  description: "Render recorded provider-neutral work item drafts to GitHub previews or markdown files.",
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
      defaultValue: ".qube/aib/session.json"
    }),
    defineFlag({
      name: "provider",
      description: "Work item render target.",
      type: "option",
      options: ["github", "markdown"],
      required: true
    }),
    defineFlag({
      name: "dry-run",
      description: "Preview rendered work items without provider mutation or file writes.",
      type: "boolean"
    }),
    defineFlag({
      name: "output-dir",
      description: "Markdown output directory, relative to the project root.",
      type: "string"
    })
  ],
  examples: [
    defineExample({
      description: "Preview GitHub issues from recorded work item drafts.",
      command: "aib work-items render --provider github --dry-run --json"
    }),
    defineExample({
      description: "Write markdown work item drafts without network access.",
      command: "aib work-items render --provider markdown --json"
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
      kind: "work-items-required",
      description: "Work item rendering is blocked until provider-neutral drafts exist in planning state.",
      exitCode: 3
    },
    {
      kind: "work-item-order-invalid",
      description: "Generated work-item sequence metadata conflicts with blocker ordering.",
      exitCode: 3
    },
    {
      kind: "provider-mutation-unsupported",
      description: "The selected provider cannot be mutated by this command yet.",
      exitCode: 5
    },
    {
      kind: "work-item-render-failed",
      description: "The work-item drafts could not be rendered or written.",
      exitCode: 3
    }
  ],
  exitCodes: [
    ...stateCommandExitCodes,
    {
      code: 5,
      category: "safety",
      description: "The command refused unsupported provider mutation."
    }
  ]
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
      defaultValue: ".qube/aib/session.json"
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
  commands: [
    initCommand,
    statusCommand,
    nextCommand,
    answerCommand,
    specDraftCommand,
    specValidateCommand,
    specAcceptCommand,
    specReopenCommand,
    milestonesGenerateCommand,
    workItemsGenerateCommand,
    workItemsRenderCommand
  ]
});
