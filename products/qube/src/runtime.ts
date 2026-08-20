import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, realpathSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createCliError } from "@tjalve/qube-cli/errors";
import { defineInstallerChoiceGroup, promptInstallerChoice, promptInstallerChoices, type InstallerChoice, type InstallerChoiceGroup } from "@tjalve/qube-cli/installer";
import { defineArgument, defineCommand, defineExtensions, defineFlag } from "@tjalve/qube-cli/metadata";
import { defineMutationMetadata, mutationCategories } from "@tjalve/qube-cli/mutation";
import { promptConfirm } from "@tjalve/qube-cli/prompts";
import { createCommandRegistry } from "@tjalve/qube-cli/registry";
import { createCli, createCommand as createRuntimeCommand, createSchemaCommand, runCli, type RuntimeCommandResult } from "@tjalve/qube-cli/runtime";
import { synthesizeAutoresearchArena } from "@tjalve/aib";
import { getAgentHostProfileSync, listInitExternalReviewers } from "@tjalve/aie";
import type { AgentHostId, AutoresearchArena, AutoresearchEvaluator, ConnectionContract } from "@tjalve/qube-core";
import { AGENT_HOST_IDS, qubeCommandSurfaceContracts, resolveExecutable } from "@tjalve/qube-core";

import { formatConnectionDoctor, runConnectionDoctor } from "./connection_doctor.js";
import { formatModelRoutingDoctor, formatPermutationDoctor, runModelRoutingDoctor, runPermutationDoctor } from "./permutation_doctor.js";
import { executorCiProviders, executorHostSurfaces, executorWorkProviders, findQubeComponent, qubeComponents, type QubeComponent, type QubeDiscoveryOption } from "./components.js";
import {
  applyUmpireHostProbes,
  composeHostToolkitManifests,
  defaultReviewSelection,
  formatHostToolkits,
  formatPlannedHostToolkits,
  probeHostToolkits,
  type HostToolkitReport,
} from "./host_toolkit.js";
import {
  QUBE_REVIEW_MODES,
  QUBE_REVIEW_PUBLISHERS,
  QUBE_UMPIRE_SCOPES,
  configForQubeScope,
  mergeQubeInitConfigs,
  readQubeInitConfig,
  repoQubeConfigPath,
  resolveQubeInitConfig,
  userQubeConfigPath,
  writeQubeInitConfig,
  type QubeExternalReviewer,
  type QubeInitConfig,
  type QubeReviewMode,
  type QubeReviewPublisher,
  type QubeUmpireScope,
} from "./init_config.js";
import { probeInstallState, type InstallStepStatus } from "./install_state.js";
import { formatPackageInstallCommand, packageInstallArgv } from "./install_packages.js";
import { verifyInstallRegistryGate, type RegistryGateResult } from "./install_registry.js";
import { buildShellCommandPlan } from "./process_launch.js";
import {
  buildInstallQuestions,
  DEFAULT_INSTALL_UI_AUDIT_EVIDENCE_ROOT,
  installQuestionGuideComplete,
  invalidInstallGuideFlag,
  isolatedReviewAvailable,
  recommendedInstallPackageManager,
  recommendedInstallReviewMode,
  type InstallReviewMode,
} from "./install_questions.js";
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
  readonly cwd: string;
}

export interface CliEnvironment {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly packageRoot?: string;
}

export interface CommandResolution {
  readonly commandPath: string;
  readonly source: "install" | "workspace";
  readonly packageJsonPath?: string;
  readonly packageVersion?: string;
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
type InstallHost = "codex" | "opencode" | "claude-code" | "grok-build" | "cursor";
type InstallWorkProvider = "github" | "gitlab" | "linear" | "jira";
type InstallCiProvider = "github" | "gitlab" | "jenkins";
type InstallLifecycleScripts = "disabled" | "review";
type YesNo = "yes" | "no";

interface InstallSelections {
  readonly scope: InstallScope;
  readonly packageManager: InstallPackageManager;
  readonly host: InstallHost;
  readonly hosts: readonly InstallHost[];
  readonly workProvider: InstallWorkProvider;
  readonly workProviders: readonly InstallWorkProvider[];
  readonly ciProvider: InstallCiProvider;
  readonly ciProviders: readonly InstallCiProvider[];
  readonly lifecycleScripts: InstallLifecycleScripts;
  readonly docs: boolean;
  readonly reviewMode: InstallReviewMode;
  readonly uiAuditEvidenceRoot: string;
  readonly creditWarning: boolean;
}

type InstallCommandStage = "package-install" | "workspace-init" | "provider-setup" | "verify";

interface InstallCommandStep {
  readonly stage: InstallCommandStage;
  readonly label: string;
  readonly command: string;
  readonly status: InstallStepStatus;
  readonly reason: string;
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
  readonly mode: "copy-commands" | "apply";
  readonly dryRun: boolean;
  readonly steps: readonly InstallCommandStep[];
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
  "codex": "Codex",
  "opencode": "OpenCode",
  "claude-code": "Claude Code",
  "grok-build": "Grok Build",
  cursor: "Cursor",
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
  name: "agent harness",
  message: "Which agent harness should QUBE configure?",
  defaultValue: "codex",
  choices: discoveryChoices<InstallHost>(executorHostSurfaces)
});
const workProviderChoices = defineInstallerChoiceGroup({
  name: "issue tracker",
  message: "Which issue tracker should QUBE use?",
  defaultValue: "github",
  choices: discoveryChoices<InstallWorkProvider>(executorWorkProviders)
});
const ciProviderChoices = defineInstallerChoiceGroup({
  name: "automated checks",
  message: "Which provider runs this repository's automated checks (CI)?",
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
const evidenceRootChoices = defineInstallerChoiceGroup({
  name: "UI audit evidence root",
  message: "Where should this machine keep local UI audit evidence?",
  defaultValue: "qube",
  choices: [
    {
      value: "qube",
      label: "QUBE user default",
      description: "Store UI audit evidence under ~/.qube/verification/.",
      recommended: true
    }
  ]
});
const attributionChoices = defineInstallerChoiceGroup({
  name: "attribution hygiene",
  message: "Should installed agent instructions keep public git and GitHub writes on the human project identity?",
  defaultValue: "true",
  choices: [
    {
      value: "true",
      label: "Yes. Install attribution hygiene rules.",
      description: "Public git and GitHub writes stay on the human project identity.",
      recommended: true
    },
    {
      value: "false",
      label: "No. Omit those rules from installed instructions.",
      description: "Do not add attribution hygiene rules."
    }
  ]
});

const applyFlag = defineFlag({
  name: "apply",
  description: "Execute the remaining install delta after confirmation. Pass --yes to skip the confirmation prompt.",
  type: "boolean"
});

const installCommand = defineCommand({
  kind: "command",
  name: "install",
  description: "Build a guided, supply-chain-safe QUBE install plan and optionally apply it.",
  flags: [
    jsonFlag,
    dryRunFlag,
    yesFlag,
    applyFlag,
    offlineFlag,
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
      description: `Comma-separated agent harnesses to select; the first is active. Default: codex. Use one or more of: ${discoveryOptionValues(executorHostSurfaces).join(", ")}.`,
      type: "string"
    }),
    defineFlag({
      name: "work-provider",
      description: `Comma-separated work providers to select; the first is active. Default: github. Use one or more of: ${discoveryOptionValues(executorWorkProviders).join(", ")}.`,
      type: "string"
    }),
    defineFlag({
      name: "ci-provider",
      description: `Comma-separated CI providers to select; the first is active. Default: github. Use one or more of: ${discoveryOptionValues(executorCiProviders).join(", ")}.`,
      type: "string"
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
      name: "review-mode",
      description: "Review mode written into the workspace-init command. Isolated is available only when a selected host adapter can run isolated review.",
      type: "option",
      options: ["isolated", "host", "external"]
    }),
    defineFlag({
      name: "ui-audit-evidence-root",
      description: "User-local directory that UI audit evidence should use. Default: ~/.qube/verification.",
      type: "string"
    }),
    defineFlag({
      name: "credit-warning",
      description: "Install attribution hygiene rules so public git and GitHub writes stay on the human project identity.",
      type: "boolean",
      negatable: true
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
    },
    {
      description: "Apply the remaining install delta without prompting.",
      command: "qube install --apply --yes"
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
  mutation: defineMutationMetadata({
    categories: mutationCategories("dependency", "local-files")
  }),
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
  readonly targetCommand: string;
  readonly supportsJson: boolean;
  readonly passthroughJson?: boolean;
  readonly qubePrimaryHelp?: boolean;
  readonly mapArgs: (args: readonly string[]) => readonly string[];
}

const doctorCommand = defineCommand({
  kind: "command",
  name: "doctor",
  description: "Aggregate Quality Control, Executor workflow, Umpire continuation, host toolkit completeness, and configured provider connection diagnostics.",
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

const forceFlag = defineFlag({
  name: "force",
  description: "Replace blocked managed sections or known fields intentionally.",
  type: "boolean"
});
const defaultsFlag = defineFlag({
  name: "defaults",
  description: "Use default repository policy values without prompting.",
  type: "boolean"
});

const initCommand = defineCommand({
  kind: "command",
  name: "init",
  description: "Initialize QUBE workspace setup by composing each installed component's init through its init capability contract.",
  arguments: [
    defineArgument({
      name: "target",
      description: "Target directory to initialize. Default: the current directory.",
      required: false
    })
  ],
  flags: [
    jsonFlag,
    dryRunFlag,
    yesFlag,
    forceFlag,
    defaultsFlag,
    defineFlag({
      name: "host",
      description: `Comma-separated agent harnesses to initialize. Default: codex. Use one or more of: ${discoveryOptionValues(executorHostSurfaces).join(", ")}.`,
      type: "string"
    }),
    defineFlag({
      name: "work-provider",
      description: `Comma-separated work providers to select; the first is active. Default: github. Use one or more of: ${discoveryOptionValues(executorWorkProviders).join(", ")}.`,
      type: "string"
    }),
    defineFlag({
      name: "ci-provider",
      description: `Comma-separated CI providers to select; the first is active. Default: github. Use one or more of: ${discoveryOptionValues(executorCiProviders).join(", ")}.`,
      type: "string"
    }),
    defineFlag({
      name: "mcp",
      description: "Opt in to host MCP wiring for exploratory reading. Default: off. Provider access stays on qube commands.",
      type: "boolean",
      negatable: true
    }),
    defineFlag({
      name: "config-scope",
      description: "Store QUBE setup choices for this repository or as user-global defaults. Repository values override global values.",
      type: "option",
      options: ["repo", "global"]
    }),
    defineFlag({
      name: "continuous-shipping",
      description: "Let QUBE complete the development cycle and continue with the next Ready issue. Default: on.",
      type: "boolean",
      negatable: true
    }),
    defineFlag({
      name: "umpire-scope",
      description: "Choose what Umpire may do after the current issue: Ready issues, the standard quality set, or a configured custom set.",
      type: "option",
      options: [...QUBE_UMPIRE_SCOPES]
    }),
    defineFlag({
      name: "quality-stage",
      description: "Comma-separated Quality stages. One stage includes all earlier stages; multiple stages run exactly those stages.",
      type: "string"
    }),
    defineFlag({
      name: "review-mode",
      description: "Choose review cost source: an external reviewer, subagents in the primary harness, or isolated agents in another harness.",
      type: "option",
      options: [...QUBE_REVIEW_MODES]
    }),
    defineFlag({
      name: "review-harness",
      description: "Agent harness that runs isolated review. It must differ from the primary harness and support isolated review.",
      type: "string"
    }),
    defineFlag({
      name: "external-reviewer",
      description: "Comma-separated external reviewers. Use one or more of: coderabbit, copilot, cubic.",
      type: "string"
    }),
    defineFlag({
      name: "review-publisher",
      description: "Publish with the current GitHub account or record QUBE Reviewer App setup as a follow-up.",
      type: "option",
      options: [...QUBE_REVIEW_PUBLISHERS]
    }),
    defineFlag({
      name: "ui-audit-evidence-root",
      description: "UI audit evidence root forwarded to Executor init.",
      type: "string"
    }),
    defineFlag({
      name: "credit-warning",
      description: "Attribution hygiene policy forwarded to Executor init.",
      type: "boolean",
      negatable: true
    })
  ],
  examples: [
    { description: "Initialize the current directory for Claude Code with GitHub providers.", command: "qube init . --host claude-code --work-provider github --ci-provider github --yes" },
    { description: "Initialize all components for multiple agent harnesses.", command: "qube init . --host claude-code,codex --yes --json" },
    { description: "Record an explicit MCP opt-in. This does not install provider MCP servers.", command: "qube init . --host claude-code --mcp --yes --dry-run --json" }
  ],
  interactions: {
    json: true,
    dryRun: {
      supported: true
    },
    noColor: true,
    nonInteractive: true,
    ttyPrompt: true
  }
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
    targetCommand: "init",
    supportsJson: true,
    mapArgs(args) {
      return mapIdeaArgs(args);
    }
  },
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
  createDirectCommand("review setup", "Explain the current GitHub account publisher and QUBE Reviewer App setup.", "aie", "review setup", { supportsJson: false, qubePrimaryHelp: true }),
  createDirectCommand("review setup github-app", "Configure the QUBE Reviewer GitHub App with safe secret references.", "aie", "review setup github-app", { passthroughJson: true, qubePrimaryHelp: true }),
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
  createDirectCommand("continue", "Show Umpire continuation status and resume guidance.", "aiu", "status"),
  createDirectCommand("whip", "Inspect and manage durable idle whip tasks.", "aiu", "whip"),
];

const directCommands = directCommandDefinitions.map(definition => definition.command);
const directCommandNames = new Set(directCommands.map(command => command.name));
const sortedDirectCommandDefinitions = [...directCommandDefinitions].sort((left, right) => right.command.name.split(" ").length - left.command.name.split(" ").length);

const ambiguousCommandGuidance: Readonly<Record<string, string>> = {
  config: "Config exists in multiple components. Use qube aiq config, qube aiu config, or qube aie init for Executor config setup.",
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

let runtimeRegistry = createCommandRegistry({ commands: [componentsCommand, installCommand, initCommand, doctorCommand, autoresearchCommand, oneshotCommand, makeItSoCommand, ...directCommands, runCommand, ...componentCommands] });

export function renderCommandSurfacesDoc(): string {
  const composerCommands = [componentsCommand, installCommand, initCommand, doctorCommand, autoresearchCommand, oneshotCommand, makeItSoCommand, runCommand];
  const lines: string[] = [
    "# QUBE Command Surfaces",
    "",
    "Generated from the composer command registry. Do not edit by hand; regenerate with `pnpm --dir products/qube run docs:surfaces` after a build.",
    "",
    "See also the static command-flow visual: [QUBE Command Surface: Idea to Complete Implementation](./qube-command-surface-visual.html).",
    "",
    "## Composer-level commands",
    "",
    "| Command | Description |",
    "| --- | --- |",
    ...composerCommands.map(command => `| \`qube ${command.name}\` | ${command.description} |`),
    "",
    "## Direct workflow commands",
    "",
    "Each direct command is the composer-facing name for one component command.",
    "",
    "| Command | Routes to | Description |",
    "| --- | --- | --- |",
    ...directCommandDefinitions.map(definition => `| \`qube ${definition.command.name}\` | \`${definition.component} ${definition.targetCommand}\` | ${definition.command.description} |`),
    "",
    "## Component passthroughs",
    "",
    "`qube components` exposes the package-level component CLIs only. Standalone-only package commands remain valid on each component CLI without being required for composer dispatch or component discovery.",
    "",
    "| Command | Component | Aliases |",
    "| --- | --- | --- |",
    ...qubeComponents.map(component => {
      const aliases = component.id === component.command || directCommandNames.has(component.id) ? '—' : `\`qube ${component.id}\``;
      return `| \`qube ${component.command} <args...>\` | ${component.packageName} | ${aliases} |`;
    }),
    "",
    "## Package command surface contracts",
    "",
    "Package-level classification from the core contracts: which package command patterns are QUBE-facing workflow surfaces and which stay standalone-only.",
    "",
    "| Package | Command pattern | Classification | QUBE-facing | Schema required | Notes |",
    "| --- | --- | --- | --- | --- | --- |",
    ...qubeCommandSurfaceContracts.map(contract => `| \`${contract.packageName}\` | \`${contract.commandPattern.replaceAll("|", "\\|")}\` | ${contract.classification} | ${contract.qubeFacing ? 'yes' : 'no'} | ${contract.schemaRequired ? 'yes' : 'no'} | ${contract.notes} |`),
    "",
  ];
  return lines.join("\n");
}

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
  if (args[0] === "init") {
    return planQubeInit(args.slice(1), environment);
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
  if (args[0] === "make-it-so") {
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
    return resolveComponentCommand(component, environment)?.commandPath;
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
    return withPackageMetadata(
      component,
      workspacePath,
      "workspace",
      path.join(environment.cwd, "node_modules", ...component.packageName.split("/"), "package.json")
    );
  }
  return undefined;
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
        return executeQubeInstall(flags, environment);
      }),
      createRuntimeCommand(initCommand, ({ flags, args }) => executeQubeInit(flags, args, environment)),
      createRuntimeCommand(doctorCommand, ({ flags }) => executeQubeDoctor(flags.json === true, flags.offline === true, environment)),
      createRuntimeCommand(autoresearchCommand, ({ argv }) => executeAutoresearch(argv, environment)),
      createRuntimeCommand(oneshotCommand, ({ argv }) => executeOneshot(argv, environment)),
      createRuntimeCommand(makeItSoCommand, ({ argv }) => executeMakeItSo(argv, environment)),
      ...directCommandDefinitions.map(definition => createRuntimeCommand(
        definition.command,
        ({ argv }) => executeDirectCommand(definition, argv, environment)
      )),
      createRuntimeCommand(runCommand, ({ args }) => executeQubeDispatch(readString(args.component), stripSeparator(readStringArray(args.args)), environment)),
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

interface QubeDoctorWorkflowSection {
  status: "ok" | "unavailable" | "not-run";
  readiness?: unknown;
  error?: string;
}

async function collectWorkflowReadiness(offline: boolean, environment: CliEnvironment): Promise<QubeDoctorWorkflowSection> {
  if (offline) {
    return { status: "not-run", error: "Offline doctor mode skips workflow readiness diagnostics." };
  }
  const planned = planQubeDispatch("aie", ["doctor", "--json"], environment);
  if (!planned.dispatch) {
    return { status: "unavailable", error: planned.stderr.trim() || "Executor doctor is unavailable." };
  }
  const captured = await dispatchCommandCaptured(planned.dispatch);
  if (captured.exitCode !== 0) {
    return { status: "unavailable", error: captured.stderr.trim() || `Executor doctor exited with code ${captured.exitCode}.` };
  }
  if (captured.truncated) {
    return { status: "unavailable", error: "Executor doctor output exceeded the capture limit; truncated output is never accepted as workflow readiness." };
  }
  try {
    const parsed = JSON.parse(captured.stdout) as { workflowReadiness?: unknown };
    if (parsed && typeof parsed === "object" && parsed.workflowReadiness) {
      return { status: "ok", readiness: parsed.workflowReadiness };
    }
    return { status: "unavailable", error: "Executor doctor returned no workflow readiness section." };
  } catch {
    return { status: "unavailable", error: "Executor doctor returned invalid JSON." };
  }
}

function formatWorkflowReadiness(workflow: QubeDoctorWorkflowSection): string {
  if (workflow.status !== "ok") {
    return `Workflow readiness: ${workflow.status}${workflow.error ? ` — ${workflow.error}` : ""}\n`;
  }
  const readiness = workflow.readiness as { stages?: Array<{ stage?: string; status?: string; detail?: string; nextAction?: string | null }> };
  const lines = ["Workflow readiness:"];
  for (const stage of readiness.stages ?? []) {
    lines.push(`- ${stage.stage}: ${stage.status} — ${stage.detail}${stage.nextAction ? ` Next: ${stage.nextAction}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

interface QubeDoctorContinuationSection {
  status: "ok" | "unavailable" | "not-run";
  report?: unknown;
  error?: string;
}

async function collectContinuationHealth(offline: boolean, environment: CliEnvironment): Promise<QubeDoctorContinuationSection> {
  if (offline) {
    return { status: "not-run", error: "Offline doctor mode skips continuation diagnostics." };
  }
  const planned = planQubeDispatch("aiu", ["doctor", "--json"], environment);
  if (!planned.dispatch) {
    return { status: "unavailable", error: planned.stderr.trim() || "Umpire doctor is unavailable." };
  }
  const captured = await dispatchCommandCaptured(planned.dispatch);
  if (captured.exitCode !== 0) {
    return { status: "unavailable", error: captured.stderr.trim() || `Umpire doctor exited with code ${captured.exitCode}.` };
  }
  if (captured.truncated) {
    return { status: "unavailable", error: "Umpire doctor output exceeded the capture limit; truncated output is never accepted as continuation health." };
  }
  try {
    const parsed = JSON.parse(captured.stdout) as { ok?: unknown; doctor?: unknown };
    if (parsed && typeof parsed === "object" && parsed.ok === true && parsed.doctor) {
      return { status: "ok", report: parsed.doctor };
    }
    return { status: "unavailable", error: "Umpire doctor returned no continuation report." };
  } catch {
    return { status: "unavailable", error: "Umpire doctor returned invalid JSON." };
  }
}

function continuationExitCode(continuation: QubeDoctorContinuationSection): number {
  if (continuation.status !== "ok") {
    return 0;
  }
  const report = continuation.report as { status?: string } | undefined;
  return report?.status === "error" ? 1 : 0;
}

function formatContinuationHealth(continuation: QubeDoctorContinuationSection): string {
  if (continuation.status !== "ok") {
    return `Continuation health: ${continuation.status}${continuation.error ? ` — ${continuation.error}` : ""}\n`;
  }
  const report = continuation.report as { status?: string } | undefined;
  return `Continuation health: ${report?.status ?? "unknown"}\n`;
}

function toolkitExitCode(hosts: HostToolkitReport): number {
  return hosts.status === "missing" || hosts.status === "partial" ? 1 : 0;
}

async function executeQubeDoctor(json: boolean, offline: boolean, environment: CliEnvironment): Promise<RuntimeCommandResult> {
  const connectionsPromise = runConnectionDoctor({
    cwd: environment.cwd,
    env: environment.env,
    mode: offline ? "offline" : "live",
  });
  const permutationPromise = runPermutationDoctor(environment.cwd);
  const modelRoutingPromise = runModelRoutingDoctor(environment.cwd);
  const workflowPromise = collectWorkflowReadiness(offline, environment);
  const continuationPromise = collectContinuationHealth(offline, environment);
  const [baseHosts, continuation] = await Promise.all([
    probeHostToolkits({ cwd: environment.cwd, env: environment.env, offline }),
    continuationPromise,
  ]);
  const hosts = applyUmpireHostProbes(baseHosts, continuation.report);
  const planned = planQubeDispatch("aiq", ["doctor", ...(json ? ["--format", "json"] : [])], environment);
  if (!planned.dispatch) {
    const [connections, permutation, modelRouting, workflow] = await Promise.all([connectionsPromise, permutationPromise, modelRoutingPromise, workflowPromise]);
    const connectionExitCode = connections.status === "fail" ? 1 : 0;
    const exitCode = planned.exitCode === 0
      ? Math.max(connectionExitCode, continuationExitCode(continuation), toolkitExitCode(hosts))
      : planned.exitCode || 1;
    if (json) {
      const payload = {
        ok: false,
        command: "doctor",
        quality: { ok: false, error: planned.stderr.trim() || "Quality Control doctor is unavailable." },
        workflow,
        continuation,
        hosts,
        permutation,
        modelRouting,
        connectionStatus: connections.status,
        connections,
      };
      return {
        exitCode,
        jsonStdout: `${JSON.stringify(payload)}\n`,
      };
    }
    return { exitCode, stdout: `${planned.stdout}${formatWorkflowReadiness(workflow)}${formatContinuationHealth(continuation)}${formatHostToolkits(hosts)}${formatPermutationDoctor(permutation)}${formatModelRoutingDoctor(modelRouting)}${formatConnectionDoctor(connections)}`, stderr: planned.stderr };
  }

  const [connections, permutation, modelRouting, quality, workflow] = await Promise.all([
    connectionsPromise,
    permutationPromise,
    modelRoutingPromise,
    dispatchCommandCaptured(planned.dispatch),
    workflowPromise,
  ]);
  const connectionExitCode = connections.status === "fail" ? 1 : 0;
  // Offline mode must not mask an actual Quality Control failure as success.
  let exitCode = quality.exitCode === 0
    ? Math.max(connectionExitCode, continuationExitCode(continuation), toolkitExitCode(hosts))
    : (quality.exitCode || 1);
  if (json) {
    let qualityPayload: unknown;
    try {
      qualityPayload = quality.truncated ? { ok: false, error: "Quality Control doctor output exceeded the capture limit." } : JSON.parse(quality.stdout);
    } catch {
      qualityPayload = { ok: false, error: "Quality Control doctor returned invalid JSON." };
    }
    // A zero exit with a failing or unreadable payload is still a failure.
    if (exitCode === 0 && (!qualityPayload || typeof qualityPayload !== "object" || (qualityPayload as { ok?: unknown }).ok === false)) {
      exitCode = 1;
    }
    const payload = {
      ok: exitCode === 0,
      command: "doctor",
      quality: qualityPayload,
      workflow,
      continuation,
      hosts,
      permutation,
      modelRouting,
      connectionStatus: connections.status,
      connections,
    };
    return { exitCode, jsonStdout: `${JSON.stringify(payload)}\n`, stderr: `${planned.stderr}${quality.stderr}` };
  }
  return {
    exitCode,
    stdout: `${quality.stdout.trimEnd()}\n\n${formatWorkflowReadiness(workflow)}${formatContinuationHealth(continuation)}${formatHostToolkits(hosts)}${formatPermutationDoctor(permutation)}${formatModelRoutingDoctor(modelRouting)}${formatConnectionDoctor(connections)}`,
    stderr: `${planned.stderr}${quality.stderr}`,
  };
}

interface QubeInitChildResult {
  readonly component: string;
  readonly args: readonly string[];
  readonly ok: boolean;
  readonly exitCode: number;
  readonly json?: unknown;
  readonly stderr?: string;
  readonly error?: string;
  readonly nextAction?: string;
}

function normalizeInitQuestionState(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.questions) || !Array.isArray(record.unansweredQuestionIds)) return value;
  const answeredIds = new Set(record.questions.flatMap(question => {
    if (question === null || typeof question !== "object" || Array.isArray(question)) return [];
    const candidate = question as Record<string, unknown>;
    return candidate.answered === true && typeof candidate.id === "string" ? [candidate.id] : [];
  }));
  return {
    ...record,
    unansweredQuestionIds: record.unansweredQuestionIds.filter(id => typeof id !== "string" || !answeredIds.has(id)),
  };
}

/** Every init child is dispatched with its own JSON flag and parsed defensively; a failed, unavailable, or non-envelope child is never coerced into ok:true. */
async function dispatchInitChild(componentName: string, args: readonly string[], environment: CliEnvironment, cwd = environment.cwd): Promise<QubeInitChildResult> {
  const planned = planQubeDispatch(componentName, args, environment);
  if (!planned.dispatch) {
    return { component: componentName, args, ok: false, exitCode: planned.exitCode || 1, error: planned.stderr.trim() || `${componentName} is unavailable.` };
  }
  const captured = await dispatchCommandCaptured({ ...planned.dispatch, cwd });
  if (captured.truncated) {
    return { component: componentName, args, ok: false, exitCode: captured.exitCode || 1, stderr: captured.stderr, error: `${componentName} output exceeded the capture limit; truncated output is never accepted.` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(captured.stdout);
  } catch {
    return {
      component: componentName,
      args,
      ok: false,
      exitCode: captured.exitCode === 0 ? 1 : captured.exitCode,
      stderr: captured.stderr,
      error: captured.stderr.trim() || `${componentName} did not return a single JSON envelope.`,
    };
  }
  const normalized = normalizeInitQuestionState(parsed);
  const isEnvelope = normalized !== null && typeof normalized === "object" && !Array.isArray(normalized);
  const ok = isEnvelope && (normalized as { ok?: unknown }).ok === true && captured.exitCode === 0;
  const failure = ok ? undefined : exactChildFailure(componentName, args, normalized, captured.stderr, captured.exitCode);
  return {
    component: componentName,
    args,
    ok,
    exitCode: captured.exitCode,
    ...(isEnvelope ? { json: normalized } : {}),
    stderr: captured.stderr,
    ...(failure ? { error: failure.error, ...(failure.nextAction ? { nextAction: failure.nextAction } : {}) } : {})
  };
}

function buildAieInitArgs(target: string, tool: AieInitTool | undefined, options: { readonly dryRun: boolean; readonly force: boolean; readonly yes: boolean; readonly defaults: boolean; readonly workProvider?: string; readonly reviewProvider?: string; readonly ciProvider?: string; readonly primaryHost?: string; readonly reviewMode?: string; readonly reviewAgents?: readonly string[]; readonly localReviewAgents?: readonly string[]; readonly isolatedReviewAgent?: string; readonly reviewModels?: readonly string[]; readonly publisher?: QubeReviewPublisher; readonly continuousShipping?: boolean; readonly uiAuditEvidenceRoot?: string; readonly creditWarning?: boolean }): readonly string[] {
  const args = ["init", target, "--json"];
  if (tool) args.push("--tool", tool);
  if (options.workProvider) args.push("--work-provider", options.workProvider);
  if (options.reviewProvider) args.push("--review-provider", options.reviewProvider);
  if (options.ciProvider) args.push("--ci-provider", options.ciProvider);
  if (options.primaryHost) args.push("--primary-host", options.primaryHost);
  if (options.reviewMode) args.push("--review-mode", options.reviewMode);
  if (options.reviewAgents && options.reviewAgents.length > 0) args.push("--review-agent", options.reviewAgents.join(","));
  if (options.localReviewAgents && options.localReviewAgents.length > 0) args.push("--local-review-agent", options.localReviewAgents.join(","));
  if (options.isolatedReviewAgent) args.push("--isolated-review-agent", options.isolatedReviewAgent);
  if (options.reviewModels && options.reviewModels.length > 0) args.push("--review-model", options.reviewModels.join(","));
  if (options.publisher) args.push("--publisher", options.publisher);
  if (options.continuousShipping === true) args.push("--autonomous");
  if (options.continuousShipping === false) args.push("--no-autonomous");
  if (options.uiAuditEvidenceRoot) args.push("--ui-audit-evidence-root", options.uiAuditEvidenceRoot);
  if (options.creditWarning === true) args.push("--credit-warning");
  if (options.creditWarning === false) args.push("--no-credit-warning");
  if (options.dryRun) args.push("--dry-run");
  if (options.force) args.push("--force");
  if (options.yes) args.push("--yes");
  if (options.defaults) args.push("--defaults");
  return args;
}

function buildAiuInitArgs(tool: string, options: { readonly dryRun: boolean; readonly force: boolean; readonly scope: QubeUmpireScope }): readonly string[] {
  const args = ["init", "--json"];
  args.push("--tool", tool, "--post-issue-scope", options.scope);
  if (options.dryRun) args.push("--dry-run");
  if (options.force) args.push("--force");
  return args;
}

type QubeInitComponentId = "aie" | "aib" | "aiq" | "aiu" | "labels";

interface QubeInitInvocation {
  readonly id: QubeInitComponentId;
  readonly component: "aie" | "aib" | "aiq" | "aiu";
  readonly args: readonly string[];
  readonly cwd: string;
}

function homeDirectory(environment: CliEnvironment): string {
  return environment.env.USERPROFILE ?? environment.env.HOME ?? homedir();
}

function resolveInitTarget(cwd: string, target: string): string {
  const selected = path.resolve(cwd, target);
  const probe = spawnSync("git", ["-C", selected, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (probe.status !== 0) return selected;
  const repositoryRoot = probe.stdout.trim();
  return repositoryRoot === "" ? selected : path.resolve(repositoryRoot);
}

function detectCiProviders(target: string): readonly InstallCiProvider[] {
  const detected: InstallCiProvider[] = [];
  const workflowDirectory = path.join(target, ".github", "workflows");
  try {
    if (existsSync(workflowDirectory) && statSync(workflowDirectory).isDirectory()) {
      const hasWorkflow = readdirSync(workflowDirectory).some(name => /\.ya?ml$/i.test(name));
      if (hasWorkflow) detected.push("github");
    }
  } catch {
    // An unreadable marker is ambiguous and must not become a detected choice.
  }
  if (existsSync(path.join(target, ".gitlab-ci.yml"))) detected.push("gitlab");
  if (existsSync(path.join(target, "Jenkinsfile"))) detected.push("jenkins");
  return Object.freeze([...new Set(detected)]);
}

function initConfigError(source: "user-global" | "repository", result: ReturnType<typeof readQubeInitConfig>): string | undefined {
  return result.status === "invalid"
    ? `The ${source} QUBE config is invalid: ${result.error ?? "unknown validation error"}`
    : undefined;
}

function initExplicitConfig(flags: Readonly<Record<string, unknown>>, interactiveAnswers: {
  readonly hosts?: readonly string[];
  readonly workProviders?: readonly string[];
  readonly ciProviders?: readonly string[];
} = {}): QubeInitConfig {
  const explicitReviewMode = readOption<QubeReviewMode>(flags, "review-mode");
  const reviewHarness = readOption<string>(flags, "review-harness");
  const externalReviewers = readOptionList<QubeExternalReviewer>(flags, "external-reviewer");
  const publisher = readOption<QubeReviewPublisher>(flags, "review-publisher");
  const config: QubeInitConfig = {
    version: 1,
    ...(interactiveAnswers.hosts ? { hosts: interactiveAnswers.hosts } : readOptionList<string>(flags, "host") ? { hosts: readOptionList<string>(flags, "host") } : {}),
    ...(interactiveAnswers.workProviders ? { workProviders: interactiveAnswers.workProviders } : readOptionList<string>(flags, "work-provider") ? { workProviders: readOptionList<string>(flags, "work-provider") } : {}),
    ...(interactiveAnswers.ciProviders ? { ciProviders: interactiveAnswers.ciProviders } : readOptionList<string>(flags, "ci-provider") ? { ciProviders: readOptionList<string>(flags, "ci-provider") } : {}),
    ...(typeof flags["continuous-shipping"] === "boolean" ? { continuousShipping: flags["continuous-shipping"] as boolean } : {}),
    ...(typeof flags["umpire-scope"] === "string" ? { umpire: { scope: flags["umpire-scope"] as QubeUmpireScope } } : {}),
    ...(readOptionList<string>(flags, "quality-stage") ? { quality: { stages: readOptionList<string>(flags, "quality-stage")! } } : {}),
    ...(explicitReviewMode || reviewHarness || externalReviewers || publisher ? {
      review: {
        ...(explicitReviewMode ? { mode: explicitReviewMode } : {}),
        ...(reviewHarness ? { harness: reviewHarness } : {}),
        ...(externalReviewers ? { externalReviewers } : {}),
        ...(publisher ? { publisher } : {}),
      },
    } : {}),
    ...(typeof flags.mcp === "boolean" ? { mcp: { optIn: flags.mcp } } : {}),
  };
  return Object.freeze(config);
}

function resolveExternalReviewerIds(
  requested: readonly string[],
  registered: readonly { readonly id: string; readonly aliases: readonly string[] }[],
): { readonly values: readonly string[]; readonly error?: string } {
  const values: string[] = [];
  for (const raw of requested) {
    const normalized = raw.trim().replace(/^@/, "").toLowerCase();
    const match = registered.find(reviewer => reviewer.id === normalized || reviewer.aliases.some(alias => alias.toLowerCase() === normalized));
    if (!match) {
      const available = registered.map(reviewer => reviewer.id).join(", ");
      return { values: Object.freeze(values), error: `External reviewer ${raw} is not registered for GitHub setup.${available === "" ? "" : ` Use one or more of: ${available}.`}` };
    }
    if (!values.includes(match.id)) values.push(match.id);
  }
  if (values.length === 0) return { values: Object.freeze([]), error: "External review requires a registered GitHub reviewer service." };
  return { values: Object.freeze(values) };
}

function childRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function directText(value: unknown, keys: readonly string[]): string | undefined {
  const record = childRecord(value);
  if (!record) return undefined;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
    if (Array.isArray(candidate)) {
      const messages = candidate.filter(item => typeof item === "string" && item.trim() !== "");
      if (messages.length > 0) return messages.join("; ");
    }
  }
  return undefined;
}

function exactChildFailure(component: string, args: readonly string[], json: unknown, stderr: string, exitCode: number): { readonly error: string; readonly nextAction?: string } {
  const record = childRecord(json);
  const nestedEnvelopes = record ? [record.error, record.init, record.setup, record.result] : [];
  const stderrText = stderr.trim() || undefined;
  const error = directText(record, ["error", "errors", "message", "likelyCause"])
    ?? nestedEnvelopes.map(value => directText(value, ["error", "errors", "message", "likelyCause"])).find(Boolean)
    ?? stderrText
    ?? directText(record, ["reason"])
    ?? `${component} ${args[0] ?? "init"} failed with exit code ${exitCode || 1}.`;
  const nextAction = directText(record, ["nextAction", "nextCommand", "recoveryAction", "suggestedNextAction"])
    ?? nestedEnvelopes.map(value => directText(value, ["nextAction", "nextCommand", "recoveryAction", "suggestedNextAction"])).find(Boolean);
  return { error, ...(nextAction ? { nextAction } : {}) };
}

function childPlanActions(value: unknown): readonly unknown[] {
  const record = childRecord(value);
  if (!record) return Object.freeze([]);
  if (Array.isArray(record.actions)) return Object.freeze(record.actions.map(summarizePlanAction));
  for (const key of ["init", "setup", "plan"]) {
    const nested = childRecord(record[key]);
    if (nested && Array.isArray(nested.actions)) return Object.freeze(nested.actions.map(summarizePlanAction));
    if (key === "init" && nested) {
      const actions = [nested.config, ...(Array.isArray(nested.files) ? nested.files : [])].filter(item => item !== undefined);
      if (actions.length > 0) return Object.freeze(actions.map(summarizePlanAction));
    }
  }
  const setup = childRecord(record.setup);
  if (setup) {
    return Object.freeze([setup.config, setup.progress].filter(value => value !== undefined).map(summarizePlanAction));
  }
  return Object.freeze([]);
}

function summarizePlanAction(value: unknown): unknown {
  const record = childRecord(value);
  if (!record) return value;
  return Object.freeze(Object.fromEntries(Object.entries(record).filter(([key]) => !["content", "hostProfiles"].includes(key))));
}

function childPostInitActions(value: unknown): readonly unknown[] {
  const record = childRecord(value);
  if (!record) return Object.freeze([]);
  if (Array.isArray(record.postInitActions)) return Object.freeze([...record.postInitActions]);
  for (const key of ["init", "setup", "plan"]) {
    const actions = childPostInitActions(record[key]);
    if (actions.length > 0) return actions;
  }
  return Object.freeze([]);
}

function childProviderActions(value: unknown): readonly unknown[] {
  const record = childRecord(value);
  if (!record) return Object.freeze([]);
  if (Array.isArray(record.providerActions)) return Object.freeze([...record.providerActions]);
  for (const key of ["init", "setup", "plan"]) {
    const actions = childProviderActions(record[key]);
    if (actions.length > 0) return actions;
  }
  return Object.freeze([]);
}

function childChanged(value: unknown): boolean {
  const record = childRecord(value);
  if (!record) return false;
  if (record.mutated === true || record.changed === true || record.applied === true) return true;
  if (Array.isArray(record.completedChanges) && record.completedChanges.length > 0) return true;
  for (const action of childPlanActions(record)) {
    const actionRecord = childRecord(action);
    const operation = actionRecord?.operation;
    if (typeof operation === "string" && !["skip", "skipped", "unchanged", "none"].includes(operation)) return true;
  }
  for (const key of ["init", "setup", "apply", "result"]) {
    if (childChanged(record[key])) return true;
  }
  return false;
}

function childPlanMetadata(value: unknown): Record<string, unknown> {
  const setup = childRecord(childRecord(value)?.setup);
  if (!setup) return {};
  return {
    ...(childRecord(setup.selection) ? { selection: setup.selection } : {}),
    ...(Array.isArray(setup.stageMetadata) ? { stageMetadata: setup.stageMetadata } : {}),
  };
}

function planRow(invocation: QubeInitInvocation, result: QubeInitChildResult): Record<string, unknown> {
  return {
    id: invocation.id,
    component: invocation.component,
    args: invocation.args,
    cwd: invocation.cwd,
    status: result.ok ? "ready" : "failed",
    actions: childPlanActions(result.json),
    ...childPlanMetadata(result.json),
    ...(result.ok ? {} : { error: result.error, ...(result.nextAction ? { nextAction: result.nextAction } : {}) }),
  };
}

function qubeConfigOperation(
  current: ReturnType<typeof readQubeInitConfig>,
  desired: QubeInitConfig,
  skipEmptyRepo: boolean,
): "create" | "update" | "skip" {
  if (skipEmptyRepo && current.status === "missing" && Object.keys(desired).length === 1) return "skip";
  if (current.status === "missing") return "create";
  if (current.config && JSON.stringify(current.config) === JSON.stringify(desired)) return "skip";
  return "update";
}

async function executeQubeInit(flags: Readonly<Record<string, unknown>>, args: Readonly<Record<string, unknown>>, environment: CliEnvironment): Promise<RuntimeCommandResult> {
  const targetPath = resolveInitTarget(environment.cwd, readString(args.target) ?? ".");
  const json = flags.json === true;
  const dryRun = flags["dry-run"] === true;
  const force = flags.force === true;
  const useDefaults = flags.yes === true || flags.defaults === true;
  const configScope = readOption<"repo" | "global">(flags, "config-scope") ?? "repo";
  const globalConfigPath = userQubeConfigPath(homeDirectory(environment));
  const repositoryConfigPath = repoQubeConfigPath(targetPath);
  const globalConfig = readQubeInitConfig(globalConfigPath);
  const repositoryConfig = readQubeInitConfig(repositoryConfigPath);
  const configError = initConfigError("user-global", globalConfig) ?? initConfigError("repository", repositoryConfig);
  if (configError) {
    const payload = { ok: false, command: "init", error: configError };
    return json
      ? { exitCode: 2, jsonStdout: `${JSON.stringify(payload)}\n` }
      : { exitCode: 2, stdout: "", stderr: `${configError}\n` };
  }

  const inherited = mergeQubeInitConfigs(globalConfig.config, repositoryConfig.config);
  const choiceFlags = { ...flags, yes: useDefaults };
  const hostSeed = readOptionList<InstallHost>(flags, "host") ?? inherited.hosts as readonly InstallHost[] | undefined;
  const hosts = await resolveInstallChoices(hostChoices, hostSeed, choiceFlags, initCommand);
  const workSeed = readOptionList<InstallWorkProvider>(flags, "work-provider") ?? inherited.workProviders as readonly InstallWorkProvider[] | undefined;
  const workProviders = await resolveInstallChoices(workProviderChoices, workSeed, choiceFlags, initCommand);
  const detectedCi = detectCiProviders(targetPath);
  const explicitCi = readOptionList<InstallCiProvider>(flags, "ci-provider");
  if (useDefaults && !explicitCi && !inherited.ciProviders && detectedCi.length !== 1) {
    const detail = detectedCi.length === 0 ? "no CI provider was detected" : `multiple CI providers were detected: ${detectedCi.join(", ")}`;
    const error = `Automated checks (CI) are ambiguous because ${detail}. Pass --ci-provider with the provider that runs required checks.`;
    return json
      ? { exitCode: 2, jsonStdout: `${JSON.stringify({ ok: false, command: "init", error })}\n` }
      : { exitCode: 2, stdout: "", stderr: `${error}\n` };
  }
  const ciSeed = explicitCi
    ?? inherited.ciProviders as readonly InstallCiProvider[] | undefined
    ?? (detectedCi.length === 1 ? detectedCi : undefined);
  const ciProviders = await resolveInstallChoices(ciProviderChoices, ciSeed, choiceFlags, initCommand);
  const interactive = !useDefaults;
  const explicit = initExplicitConfig(flags, {
    ...(readOptionList(flags, "host") || (!inherited.hosts && interactive) ? { hosts } : {}),
    ...(readOptionList(flags, "work-provider") || (!inherited.workProviders && interactive) ? { workProviders } : {}),
    ...(readOptionList(flags, "ci-provider") || (!inherited.ciProviders && detectedCi.length !== 1 && interactive) ? { ciProviders } : {}),
  });
  const registeredReviewers = await listInitExternalReviewers();
  const recommendedReviewer = registeredReviewers.find(reviewer => reviewer.id === "coderabbit") ?? registeredReviewers[0];
  const defaultReview = defaultReviewSelection(hosts);
  const defaultsConfig = Object.freeze({
    version: 1,
    hosts: Object.freeze(["codex"]),
    workProviders: Object.freeze(["github"]),
    ciProviders: Object.freeze(["github"]),
    continuousShipping: true,
    umpire: Object.freeze({ scope: "ready" as const }),
    quality: Object.freeze({ stages: Object.freeze(["unit"]) }),
    review: Object.freeze({
      mode: defaultReview.mode,
      ...(defaultReview.harness ? { harness: defaultReview.harness } : {}),
      externalReviewers: Object.freeze(recommendedReviewer ? [recommendedReviewer.id] : []),
      publisher: "user" as const,
    }),
    mcp: Object.freeze({ optIn: false }),
  });
  const detectedConfig: QubeInitConfig = Object.freeze({
    version: 1,
    ...(detectedCi.length === 1 ? { ciProviders: detectedCi } : {}),
  });
  const baseResolved = resolveQubeInitConfig({
    globalConfig: globalConfig.config,
    repoConfig: repositoryConfig.config,
    detected: detectedConfig,
    explicit,
    defaults: defaultsConfig,
  });
  let resolved = baseResolved;
  if (baseResolved.config.review.mode === "external") {
    const reviewerSelection = resolveExternalReviewerIds(baseResolved.config.review.externalReviewers ?? [], registeredReviewers);
    if (reviewerSelection.error) {
      return json
        ? { exitCode: 2, jsonStdout: `${JSON.stringify({ ok: false, command: "init", error: reviewerSelection.error })}\n` }
        : { exitCode: 2, stdout: "", stderr: `${reviewerSelection.error}\n` };
    }
    resolved = Object.freeze({
      ...baseResolved,
      config: Object.freeze({
        ...baseResolved.config,
        review: Object.freeze({ ...baseResolved.config.review, externalReviewers: reviewerSelection.values }),
      }),
    });
  }
  const setup = resolved.config;
  const reviewProvider = setup.workProviders[0] === "gitlab" ? "gitlab" : "github";
  const primaryHarness = setup.hosts[0]!;
  const reviewHarness = setup.review.harness;
  const requestedReviewHarness = explicit.review?.harness;
  const requestedExternalReviewers = explicit.review?.externalReviewers;
  let reviewError: string | undefined;
  if (setup.review.mode === "external" && reviewProvider !== "github") {
    reviewError = `External reviewer services are not registered for the ${reviewProvider} review provider.`;
  } else if (setup.review.mode === "external" && requestedReviewHarness) {
    reviewError = "External review does not use an agent harness.";
  } else if (setup.review.mode !== "external" && requestedExternalReviewers && requestedExternalReviewers.length > 0) {
    reviewError = "External reviewer services require external review mode.";
  } else if (setup.review.mode === "host") {
    if (requestedReviewHarness && requestedReviewHarness !== primaryHarness) reviewError = `Primary-harness review must use ${primaryHarness}.`;
    else if (reviewHarness !== primaryHarness) reviewError = `Primary-harness review must use ${primaryHarness}.`;
    else if (getAgentHostProfileSync(primaryHarness as AgentHostId).review.local.support === "unsupported") reviewError = `${primaryHarness} does not support native review subagents.`;
  } else if (setup.review.mode === "isolated") {
    if (!reviewHarness) reviewError = "Isolated review requires another selected agent harness.";
    else if (reviewHarness === primaryHarness) reviewError = "Isolated review must use an agent harness other than the primary harness.";
    else if (!setup.hosts.includes(reviewHarness)) reviewError = `Isolated review harness ${reviewHarness} is not in the selected agent harnesses.`;
    else if (getAgentHostProfileSync(reviewHarness as AgentHostId).review.isolated.support === "unsupported") reviewError = `${reviewHarness} does not support isolated review.`;
  }
  if (reviewError) {
    return json
      ? { exitCode: 2, jsonStdout: `${JSON.stringify({ ok: false, command: "init", error: reviewError })}\n` }
      : { exitCode: 2, stdout: "", stderr: `${reviewError}\n` };
  }
  if (setup.review.publisher === "github-app" && reviewProvider !== "github") {
    const error = "QUBE Reviewer App publishing requires the GitHub review provider.";
    return json
      ? { exitCode: 2, jsonStdout: `${JSON.stringify({ ok: false, command: "init", error })}\n` }
      : { exitCode: 2, stdout: "", stderr: `${error}\n` };
  }

  const selectedConfigPath = configScope === "global" ? globalConfigPath : repositoryConfigPath;
  const selectedConfigRead = configScope === "global" ? globalConfig : repositoryConfig;
  const selectedConfig = configForQubeScope(resolved, configScope, globalConfig.config);
  const configOperation = qubeConfigOperation(selectedConfigRead, selectedConfig, configScope === "repo");
  if (configScope === "global") {
    const projectedMerged = mergeQubeInitConfigs(selectedConfig, repositoryConfig.config);
    const projectedHosts = projectedMerged.hosts && projectedMerged.hosts.length > 0
      ? projectedMerged.hosts
      : defaultsConfig.hosts;
    const projectedReview = defaultReviewSelection(projectedHosts);
    const projectedDefaults = Object.freeze({
      ...defaultsConfig,
      review: Object.freeze({
        mode: projectedReview.mode,
        ...(projectedReview.harness ? { harness: projectedReview.harness } : {}),
        externalReviewers: defaultsConfig.review.externalReviewers,
        publisher: defaultsConfig.review.publisher,
      }),
    });
    const projectedResolved = resolveQubeInitConfig({
      globalConfig: selectedConfig,
      repoConfig: repositoryConfig.config,
      detected: detectedConfig,
      defaults: projectedDefaults,
    });
    let projectedSetup = projectedResolved.config;
    if (projectedSetup.review.mode === "external") {
      const reviewerSelection = resolveExternalReviewerIds(projectedSetup.review.externalReviewers ?? [], registeredReviewers);
      if (!reviewerSelection.error) {
        projectedSetup = Object.freeze({
          ...projectedSetup,
          review: Object.freeze({ ...projectedSetup.review, externalReviewers: reviewerSelection.values }),
        });
      }
    }
    if (JSON.stringify(projectedSetup) !== JSON.stringify(setup)) {
      const error = "Repository QUBE configuration overrides the requested global setup. Use --config-scope repo for this repository, or remove the conflicting repository values before updating global defaults.";
      return json
        ? { exitCode: 2, jsonStdout: `${JSON.stringify({ ok: false, command: "init", error })}\n` }
        : { exitCode: 2, stdout: "", stderr: `${error}\n` };
    }
  }

  const aieTool = resolveAieInitToolTargets(setup.hosts as readonly InstallHost[])[0];
  const aiuTool = resolveAiuInitToolTargets(setup.hosts as readonly InstallHost[])[0] ?? "none";
  const buildInvocations = (planOnly: boolean): readonly QubeInitInvocation[] => Object.freeze([
    {
      id: "aie",
      component: "aie",
      cwd: targetPath,
      args: buildAieInitArgs(targetPath, aieTool, {
        dryRun: planOnly,
        force,
        yes: true,
        defaults: false,
        workProvider: setup.workProviders[0],
        reviewProvider,
        ciProvider: setup.ciProviders[0],
        primaryHost: primaryHarness,
        reviewMode: setup.review.mode,
        reviewAgents: setup.review.mode === "external" ? setup.review.externalReviewers : undefined,
        localReviewAgents: setup.review.mode === "host" ? [primaryHarness] : undefined,
        isolatedReviewAgent: setup.review.mode === "isolated" ? reviewHarness : undefined,
        reviewModels: setup.review.models,
        publisher: reviewProvider === "github" ? setup.review.publisher : undefined,
        continuousShipping: setup.continuousShipping,
        uiAuditEvidenceRoot: readOption<string>(flags, "ui-audit-evidence-root"),
        creditWarning: typeof flags["credit-warning"] === "boolean" ? flags["credit-warning"] : undefined,
      }),
    },
    {
      id: "aib",
      component: "aib",
      cwd: targetPath,
      args: Object.freeze([
        "init",
        targetPath,
        "--json",
        "--agent",
        setup.hosts[0],
        "--surfaces",
        setup.hosts.join(","),
        ...(planOnly ? ["--dry-run"] : []),
      ]),
    },
    {
      id: "aiq",
      component: "aiq",
      cwd: targetPath,
      args: Object.freeze([
        "config",
        "--stages",
        setup.quality.stages.join(","),
        "--format",
        "json",
        ...(planOnly ? ["--dry-run"] : []),
      ]),
    },
    {
      id: "aiu",
      component: "aiu",
      cwd: targetPath,
      args: buildAiuInitArgs(aiuTool, { dryRun: planOnly, force, scope: setup.umpire.scope }),
    },
  ]);

  const planInvocations = buildInvocations(true);
  const planResults = await Promise.all(planInvocations.map(invocation =>
    dispatchInitChild(invocation.component, invocation.args, environment, invocation.cwd)));
  const firstPlanFailureIndex = planResults.findIndex(result => !result.ok);
  const postInitActions = Object.freeze(planResults.flatMap(result => childPostInitActions(result.json)));
  const providerActions = Object.freeze(planResults.flatMap(result => childProviderActions(result.json)));
  const plan = {
    target: targetPath,
    resolved: setup,
    sources: resolved.sources,
    deviations: resolved.deviations,
    components: planInvocations.map((invocation, index) => planRow(invocation, planResults[index]!)),
    providerActions,
    postInitActions,
    config: {
      scope: configScope,
      path: selectedConfigPath,
      operation: configOperation,
    },
  };
  const planStderr = planResults.map(result => result.stderr ?? "").join("");
  if (firstPlanFailureIndex >= 0) {
    const failure = planResults[firstPlanFailureIndex]!;
    const payload = {
      ok: false,
      command: "init",
      mode: "plan",
      plan,
      error: failure.error,
      ...(failure.nextAction ? { nextAction: failure.nextAction } : {}),
    };
    return json
      ? { exitCode: failure.exitCode || 1, jsonStdout: `${JSON.stringify(payload)}\n`, stderr: planStderr }
      : { exitCode: failure.exitCode || 1, stdout: "", stderr: `${failure.error ?? "QUBE init planning failed."}\n${failure.nextAction ? `${failure.nextAction}\n` : ""}${planStderr}` };
  }

  if (dryRun) {
    const payload = { ok: true, command: "init", mode: "plan", plan };
    if (json) return { exitCode: 0, jsonStdout: `${JSON.stringify(payload)}\n`, stderr: planStderr };
    return {
      exitCode: 0,
      stdout: renderQubeInitSummary("plan", setup, planInvocations.map(invocation => invocation.id), configOperation, postInitActions),
      stderr: planStderr,
    };
  }

  const applyInvocations = buildInvocations(false);
  const applySteps: Array<Record<string, unknown>> = [];
  const applyStderr: string[] = [];
  if (configOperation !== "skip") {
    try {
      writeQubeInitConfig(selectedConfigPath, selectedConfig);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const nextAction = `Check write access to ${selectedConfigPath}, then rerun qube init with the same selections.`;
      const apply = {
        changed: false,
        steps: Object.freeze([{ id: "config", status: "failed", exitCode: 1, error: message, nextAction }]),
      };
      const payload = { ok: false, command: "init", mode: "apply", plan, apply, error: message, nextAction };
      return json
        ? { exitCode: 1, jsonStdout: `${JSON.stringify(payload)}\n`, stderr: planStderr }
        : { exitCode: 1, stdout: "", stderr: `${message}\n${nextAction}\n${planStderr}` };
    }
  }
  let failedApply: QubeInitChildResult | undefined;
  for (const invocation of applyInvocations) {
    const result = await dispatchInitChild(invocation.component, invocation.args, environment, invocation.cwd);
    if (result.stderr) applyStderr.push(result.stderr);
    applySteps.push({
      id: invocation.id,
      status: result.ok ? (childChanged(result.json) ? "changed" : "unchanged") : "failed",
      exitCode: result.exitCode,
      ...(result.ok ? {} : { error: result.error, ...(result.nextAction ? { nextAction: result.nextAction } : {}) }),
      result: result.json,
    });
    if (!result.ok) {
      failedApply = result;
      break;
    }
  }
  if (!failedApply && setup.workProviders[0] === "github") {
    const invocation: QubeInitInvocation = {
      id: "labels",
      component: "aie",
      cwd: targetPath,
      args: Object.freeze(["labels", "setup", "--json"]),
    };
    const result = await dispatchInitChild(invocation.component, invocation.args, environment, invocation.cwd);
    if (result.stderr) applyStderr.push(result.stderr);
    applySteps.push({
      id: invocation.id,
      status: result.ok ? (childChanged(result.json) ? "changed" : "unchanged") : "failed",
      exitCode: result.exitCode,
      ...(result.ok ? {} : { error: result.error, ...(result.nextAction ? { nextAction: result.nextAction } : {}) }),
      result: result.json,
    });
    if (!result.ok) failedApply = result;
  }
  const changed = configOperation !== "skip" || applySteps.some(step => step.status === "changed");
  const apply = { changed, steps: Object.freeze(applySteps) };
  const stderr = `${planStderr}${applyStderr.join("")}`;
  if (failedApply) {
    const payload = {
      ok: false,
      command: "init",
      mode: "apply",
      plan,
      apply,
      error: failedApply.error,
      ...(failedApply.nextAction ? { nextAction: failedApply.nextAction } : {}),
    };
    return json
      ? { exitCode: failedApply.exitCode || 1, jsonStdout: `${JSON.stringify(payload)}\n`, stderr }
      : { exitCode: failedApply.exitCode || 1, stdout: "", stderr: `${failedApply.error ?? "QUBE init apply failed."}\n${failedApply.nextAction ? `${failedApply.nextAction}\n` : ""}` };
  }

  const payload = { ok: true, command: "init", mode: "apply", plan, apply };
  if (json) return { exitCode: 0, jsonStdout: `${JSON.stringify(payload)}\n`, stderr };
  return {
    exitCode: 0,
    stdout: renderQubeInitSummary("apply", setup, applySteps.map(step => String(step.id)), configOperation, postInitActions),
    stderr,
  };
}

function renderQubeInitSummary(
  mode: "plan" | "apply",
  setup: ReturnType<typeof resolveQubeInitConfig>["config"],
  componentIds: readonly string[],
  configOperation: "create" | "update" | "skip",
  postInitActions: readonly unknown[],
): string {
  const lines = [
    `QUBE init ${mode === "plan" ? "plan is ready" : "is complete"}.`,
    `Agent harnesses: ${setup.hosts.join(", ")}`,
    `Issue tracker: ${setup.workProviders.join(", ")}`,
    `Automated checks (CI): ${setup.ciProviders.join(", ")}`,
    `Continuous Shipping: ${setup.continuousShipping ? "on" : "off"}`,
    `Umpire: ${setup.umpire.scope}`,
    `Quality stages: ${setup.quality.stages.join(", ")}`,
    `Review: ${setup.review.mode}; publisher ${setup.review.publisher}`,
    `Components: ${componentIds.join(", ")}`,
    `QUBE configuration: ${configOperation}`,
  ];
  for (const action of postInitActions) {
    const command = childRecord(action)?.command;
    if (typeof command === "string") lines.push(`Next: ${command}`);
  }
  if (mode === "apply") lines.push("Start a new agent session so the selected harness loads the new instructions.");
  return `${lines.join("\n")}\n`;
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
  const commandPlan = buildShellCommandPlan(context.evaluator.command ?? "");
  const result = spawnSync(commandPlan.executable, commandPlan.args, {
    cwd: workspacePath,
    shell: false,
    encoding: "utf8",
    windowsVerbatimArguments: commandPlan.windowsVerbatimArguments,
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
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    dispatch: {
      component,
      commandPath: resolution.commandPath,
      resolution,
      args: componentArgs,
      cwd: environment.cwd
    }
  };
}

function isRegularFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function hasNodeShebang(filePath: string): boolean {
  try {
    const head = readFileSync(filePath, { encoding: "utf8" }).slice(0, 80);
    return /^#!\s*(?:\/usr\/bin\/env\s+node|\/usr\/bin\/node|\/bin\/node)\b/.test(head);
  } catch {
    return false;
  }
}

function resolveNodeScriptForCommand(commandPath: string): string | undefined {
  const companion = path.join(
    path.dirname(commandPath),
    `${path.basename(commandPath).replace(/\.(?:cmd|bat|exe)$/i, "")}.mjs`
  );
  if (isRegularFile(companion)) return companion;
  if (/\.(?:js|mjs|cjs)$/i.test(commandPath) && isRegularFile(commandPath)) return commandPath;
  if (isRegularFile(commandPath) && hasNodeShebang(commandPath)) return commandPath;
  return undefined;
}

function resolveCommandFromEntries(command: string, entries: readonly string[], environment: CliEnvironment): string | undefined {
  const windows = process.platform === "win32" || String(environment.env.OS ?? "").toLowerCase().includes("windows");
  const delimiter = windows ? ";" : ":";
  const found = resolveExecutable(command, {
    env: { ...environment.env, PATH: entries.filter(entry => entry.trim() !== "").join(delimiter) },
    platform: windows ? "win32" : process.platform,
    pathDelimiter: delimiter,
  });
  return found.resolvedPath ?? undefined;
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
  if (isDirectHelpRequest(args)) {
    const planned = planQubeDispatch(definition.component, mapped.args, environment);
    if (!planned.dispatch) return { exitCode: planned.exitCode, stdout: planned.stdout, stderr: planned.stderr };
    const captured = await dispatchCommandCaptured(planned.dispatch);
    return {
      exitCode: captured.exitCode,
      stdout: definition.qubePrimaryHelp
        ? rewriteQubeReviewHelp(captured.stdout, definition.command.name)
        : rewriteDirectCommandHelp(captured.stdout, definition),
      stderr: `${planned.stderr}${captured.stderr}`,
    };
  }
  if (definition.passthroughJson && hasTopLevelJsonFlag(args)) {
    return executeQubeJsonDispatch(definition.component, mapped.args, environment);
  }
  // A JSON-requesting direct command must capture the child envelope so exactly one JSON object reaches stdout.
  if (definition.supportsJson && mappedArgsRequestJson(mapped.args)) {
    return executeQubeJsonDispatch(definition.component, mapped.args, environment);
  }
  return executeQubeDispatch(definition.component, mapped.args, environment);
}

function mappedArgsRequestJson(args: readonly string[]): boolean {
  if (args.includes("--json")) return true;
  const formatIndex = args.indexOf("--format");
  return formatIndex >= 0 && args[formatIndex + 1] === "json";
}

function rewriteDirectCommandHelp(output: string, definition: DirectQubeCommand): string {
  const componentPath = `${definition.component} ${definition.targetCommand}`;
  const primary = output.split(componentPath).join(`qube ${definition.command.name}`).trimEnd();
  return `${primary}\n\nEquivalent paths: \`qube ${componentPath}\` or \`${componentPath}\`.\n`;
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
  // A planning failure has no child envelope; forwarding stderr without jsonStdout preserves the exit code and cause in one synthesized envelope.
  if (!planned.dispatch) return { exitCode: planned.exitCode, stderr: joinNonEmpty(planned.stderr, planned.stdout) };
  const captured = await dispatchCommandCaptured(planned.dispatch);
  const stderr = `${planned.stderr}${captured.stderr}`;
  let envelope: unknown;
  try {
    envelope = captured.truncated ? undefined : JSON.parse(captured.stdout);
  } catch {
    envelope = undefined;
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || typeof (envelope as Record<string, unknown>).ok !== "boolean") {
    // The child violated the single-JSON-envelope contract (one object carrying the shared ok field);
    // forward the failure so exactly one envelope is synthesized.
    return {
      exitCode: captured.exitCode === 0 ? 1 : captured.exitCode,
      stderr: `${stderr}${captured.stdout.trim() === "" ? "" : `Component output was not a single JSON envelope object: ${captured.stdout.trim().slice(0, 200)}\n`}`,
    };
  }
  return {
    exitCode: captured.exitCode,
    jsonStdout: captured.stdout,
    stderr,
  };
}

function joinNonEmpty(...parts: readonly string[]): string {
  return parts.filter(part => part.trim() !== "").join("");
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

interface InstallApplyStepResult {
  readonly stage: InstallCommandStage;
  readonly command: string;
  readonly status: "executed" | "skipped" | "failed" | "plan-only";
  readonly exitCode?: number;
  readonly error?: string;
}

interface InstallApplyReport {
  readonly confirmed: true;
  readonly executed: readonly InstallApplyStepResult[];
  readonly registry?: RegistryGateResult;
  readonly components?: unknown;
  readonly doctor?: unknown;
  readonly mismatches: readonly string[];
  readonly findings: readonly string[];
}

function shouldStayPlanOnly(flags: Readonly<Record<string, unknown>>): boolean {
  return flags.apply !== true || flags["dry-run"] === true || (flags.json === true && flags.yes !== true);
}

function unsupportedApplySelections(selections: InstallSelections): readonly string[] {
  const reasons: string[] = [];
  for (const [label, ids, catalog] of [
    ["host", selections.hosts, executorHostSurfaces],
    ["work-provider", selections.workProviders, executorWorkProviders],
    ["ci-provider", selections.ciProviders, executorCiProviders]
  ] as const) {
    for (const id of ids) {
      const option = catalog.find(candidate => candidate.id === id);
      if (option?.support === "unsupported") {
        reasons.push(`${label} ${id}`);
      }
    }
  }
  return Object.freeze(reasons);
}

function applyConfirmMessage(plan: InstallPlan): string {
  const commands = plan.commands.filter(step => step.stage !== "verify");
  const listed = commands.length === 0
    ? "No remaining install delta. Verification will still run."
    : commands.map((step, index) => `${index + 1}. ${step.command}`).join("\n");
  return `Apply these install commands?\n${listed}\nThen verify with qube components --json and qube doctor.`;
}

function remainingApplySteps(selections: InstallSelections, cwd: string): readonly InstallCommandStep[] {
  return createInstallCommands(selections, cwd).filter(step => step.stage !== "verify" && (step.status === "missing" || step.status === "stale"));
}

function collectInstallMismatches(selections: InstallSelections, environment: CliEnvironment): readonly string[] {
  const mismatches: string[] = [];
  const packageState = probeInstallState(environment.cwd, selections).find(step => step.stage === "package-install");
  if (packageState && packageState.status !== "satisfied") {
    mismatches.push(packageState.reason);
  }
  for (const component of qubeComponents) {
    const resolution = resolveComponentCommand(component, environment);
    if (!resolution) {
      mismatches.push(`Missing ${component.packageName}@${component.packageVersion}.`);
      continue;
    }
    if (resolution.packageVersion && resolution.packageVersion !== component.packageVersion) {
      mismatches.push(`Expected ${component.packageName}@${component.packageVersion}, found ${resolution.packageVersion}.`);
    }
  }
  return Object.freeze(mismatches);
}

function isComponentsEnvelope(payload: unknown): payload is { readonly ok: true; readonly command: "components"; readonly components: readonly unknown[] } {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const record = payload as Record<string, unknown>;
  return record.ok === true && record.command === "components" && Array.isArray(record.components);
}

function isVerificationError(payload: unknown, kind: "components" | "doctor"): boolean {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return true;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.error === "string" && record.command === undefined) {
    return true;
  }
  if (kind === "components") {
    return !isComponentsEnvelope(payload);
  }
  return false;
}

function doctorFindings(payload: unknown): readonly string[] {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return Object.freeze(["Doctor did not return a JSON object."]);
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.error === "string" && record.error.trim() !== "") {
    return Object.freeze([record.error]);
  }
  const findings: string[] = [];
  if (record.ok === false) {
    findings.push("Doctor reported a failed verification.");
  }
  if (record.connectionStatus === "fail") {
    findings.push("A configured provider connection failed.");
  }
  const hosts = record.hosts;
  if (hosts && typeof hosts === "object" && !Array.isArray(hosts)) {
    const status = (hosts as { status?: unknown }).status;
    if (status === "missing" || status === "partial") {
      findings.push(`Host toolkit status is ${status}.`);
    }
  }
  return Object.freeze(findings);
}

async function runApplyPackageInstall(selections: InstallSelections, environment: CliEnvironment): Promise<InstallApplyStepResult> {
  const command = formatPackageInstallCommand(selections);
  const argv = packageInstallArgv(selections);
  const commandPath = resolveCommandFromEntries(argv.command, [
    path.join(environment.cwd, "node_modules", ".bin"),
    ...pathEntries(environment.env)
  ], environment);
  if (!commandPath) {
    return {
      stage: "package-install",
      command,
      status: "failed",
      error: `Cannot find ${argv.command} on PATH. Install the selected package manager or pass a PATH that includes it.`
    };
  }
  const spawned = await spawnCapturedPath(commandPath, argv.args, environment);
  if (spawned.exitCode !== 0) {
    return {
      stage: "package-install",
      command,
      status: "failed",
      exitCode: spawned.exitCode,
      error: spawned.stderr.trim() || spawned.stdout.trim() || `${argv.command} exited with code ${spawned.exitCode}.`
    };
  }
  return { stage: "package-install", command, status: "executed", exitCode: spawned.exitCode };
}

async function runApplyWorkspaceInit(selections: InstallSelections, environment: CliEnvironment): Promise<InstallApplyStepResult> {
  const command = buildQubeInitCommand(selections);
  const result = await executeQubeInit({
    json: true,
    yes: true,
    host: selections.hosts.join(","),
    "work-provider": selections.workProviders.join(","),
    "ci-provider": selections.ciProviders.join(",")
  }, { target: "." }, environment);
  if ((result.exitCode ?? 0) !== 0) {
    return {
      stage: "workspace-init",
      command,
      status: "failed",
      exitCode: result.exitCode,
      error: result.stderr?.trim() || "qube init did not report success."
    };
  }
  return { stage: "workspace-init", command, status: "executed", exitCode: result.exitCode ?? 0 };
}

async function runApplyProviderSetup(step: InstallCommandStep, environment: CliEnvironment): Promise<InstallApplyStepResult> {
  const result = await executeQubeDispatch("aie", ["labels", "setup"], environment);
  if ((result.exitCode ?? 0) !== 0) {
    return {
      stage: "provider-setup",
      command: step.command,
      status: "failed",
      exitCode: result.exitCode,
      error: result.stderr?.trim() || "Provider setup did not report success."
    };
  }
  return { stage: "provider-setup", command: step.command, status: "executed", exitCode: result.exitCode ?? 0 };
}

async function runApplyComponents(environment: CliEnvironment, scope: InstallScope): Promise<unknown> {
  const entries = scope === "global"
    ? pathEntries(environment.env)
    : [path.join(environment.cwd, "node_modules", ".bin")];
  const commandPath = resolveCommandFromEntries("qube", entries, environment);
  if (!commandPath) {
    return { error: "Cannot find qube to run components --json after apply." };
  }
  const nodeScript = resolveNodeScriptForCommand(commandPath);
  const spawned = nodeScript
    ? await spawnCapturedPath(process.execPath, [nodeScript, "components", "--json"], environment)
    : await spawnCapturedPath(commandPath, ["components", "--json"], environment);
  const launched = nodeScript ?? commandPath;
  if (spawned.truncated) {
    return { error: "qube components --json output exceeded the capture limit." };
  }
  if (spawned.exitCode !== 0) {
    return { error: spawned.stderr.trim() || `qube components --json exited with code ${spawned.exitCode}.` };
  }
  const stdout = spawned.stdout.trim();
  if (stdout === "") {
    return {
      error: spawned.stderr.trim() || `qube components --json did not return a JSON envelope (${launched}).`
    };
  }
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "qube components --json did not return a JSON object." };
    }
    return parsed;
  } catch {
    return { error: "qube components --json returned invalid JSON." };
  }
}

async function collectApplyVerification(selections: InstallSelections, environment: CliEnvironment): Promise<{
  readonly components: unknown;
  readonly doctor: unknown;
  readonly mismatches: readonly string[];
  readonly findings: readonly string[];
}> {
  const mismatches = collectInstallMismatches(selections, environment);
  const componentsPromise = runApplyComponents(environment, selections.scope);
  const doctorResult = await executeQubeDoctor(true, false, environment);
  let doctorPayload: unknown;
  if (typeof doctorResult.jsonStdout === "string" && doctorResult.jsonStdout.trim() !== "") {
    try {
      doctorPayload = JSON.parse(doctorResult.jsonStdout);
    } catch {
      doctorPayload = { error: "Doctor returned invalid JSON." };
    }
  } else {
    const detail = doctorResult.stderr?.trim() ?? "";
    doctorPayload = { error: detail === "" ? "Doctor did not return a JSON envelope." : detail };
  }
  return {
    components: await componentsPromise,
    doctor: doctorPayload,
    mismatches,
    findings: doctorFindings(doctorPayload)
  };
}

function renderApplyReport(report: InstallApplyReport): string {
  const executed = report.executed.length === 0
    ? ["- No remaining install delta was applied."]
    : report.executed.map(step => `- ${step.stage}: ${step.status}${step.error ? ` — ${step.error}` : ` (${step.command})`}`);
  const mismatches = report.mismatches.length === 0 ? ["- none"] : report.mismatches.map(item => `- ${item}`);
  const findings = report.findings.length === 0 ? ["- none"] : report.findings.map(item => `- ${item}`);
  const registry = report.registry?.status === "plan-only" && report.registry.reason
    ? ["", "Registry gate:", `- ${report.registry.reason}`]
    : [];
  return [
    "Apply result:",
    ...executed,
    ...registry,
    "",
    "Component mismatches:",
    ...mismatches,
    "",
    "Doctor findings:",
    ...findings,
    ""
  ].join("\n");
}

async function executeQubeInstall(flags: Readonly<Record<string, unknown>>, environment: CliEnvironment): Promise<RuntimeCommandResult> {
  const json = flags.json === true;
  const validationError = validateInstallFlagChoices(flags);
  if (validationError) {
    throw createCliError({
      command: "install",
      kind: "invalid-command-usage",
      operation: "validate install flags",
      likelyCause: validationError.stderr.trim(),
      suggestedNextAction: "Use a supported install option value.",
      category: "usage"
    });
  }
  if (json && flags.yes !== true && !hasCompleteInstallSelections(flags, environment.cwd)) {
    const guide = buildInstallQuestions({ flags, cwd: environment.cwd });
    return {
      json: {
        awaitingAnswers: true,
        questions: guide.questions,
        unansweredQuestionIds: guide.unansweredQuestionIds,
      }
    };
  }
  const selections = flags.json === true
    ? createInstallSelectionsFromFlags(flags, environment.cwd)
    : await resolveInstallSelections(flags, environment.cwd);
  const plan = createInstallPlan(selections, flags["dry-run"] === true, environment.cwd);
  if (shouldStayPlanOnly(flags)) {
    if (json) {
      return { json: { installPlan: plan } };
    }
    return { stdout: renderInstallPlan(plan) };
  }

  const unsupported = unsupportedApplySelections(selections);
  if (unsupported.length > 0) {
    throw createCliError({
      command: "install",
      kind: "unsupported-install-selection",
      operation: "apply install plan",
      likelyCause: `Apply does not support ${unsupported.join(", ")}.`,
      suggestedNextAction: "Choose supported host, work-provider, and ci-provider values, or stay in plan mode.",
      category: "validation"
    });
  }

  if (flags.yes !== true) {
    const confirmed = await promptConfirm({
      command: installCommand,
      promptName: "apply install plan",
      jsonMode: json,
      yes: false,
      clack: {
        message: applyConfirmMessage(plan)
      }
    });
    if (confirmed !== true) {
      throw createCliError({
        command: "install",
        kind: "prompt-cancelled",
        operation: "apply install plan",
        likelyCause: "Install apply was not confirmed.",
        suggestedNextAction: "Rerun qube install --apply and confirm, or pass --yes for a non-interactive apply.",
        category: "usage"
      });
    }
  }

  const executed: InstallApplyStepResult[] = [];
  const packageStep = remainingApplySteps(selections, environment.cwd).find(step => step.stage === "package-install");
  const registry = packageStep
    ? await verifyInstallRegistryGate({
      selections,
      env: environment.env,
      offline: flags.offline === true
    })
    : undefined;
  if (packageStep && registry?.status === "plan-only") {
    executed.push({
      stage: "package-install",
      command: formatPackageInstallCommand(selections),
      status: "plan-only",
      error: registry.reason ?? "Registry verification downgraded the package install to plan-only."
    });
  } else if (packageStep) {
    const result = await runApplyPackageInstall(selections, environment);
    executed.push(result);
  }
  const workspaceStep = executed.some(step => step.status === "failed")
    ? undefined
    : remainingApplySteps(selections, environment.cwd).find(step => step.stage === "workspace-init");
  if (workspaceStep) {
    const result = await runApplyWorkspaceInit(selections, environment);
    executed.push(result);
  }
  const providerStep = executed.some(step => step.status === "failed")
    ? undefined
    : remainingApplySteps(selections, environment.cwd).find(step => step.stage === "provider-setup");
  if (providerStep) {
    executed.push(await runApplyProviderSetup(providerStep, environment));
  }

  const verification = await collectApplyVerification(selections, environment);
  const failedStep = executed.some(step => step.status === "failed");
  const registryBlocked = executed.some(step => step.status === "plan-only");
  const verificationFailed = verification.mismatches.length > 0
    || isVerificationError(verification.components, "components")
    || isVerificationError(verification.doctor, "doctor");
  const exitCode = failedStep || verificationFailed || registryBlocked ? 1 : 0;
  const appliedPlan: InstallPlan = {
    ...plan,
    mode: registryBlocked ? "copy-commands" : "apply",
    dryRun: false
  };
  const apply: InstallApplyReport = {
    confirmed: true,
    executed,
    registry,
    components: verification.components,
    doctor: verification.doctor,
    mismatches: verification.mismatches,
    findings: verification.findings
  };
  if (json) {
    return {
      exitCode,
      jsonStdout: `${JSON.stringify({
        ok: exitCode === 0,
        command: "install",
        installPlan: appliedPlan,
        apply
      })}\n`
    };
  }
  return {
    exitCode,
    stdout: `${renderInstallPlan(appliedPlan)}\n${renderApplyReport(apply)}`
  };
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
  if (parsed.flags.json === true && parsed.flags.yes !== true && !hasCompleteInstallSelections(parsed.flags, process.cwd())) {
    const guide = buildInstallQuestions({ flags: parsed.flags, cwd: process.cwd() });
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({
        ok: true,
        command: "install",
        awaitingAnswers: true,
        questions: guide.questions,
        unansweredQuestionIds: guide.unansweredQuestionIds,
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

/** The synchronous API validates init syntax, then fails closed because only the async runtime can resolve and plan every component. */
function planQubeInit(args: readonly string[], environment: CliEnvironment): CliExecution {
  const flags: Record<string, unknown> = {};
  const positional: string[] = [];
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
    if (token === "--force") {
      flags.force = true;
      continue;
    }
    if (token === "--defaults") {
      flags.defaults = true;
      continue;
    }
    if (token === "--mcp" || token === "--no-mcp") {
      flags.mcp = token === "--mcp";
      continue;
    }
    if (token === "--continuous-shipping" || token === "--no-continuous-shipping") {
      flags["continuous-shipping"] = token === "--continuous-shipping";
      continue;
    }
    if (token === "--credit-warning") {
      flags["credit-warning"] = true;
      continue;
    }
    if (token === "--no-credit-warning") {
      flags["credit-warning"] = false;
      continue;
    }
    const option = parseInitOptionToken(args, index);
    if (option?.kind === "missing-value") {
      return { exitCode: 2, stdout: "", stderr: `Missing value for init option --${option.key}.\n` };
    }
    if (option?.kind === "parsed") {
      flags[option.key] = option.value;
      index = option.nextIndex;
      continue;
    }
    if (!token.startsWith("-")) {
      positional.push(token);
      continue;
    }
    return { exitCode: 2, stdout: "", stderr: `Unknown init flag or argument: ${token}\n` };
  }

  const validationError = validateInstallFlagChoices(flags);
  if (validationError) {
    return validationError;
  }

  if (positional.length > 1) {
    return { exitCode: 2, stdout: "", stderr: "QUBE init accepts at most one target directory.\n" };
  }

  void environment;
  return {
    exitCode: 2,
    stdout: "",
    stderr: "The synchronous planning API cannot resolve QUBE init across all components. Use runQubeCli() or the qube executable.\n"
  };
}

function parseInitOptionToken(
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
  for (const key of ["host", "work-provider", "ci-provider", "review-mode", "review-harness", "ui-audit-evidence-root", "config-scope", "umpire-scope", "quality-stage", "external-reviewer", "review-publisher"]) {
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
    targetCommand,
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

async function resolveInstallSelections(flags: Readonly<Record<string, unknown>>, cwd: string): Promise<InstallSelections> {
  const scope = await resolveInstallChoice(scopeChoices, readOption<InstallScope>(flags, "scope"), flags);
  const packageManager = await resolveInstallChoice(
    { ...packageManagerChoices, defaultValue: recommendedInstallPackageManager(cwd) },
    readOption<InstallPackageManager>(flags, "package-manager"),
    flags
  );
  const hosts = await resolveInstallChoices(hostChoices, readOptionList<InstallHost>(flags, "host"), flags);
  const workProviders = await resolveInstallChoices(workProviderChoices, readOptionList<InstallWorkProvider>(flags, "work-provider"), flags);
  const ciProviders = await resolveInstallChoices(ciProviderChoices, readOptionList<InstallCiProvider>(flags, "ci-provider"), flags);
  const isolatedOk = isolatedReviewAvailable(hosts);
  const reviewMode = await resolveInstallChoice(
    defineInstallerChoiceGroup({
      name: "review mode",
      message: "Which review mode should this repository use?",
      defaultValue: recommendedInstallReviewMode(hosts),
      choices: [
        ...(isolatedOk
          ? [{
            value: "isolated" as const,
            label: "isolated",
            description: "Executor runs model CLIs for the lane batch.",
            recommended: true
          }]
          : []),
        {
          value: "host",
          label: "host",
          description: "The coding agent runs one review subagent per lane."
        },
        {
          value: "external",
          label: "external",
          description: "A review service reviews the pull request.",
          recommended: !isolatedOk
        }
      ]
    }),
    readOption<InstallReviewMode>(flags, "review-mode"),
    flags
  );
  const uiAuditEvidenceRoot = await resolveUiAuditEvidenceRoot(flags);
  const creditWarningValue = await resolveInstallChoice(
    attributionChoices,
    typeof flags["credit-warning"] === "boolean" ? String(flags["credit-warning"]) : undefined,
    flags
  );
  const lifecycleScripts = await resolveInstallChoice(lifecycleChoices, readOption<InstallLifecycleScripts>(flags, "lifecycle-scripts"), flags);
  const docsValue = await resolveInstallChoice(docsChoices, readDocsFlag(flags), flags);
  return {
    scope,
    packageManager,
    host: hosts[0] ?? "codex",
    hosts,
    workProvider: workProviders[0] ?? "github",
    workProviders,
    ciProvider: ciProviders[0] ?? "github",
    ciProviders,
    lifecycleScripts,
    docs: docsValue === "yes",
    reviewMode,
    uiAuditEvidenceRoot,
    creditWarning: creditWarningValue === "true"
  };
}

function mapEvidenceRootChoice(value: string): string {
  if (value === "qube") return DEFAULT_INSTALL_UI_AUDIT_EVIDENCE_ROOT;
  return value;
}

async function resolveUiAuditEvidenceRoot(flags: Readonly<Record<string, unknown>>): Promise<string> {
  const flagged = readOption<string>(flags, "ui-audit-evidence-root");
  if (flagged) return flagged;
  const token = await resolveInstallChoice(evidenceRootChoices, undefined, flags);
  return mapEvidenceRootChoice(token);
}

async function resolveInstallChoice<Value extends string>(
  group: InstallerChoiceGroup<Value>,
  value: Value | undefined,
  flags: Readonly<Record<string, unknown>>,
  command: Parameters<typeof promptInstallerChoice>[0]["command"] = installCommand
): Promise<Value> {
  const useDefaults = flags.yes === true || flags.defaults === true;
  return promptInstallerChoice({
    command,
    promptName: group.name,
    message: group.message,
    choices: group.choices,
    value,
    defaultValue: useDefaults ? group.defaultValue : undefined,
    jsonMode: flags.json === true,
    yes: useDefaults
  });
}

async function resolveInstallChoices<Value extends string>(
  group: InstallerChoiceGroup<Value>,
  values: readonly Value[] | undefined,
  flags: Readonly<Record<string, unknown>>,
  command: Parameters<typeof promptInstallerChoices>[0]["command"] = installCommand
): Promise<readonly Value[]> {
  const useDefaults = flags.yes === true || flags.defaults === true;
  const selected = await promptInstallerChoices({
    command,
    promptName: group.name,
    message: group.message,
    choices: group.choices,
    value: values,
    defaultValue: useDefaults && group.defaultValue !== undefined ? [group.defaultValue] : undefined,
    jsonMode: flags.json === true,
    yes: useDefaults
  });
  return Object.freeze([...new Set(selected)]);
}

function createInstallSelectionsFromFlags(flags: Readonly<Record<string, unknown>>, cwd = process.cwd()): InstallSelections {
  // Keep these synchronous fallbacks aligned with the choice group defaults above.
  const hosts = readOptionList<InstallHost>(flags, "host") ?? ["codex"];
  const workProviders = readOptionList<InstallWorkProvider>(flags, "work-provider") ?? ["github"];
  const ciProviders = readOptionList<InstallCiProvider>(flags, "ci-provider") ?? ["github"];
  return {
    scope: readOption<InstallScope>(flags, "scope") ?? "local",
    packageManager: readOption<InstallPackageManager>(flags, "package-manager") ?? recommendedInstallPackageManager(cwd),
    host: hosts[0] ?? "codex",
    hosts,
    workProvider: workProviders[0] ?? "github",
    workProviders,
    ciProvider: ciProviders[0] ?? "github",
    ciProviders,
    lifecycleScripts: readOption<InstallLifecycleScripts>(flags, "lifecycle-scripts") ?? "disabled",
    docs: readDocsFlag(flags) !== "no",
    reviewMode: readOption<InstallReviewMode>(flags, "review-mode") ?? recommendedInstallReviewMode(hosts),
    uiAuditEvidenceRoot: readOption<string>(flags, "ui-audit-evidence-root") ?? DEFAULT_INSTALL_UI_AUDIT_EVIDENCE_ROOT,
    creditWarning: typeof flags["credit-warning"] === "boolean" ? flags["credit-warning"] : true
  };
}

function createInstallPlan(selections: InstallSelections, dryRun: boolean, cwd = process.cwd()): InstallPlan {
  const steps = createInstallCommands(selections, cwd);
  return {
    package: {
      name: packageName,
      version: packageVersion
    },
    selections,
    options: createInstallOptionGroups(),
    mode: "copy-commands",
    dryRun,
    steps,
    commands: steps.filter(step => step.status === "missing" || step.status === "stale"),
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
    ...selections.workProviders.map(id => executorWorkProviders.find(option => option.id === id)?.connection),
    ...selections.ciProviders.map(id => executorCiProviders.find(option => option.id === id)?.connection),
  ].filter((connection): connection is ConnectionContract => connection !== null && connection !== undefined);
  return Object.freeze([...new Map(selected.map(connection => [connection.adapterId, connection])).values()]);
}

const AIE_INIT_HOST_TOOLS = AGENT_HOST_IDS;
type AieInitHostTool = AgentHostId;
type AieInitTool = AieInitHostTool | "all" | `${AieInitHostTool},${string}`;

function mapSelectedInitTools(hosts: readonly InstallHost[]): Set<AieInitHostTool> {
  const mapped = new Set<AieInitHostTool>();
  for (const host of hosts) {
    mapped.add(host);
  }
  return mapped;
}

/** Executor accepts one --tool value that may list several hosts so shared AGENTS.md is written once. */
function resolveAieInitToolTargets(hosts: readonly InstallHost[]): readonly AieInitTool[] {
  const mapped = mapSelectedInitTools(hosts);
  if (mapped.size === 0) return [];
  return Object.freeze([AIE_INIT_HOST_TOOLS.filter(tool => mapped.has(tool)).join(",") as AieInitTool]);
}

/** Umpire receives the complete supported selection so it can apply one idempotent config plan. */
function resolveAiuInitToolTargets(hosts: readonly InstallHost[]): readonly AieInitTool[] {
  const mapped = mapSelectedInitTools(hosts);
  if (mapped.size === 0) return [];
  const tools = AIE_INIT_HOST_TOOLS.filter(tool =>
    mapped.has(tool) && getAgentHostProfileSync(tool).umpire.continuation.support !== "unsupported"
  );
  if (tools.length === 0) return [];
  return Object.freeze([tools.join(",") as AieInitTool]);
}

function buildQubeInitCommand(selections: InstallSelections): string {
  const parts = [
    "qube init .",
    `--host ${selections.hosts.join(",")}`,
    `--work-provider ${selections.workProviders.join(",")}`,
    `--ci-provider ${selections.ciProviders.join(",")}`,
    `--review-mode ${selections.reviewMode}`,
    `--ui-audit-evidence-root ${selections.uiAuditEvidenceRoot}`,
    selections.creditWarning ? "--credit-warning" : "--no-credit-warning"
  ];
  return parts.join(" ");
}

function createPackageInstallCommand(selections: InstallSelections, status: InstallStepStatus, reason: string): InstallCommandStep {
  const label = selections.scope === "global" ? "Install QUBE globally for manual shell use." : "Install QUBE in the current project.";
  return { stage: "package-install", label, command: formatPackageInstallCommand(selections), status, reason };
}

function createProviderSetupCommands(selections: InstallSelections, status: InstallStepStatus, reason: string): readonly InstallCommandStep[] {
  const commands: InstallCommandStep[] = [];
  if (selections.workProviders.includes("github") || selections.ciProviders.includes("github")) {
    commands.push({ stage: "provider-setup", label: "Configure GitHub status labels.", command: "qube aie labels setup", status, reason });
  }
  return Object.freeze(commands);
}

function createInstallCommands(selections: InstallSelections, cwd: string): readonly InstallCommandStep[] {
  const probed = probeInstallState(cwd, selections);
  const byStage = new Map(probed.map(step => [step.stage, step]));
  const packageState = byStage.get("package-install") ?? { status: "missing" as const, reason: "Package install state could not be probed." };
  const workspaceState = byStage.get("workspace-init") ?? { status: "missing" as const, reason: "Workspace init state could not be probed." };
  const providerState = byStage.get("provider-setup") ?? { status: "missing" as const, reason: "Provider setup state could not be probed." };
  const verifyState = byStage.get("verify") ?? { status: "missing" as const, reason: "Verify state could not be probed." };
  return [
    createPackageInstallCommand(selections, packageState.status, packageState.reason),
    {
      stage: "workspace-init",
      label: "Initialize QUBE workspace setup for the selected hosts and providers.",
      command: buildQubeInitCommand(selections),
      status: workspaceState.status,
      reason: workspaceState.reason
    },
    ...createProviderSetupCommands(selections, providerState.status, providerState.reason),
    {
      stage: "verify",
      label: "Verify the workspace with the aggregating doctor.",
      command: "qube doctor",
      status: verifyState.status,
      reason: verifyState.reason
    }
  ];
}

function createInstallFiles(selections: InstallSelections): readonly string[] {
  if (!selections.docs) {
    return [];
  }
  const files = ["README.md install snippet"];
  for (const host of selections.hosts) {
    const profile = getAgentHostProfileSync(host as AgentHostId);
    files.push(`${profile.instructionTarget.path} agent instructions`);
    files.push(`${profile.makeItSo.path} Make It So ${profile.makeItSo.kind}`);
    if (selections.reviewMode === "host") {
      for (const agent of profile.review.local.agents) {
        files.push(`${agent.path} native review agent`);
      }
    }
    for (const action of profile.trust.actions) {
      if (action.kind !== "review-files") continue;
      for (const actionPath of action.paths) files.push(`${actionPath} trust review`);
    }
  }
  if (selections.workProviders.some(id => id === "github" || id === "gitlab" || id === "linear" || id === "jira")) {
    files.push(".qube/aie/config.json provider notes");
  }
  if (selections.ciProviders.includes("jenkins")) {
    files.push(".qube/aie/gates/jenkins gate evidence notes");
  }
  return Object.freeze([...new Set(files)]);
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
  notes.push("Run `qube components` any time to confirm the installed component deck.");
  notes.push(installOptionNote("Work provider", executorWorkProviders, selections.workProvider));
  notes.push(installOptionNote("CI provider", executorCiProviders, selections.ciProvider));
  if (selections.workProviders.length > 1) {
    notes.push(`Additional installed work providers (not yet active): ${selections.workProviders.slice(1).join(", ")}. The first selected work provider stays active; Executor init still always writes GitHub as the provider kind, so switching the active kind for another provider requires a manual .qube/aie/config.json edit.`);
  }
  if (selections.ciProviders.length > 1) {
    notes.push(`Additional installed CI providers (not yet active): ${selections.ciProviders.slice(1).join(", ")}. The first selected CI provider stays active.`);
  }
  if (selections.hosts.length > 1) {
    notes.push(`qube init fans out across all selected hosts (${selections.hosts.join(", ")}) inside one command.`);
  }
  notes.push("qube init initializes Bootstrap, Executor, Quality, and Umpire together.");
  for (const host of selections.hosts) {
    const profile = getAgentHostProfileSync(host as AgentHostId);
    notes.push(`${profile.displayName}: reads ${profile.instructionTarget.path}; start with ${profile.makeItSo.invocation}.`);
    notes.push(`${profile.displayName} capabilities: task list ${profile.taskList.support}; subagents ${profile.subagents.support}; native review ${profile.review.local.support}; isolated review ${profile.review.isolated.support}; Umpire continuation ${profile.umpire.continuation.support}; live models ${profile.modelDiscovery.support}.`);
    if (profile.trust.required) {
      notes.push(`${profile.displayName} requires trust after you review the installed files: ${profile.trust.actions.map(action => action.description).join(" ")}`);
    }
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
    `Agent harnesses: ${plan.selections.hosts.join(", ")}`,
    `Work provider: ${plan.selections.workProviders.join(", ")}`,
    `CI provider: ${plan.selections.ciProviders.join(", ")}`,
    `Lifecycle scripts: ${plan.selections.lifecycleScripts}`,
    `Docs/config notes: ${plan.selections.docs ? "included" : "omitted"}`,
    "",
    "Commands to run:",
    ...(plan.commands.length > 0
      ? plan.commands.flatMap((step, index) => [`${index + 1}. [${step.status}] ${step.label}`, `   ${step.command}`, `   ${step.reason}`])
      : ["None. Every probed setup step is already satisfied."]),
    "",
    "Step status:",
    ...plan.steps.map(step => `- ${step.stage}: ${step.status} — ${step.reason}`),
    "",
    "Current options:",
    renderOptionSummary("Agent harnesses", plan.options.hosts),
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
    plan.mode === "apply" ? "Install apply finished." : "No commands were run.",
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
    `  Config path: ${connection.configPath}`,
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

function validateInstallFlagChoices(flags: Readonly<Record<string, unknown>>): CliExecution | undefined {
  const singleGroups = [
    { key: "scope", choices: scopeChoices.choices },
    { key: "package-manager", choices: packageManagerChoices.choices },
    { key: "lifecycle-scripts", choices: lifecycleChoices.choices }
  ];
  for (const group of singleGroups) {
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

  const multiGroups = [
    { key: "host", choices: hostChoices.choices },
    { key: "work-provider", choices: workProviderChoices.choices },
    { key: "ci-provider", choices: ciProviderChoices.choices }
  ];
  for (const group of multiGroups) {
    const value = flags[group.key];
    if (typeof value !== "string") {
      continue;
    }
    const tokens = splitCsvOption(value);
    if (tokens.length === 0) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: `Invalid install option --${group.key}=. Use one or more of: ${group.choices.map(choice => choice.value).join(", ")}.\n`
      };
    }
    const invalid = tokens.filter(token => !group.choices.some(choice => choice.value === token));
    if (invalid.length === 0) {
      continue;
    }
    return {
      exitCode: 2,
      stdout: "",
      stderr: `Invalid install option --${group.key}=${invalid.join(",")}. Use one or more of: ${group.choices.map(choice => choice.value).join(", ")}.\n`
    };
  }
  const guideError = invalidInstallGuideFlag(flags);
  if (guideError) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `${guideError}\n`
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

function hasCompleteInstallSelections(flags: Readonly<Record<string, unknown>>, cwd: string): boolean {
  return installQuestionGuideComplete(flags, cwd);
}

function splitCsvOption(value: string): readonly string[] {
  return Object.freeze(value.split(",").map(token => token.trim()).filter(token => token.length > 0));
}

function readOptionList<Value extends string>(flags: Readonly<Record<string, unknown>>, key: string): readonly Value[] | undefined {
  const value = flags[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const tokens = splitCsvOption(value) as readonly Value[];
  return tokens.length > 0 ? tokens : undefined;
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
    if (token === "--apply") {
      flags.apply = true;
      continue;
    }
    if (token === "--offline") {
      flags.offline = true;
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
    if (token === "--credit-warning") {
      flags["credit-warning"] = true;
      continue;
    }
    if (token === "--no-credit-warning") {
      flags["credit-warning"] = false;
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
  for (const key of ["scope", "package-manager", "host", "work-provider", "ci-provider", "lifecycle-scripts", "review-mode", "ui-audit-evidence-root"]) {
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
    case "review-mode":
      return ["isolated", "host", "external"];
    case "ui-audit-evidence-root":
      return [DEFAULT_INSTALL_UI_AUDIT_EVIDENCE_ROOT];
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

function dispatchCommand(request: DispatchRequest): Promise<number> {
  return new Promise(resolve => {
    let command: string;
    let args: string[];
    try {
      [command, args] = spawnInput(request);
    } catch (err: unknown) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      resolve(2);
      return;
    }
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

const CAPTURED_DISPATCH_MAX_CHARS = 16 * 1024 * 1024;

type CapturedProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
};

function captureChildOutput(child: ReturnType<typeof spawn>): Promise<CapturedProcessResult> {
  return new Promise(resolve => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    const finish = (result: CapturedProcessResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    if (!child.stdout || !child.stderr) {
      finish({ exitCode: 1, stdout: "", stderr: "Captured process has no stdout or stderr pipe.\n", truncated: false });
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    // Bounded capture: a runaway or compromised component cannot exhaust composer memory,
    // and truncation is recorded so a valid-JSON prefix is never treated as a complete envelope.
    const append = (existing: string, chunk: string): string => {
      const remaining = CAPTURED_DISPATCH_MAX_CHARS - existing.length;
      if (chunk.length <= remaining) return existing + chunk;
      truncated = true;
      return existing + chunk.slice(0, Math.max(0, remaining));
    };
    child.stdout.on("data", chunk => { stdout = append(stdout, chunk); });
    child.stderr.on("data", chunk => { stderr = append(stderr, chunk); });
    // Wait for close, not exit: exit can fire before the last stdout chunk is delivered.
    child.on("close", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      finish({ exitCode: code ?? 1, stdout, stderr, truncated });
    });
    child.on("error", error => finish({
      exitCode: 1,
      stdout,
      stderr: `${stderr}${error instanceof Error ? error.message : String(error)}\n`,
      truncated
    }));
  });
}

function spawnCapturedPath(
  commandPath: string,
  args: readonly string[],
  environment: CliEnvironment
): Promise<CapturedProcessResult> {
  let command: string;
  let spawnArgs: string[];
  try {
    [command, spawnArgs] = spawnInput({ commandPath, args });
  } catch (err: unknown) {
    return Promise.resolve({
      exitCode: 2,
      stdout: "",
      stderr: `${err instanceof Error ? err.message : String(err)}\n`,
      truncated: false
    });
  }
  return captureChildOutput(spawn(command, spawnArgs, {
    cwd: environment.cwd,
    env: environment.env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: true
  }));
}

function dispatchCommandCaptured(request: DispatchRequest): Promise<CapturedProcessResult> {
  let command: string;
  let args: string[];
  try {
    [command, args] = spawnInput(request);
  } catch (err: unknown) {
    return Promise.resolve({
      exitCode: 2,
      stdout: "",
      stderr: `${err instanceof Error ? err.message : String(err)}\n`,
      truncated: false
    });
  }
  return captureChildOutput(spawn(command, args, {
    cwd: request.cwd,
    stdio: ["inherit", "pipe", "pipe"],
    shell: false
  }));
}

const CMD_UNSAFE_ARGUMENT = /[&|<>^%!"\r\n]/;

function spawnInput(request: Pick<DispatchRequest, "commandPath" | "args">): [string, string[]] {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(request.commandPath)) {
    // cmd.exe parses metacharacters inside forwarded arguments regardless of
    // Node's quoting, so arguments that could splice commands are refused
    // instead of being forwarded through the .cmd shim.
    const unsafe = request.args.find(argument => CMD_UNSAFE_ARGUMENT.test(argument));
    if (unsafe !== undefined) {
      throw new Error(`Refusing to forward an argument containing cmd metacharacters through ${request.commandPath}: ${JSON.stringify(unsafe)}.`);
    }
    return [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", request.commandPath, ...request.args]];
  }
  return [request.commandPath, [...request.args]];
}
