import {
  type CliPackageSchema,
  type CommandMetadata,
  type ExitCodeMetadata,
  type FlagMetadata,
  type RenderSchemaOptions,
  createCommandRegistry,
  renderSchema,
  renderSchemaJson,
} from "@tjalve/qube-cli";

export const aiqSchemaVersion = 1 as const;
export const aiqPackageName = "@tjalve/aiq" as const;
export const aiqPackageVersion = "0.2.0" as const;
export const aiqSchemaBin = "aiq" as const;

const stageSelectionFlags = [
  {
    name: "up-to",
    description: "Run every ladder stage from 0 through the provided stage index.",
    type: "integer",
  },
  {
    name: "only",
    description: "Run one numeric ladder stage.",
    type: "integer",
  },
  {
    name: "stage",
    description: "Run one named stage.",
    type: "string",
  },
  {
    name: "profile",
    description: "Select the configured AIQ profile.",
    type: "option",
    options: ["fast", "standard", "deep"],
  },
] as const satisfies readonly FlagMetadata[];

const manifestFlags = [
  {
    name: "files",
    description: "Add explicit input files or paths to the run manifest.",
    type: "string",
    multiple: true,
  },
  {
    name: "files-from",
    description: "Read newline-delimited input files from a path.",
    type: "string",
  },
  {
    name: "stdin-file-list",
    description: "Read newline-delimited input files from standard input.",
    type: "boolean",
  },
] as const satisfies readonly FlagMetadata[];

const outputFlags = [
  {
    name: "format",
    description: "Select text or JSON output.",
    type: "option",
    options: ["text", "json"],
    defaultValue: "text",
  },
] as const satisfies readonly FlagMetadata[];

const commonExitCodes = [
  {
    code: 0,
    category: "success",
    description: "The command completed successfully.",
  },
  {
    code: 1,
    category: "validation",
    description: "The quality run completed and reported quality failures.",
  },
  {
    code: 2,
    category: "usage",
    description: "The command line, configuration, or selected project inputs were invalid.",
  },
  {
    code: 3,
    category: "unexpected",
    description: "AIQ hit an internal or host runtime error.",
  },
] as const satisfies readonly ExitCodeMetadata[];

export const aiqCommandMetadata = [
  {
    kind: "command",
    name: "run",
    description: "Run AIQ quality stages for explicit files or paths.",
    aliases: ["check"],
    arguments: [
      {
        name: "files",
        description: "Input files or paths to check.",
        required: true,
        multiple: true,
      },
    ],
    flags: [
      ...manifestFlags,
      ...stageSelectionFlags,
      ...outputFlags,
      {
        name: "diff-only",
        description: "Scope diff-safe stages to the supplied changed-file manifest.",
        type: "boolean",
      },
      {
        name: "dry-run",
        description: "Render the resolved plan without executing tools or writing artifacts.",
        type: "boolean",
      },
      {
        name: "out-dir",
        description: "Override the AIQ artifact output directory.",
        type: "string",
      },
      {
        name: "verbose",
        short: "v",
        description: "Include command and tool details in text output.",
        type: "boolean",
      },
    ],
    examples: [
      {
        command: "aiq run src --up-to 3",
        description: "Run cumulative stages through typecheck for the src path.",
      },
      {
        command: "aiq run src/index.ts --only 1 --format json",
        description: "Run one lint stage and emit JSON.",
      },
    ],
    output: { formats: ["text", "json"], defaultFormat: "text" },
    interactions: {
      json: true,
      dryRun: { supported: true },
      noColor: false,
      nonInteractive: true,
      ttyPrompt: false,
    },
    mutation: { categories: ["local-files"] },
    supplyChain: {
      sensitive: true,
      kinds: ["package-manager", "dependency"],
      reason: "AIQ run may execute project quality tools selected by the repository configuration.",
    },
    exitCodes: commonExitCodes,
    extensions: {
      aiq: {
        capability: "quality-control",
        contexts: ["cli", "qube"],
        targetMode: "explicit-paths",
      },
    },
  },
  {
    kind: "command",
    name: "plan",
    description: "Resolve the AIQ run plan without executing quality tools.",
    arguments: [
      {
        name: "files",
        description: "Input files or paths to include in the plan.",
        required: true,
        multiple: true,
      },
    ],
    flags: [
      ...manifestFlags,
      ...stageSelectionFlags,
      ...outputFlags,
      {
        name: "out-dir",
        description: "Override the AIQ artifact output directory.",
        type: "string",
      },
    ],
    examples: [
      {
        command: "aiq plan src --format json",
        description: "Render a machine-readable AIQ plan for src.",
      },
    ],
    output: { formats: ["text", "json"], defaultFormat: "text" },
    interactions: { json: true, noColor: false, nonInteractive: true, ttyPrompt: false },
    exitCodes: commonExitCodes,
    extensions: { aiq: { capability: "quality-plan", contexts: ["cli", "qube"] } },
  },
  {
    kind: "command",
    name: "doctor",
    description:
      "Inspect AIQ config, progress state, detected technologies, and tool prerequisites.",
    flags: [
      ...stageSelectionFlags,
      ...outputFlags,
      {
        name: "verbose",
        short: "v",
        description: "Include resolved binary paths and versions.",
        type: "boolean",
      },
    ],
    examples: [
      {
        command: "aiq doctor --format json",
        description: "Render machine-readable setup diagnostics.",
      },
    ],
    output: { formats: ["text", "json"], defaultFormat: "text" },
    interactions: { json: true, noColor: false, nonInteractive: true, ttyPrompt: false },
    exitCodes: commonExitCodes,
    extensions: { aiq: { capability: "quality-diagnostics", contexts: ["cli", "qube"] } },
  },
  {
    kind: "command",
    name: "setup",
    description:
      "Render agent-facing setup guidance for selected AIQ stages without installing tools.",
    flags: [
      ...stageSelectionFlags,
      ...outputFlags,
      {
        name: "verbose",
        short: "v",
        description: "Include resolved binary paths and versions.",
        type: "boolean",
      },
    ],
    examples: [
      {
        command: "aiq setup --format json",
        description: "Render machine-readable missing prerequisites and recommended actions.",
      },
    ],
    output: { formats: ["text", "json"], defaultFormat: "text" },
    interactions: { json: true, noColor: false, nonInteractive: true, ttyPrompt: false },
    exitCodes: commonExitCodes,
    extensions: { aiq: { capability: "quality-setup", contexts: ["cli", "qube"] } },
  },
  {
    kind: "command",
    name: "status",
    description: "Show current AIQ stage, default run range, last run status, and next command.",
    flags: outputFlags,
    examples: [
      {
        command: "aiq status --format json",
        description: "Render machine-readable AIQ workflow status.",
      },
    ],
    output: { formats: ["text", "json"], defaultFormat: "text" },
    interactions: { json: true, noColor: false, nonInteractive: true, ttyPrompt: false },
    exitCodes: commonExitCodes,
    extensions: { aiq: { capability: "quality-status", contexts: ["cli", "qube"] } },
  },
  {
    kind: "command",
    name: "config",
    description: "Print effective AIQ configuration or persist the current quality stage.",
    flags: [
      ...outputFlags,
      {
        name: "print-config",
        description: "Print effective config and progress state.",
        type: "boolean",
      },
      {
        name: "set-stage",
        description: "Persist the current AIQ stage index.",
        type: "integer",
      },
    ],
    examples: [
      {
        command: "aiq config --print-config --format json",
        description: "Render machine-readable effective config.",
      },
      {
        command: "aiq config --set-stage 3",
        description: "Set the default current stage to typecheck.",
      },
    ],
    output: { formats: ["text", "json"], defaultFormat: "text" },
    interactions: {
      json: true,
      dryRun: {
        supported: false,
        reason: "Stage updates intentionally persist .aiq/progress.json.",
      },
      noColor: false,
      nonInteractive: true,
      ttyPrompt: false,
    },
    mutation: { categories: ["local-config"] },
    exitCodes: commonExitCodes,
    extensions: { aiq: { capability: "quality-config", contexts: ["cli", "qube"] } },
  },
  {
    kind: "command",
    name: "evidence",
    description: "Emit structured AIQ quality evidence for AIE gates and AIU trusted state.",
    flags: [
      {
        name: "format",
        description: "Select evidence output format.",
        type: "option",
        options: ["json"],
        defaultValue: "json",
      },
    ],
    examples: [
      {
        command: "aiq evidence --format json",
        description: "Render local AIQ quality evidence as JSON.",
      },
    ],
    output: { formats: ["json"], defaultFormat: "json" },
    interactions: { json: true, noColor: true, nonInteractive: true, ttyPrompt: false },
    exitCodes: [
      {
        code: 0,
        category: "success",
        description:
          "Evidence was rendered successfully; inspect the structured result for pass/fail/missing/stale quality state.",
      },
      {
        code: 2,
        category: "usage",
        description: "The command line or local evidence query failed.",
      },
    ],
    extensions: { aiq: { capability: "quality-evidence", contexts: ["cli", "qube"] } },
  },
  {
    kind: "command",
    name: "schema",
    description: "Render the QUBE-compatible AIQ command and capability schema.",
    flags: [
      {
        name: "format",
        description: "Select schema output format.",
        type: "option",
        options: ["json"],
        defaultValue: "json",
      },
    ],
    examples: [
      {
        command: "aiq schema --format json",
        description: "Render QUBE-compatible AIQ command metadata.",
      },
    ],
    output: { formats: ["json"], defaultFormat: "json" },
    interactions: { json: true, noColor: true, nonInteractive: true, ttyPrompt: false },
    exitCodes: [
      {
        code: 0,
        category: "success",
        description: "The schema was rendered successfully.",
      },
      {
        code: 2,
        category: "usage",
        description: "The command line was invalid.",
      },
    ],
    extensions: { aiq: { capability: "quality-schema", contexts: ["cli", "qube"] } },
  },
] as const satisfies readonly CommandMetadata[];

export const aiqCommandRegistry = createCommandRegistry({ commands: aiqCommandMetadata });

const aiqSchemaOptions = {
  packageName: aiqPackageName,
  packageVersion: aiqPackageVersion,
  bin: aiqSchemaBin,
  sections: {
    capabilities: [
      "quality-control",
      "quality-plan",
      "quality-diagnostics",
      "quality-setup",
      "quality-status",
      "quality-evidence",
    ],
    discovery: {
      command: "aiq schema --format json",
      packageExport: "@tjalve/aiq/schema",
    },
  },
  extensions: {
    aiq: {
      defaultCommand: "aiq",
      explicitTargetCommand: "aiq run <paths...>",
      schemaVersion: aiqSchemaVersion,
      packageExport: "@tjalve/aiq/schema",
    },
    qube: {
      discoverable: true,
      commandPrefix: "quality",
    },
  },
} as const satisfies RenderSchemaOptions;

export function renderAiqCommandSchema(): CliPackageSchema {
  return renderSchema(aiqCommandRegistry, aiqSchemaOptions);
}

export function renderAiqCommandSchemaJson(): string {
  return renderSchemaJson(aiqCommandRegistry, aiqSchemaOptions);
}
