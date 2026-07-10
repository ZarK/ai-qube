import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, realpathSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineInstallerChoiceGroup, promptInstallerChoice, type InstallerChoice, type InstallerChoiceGroup } from "@tjalve/qube-cli/installer";
import { defineArgument, defineCommand, defineExtensions, defineFlag } from "@tjalve/qube-cli/metadata";
import { defineMutationMetadata, mutationCategories } from "@tjalve/qube-cli/mutation";
import { createCommandRegistry } from "@tjalve/qube-cli/registry";
import { createCli, createCommand as createRuntimeCommand, createSchemaCommand, runCli, type RuntimeCommandResult } from "@tjalve/qube-cli/runtime";
import { synthesizeAutoresearchArena } from "@tjalve/aib";
import type { AutoresearchArena, AutoresearchEvaluator, ConnectionContract } from "@tjalve/qube-core";

import { listClaudeCodeInstallFiles, listClaudeCodeInstallNotes } from "./claude_code_host.js";
import { formatConnectionDoctor, runConnectionDoctor } from "./connection_doctor.js";
import { listCodexInstallFiles, listCodexInstallNotes } from "./codex_host.js";
import { executorCiProviders, executorHostSurfaces, executorWorkProviders, findQubeComponent, qubeComponents, type QubeComponent, type QubeDiscoveryOption } from "./components.js";
import { listGrokBuildInstallFiles, listGrokBuildInstallNotes } from "./grok_build_host.js";
import { packageDescription, packageName, packageVersion } from "./package.js";

export interface CliExecution {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly dispatch?: DispatchRequest;
}

export interface DispatchRequest {
  readonly component: QubeComponent;
  readonly commandPath: string;
  readonly resolution: CommandResolution;
  readonly args: readonly string[];
}

export interface CliEnvironment {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly packageRoot?: string;
}

export interface CommandResolution {
  readonly commandPath: string;
  readonly source: "install" | "workspace" | "path";
  readonly packageJsonPath?: string;
  readonly packageVersion?: string;
  readonly error?: string;
  readonly warning?: string;
}

const passthroughExtensions = defineExtensions({ passthrough: true });
const targetedPassthroughExtensions = defineExtensions({ passthrough: { minArguments: 1 } });
const jsonFlag = defineFlag({
  name: "json",
  description: "Render machine-readable JSON output.",
  type: "boolean"
});
const dryRunFlag = defineFlag({
  name: "dry-run",
  description: "Print the plan without running mapped commands.",
  type: "boolean"
});
const yesFlag = defineFlag({
  name: "yes",
  short: "y",
  description: "Use safe defaults for non-interactive installer decisions.",
  type: "boolean"
});
const offlineFlag = defineFlag({
  name: "offline",
  description: "Skip provider network and CLI probes and report configured connections as unverified.",
  type: "boolean"
});

type InstallScope = "local" | "global";
type InstallPackageManager = "pnpm" | "npm";
type InstallHost = "generic" | "codex" | "opencode" | "claude-code" | "grok-build";
type InstallWorkProvider = "github" | "gitlab" | "linear" | "jira" | "local";
type InstallCiProvider = "github" | "jenkins" | "local";
type InstallLifecycleScripts = "disabled" | "review";
type InstallMigration = "none" | "standalone-globals";
type YesNo = "yes" | "no";

interface InstallSelections {
  readonly scope: InstallScope;
  readonly packageManager: InstallPackageManager;
  readonly host: InstallHost;
  readonly workProvider: InstallWorkProvider;
  readonly ciProvider: InstallCiProvider;
  readonly lifecycleScripts: InstallLifecycleScripts;
  readonly docs: boolean;
  readonly migration: InstallMigration;
}

interface InstallCommandStep {
  readonly label: string;
  readonly command: string;
}

interface InstallOptionSummary {
  readonly value: string;
  readonly label: string;
  readonly support: QubeDiscoveryOption["support"];
  readonly default: boolean;
  readonly packageName: string | null;
  readonly source: QubeDiscoveryOption["source"];
  readonly summary: string;
  readonly capabilities: QubeDiscoveryOption["capabilities"];
  readonly connection: ConnectionContract | null;
}

interface InstallOptionGroups {
  readonly hosts: readonly InstallOptionSummary[];
  readonly workProviders: readonly InstallOptionSummary[];
  readonly ciProviders: readonly InstallOptionSummary[];
}

interface InstallPlan {
  readonly package: {
    readonly name: string;
    readonly version: string;
  };
  readonly selections: InstallSelections;
  readonly options: InstallOptionGroups;
  readonly mode: "copy-commands";
  readonly dryRun: boolean;
  readonly commands: readonly InstallCommandStep[];
  readonly connections: readonly ConnectionContract[];
  readonly files: readonly string[];
  readonly notes: readonly string[];
}

type AutoresearchCommandName = "init" | "baseline" | "run" | "status" | "dashboard" | "promote";
type AutoresearchPhase = "initialized" | "baselined" | "ran" | "promoted";

interface AutoresearchFlags {
  readonly json: boolean;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly runId?: string;
  readonly output?: string;
}

interface AutoresearchRequest {
  readonly command: AutoresearchCommandName;
  readonly compact: boolean;
  readonly args: readonly string[];
  readonly flags: AutoresearchFlags;
}

interface AutoresearchState {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly phase: AutoresearchPhase;
  readonly target: string;
  readonly targetPath: string;
  readonly targetKind: string;
  readonly goal: string;
  readonly evaluatorHash: string;
  readonly currentBest: AutoresearchCandidate | null;
  readonly baseline: AutoresearchEvaluation | null;
  readonly attempts: readonly AutoresearchCandidate[];
  readonly promoted: AutoresearchPromotion | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nextAction: string;
}

interface AutoresearchEvaluation {
  readonly score: number;
  readonly matchedTerms: readonly string[];
  readonly missingTerms: readonly string[];
  readonly evaluatorHash: string;
  readonly summary: string;
  readonly command?: string;
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly durationMs?: number;
  readonly workspacePath?: string;
  readonly outputTruncated?: boolean;
  readonly referee?: AutoresearchReferee;
  readonly recordedAt: string;
}

interface AutoresearchCandidate {
  readonly id: string;
  readonly workspacePath: string;
  readonly artifactPath: string;
  readonly changedFiles: readonly string[];
  readonly evaluation: AutoresearchEvaluation;
  readonly accepted: boolean;
  readonly referee: AutoresearchReferee;
  readonly owner: {
    readonly execution: "aie";
    readonly evaluation: "aiq";
    readonly continuation: "aiu";
  };
}

interface AutoresearchReferee {
  readonly owner: "aiq";
  readonly boundary: "aiq-fixed-evaluator";
  readonly status: "passed" | "rejected";
  readonly reasons: readonly string[];
  readonly evaluatorImmutable: boolean;
  readonly gatesPassed: boolean;
  readonly antiGamingPassed: boolean;
  readonly provenance: {
    readonly evaluatorHash: string;
    readonly command?: string;
    readonly evidenceRequired: readonly string[];
  };
}

interface AutoresearchWorkspaceChange {
  readonly path: string;
  readonly kind: "added" | "modified" | "deleted" | "symlink";
}

interface AutoresearchWorkspaceScan {
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly reasons: readonly string[];
}

interface AutoresearchContinuation {
  readonly owner: "aiu";
  readonly runId: string;
  readonly phase: AutoresearchPhase;
  readonly status: "ready" | "blocked" | "complete";
  readonly resumeCommand: string | null;
  readonly nextAction: string;
  readonly blockers: readonly string[];
  readonly activeCandidateId: string | null;
  readonly currentBestId: string | null;
  readonly safeToResume: boolean;
}

interface AutoresearchPromotion {
  readonly candidateId: string;
  readonly outputPath: string;
  readonly sourcePath: string;
  readonly promotedAt: string;
}

type OneshotCommandName = "run" | "status" | "inspect" | "resume" | "review" | "checks" | "summary";
type OneshotKind = "auto" | "code" | "doc" | "app" | "repo-change" | "research" | "config" | "data";
type OneshotAgent = "auto" | "opencode" | "codex" | "claude-code" | "manual";
type OneshotQuality = "basic" | "standard" | "strict";
type OneshotStatus = "dry-run-complete" | "success" | "blocked-unsupported-target" | "blocked-human-approval-required" | "failed-checks";

interface OneshotFlags {
  readonly json: boolean;
  readonly dryRun: boolean;
  readonly apply: boolean;
  readonly forceOutput: boolean;
  readonly target?: string;
  readonly output?: string;
  readonly kind: OneshotKind;
  readonly agent: OneshotAgent;
  readonly quality: OneshotQuality;
  readonly maxIterations: number;
}

interface OneshotRequest {
  readonly command: OneshotCommandName;
  readonly idea?: string;
  readonly runId?: string;
  readonly flags: OneshotFlags;
}

interface OneshotPlan {
  readonly schemaVersion: 1;
  readonly kind: "code" | "doc";
  readonly title: string;
  readonly intent: string;
  readonly assumptions: readonly { readonly id: string; readonly summary: string; readonly risk: "low" | "medium" | "high" }[];
  readonly acceptanceCriteria: readonly string[];
  readonly nonGoals: readonly string[];
  readonly mutationPolicy: {
    readonly targetMode: "scratch" | "new-directory" | "existing-target-blocked";
    readonly allowedMutationPaths: readonly string[];
    readonly githubSideEffects: false;
    readonly requiresApply: boolean;
  };
  readonly checkPlan: {
    readonly required: readonly string[];
    readonly optional: readonly string[];
  };
}

interface OneshotState {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly status: OneshotStatus;
  readonly phase: "planned" | "finalized" | "blocked";
  readonly idea: string;
  readonly kind: "code" | "doc";
  readonly targetMode: OneshotPlan["mutationPolicy"]["targetMode"];
  readonly runDirectory: string;
  readonly workspaceDirectory: string;
  readonly outputDirectory: string;
  readonly summaryPath: string;
  readonly artifactPath: string | null;
  readonly checksPath: string;
  readonly githubSideEffects: {
    readonly issueCreated: false;
    readonly branchCreated: false;
    readonly pullRequestCreated: false;
    readonly reviewRequested: false;
    readonly mergeAttempted: false;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nextAction: string;
}

interface OneshotContext {
  readonly runDirectory: string;
  readonly state: OneshotState;
  readonly plan: OneshotPlan;
}

interface OneshotCheck {
  readonly id: string;
  readonly name: string;
  readonly command?: readonly string[];
  readonly status: "passed" | "failed" | "skipped";
  readonly summary: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number | null;
}

const makeItSoFlowValues = ["planned", "issue", "direct-local"] as const;
type MakeItSoFlow = typeof makeItSoFlowValues[number];

interface MakeItSoMappedCommand {
  readonly component: QubeComponent["command"];
  readonly args: readonly string[];
  readonly command: string;
}

interface MakeItSoPlan {
  readonly flow: MakeItSoFlow;
  readonly intent: string | null;
  readonly target: string;
  readonly dryRun: boolean;
  readonly status: "dispatch" | "blocked";
  readonly mappedCommand: MakeItSoMappedCommand | null;
  readonly boundaries: readonly string[];
  readonly nextAction: string;
}

const scopeChoices = defineInstallerChoiceGroup({
  name: "install scope",
  message: "Where should QUBE be installed?",
  defaultValue: "local",
  choices: [
    {
      value: "local",
      label: "Project-local",
      description: "Install into the current project for reproducible automation.",
      recommended: true
    },
    {
      value: "global",
      label: "Global manual",
      description: "Install for direct human shell use."
    }
  ]
});
const packageManagerChoices = defineInstallerChoiceGroup({
  name: "package manager",
  message: "Which package manager should the commands use?",
  defaultValue: "pnpm",
  choices: [
    {
      value: "pnpm",
      label: "pnpm",
      description: "Use pnpm with exact package specifiers and disabled lifecycle scripts.",
      recommended: true
    },
    {
      value: "npm",
      label: "npm",
      description: "Use npm with exact package specifiers and disabled lifecycle scripts."
    }
  ]
});

const installOptionLabels: Readonly<Record<string, string>> = Object.freeze({
  "generic": "Generic terminal",
  "codex": "Codex",
  "opencode": "OpenCode",
  "claude-code": "Claude Code",
  "grok-build": "Grok Build",
  "github": "GitHub",
  "gitlab": "GitLab",
  "linear": "Linear",
  "jira": "Jira",
  "jenkins": "Jenkins",
  "local": "Local only",
});

function discoveryChoices<Value extends string>(options: readonly QubeDiscoveryOption[]): readonly InstallerChoice<Value>[] {
  return Object.freeze(options.map(option => Object.freeze({
    value: option.id as Value,
    label: installOptionLabels[option.id] ?? option.id,
    description: `${option.support}: ${option.summary}`,
    ...(option.default ? { recommended: true } : {}),
  })));
}

function discoveryOptionValues(options: readonly QubeDiscoveryOption[]): string[] {
  return options.map(option => option.id);
}

const hostChoices = defineInstallerChoiceGroup({
  name: "host surface",
  message: "Which host surface should the install notes target?",
  defaultValue: "generic",
  choices: discoveryChoices<InstallHost>(executorHostSurfaces)
});
const workProviderChoices = defineInstallerChoiceGroup({
  name: "work provider",
  message: "Which work provider should the notes target?",
  defaultValue: "github",
  choices: discoveryChoices<InstallWorkProvider>(executorWorkProviders)
});
const ciProviderChoices = defineInstallerChoiceGroup({
  name: "ci provider",
  message: "Which CI provider should the notes target?",
  defaultValue: "github",
  choices: discoveryChoices<InstallCiProvider>(executorCiProviders)
});
const lifecycleChoices = defineInstallerChoiceGroup({
  name: "lifecycle scripts",
  message: "How should package lifecycle scripts be handled?",
  defaultValue: "disabled",
  choices: [
    {
      value: "disabled",
      label: "Disabled",
      description: "Add package-manager flags that keep install lifecycle scripts off.",
      recommended: true
    },
    {
      value: "review",
      label: "Review before enabling",
      description: "Keep generated commands safe and document any manual exception."
    }
  ]
});
const docsChoices = defineInstallerChoiceGroup({
  name: "docs generation",
  message: "Should the plan include docs/config notes?",
  defaultValue: "yes",
  choices: [
    {
      value: "yes",
      label: "Include docs notes",
      description: "Show README and config guidance after install.",
      recommended: true
    },
    {
      value: "no",
      label: "Commands only",
      description: "Only show package install and verification commands."
    }
  ]
});
const migrationChoices = defineInstallerChoiceGroup({
  name: "migration path",
  message: "Is this replacing standalone global package commands?",
  defaultValue: "none",
  choices: [
    {
      value: "none",
      label: "Fresh QUBE install",
      description: "Keep the plan focused on installing the composer package.",
      recommended: true
    },
    {
      value: "standalone-globals",
      label: "Migrate standalone globals",
      description: "Include notes for moving from direct aib, aie, aiq, or aiu globals."
    }
  ]
});

const installCommand = defineCommand({
  kind: "command",
  name: "install",
  description: "Build a guided, supply-chain-safe QUBE install plan.",
  flags: [
    jsonFlag,
    dryRunFlag,
    yesFlag,
    defineFlag({
      name: "scope",
      description: "Install scope to plan.",
      type: "option",
      options: ["local", "global"]
    }),
    defineFlag({
      name: "package-manager",
      description: "Package manager to use in generated commands.",
      type: "option",
      options: ["pnpm", "npm"]
    }),
    defineFlag({
      name: "host",
      description: "Host surface to mention in setup notes. Default: generic.",
      type: "option",
      options: discoveryOptionValues(executorHostSurfaces)
    }),
    defineFlag({
      name: "work-provider",
      description: "Work provider to mention in setup notes. Default: github.",
      type: "option",
      options: discoveryOptionValues(executorWorkProviders)
    }),
    defineFlag({
      name: "ci-provider",
      description: "CI provider to mention in setup notes. Default: github.",
      type: "option",
      options: discoveryOptionValues(executorCiProviders)
    }),
    defineFlag({
      name: "lifecycle-scripts",
      description: "Lifecycle script posture for generated install commands.",
      type: "option",
      options: ["disabled", "review"]
    }),
    defineFlag({
      name: "docs",
      description: "Include README and configuration guidance in the generated plan.",
      type: "boolean",
      negatable: true
    }),
    defineFlag({
      name: "migration",
      description: "Migration posture for users moving from standalone package globals.",
      type: "option",
      options: ["none", "standalone-globals"]
    })
  ],
  examples: [
    {
      description: "Render an interactive guided install plan.",
      command: "qube install"
    },
    {
      description: "Render a non-interactive local install plan as JSON.",
      command: "qube install --yes --dry-run --json"
    },
    {
      description: "Render a global npm install plan.",
      command: "qube install --scope global --package-manager npm --yes"
    }
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
  supplyChain: {
    sensitive: true,
    reason: "Installer output contains package-manager commands and dependency setup guidance.",
    kinds: ["dependency", "package-manager"]
  }
});

const componentsCommand = defineCommand({
  kind: "command",
  name: "components",
  description: "List QUBE component packages and commands.",
  flags: [jsonFlag],
  examples: [
    {
      description: "List QUBE components.",
      command: "qube components"
    },
    {
      description: "List QUBE components as JSON.",
      command: "qube components --json"
    }
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
  }
});

const autoresearchCommand = defineCommand({
  kind: "command",
  name: "autoresearch",
  description: "Run a safety-bounded local autoresearch arena lifecycle. Agent entry: translate the request into <target-directory> plus <goal>, then use AIB arena synthesis before edits.",
  arguments: [
    defineArgument({
      name: "args",
      description: "Lifecycle input: init <target-directory> <goal> for an existing local directory, baseline, run, status, dashboard, promote, or compact <target-directory> <goal> as an init-only alias. AIB arena synthesis designs the fixed evaluator from command metric, threshold, finding reduction, fixed rubric, or human-gated promotion policy. State lives under .qube/autoresearch/runs/<run-id>/ with latest selection in .qube/autoresearch/latest.json.",
      multiple: true
    })
  ],
  flags: [
    jsonFlag,
    dryRunFlag,
    defineFlag({
      name: "help",
      short: "h",
      description: "Show command help.",
      type: "boolean"
    }),
    defineFlag({
      name: "run",
      description: "Autoresearch run id for lifecycle commands.",
      type: "string"
    }),
    defineFlag({
      name: "output",
      description: "Promotion output path. Defaults to <target>/autoresearch-result.md.",
      type: "string"
    }),
    defineFlag({
      name: "force",
      description: "Allow promotion to replace an existing output file.",
      type: "boolean"
    })
  ],
  examples: [
    {
      description: "Create a fixed local-directory arena under .qube/autoresearch without mutating the target.",
      command: "qube autoresearch init <target-directory> <goal> --json"
    },
    {
      description: "Use compact target/goal input as a safe init-only alias.",
      command: "qube autoresearch ./scratch \"improve notes summary quality\" --json"
    },
    {
      description: "Run the immutable fixed evaluator for the latest arena.",
      command: "qube autoresearch baseline --json"
    },
    {
      description: "Run one sandboxed candidate loop with AIE execution ownership and AIQ evaluation evidence.",
      command: "qube autoresearch run --json"
    },
    {
      description: "Report the active run, score, current best, and next safe command.",
      command: "qube autoresearch status --json"
    },
    {
      description: "promote is the only command that copies the selected best candidate to target or --output.",
      command: "qube autoresearch promote --output ./scratch/autoresearch-result.md"
    }
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
    ttyPrompt: false
  },
  mutation: defineMutationMetadata({
    categories: mutationCategories("local-files")
  })
});

const oneshotKindValues = ["auto", "code", "doc", "app", "repo-change", "research", "config", "data"] as const;
const oneshotAgentValues = ["auto", "opencode", "codex", "claude-code", "manual"] as const;
const oneshotQualityValues = ["basic", "standard", "strict"] as const;

const oneshotCommand = defineCommand({
  kind: "command",
  name: "oneshot",
  description: "Create a bounded local artifact without the normal issue, PR, or review-gate workflow.",
  arguments: [
    defineArgument({
      name: "args",
      description: "Idea text, or status/inspect/resume/review/checks/summary <run-id>. Default runs use .qube/oneshot/<run-id>/ scratch state and create no GitHub issue, branch, PR, review request, merge, or approval.",
      multiple: true
    })
  ],
  flags: [
    jsonFlag,
    dryRunFlag,
    defineFlag({
      name: "help",
      short: "h",
      description: "Show command help.",
      type: "boolean"
    }),
    defineFlag({
      name: "target",
      description: "Target path. Missing paths become explicit new-directory targets; existing targets are refused unless a future apply path supports them.",
      type: "string"
    }),
    defineFlag({
      name: "output",
      description: "Optional final artifact output path. Existing files require --force-output.",
      type: "string"
    }),
    defineFlag({
      name: "kind",
      description: "Artifact kind. The first implementation supports auto, code, and doc.",
      type: "option",
      options: [...oneshotKindValues]
    }),
    defineFlag({
      name: "agent",
      description: "Agent host preference recorded in run input.",
      type: "option",
      options: [...oneshotAgentValues]
    }),
    defineFlag({
      name: "quality",
      description: "Local quality posture recorded in the check plan.",
      type: "option",
      options: [...oneshotQualityValues]
    }),
    defineFlag({
      name: "max-iterations",
      description: "Bounded local loop budget. The first implementation performs one concrete iteration.",
      type: "string"
    }),
    defineFlag({
      name: "apply",
      description: "Explicitly request existing target mutation. Existing-target mutation is refused in the first implementation.",
      type: "boolean"
    }),
    defineFlag({
      name: "force-output",
      description: "Allow --output to replace an existing file.",
      type: "boolean"
    })
  ],
  examples: [
    {
      description: "Create a scratch code artifact with local checks and no GitHub side effects.",
      command: "qube oneshot \"Ship a local notes CLI\" --kind code --json"
    },
    {
      description: "Preview inferred assumptions, mutation policy, checks, and run paths without writing files.",
      command: "qube oneshot \"Create a README draft\" --kind doc --dry-run --json"
    },
    {
      description: "Inspect trusted state for an existing local run.",
      command: "qube oneshot status <run-id> --json"
    },
    {
      description: "Read the final handoff summary for a run.",
      command: "qube oneshot summary <run-id>"
    }
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
    ttyPrompt: false
  },
  mutation: defineMutationMetadata({
    categories: mutationCategories("local-files")
  })
});

const makeItSoCommand = defineCommand({
  kind: "command",
  name: "make-it-so",
  aliases: ["makeitso"],
  description: "Map an intent to the safest real QUBE workflow.",
  arguments: [
    defineArgument({
      name: "args",
      description: "Intent text, issue selector, and additional arguments forwarded to the mapped component command.",
      multiple: true
    })
  ],
  flags: [
    jsonFlag,
    dryRunFlag,
    defineFlag({
      name: "help",
      short: "h",
      description: "Show command help.",
      type: "boolean"
    }),
    defineFlag({
      name: "flow",
      description: "Workflow to run.",
      type: "option",
      options: [...makeItSoFlowValues]
    }),
    defineFlag({
      name: "target",
      description: "Planning target path for the planned flow.",
      type: "string"
    })
  ],
  examples: [
    {
      description: "Start planning from a concise intent.",
      command: "qube make-it-so \"Ship a local notes CLI\""
    },
    {
      description: "Start the next provider-backed issue through Executor.",
      command: "qube make-it-so --flow issue next --json"
    },
    {
      description: "Preview the mapped workflow without running it.",
      command: "qube make-it-so \"Ship a local notes CLI\" --dry-run --json"
    }
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
    ttyPrompt: false
  },
  extensions: passthroughExtensions
});

interface DirectQubeCommand {
  readonly command: ReturnType<typeof defineCommand>;
  readonly component: QubeComponent["command"];
  readonly supportsJson: boolean;
  readonly passthroughJson?: boolean;
  readonly qubePrimaryHelp?: boolean;
  readonly mapArgs: (args: readonly string[]) => readonly string[];
}

const doctorCommand = defineCommand({
  kind: "command",
  name: "doctor",
  description: "Run Quality Control diagnostics and configured provider connection probes.",
  flags: [jsonFlag, offlineFlag],
  examples: [
    { description: "Run all diagnostics and live read-only provider probes.", command: "qube doctor" },
    { description: "Report connection probes as unverified without network access.", command: "qube doctor --offline --json" },
  ],
  interactions: {
    json: true,
    noColor: true,
    nonInteractive: true,
    ttyPrompt: false,
  },
});

const directCommandDefinitions: readonly DirectQubeCommand[] = [
  {
    command: defineCommand({
      kind: "command",
      name: "idea",
      description: "Start Bootstrap from a concise idea.",
      arguments: [
        defineArgument({
          name: "idea",
          description: "Idea text to turn into an initial QUBE plan.",
          required: false
        }),
        defineArgument({
          name: "args",
          description: "Additional arguments forwarded to aib init.",
          multiple: true
        })
      ],
      flags: [jsonFlag],
      examples: [
        {
          description: "Start a QUBE plan from an idea.",
          command: "qube idea \"Ship a local notes CLI\""
        },
        {
          description: "Start a QUBE plan and render JSON.",
          command: "qube idea \"Ship a local notes CLI\" --json"
        }
      ],
      interactions: {
        json: true,
        noColor: true,
        nonInteractive: true,
        ttyPrompt: false
      },
      extensions: passthroughExtensions
    }),
    component: "aib",
    supportsJson: true,
    mapArgs(args) {
      return mapIdeaArgs(args);
    }
  },
  createDirectCommand("init", "Initialize Bootstrap planning state for a target.", "aib", "init"),
  createDirectCommand("plan status", "Show Bootstrap planning status.", "aib", "status"),
  createDirectCommand("plan next", "Show the next Bootstrap planning action.", "aib", "next"),
  createDirectCommand("answer", "Record a Bootstrap planning answer.", "aib", "answer"),
  createDirectCommand("spec draft", "Draft the Bootstrap spec artifact.", "aib", "spec draft"),
  createDirectCommand("spec validate", "Validate the Bootstrap spec artifact.", "aib", "spec validate"),
  createDirectCommand("spec accept", "Accept reviewed Bootstrap spec sections.", "aib", "spec accept"),
  createDirectCommand("spec reopen", "Reopen accepted Bootstrap spec sections.", "aib", "spec reopen"),
  createDirectCommand("milestones", "Generate milestone planning artifacts.", "aib", "milestones generate"),
  createDirectCommand("milestones generate", "Generate milestone planning artifacts.", "aib", "milestones generate"),
  createDirectCommand("work-items", "Generate provider-neutral work item drafts.", "aib", "work-items generate"),
  createDirectCommand("work-items generate", "Generate provider-neutral work item drafts.", "aib", "work-items generate"),
  createDirectCommand("work-items render", "Render work item drafts for a provider.", "aib", "work-items render"),
  createDirectCommand("queue", "Show the Executor issue queue.", "aie", "queue"),
  createDirectCommand("next", "Select the next Executor issue.", "aie", "next"),
  createDirectCommand("start", "Start or resume Executor issue work.", "aie", "start"),
  createDirectCommand("switch", "Switch Executor issue work.", "aie", "switch"),
  createDirectCommand("view", "Show Executor issue context.", "aie", "view"),
  createDirectCommand("complete", "Complete post-merge Executor issue work.", "aie", "complete"),
  createDirectCommand("branch", "Show Executor branch helpers.", "aie", "branch", { supportsJson: false }),
  createDirectCommand("branch suggest", "Suggest the policy-compliant issue branch.", "aie", "branch suggest"),
  createDirectCommand("branch check", "Check the current issue branch.", "aie", "branch check"),
  createDirectCommand("branch create", "Create or switch to the issue branch.", "aie", "branch create"),
  createDirectCommand("gates", "Show Executor gate helpers.", "aie", "gates", { supportsJson: false }),
  createDirectCommand("gates plan", "Show configured Executor gate obligations.", "aie", "gates plan"),
  createDirectCommand("gates status", "Show recorded Executor gate evidence.", "aie", "gates status"),
  createDirectCommand("audit", "Show Executor audit helpers.", "aie", "audit", { supportsJson: false }),
  createDirectCommand("audit ui", "Plan or check manual UI audit evidence.", "aie", "audit ui"),
  createDirectCommand("review", "Set up and validate provider publishing or show host-run Executor review helpers.", "aie", "review", { supportsJson: false, qubePrimaryHelp: true }),
  createDirectCommand("review setup", "Show guided reviewer publisher setup paths.", "aie", "review setup", { supportsJson: false, qubePrimaryHelp: true }),
  createDirectCommand("review setup github-app", "Configure a user-owned GitHub App reviewer publisher with safe secret references.", "aie", "review setup github-app", { passthroughJson: true, qubePrimaryHelp: true }),
  createDirectCommand("review setup token", "Configure a separate-user fine-grained token reviewer publisher with an env reference.", "aie", "review setup token", { passthroughJson: true, qubePrimaryHelp: true }),
  createDirectCommand("review doctor", "Validate reviewer publisher readiness and permissions without exposing secrets.", "aie", "review doctor", { passthroughJson: true, qubePrimaryHelp: true }),
  createDirectCommand("review gate", "Render configured review-agent gate prompts.", "aie", "review gate", { qubePrimaryHelp: true }),
  createDirectCommand("pr", "Show Executor pull request helpers.", "aie", "pr", { supportsJson: false }),
  createDirectCommand("pr view", "Show concise pull request state.", "aie", "pr view"),
  createDirectCommand("pr body", "Draft a pull request body for issue work.", "aie", "pr body"),
  createDirectCommand("pr gate", "Request and inspect configured pull request reviews.", "aie", "pr gate"),
  createDirectCommand("deps", "Show Executor dependency helpers.", "aie", "deps", { supportsJson: false }),
  createDirectCommand("deps blockers", "List direct blockers for an issue.", "aie", "deps blockers"),
  createDirectCommand("deps blocked", "List blocked open issues.", "aie", "deps blocked"),
  createDirectCommand("deps blocking", "List open issues blocked by an issue.", "aie", "deps blocking"),
  createDirectCommand("deps ready", "List ready issues with no open blockers.", "aie", "deps ready"),
  createDirectCommand("deps chain", "Show recursive issue blockers.", "aie", "deps chain"),
  createDirectCommand("deps graph", "Emit the open issue dependency graph.", "aie", "deps graph"),
  createDirectCommand("deps fix", "Synchronize dependency status labels.", "aie", "deps fix"),
  createDirectCommand("app start", "Start a local app process for audit work.", "aie", "run start"),
  createDirectCommand("app wait", "Wait for a local audit app readiness URL.", "aie", "run wait"),
  createDirectCommand("app status", "Show local audit app process status.", "aie", "run status"),
  createDirectCommand("app stop", "Stop a local audit app process.", "aie", "run stop"),
  createDirectCommand("check", "Run Quality Control checks for explicit paths.", "aiq", "check", { translateJson: true }),
  createDirectCommand("quality", "Run AIQ quality stages for explicit paths.", "aiq", "run", { translateJson: true }),
  createDirectCommand("quality run", "Run AIQ quality stages for explicit paths.", "aiq", "run", { translateJson: true }),
  createDirectCommand("quality plan", "Resolve the AIQ quality plan.", "aiq", "plan", { translateJson: true }),
  createDirectCommand("quality status", "Show AIQ quality status.", "aiq", "status", { translateJson: true }),
  createDirectCommand("quality setup", "Render AIQ setup guidance.", "aiq", "setup", { translateJson: true }),
  createDirectCommand("evidence", "Emit structured AIQ quality evidence.", "aiq", "evidence", { translateJson: true }),
  createDirectCommand("quality evidence", "Emit structured AIQ quality evidence.", "aiq", "evidence", { translateJson: true }),
  createDirectCommand("bench", "Run the standalone AIQ benchmark corpus.", "aiq", "bench", { translateJson: true }),
  createDirectCommand("watch", "Run AIQ continuously for explicit paths.", "aiq", "watch", { translateJson: true }),
  createDirectCommand("serve", "Start the standalone AIQ quality server.", "aiq", "serve", { translateJson: true }),
  createDirectCommand("status", "Show Umpire continuation status.", "aiu", "status"),
  createDirectCommand("continue", "Show Umpire continuation status.", "aiu", "status"),
  createDirectCommand("continue status", "Show Umpire continuation status.", "aiu", "status"),
  createDirectCommand("whip", "Inspect and manage durable idle whip tasks.", "aiu", "whip"),
];

const directCommands = directCommandDefinitions.map(definition => definition.command);
const directCommandNames = new Set(directCommands.map(command => command.name));
const sortedDirectCommandDefinitions = [...directCommandDefinitions].sort((left, right) => right.command.name.split(" ").length - left.command.name.split(" ").length);

const ambiguousCommandGuidance: Readonly<Record<string, string>> = {
  config: "Config exists in multiple components. Use qube aiq config, qube aiu config, or qube aie init for Executor config setup.",
  migrate: "Migration exists in Executor and Umpire. Use qube aie migrate ... for Executor migration or qube aiu migrate ... for Umpire migration.",
  labels: "Label management is Executor-specific. Use qube aie labels setup ... when you need repository label administration.",
  repo: "Repository preparation is Executor-specific administration. Use qube aie repo prime ... when you need it.",
  paths: "Path inspection is Umpire-specific. Use qube aiu paths ... when you need package and state paths.",
  hook: "Hook setup is package-specific. Use qube aiq hook ... for Quality Control hooks.",
  "hook-stop": "Stop-hook handling is Umpire-specific host integration. Use qube aiu hook-stop ... from host hook wiring."
};

const runCommand = defineCommand({
  kind: "command",
  name: "run",
  description: "Run a QUBE component command with passthrough arguments.",
  arguments: [
    defineArgument({
      name: "component",
      description: "Component id, command, or package name to run.",
      required: false
    }),
    defineArgument({
      name: "args",
      description: "Arguments forwarded to the component command.",
      multiple: true
    })
  ],
  examples: [
    {
      description: "Run an advanced AIB command through QUBE.",
      command: "qube run aib status"
    },
    {
      description: "Forward flags to a component command.",
      command: "qube run aiq --version"
    }
  ],
  interactions: {
    nonInteractive: true,
    ttyPrompt: false
  },
  extensions: targetedPassthroughExtensions
});

const componentCommands = qubeComponents.map(component => defineCommand({
  kind: "command",
  name: component.command,
  description: component.summary,
  aliases: component.id === component.command || directCommandNames.has(component.id) ? [] : [component.id],
  arguments: [
    defineArgument({
      name: "args",
      description: `Arguments forwarded to ${component.command}.`,
      multiple: true
    })
  ],
  examples: [
    {
      description: `Run ${component.command} through QUBE.`,
      command: `qube ${component.command} --version`
    }
  ],
  interactions: {
    nonInteractive: true,
    ttyPrompt: false
  },
  extensions: passthroughExtensions
}));

let runtimeRegistry = createCommandRegistry({ commands: [componentsCommand, installCommand, doctorCommand, autoresearchCommand, oneshotCommand, makeItSoCommand, ...directCommands, runCommand, ...componentCommands] });

export function planQubeCli(input: readonly string[], environment: CliEnvironment = defaultEnvironment()): CliExecution {
  const args = [...input];
  if (args[0] === "components") {
    if (args.includes("--json")) {
      return { exitCode: 0, stdout: `${JSON.stringify({ ok: true, command: "components", components: qubeComponents })}\n`, stderr: "" };
    }
    return { exitCode: 0, stdout: renderComponents(), stderr: "" };
  }
  if (args[0] === "install") {
    return planQubeInstall(args.slice(1));
  }
  if (args[0] === "doctor") {
    const forwarded = args.slice(1).filter(argument => argument !== "--offline");
    return planQubeDispatch("aiq", ["doctor", ...translateJsonFlag(forwarded)], environment);
  }
  if (args[0] === "autoresearch") {
    return planAutoresearch(args.slice(1), environment);
  }
  if (args[0] === "oneshot") {
    return planOneshot(args.slice(1), environment);
  }
  if (args[0] === "make-it-so" || args[0] === "makeitso") {
    return planMakeItSo(args.slice(1), environment);
  }

  const direct = planDirectCommand(args, environment);
  if (direct) {
    return direct;
  }

  const ambiguous = ambiguityError(args);
  if (ambiguous) {
    return ambiguous;
  }

  const dispatchInput = args[0] === "run" ? args.slice(1) : args;
  const [componentName, ...componentArgs] = dispatchInput;
  return planQubeDispatch(componentName, stripSeparator(componentArgs), environment);
}

export async function runQubeCli(input: readonly string[] = process.argv.slice(2)): Promise<number> {
  const result = await runCli(createQubeCli(defaultEnvironment()), input);
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode === 0 ? process.exitCode : result.exitCode;
  return result.exitCode;
}

export function resolveCommand(command: string, environment: CliEnvironment = defaultEnvironment()): string | undefined {
  const component = qubeComponents.find(candidate => candidate.command === command);
  if (component) {
    const resolution = resolveComponentCommand(component, environment);
    return resolution && !resolution.error ? resolution.commandPath : undefined;
  }
  return resolveCommandFromEntries(command, [path.join(environment.cwd, "node_modules", ".bin"), ...pathEntries(environment.env)], environment);
}

export function resolveComponentCommand(component: QubeComponent, environment: CliEnvironment = defaultEnvironment()): CommandResolution | undefined {
  const packageRoot = environment.packageRoot ?? defaultPackageRoot(environment.env);
  const installBin = path.join(packageRoot, "node_modules", ".bin");
  const installPath = resolveCommandFromEntries(component.command, [installBin], environment);
  if (installPath) {
    return withPackageMetadata(component, installPath, "install", path.join(packageRoot, "node_modules", ...component.packageName.split("/"), "package.json"));
  }

  const workspacePath = resolveCommandFromEntries(component.command, [path.join(environment.cwd, "node_modules", ".bin")], environment);
  if (workspacePath) {
    return withPackageMetadata(component, workspacePath, "workspace", findNearestPackageJson(workspacePath));
  }

  const pathPath = resolveCommandFromEntries(component.command, pathEntries(environment.env), environment);
  if (!pathPath) {
    return undefined;
  }

  const resolution = withPackageMetadata(component, pathPath, "path", findNearestPackageJson(pathPath));
  if (!resolution.packageVersion) {
    return {
      ...resolution,
      error: `Refusing ${component.command} from PATH at ${pathPath}: unable to verify ${component.packageName}@${component.packageVersion}.`
    };
  }
  if (resolution.packageVersion && resolution.packageVersion !== component.packageVersion) {
    return {
      ...resolution,
      error: `Refusing ${component.command} from PATH at ${pathPath}: expected ${component.packageName}@${component.packageVersion}, found ${resolution.packageVersion}.`
    };
  }
  return {
    ...resolution,
    warning: `Warning: ${component.command} resolved from PATH at ${pathPath}; install-scoped ${component.packageName}@${component.packageVersion} was not found.`
  };
}

function createQubeCli(environment: CliEnvironment) {
  const cli = createCli({
    bin: "qube",
    packageName,
    packageVersion,
    description: packageDescription,
    registry: runtimeRegistry,
    commands: [
      createRuntimeCommand(componentsCommand, ({ flags }) => {
        if (flags.json === true) {
          return { json: { components: qubeComponents } };
        }
        return { stdout: renderComponents() };
      }),
      createRuntimeCommand(installCommand, async ({ flags }) => {
        const plan = createInstallPlan(await resolveInstallSelections(flags), flags["dry-run"] === true);
        if (flags.json === true) {
          return { json: { installPlan: plan } };
        }
        return { stdout: renderInstallPlan(plan) };
      }),
      createRuntimeCommand(doctorCommand, ({ flags }) => executeQubeDoctor(flags.json === true, flags.offline === true, environment)),
      createRuntimeCommand(autoresearchCommand, ({ argv }) => executeAutoresearch(argv, environment)),
      createRuntimeCommand(oneshotCommand, ({ argv }) => executeOneshot(argv, environment)),
      createRuntimeCommand(makeItSoCommand, ({ argv }) => executeMakeItSo(argv, environment)),
      ...directCommandDefinitions.map(definition => createRuntimeCommand(
        definition.command,
        ({ argv }) => executeDirectCommand(definition, argv, environment)
      )),
      createRuntimeCommand(runCommand, ({ args }) => executeQubeDispatch(readString(args.component), readStringArray(args.args), environment)),
      ...qubeComponents.map((component, index) => createRuntimeCommand(
        componentCommands[index]!,
        ({ args }) => executeQubeDispatch(component.command, readStringArray(args.args), environment)
      )),
      createSchemaCommand({
        registry: () => runtimeRegistry,
        bin: "qube",
        packageName,
        packageVersion,
        sections: {
          components: qubeComponents,
          directCommands: directCommandDefinitions.map(definition => ({
            command: definition.command.name,
            component: definition.component
          }))
        }
      })
    ]
  });
  runtimeRegistry = cli.registry;
  return cli;
}

async function executeQubeDoctor(json: boolean, offline: boolean, environment: CliEnvironment): Promise<RuntimeCommandResult> {
  const connections = await runConnectionDoctor({
    cwd: environment.cwd,
    env: environment.env,
    mode: offline ? "offline" : "live",
  });
  const planned = planQubeDispatch("aiq", ["doctor", ...(json ? ["--format", "json"] : [])], environment);
  if (!planned.dispatch) {
    const exitCode = planned.exitCode === 0 && connections.status !== "fail" ? 0 : planned.exitCode || 1;
    if (json) {
      return {
        exitCode,
        json: {
          quality: { ok: false, error: planned.stderr.trim() || "Quality Control doctor is unavailable." },
          connectionStatus: connections.status,
          connections,
        },
      };
    }
    return { exitCode, stdout: `${planned.stdout}${formatConnectionDoctor(connections)}`, stderr: planned.stderr };
  }

  const quality = await dispatchCommandCaptured(planned.dispatch);
  const exitCode = quality.exitCode === 0 && connections.status !== "fail" ? 0 : quality.exitCode || 1;
  if (json) {
    let qualityPayload: unknown;
    try {
      qualityPayload = JSON.parse(quality.stdout);
    } catch {
      qualityPayload = { ok: false, error: "Quality Control doctor returned invalid JSON." };
    }
    return {
      exitCode,
      json: {
        quality: qualityPayload,
        connectionStatus: connections.status,
        connections,
      },
      stderr: `${planned.stderr}${quality.stderr}`,
    };
  }
  return {
    exitCode,
    stdout: `${quality.stdout.trimEnd()}\n\n${formatConnectionDoctor(connections)}`,
    stderr: `${planned.stderr}${quality.stderr}`,
  };
}

async function executeQubeDispatch(componentName: string | undefined, componentArgs: readonly string[], environment: CliEnvironment): Promise<RuntimeCommandResult> {
  const planned = planQubeDispatch(componentName, componentArgs, environment);
  if (!planned.dispatch) {
    return { exitCode: planned.exitCode, stdout: planned.stdout, stderr: planned.stderr };
  }

  if (planned.stderr.length > 0) {
    process.stderr.write(planned.stderr);
  }
  const exitCode = await dispatchCommand(planned.dispatch);
  return { exitCode };
}

function planAutoresearch(args: readonly string[], environment: CliEnvironment): CliExecution {
  if (isAutoresearchHelpRequest(args)) {
    return { exitCode: 0, stdout: renderAutoresearchHelp(), stderr: "" };
  }
  return runAutoresearch(args, environment, false);
}

async function executeAutoresearch(args: readonly string[], environment: CliEnvironment): Promise<RuntimeCommandResult> {
  if (isAutoresearchHelpRequest(args)) {
    return { exitCode: 0, stdout: renderAutoresearchHelp() };
  }
  const planned = runAutoresearch(args, environment, true);
  if (hasTopLevelJsonFlag(args)) {
    return { exitCode: planned.exitCode, jsonStdout: planned.stdout, stderr: planned.stderr };
  }
  return { exitCode: planned.exitCode, stdout: planned.stdout, stderr: planned.stderr };
}

function runAutoresearch(args: readonly string[], environment: CliEnvironment, mutate: boolean): CliExecution {
  const parsed = parseAutoresearchArgs(args);
  if ("error" in parsed) {
    return parsed.error;
  }
  const flags = parsed.request.flags;
  const dryRun = flags.dryRun || !mutate;
  const result = executeAutoresearchRequest(parsed.request, environment, dryRun);
  if ("error" in result) {
    return autoresearchError(result.error, flags.json);
  }
  const payload = { ...result.payload, dryRun };
  if (flags.json) {
    return { exitCode: 0, stdout: `${JSON.stringify({ ok: true, command: "autoresearch", autoresearch: payload })}\n`, stderr: "" };
  }
  return { exitCode: 0, stdout: renderAutoresearchResult(payload), stderr: "" };
}

function executeAutoresearchRequest(
  request: AutoresearchRequest,
  environment: CliEnvironment,
  dryRun: boolean
): { readonly payload: Readonly<Record<string, unknown>> } | { readonly error: string } {
  if (request.command === "init") {
    return initAutoresearch(request, environment, dryRun);
  }
  const context = loadAutoresearchContext(environment, request.flags.runId ?? request.args[0]);
  if ("error" in context) {
    return context;
  }
  const immutable = validateAutoresearchEvaluator(context.state, context.evaluator);
  if (immutable) {
    return { error: immutable };
  }
  if (request.command === "baseline") {
    return baselineAutoresearch(context, dryRun);
  }
  if (request.command === "run") {
    return runAutoresearchCandidate(context, dryRun);
  }
  if (request.command === "status") {
    return { payload: summarizeAutoresearch(context, "status") };
  }
  if (request.command === "dashboard") {
    if (!dryRun) {
      writeAutoresearchDashboard(context);
    }
    return { payload: { ...summarizeAutoresearch(context, "dashboard"), dashboardPath: path.join(context.runDirectory, "dashboard.html"), dashboardDataPath: path.join(context.runDirectory, "dashboard-data.json") } };
  }
  return promoteAutoresearch(context, request, environment, dryRun);
}

function initAutoresearch(
  request: AutoresearchRequest,
  environment: CliEnvironment,
  dryRun: boolean
): { readonly payload: Readonly<Record<string, unknown>> } | { readonly error: string } {
  const [target, ...goalParts] = request.args;
  const goal = goalParts.join(" ").trim();
  if (!target || goal.length === 0) {
    return { error: "Autoresearch init requires <target> and <goal>." };
  }
  if (/^(?:https?:|github:|gitlab:|linear:)/i.test(target)) {
    return { error: "This first autoresearch implementation supports local directory targets only." };
  }
  const targetPath = path.resolve(environment.cwd, target);
  if (!existsSync(targetPath) || !statSync(targetPath).isDirectory()) {
    return { error: "This first autoresearch implementation requires an existing directory target." };
  }
  const synthesis = synthesizeAutoresearchArena({ target, goal, cwd: environment.cwd });
  if (synthesis.classification !== "autoresearch" || !synthesis.target || !synthesis.evaluator || !synthesis.arena || !synthesis.arenaMarkdown) {
    const questions = synthesis.blockingQuestions.map(question => question.text).join(" ");
    return { error: questions || synthesis.nextAction };
  }
  const now = new Date().toISOString();
  const evaluator = synthesis.evaluator;
  const runId = createAutoresearchRunId(goal, now);
  const runDirectory = autoresearchRunDirectory(environment, runId);
  const state: AutoresearchState = {
    schemaVersion: 1,
    runId,
    phase: "initialized",
    target,
    targetPath,
    targetKind: synthesis.target.kind,
    goal,
    evaluatorHash: evaluator.hash,
    currentBest: null,
    baseline: null,
    attempts: [],
    promoted: null,
    createdAt: now,
    updatedAt: now,
    nextAction: `Run qube autoresearch baseline --run ${runId}.`
  };
  const arena = createAutoresearchArena(state, evaluator, runDirectory, synthesis.arena);
  if (!dryRun) {
    createAutoresearchDirectories(runDirectory);
    writeJsonFile(path.join(runDirectory, "arena.json"), arena);
    writeFileSync(path.join(runDirectory, "arena.md"), synthesis.arenaMarkdown, "utf8");
    writeJsonFile(path.join(runDirectory, "evaluator.json"), evaluator);
    writeJsonFile(path.join(runDirectory, "state.json"), state);
    writeFileSync(path.join(runDirectory, "attempts.jsonl"), "", "utf8");
    writeJsonFile(autoresearchLatestPath(environment), { runId });
    writeAutoresearchDashboard({ runDirectory, state, evaluator, arena });
  }
  return {
    payload: {
      action: "init",
      runId,
      phase: state.phase,
      target,
      targetPath,
      goal,
      evaluatorHash: evaluator.hash,
      synthesis: {
        classification: synthesis.classification,
        readinessChecklist: synthesis.readinessChecklist,
        objective: synthesis.objective
      },
      stateDirectory: runDirectory,
      stateLayout: autoresearchStateLayout(runDirectory),
      safety: arena.safety,
      nextAction: state.nextAction
    }
  };
}

function baselineAutoresearch(
  context: AutoresearchContext,
  dryRun: boolean
): { readonly payload: Readonly<Record<string, unknown>> } | { readonly error: string } {
  if (context.state.baseline) {
    return { error: "Autoresearch baseline is immutable once recorded for this run." };
  }
  if (!isCommandMetricEvaluator(context.evaluator) || context.evaluator.acceptancePolicy.promotionRequiresHuman) {
    return baselineHumanGatedAutoresearch(context, dryRun);
  }
  const workspacePath = autoresearchWorkspacePath(context);
  const targetSizeReasons = validateAutoresearchWorkspaceSize(context.state.targetPath, "Autoresearch target");
  if (dryRun) {
    return {
      payload: {
        action: "baseline",
        runId: context.state.runId,
        phase: context.state.phase,
        planned: true,
        workspacePath,
        workspaceLimits: autoresearchWorkspaceLimitSummary(),
        blockers: targetSizeReasons,
        evaluatorProvenance: autoresearchEvaluatorProvenance(context),
        nextAction: `Run qube autoresearch baseline --run ${context.state.runId} without --dry-run to snapshot and evaluate the baseline.`
      }
    };
  }
  if (targetSizeReasons.length > 0) {
    return { error: targetSizeReasons.join(" ") };
  }
  if (!dryRun) {
    materializeAutoresearchWorkspace(context.state.targetPath, workspacePath);
    copyAutoresearchWorkspace(workspacePath, autoresearchBaselineWorkspacePath(context));
    copyAutoresearchWorkspace(workspacePath, autoresearchCurrentBestWorkspacePath(context));
  }
  const evaluation = evaluateAutoresearchCommand(context, workspacePath);
  if (evaluation.referee?.status !== "passed") {
    return { error: `Autoresearch baseline evaluator was rejected: ${evaluation.referee?.reasons.join(" ") || "unknown AIQ referee rejection"}` };
  }
  const state = updateAutoresearchState(context.state, {
    phase: "baselined",
    baseline: evaluation,
    nextAction: `Run qube autoresearch run --run ${context.state.runId}.`
  });
  if (!dryRun) {
    writeJsonFile(path.join(context.runDirectory, "baseline.json"), evaluation);
    writeJsonFile(path.join(context.runDirectory, "state.json"), state);
    writeAutoresearchDashboard({ ...context, state });
  }
  return {
    payload: {
      action: "baseline",
      runId: state.runId,
      phase: state.phase,
      evaluation,
      nextAction: state.nextAction
    }
  };
}

function baselineHumanGatedAutoresearch(
  context: AutoresearchContext,
  dryRun: boolean
): { readonly payload: Readonly<Record<string, unknown>> } | { readonly error: string } {
  const workspacePath = autoresearchWorkspacePath(context);
  const targetSizeReasons = validateAutoresearchWorkspaceSize(context.state.targetPath, "Autoresearch target");
  const reasons = [
    ...targetSizeReasons,
    "Autoresearch has no trustworthy automated score for this evaluator; promotion is human-gated."
  ];
  if (dryRun) {
    return {
      payload: {
        action: "baseline",
        runId: context.state.runId,
        phase: context.state.phase,
        planned: true,
        workspacePath,
        workspaceLimits: autoresearchWorkspaceLimitSummary(),
        blockers: reasons,
        evaluatorProvenance: autoresearchEvaluatorProvenance(context),
        continuation: createAutoresearchContinuation(context),
        nextAction: "Use the dashboard and normal QUBE review to decide whether this human-gated arena should continue."
      }
    };
  }
  if (targetSizeReasons.length > 0) {
    return { error: targetSizeReasons.join(" ") };
  }
  materializeAutoresearchWorkspace(context.state.targetPath, workspacePath);
  const evaluation = createAutoresearchHumanGatedEvaluation(context, workspacePath, reasons);
  const state = updateAutoresearchState(context.state, {
    phase: "baselined",
    baseline: evaluation,
    nextAction: "Human-gated arena recorded. Inspect dashboard and use normal QUBE review before any promotion."
  });
  writeJsonFile(path.join(context.runDirectory, "baseline.json"), evaluation);
  writeJsonFile(path.join(context.runDirectory, "state.json"), state);
  writeAutoresearchDashboard({ ...context, state });
  return {
    payload: {
      action: "baseline",
      runId: state.runId,
      phase: state.phase,
      evaluation,
      blockers: reasons,
      continuation: createAutoresearchContinuation({ ...context, state }),
      nextAction: state.nextAction
    }
  };
}

function runAutoresearchCandidate(
  context: AutoresearchContext,
  dryRun: boolean
): { readonly payload: Readonly<Record<string, unknown>> } | { readonly error: string } {
  if (!context.state.baseline) {
    return { error: "Run qube autoresearch baseline before executing candidates." };
  }
  if (!isCommandMetricEvaluator(context.evaluator)) {
    return { error: "Autoresearch run requires a trustworthy automated command evaluator. This arena is human-gated; inspect status/dashboard and use normal QUBE review instead of faking objective progress." };
  }
  if (context.evaluator.acceptancePolicy.promotionRequiresHuman) {
    return { error: "Autoresearch run is human-gated by evaluator policy; inspect status/dashboard and use normal QUBE review instead of faking objective progress." };
  }
  const workspacePath = autoresearchWorkspacePath(context);
  if (!existsSync(workspacePath)) {
    return { error: `Autoresearch sandbox workspace is missing: ${workspacePath}. Run baseline again with a new arena.` };
  }
  const candidateNumber = context.state.attempts.length + 1;
  const candidateId = `candidate-${String(candidateNumber).padStart(3, "0")}`;
  const candidateDirectory = path.join(context.runDirectory, "sandbox", "candidates", candidateId);
  const candidateWorkspacePath = path.join(candidateDirectory, "workspace");
  const artifactPath = path.join(candidateDirectory, "artifact.md");
  const baseWorkspacePath = context.state.currentBest ? autoresearchCurrentBestWorkspacePath(context) : autoresearchBaselineWorkspacePath(context);
  const currentScore = context.state.currentBest?.evaluation.score ?? context.state.baseline.score;
  const workspaceSizeReasons = [
    ...validateAutoresearchWorkspaceSize(workspacePath, "Autoresearch sandbox workspace"),
    ...validateAutoresearchWorkspaceSize(baseWorkspacePath, "Autoresearch current-best workspace")
  ];
  if (workspaceSizeReasons.length > 0) {
    if (dryRun) {
      return {
        payload: {
          action: "run",
          runId: context.state.runId,
          phase: context.state.phase,
          planned: true,
          candidateId,
          workspacePath,
          candidateWorkspacePath,
          changedFiles: [],
          currentScore,
          workspaceLimits: autoresearchWorkspaceLimitSummary(),
          evaluatorProvenance: autoresearchEvaluatorProvenance(context),
          blockers: workspaceSizeReasons,
          nextAction: "Reduce the autoresearch workspace size before evaluating a candidate."
        }
      };
    }
    return { error: workspaceSizeReasons.join(" ") };
  }
  const changes = collectAutoresearchWorkspaceChanges(baseWorkspacePath, workspacePath);
  const changedFiles = changes.map(change => change.path);
  if (dryRun) {
    return {
      payload: {
        action: "run",
        runId: context.state.runId,
        phase: context.state.phase,
        planned: true,
        candidateId,
        workspacePath,
        candidateWorkspacePath,
        changedFiles,
        currentScore,
        workspaceLimits: autoresearchWorkspaceLimitSummary(),
        evaluatorProvenance: autoresearchEvaluatorProvenance(context),
        blockers: validateAutoresearchCandidateBoundary(context, changes),
        nextAction: `Run qube autoresearch run --run ${context.state.runId} without --dry-run to evaluate ${candidateId}.`
      }
    };
  }
  copyAutoresearchWorkspace(workspacePath, candidateWorkspacePath);
  const boundaryReasons = validateAutoresearchCandidateBoundary(context, changes);
  const evaluation = boundaryReasons.length > 0
    ? createAutoresearchRejectedEvaluation(context, candidateWorkspacePath, currentScore, boundaryReasons)
    : evaluateAutoresearchCommand(context, candidateWorkspacePath);
  const improved = evaluation.referee?.status === "passed" && isAutoresearchScoreImproved(context.evaluator, evaluation.score, currentScore);
  const accepted = improved && boundaryReasons.length === 0;
  const referee = evaluation.referee?.status === "rejected"
    ? evaluation.referee
    : runAiqAutoresearchReferee(
      context,
      evaluation,
      accepted ? [] : [`Candidate score ${evaluation.score} did not improve current best ${currentScore}.`]
    );
  const candidateEvaluation = { ...evaluation, referee };
  const artifact = renderAutoresearchArtifact(context.state, context.evaluator, candidateId, candidateEvaluation, referee);
  const candidate: AutoresearchCandidate = {
    id: candidateId,
    workspacePath: candidateWorkspacePath,
    artifactPath,
    changedFiles,
    evaluation: candidateEvaluation,
    accepted,
    referee,
    owner: {
      execution: "aie",
      evaluation: "aiq",
      continuation: "aiu"
    }
  };
  const attempts = [...context.state.attempts, candidate];
  const state = updateAutoresearchState(context.state, {
    phase: "ran",
    attempts,
    currentBest: accepted ? candidate : context.state.currentBest,
    nextAction: accepted
      ? `Run qube autoresearch promote --run ${context.state.runId} when you are ready to apply the selected candidate.`
      : `Inspect ${candidateId}, then run qube autoresearch run --run ${context.state.runId} again.`
  });
  if (!dryRun) {
    mkdirSync(candidateDirectory, { recursive: true });
    writeFileSync(artifactPath, artifact, "utf8");
    writeJsonFile(path.join(candidateDirectory, "evaluation.json"), candidateEvaluation);
    writeJsonFile(path.join(candidateDirectory, "referee.json"), referee);
    if (accepted) {
      copyAutoresearchWorkspace(candidateWorkspacePath, autoresearchCurrentBestWorkspacePath(context));
    } else {
      restoreAutoresearchWorkspace(context, workspacePath);
    }
    appendFileSync(path.join(context.runDirectory, "attempts.jsonl"), `${JSON.stringify(candidate)}\n`, "utf8");
    writeJsonFile(path.join(context.runDirectory, "state.json"), state);
    writeAutoresearchDashboard({ ...context, state });
  }
  return {
    payload: {
      action: "run",
      runId: state.runId,
      phase: state.phase,
      candidate,
      currentBest: state.currentBest,
      nextAction: state.nextAction
    }
  };
}

function promoteAutoresearch(
  context: AutoresearchContext,
  request: AutoresearchRequest,
  environment: CliEnvironment,
  dryRun: boolean
): { readonly payload: Readonly<Record<string, unknown>> } | { readonly error: string } {
  if (context.evaluator.acceptancePolicy.promotionRequiresHuman) {
    return { error: "Autoresearch promotion is human-gated by evaluator policy. Use the evidence package and normal QUBE review before promoting changes." };
  }
  const best = context.state.currentBest;
  if (!best) {
    return { error: "No accepted autoresearch candidate is available to promote." };
  }
  const outputPath = request.flags.output
    ? path.resolve(environment.cwd, request.flags.output)
    : path.join(context.state.targetPath, "autoresearch-result.md");
  const mutableSurfaceError = validateAutoresearchPromotionOutput(context, outputPath);
  if (mutableSurfaceError) {
    return { error: mutableSurfaceError };
  }
  if (existsSync(outputPath) && !request.flags.force) {
    return { error: `Promotion output already exists: ${outputPath}. Pass --force to replace it.` };
  }
  const sourcePath = validateAutoresearchCandidateArtifact(context, best);
  if (typeof sourcePath !== "string") {
    return sourcePath;
  }
  const promotion: AutoresearchPromotion = {
    candidateId: best.id,
    outputPath,
    sourcePath,
    promotedAt: new Date().toISOString()
  };
  const state = updateAutoresearchState(context.state, {
    phase: "promoted",
    promoted: promotion,
    nextAction: "Promotion complete. Review the output and keep the autoresearch evidence with the run."
  });
  if (!dryRun) {
    mkdirSync(path.dirname(outputPath), { recursive: true });
    copyFileSync(sourcePath, outputPath);
    writeJsonFile(path.join(context.runDirectory, "promotion.json"), promotion);
    writeJsonFile(path.join(context.runDirectory, "state.json"), state);
    writeAutoresearchDashboard({ ...context, state });
  }
  return {
    payload: {
      action: "promote",
      runId: state.runId,
      phase: state.phase,
      promotion,
      nextAction: state.nextAction
    }
  };
}

function validateAutoresearchPromotionOutput(context: AutoresearchContext, outputPath: string): string | undefined {
  const output = path.resolve(outputPath);
  const targetRoot = path.resolve(context.state.targetPath);
  const realTargetRoot = realpathSync(targetRoot);
  const realOutputAnchor = realAutoresearchOutputAnchor(output);
  const allowedSurfaces = context.arena.mutableSurfaces.filter(surface => (
    surface.kind === "directory"
    && surface.permission === "read-write"
    && isPathInside(targetRoot, path.resolve(surface.path))
    && existsSync(surface.path)
    && isPathInside(realTargetRoot, realpathSync(surface.path))
  ));
  if (allowedSurfaces.some(surface => {
    const surfacePath = path.resolve(surface.path);
    const realSurfacePath = realpathSync(surfacePath);
    return isPathInside(surfacePath, output) && isPathInside(realSurfacePath, realOutputAnchor);
  })) {
    return undefined;
  }
  const surfaces = allowedSurfaces.map(surface => surface.path).join(", ");
  return `Promotion output is outside declared mutable surfaces: ${output}. Allowed surfaces: ${surfaces || "none"}.`;
}

function realAutoresearchOutputAnchor(outputPath: string): string {
  if (existsSync(outputPath)) {
    return realpathSync(outputPath);
  }
  let currentPath = path.dirname(outputPath);
  while (!existsSync(currentPath)) {
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return realpathSync(parentPath);
    }
    currentPath = parentPath;
  }
  return realpathSync(currentPath);
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  const relativePath = path.relative(root, candidate);
  return relativePath === "" || (relativePath.length > 0 && !relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

interface AutoresearchContext {
  readonly runDirectory: string;
  readonly state: AutoresearchState;
  readonly evaluator: AutoresearchEvaluator;
  readonly arena: AutoresearchArena;
}

function validateAutoresearchCandidateArtifact(
  context: AutoresearchContext,
  candidate: AutoresearchCandidate
): string | { readonly error: string } {
  const sandboxDirectory = path.join(context.runDirectory, "sandbox", "candidates");
  const artifactPath = path.resolve(candidate.artifactPath);
  if (!existsSync(sandboxDirectory)) {
    return { error: `Autoresearch candidate sandbox is missing: ${sandboxDirectory}.` };
  }
  if (!existsSync(artifactPath)) {
    return { error: `Selected autoresearch candidate artifact is missing: ${artifactPath}.` };
  }
  const realSandboxDirectory = realpathSync(sandboxDirectory);
  const realArtifactPath = realpathSync(artifactPath);
  const relativeArtifactPath = path.relative(realSandboxDirectory, realArtifactPath);
  if (relativeArtifactPath.startsWith("..") || path.isAbsolute(relativeArtifactPath)) {
    return { error: "Selected autoresearch candidate artifact is outside the sandbox. Refusing promotion." };
  }
  if (!statSync(realArtifactPath).isFile()) {
    return { error: `Selected autoresearch candidate artifact is not a file: ${realArtifactPath}.` };
  }
  return realArtifactPath;
}

function parseAutoresearchArgs(args: readonly string[]):
  | { readonly request: AutoresearchRequest }
  | { readonly error: CliExecution } {
  const flags: { json: boolean; dryRun: boolean; force: boolean; runId?: string; output?: string } = {
    json: false,
    dryRun: false,
    force: false
  };
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) continue;
    if (token === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (token === "--json") {
      flags.json = true;
      continue;
    }
    if (token === "--dry-run") {
      flags.dryRun = true;
      continue;
    }
    if (token === "--force") {
      flags.force = true;
      continue;
    }
    const option = parseAutoresearchOption(args, index);
    if (option?.kind === "missing-value") {
      return { error: autoresearchError(`Missing value for autoresearch option --${option.key}.`, hasTopLevelJsonFlag(args)) };
    }
    if (option?.kind === "parsed") {
      if (option.key === "run") flags.runId = option.value;
      if (option.key === "output") flags.output = option.value;
      index = option.nextIndex;
      continue;
    }
    if (token.startsWith("-")) {
      return { error: autoresearchError(`Unknown autoresearch flag: ${token}`, hasTopLevelJsonFlag(args)) };
    }
    positionals.push(token);
  }

  const [first, ...rest] = positionals;
  if (first && isAutoresearchCommand(first)) {
    if (first !== "init") {
      if (flags.runId && rest.length > 0) {
        return { error: autoresearchError(`Autoresearch ${first} accepts either --run <id> or one positional run id, not both.`, hasTopLevelJsonFlag(args)) };
      }
      if (rest.length > 1) {
        return { error: autoresearchError(`Autoresearch ${first} accepts at most one positional run id.`, hasTopLevelJsonFlag(args)) };
      }
    }
    return { request: { command: first, compact: false, args: rest, flags } };
  }
  if (first) {
    return { request: { command: "init", compact: true, args: positionals, flags } };
  }
  return { request: { command: "status", compact: false, args: [], flags } };
}

function parseAutoresearchOption(
  args: readonly string[],
  index: number
):
  | { readonly kind: "parsed"; readonly key: "run" | "output"; readonly value: string; readonly nextIndex: number }
  | { readonly kind: "missing-value"; readonly key: "run" | "output" }
  | undefined {
  const token = args[index];
  if (!token) return undefined;
  for (const key of ["run", "output"] as const) {
    const flag = `--${key}`;
    if (token.startsWith(`${flag}=`)) {
      return { kind: "parsed", key, value: token.slice(flag.length + 1), nextIndex: index };
    }
    if (token === flag) {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { kind: "missing-value", key };
      }
      return { kind: "parsed", key, value, nextIndex: index + 1 };
    }
  }
  return undefined;
}

function isAutoresearchCommand(value: string): value is AutoresearchCommandName {
  return value === "init" || value === "baseline" || value === "run" || value === "status" || value === "dashboard" || value === "promote";
}

function autoresearchError(message: string, json: boolean): CliExecution {
  if (json) {
    return {
      exitCode: 2,
      stdout: `${JSON.stringify({
        ok: false,
        command: "autoresearch",
        error: {
          kind: "invalid-command-usage",
          likelyCause: message,
          suggestedNextAction: "Run `qube autoresearch --help` and retry with a supported local directory target.",
          category: "usage",
          exitCode: 2
        }
      })}\n`,
      stderr: ""
    };
  }
  return { exitCode: 2, stdout: "", stderr: `${message}\n` };
}

function autoresearchRoot(environment: CliEnvironment): string {
  return path.join(environment.cwd, ".qube", "autoresearch");
}

function autoresearchRunDirectory(environment: CliEnvironment, runId: string): string {
  return path.join(autoresearchRoot(environment), "runs", runId);
}

function autoresearchLatestPath(environment: CliEnvironment): string {
  return path.join(autoresearchRoot(environment), "latest.json");
}

function loadAutoresearchContext(environment: CliEnvironment, runIdInput: string | undefined): AutoresearchContext | { readonly error: string } {
  const runId = runIdInput ?? readLatestAutoresearchRunId(environment);
  if (!runId) {
    return { error: "No autoresearch run selected. Run `qube autoresearch init <target> <goal>` first or pass --run <id>." };
  }
  const runDirectory = autoresearchRunDirectory(environment, runId);
  const statePath = path.join(runDirectory, "state.json");
  const evaluatorPath = path.join(runDirectory, "evaluator.json");
  const arenaPath = path.join(runDirectory, "arena.json");
  if (!existsSync(statePath) || !existsSync(evaluatorPath) || !existsSync(arenaPath)) {
    return { error: `Autoresearch run ${runId} is missing required state files.` };
  }
  return {
    runDirectory,
    state: readJsonFile<AutoresearchState>(statePath),
    evaluator: readJsonFile<AutoresearchEvaluator>(evaluatorPath),
    arena: readJsonFile<AutoresearchArena>(arenaPath)
  };
}

function readLatestAutoresearchRunId(environment: CliEnvironment): string | undefined {
  const latestPath = autoresearchLatestPath(environment);
  if (!existsSync(latestPath)) return undefined;
  const latest = readJsonFile<{ runId?: string }>(latestPath);
  return typeof latest.runId === "string" && latest.runId.length > 0 ? latest.runId : undefined;
}

function validateAutoresearchEvaluator(state: AutoresearchState, evaluator: AutoresearchEvaluator): string | undefined {
  const hash = hashAutoresearchEvaluator(evaluator);
  if (evaluator.hash !== hash || state.evaluatorHash !== hash) {
    return "Autoresearch evaluator changed after arena creation. Refusing to continue until a new arena is initialized.";
  }
  return undefined;
}

function hashAutoresearchEvaluator(evaluator: AutoresearchEvaluator): string {
  const { hash: _hash, ...hashable } = evaluator;
  return createHash("sha256").update(stableJson(hashable)).digest("hex");
}

function createAutoresearchRunId(goal: string, timestamp: string): string {
  const compactTime = timestamp.replace(/\D/g, "").slice(0, 14);
  return `${compactTime}-${hashText(goal).slice(0, 8)}`;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter(key => record[key] !== undefined).map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function createAutoresearchArena(
  state: AutoresearchState,
  evaluator: AutoresearchEvaluator,
  runDirectory: string,
  synthesizedArena: AutoresearchArena
): AutoresearchArena {
  return {
    ...synthesizedArena,
    schemaVersion: 1,
    runId: state.runId,
    goal: state.goal,
    evaluator: {
      kind: evaluator.kind,
      owner: evaluator.owner,
      hash: evaluator.hash,
      objective: evaluator.objective,
      signals: evaluator.signals
    },
    safety: {
      ...synthesizedArena.safety,
      evaluatorFixedBeforeRun: true,
      targetMutationBeforePromote: false,
      sandboxDirectory: path.join(runDirectory, "sandbox"),
      promotionExplicit: true,
      stateDirectory: runDirectory
    },
    lifecycle: ["init", "baseline", "run", "status", "dashboard", "promote"]
  };
}

function createAutoresearchDirectories(runDirectory: string): void {
  for (const directory of [
    runDirectory,
    path.join(runDirectory, "sandbox", "workspace"),
    path.join(runDirectory, "sandbox", "candidates"),
    path.join(runDirectory, "outputs"),
    path.join(runDirectory, "logs")
  ]) {
    mkdirSync(directory, { recursive: true });
  }
}

function autoresearchStateLayout(runDirectory: string): Readonly<Record<string, string>> {
  return {
    arena: path.join(runDirectory, "arena.json"),
    arenaMarkdown: path.join(runDirectory, "arena.md"),
    evaluator: path.join(runDirectory, "evaluator.json"),
    state: path.join(runDirectory, "state.json"),
    attempts: path.join(runDirectory, "attempts.jsonl"),
    dashboard: path.join(runDirectory, "dashboard.html"),
    dashboardData: path.join(runDirectory, "dashboard-data.json"),
    sandbox: path.join(runDirectory, "sandbox")
  };
}

function summarizeAutoresearchTarget(state: AutoresearchState): string {
  if (!existsSync(state.targetPath)) {
    return `Missing directory target planned for ${state.targetPath}.`;
  }
  const entries = readdirSync(state.targetPath).slice(0, 50).join("\n");
  return `Directory target: ${state.targetPath}\nEntries:\n${entries}`;
}

function isCommandMetricEvaluator(evaluator: AutoresearchEvaluator): evaluator is AutoresearchEvaluator & { readonly command: string } {
  return evaluator.kind === "command-metric" && typeof evaluator.command === "string" && evaluator.command.trim().length > 0;
}

function autoresearchWorkspacePath(context: AutoresearchContext): string {
  return path.join(context.runDirectory, "sandbox", "workspace");
}

function autoresearchBaselineWorkspacePath(context: AutoresearchContext): string {
  return path.join(context.runDirectory, "sandbox", "baseline", "workspace");
}

function autoresearchCurrentBestWorkspacePath(context: AutoresearchContext): string {
  return path.join(context.runDirectory, "sandbox", "current-best", "workspace");
}

function materializeAutoresearchWorkspace(targetPath: string, workspacePath: string): void {
  copyAutoresearchWorkspace(targetPath, workspacePath);
}

function copyAutoresearchWorkspace(sourcePath: string, destinationPath: string): void {
  const sizeReasons = validateAutoresearchWorkspaceSize(sourcePath, "Autoresearch workspace copy source");
  if (sizeReasons.length > 0) {
    throw new Error(sizeReasons.join(" "));
  }
  rmSync(destinationPath, { recursive: true, force: true });
  mkdirSync(destinationPath, { recursive: true });
  for (const entry of readdirSync(sourcePath, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || isIgnoredAutoresearchEntry(entry.name)) {
      continue;
    }
    const sourceEntry = path.join(sourcePath, entry.name);
    const destinationEntry = path.join(destinationPath, entry.name);
    const sourceRoot = sourceEntry;
    cpSync(sourceEntry, destinationEntry, {
      recursive: true,
      force: true,
      verbatimSymlinks: false,
      filter(source) {
        try {
          if (lstatSync(source).isSymbolicLink()) return false;
        } catch {
          return false;
        }
        const relativeParts = path.relative(sourceRoot, source).split(path.sep).filter(Boolean);
        return !relativeParts.some(part => isIgnoredAutoresearchEntry(part));
      }
    });
  }
}

function restoreAutoresearchWorkspace(context: AutoresearchContext, workspacePath: string): void {
  const currentBestPath = context.state.currentBest ? autoresearchCurrentBestWorkspacePath(context) : autoresearchBaselineWorkspacePath(context);
  copyAutoresearchWorkspace(currentBestPath, workspacePath);
}

function isIgnoredAutoresearchEntry(name: string): boolean {
  return name === ".git" || name === ".qube" || name === "node_modules" || name === "dist" || name === "build";
}

const autoresearchWorkspaceMaxFiles = 2_000;
const autoresearchWorkspaceMaxBytes = 50 * 1024 * 1024;

function autoresearchWorkspaceLimitSummary(): Readonly<Record<string, number>> {
  return {
    maxFiles: autoresearchWorkspaceMaxFiles,
    maxBytes: autoresearchWorkspaceMaxBytes
  };
}

function validateAutoresearchWorkspaceSize(rootPath: string, label: string): readonly string[] {
  return scanAutoresearchWorkspace(rootPath, label).reasons;
}

function scanAutoresearchWorkspace(rootPath: string, label: string): AutoresearchWorkspaceScan {
  let fileCount = 0;
  let totalBytes = 0;
  const reasons: string[] = [];
  if (!existsSync(rootPath)) {
    return { fileCount, totalBytes, reasons };
  }
  const visit = (directoryPath: string): void => {
    if (reasons.length > 0) return;
    for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
      if (isIgnoredAutoresearchEntry(entry.name)) continue;
      const entryPath = path.join(directoryPath, entry.name);
      let stats;
      try {
        stats = lstatSync(entryPath);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        visit(entryPath);
        if (reasons.length > 0) return;
        continue;
      }
      if (!stats.isFile()) continue;
      fileCount += 1;
      totalBytes += stats.size;
      if (fileCount > autoresearchWorkspaceMaxFiles) {
        reasons.push(`${label} has ${fileCount} files, exceeding the autoresearch limit of ${autoresearchWorkspaceMaxFiles} files.`);
        return;
      }
      if (totalBytes > autoresearchWorkspaceMaxBytes) {
        reasons.push(`${label} has ${formatAutoresearchBytes(totalBytes)}, exceeding the autoresearch limit of ${formatAutoresearchBytes(autoresearchWorkspaceMaxBytes)}.`);
        return;
      }
    }
  };
  visit(rootPath);
  return { fileCount, totalBytes, reasons };
}

function formatAutoresearchBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${Math.round(kib)} KiB`;
  return `${Math.round(kib / 1024)} MiB`;
}

function collectAutoresearchWorkspaceChanges(basePath: string, candidatePath: string): readonly AutoresearchWorkspaceChange[] {
  const baseFiles = collectAutoresearchFileHashes(basePath);
  const candidateFiles = collectAutoresearchFileHashes(candidatePath);
  const paths = [...new Set([...baseFiles.keys(), ...candidateFiles.keys()])].sort();
  const changes: AutoresearchWorkspaceChange[] = [];
  for (const relativePath of paths) {
    const base = baseFiles.get(relativePath);
    const candidate = candidateFiles.get(relativePath);
    if (base === candidate) continue;
    if (candidate === undefined) {
      changes.push({ path: relativePath, kind: "deleted" });
      continue;
    }
    if (candidate === "symlink") {
      changes.push({ path: relativePath, kind: "symlink" });
      continue;
    }
    changes.push({ path: relativePath, kind: base === undefined ? "added" : "modified" });
  }
  return changes;
}

function collectAutoresearchFileHashes(rootPath: string): Map<string, string> {
  const files = new Map<string, string>();
  if (!existsSync(rootPath)) return files;
  const visit = (directoryPath: string): void => {
    for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
      if (isIgnoredAutoresearchEntry(entry.name)) continue;
      const entryPath = path.join(directoryPath, entry.name);
      const relativePath = path.relative(rootPath, entryPath);
      if (entry.isSymbolicLink()) {
        files.set(relativePath, "symlink");
        continue;
      }
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (entry.isFile()) {
        files.set(relativePath, createHash("sha256").update(readFileSync(entryPath)).digest("hex"));
      }
    }
  };
  visit(rootPath);
  return files;
}

function validateAutoresearchCandidateBoundary(
  context: AutoresearchContext,
  changes: readonly AutoresearchWorkspaceChange[]
): readonly string[] {
  if (changes.length === 0) {
    return ["Candidate workspace has no changed files to evaluate."];
  }
  const reasons: string[] = [];
  const allowedSurfacePaths = allowedAutoresearchWorkspaceSurfaces(context);
  if (allowedSurfacePaths.length === 0) {
    reasons.push("Arena has no declared read-write mutable surfaces for candidate changes.");
  }
  for (const change of changes) {
    const candidatePath = path.resolve(autoresearchWorkspacePath(context), change.path);
    const allowed = allowedSurfacePaths.some(surfacePath => isPathInside(surfacePath, candidatePath));
    if (!allowed) {
      reasons.push(`Candidate change ${change.path} is outside declared mutable surfaces.`);
    }
    if (change.kind === "symlink") {
      reasons.push(`Candidate change ${change.path} is a symbolic link, which is not allowed in autoresearch workspaces.`);
    }
  }
  return reasons;
}

function allowedAutoresearchWorkspaceSurfaces(context: AutoresearchContext): readonly string[] {
  const targetRoot = path.resolve(context.state.targetPath);
  const workspaceRoot = autoresearchWorkspacePath(context);
  const surfaces: string[] = [];
  for (const surface of context.arena.mutableSurfaces) {
    if (surface.kind !== "directory" || surface.permission !== "read-write") continue;
    const surfacePath = path.resolve(surface.path);
    if (!isPathInside(targetRoot, surfacePath)) continue;
    surfaces.push(path.resolve(workspaceRoot, path.relative(targetRoot, surfacePath)));
  }
  return surfaces;
}

function createAutoresearchRejectedEvaluation(
  context: AutoresearchContext,
  workspacePath: string,
  score: number,
  reasons: readonly string[]
): AutoresearchEvaluation {
  const referee = runAiqAutoresearchReferee(context, {
    exitCode: null,
    score,
    stdout: "",
    stderr: ""
  }, reasons);
  return {
    score,
    matchedTerms: [],
    missingTerms: [],
    evaluatorHash: context.evaluator.hash,
    summary: `Candidate rejected before evaluator command: ${referee.reasons.join(" ")}`,
    command: context.evaluator.command,
    exitCode: null,
    stdout: "",
    stderr: "",
    durationMs: 0,
    workspacePath,
    referee,
    recordedAt: new Date().toISOString()
  };
}

function createAutoresearchHumanGatedEvaluation(
  context: AutoresearchContext,
  workspacePath: string,
  reasons: readonly string[]
): AutoresearchEvaluation {
  const referee: AutoresearchReferee = {
    owner: "aiq",
    boundary: "aiq-fixed-evaluator",
    status: "rejected",
    reasons,
    evaluatorImmutable: validateAutoresearchEvaluator(context.state, context.evaluator) === undefined,
    gatesPassed: false,
    antiGamingPassed: true,
    provenance: {
      evaluatorHash: context.evaluator.hash,
      command: context.evaluator.command,
      evidenceRequired: context.evaluator.acceptancePolicy.evidenceRequired
    }
  };
  return {
    score: 0,
    matchedTerms: [],
    missingTerms: [],
    evaluatorHash: context.evaluator.hash,
    summary: `Human-gated evaluator recorded without automated score: ${reasons.join(" ")}`,
    command: context.evaluator.command,
    exitCode: null,
    stdout: "",
    stderr: "",
    durationMs: 0,
    workspacePath,
    referee,
    recordedAt: new Date().toISOString()
  };
}

const autoresearchEvidenceOutputLimit = 16_000;

function evaluateAutoresearchCommand(context: AutoresearchContext, workspacePath: string): AutoresearchEvaluation {
  const started = Date.now();
  const result = spawnSync(context.evaluator.command ?? "", [], {
    cwd: workspacePath,
    shell: true,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    env: { ...process.env, QUBE_AUTORESEARCH: "1" }
  });
  const durationMs = Date.now() - started;
  const rawStdout = result.stdout ?? "";
  const rawStderr = result.stderr ?? "";
  const stdout = limitAutoresearchOutput(rawStdout);
  const stderr = limitAutoresearchOutput(rawStderr);
  const score = parseAutoresearchScore(rawStdout);
  const reasons: string[] = [];
  if (result.error) reasons.push(result.error.message);
  if (score === null) reasons.push("Evaluator command did not emit a scalar score.");
  if (rawStdout.length > autoresearchEvidenceOutputLimit || rawStderr.length > autoresearchEvidenceOutputLimit) {
    reasons.push("Evaluator output exceeded bounded evidence limits.");
  }
  const referee = runAiqAutoresearchReferee(context, {
    exitCode: result.status,
    score: score ?? 0,
    stdout,
    stderr
  }, reasons);
  return {
    score: score ?? 0,
    matchedTerms: [],
    missingTerms: [],
    evaluatorHash: context.evaluator.hash,
    summary: referee.status === "passed"
      ? `Evaluator command produced score ${score}.`
      : `Evaluator command rejected: ${referee.reasons.join(" ")}`,
    command: context.evaluator.command,
    exitCode: result.status,
    stdout,
    stderr,
    durationMs,
    workspacePath,
    outputTruncated: rawStdout !== stdout || rawStderr !== stderr,
    referee,
    recordedAt: new Date().toISOString()
  };
}

function limitAutoresearchOutput(text: string): string {
  if (text.length <= autoresearchEvidenceOutputLimit) return text;
  return `${text.slice(0, autoresearchEvidenceOutputLimit)}\n[truncated ${text.length - autoresearchEvidenceOutputLimit} bytes]\n`;
}

function parseAutoresearchScore(stdout: string): number | null {
  const text = stdout.trim();
  if (text.length === 0) return null;
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const line of [...lines].reverse()) {
    const scalar = Number(line);
    if (Number.isFinite(scalar)) return scalar;
    try {
      const parsed = JSON.parse(line) as unknown;
      const score = readAutoresearchScore(parsed);
      if (score !== null) return score;
    } catch {
      // Continue scanning earlier lines.
    }
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return readAutoresearchScore(parsed);
  } catch {
    return null;
  }
}

function readAutoresearchScore(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["score", "metric", "value", "result"]) {
    const candidate = record[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return null;
}

function runAiqAutoresearchReferee(
  context: AutoresearchContext,
  evaluation: Pick<AutoresearchEvaluation, "score" | "exitCode" | "stdout" | "stderr">,
  extraReasons: readonly string[] = []
): AutoresearchReferee {
  const evaluatorImmutable = validateAutoresearchEvaluator(context.state, context.evaluator) === undefined;
  const gatesPassed = evaluation.exitCode === 0;
  const antiGamingPassed = evaluation.stdout !== undefined && evaluation.stdout.length < 64_000 && (evaluation.stderr?.length ?? 0) < 64_000;
  const reasons = [
    ...(!evaluatorImmutable ? ["Evaluator hash changed after arena creation."] : []),
    ...(!gatesPassed ? [`Evaluator command exited with ${evaluation.exitCode ?? "unknown status"}.`] : []),
    ...(!antiGamingPassed ? ["Evaluator output exceeded bounded evidence limits."] : []),
    ...extraReasons
  ];
  return {
    owner: "aiq",
    boundary: "aiq-fixed-evaluator",
    status: reasons.length === 0 ? "passed" : "rejected",
    reasons,
    evaluatorImmutable,
    gatesPassed,
    antiGamingPassed,
    provenance: {
      evaluatorHash: context.evaluator.hash,
      command: context.evaluator.command,
      evidenceRequired: context.evaluator.acceptancePolicy.evidenceRequired
    }
  };
}

function isAutoresearchScoreImproved(evaluator: AutoresearchEvaluator, score: number, currentScore: number): boolean {
  const improved = evaluator.direction === "minimize" ? score < currentScore : score > currentScore;
  if (evaluator.acceptancePolicy.mode === "threshold" && typeof evaluator.acceptancePolicy.threshold === "number") {
    const thresholdPassed = evaluator.direction === "minimize"
      ? score <= evaluator.acceptancePolicy.threshold
      : score >= evaluator.acceptancePolicy.threshold;
    return thresholdPassed && improved;
  }
  return improved;
}

function renderAutoresearchArtifact(
  state: AutoresearchState,
  evaluator: AutoresearchEvaluator,
  candidateId: string,
  evaluation: AutoresearchEvaluation,
  referee: AutoresearchReferee
): string {
  return [
    `# Autoresearch Candidate ${candidateId}`,
    "",
    `Target: ${state.target}`,
    `Goal: ${state.goal}`,
    `Evaluator: ${evaluator.kind}`,
    `Command: ${evaluator.command ?? "none"}`,
    `Score: ${evaluation.score}`,
    `Referee: ${referee.status}`,
    "",
    "## Fixed Evaluator Evidence",
    "",
    `- evaluator hash: ${evaluation.evaluatorHash}`,
    `- command exit: ${evaluation.exitCode ?? "unknown"}`,
    `- duration ms: ${evaluation.durationMs ?? 0}`,
    ...referee.reasons.map(reason => `- referee reason: ${reason}`),
    "",
    "## Candidate Output",
    "",
    `This sandboxed candidate was evaluated against ${state.goal}.`,
    "It remains inside the QUBE autoresearch run directory until explicit promotion.",
    "Promotion copies only this selected artifact back to the requested output path."
  ].join("\n") + "\n";
}

function updateAutoresearchState(state: AutoresearchState, patch: Partial<AutoresearchState>): AutoresearchState {
  return { ...state, ...patch, updatedAt: new Date().toISOString() };
}

function summarizeAutoresearch(context: AutoresearchContext, action: string): Readonly<Record<string, unknown>> {
  const activeCandidate = context.state.attempts.at(-1) ?? null;
  return {
    action,
    runId: context.state.runId,
    phase: context.state.phase,
    target: context.state.target,
    targetPath: context.state.targetPath,
    goal: context.state.goal,
    evaluatorHash: context.state.evaluatorHash,
    evaluatorProvenance: autoresearchEvaluatorProvenance(context),
    baseline: context.state.baseline,
    currentBest: context.state.currentBest,
    activeCandidate,
    attempts: context.state.attempts.length,
    attemptHistory: summarizeAutoresearchAttempts(context.state.attempts),
    currentBestTrajectory: autoresearchBestTrajectory(context.state),
    changedSurfaceSummary: summarizeAutoresearchChangedSurfaces(context.state.attempts),
    blockers: autoresearchBlockers(context),
    activeBlocker: autoresearchBlockers(context)[0] ?? null,
    continuation: createAutoresearchContinuation(context),
    promoted: context.state.promoted,
    stateDirectory: context.runDirectory,
    nextAction: context.state.nextAction
  };
}

function autoresearchEvaluatorProvenance(context: AutoresearchContext): Readonly<Record<string, unknown>> {
  return {
    owner: context.evaluator.owner,
    kind: context.evaluator.kind,
    command: context.evaluator.command,
    hash: context.evaluator.hash,
    synthesizedBy: context.evaluator.provenance.synthesizedBy,
    targetKind: context.evaluator.provenance.targetKind,
    acceptancePolicy: context.evaluator.acceptancePolicy,
    aiqBoundary: "aiq-fixed-evaluator"
  };
}

function autoresearchBlockers(context: AutoresearchContext): readonly string[] {
  const blockers: string[] = [];
  const evaluatorError = validateAutoresearchEvaluator(context.state, context.evaluator);
  if (evaluatorError) blockers.push(evaluatorError);
  if (!isCommandMetricEvaluator(context.evaluator)) {
    blockers.push("No trustworthy automated command evaluator is available; this arena is human-gated.");
  }
  if (context.evaluator.acceptancePolicy.promotionRequiresHuman) {
    blockers.push("Autoresearch promotion is human-gated by evaluator policy.");
  }
  if (context.state.baseline?.referee?.status === "rejected") {
    blockers.push(...context.state.baseline.referee.reasons);
  }
  return [...new Set(blockers)];
}

function createAutoresearchContinuation(context: AutoresearchContext): AutoresearchContinuation {
  const blockers = autoresearchBlockers(context);
  const complete = context.state.phase === "promoted";
  const blocked = blockers.length > 0;
  const resumeCommand = complete || blocked ? null : nextAutoresearchResumeCommand(context);
  return {
    owner: "aiu",
    runId: context.state.runId,
    phase: context.state.phase,
    status: complete ? "complete" : blocked ? "blocked" : "ready",
    resumeCommand,
    nextAction: context.state.nextAction,
    blockers,
    activeCandidateId: context.state.attempts.at(-1)?.id ?? null,
    currentBestId: context.state.currentBest?.id ?? null,
    safeToResume: resumeCommand !== null
  };
}

function nextAutoresearchResumeCommand(context: AutoresearchContext): string | null {
  if (!context.state.baseline) return `qube autoresearch baseline --run ${context.state.runId} --json`;
  if (!context.state.currentBest) return `qube autoresearch run --run ${context.state.runId} --json`;
  if (context.state.phase === "ran") return `qube autoresearch run --run ${context.state.runId} --json`;
  return `qube autoresearch status --run ${context.state.runId} --json`;
}

function summarizeAutoresearchAttempts(attempts: readonly AutoresearchCandidate[]): readonly Readonly<Record<string, unknown>>[] {
  return attempts.map(candidate => ({
    id: candidate.id,
    accepted: candidate.accepted,
    score: candidate.evaluation.score,
    changedFiles: candidate.changedFiles,
    refereeStatus: candidate.referee.status,
    refereeReasons: candidate.referee.reasons
  }));
}

function autoresearchBestTrajectory(state: AutoresearchState): readonly Readonly<Record<string, unknown>>[] {
  const trajectory: Readonly<Record<string, unknown>>[] = [];
  if (state.baseline && state.baseline.referee?.status !== "rejected") {
    trajectory.push({ id: "baseline", score: state.baseline.score, accepted: true, recordedAt: state.baseline.recordedAt });
  }
  for (const candidate of state.attempts) {
    if (candidate.accepted) {
      trajectory.push({ id: candidate.id, score: candidate.evaluation.score, accepted: true, recordedAt: candidate.evaluation.recordedAt });
    }
  }
  return trajectory;
}

function summarizeAutoresearchChangedSurfaces(attempts: readonly AutoresearchCandidate[]): Readonly<Record<string, unknown>> {
  const files = [...new Set(attempts.flatMap(candidate => candidate.changedFiles))].sort();
  return {
    totalChangedFiles: files.length,
    files
  };
}

function writeAutoresearchDashboard(context: AutoresearchContext): void {
  const summary = summarizeAutoresearch(context, "dashboard");
  const data = {
    state: context.state,
    evaluator: context.evaluator,
    arena: context.arena,
    summary
  };
  writeJsonFile(path.join(context.runDirectory, "dashboard-data.json"), data);
  const bestScore = context.state.currentBest?.evaluation.score ?? context.state.baseline?.score ?? 0;
  const continuation = createAutoresearchContinuation(context);
  const attempts = summarizeAutoresearchAttempts(context.state.attempts);
  const trajectory = autoresearchBestTrajectory(context.state);
  const changedSurfaces = summarizeAutoresearchChangedSurfaces(context.state.attempts);
  const html = [
    "<!doctype html>",
    "<html><head><meta charset=\"utf-8\"><title>QUBE Autoresearch</title></head>",
    "<style>",
    "*,*::before,*::after{box-sizing:border-box}",
    "body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.45;margin:0;padding:28px clamp(20px,5vw,32px);width:min(960px,100%);overflow-wrap:anywhere;color:#171717;background:#fff}",
    "h1{font-size:clamp(1.75rem,5vw,2.5rem);line-height:1.1;margin:0 0 24px}",
    "h2{font-size:1.4rem;margin:28px 0 12px}",
    "p{margin:0 0 14px}",
    "ul{padding-left:1.25rem}",
    "@media (max-width:480px){body{padding:32px 24px}h1{font-size:1.85rem}}",
    "</style>",
    "<body>",
    `<h1>QUBE Autoresearch ${escapeHtml(context.state.runId)}</h1>`,
    `<p><strong>Phase:</strong> ${escapeHtml(context.state.phase)}</p>`,
    `<p><strong>Goal:</strong> ${escapeHtml(context.state.goal)}</p>`,
    `<p><strong>Current score:</strong> ${bestScore}</p>`,
    `<p><strong>Continuation:</strong> ${escapeHtml(continuation.status)}${continuation.resumeCommand ? ` (${escapeHtml(continuation.resumeCommand)})` : ""}</p>`,
    `<p><strong>Active blocker:</strong> ${escapeHtml(continuation.blockers[0] ?? "none")}</p>`,
    `<p><strong>Next:</strong> ${escapeHtml(context.state.nextAction)}</p>`,
    "<h2>Control Loop</h2>",
    `<p><strong>Current best trajectory:</strong> ${escapeHtml(trajectory.map(point => `${point.id}:${point.score}`).join(" -> ") || "none")}</p>`,
    `<p><strong>Changed surfaces:</strong> ${escapeHtml(`${changedSurfaces.totalChangedFiles} file(s)`)}</p>`,
    "<h2>Attempts</h2>",
    "<ul>",
    ...attempts.map(candidate => `<li>${escapeHtml(String(candidate.id))}: score ${candidate.score}, accepted=${String(candidate.accepted)}, referee=${escapeHtml(String(candidate.refereeStatus))}${Array.isArray(candidate.refereeReasons) && candidate.refereeReasons.length > 0 ? `, reason=${escapeHtml(candidate.refereeReasons.join("; "))}` : ""}</li>`),
    "</ul>",
    "</body></html>"
  ].join("\n");
  writeFileSync(path.join(context.runDirectory, "dashboard.html"), html, "utf8");
}

function renderAutoresearchResult(payload: Readonly<Record<string, unknown>>): string {
  const runId = typeof payload.runId === "string" ? payload.runId : "(none)";
  const action = typeof payload.action === "string" ? payload.action : "status";
  const phase = typeof payload.phase === "string" ? payload.phase : "(unknown)";
  const nextAction = typeof payload.nextAction === "string" ? payload.nextAction : "Inspect autoresearch status.";
  return [
    "QUBE autoresearch",
    "",
    `Action: ${action}`,
    `Run: ${runId}`,
    `Phase: ${phase}`,
    `Next: ${nextAction}`
  ].join("\n") + "\n";
}

function isAutoresearchHelpRequest(args: readonly string[]): boolean {
  const topLevelArgs = topLevelTokens(args);
  return topLevelArgs.includes("--help") || topLevelArgs.includes("-h");
}

function renderAutoresearchHelp(): string {
  return [
    "autoresearch",
    "Run a safety-bounded local autoresearch arena lifecycle.",
    "",
    "Usage:",
    "  qube autoresearch init <target-directory> <goal> [--json] [--dry-run]",
    "  qube autoresearch baseline [--run <id>] [--json] [--dry-run]",
    "  qube autoresearch run [--run <id>] [--json] [--dry-run]",
    "  qube autoresearch status [--run <id>] [--json]",
    "  qube autoresearch dashboard [--run <id>] [--json] [--dry-run]",
    "  qube autoresearch promote [--run <id>] [--output <path>] [--force] [--json] [--dry-run]",
    "  qube autoresearch <target-directory> <goal> [--json] [--dry-run]",
    "",
    "Agent entry:",
    "  When a user asks for autoresearch in natural language, run this help first.",
    "  Translate the request into <target-directory> plus <goal>; do not edit the target before arena synthesis.",
    "  Init uses AIB arena synthesis to classify the target, resolve the local path, design the referee, define mutable surfaces and invariants, and write the fixed arena.",
    "  Ask only blocking clarification questions returned by synthesis; otherwise infer safe defaults from the target.",
    "",
    "Target and goal:",
    "  The first supported target is an existing local directory.",
    "  Remote and provider target kinds route away until a local target exists.",
    "  The goal must be machine-verifiable through a command metric, threshold, finding reduction, fixed rubric, or human-gated promotion policy.",
    "  The compact <target-directory> <goal> form is a safe alias for init only.",
    "",
    "Arena synthesis steps:",
    "  1. Classify the target kind and objective shape.",
    "  2. Resolve the target path and mutable surfaces.",
    "  3. Design the fixed evaluator/referee and acceptance policy.",
    "  4. Persist arena.json, arena.md, evaluator.json, and state.",
    "  5. Baseline, run candidates, inspect status/dashboard, and promote explicitly.",
    "",
    "State:",
    "  Runs write arena.json, arena.md, evaluator.json, state.json, attempts.jsonl, dashboards, logs, and sandbox files under .qube/autoresearch/runs/<run-id>/.",
    "  .qube/autoresearch/latest.json selects the latest run when --run is omitted.",
    "",
    "Safety boundaries:",
    "  init creates the arena and evaluator without target mutation.",
    "  baseline records immutable fixed-evaluator evidence.",
    "  run writes sandboxed candidates under .qube/autoresearch/ and records AIE execution, AIQ evaluation, and AIU continuation ownership.",
    "  promote is the only command that copies the selected best candidate to the target workspace or --output path.",
    "  evaluator.json changes after init stop lifecycle commands until a new arena is created.",
    "",
    "Examples:",
    "  qube autoresearch init ./scratch \"improve notes summary quality\" --json",
    "  qube autoresearch baseline --json",
    "  qube autoresearch run --json",
    "  qube autoresearch status --json",
    "  qube autoresearch dashboard --json",
    "  qube autoresearch promote --output ./scratch/autoresearch-result.md",
    "",
    "Behavior:",
    "  JSON output: supported",
    "  Dry run: supported",
    "  Mutation: local-files",
    "  Supply chain: standard"
  ].join("\n") + "\n";
}

function planOneshot(args: readonly string[], environment: CliEnvironment): CliExecution {
  if (isOneshotHelpRequest(args)) {
    return { exitCode: 0, stdout: renderOneshotHelp(), stderr: "" };
  }
  return runOneshot(args, environment, false);
}

async function executeOneshot(args: readonly string[], environment: CliEnvironment): Promise<RuntimeCommandResult> {
  if (isOneshotHelpRequest(args)) {
    return { exitCode: 0, stdout: renderOneshotHelp() };
  }
  const planned = runOneshot(args, environment, true);
  if (hasTopLevelJsonFlag(args)) {
    return { exitCode: planned.exitCode, jsonStdout: planned.stdout, stderr: planned.stderr };
  }
  return { exitCode: planned.exitCode, stdout: planned.stdout, stderr: planned.stderr };
}

function runOneshot(args: readonly string[], environment: CliEnvironment, mutate: boolean): CliExecution {
  const parsed = parseOneshotArgs(args);
  if ("error" in parsed) {
    return parsed.error;
  }
  const request = parsed.request;
  const dryRun = request.flags.dryRun || (!mutate && request.command === "run");
  const result = executeOneshotRequest(request, environment, dryRun);
  if ("error" in result) {
    return oneshotError(result.error, request.flags.json);
  }
  const payload = { ...result.payload, dryRun };
  if (request.flags.json) {
    return { exitCode: 0, stdout: `${JSON.stringify({ ok: true, command: "oneshot", oneshot: payload })}\n`, stderr: "" };
  }
  return { exitCode: 0, stdout: renderOneshotResult(payload), stderr: "" };
}

function executeOneshotRequest(
  request: OneshotRequest,
  environment: CliEnvironment,
  dryRun: boolean
): { readonly payload: Readonly<Record<string, unknown>> } | { readonly error: string } {
  if (request.command === "run") {
    return runOneshotMission(request, environment, dryRun);
  }
  const context = loadOneshotContext(environment, request.runId);
  if ("error" in context) {
    return context;
  }
  if (request.command === "status" || request.command === "resume" || request.command === "inspect") {
    return { payload: summarizeOneshot(context, request.command) };
  }
  if (request.command === "checks") {
    return { payload: { ...summarizeOneshot(context, "checks"), checks: readJsonFile<readonly OneshotCheck[]>(context.state.checksPath) } };
  }
  if (request.command === "review") {
    return { payload: { ...summarizeOneshot(context, "review"), review: readTextIfPresent(path.join(context.runDirectory, "review.md")) } };
  }
  return { payload: { ...summarizeOneshot(context, "summary"), summary: readTextIfPresent(context.state.summaryPath) } };
}

function runOneshotMission(
  request: OneshotRequest,
  environment: CliEnvironment,
  dryRun: boolean
): { readonly payload: Readonly<Record<string, unknown>> } | { readonly error: string } {
  const idea = request.idea?.trim() ?? "";
  if (idea.length === 0) {
    return { error: "qube oneshot requires an idea or a supported inspection command." };
  }
  const planned = createOneshotPlan(idea, request.flags, environment);
  if ("error" in planned) {
    return planned;
  }
  const { runId, runDirectory, workspaceDirectory, outputDirectory, plan, manifest, state } = planned;
  if (dryRun) {
    return {
      payload: {
        action: "run",
        status: "dry-run-complete",
        runId,
        runDirectory,
        workspaceDirectory,
        outputDirectory,
        plan,
        manifest,
        githubSideEffects: state.githubSideEffects,
        nextAction: `Run qube oneshot ${JSON.stringify(idea)} --kind ${plan.kind} --json to create the local artifact.`
      }
    };
  }
  if (plan.mutationPolicy.targetMode === "existing-target-blocked") {
    return { error: "Existing target mutation is not supported by the first oneshot implementation. Use the default scratch workspace or a new target directory." };
  }
  const outputIssue = validateOneshotOutputPath(request.flags, environment);
  if (outputIssue) {
    return { error: outputIssue };
  }

  createOneshotDirectories(runDirectory);
  writeJsonFile(path.join(runDirectory, "input.json"), {
    schemaVersion: 1,
    idea,
    cwd: environment.cwd,
    flags: request.flags,
    components: qubeComponents.map(component => ({ id: component.id, command: component.command, packageName: component.packageName, packageVersion: component.packageVersion }))
  });
  writeJsonFile(path.join(runDirectory, "manifest.json"), manifest);
  writeJsonFile(path.join(runDirectory, "plan.json"), plan);
  writeFileSync(path.join(runDirectory, "assumptions.md"), renderOneshotAssumptions(plan), "utf8");
  writeFileSync(path.join(runDirectory, "mission.md"), renderOneshotMission(plan, state), "utf8");
  writeFileSync(path.join(runDirectory, "loop.jsonl"), "", "utf8");
  writeFileSync(path.join(runDirectory, "actions.jsonl"), "", "utf8");
  writeFileSync(path.join(runDirectory, "patch.diff"), "", "utf8");
  appendJsonLine(path.join(runDirectory, "loop.jsonl"), { phase: "planned", status: "started", recordedAt: new Date().toISOString() });

  const artifact = plan.kind === "code"
    ? writeOneshotCodeArtifact(plan, state)
    : writeOneshotDocArtifact(plan, state);
  for (const writtenPath of artifact.writtenPaths) {
    appendJsonLine(path.join(runDirectory, "actions.jsonl"), { action: "write", path: writtenPath, recordedAt: new Date().toISOString() });
  }
  const checks = runOneshotChecks(plan, artifact);
  const passed = checks.every(check => check.status === "passed");
  writeJsonFile(state.checksPath, checks);
  writeJsonFile(path.join(runDirectory, "aiq-evidence.json"), renderOneshotEvidence(plan, checks));
  writeFileSync(path.join(runDirectory, "review.md"), renderOneshotReview(plan, checks), "utf8");
  writeFileSync(path.join(runDirectory, "risk.md"), renderOneshotRisk(plan), "utf8");

  const finalArtifactPath = copyOneshotResult(request.flags, environment, plan, artifact);
  const finalState = updateOneshotState(state, {
    status: passed ? "success" : "failed-checks",
    phase: passed ? "finalized" : "blocked",
    artifactPath: finalArtifactPath,
    nextAction: passed ? `Inspect ${state.summaryPath}.` : `Inspect ${state.checksPath} and rerun qube oneshot resume ${runId}.`
  });
  writeFileSync(finalState.summaryPath, renderOneshotSummary(plan, finalState, checks), "utf8");
  writeJsonFile(path.join(runDirectory, "final.json"), {
    schemaVersion: 1,
    runId,
    status: finalState.status,
    artifactPath: finalState.artifactPath,
    summaryPath: finalState.summaryPath,
    checksPath: finalState.checksPath,
    githubSideEffects: finalState.githubSideEffects
  });
  writeJsonFile(path.join(runDirectory, "state.json"), finalState);
  writeJsonFile(oneshotLatestPath(environment), { runId });
  appendJsonLine(path.join(runDirectory, "loop.jsonl"), { phase: finalState.phase, status: finalState.status, recordedAt: finalState.updatedAt });

  return {
    payload: {
      action: "run",
      runId,
      status: finalState.status,
      artifactPath: finalState.artifactPath,
      summaryPath: finalState.summaryPath,
      checks,
      githubSideEffects: finalState.githubSideEffects,
      nextAction: finalState.nextAction
    }
  };
}

function parseOneshotArgs(args: readonly string[]):
  | { readonly request: OneshotRequest }
  | { readonly error: CliExecution } {
  const flags: {
    json: boolean;
    dryRun: boolean;
    apply: boolean;
    forceOutput: boolean;
    kind: OneshotKind;
    agent: OneshotAgent;
    quality: OneshotQuality;
    maxIterations: number;
    target?: string;
    output?: string;
  } = {
    json: false,
    dryRun: false,
    apply: false,
    forceOutput: false,
    kind: "auto",
    agent: "auto",
    quality: "standard",
    maxIterations: 8
  };
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token) continue;
    if (token === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (token === "--json") {
      flags.json = true;
      continue;
    }
    if (token === "--dry-run") {
      flags.dryRun = true;
      continue;
    }
    if (token === "--apply") {
      flags.apply = true;
      continue;
    }
    if (token === "--force-output") {
      flags.forceOutput = true;
      continue;
    }
    const option = parseOneshotOption(args, index);
    if (option?.kind === "missing-value") {
      return { error: oneshotError(`Missing value for oneshot option --${option.key}.`, hasTopLevelJsonFlag(args)) };
    }
    if (option?.kind === "parsed") {
      const validation = assignOneshotOption(flags, option.key, option.value);
      if (validation) {
        return { error: oneshotError(validation, hasTopLevelJsonFlag(args)) };
      }
      index = option.nextIndex;
      continue;
    }
    if (token.startsWith("-")) {
      return { error: oneshotError(`Unknown oneshot flag: ${token}`, hasTopLevelJsonFlag(args)) };
    }
    positionals.push(token);
  }

  const [first, ...rest] = positionals;
  if (first && isOneshotCommand(first)) {
    if (first === "run") {
      if (rest.length === 0) {
        return { error: oneshotError("qube oneshot run requires an idea.", hasTopLevelJsonFlag(args)) };
      }
      return { request: { command: "run", idea: rest.join(" "), flags } };
    }
    if (rest.length > 1) {
      return { error: oneshotError(`qube oneshot ${first} accepts at most one run id.`, hasTopLevelJsonFlag(args)) };
    }
    return { request: { command: first, runId: rest[0], flags } };
  }
  if (positionals.length === 0) {
    return { request: { command: "status", flags } };
  }
  return { request: { command: "run", idea: positionals.join(" "), flags } };
}

function parseOneshotOption(
  args: readonly string[],
  index: number
):
  | { readonly kind: "parsed"; readonly key: "target" | "output" | "kind" | "agent" | "quality" | "max-iterations"; readonly value: string; readonly nextIndex: number }
  | { readonly kind: "missing-value"; readonly key: "target" | "output" | "kind" | "agent" | "quality" | "max-iterations" }
  | undefined {
  const token = args[index];
  if (!token) return undefined;
  for (const key of ["target", "output", "kind", "agent", "quality", "max-iterations"] as const) {
    const flag = `--${key}`;
    if (token.startsWith(`${flag}=`)) {
      return { kind: "parsed", key, value: token.slice(flag.length + 1), nextIndex: index };
    }
    if (token === flag) {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { kind: "missing-value", key };
      }
      return { kind: "parsed", key, value, nextIndex: index + 1 };
    }
  }
  return undefined;
}

function assignOneshotOption(
  flags: { target?: string; output?: string; kind: OneshotKind; agent: OneshotAgent; quality: OneshotQuality; maxIterations: number },
  key: "target" | "output" | "kind" | "agent" | "quality" | "max-iterations",
  value: string
): string | undefined {
  if (key === "target") flags.target = value;
  if (key === "output") flags.output = value;
  if (key === "kind") {
    if (!isOneshotKind(value)) return `Invalid oneshot kind: ${value}.`;
    flags.kind = value;
  }
  if (key === "agent") {
    if (!isOneshotAgent(value)) return `Invalid oneshot agent: ${value}.`;
    flags.agent = value;
  }
  if (key === "quality") {
    if (!isOneshotQuality(value)) return `Invalid oneshot quality: ${value}.`;
    flags.quality = value;
  }
  if (key === "max-iterations") {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 1) return "Oneshot --max-iterations must be a positive integer.";
    flags.maxIterations = parsed;
  }
  return undefined;
}

function isOneshotCommand(value: string): value is OneshotCommandName {
  return value === "run" || value === "status" || value === "inspect" || value === "resume" || value === "review" || value === "checks" || value === "summary";
}

function isOneshotKind(value: string): value is OneshotKind {
  return (oneshotKindValues as readonly string[]).includes(value);
}

function isOneshotAgent(value: string): value is OneshotAgent {
  return (oneshotAgentValues as readonly string[]).includes(value);
}

function isOneshotQuality(value: string): value is OneshotQuality {
  return (oneshotQualityValues as readonly string[]).includes(value);
}

function createOneshotPlan(idea: string, flags: OneshotFlags, environment: CliEnvironment):
  | {
    readonly runId: string;
    readonly runDirectory: string;
    readonly workspaceDirectory: string;
    readonly outputDirectory: string;
    readonly plan: OneshotPlan;
    readonly manifest: Readonly<Record<string, unknown>>;
    readonly state: OneshotState;
  }
  | { readonly error: string } {
  const kind = inferOneshotKind(idea, flags.kind);
  if (!kind) {
    return { error: "The first oneshot implementation supports only code and doc artifacts." };
  }
  const now = new Date().toISOString();
  const runId = createOneshotRunId(idea, now);
  const runDirectory = oneshotRunDirectory(environment, runId);
  const workspaceDirectory = path.join(runDirectory, "workspace");
  const outputDirectory = path.join(runDirectory, "outputs");
  const targetMode = resolveOneshotTargetMode(flags, environment);
  const plan = buildOneshotPlan(idea, kind, flags, targetMode, runDirectory, workspaceDirectory);
  const summaryPath = path.join(runDirectory, "summary.md");
  const state: OneshotState = {
    schemaVersion: 1,
    runId,
    status: "dry-run-complete",
    phase: "planned",
    idea,
    kind,
    targetMode,
    runDirectory,
    workspaceDirectory,
    outputDirectory,
    summaryPath,
    artifactPath: null,
    checksPath: path.join(runDirectory, "checks.json"),
    githubSideEffects: noGithubSideEffects(),
    createdAt: now,
    updatedAt: now,
    nextAction: `Run qube oneshot status ${runId} --json.`
  };
  const manifest = {
    schemaVersion: 1,
    runId,
    createdAt: now,
    targetMode,
    runDirectory,
    workspaceDirectory,
    outputDirectory,
    outputPath: flags.output ? path.resolve(environment.cwd, flags.output) : null,
    policy: {
      githubSideEffects: false,
      dependencyAdditions: "disabled",
      network: "not-used",
      maxIterations: flags.maxIterations,
      existingTargetMutation: "blocked"
    }
  };
  return { runId, runDirectory, workspaceDirectory, outputDirectory, plan, manifest, state };
}

function inferOneshotKind(idea: string, kind: OneshotKind): "code" | "doc" | undefined {
  if (kind === "code" || kind === "doc") return kind;
  if (kind !== "auto") return undefined;
  return /\b(cli|app|tool|script|server|game|component|code)\b/i.test(idea) ? "code" : "doc";
}

function resolveOneshotTargetMode(flags: OneshotFlags, environment: CliEnvironment): OneshotPlan["mutationPolicy"]["targetMode"] {
  if (!flags.target) return "scratch";
  const targetPath = path.resolve(environment.cwd, flags.target);
  return existsSync(targetPath) ? "existing-target-blocked" : "new-directory";
}

function buildOneshotPlan(
  idea: string,
  kind: "code" | "doc",
  flags: OneshotFlags,
  targetMode: OneshotPlan["mutationPolicy"]["targetMode"],
  runDirectory: string,
  workspaceDirectory: string
): OneshotPlan {
  const title = titleFromIdea(idea);
  const acceptanceCriteria = kind === "code"
    ? ["Artifact has a runnable help command.", "Smoke check exits successfully.", "Summary and evidence are written."]
    : ["Markdown artifact has a title.", "Markdown artifact records assumptions and next steps.", "Summary and evidence are written."];
  return {
    schemaVersion: 1,
    kind,
    title,
    intent: idea,
    assumptions: [
      { id: "scope", summary: "Use a scratch local run workspace unless an explicit new target path is provided.", risk: "low" },
      { id: "review-level", summary: "Result receives local checks and local review only; no PR approval is created.", risk: "medium" },
      { id: "dependencies", summary: "Do not add dependencies or run package managers in the first implementation.", risk: "low" }
    ],
    acceptanceCriteria,
    nonGoals: ["No GitHub issue, branch, PR, review request, merge, or approval.", "No publishing, deployment, credentials, or dependency additions.", "No existing checkout mutation in the first implementation."],
    mutationPolicy: {
      targetMode,
      allowedMutationPaths: targetMode === "new-directory" && flags.target ? [runDirectory, flags.target] : [runDirectory],
      githubSideEffects: false,
      requiresApply: targetMode === "existing-target-blocked"
    },
    checkPlan: {
      required: kind === "code" ? ["node-help-smoke", "local-artifact-audit"] : ["markdown-structure", "local-artifact-audit"],
      optional: flags.quality === "strict" ? ["manual-review"] : []
    }
  };
}

function titleFromIdea(idea: string): string {
  const words = idea.replace(/[^a-zA-Z0-9 ]/g, " ").trim().split(/\s+/).filter(Boolean).slice(0, 8);
  return words.length > 0 ? words.map(word => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`).join(" ") : "Oneshot Artifact";
}

function noGithubSideEffects(): OneshotState["githubSideEffects"] {
  return {
    issueCreated: false,
    branchCreated: false,
    pullRequestCreated: false,
    reviewRequested: false,
    mergeAttempted: false
  };
}

function createOneshotDirectories(runDirectory: string): void {
  for (const directory of [
    runDirectory,
    path.join(runDirectory, "workspace"),
    path.join(runDirectory, "outputs"),
    path.join(runDirectory, "snapshots"),
    path.join(runDirectory, "logs")
  ]) {
    mkdirSync(directory, { recursive: true });
  }
}

function writeOneshotCodeArtifact(plan: OneshotPlan, state: OneshotState): { readonly artifactPath: string; readonly writtenPaths: readonly string[] } {
  const packagePath = path.join(state.workspaceDirectory, "package.json");
  const readmePath = path.join(state.workspaceDirectory, "README.md");
  const artifactPath = path.join(state.workspaceDirectory, "index.mjs");
  writeJsonFile(packagePath, {
    type: "module",
    scripts: {
      smoke: "node index.mjs --help"
    }
  });
  writeFileSync(artifactPath, [
    "#!/usr/bin/env node",
    `const title = ${JSON.stringify(plan.title)};`,
    `const intent = ${JSON.stringify(plan.intent)};`,
    "if (process.argv.includes('--help') || process.argv.includes('-h') || process.argv.length <= 2) {",
    "  console.log(`${title}\\n\\nLocal oneshot artifact.\\nIntent: ${intent}\\nUsage: node index.mjs --help`);",
    "} else {",
    "  console.log(`${title}: ${process.argv.slice(2).join(' ')}`);",
    "}"
  ].join("\n") + "\n", "utf8");
  writeFileSync(readmePath, [
    `# ${plan.title}`,
    "",
    "Local QUBE oneshot code artifact.",
    "",
    "```sh",
    "node index.mjs --help",
    "```",
    ""
  ].join("\n"), "utf8");
  return { artifactPath, writtenPaths: [packagePath, artifactPath, readmePath] };
}

function writeOneshotDocArtifact(plan: OneshotPlan, state: OneshotState): { readonly artifactPath: string; readonly writtenPaths: readonly string[] } {
  const artifactPath = path.join(state.outputDirectory, "artifact.md");
  writeFileSync(artifactPath, [
    `# ${plan.title}`,
    "",
    `Intent: ${plan.intent}`,
    "",
    "## Assumptions",
    "",
    ...plan.assumptions.map(assumption => `- ${assumption.summary}`),
    "",
    "## Acceptance Criteria",
    "",
    ...plan.acceptanceCriteria.map(criterion => `- ${criterion}`),
    "",
    "## Next Steps",
    "",
    "- Review this local artifact.",
    "- Promote it into normal QUBE issue/PR work only with an explicit future bridge.",
    ""
  ].join("\n"), "utf8");
  return { artifactPath, writtenPaths: [artifactPath] };
}

function runOneshotChecks(plan: OneshotPlan, artifact: { readonly artifactPath: string }): readonly OneshotCheck[] {
  if (plan.kind === "code") {
    const result = spawnSync(process.execPath, [artifact.artifactPath, "--help"], {
      encoding: "utf8",
      windowsHide: true
    });
    const passed = result.status === 0 && result.stdout.includes(plan.title);
    return [
      {
        id: "node-help-smoke",
        name: "Node help smoke",
        command: [process.execPath, artifact.artifactPath, "--help"],
        status: passed ? "passed" : "failed",
        summary: passed ? "Generated CLI help ran successfully." : "Generated CLI help did not produce the expected output.",
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.status
      },
      localAuditCheck(plan, artifact.artifactPath)
    ];
  }
  const text = readTextIfPresent(artifact.artifactPath);
  return [
    {
      id: "markdown-structure",
      name: "Markdown structure",
      status: text.startsWith(`# ${plan.title}`) && text.includes("## Assumptions") ? "passed" : "failed",
      summary: "Markdown artifact includes the expected title and assumptions section."
    },
    localAuditCheck(plan, artifact.artifactPath)
  ];
}

function localAuditCheck(plan: OneshotPlan, artifactPath: string): OneshotCheck {
  const text = readTextIfPresent(artifactPath);
  const suspicious = /\b(todo|placeholder|not implemented)\b/i.test(text);
  return {
    id: "local-artifact-audit",
    name: "Local artifact audit",
    status: suspicious ? "failed" : "passed",
    summary: suspicious
      ? "Artifact contains placeholder language."
      : `Artifact matches the ${plan.kind} oneshot shape without placeholder language.`
  };
}

function copyOneshotResult(
  flags: OneshotFlags,
  environment: CliEnvironment,
  plan: OneshotPlan,
  artifact: { readonly artifactPath: string; readonly writtenPaths: readonly string[] }
): string {
  if (flags.output) {
    const outputPath = path.resolve(environment.cwd, flags.output);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    copyFileSync(artifact.artifactPath, outputPath);
    return outputPath;
  }
  if (plan.mutationPolicy.targetMode === "new-directory" && flags.target) {
    const targetPath = path.resolve(environment.cwd, flags.target);
    mkdirSync(targetPath, { recursive: true });
    for (const writtenPath of artifact.writtenPaths) {
      copyFileSync(writtenPath, path.join(targetPath, path.basename(writtenPath)));
    }
    return targetPath;
  }
  return artifact.artifactPath;
}

function validateOneshotOutputPath(flags: OneshotFlags, environment: CliEnvironment): string | undefined {
  if (!flags.output) return undefined;
  const outputPath = path.resolve(environment.cwd, flags.output);
  if (existsSync(outputPath) && statSync(outputPath).isDirectory()) {
    return `Oneshot output must be a file path, not a directory: ${outputPath}.`;
  }
  if (existsSync(outputPath) && !flags.forceOutput) {
    return `Oneshot output already exists: ${outputPath}. Pass --force-output to replace it.`;
  }
  return undefined;
}

function renderOneshotEvidence(plan: OneshotPlan, checks: readonly OneshotCheck[]): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    owner: "aiq",
    kind: "local-oneshot-evidence",
    artifactKind: plan.kind,
    requiredChecks: plan.checkPlan.required,
    checks,
    trustedNarration: false
  };
}

function renderOneshotAssumptions(plan: OneshotPlan): string {
  return [
    "# Assumptions",
    "",
    ...plan.assumptions.map(assumption => `- ${assumption.id}: ${assumption.summary} (risk: ${assumption.risk})`),
    ""
  ].join("\n");
}

function renderOneshotMission(plan: OneshotPlan, state: OneshotState): string {
  return [
    `# ${plan.title}`,
    "",
    plan.intent,
    "",
    "## Boundaries",
    "",
    "- Local oneshot mode only.",
    "- No GitHub side effects.",
    "- Mutate only allowed local run paths.",
    "",
    "## Run",
    "",
    `Run id: ${state.runId}`,
    `Workspace: ${state.workspaceDirectory}`,
    ""
  ].join("\n");
}

function renderOneshotReview(plan: OneshotPlan, checks: readonly OneshotCheck[]): string {
  return [
    "# Local Review",
    "",
    `Artifact kind: ${plan.kind}`,
    `Checks: ${checks.filter(check => check.status === "passed").length}/${checks.length} passed`,
    "",
    "This is local checks plus local self-review only. It is not an approved pull request.",
    ""
  ].join("\n");
}

function renderOneshotRisk(plan: OneshotPlan): string {
  return [
    "# Residual Risk",
    "",
    "- No GitHub issue, branch, PR, external review, merge, or approval was created.",
    "- The first implementation does not mutate existing repositories.",
    `- Artifact kind is limited to ${plan.kind}.`,
    ""
  ].join("\n");
}

function renderOneshotSummary(plan: OneshotPlan, state: OneshotState, checks: readonly OneshotCheck[]): string {
  return [
    `# ${plan.title}`,
    "",
    `Status: ${state.status}`,
    `Artifact: ${state.artifactPath ?? "(none)"}`,
    `Checks: ${checks.map(check => `${check.id}=${check.status}`).join(", ")}`,
    "",
    "Review level: local checks + local self-review only.",
    "GitHub side effects: none. No issue, branch, PR, review request, merge, or approval was created.",
    "",
    "## Assumptions",
    "",
    ...plan.assumptions.map(assumption => `- ${assumption.summary}`),
    ""
  ].join("\n");
}

function updateOneshotState(state: OneshotState, patch: Partial<OneshotState>): OneshotState {
  return { ...state, ...patch, updatedAt: new Date().toISOString() };
}

function summarizeOneshot(context: OneshotContext, action: string): Readonly<Record<string, unknown>> {
  return {
    action,
    runId: context.state.runId,
    status: context.state.status,
    phase: context.state.phase,
    kind: context.state.kind,
    targetMode: context.state.targetMode,
    runDirectory: context.runDirectory,
    workspaceDirectory: context.state.workspaceDirectory,
    artifactPath: context.state.artifactPath,
    summaryPath: context.state.summaryPath,
    checksPath: context.state.checksPath,
    githubSideEffects: context.state.githubSideEffects,
    nextAction: context.state.nextAction
  };
}

function loadOneshotContext(environment: CliEnvironment, runIdInput: string | undefined): OneshotContext | { readonly error: string } {
  const runId = runIdInput ?? readLatestOneshotRunId(environment);
  if (!runId) {
    return { error: "No oneshot run selected. Run `qube oneshot \"idea\"` first or pass a run id." };
  }
  const runDirectory = oneshotRunDirectory(environment, runId);
  const statePath = path.join(runDirectory, "state.json");
  const planPath = path.join(runDirectory, "plan.json");
  if (!existsSync(statePath) || !existsSync(planPath)) {
    return { error: `Oneshot run ${runId} is missing required state files.` };
  }
  return {
    runDirectory,
    state: readJsonFile<OneshotState>(statePath),
    plan: readJsonFile<OneshotPlan>(planPath)
  };
}

function createOneshotRunId(idea: string, timestamp: string): string {
  const compactTime = timestamp.replace(/\D/g, "").slice(0, 17);
  return `${compactTime}-${hashText(idea).slice(0, 8)}-${randomUUID().slice(0, 8)}`;
}

function oneshotRoot(environment: CliEnvironment): string {
  return path.join(environment.cwd, ".qube", "oneshot");
}

function oneshotRunDirectory(environment: CliEnvironment, runId: string): string {
  return path.join(oneshotRoot(environment), runId);
}

function oneshotLatestPath(environment: CliEnvironment): string {
  return path.join(oneshotRoot(environment), "latest.json");
}

function readLatestOneshotRunId(environment: CliEnvironment): string | undefined {
  const latestPath = oneshotLatestPath(environment);
  if (!existsSync(latestPath)) return undefined;
  const latest = readJsonFile<{ runId?: string }>(latestPath);
  return typeof latest.runId === "string" && latest.runId.length > 0 ? latest.runId : undefined;
}

function oneshotError(message: string, json: boolean): CliExecution {
  if (json) {
    return {
      exitCode: 2,
      stdout: `${JSON.stringify({
        ok: false,
        command: "oneshot",
        error: {
          kind: "invalid-command-usage",
          likelyCause: message,
          suggestedNextAction: "Run `qube oneshot --help` and retry with a scratch doc or code artifact.",
          category: "usage",
          exitCode: 2
        }
      })}\n`,
      stderr: ""
    };
  }
  return { exitCode: 2, stdout: "", stderr: `${message}\n` };
}

function renderOneshotResult(payload: Readonly<Record<string, unknown>>): string {
  const runId = typeof payload.runId === "string" ? payload.runId : "(none)";
  const status = typeof payload.status === "string" ? payload.status : "(unknown)";
  const artifactPath = typeof payload.artifactPath === "string" ? payload.artifactPath : "(planned)";
  const nextAction = typeof payload.nextAction === "string" ? payload.nextAction : "Inspect oneshot status.";
  return [
    "QUBE oneshot",
    "",
    `Run: ${runId}`,
    `Status: ${status}`,
    `Artifact: ${artifactPath}`,
    `Next: ${nextAction}`
  ].join("\n") + "\n";
}

function isOneshotHelpRequest(args: readonly string[]): boolean {
  const topLevelArgs = topLevelTokens(args);
  return topLevelArgs.includes("--help") || topLevelArgs.includes("-h");
}

function renderOneshotHelp(): string {
  return [
    "oneshot",
    "Create a bounded local artifact without the normal issue, PR, or review-gate workflow.",
    "",
    "Usage:",
    "  qube oneshot <idea> [--kind code|doc|auto] [--json] [--dry-run]",
    "  qube oneshot run <idea> [--kind code|doc|auto] [--json]",
    "  qube oneshot status <run-id> --json",
    "  qube oneshot checks <run-id> --json",
    "  qube oneshot review <run-id> --json",
    "  qube oneshot summary <run-id>",
    "",
    "Boundary:",
    "  Default runs write only .qube/oneshot/<run-id>/ scratch state.",
    "  No GitHub issue, branch, PR, review request, merge, or approval is created by default.",
    "  Existing targets are refused in the first implementation.",
    "",
    "Examples:",
    "  qube oneshot \"Ship a local notes CLI\" --kind code --json",
    "  qube oneshot \"Create a README draft\" --kind doc --dry-run --json",
    "  qube oneshot status <run-id> --json",
    "",
    "Behavior:",
    "  JSON output: supported",
    "  Dry run: supported",
    "  Mutation: local-files",
    "  Supply chain: standard"
  ].join("\n") + "\n";
}

function readTextIfPresent(filePath: string): string {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
}

function appendJsonLine(filePath: string, value: unknown): void {
  appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function writeJsonFile(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJsonFile<Value>(filePath: string): Value {
  return JSON.parse(readFileSync(filePath, "utf8")) as Value;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function executeMakeItSo(args: readonly string[], environment: CliEnvironment): Promise<RuntimeCommandResult> {
  if (isMakeItSoHelpRequest(args)) {
    return { exitCode: 0, stdout: renderMakeItSoHelp() };
  }
  const planned = planMakeItSo(args, environment);
  if (!planned.dispatch) {
    return makeItSoRuntimeResult(args, planned);
  }
  if (planned.stderr.length > 0) {
    process.stderr.write(planned.stderr);
  }
  const exitCode = await dispatchCommand(planned.dispatch);
  return { exitCode };
}

function makeItSoRuntimeResult(args: readonly string[], planned: CliExecution): RuntimeCommandResult {
  if (hasTopLevelJsonFlag(args)) {
    return { exitCode: planned.exitCode, jsonStdout: planned.stdout, stderr: planned.stderr };
  }
  return { exitCode: planned.exitCode, stdout: planned.stdout, stderr: planned.stderr };
}

function isMakeItSoHelpRequest(args: readonly string[]): boolean {
  const topLevelArgs = topLevelTokens(args);
  return topLevelArgs.includes("--help") || topLevelArgs.includes("-h");
}

function hasTopLevelJsonFlag(args: readonly string[]): boolean {
  return topLevelTokens(args).includes("--json");
}

function topLevelTokens(args: readonly string[]): readonly string[] {
  const separator = args.indexOf("--");
  return separator === -1 ? args : args.slice(0, separator);
}

function renderMakeItSoHelp(): string {
  return [
    "make-it-so",
    "Map an intent to the safest real QUBE workflow.",
    "",
    "Usage:",
    "  qube make-it-so [args] [--json] [--dry-run] [--flow <value>] [--target <value>]",
    "",
    "Arguments:",
    "  [args]  Intent text, issue selector, and additional arguments forwarded to the mapped component command.",
    "",
    "Flags:",
    "  --json            Render machine-readable JSON output.",
    "  --dry-run         Print the plan without running mapped commands.",
    "  -h, --help        Show command help.",
    "  --flow <value>    Workflow to run.; options: planned, issue, direct-local",
    "  --target <value>  Planning target path for the planned flow.",
    "",
    "Examples:",
    "  qube make-it-so \"Ship a local notes CLI\"  # Start planning from a concise intent.",
    "  qube make-it-so --flow issue next --json  # Start the next provider-backed issue through Executor.",
    "  qube make-it-so \"Ship a local notes CLI\" --dry-run --json  # Preview the mapped workflow without running it.",
    "",
    "Behavior:",
    "  JSON output: supported",
    "  Dry run: supported",
    "  Mutation: none",
    "  Supply chain: standard"
  ].join("\n") + "\n";
}

function planDirectCommand(args: readonly string[], environment: CliEnvironment): CliExecution | undefined {
  const match = findDirectCommand(args);
  if (!match) {
    return undefined;
  }
  const mapped = mapDirectArgs(match.definition, match.args);
  if ("error" in mapped) {
    return mapped.error;
  }
  return planQubeDispatch(match.definition.component, mapped.args, environment);
}

function planQubeDispatch(componentName: string | undefined, componentArgs: readonly string[], environment: CliEnvironment): CliExecution {
  if (!componentName) {
    return { exitCode: 2, stdout: "", stderr: "Missing component. Run qube components to list available tools.\n" };
  }

  const component = findQubeComponent(componentName);
  if (!component) {
    return { exitCode: 2, stdout: "", stderr: `Unknown QUBE component: ${componentName}\nRun qube components to list available tools.\n` };
  }

  const resolution = resolveComponentCommand(component, environment);
  if (!resolution) {
    return {
      exitCode: 4,
      stdout: "",
      stderr: `Cannot find ${component.command} for ${component.packageName}@${component.packageVersion}.\nInstall QUBE with its component dependencies or install the matching standalone package version.\n`
    };
  }
  if (resolution.error) {
    return {
      exitCode: 4,
      stdout: "",
      stderr: `${resolution.error}\n`
    };
  }

  return {
    exitCode: 0,
    stdout: "",
    stderr: resolution.warning ? `${resolution.warning}\n` : "",
    dispatch: {
      component,
      commandPath: resolution.commandPath,
      resolution,
      args: componentArgs
    }
  };
}

function resolveCommandFromEntries(command: string, entries: readonly string[], environment: CliEnvironment): string | undefined {
  for (const entry of entries) {
    for (const name of commandNames(command, environment)) {
      const candidate = path.join(entry, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function defaultEnvironment(): CliEnvironment {
  return { cwd: process.cwd(), env: process.env };
}

function defaultPackageRoot(env: NodeJS.ProcessEnv): string {
  if (env.QUBE_TEST_PACKAGE_ROOT && env.QUBE_TEST_PACKAGE_ROOT.trim().length > 0) {
    return env.QUBE_TEST_PACKAGE_ROOT;
  }
  return fileURLToPath(new URL("..", import.meta.url));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(item => typeof item === "string");
}

function stripSeparator(args: readonly string[]): readonly string[] {
  return args[0] === "--" ? args.slice(1) : args;
}

function mapIdeaArgs(args: readonly string[]): readonly string[] {
  const forceIdea = args[0] === "--";
  const normalized = stripSeparator(args);
  const [idea, ...rest] = normalized;
  if (idea && (forceIdea || !idea.startsWith("-"))) {
    return ["init", ".", "--idea", idea, ...rest];
  }
  return ["init", ".", ...normalized];
}

function planMakeItSo(args: readonly string[], environment: CliEnvironment): CliExecution {
  const parsed = parseMakeItSoArgs(args);
  if ("error" in parsed) {
    return parsed.error;
  }
  const plan = createMakeItSoPlan(parsed.flags, parsed.positionals);
  if ("error" in plan) {
    return makeItSoError(plan.error, parsed.flags.json === true);
  }
  if (plan.status === "blocked" && parsed.flags["dry-run"] !== true) {
    if (parsed.flags.json === true) {
      return {
        exitCode: 2,
        stdout: `${JSON.stringify({
          ok: false,
          command: "make-it-so",
          makeItSo: plan,
          error: {
            kind: "unsupported-flow",
            likelyCause: "Direct-local make-it-so execution requires the QUBE oneshot workflow.",
            suggestedNextAction: plan.nextAction,
            category: "usage",
            exitCode: 2
          }
        })}\n`,
        stderr: ""
      };
    }
    return { exitCode: 2, stdout: renderMakeItSoPlan(plan), stderr: "" };
  }
  if (parsed.flags["dry-run"] === true) {
    if (parsed.flags.json === true) {
      return { exitCode: 0, stdout: `${JSON.stringify({ ok: true, command: "make-it-so", makeItSo: plan })}\n`, stderr: "" };
    }
    return { exitCode: 0, stdout: renderMakeItSoPlan(plan), stderr: "" };
  }
  if (!plan.mappedCommand) {
    return makeItSoError("No mapped command is available for this make-it-so flow.", parsed.flags.json === true);
  }
  return planQubeDispatch(plan.mappedCommand.component, plan.mappedCommand.args, environment);
}

function createMakeItSoPlan(
  flags: Readonly<Record<string, unknown>>,
  positionals: readonly string[]
): MakeItSoPlan | { readonly error: string } {
  const explicitFlow = readOption<MakeItSoFlow>(flags, "flow");
  if (explicitFlow && !makeItSoFlowValues.includes(explicitFlow)) {
    return { error: `Invalid make-it-so flow: ${explicitFlow}. Use one of: ${makeItSoFlowValues.join(", ")}.` };
  }
  const flow = explicitFlow ?? (positionals.length > 0 ? "planned" : "issue");
  const target = readOption<string>(flags, "target") ?? ".";
  const [first = null, ...remaining] = positionals;
  const hasSelectorOrIntent = first !== null && !first.startsWith("-");
  const intent = hasSelectorOrIntent ? first : null;
  const rest = hasSelectorOrIntent ? remaining : positionals;
  const wantsJson = flags.json === true;

  if (flow === "direct-local") {
    return {
      flow,
      intent,
      target,
      dryRun: flags["dry-run"] === true,
      status: "blocked",
      mappedCommand: null,
      boundaries: [
        "Direct-local artifact generation is intentionally not implemented here until QUBE oneshot exists.",
        "No GitHub issue, branch, pull request, dependency, or workspace mutation is performed."
      ],
      nextAction: "Use `qube make-it-so --flow planned <intent>` to create a real AIB plan, or implement the oneshot workflow before enabling direct-local execution."
    };
  }

  if (flow === "issue") {
    const selector = intent ?? "next";
    if (selector !== "next" && !/^#?\d+$/.test(selector)) {
      return { error: "Issue flow requires an existing issue number, #number, or next. Use planned flow for free-form ideas." };
    }
    const issue = selector.startsWith("#") ? selector.slice(1) : selector;
    const args = ["start", issue, ...rest, ...(wantsJson ? ["--json"] : [])];
    return {
      flow,
      intent: selector,
      target,
      dryRun: flags["dry-run"] === true,
      status: "dispatch",
      mappedCommand: makeMappedCommand("aie", args),
      boundaries: [
        "Uses the Executor issue lifecycle with configured pre-start checks.",
        "Branch policy, review gates, PR checks, completion, and queue continuation remain active."
      ],
      nextAction: `Run ${formatQubeCommand("aie", args)}.`
    };
  }

  const args = intent
    ? ["init", target, "--idea", intent, ...rest, ...(wantsJson ? ["--json"] : [])]
    : ["init", target, ...rest, ...(wantsJson ? ["--json"] : [])];
  return {
    flow,
    intent,
    target,
    dryRun: flags["dry-run"] === true,
    status: "dispatch",
    mappedCommand: makeMappedCommand("aib", args),
    boundaries: [
      "Uses AIB planning state only; it does not create a GitHub issue, branch, pull request, or review request.",
      "Execution still requires explicit work item creation and AIE issue workflow after planning."
    ],
    nextAction: `Run ${formatQubeCommand("aib", args)}.`
  };
}

function makeMappedCommand(component: QubeComponent["command"], args: readonly string[]): MakeItSoMappedCommand {
  return {
    component,
    args,
    command: formatQubeCommand(component, args)
  };
}

function renderMakeItSoPlan(plan: MakeItSoPlan): string {
  return [
    "QUBE make-it-so plan",
    "",
    `Flow: ${plan.flow}`,
    `Status: ${plan.status}`,
    `Intent: ${plan.intent ?? "(none)"}`,
    `Target: ${plan.target}`,
    ...(plan.mappedCommand ? [`Mapped command: ${plan.mappedCommand.command}`] : ["Mapped command: (none)"]),
    "",
    "Boundaries:",
    ...plan.boundaries.map(boundary => `- ${boundary}`),
    "",
    `Next: ${plan.nextAction}`,
    plan.dryRun ? "No commands were run." : ""
  ].filter(line => line !== "").join("\n") + "\n";
}

function formatQubeCommand(component: QubeComponent["command"], args: readonly string[]): string {
  return ["qube", component, ...args].map(quoteShellArg).join(" ");
}

function quoteShellArg(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : JSON.stringify(value);
}

function parseMakeItSoArgs(args: readonly string[]):
  | { readonly flags: Readonly<Record<string, unknown>>; readonly positionals: readonly string[] }
  | { readonly error: CliExecution } {
  const wantsJsonOutput = hasTopLevelJsonFlag(args);
  const flags: Record<string, unknown> = {};
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) {
      continue;
    }
    if (token === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (token === "--json") {
      flags.json = true;
      continue;
    }
    if (token === "--dry-run") {
      flags["dry-run"] = true;
      continue;
    }
    const parsed = parseMakeItSoOption(args, index);
    if (parsed?.kind === "missing-value") {
      return {
        error: makeItSoError(`Missing value for make-it-so option --${parsed.key}.`, wantsJsonOutput)
      };
    }
    if (parsed?.kind === "parsed") {
      flags[parsed.key] = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    positionals.push(token);
  }
  return { flags, positionals };
}

function parseMakeItSoOption(
  args: readonly string[],
  index: number
):
  | { readonly kind: "parsed"; readonly key: string; readonly value: string; readonly nextIndex: number }
  | { readonly kind: "missing-value"; readonly key: string }
  | undefined {
  const token = args[index];
  if (!token) {
    return undefined;
  }
  for (const key of ["flow", "target"]) {
    const flag = `--${key}`;
    if (token.startsWith(`${flag}=`)) {
      return { kind: "parsed", key, value: token.slice(flag.length + 1), nextIndex: index };
    }
    if (token === flag) {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { kind: "missing-value", key };
      }
      return { kind: "parsed", key, value, nextIndex: index + 1 };
    }
  }
  return undefined;
}

function makeItSoError(message: string, json: boolean): CliExecution {
  if (json) {
    return {
      exitCode: 2,
      stdout: `${JSON.stringify({
        ok: false,
        command: "make-it-so",
        error: {
          kind: "invalid-command-usage",
          likelyCause: message,
          suggestedNextAction: "Use `qube make-it-so --dry-run --json` to inspect the mapped workflow.",
          category: "usage",
          exitCode: 2
        }
      })}\n`,
      stderr: ""
    };
  }
  return { exitCode: 2, stdout: "", stderr: `${message}\n` };
}

function translateJsonFlag(args: readonly string[]): readonly string[] {
  return args.flatMap(arg => arg === "--json" ? ["--format", "json"] : [arg]);
}

async function executeDirectCommand(definition: DirectQubeCommand, args: readonly string[], environment: CliEnvironment): Promise<RuntimeCommandResult> {
  const mapped = mapDirectArgs(definition, args);
  if ("error" in mapped) {
    return { exitCode: mapped.error.exitCode, stdout: mapped.error.stdout, stderr: mapped.error.stderr };
  }
  // Help must win over JSON so combined --help --json still returns human help.
  if (definition.qubePrimaryHelp && isDirectHelpRequest(args)) {
    const planned = planQubeDispatch(definition.component, mapped.args, environment);
    if (!planned.dispatch) return { exitCode: planned.exitCode, stdout: planned.stdout, stderr: planned.stderr };
    const captured = await dispatchCommandCaptured(planned.dispatch);
    return {
      exitCode: captured.exitCode,
      stdout: rewriteQubeReviewHelp(captured.stdout, definition.command.name),
      stderr: `${planned.stderr}${captured.stderr}`,
    };
  }
  if (definition.passthroughJson && hasTopLevelJsonFlag(args)) {
    return executeQubeJsonDispatch(definition.component, mapped.args, environment);
  }
  return executeQubeDispatch(definition.component, mapped.args, environment);
}

function isDirectHelpRequest(args: readonly string[]): boolean {
  return stripSeparator(args).some(argument => argument === '--help' || argument === '-h');
}

function rewriteQubeReviewHelp(output: string, commandName: string): string {
  const primary = output.replace(/\baie review\b/g, 'qube review').trimEnd();
  return `${primary}\n\nEquivalent paths: \`qube aie ${commandName}\` or \`aie ${commandName}\`.\n`;
}

async function executeQubeJsonDispatch(componentName: string, componentArgs: readonly string[], environment: CliEnvironment): Promise<RuntimeCommandResult> {
  const planned = planQubeDispatch(componentName, componentArgs, environment);
  if (!planned.dispatch) return { exitCode: planned.exitCode, jsonStdout: planned.stdout, stderr: planned.stderr };
  const captured = await dispatchCommandCaptured(planned.dispatch);
  return {
    exitCode: captured.exitCode,
    jsonStdout: captured.stdout,
    stderr: `${planned.stderr}${captured.stderr}`,
  };
}

function mapDirectArgs(definition: DirectQubeCommand, args: readonly string[]): { readonly args: readonly string[] } | { readonly error: CliExecution } {
  const stripped = stripSeparator(args);
  if (!definition.supportsJson && stripped.includes("--json")) {
    return {
      error: {
        exitCode: 2,
        stdout: "",
        stderr: `qube ${definition.command.name} does not support --json because ${definition.component} ${definition.command.name} is a helper topic. Use qube help ${definition.command.name} or a concrete subcommand.\n`
      }
    };
  }
  return { args: definition.mapArgs(args) };
}

function planQubeInstall(args: readonly string[]): CliExecution {
  const parsed = parseInstallArgs(args);
  if ("error" in parsed) {
    return parsed.error;
  }
  const validationError = validateInstallFlagChoices(parsed.flags);
  if (validationError) {
    return validationError;
  }
  if (parsed.flags.json === true && parsed.flags.yes !== true && !hasCompleteInstallSelections(parsed.flags)) {
    return {
      exitCode: 2,
      stdout: `${JSON.stringify({
        ok: false,
        command: "install",
        error: {
          kind: "prompt-blocked",
          operation: "prompt install scope",
          likelyCause: "Prompts are disabled in JSON output mode.",
          suggestedNextAction: "Provide explicit install flags or pass --yes for safe defaults.",
          category: "usage",
          exitCode: 2
        }
      })}\n`,
      stderr: ""
    };
  }
  const selections = createInstallSelectionsFromFlags(parsed.flags);
  const plan = createInstallPlan(selections, parsed.flags["dry-run"] === true);
  if (parsed.flags.json === true) {
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({ ok: true, command: "install", installPlan: plan })}\n`,
      stderr: ""
    };
  }
  return {
    exitCode: 0,
    stdout: renderInstallPlan(plan),
    stderr: ""
  };
}

function createDirectCommand(
  name: string,
  description: string,
  component: QubeComponent["command"],
  targetCommand: string,
  options: { readonly translateJson?: boolean; readonly supportsJson?: boolean; readonly passthroughJson?: boolean; readonly qubePrimaryHelp?: boolean } = {}
): DirectQubeCommand {
  const supportsJson = options.supportsJson ?? true;
  return {
    command: defineCommand({
      kind: "command",
      name,
      description,
      arguments: [
        defineArgument({
          name: "args",
          description: `Arguments forwarded to ${component} ${targetCommand}.`,
          multiple: true
        })
      ],
      flags: supportsJson ? [jsonFlag] : [],
      examples: [
        {
          description,
          command: supportsJson ? `qube ${name} --json` : `qube ${name} --help`
        }
      ],
      interactions: {
        json: supportsJson,
        noColor: true,
        nonInteractive: true,
        ttyPrompt: false
      },
      extensions: passthroughExtensions
    }),
    component,
    supportsJson,
    passthroughJson: options.passthroughJson === true,
    qubePrimaryHelp: options.qubePrimaryHelp === true,
    mapArgs(args) {
      const stripped = stripSeparator(args);
      const forwarded = options.translateJson ? translateJsonFlag(stripped) : stripped;
      return [...targetCommand.split(" "), ...forwarded];
    }
  };
}

async function resolveInstallSelections(flags: Readonly<Record<string, unknown>>): Promise<InstallSelections> {
  const scope = await resolveInstallChoice(scopeChoices, readOption<InstallScope>(flags, "scope"), flags);
  const packageManager = await resolveInstallChoice(packageManagerChoices, readOption<InstallPackageManager>(flags, "package-manager"), flags);
  const host = await resolveInstallChoice(hostChoices, readOption<InstallHost>(flags, "host"), flags);
  const workProvider = await resolveInstallChoice(workProviderChoices, readOption<InstallWorkProvider>(flags, "work-provider"), flags);
  const ciProvider = await resolveInstallChoice(ciProviderChoices, readOption<InstallCiProvider>(flags, "ci-provider"), flags);
  const lifecycleScripts = await resolveInstallChoice(lifecycleChoices, readOption<InstallLifecycleScripts>(flags, "lifecycle-scripts"), flags);
  const docsValue = await resolveInstallChoice(docsChoices, readDocsFlag(flags), flags);
  const migration = await resolveInstallChoice(migrationChoices, readOption<InstallMigration>(flags, "migration"), flags);
  return {
    scope,
    packageManager,
    host,
    workProvider,
    ciProvider,
    lifecycleScripts,
    docs: docsValue === "yes",
    migration
  };
}

async function resolveInstallChoice<Value extends string>(
  group: InstallerChoiceGroup<Value>,
  value: Value | undefined,
  flags: Readonly<Record<string, unknown>>
): Promise<Value> {
  return promptInstallerChoice({
    command: installCommand,
    promptName: group.name,
    message: group.message,
    choices: group.choices,
    value,
    defaultValue: flags.yes === true ? group.defaultValue : undefined,
    jsonMode: flags.json === true,
    yes: flags.yes === true
  });
}

function createInstallSelectionsFromFlags(flags: Readonly<Record<string, unknown>>): InstallSelections {
  // Keep these synchronous fallbacks aligned with the choice group defaults above.
  return {
    scope: readOption<InstallScope>(flags, "scope") ?? "local",
    packageManager: readOption<InstallPackageManager>(flags, "package-manager") ?? "pnpm",
    host: readOption<InstallHost>(flags, "host") ?? "generic",
    workProvider: readOption<InstallWorkProvider>(flags, "work-provider") ?? "github",
    ciProvider: readOption<InstallCiProvider>(flags, "ci-provider") ?? "github",
    lifecycleScripts: readOption<InstallLifecycleScripts>(flags, "lifecycle-scripts") ?? "disabled",
    docs: readDocsFlag(flags) !== "no",
    migration: readOption<InstallMigration>(flags, "migration") ?? "none"
  };
}

function createInstallPlan(selections: InstallSelections, dryRun: boolean): InstallPlan {
  return {
    package: {
      name: packageName,
      version: packageVersion
    },
    selections,
    options: createInstallOptionGroups(),
    mode: "copy-commands",
    dryRun,
    commands: createInstallCommands(selections),
    connections: createInstallConnections(selections),
    files: createInstallFiles(selections),
    notes: createInstallNotes(selections)
  };
}

function createInstallOptionGroups(): InstallOptionGroups {
  return Object.freeze({
    hosts: summarizeDiscoveryOptions(executorHostSurfaces),
    workProviders: summarizeDiscoveryOptions(executorWorkProviders),
    ciProviders: summarizeDiscoveryOptions(executorCiProviders),
  });
}

function summarizeDiscoveryOptions(options: readonly QubeDiscoveryOption[]): readonly InstallOptionSummary[] {
  return Object.freeze(options.map(option => Object.freeze({
    value: option.id,
    label: installOptionLabels[option.id] ?? option.id,
    support: option.support,
    default: option.default,
    packageName: option.packageName,
    source: option.source,
    summary: option.summary,
    capabilities: option.capabilities,
    connection: option.connection,
  })));
}

function createInstallConnections(selections: InstallSelections): readonly ConnectionContract[] {
  const selected = [
    executorWorkProviders.find(option => option.id === selections.workProvider)?.connection,
    executorCiProviders.find(option => option.id === selections.ciProvider)?.connection,
  ].filter((connection): connection is ConnectionContract => connection !== null && connection !== undefined);
  return Object.freeze([...new Map(selected.map(connection => [connection.adapterId, connection])).values()]);
}

function createInstallCommands(selections: InstallSelections): readonly InstallCommandStep[] {
  const packageSpec = `${packageName}@${packageVersion}`;
  if (selections.packageManager === "pnpm" && selections.scope === "local") {
    return [
      {
        label: "Install QUBE in the current project.",
        command: `pnpm add -D --save-exact ${lifecycleFlag(selections)} ${packageSpec}`.replace(/\s+/g, " ").trim()
      },
      {
        label: "Confirm the installed component deck.",
        command: "pnpm exec qube components"
      }
    ];
  }
  if (selections.packageManager === "pnpm" && selections.scope === "global") {
    return [
      {
        label: "Install QUBE globally for manual shell use.",
        command: `pnpm add --global ${lifecycleFlag(selections)} ${packageSpec}`.replace(/\s+/g, " ").trim()
      },
      {
        label: "Confirm the installed component deck.",
        command: "qube components"
      }
    ];
  }
  if (selections.packageManager === "npm" && selections.scope === "local") {
    return [
      {
        label: "Install QUBE in the current project.",
        command: `npm install --save-dev --save-exact ${lifecycleFlag(selections)} ${packageSpec}`.replace(/\s+/g, " ").trim()
      },
      {
        label: "Confirm the installed component deck.",
        command: "npm exec -- qube components"
      }
    ];
  }
  return [
    {
      label: "Install QUBE globally for manual shell use.",
      command: `npm install --global ${lifecycleFlag(selections)} ${packageSpec}`.replace(/\s+/g, " ").trim()
    },
    {
      label: "Confirm the installed component deck.",
      command: "qube components"
    }
  ];
}

function createInstallFiles(selections: InstallSelections): readonly string[] {
  if (!selections.docs) {
    return [];
  }
  const files = ["README.md install snippet"];
  if (selections.host === "codex") {
    files.push(...listCodexInstallFiles());
  }
  if (selections.host === "claude-code") {
    files.push(...listClaudeCodeInstallFiles());
  }
  if (selections.host === "grok-build") {
    files.push(...listGrokBuildInstallFiles());
  }
  if (selections.host === "opencode") {
    files.push(".opencode command notes");
  }
  if (selections.workProvider === "github" || selections.workProvider === "gitlab" || selections.workProvider === "linear" || selections.workProvider === "jira") {
    files.push(".qube/aie/config.json provider notes");
  }
  if (selections.ciProvider === "jenkins") {
    files.push(".qube/aie/gates/jenkins gate evidence notes");
  }
  return files;
}

function createInstallNotes(selections: InstallSelections): readonly string[] {
  const notes = [
    "No package-manager command is executed by qube install.",
    "Commands use exact QUBE package versions.",
    selections.lifecycleScripts === "disabled"
      ? "Lifecycle scripts stay disabled where the selected package manager supports it."
      : "Generated commands still keep lifecycle scripts disabled; review any manual exception before changing them."
  ];
  if (selections.scope === "global") {
    notes.push("Prefer project-local installs for automation; global installs are for manual shell use.");
  }
  notes.push("Autoresearch agent entry: run `qube autoresearch --help`, translate natural-language requests to `<target>` plus `<goal>`, and synthesize the arena before edits.");
  notes.push("QUBE provider probes verify only QUBE adapter credentials; host MCP server credentials are separate even when they use the same token.");
  notes.push(installOptionNote("Work provider", executorWorkProviders, selections.workProvider));
  notes.push(installOptionNote("CI provider", executorCiProviders, selections.ciProvider));
  if (selections.host === "codex") {
    notes.push(...listCodexInstallNotes());
  }
  if (selections.host === "claude-code") {
    notes.push(...listClaudeCodeInstallNotes());
  }
  if (selections.host === "grok-build") {
    notes.push(...listGrokBuildInstallNotes());
  }
  if (selections.migration === "standalone-globals") {
    notes.push("After QUBE is verified, remove stale standalone global commands only after confirming no workflow still depends on them.");
  }
  return notes;
}

function installOptionNote(label: string, options: readonly QubeDiscoveryOption[], selected: string): string {
  const option = options.find(candidate => candidate.id === selected);
  if (!option) {
    return `${label}: ${selected} is not a known current QUBE option.`;
  }
  const packageText = option.packageName ? ` Package: ${option.packageName}.` : "";
  const supported = option.capabilities.filter(capability => capability.support === "supported").map(capability => capability.id);
  const standalone = option.capabilities.filter(capability => capability.support === "standalone").map(capability => capability.id);
  const hostProvided = option.capabilities.filter(capability => capability.support === "host-provided").map(capability => capability.id);
  const unsupported = option.capabilities.filter(capability => capability.support === "unsupported").map(capability => capability.id);
  const supportedText = supported.length > 0 ? ` Supported capabilities: ${supported.join(", ")}.` : "";
  const standaloneText = standalone.length > 0 ? ` Standalone capabilities: ${standalone.join(", ")}.` : "";
  const hostProvidedText = hostProvided.length > 0 ? ` Host-provided capabilities: ${hostProvided.join(", ")}.` : "";
  const unsupportedText = unsupported.length > 0 ? ` Unsupported capabilities: ${unsupported.join(", ")}.` : "";
  return `${label}: ${option.id} (${option.support}, ${option.source}). ${option.summary}${packageText}${supportedText}${standaloneText}${hostProvidedText}${unsupportedText}`;
}

function renderInstallPlan(plan: InstallPlan): string {
  return [
    "QUBE guided install plan",
    "",
    `Package: ${plan.package.name}@${plan.package.version}`,
    `Scope: ${plan.selections.scope}`,
    `Package manager: ${plan.selections.packageManager}`,
    `Host surface: ${plan.selections.host}`,
    `Work provider: ${plan.selections.workProvider}`,
    `CI provider: ${plan.selections.ciProvider}`,
    `Lifecycle scripts: ${plan.selections.lifecycleScripts}`,
    `Docs/config notes: ${plan.selections.docs ? "included" : "omitted"}`,
    `Migration path: ${plan.selections.migration}`,
    "",
    "Commands to run:",
    ...plan.commands.flatMap((step, index) => [`${index + 1}. ${step.label}`, `   ${step.command}`]),
    "",
    "Current options:",
    renderOptionSummary("Host surfaces", plan.options.hosts),
    renderOptionSummary("Work providers", plan.options.workProviders),
    renderOptionSummary("CI providers", plan.options.ciProviders),
    "",
    "Connections:",
    ...(plan.connections.length > 0 ? plan.connections.flatMap(renderInstallConnection) : ["- No provider connection is selected."]),
    "",
    "Notes:",
    ...plan.notes.map(note => `- ${note}`),
    ...(plan.files.length > 0 ? ["", "Docs/config notes to add:", ...plan.files.map(file => `- ${file}`)] : []),
    "",
    "No commands were run.",
    ""
  ].join("\n");
}

function renderInstallConnection(connection: ConnectionContract): readonly string[] {
  const envVars = connection.envVars.length === 0
    ? "none (credentials are delegated to the provider CLI)"
    : connection.envVars.map(variable => `${variable.name}${variable.sensitive ? " (secret)" : " (non-secret)"}: ${variable.purpose}`).join("; ");
  const configFields = connection.configFields.length === 0
    ? "none"
    : connection.configFields.map(field => `${field.name}${field.required ? " (required)" : " (optional)"}: ${field.purpose}`).join("; ");
  return [
    `- ${connection.adapterId} (${connection.authMethod})`,
    `  Environment: ${envVars}`,
    `  Config fields: ${configFields}`,
    `  Token URL: ${connection.credentialUrl}`,
    `  Minimal scopes: ${connection.scopes.join(", ") || "none"}`,
    `  Read-only probe: ${connection.probe.name} (${connection.probe.timeoutMs}ms timeout)`,
    `  Verify: ${connection.probe.verifyCommand}`,
  ];
}

function renderOptionSummary(label: string, options: readonly InstallOptionSummary[]): string {
  return `${label}: ${options.map(option => `${option.value}${option.default ? " (default)" : ""}:${option.support}`).join(", ")}`;
}

function lifecycleFlag(selections: InstallSelections): string {
  if (selections.lifecycleScripts === "disabled" || selections.lifecycleScripts === "review") {
    return "--ignore-scripts";
  }
  return "";
}

function validateInstallFlagChoices(flags: Readonly<Record<string, unknown>>): CliExecution | undefined {
  const groups = [
    { key: "scope", choices: scopeChoices.choices },
    { key: "package-manager", choices: packageManagerChoices.choices },
    { key: "host", choices: hostChoices.choices },
    { key: "work-provider", choices: workProviderChoices.choices },
    { key: "ci-provider", choices: ciProviderChoices.choices },
    { key: "lifecycle-scripts", choices: lifecycleChoices.choices },
    { key: "migration", choices: migrationChoices.choices }
  ];
  for (const group of groups) {
    const value = flags[group.key];
    if (typeof value !== "string") {
      continue;
    }
    if (group.choices.some(choice => choice.value === value)) {
      continue;
    }
    return {
      exitCode: 2,
      stdout: "",
      stderr: `Invalid install option --${group.key}=${value}. Use one of: ${group.choices.map(choice => choice.value).join(", ")}.\n`
    };
  }
  return undefined;
}

function readOption<Value extends string>(flags: Readonly<Record<string, unknown>>, key: string): Value | undefined {
  const value = flags[key];
  return typeof value === "string" ? value as Value : undefined;
}

function readDocsFlag(flags: Readonly<Record<string, unknown>>): YesNo | undefined {
  if (flags.docs === true) {
    return "yes";
  }
  if (flags.docs === false) {
    return "no";
  }
  return undefined;
}

function hasCompleteInstallSelections(flags: Readonly<Record<string, unknown>>): boolean {
  return ["scope", "package-manager", "host", "work-provider", "ci-provider", "lifecycle-scripts", "migration"].every(key => typeof flags[key] === "string")
    && typeof flags.docs === "boolean";
}

function parseInstallArgs(args: readonly string[]):
  | { readonly flags: Readonly<Record<string, unknown>> }
  | { readonly error: CliExecution } {
  const flags: Record<string, unknown> = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) {
      continue;
    }
    if (token === "--json") {
      flags.json = true;
      continue;
    }
    if (token === "--dry-run") {
      flags["dry-run"] = true;
      continue;
    }
    if (token === "--yes" || token === "-y") {
      flags.yes = true;
      continue;
    }
    if (token === "--docs") {
      flags.docs = true;
      continue;
    }
    if (token === "--no-docs") {
      flags.docs = false;
      continue;
    }
    const parsed = parseOptionToken(args, index);
    if (parsed?.kind === "missing-value") {
      return {
        error: {
          exitCode: 2,
          stdout: "",
          stderr: `Missing value for install option --${parsed.key}. Use one of: ${installOptionValues(parsed.key).join(", ")}.\n`
        }
      };
    }
    if (parsed?.kind === "parsed") {
      flags[parsed.key] = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    return {
      error: {
        exitCode: 2,
        stdout: "",
        stderr: `Unknown install flag or argument: ${token}\n`
      }
    };
  }
  return { flags };
}

function parseOptionToken(
  args: readonly string[],
  index: number
):
  | { readonly kind: "parsed"; readonly key: string; readonly value: string; readonly nextIndex: number }
  | { readonly kind: "missing-value"; readonly key: string }
  | undefined {
  const token = args[index];
  if (!token) {
    return undefined;
  }
  for (const key of ["scope", "package-manager", "host", "work-provider", "ci-provider", "lifecycle-scripts", "migration"]) {
    const flag = `--${key}`;
    if (token.startsWith(`${flag}=`)) {
      return { kind: "parsed", key, value: token.slice(flag.length + 1), nextIndex: index };
    }
    if (token === flag) {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { kind: "missing-value", key };
      }
      return { kind: "parsed", key, value, nextIndex: index + 1 };
    }
  }
  return undefined;
}

function installOptionValues(key: string): readonly string[] {
  switch (key) {
    case "scope":
      return scopeChoices.choices.map(choice => choice.value);
    case "package-manager":
      return packageManagerChoices.choices.map(choice => choice.value);
    case "host":
      return hostChoices.choices.map(choice => choice.value);
    case "work-provider":
      return workProviderChoices.choices.map(choice => choice.value);
    case "ci-provider":
      return ciProviderChoices.choices.map(choice => choice.value);
    case "lifecycle-scripts":
      return lifecycleChoices.choices.map(choice => choice.value);
    case "migration":
      return migrationChoices.choices.map(choice => choice.value);
    default:
      return [];
  }
}

function findDirectCommand(args: readonly string[]): { readonly definition: DirectQubeCommand; readonly args: readonly string[] } | undefined {
  for (const definition of sortedDirectCommandDefinitions) {
    const tokens = definition.command.name.split(" ");
    if (tokens.every((token, index) => args[index] === token)) {
      return { definition, args: args.slice(tokens.length) };
    }
  }
  return undefined;
}

function ambiguityError(args: readonly string[]): CliExecution | undefined {
  const [first, second] = args;
  const candidates = second ? [`${first} ${second}`, first] : [first];
  for (const candidate of candidates) {
    if (candidate && ambiguousCommandGuidance[candidate]) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: `${ambiguousCommandGuidance[candidate]}\n`
      };
    }
  }
  return undefined;
}

function renderComponents(): string {
  return `${qubeComponents.map(component => `${component.command}\t${component.packageName}\t${component.packageVersion}\t${component.summary}`).join("\n")}\n`;
}

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? "").split(path.delimiter).filter(entry => entry.length > 0);
}

function withPackageMetadata(
  component: QubeComponent,
  commandPath: string,
  source: CommandResolution["source"],
  packageJsonPath: string | undefined
): CommandResolution {
  const packageVersion = readPackageVersion(component.packageName, packageJsonPath);
  return {
    commandPath,
    source,
    ...(packageJsonPath ? { packageJsonPath } : {}),
    ...(packageVersion ? { packageVersion } : {})
  };
}

function readPackageVersion(packageName: string, packageJsonPath: string | undefined): string | undefined {
  if (!packageJsonPath || !existsSync(packageJsonPath)) {
    return undefined;
  }
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string; version?: string };
    return packageJson.name === packageName && typeof packageJson.version === "string" ? packageJson.version : undefined;
  } catch {
    return undefined;
  }
}

function findNearestPackageJson(commandPath: string): string | undefined {
  let current = path.dirname(realpathSync.native(commandPath));
  for (;;) {
    const packageJson = path.join(current, "package.json");
    if (existsSync(packageJson)) return packageJson;
    const next = path.dirname(current);
    if (next === current) return undefined;
    current = next;
  }
}

function commandNames(command: string, environment: CliEnvironment): readonly string[] {
  if ((environment.env.OS ?? "").toLowerCase().includes("windows") || process.platform === "win32") {
    return [`${command}.cmd`, `${command}.exe`, `${command}.bat`, command];
  }
  return [command];
}

function dispatchCommand(request: DispatchRequest): Promise<number> {
  return new Promise(resolve => {
    const [command, args] = spawnInput(request);
    const child = spawn(command, args, { stdio: "inherit", shell: false });
    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    });
    child.on("error", error => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      resolve(1);
    });
  });
}

function dispatchCommandCaptured(request: DispatchRequest): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const [command, args] = spawnInput(request);
    const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'pipe'], shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    child.on('error', error => resolve({ exitCode: 1, stdout, stderr: `${stderr}${error instanceof Error ? error.message : String(error)}\n` }));
  });
}

function spawnInput(request: DispatchRequest): [string, string[]] {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(request.commandPath)) {
    return [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", request.commandPath, ...request.args]];
  }
  return [request.commandPath, [...request.args]];
}
