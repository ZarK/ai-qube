import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, realpathSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { promptInstallerChoice, promptInstallerChoices, type InstallerChoice } from "@tjalve/qube-cli/installer";
import { defineArgument, defineCommand, defineExtensions, defineFlag } from "@tjalve/qube-cli/metadata";
import { defineMutationMetadata, mutationCategories } from "@tjalve/qube-cli/mutation";
import { evaluatePromptGate, promptConfirm } from "@tjalve/qube-cli/prompts";
import { createCommandRegistry } from "@tjalve/qube-cli/registry";
import { createCli, createCommand as createRuntimeCommand, createSchemaCommand, runCli, type RuntimeCommandResult } from "@tjalve/qube-cli/runtime";
import { synthesizeAutoresearchArena } from "@tjalve/aib";
import {
  detectInstalledReviewHostsOnPath,
  getAgentHostProfileSync,
  listHostModels,
  listInitExternalReviewers,
} from "@tjalve/aie";
import { aiqStageMetadata } from "@tjalve/aiq/config";
import { AIU_POST_ISSUE_SCOPES } from "@tjalve/aiu";
import type { AgentHostId, AutoresearchArena, AutoresearchEvaluator } from "@tjalve/qube-core";
import {
  AGENT_HOST_IDS,
  QUBE_INIT_LAYER_CONTEXT_ENV,
  qubeCommandSurfaceContracts,
  resolveExecutable,
  serializeInitLayerContext,
} from "@tjalve/qube-core";

import { formatConnectionDoctor, runConnectionDoctor } from "./connection_doctor.js";
import { formatModelRoutingDoctor, formatPermutationDoctor, runModelRoutingDoctor, runPermutationDoctor } from "./permutation_doctor.js";
import { executorCiProviders, executorHostSurfaces, executorWorkProviders, findQubeComponent, qubeComponents, type QubeComponent } from "./components.js";
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
  QUBE_INIT_FIELDS,
  QUBE_REVIEW_MODES,
  QUBE_REVIEW_PUBLISHERS,
  configForQubeScope,
  describeQubeInitFields,
  mergeQubeInitConfigs,
  omitQubeInitFields,
  readQubeInitConfig,
  repoQubeConfigPath,
  resolveQubeInitConfig,
  userQubeConfigPath,
  writeQubeInitConfig,
  type QubeExternalReviewer,
  type QubeInitConfig,
  type QubeInitField,
  type QubeReviewMode,
  type QubeReviewPublisher,
  type QubeUmpireScope,
} from "./init_config.js";
import {
  publicInitActionLabel,
  renderInitFailure,
  renderInitOutput,
  type InitPublisherReadiness,
  type PublicInitAnswer,
} from "./init_output.js";
import {
  GUIDED_INIT_UNPINNED_MODEL,
  buildGuidedInitQuestions,
  normalizeGuidedInitAnswers,
  type GuidedHarnessChoice,
  type GuidedInitAnswers,
  type GuidedInitCapabilities,
  type GuidedInitChoice,
  type GuidedInitNormalization,
  type GuidedInitQuestion,
  type GuidedInitQuestionId,
  type GuidedIssueTrackerChoice,
  type GuidedReviewModelCapability,
  type GuidedReviewSource,
} from "./init_questions.js";
import { formatPackageInstallCommand, selectedAdapterInstallSpecs } from "./install_packages.js";
import { buildShellCommandPlan, quoteShellArgument } from "./process_launch.js";
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
  readonly env?: NodeJS.ProcessEnv;
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
  description: "Use the recommended answers without prompting.",
  type: "boolean"
});
const offlineFlag = defineFlag({
  name: "offline",
  description: "Skip provider network and CLI probes and report configured connections as unverified.",
  type: "boolean"
});

type InstallPackageManager = "pnpm" | "npm";
type InstallHost = "codex" | "opencode" | "claude-code" | "grok-build" | "cursor";
type InstallCiProvider = "github" | "gitlab" | "jenkins";

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

const installCommand = defineCommand({
  kind: "command",
  name: "install",
  hidden: true,
  description: "Explain the package-manager installation migration and direct QUBE setup to qube init.",
  flags: [jsonFlag],
  examples: [{
    description: "Show the non-mutating package-manager migration response.",
    command: "qube install --json"
  }],
  output: {
    formats: ["human", "json"],
    defaultFormat: "human"
  },
  interactions: {
    json: true,
    dryRun: { supported: true },
    noColor: true,
    nonInteractive: true,
    ttyPrompt: false
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
  description: "Use the same recommended answers as the guided flow without prompting.",
  type: "boolean"
});

const initCommand = defineCommand({
  kind: "command",
  name: "init",
  description: "Initialize user-global QUBE choices or prepare one repository through the complete guided setup flow.",
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
      name: "global",
      description: "Initialize user-global QUBE settings without resolving or inspecting a repository.",
      type: "boolean"
    }),
    defineFlag({
      name: "git-init",
      description: "Permit repository initialization to create Git metadata in a target that is not yet a repository.",
      type: "boolean"
    }),
    defineFlag({
      name: "inherit",
      description: `Remove comma-separated repository overrides so they inherit again. Use one or more of: ${QUBE_INIT_FIELDS.join(", ")}.`,
      type: "string"
    }),
    defineFlag({
      name: "inherit-all",
      description: "Remove every repository override and recompute the effective setup from user-global settings, detection, and defaults.",
      type: "boolean"
    }),
    defineFlag({
      name: "host",
      description: `Comma-separated Agent harnesses. The first harness is primary. Use one or more of: ${executorHostSurfaces.map(option => option.id).join(", ")}.`,
      type: "string"
    }),
    defineFlag({
      name: "work-provider",
      description: `Issue tracker. Use one of: ${executorWorkProviders.map(option => option.id).join(", ")}.`,
      type: "string"
    }),
    defineFlag({
      name: "ci-provider",
      description: `Provider for Automated checks (CI). Use one of: ${executorCiProviders.map(option => option.id).join(", ")}.`,
      type: "string"
    }),
    defineFlag({
      name: "mcp",
      description: "Allow selected Agent harnesses to use configured MCP connections for read-only exploration. Default: off.",
      type: "boolean",
      negatable: true
    }),
    defineFlag({
      name: "config-scope",
      description: "Compatibility alias for --global or repository initialization. Use --global for new commands.",
      type: "option",
      options: ["repo", "global"]
    }),
    defineFlag({
      name: "continuous-shipping",
      description: "Let QUBE complete the development cycle and continue with the next Ready issue.",
      type: "boolean",
      negatable: true
    }),
    defineFlag({
      name: "umpire-scope",
      description: "Choose what Umpire may do after the current issue: Ready issues only, standard post-queue work, or a configured custom set.",
      type: "option",
      options: [...AIU_POST_ISSUE_SCOPES]
    }),
    defineFlag({
      name: "quality-stage",
      description: "Comma-separated Quality checks. One choice includes all earlier checks; multiple choices run exactly those checks.",
      type: "string"
    }),
    defineFlag({
      name: "review-mode",
      description: "Choose the account or service used for Review: an external service, the primary Agent harness, or another selected, installed Agent harness.",
      type: "option",
      options: [...QUBE_REVIEW_MODES]
    }),
    defineFlag({
      name: "review-harness",
      description: "Another selected, installed Agent harness that runs Review. It must differ from the primary harness and support this review source.",
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
      description: "Directory for manual UI audit evidence.",
      type: "string"
    }),
    defineFlag({
      name: "credit-warning",
      description: "Require attribution warnings in generated Agent harness instructions.",
      type: "boolean",
      negatable: true
    })
  ],
  examples: [
    { description: "Initialize user-global QUBE choices from any directory.", command: "qube init --global" },
    { description: "Initialize the current repository.", command: "qube init" },
    { description: "Initialize an explicit repository target.", command: "qube init <target>" },
    { description: "Initialize Git and QUBE in a prospective repository target.", command: "qube init <target> --git-init" }
  ],
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
    categories: mutationCategories("local-files", "local-config", "external-service")
  })
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
  createDirectCommand("review setup github-app", "Configure the QUBE Reviewer GitHub App with safe secret references.", "aie", "review setup github-app", { passthroughJson: true, qubePrimaryHelp: true, ttyPrompt: true }),
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
  const composerCommands = [componentsCommand, initCommand, doctorCommand, autoresearchCommand, oneshotCommand, makeItSoCommand, runCommand];
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
        return executeQubeInstall(flags);
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

interface QubeDoctorConfigurationSection {
  readonly status: "valid" | "invalid";
  readonly scope: "repository";
  readonly userGlobalPath: string;
  readonly repositoryPath: string;
  readonly fields?: ReturnType<typeof describeQubeInitFields>;
  readonly sources?: Readonly<Record<QubeInitField, string>>;
  readonly error?: string;
  readonly nextAction?: string;
}

function collectComposerConfiguration(environment: CliEnvironment): QubeDoctorConfigurationSection {
  const gitState = inspectInitGitState(environment.cwd, ".");
  const repositoryRoot = gitState.repositoryRoot ?? environment.cwd;
  const userGlobalPath = userQubeConfigPath(homeDirectory(environment));
  const repositoryPath = repoQubeConfigPath(repositoryRoot);
  const userGlobal = readQubeInitConfig(userGlobalPath);
  const repository = readQubeInitConfig(repositoryPath);
  const error = initConfigError("user-global", userGlobal) ?? initConfigError("repository", repository);
  if (error) {
    return Object.freeze({
      status: "invalid",
      scope: "repository",
      userGlobalPath,
      repositoryPath,
      error,
      nextAction: "Correct the invalid source configuration, then rerun `qube doctor`.",
    });
  }
  const merged = mergeQubeInitConfigs(userGlobal.config, repository.config);
  const hosts = merged.hosts && merged.hosts.length > 0 ? merged.hosts : Object.freeze(["codex"]);
  const review = defaultReviewSelection(hosts);
  const defaults = Object.freeze({
    version: 1 as const,
    hosts,
    workProviders: Object.freeze(["github"]),
    ciProviders: Object.freeze(["github"]),
    continuousShipping: true,
    umpire: Object.freeze({ scope: "ready" as const }),
    quality: Object.freeze({ stages: Object.freeze(["unit"]) }),
    review: Object.freeze({ mode: review.mode, ...(review.harness ? { harness: review.harness } : {}), publisher: "user" as const }),
    mcp: Object.freeze({ optIn: false }),
  });
  const resolved = resolveQubeInitConfig({ globalConfig: userGlobal.config, repoConfig: repository.config, defaults });
  return Object.freeze({
    status: "valid",
    scope: "repository",
    userGlobalPath,
    repositoryPath,
    sources: resolved.sources,
    fields: describeQubeInitFields({
      userGlobal: userGlobal.config,
      repository: repository.config,
      resolved,
      projectedRepository: repository.config ?? Object.freeze({ version: 1 as const }),
    }),
  });
}

function formatComposerConfiguration(configuration: QubeDoctorConfigurationSection): string {
  if (configuration.status === "invalid") {
    return `Effective configuration: invalid — ${configuration.error}\nNext action: ${configuration.nextAction}\n`;
  }
  const lines = ["Effective configuration:"];
  for (const field of configuration.fields ?? []) {
    const derived = field.effective.derivedFrom?.length ? ` from ${field.effective.derivedFrom.join(", ")}` : "";
    lines.push(`- ${field.id}: ${formatDoctorValue(field.effective.value)} (${field.effective.source}${derived})`);
  }
  return `${lines.join("\n")}\n`;
}

function formatDoctorValue(value: unknown): string {
  if (Array.isArray(value)) return value.length === 0 ? "none" : value.join(", ");
  return String(value);
}

async function executeQubeDoctor(json: boolean, offline: boolean, environment: CliEnvironment): Promise<RuntimeCommandResult> {
  const configuration = collectComposerConfiguration(environment);
  const configurationExitCode = configuration.status === "invalid" ? 1 : 0;
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
      ? Math.max(configurationExitCode, connectionExitCode, continuationExitCode(continuation), toolkitExitCode(hosts))
      : planned.exitCode || 1;
    if (json) {
      const payload = {
        ok: false,
        command: "doctor",
        configuration,
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
    return { exitCode, stdout: `${planned.stdout}${formatComposerConfiguration(configuration)}${formatWorkflowReadiness(workflow)}${formatContinuationHealth(continuation)}${formatHostToolkits(hosts)}${formatPermutationDoctor(permutation)}${formatModelRoutingDoctor(modelRouting)}${formatConnectionDoctor(connections)}`, stderr: planned.stderr };
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
    ? Math.max(configurationExitCode, connectionExitCode, continuationExitCode(continuation), toolkitExitCode(hosts))
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
      configuration,
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
    stdout: `${quality.stdout.trimEnd()}\n\n${formatComposerConfiguration(configuration)}${formatWorkflowReadiness(workflow)}${formatContinuationHealth(continuation)}${formatHostToolkits(hosts)}${formatPermutationDoctor(permutation)}${formatModelRoutingDoctor(modelRouting)}${formatConnectionDoctor(connections)}`,
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
async function dispatchInitChild(componentName: string, args: readonly string[], environment: CliEnvironment, cwd = environment.cwd, env = environment.env): Promise<QubeInitChildResult> {
  const planned = planQubeDispatch(componentName, args, environment);
  if (!planned.dispatch) {
    return { component: componentName, args, ok: false, exitCode: planned.exitCode || 1, error: planned.stderr.trim() || `${componentName} is unavailable.` };
  }
  const captured = await dispatchCommandCaptured({ ...planned.dispatch, cwd, env });
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

function buildAieInitArgs(target: string, tool: AieInitTool | undefined, options: { readonly dryRun: boolean; readonly prospectiveRoot?: boolean; readonly force: boolean; readonly yes: boolean; readonly defaults: boolean; readonly workProvider?: string; readonly reviewProvider?: string; readonly ciProvider?: string; readonly primaryHost?: string; readonly reviewMode?: string; readonly reviewAgents?: readonly string[]; readonly localReviewAgents?: readonly string[]; readonly isolatedReviewAgent?: string; readonly reviewModels?: readonly string[]; readonly publisher?: QubeReviewPublisher; readonly configScope?: 'repo' | 'global'; readonly continuousShipping?: boolean; readonly uiAuditEvidenceRoot?: string; readonly creditWarning?: boolean }): readonly string[] {
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
  if (options.configScope) args.push("--config-scope", options.configScope);
  if (options.continuousShipping === true) args.push("--autonomous");
  if (options.continuousShipping === false) args.push("--no-autonomous");
  if (options.uiAuditEvidenceRoot) args.push("--ui-audit-evidence-root", options.uiAuditEvidenceRoot);
  if (options.creditWarning === true) args.push("--credit-warning");
  if (options.creditWarning === false) args.push("--no-credit-warning");
  if (options.dryRun) args.push("--dry-run");
  if (options.prospectiveRoot) args.push("--prospective-root");
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
  readonly env?: NodeJS.ProcessEnv;
}

function homeDirectory(environment: CliEnvironment): string {
  return environment.env.USERPROFILE ?? environment.env.HOME ?? homedir();
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
    ? `The ${source} QUBE config is invalid at ${result.path}: ${result.error ?? "unknown validation error"}`
    : undefined;
}

const GUIDED_INIT_QUESTION_ORDER: readonly GuidedInitQuestionId[] = Object.freeze([
  "agent-harnesses",
  "issue-tracker",
  "automated-checks",
  "continuous-shipping",
  "umpire-scope",
  "quality-checks",
  "review-source",
  "external-reviewer",
  "review-harness",
  "review-model",
  "review-publisher",
]);

const GUIDED_REVIEW_TRACKERS = Object.freeze(["github", "linear", "jira"]);

const GUIDED_QUALITY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  e2e: "End-to-end tests",
  lint: "Lint checks",
  format: "Formatting checks",
  typecheck: "Type checks",
  unit: "Unit tests",
  sloc: "Source file size",
  complexity: "Complexity checks",
  maintainability: "Maintainability checks",
  coverage: "Coverage checks",
  security: "Security checks",
});

function guidedQualityWarning(stage: (typeof aiqStageMetadata)[number]): string | undefined {
  return "warning" in stage ? stage.warning?.message : undefined;
}

function guidedReviewSource(mode: QubeReviewMode | undefined): GuidedReviewSource | undefined {
  if (mode === "host") return "primary";
  if (mode === "isolated") return "harness";
  return mode;
}

function guidedReviewMode(source: GuidedReviewSource): QubeReviewMode {
  if (source === "primary") return "host";
  if (source === "harness") return "isolated";
  return "external";
}

function singleGuidedFlag(values: readonly string[] | undefined): string | undefined {
  if (!values || values.length === 0) return undefined;
  return values.length === 1 ? values[0] : values.join(",");
}

function guidedAnswersFromFlags(
  flags: Readonly<Record<string, unknown>>,
  registeredReviewers: readonly { readonly id: string; readonly aliases: readonly string[] }[] = Object.freeze([]),
): GuidedInitAnswers {
  const hosts = readOptionList<string>(flags, "host");
  const workProviders = readOptionList<string>(flags, "work-provider");
  const ciProviders = readOptionList<string>(flags, "ci-provider");
  const reviewMode = readOption<QubeReviewMode>(flags, "review-mode");
  const reviewHarness = readOption<string>(flags, "review-harness");
  const externalReviewers = readOptionList<string>(flags, "external-reviewer");
  const canonicalExternalReviewers = externalReviewers
    ? Object.freeze([...new Set(externalReviewers.map(raw => {
        const normalized = raw.trim().replace(/^@/, "").toLowerCase();
        const registered = registeredReviewers.find(reviewer => (
          reviewer.id === normalized || reviewer.aliases.some(alias => alias.toLowerCase() === normalized)
        ));
        return registered?.id ?? raw;
      }))])
    : undefined;
  const publisher = readOption<QubeReviewPublisher>(flags, "review-publisher");
  return Object.freeze({
    ...(hosts ? { agentHarnesses: hosts } : {}),
    ...(workProviders ? { issueTracker: singleGuidedFlag(workProviders) } : {}),
    ...(ciProviders ? { automatedChecks: singleGuidedFlag(ciProviders) } : {}),
    ...(typeof flags["continuous-shipping"] === "boolean"
      ? { continuousShipping: flags["continuous-shipping"] as boolean }
      : {}),
    ...(typeof flags["umpire-scope"] === "string"
      ? { umpireScope: flags["umpire-scope"] as QubeUmpireScope }
      : {}),
    ...(readOptionList<string>(flags, "quality-stage")
      ? { qualityStages: readOptionList<string>(flags, "quality-stage")! }
      : {}),
    ...(reviewMode ? { reviewSource: guidedReviewSource(reviewMode) } : {}),
    ...(canonicalExternalReviewers ? { externalReviewers: canonicalExternalReviewers } : {}),
    ...(reviewHarness ? { reviewHarness } : {}),
    ...(publisher ? { reviewPublisher: publisher } : {}),
  });
}

function explicitGuidedReviewError(flags: Readonly<Record<string, unknown>>, inherited: QubeInitConfig): string | undefined {
  const mode = readOption<QubeReviewMode>(flags, "review-mode");
  const hosts = readOptionList<string>(flags, "host") ?? inherited.hosts;
  const primary = hosts?.[0];
  const harness = readOption<string>(flags, "review-harness");
  const reviewers = readOptionList<string>(flags, "external-reviewer");
  const publisher = readOption<QubeReviewPublisher>(flags, "review-publisher");
  const workProvider = singleGuidedFlag(readOptionList<string>(flags, "work-provider"))
    ?? inherited.workProviders?.[0]
    ?? "github";
  const reviewProvider = workProvider === "gitlab" ? "gitlab" : "github";
  if (publisher && reviewProvider !== "github") {
    return "Review publisher selection applies only when GitHub publishes reviews.";
  }
  if (!mode) return undefined;
  if (mode === "external") {
    if (reviewProvider !== "github") return `External reviewer services are not registered for the ${reviewProvider} review provider.`;
    if (harness) return "External review does not use an agent harness.";
    return undefined;
  }
  if (reviewers && reviewers.length > 0) return "External reviewer services require external review mode.";
  if (!primary) return undefined;
  if (!(AGENT_HOST_IDS as readonly string[]).includes(primary)) return undefined;
  if (mode === "host") {
    if (harness && harness !== primary) return `Primary-harness review must use ${primary}.`;
    if (getAgentHostProfileSync(primary as AgentHostId).review.local.support === "unsupported") {
      return `${primary} does not support native review subagents.`;
    }
    return undefined;
  }
  if (!harness) return undefined;
  if (!hosts || !primary) return undefined;
  if (harness === primary) return "Isolated review must use an agent harness other than the primary harness.";
  if (!hosts.includes(harness)) return `Isolated review harness ${harness} is not in the selected agent harnesses.`;
  if (!(AGENT_HOST_IDS as readonly string[]).includes(harness)) return undefined;
  if (getAgentHostProfileSync(harness as AgentHostId).review.isolated.support === "unsupported") {
    return `${harness} does not support isolated review.`;
  }
  return undefined;
}

function configuredReviewModel(config: QubeInitConfig, reviewHost: string | undefined): string | undefined {
  if (!reviewHost) return undefined;
  const prefix = `${reviewHost}:`;
  const binding = config.review?.models?.find(value => value.startsWith(prefix));
  return binding?.slice(prefix.length);
}

function guidedAnswersFromConfig(config: QubeInitConfig | null, detectedCi: readonly InstallCiProvider[] = []): GuidedInitAnswers {
  if (!config) {
    return detectedCi.length === 1
      ? Object.freeze({ automatedChecks: detectedCi[0] })
      : Object.freeze({});
  }
  const reviewSource = guidedReviewSource(config.review?.mode);
  const reviewHarness = reviewSource === "primary"
    ? config.hosts?.[0]
    : reviewSource === "harness"
      ? config.review?.harness
      : undefined;
  const reviewModel = configuredReviewModel(config, reviewHarness);
  return Object.freeze({
    ...(config.hosts ? { agentHarnesses: config.hosts } : {}),
    ...(config.workProviders?.[0] ? { issueTracker: config.workProviders[0] } : {}),
    ...(config.ciProviders?.[0]
      ? { automatedChecks: config.ciProviders[0] }
      : detectedCi.length === 1
        ? { automatedChecks: detectedCi[0] }
        : {}),
    ...(config.continuousShipping === undefined ? {} : { continuousShipping: config.continuousShipping }),
    ...(config.umpire?.scope ? { umpireScope: config.umpire.scope } : {}),
    ...(config.quality?.stages ? { qualityStages: config.quality.stages } : {}),
    ...(reviewSource ? { reviewSource } : {}),
    ...(reviewSource === "external" && config.review?.externalReviewers
      ? { externalReviewers: config.review.externalReviewers }
      : {}),
    ...(reviewSource === "harness" && reviewHarness ? { reviewHarness } : {}),
    ...(reviewSource && reviewSource !== "external"
      ? { reviewModel: reviewModel ?? null }
      : {}),
    ...(config.review?.publisher ? { reviewPublisher: config.review.publisher } : {}),
  });
}

function defaultGuidedInitAnswers(recommendedReviewer: string | undefined): GuidedInitAnswers {
  return Object.freeze({
    agentHarnesses: Object.freeze(["codex"]),
    issueTracker: "github",
    continuousShipping: true,
    umpireScope: "ready",
    qualityStages: Object.freeze(["unit"]),
    ...(recommendedReviewer ? { externalReviewers: Object.freeze([recommendedReviewer]) } : {}),
    reviewPublisher: "user",
  });
}

function normalizedExplicitGuidedAnswers(
  explicit: GuidedInitAnswers,
  resolved: NonNullable<GuidedInitNormalization["answers"]>,
  current: GuidedInitAnswers,
): GuidedInitAnswers {
  const normalized: GuidedInitAnswers = Object.freeze({
    ...(Object.hasOwn(explicit, "agentHarnesses") ? { agentHarnesses: resolved.agentHarnesses } : {}),
    ...(Object.hasOwn(explicit, "issueTracker") ? { issueTracker: resolved.issueTracker } : {}),
    ...(Object.hasOwn(explicit, "automatedChecks") ? { automatedChecks: resolved.automatedChecks } : {}),
    ...(Object.hasOwn(explicit, "continuousShipping") ? { continuousShipping: resolved.continuousShipping } : {}),
    ...(Object.hasOwn(explicit, "umpireScope") ? { umpireScope: resolved.umpireScope } : {}),
    ...(Object.hasOwn(explicit, "qualityStages") ? { qualityStages: resolved.qualityStages } : {}),
    ...(Object.hasOwn(explicit, "reviewSource") ? { reviewSource: resolved.reviewSource } : {}),
    ...(Object.hasOwn(explicit, "externalReviewers") && resolved.externalReviewers
      ? { externalReviewers: resolved.externalReviewers }
      : {}),
    ...(Object.hasOwn(explicit, "reviewHarness") && resolved.reviewHarness
      ? { reviewHarness: resolved.reviewHarness }
      : {}),
    ...(Object.hasOwn(explicit, "reviewModel") ? { reviewModel: resolved.reviewModel ?? null } : {}),
    ...(Object.hasOwn(explicit, "reviewPublisher") && resolved.reviewPublisher
      ? { reviewPublisher: resolved.reviewPublisher }
      : {}),
  });
  const reviewSourceChanged = Object.hasOwn(normalized, "reviewSource")
    && normalized.reviewSource !== current.reviewSource;
  const withReviewDependencies: GuidedInitAnswers = reviewSourceChanged
    ? Object.freeze({
        ...normalized,
        ...(resolved.reviewSource === "external"
          ? { externalReviewers: resolved.externalReviewers ?? Object.freeze([]), reviewModel: null }
          : resolved.reviewSource === "harness"
            ? { reviewHarness: resolved.reviewHarness, reviewModel: resolved.reviewModel ?? null }
            : { reviewModel: resolved.reviewModel ?? null }),
      })
    : normalized;
  const withPublisherReset: GuidedInitAnswers = current.reviewPublisher === "github-app" && resolved.reviewPublisher === undefined
    ? Object.freeze({ ...withReviewDependencies, reviewPublisher: "user" })
    : withReviewDependencies;
  const reviewHarnessChanged = Object.hasOwn(withPublisherReset, "reviewHarness")
    && withPublisherReset.reviewHarness !== current.reviewHarness;
  const currentReviewHost = current.reviewSource === "primary"
    ? current.agentHarnesses?.[0]
    : current.reviewSource === "harness"
      ? current.reviewHarness
      : undefined;
  const resolvedReviewHost = resolved.reviewSource === "primary"
    ? resolved.agentHarnesses[0]
    : resolved.reviewSource === "harness"
      ? resolved.reviewHarness
      : undefined;
  const reviewHostChanged = (
    Object.hasOwn(withPublisherReset, "agentHarnesses")
    || Object.hasOwn(withPublisherReset, "reviewSource")
    || Object.hasOwn(withPublisherReset, "reviewHarness")
  ) && currentReviewHost !== resolvedReviewHost;
  const withModelReset = (reviewSourceChanged || reviewHarnessChanged || reviewHostChanged) && !Object.hasOwn(withPublisherReset, "reviewModel")
    ? Object.freeze({ ...withPublisherReset, reviewModel: resolved.reviewModel ?? null })
    : withPublisherReset;
  return withModelReset;
}

function guidedConfigFromAnswers(
  flags: Readonly<Record<string, unknown>>,
  answers: GuidedInitAnswers,
  resolved: NonNullable<GuidedInitNormalization["answers"]>,
): QubeInitConfig {
  const reviewSource = answers.reviewSource;
  const reviewModelAnswered = Object.hasOwn(answers, "reviewModel");
  const reviewHost = resolved.reviewSource === "primary"
    ? resolved.agentHarnesses[0]
    : resolved.reviewSource === "harness"
      ? resolved.reviewHarness
      : undefined;
  const reviewModels = reviewModelAnswered
    ? Object.freeze(resolved.reviewModel && reviewHost ? [`${reviewHost}:${resolved.reviewModel}`] : [])
    : undefined;
  return Object.freeze({
    version: 1,
    ...(answers.agentHarnesses ? { hosts: Object.freeze([...answers.agentHarnesses]) } : {}),
    ...(answers.issueTracker ? { workProviders: Object.freeze([answers.issueTracker]) } : {}),
    ...(answers.automatedChecks ? { ciProviders: Object.freeze([answers.automatedChecks]) } : {}),
    ...(answers.continuousShipping === undefined ? {} : { continuousShipping: answers.continuousShipping }),
    ...(answers.umpireScope ? { umpire: Object.freeze({ scope: answers.umpireScope }) } : {}),
    ...(answers.qualityStages ? { quality: Object.freeze({ stages: Object.freeze([...answers.qualityStages]) }) } : {}),
    ...(reviewSource || answers.reviewHarness || answers.externalReviewers || answers.reviewPublisher || reviewModels
      ? {
          review: Object.freeze({
            ...(reviewSource ? { mode: guidedReviewMode(reviewSource) } : {}),
            ...(answers.reviewHarness ? { harness: answers.reviewHarness } : {}),
            ...(answers.externalReviewers
              ? { externalReviewers: Object.freeze([...answers.externalReviewers]) }
              : {}),
            ...(answers.reviewPublisher ? { publisher: answers.reviewPublisher } : {}),
            ...(reviewModels ? { models: reviewModels } : {}),
          }),
        }
      : {}),
    ...(typeof flags.mcp === "boolean" ? { mcp: Object.freeze({ optIn: flags.mcp }) } : {}),
  });
}

function guidedModelCapability(
  host: AgentHostId,
  requestedHost: AgentHostId | undefined,
  listings: Map<AgentHostId, ReturnType<typeof listHostModels>>,
): GuidedReviewModelCapability {
  const profile = getAgentHostProfileSync(host);
  if (profile.modelDiscovery.support === "unsupported") {
    return Object.freeze({
      kind: "unpinned",
      label: "Harness default (not pinned)",
      reason: `${profile.displayName} does not provide a live model list. Leave Review unpinned.`,
    });
  }
  if (requestedHost !== host) {
    return Object.freeze({ kind: "unavailable", reason: "Select this harness before QUBE loads its live model list." });
  }
  let listing = listings.get(host);
  if (!listing) {
    listing = listHostModels(host);
    listings.set(host, listing);
  }
  if (listing.status !== "ready") {
    return Object.freeze({
      kind: "unavailable",
      reason: listing.diagnostic ?? `${profile.displayName} did not provide a live model list.`,
    });
  }
  return Object.freeze({
    kind: "live",
    models: Object.freeze(listing.models.map(model => Object.freeze({ value: model, label: model }))),
  });
}

function createGuidedInitCapabilities(input: {
  readonly environment: CliEnvironment;
  readonly registeredReviewers: readonly { readonly id: string; readonly label: string }[];
  readonly modelHost?: AgentHostId;
  readonly modelListings: Map<AgentHostId, ReturnType<typeof listHostModels>>;
}): GuidedInitCapabilities {
  const installedReviewHosts = new Set(detectInstalledReviewHostsOnPath(command => (
    resolveExecutable(command, { env: input.environment.env }).status === "found"
  )));
  const agentHarnesses: readonly GuidedHarnessChoice[] = Object.freeze(executorHostSurfaces.map(option => {
    const profile = getAgentHostProfileSync(option.id as AgentHostId);
    const availableForSeparateReview = installedReviewHosts.has(profile.id);
    return Object.freeze({
      value: profile.id,
      label: profile.displayName,
      description: `${profile.displayName} uses ${profile.makeItSo.invocation} to start QUBE.`,
      recommended: option.default,
      canRunPrimaryReview: profile.review.local.support !== "unsupported",
      canRunSeparateReview: availableForSeparateReview && profile.review.isolated.support !== "unsupported",
      reviewModels: guidedModelCapability(profile.id, input.modelHost, input.modelListings),
    });
  }));
  const issueTrackers: readonly GuidedIssueTrackerChoice[] = Object.freeze(executorWorkProviders.map(option => Object.freeze({
    value: option.id,
    label: installOptionLabels[option.id] ?? option.id,
    description: option.id === "github"
      ? "Use GitHub issues and pull requests as the shared work queue."
      : `Read the ${installOptionLabels[option.id] ?? option.id} work queue. Lifecycle updates remain manual.`,
    recommended: option.default,
    supportsContinuousShipping: option.capabilities.some(capability => (
      capability.id === "sync-issue-status" && capability.support === "supported"
    )),
  })));
  const automatedChecks: readonly GuidedInitChoice[] = Object.freeze(executorCiProviders.map(option => Object.freeze({
    value: option.id,
    label: installOptionLabels[option.id] ?? option.id,
    description: `Read required check results from ${installOptionLabels[option.id] ?? option.id}.`,
    recommended: option.default,
  })));
  const umpireLabels: Readonly<Record<QubeUmpireScope, string>> = Object.freeze({
    ready: "Ready issues only",
    standard: "Standard post-queue work",
    custom: "Custom set",
  });
  return Object.freeze({
    agentHarnesses,
    issueTrackers,
    automatedChecks,
    umpireScopes: Object.freeze(AIU_POST_ISSUE_SCOPES.map(scope => Object.freeze({
      value: scope,
      label: umpireLabels[scope],
      recommended: scope === "ready",
    }))),
    qualityStages: Object.freeze(aiqStageMetadata.map(stage => {
      const warning = guidedQualityWarning(stage);
      return Object.freeze({
        value: stage.id,
        label: GUIDED_QUALITY_LABELS[stage.id] ?? stage.id,
        description: warning ? `${stage.description} ${warning}` : stage.description,
        recommended: stage.id === "unit",
      });
    })),
    externalReviewers: Object.freeze(input.registeredReviewers.map(reviewer => Object.freeze({
      value: reviewer.id,
      label: reviewer.label,
      forIssueTrackers: GUIDED_REVIEW_TRACKERS,
      recommended: reviewer.id === "coderabbit",
    }))),
    reviewPublishers: Object.freeze([
      Object.freeze({
        value: "user",
        label: "Current GitHub account",
        forIssueTrackers: GUIDED_REVIEW_TRACKERS,
        recommended: true,
      }),
      Object.freeze({
        value: "github-app",
        label: "QUBE Reviewer App",
        description: "Use a separate review identity for formal verdicts and inline comments.",
        forIssueTrackers: GUIDED_REVIEW_TRACKERS,
      }),
    ]),
  });
}

function selectedGuidedModelHost(questions: readonly GuidedInitQuestion[]): AgentHostId | undefined {
  const byId = new Map(questions.map(question => [question.id, question]));
  const source = byId.get("review-source")?.selectedValue;
  if (source === "primary") {
    const hosts = byId.get("agent-harnesses")?.selectedValue;
    return Array.isArray(hosts) ? hosts[0] as AgentHostId | undefined : undefined;
  }
  if (source === "harness") {
    const harness = byId.get("review-harness")?.selectedValue;
    return typeof harness === "string" ? harness as AgentHostId : undefined;
  }
  return undefined;
}

function guidedQuestionChoices(question: GuidedInitQuestion): {
  readonly choices: readonly InstallerChoice<string>[];
  readonly values: ReadonlyMap<string, string>;
} {
  const values = new Map<string, string>();
  const recommended = new Set(Array.isArray(question.recommendedValue)
    ? question.recommendedValue
    : typeof question.recommendedValue === "string"
      ? [question.recommendedValue]
      : []);
  const preferredValue = question.selection === "single" && typeof question.preselectedValue === "string"
    ? question.preselectedValue
    : undefined;
  const options = preferredValue
    ? [
        ...question.options.filter(option => option.value === preferredValue),
        ...question.options.filter(option => option.value !== preferredValue),
      ]
    : question.options;
  const choices = options.map((option, index) => {
    const token = `choice-${index + 1}`;
    values.set(token, option.value);
    return Object.freeze({
      value: token,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
      ...(recommended.has(option.value) ? { recommended: true } : {}),
    });
  });
  return { choices: Object.freeze(choices), values };
}

function showGuidedQuestion(question: GuidedInitQuestion): void {
  process.stdout.write([
    "",
    `${question.step}. ${question.label}`,
    question.explanation,
    `Recommended: ${question.recommendation}. ${question.recommendationReason}`,
    `Documentation: ${question.docsUrl}`,
    "",
  ].join("\n"));
}

async function promptGuidedQuestion(question: GuidedInitQuestion, jsonMode: boolean): Promise<GuidedInitQuestion["selectedValue"]> {
  if (!jsonMode) showGuidedQuestion(question);
  const mapped = guidedQuestionChoices(question);
  if (question.selection === "multiple") {
    const selected = await promptInstallerChoices({
      command: initCommand,
      promptName: question.label,
      message: question.prompt,
      choices: mapped.choices,
      jsonMode,
      yes: false,
    });
    return Object.freeze(selected.map(value => mapped.values.get(value)!));
  }
  const selected = await promptInstallerChoice({
    command: initCommand,
    promptName: question.label,
    message: question.prompt,
    choices: mapped.choices,
    jsonMode,
    yes: false,
  });
  return mapped.values.get(selected) ?? null;
}

function addGuidedAnswer(answers: GuidedInitAnswers, question: GuidedInitQuestion, value: GuidedInitQuestion["selectedValue"]): GuidedInitAnswers {
  const list = Array.isArray(value) ? Object.freeze([...value]) : undefined;
  const selected = typeof value === "string" ? value : undefined;
  switch (question.id) {
    case "agent-harnesses": return Object.freeze({ ...answers, agentHarnesses: list });
    case "issue-tracker": return Object.freeze({ ...answers, issueTracker: selected });
    case "automated-checks": return Object.freeze({ ...answers, automatedChecks: selected });
    case "continuous-shipping": return Object.freeze({ ...answers, continuousShipping: selected === "on" });
    case "umpire-scope": return Object.freeze({ ...answers, umpireScope: selected as QubeUmpireScope });
    case "quality-checks": return Object.freeze({ ...answers, qualityStages: list });
    case "review-source": return Object.freeze({ ...answers, reviewSource: selected as GuidedReviewSource });
    case "external-reviewer": return Object.freeze({ ...answers, externalReviewers: list });
    case "review-harness": return Object.freeze({ ...answers, reviewHarness: selected });
    case "review-model": return Object.freeze({ ...answers, reviewModel: selected === GUIDED_INIT_UNPINNED_MODEL ? null : selected });
    case "review-publisher": return Object.freeze({ ...answers, reviewPublisher: selected as QubeReviewPublisher });
  }
}

function hasGuidedAnswer(answers: GuidedInitAnswers, id: GuidedInitQuestionId): boolean {
  const keys: Readonly<Record<GuidedInitQuestionId, keyof GuidedInitAnswers>> = Object.freeze({
    "agent-harnesses": "agentHarnesses",
    "issue-tracker": "issueTracker",
    "automated-checks": "automatedChecks",
    "continuous-shipping": "continuousShipping",
    "umpire-scope": "umpireScope",
    "quality-checks": "qualityStages",
    "review-source": "reviewSource",
    "external-reviewer": "externalReviewers",
    "review-harness": "reviewHarness",
    "review-model": "reviewModel",
    "review-publisher": "reviewPublisher",
  });
  return Object.hasOwn(answers, keys[id]);
}

function omitGuidedAnswer(answers: GuidedInitAnswers, id: GuidedInitQuestionId): GuidedInitAnswers {
  const mutable = { ...answers } as Record<string, unknown>;
  const keys: Readonly<Record<GuidedInitQuestionId, string>> = Object.freeze({
    "agent-harnesses": "agentHarnesses",
    "issue-tracker": "issueTracker",
    "automated-checks": "automatedChecks",
    "continuous-shipping": "continuousShipping",
    "umpire-scope": "umpireScope",
    "quality-checks": "qualityStages",
    "review-source": "reviewSource",
    "external-reviewer": "externalReviewers",
    "review-harness": "reviewHarness",
    "review-model": "reviewModel",
    "review-publisher": "reviewPublisher",
  });
  delete mutable[keys[id]];
  return Object.freeze(mutable as GuidedInitAnswers);
}

async function collectGuidedInitAnswers(input: {
  readonly environment: CliEnvironment;
  readonly registeredReviewers: readonly { readonly id: string; readonly label: string }[];
  readonly answers: GuidedInitAnswers;
  readonly current: GuidedInitAnswers;
  readonly defaults: GuidedInitAnswers;
  readonly resolveDefaults: boolean;
  readonly jsonMode: boolean;
}): Promise<{ readonly explicitAnswers: GuidedInitAnswers; readonly normalization: GuidedInitNormalization }> {
  let answers = input.answers;
  let current = input.current;
  const modelListings = new Map<AgentHostId, ReturnType<typeof listHostModels>>();
  const questions = (): readonly GuidedInitQuestion[] => {
    const firstCapabilities = createGuidedInitCapabilities({
      environment: input.environment,
      registeredReviewers: input.registeredReviewers,
      modelListings,
    });
    const firstQuestions = buildGuidedInitQuestions({
      capabilities: firstCapabilities,
      answers,
      current,
      defaults: input.defaults,
      resolveDefaults: input.resolveDefaults,
    });
    const modelHost = selectedGuidedModelHost(firstQuestions);
    const capabilities = createGuidedInitCapabilities({
      environment: input.environment,
      registeredReviewers: input.registeredReviewers,
      ...(modelHost ? { modelHost } : {}),
      modelListings,
    });
    return buildGuidedInitQuestions({
      capabilities,
      answers,
      current,
      defaults: input.defaults,
      resolveDefaults: input.resolveDefaults,
    });
  };

  for (const id of GUIDED_INIT_QUESTION_ORDER) {
    let question = questions().find(candidate => candidate.id === id);
    if (!question || !question.applicable) continue;
    if (
      question.validationError
      && !hasGuidedAnswer(answers, id)
      && question.options.length > 0
    ) {
      current = omitGuidedAnswer(current, id);
      question = questions().find(candidate => candidate.id === id);
      if (question && !question.promptNeeded && question.selectedValue !== null) {
        answers = addGuidedAnswer(answers, question, question.selectedValue);
        question = questions().find(candidate => candidate.id === id);
      }
    }
    if (!question || !question.applicable || !question.promptNeeded || question.validationError) continue;
    const promptGate = evaluatePromptGate({ command: initCommand, jsonMode: input.jsonMode });
    if (!promptGate.allowed) continue;
    answers = addGuidedAnswer(answers, question, await promptGuidedQuestion(question, input.jsonMode));
  }

  const finalQuestions = questions();
  const finalCapabilities = createGuidedInitCapabilities({
    environment: input.environment,
    registeredReviewers: input.registeredReviewers,
    ...(selectedGuidedModelHost(finalQuestions) ? { modelHost: selectedGuidedModelHost(finalQuestions) } : {}),
    modelListings,
  });
  return Object.freeze({
    explicitAnswers: answers,
    normalization: normalizeGuidedInitAnswers({
      capabilities: finalCapabilities,
      answers,
      current,
      defaults: input.defaults,
      resolveDefaults: input.resolveDefaults,
    }),
  });
}

function publicGuidedAnswers(normalization: GuidedInitNormalization, detectedCiProvider = false): readonly PublicInitAnswer[] {
  const selectedQualityStages = normalization.answers?.qualityStages ?? Object.freeze([]);
  const qualityWarnings = [...new Set(aiqStageMetadata
    .filter(stage => selectedQualityStages.includes(stage.id))
    .flatMap(stage => guidedQualityWarning(stage) ? [guidedQualityWarning(stage)!] : []))];
  return Object.freeze(normalization.summary.map(answer => Object.freeze({
    id: answer.id,
    label: answer.label,
    value: answer.answer,
    reason: detectedCiProvider && answer.id === "automated-checks"
      ? "QUBE detected this provider from the repository's automated-check configuration."
      : answer.id === "quality-checks" && qualityWarnings.length > 0
        ? `${answer.reason} ${qualityWarnings.join(" ")}`
      : answer.reason,
  })));
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

function publisherReadinessFromChild(result: QubeInitChildResult): InitPublisherReadiness {
  if (!result.ok) {
    return Object.freeze({
      state: "unavailable",
      nextAction: result.nextAction ?? "Run `qube review doctor --json` after you correct the review publisher setup.",
    });
  }
  const record = childRecord(result.json);
  const state = directText(record, ["readiness"]);
  if (!state || !["ready", "degraded", "unavailable", "unconfigured"].includes(state)) {
    return Object.freeze({
      state: "unavailable",
      nextAction: "Run `qube review doctor --json` to inspect review publisher readiness.",
    });
  }
  const nextAction = directText(record, ["nextAction"]);
  return Object.freeze({
    state: state as InitPublisherReadiness["state"],
    ...(nextAction ? { nextAction } : {}),
  });
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
): "create" | "update" | "remove" | "skip" {
  if (skipEmptyRepo && current.status === "missing" && Object.keys(desired).length === 1) return "skip";
  if (skipEmptyRepo && current.status === "valid" && Object.keys(desired).length === 1) return "remove";
  if (current.status === "missing") return "create";
  if (current.config && JSON.stringify(current.config) === JSON.stringify(desired)) return "skip";
  return "update";
}

interface InitAggregateDiagnostics {
  readonly id: "aggregate-diagnostics";
  readonly status: "ready" | "attention";
  readonly exitCode: number;
  readonly result?: unknown;
  readonly error?: string;
  readonly nextAction?: string;
}

async function runInitAggregateDiagnostics(
  environment: CliEnvironment,
  targetPath: string,
  targetArgument: string | undefined,
): Promise<InitAggregateDiagnostics> {
  const result = await executeQubeDoctor(true, false, { ...environment, cwd: targetPath });
  let parsed: unknown;
  let parseError: string | undefined;
  try {
    parsed = result.jsonStdout ? JSON.parse(result.jsonStdout) : undefined;
    if (!parsed || typeof parsed !== "object") {
      parseError = "Aggregate diagnostics returned no structured result.";
    }
  } catch {
    parseError = "Aggregate diagnostics returned invalid JSON.";
  }
  const ready = result.exitCode === 0
    && !parseError
    && (parsed as { ok?: unknown } | undefined)?.ok === true;
  if (ready) {
    return Object.freeze({
      id: "aggregate-diagnostics",
      status: "ready",
      exitCode: 0,
      result: parsed,
    });
  }
  const error = parseError
    || result.stderr?.trim()
    || `Aggregate diagnostics exited with code ${result.exitCode}.`;
  return Object.freeze({
    id: "aggregate-diagnostics",
    status: "attention",
    exitCode: result.exitCode || 1,
    ...(parsed === undefined ? {} : { result: parsed }),
    error,
    nextAction: `Correct the reported readiness problems, then rerun \`${initRerunCommand("repository", targetArgument)}\`.`,
  });
}

type QubeInitScope = "global" | "repository";

type QubeInitConfigurationAction = "edit" | "inherit" | "inherit-all";

interface QubeInitInheritance {
  readonly action: QubeInitConfigurationAction;
  readonly fields: readonly QubeInitField[];
}

const QUBE_INIT_FIELD_FLAGS: Readonly<Partial<Record<QubeInitField, string>>> = Object.freeze({
  hosts: "host",
  workProviders: "work-provider",
  ciProviders: "ci-provider",
  continuousShipping: "continuous-shipping",
  "umpire.scope": "umpire-scope",
  "quality.stages": "quality-stage",
  "review.mode": "review-mode",
  "review.harness": "review-harness",
  "review.externalReviewers": "external-reviewer",
  "review.publisher": "review-publisher",
  "mcp.optIn": "mcp",
});

function resolveQubeInitScope(
  flags: Readonly<Record<string, unknown>>,
  args: Readonly<Record<string, unknown>>,
): { readonly scope: QubeInitScope; readonly error?: string } {
  const canonicalGlobal = flags.global === true;
  const compatibilityScope = readOption<"repo" | "global">(flags, "config-scope");
  const hasTarget = readString(args.target) !== undefined;
  const wantsGitInit = flags["git-init"] === true;
  if (canonicalGlobal && compatibilityScope === "repo") {
    return { scope: "global", error: "--global conflicts with --config-scope repo." };
  }
  const scope: QubeInitScope = canonicalGlobal || compatibilityScope === "global" ? "global" : "repository";
  if (canonicalGlobal && hasTarget) {
    return { scope, error: "Global initialization does not accept a target. `qube init global` remains a repository target; use `qube init --global`." };
  }
  if (scope === "global" && wantsGitInit) {
    return { scope, error: "--git-init applies only to repository initialization and cannot be combined with --global." };
  }
  return { scope };
}

function resolveQubeInitInheritance(
  flags: Readonly<Record<string, unknown>>,
  scope: QubeInitScope,
): { readonly inheritance: QubeInitInheritance; readonly error?: string } {
  const requested = readOptionList<string>(flags, "inherit") ?? Object.freeze([]);
  const inheritAll = flags["inherit-all"] === true;
  const unknown = requested.filter(field => !(QUBE_INIT_FIELDS as readonly string[]).includes(field));
  const fallback: QubeInitInheritance = Object.freeze({ action: "edit", fields: Object.freeze([]) });
  if (unknown.length > 0) {
    return {
      inheritance: fallback,
      error: `Unknown repository setting${unknown.length === 1 ? "" : "s"} for --inherit: ${unknown.join(", ")}. Use one or more of: ${QUBE_INIT_FIELDS.join(", ")}.`,
    };
  }
  if ((inheritAll || requested.length > 0) && scope === "global") {
    return {
      inheritance: fallback,
      error: "Inheritance actions apply only to repository initialization because user-global setup has no higher configuration scope.",
    };
  }
  if (inheritAll && requested.length > 0) {
    return { inheritance: fallback, error: "--inherit-all conflicts with --inherit. Choose one inheritance action." };
  }
  const fields = Object.freeze((inheritAll ? QUBE_INIT_FIELDS : [...new Set(requested)]) as readonly QubeInitField[]);
  for (const field of fields) {
    const selectionFlag = QUBE_INIT_FIELD_FLAGS[field];
    if (selectionFlag && flags[selectionFlag] !== undefined) {
      return {
        inheritance: fallback,
        error: `--inherit ${field} conflicts with --${selectionFlag}. Choose the repository value or inherit it, not both.`,
      };
    }
  }
  return {
    inheritance: Object.freeze({
      action: inheritAll ? "inherit-all" : fields.length > 0 ? "inherit" : "edit",
      fields,
    }),
  };
}

interface InitGitState {
  readonly selectedTarget: string;
  readonly repositoryRoot: string | null;
  readonly gitAvailable: boolean;
  readonly reason: string | null;
}

function inspectInitGitState(cwd: string, target: string): InitGitState {
  const selectedTarget = path.resolve(cwd, target);
  if (!existsSync(selectedTarget) || !statSync(selectedTarget).isDirectory()) {
    return { selectedTarget, repositoryRoot: null, gitAvailable: true, reason: "The repository target must be an existing directory." };
  }
  const probe = spawnSync("git", ["-C", selectedTarget, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (probe.error && (probe.error as NodeJS.ErrnoException).code === "ENOENT") {
    return { selectedTarget, repositoryRoot: null, gitAvailable: false, reason: "Git is not installed or is not available on PATH." };
  }
  if (probe.status !== 0) {
    return { selectedTarget, repositoryRoot: null, gitAvailable: true, reason: "The selected target is not inside a Git repository." };
  }
  const repositoryRoot = probe.stdout.trim();
  return {
    selectedTarget,
    repositoryRoot: repositoryRoot === "" ? selectedTarget : path.resolve(repositoryRoot),
    gitAvailable: true,
    reason: null,
  };
}

function missingConfigRead(pathValue: string): ReturnType<typeof readQubeInitConfig> {
  return Object.freeze({ path: pathValue, status: "missing" as const, config: null, error: null });
}

type InitPackagePlacement = "global" | "project" | "unknown";

interface InitPackageRequirementReport {
  readonly placement: InitPackagePlacement;
  readonly packageManager: InstallPackageManager;
  readonly requirements: readonly {
    readonly name: string;
    readonly version: string;
    readonly status: "ready" | "missing";
  }[];
  readonly installCommand: string | null;
}

function findProjectPackageRoot(cwd: string): string | null {
  let current = path.resolve(cwd);
  while (true) {
    const manifestPath = path.join(current, "package.json");
    if (existsSync(manifestPath) && statSync(manifestPath).isFile()) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relativePath = path.relative(path.resolve(root), path.resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function declaredQubePackage(projectRoot: string | null): boolean {
  if (!projectRoot) return false;
  try {
    const manifest = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8")) as Record<string, unknown>;
    return ["dependencies", "devDependencies", "optionalDependencies"].some(field => {
      const values = manifest[field];
      return values !== null && typeof values === "object" && !Array.isArray(values)
        && typeof (values as Record<string, unknown>)[packageName] === "string";
    });
  } catch {
    return false;
  }
}

function detectInitPackagePlacement(environment: CliEnvironment): {
  readonly placement: InitPackagePlacement;
  readonly packageManager: InstallPackageManager;
  readonly projectRoot: string | null;
} {
  const explicitPlacement = environment.env.QUBE_PACKAGE_PLACEMENT;
  const projectRoot = findProjectPackageRoot(environment.cwd);
  const packageRoot = environment.packageRoot ?? defaultPackageRoot(environment.env);
  const placement: InitPackagePlacement = explicitPlacement === "global" || explicitPlacement === "project" || explicitPlacement === "unknown"
    ? explicitPlacement
    : projectRoot && (declaredQubePackage(projectRoot) || pathIsWithin(projectRoot, packageRoot))
      ? "project"
      : packageRoot.toLowerCase().includes(`${path.sep}node_modules${path.sep}`)
        ? "global"
        : "unknown";
  const userAgent = environment.env.npm_config_user_agent ?? "";
  const packageManager: InstallPackageManager = projectRoot && existsSync(path.join(projectRoot, "pnpm-lock.yaml"))
    ? "pnpm"
    : projectRoot && existsSync(path.join(projectRoot, "package-lock.json"))
      ? "npm"
      : userAgent.startsWith("pnpm/")
        ? "pnpm"
        : "npm";
  return { placement, packageManager, projectRoot };
}

function installedInitPackageVersion(
  packageNameValue: string,
  environment: CliEnvironment,
  projectRoot: string | null,
): string | null {
  const packageParts = packageNameValue.split("/");
  const packageRoot = environment.packageRoot ?? defaultPackageRoot(environment.env);
  const aie = qubeComponents.find(component => component.command === "aie");
  const aieResolution = aie ? resolveComponentCommand(aie, environment) : undefined;
  const candidateRoots = [
    path.join(packageRoot, "node_modules"),
    ...(projectRoot ? [path.join(projectRoot, "node_modules")] : []),
    ...(aieResolution?.packageJsonPath ? [path.join(path.dirname(aieResolution.packageJsonPath), "node_modules")] : []),
  ];
  for (const root of candidateRoots) {
    const manifestPath = path.join(root, ...packageParts, "package.json");
    const version = readPackageVersion(packageNameValue, manifestPath);
    if (version) return version;
  }
  return null;
}

function inspectInitPackageRequirements(
  setup: QubeInitConfig & { readonly hosts: readonly string[]; readonly workProviders: readonly string[]; readonly ciProviders: readonly string[] },
  scope: QubeInitScope,
  environment: CliEnvironment,
): InitPackageRequirementReport {
  const detected = detectInitPackagePlacement(environment);
  const selections = {
    scope: detected.placement === "project" ? "local" as const : "global" as const,
    packageManager: detected.packageManager,
    hosts: setup.hosts,
    workProviders: setup.workProviders,
    ciProviders: setup.ciProviders,
    lifecycleScripts: "disabled" as const,
  };
  const componentRequirements = scope === "repository"
    ? qubeComponents.filter(component => component.initCapability?.scopes.includes("repository"))
    : setup.review?.publisher === "github-app"
      ? qubeComponents.filter(component => component.command === "aie")
      : [];
  const requirements = [
    ...componentRequirements.map(component => ({
      name: component.packageName,
      version: component.packageVersion,
      status: resolveComponentCommand(component, environment) ? "ready" as const : "missing" as const,
    })),
    ...selectedAdapterInstallSpecs(selections).map(spec => ({
      name: spec.name,
      version: spec.version,
      status: installedInitPackageVersion(spec.name, environment, detected.projectRoot) === spec.version
        ? "ready" as const
        : "missing" as const,
    })),
  ];
  const deduplicated = [...new Map(requirements.map(requirement => [requirement.name, requirement])).values()];
  return Object.freeze({
    placement: detected.placement,
    packageManager: detected.packageManager,
    requirements: Object.freeze(deduplicated),
    installCommand: deduplicated.some(requirement => requirement.status === "missing")
      ? formatPackageInstallCommand(selections)
      : null,
  });
}

function initRerunCommand(scope: QubeInitScope, target: string | undefined): string {
  return scope === "global" ? "qube init --global" : `qube init ${target ?? "."}`;
}

function initComponentFailureNextAction(
  scope: QubeInitScope,
  target: string | undefined,
  actionId: QubeInitComponentId,
  childNextAction: string | undefined,
): string {
  const force = childNextAction?.includes("--force") ? " --force" : "";
  return `Correct ${publicInitActionLabel(actionId).toLowerCase()}, then rerun \`${initRerunCommand(scope, target)}${force}\`.`;
}

function initOwnedAction(action: unknown, scope: QubeInitScope, target: string | undefined, status: "planned" | "pending"): Readonly<Record<string, unknown>> {
  const record = childRecord(action) ?? {};
  const { command: _command, ...publicFields } = record;
  void _command;
  return Object.freeze({
    ...publicFields,
    status,
    handledBy: "qube init",
    nextAction: `Rerun \`${initRerunCommand(scope, target)}\` to resume this action.`,
  });
}

function repositoryHasOrigin(targetPath: string): boolean {
  const remote = spawnSync("git", ["-C", targetPath, "remote", "get-url", "origin"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return remote.status === 0 && remote.stdout.trim() !== "";
}

function deferredProviderFailure(error: string | undefined): boolean {
  return Boolean(error && /authentication|authenticate|credential|login|remote|repository identity|not a git repository|could not resolve repository/i.test(error));
}

async function executeQubeInit(flags: Readonly<Record<string, unknown>>, args: Readonly<Record<string, unknown>>, environment: CliEnvironment): Promise<RuntimeCommandResult> {
  const json = flags.json === true;
  const dryRun = flags["dry-run"] === true;
  const force = flags.force === true;
  const useDefaults = flags.yes === true || flags.defaults === true;
  const scopeResult = resolveQubeInitScope(flags, args);
  if (scopeResult.error) {
    const nextAction = "Use `qube init --global` without a target, or use `qube init [target]` for repository initialization.";
    const payload = { ok: false, command: "init", scope: scopeResult.scope, failedAction: publicInitActionLabel("config"), error: scopeResult.error, nextAction };
    return json
      ? { exitCode: 2, jsonStdout: `${JSON.stringify(payload)}\n` }
      : { exitCode: 2, stdout: "", stderr: renderInitFailure({ actionId: "config", reason: scopeResult.error, nextAction }) };
  }
  const scope = scopeResult.scope;
  const inheritanceResult = resolveQubeInitInheritance(flags, scope);
  if (inheritanceResult.error) {
    const nextAction = scope === "global"
      ? "Remove the inheritance option, then rerun `qube init --global`."
      : "Choose either repository selections or inheritance actions for each field, then rerun qube init.";
    const payload = { ok: false, command: "init", scope, failedAction: publicInitActionLabel("config"), error: inheritanceResult.error, nextAction };
    return json
      ? { exitCode: 2, jsonStdout: `${JSON.stringify(payload)}\n` }
      : { exitCode: 2, stdout: "", stderr: renderInitFailure({ actionId: "config", reason: inheritanceResult.error, nextAction }) };
  }
  const inheritance = inheritanceResult.inheritance;
  const configScope = scope === "global" ? "global" : "repo";
  const gitState = scope === "repository" ? inspectInitGitState(environment.cwd, readString(args.target) ?? ".") : null;
  if (gitState?.reason === "The repository target must be an existing directory.") {
    const nextAction = "Create the target directory, then rerun `qube init <target>`.";
    const payload = { ok: false, command: "init", scope, failedAction: "Repository target", error: gitState.reason, nextAction };
    return json
      ? { exitCode: 2, jsonStdout: `${JSON.stringify(payload)}\n` }
      : { exitCode: 2, stdout: "", stderr: renderInitFailure({ actionId: "config", reason: gitState.reason, nextAction }) };
  }
  const targetPath = gitState?.repositoryRoot ?? gitState?.selectedTarget ?? environment.cwd;
  const globalConfigPath = userQubeConfigPath(homeDirectory(environment));
  const repositoryConfigPath = scope === "repository" ? repoQubeConfigPath(targetPath) : "";
  const globalConfig = readQubeInitConfig(globalConfigPath);
  const repositoryConfig = scope === "repository"
    ? readQubeInitConfig(repositoryConfigPath)
    : missingConfigRead(path.join(globalConfigPath, "global-init-does-not-read-repository-config"));
  const configError = initConfigError("user-global", globalConfig)
    ?? (scope === "repository" ? initConfigError("repository", repositoryConfig) : undefined);
  if (configError) {
    const nextAction = "Correct the invalid QUBE setup file, then rerun qube init.";
    const payload = { ok: false, command: "init", failedAction: publicInitActionLabel("config"), error: configError, nextAction };
    return json
      ? { exitCode: 2, jsonStdout: `${JSON.stringify(payload)}\n` }
      : { exitCode: 2, stdout: "", stderr: renderInitFailure({ actionId: "config", reason: configError, nextAction }) };
  }

  const repositoryLayer = scope === "repository"
    ? omitQubeInitFields(repositoryConfig.config, inheritance.fields)
    : null;
  const inherited = mergeQubeInitConfigs(globalConfig.config, repositoryLayer);
  const explicitReviewSelectionError = explicitGuidedReviewError(flags, inherited);
  if (explicitReviewSelectionError) {
    const nextAction = "Correct the Review selection, then rerun qube init.";
    const payload = { ok: false, command: "init", failedAction: publicInitActionLabel("config"), error: explicitReviewSelectionError, nextAction };
    return json
      ? { exitCode: 2, jsonStdout: `${JSON.stringify(payload)}\n` }
      : { exitCode: 2, stdout: "", stderr: renderInitFailure({ actionId: "config", reason: explicitReviewSelectionError, nextAction }) };
  }
  const detectedCi = scope === "repository" ? detectCiProviders(targetPath) : Object.freeze([]) as readonly InstallCiProvider[];
  const registeredReviewers = await listInitExternalReviewers();
  const recommendedReviewer = registeredReviewers.find(reviewer => reviewer.id === "coderabbit") ?? registeredReviewers[0];
  const guidedDefaults = defaultGuidedInitAnswers(recommendedReviewer?.id);
  const guidedFlagAnswers = guidedAnswersFromFlags(flags, registeredReviewers);
  const guidedCurrent = guidedAnswersFromConfig(inherited, detectedCi);
  const guidedRun = await collectGuidedInitAnswers({
    environment,
    registeredReviewers,
    answers: guidedFlagAnswers,
    current: guidedCurrent,
    defaults: guidedDefaults,
    resolveDefaults: useDefaults,
    jsonMode: json,
  });
  if (!guidedRun.normalization.validation.ok || !guidedRun.normalization.answers) {
    const firstBlocker = guidedRun.normalization.questions.find(question => (
      question.applicable && (question.validationError || question.promptNeeded)
    ));
    const firstError = firstBlocker?.validationError;
    const unresolved = !firstError && firstBlocker?.promptNeeded ? firstBlocker.id : undefined;
    const error = firstError
      ?? (unresolved
        ? `Guided setup still needs an answer for ${unresolved}.`
        : "Guided setup could not resolve the required answers.");
    const nextAction = firstError?.includes("no available Review source")
      ? "Select and install a compatible Review harness, or choose an issue tracker with an available external review service."
      : firstError?.startsWith("Review model:")
        ? "Make the selected harness live model list available, then rerun qube init."
        : unresolved
          ? "Rerun qube init in an interactive terminal, or supply the matching command option."
          : "Correct the selected setup value, then rerun qube init.";
    const payload = { ok: false, command: "init", failedAction: publicInitActionLabel("config"), error, nextAction };
    return json
      ? { exitCode: 2, jsonStdout: `${JSON.stringify(payload)}\n` }
      : { exitCode: 2, stdout: "", stderr: renderInitFailure({ actionId: "config", reason: error, nextAction }) };
  }
  const guidedAnswers = guidedRun.normalization.answers;
  const detectedCiAnswer = !Object.hasOwn(guidedFlagAnswers, "automatedChecks")
    && !inherited.ciProviders
    && detectedCi.length === 1
    && guidedAnswers.automatedChecks === detectedCi[0];
  const answers = publicGuidedAnswers(guidedRun.normalization, detectedCiAnswer);
  const requestedExternalReviewers = readOptionList<string>(flags, "external-reviewer");
  const requestedReviewHarness = readOption<string>(flags, "review-harness");
  const requestedPublisher = readOption<QubeReviewPublisher>(flags, "review-publisher");
  let explicitReviewError: string | undefined;
  if (requestedPublisher && guidedAnswers.issueTracker === "gitlab") {
    explicitReviewError = "Review publisher selection applies only when GitHub publishes reviews.";
  } else if (requestedExternalReviewers && guidedAnswers.reviewSource !== "external") {
    explicitReviewError = "External reviewer services require external review mode.";
  } else if (requestedReviewHarness && guidedAnswers.reviewSource === "external") {
    explicitReviewError = "External review does not use an agent harness.";
  } else if (requestedReviewHarness && guidedAnswers.reviewSource === "primary" && requestedReviewHarness !== guidedAnswers.agentHarnesses[0]) {
    explicitReviewError = `Primary-harness review must use ${guidedAnswers.agentHarnesses[0]}.`;
  }
  if (explicitReviewError) {
    const nextAction = "Correct the Review selection, then rerun qube init.";
    const payload = { ok: false, command: "init", failedAction: publicInitActionLabel("config"), error: explicitReviewError, nextAction };
    return json
      ? { exitCode: 2, jsonStdout: `${JSON.stringify(payload)}\n` }
      : { exitCode: 2, stdout: "", stderr: renderInitFailure({ actionId: "config", reason: explicitReviewError, nextAction }) };
  }
  const explicitAnswers = normalizedExplicitGuidedAnswers(guidedRun.explicitAnswers, guidedAnswers, guidedCurrent);
  const guidedExplicit = guidedConfigFromAnswers(flags, explicitAnswers, guidedAnswers);
  const explicit: QubeInitConfig = guidedAnswers.reviewSource === "external" && (inherited.review?.models?.length ?? 0) > 0
    ? Object.freeze({
        ...guidedExplicit,
        review: Object.freeze({ ...guidedExplicit.review, models: Object.freeze([]) }),
      })
    : guidedExplicit;
  const guidedMode = guidedReviewMode(guidedAnswers.reviewSource);
  const guidedReviewHarness = guidedAnswers.reviewSource === "primary"
    ? guidedAnswers.agentHarnesses[0]
    : guidedAnswers.reviewHarness;
  const defaultsConfig = Object.freeze({
    version: 1,
    hosts: Object.freeze([...guidedAnswers.agentHarnesses]),
    workProviders: Object.freeze([guidedAnswers.issueTracker]),
    ciProviders: Object.freeze([guidedAnswers.automatedChecks]),
    continuousShipping: guidedAnswers.continuousShipping,
    umpire: Object.freeze({ scope: guidedAnswers.umpireScope }),
    quality: Object.freeze({ stages: Object.freeze([...guidedAnswers.qualityStages]) }),
    review: Object.freeze({
      mode: guidedMode,
      ...(guidedMode !== "external" && guidedReviewHarness ? { harness: guidedReviewHarness } : {}),
      externalReviewers: Object.freeze(guidedAnswers.externalReviewers ?? (recommendedReviewer ? [recommendedReviewer.id] : [])),
      publisher: guidedAnswers.reviewPublisher ?? "user",
      ...(guidedMode !== "external" && guidedReviewHarness && guidedAnswers.reviewModel
        ? { models: Object.freeze([`${guidedReviewHarness}:${guidedAnswers.reviewModel}`]) }
        : {}),
    }),
    mcp: Object.freeze({ optIn: false }),
  });
  const detectedConfig: QubeInitConfig = Object.freeze({
    version: 1,
    ...(detectedCi.length === 1 ? { ciProviders: detectedCi } : {}),
  });
  const baseResolved = resolveQubeInitConfig({
    globalConfig: globalConfig.config,
    repoConfig: repositoryLayer,
    detected: detectedConfig,
    explicit,
    defaults: defaultsConfig,
  });
  let resolved = baseResolved;
  if (baseResolved.config.review.mode === "external") {
    const reviewerSelection = resolveExternalReviewerIds(baseResolved.config.review.externalReviewers ?? [], registeredReviewers);
    if (reviewerSelection.error) {
      const nextAction = "Select an available external review service, then rerun qube init.";
      const payload = { ok: false, command: "init", answers, failedAction: publicInitActionLabel("config"), error: reviewerSelection.error, nextAction };
      return json
        ? { exitCode: 2, jsonStdout: `${JSON.stringify(payload)}\n` }
        : { exitCode: 2, stdout: "", stderr: renderInitFailure({ actionId: "config", reason: reviewerSelection.error, nextAction }) };
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
  const primaryProfile = getAgentHostProfileSync(primaryHarness as AgentHostId);
  const primaryHarnessPrompt = Object.freeze({
    displayName: primaryProfile.displayName,
    makeItSo: primaryProfile.makeItSo.invocation,
  });
  const reviewHarness = setup.review.harness;
  const requestedResolvedReviewHarness = explicit.review?.harness;
  const requestedResolvedExternalReviewers = explicit.review?.externalReviewers;
  let reviewError: string | undefined;
  if (setup.review.mode === "external" && reviewProvider !== "github") {
    reviewError = `External reviewer services are not registered for the ${reviewProvider} review provider.`;
  } else if (setup.review.mode === "external" && requestedResolvedReviewHarness) {
    reviewError = "External review does not use an agent harness.";
  } else if (setup.review.mode !== "external" && requestedResolvedExternalReviewers && requestedResolvedExternalReviewers.length > 0) {
    reviewError = "External reviewer services require external review mode.";
  } else if (setup.review.mode === "host") {
    if (requestedResolvedReviewHarness && requestedResolvedReviewHarness !== primaryHarness) reviewError = `Primary-harness review must use ${primaryHarness}.`;
    else if (reviewHarness !== primaryHarness) reviewError = `Primary-harness review must use ${primaryHarness}.`;
    else if (getAgentHostProfileSync(primaryHarness as AgentHostId).review.local.support === "unsupported") reviewError = `${primaryHarness} does not support native review subagents.`;
  } else if (setup.review.mode === "isolated") {
    if (!reviewHarness) reviewError = "Isolated review requires another selected agent harness.";
    else if (reviewHarness === primaryHarness) reviewError = "Isolated review must use an agent harness other than the primary harness.";
    else if (!setup.hosts.includes(reviewHarness)) reviewError = `Isolated review harness ${reviewHarness} is not in the selected agent harnesses.`;
    else if (getAgentHostProfileSync(reviewHarness as AgentHostId).review.isolated.support === "unsupported") reviewError = `${reviewHarness} does not support isolated review.`;
  }
  if (reviewError) {
    const nextAction = "Correct the Review selection, then rerun qube init.";
    const payload = { ok: false, command: "init", answers, failedAction: publicInitActionLabel("config"), error: reviewError, nextAction };
    return json
      ? { exitCode: 2, jsonStdout: `${JSON.stringify(payload)}\n` }
      : { exitCode: 2, stdout: "", stderr: renderInitFailure({ actionId: "config", reason: reviewError, nextAction }) };
  }
  if (setup.review.publisher === "github-app" && reviewProvider !== "github") {
    const error = "QUBE Reviewer App publishing requires the GitHub review provider.";
    const nextAction = "Use the current account for this provider, or select GitHub Review before choosing the QUBE Reviewer App.";
    const payload = { ok: false, command: "init", answers, failedAction: publicInitActionLabel("config"), error, nextAction };
    return json
      ? { exitCode: 2, jsonStdout: `${JSON.stringify(payload)}\n` }
        : { exitCode: 2, stdout: "", stderr: renderInitFailure({ actionId: "config", reason: error, nextAction }) };
  }

  const packageRequirements = inspectInitPackageRequirements(setup, scope, environment);
  const missingPackages = packageRequirements.requirements.filter(requirement => requirement.status === "missing");
  if (missingPackages.length > 0) {
    const missing = missingPackages.map(requirement => `${requirement.name}@${requirement.version}`).join(", ");
    const error = `Required QUBE packages are unavailable for the detected ${packageRequirements.placement} package placement: ${missing}.`;
    const installCommand = packageRequirements.installCommand!;
    const rerun = scope === "global" ? "qube init --global" : `qube init ${readString(args.target) ?? "."}`;
    const nextAction = `Run \`${installCommand}\`, then rerun \`${rerun}\`.`;
    const payload = { ok: false, command: "init", scope, mode: "preflight", changed: false, packageRequirements, failedAction: "Package requirements", error, nextAction };
    return json
      ? { exitCode: 4, jsonStdout: `${JSON.stringify(payload)}\n` }
      : { exitCode: 4, stdout: "", stderr: renderInitFailure({ actionId: "packages", reason: error, nextAction }) };
  }

  const selectedConfigPath = configScope === "global" ? globalConfigPath : repositoryConfigPath;
  const selectedConfigRead = configScope === "global" ? globalConfig : repositoryConfig;
  const projectedConfig = configForQubeScope(resolved, configScope, globalConfig.config);
  const selectedConfig = configScope === "repo"
    ? omitQubeInitFields(projectedConfig, inheritance.fields) ?? Object.freeze({ version: 1 as const })
    : projectedConfig;
  const configOperation = qubeConfigOperation(selectedConfigRead, selectedConfig, configScope === "repo");
  const configuration = scope === "repository"
    ? Object.freeze({
        scope: "repository" as const,
        action: inheritance.action,
        fields: describeQubeInitFields({
          userGlobal: globalConfig.config,
          repository: repositoryConfig.config,
          resolved,
          projectedRepository: selectedConfig,
        }),
      })
    : undefined;

  const aieTool = resolveAieInitToolTargets(setup.hosts as readonly InstallHost[])[0];
  const aiuTool = resolveAiuInitToolTargets(setup.hosts as readonly InstallHost[])[0] ?? "none";
  const prospectiveRoot = scope === "repository" && gitState?.repositoryRoot === null;
  const childEnvironment = scope === "repository"
    ? Object.freeze({
        ...environment.env,
        [QUBE_INIT_LAYER_CONTEXT_ENV]: serializeInitLayerContext({
          version: 1,
          selectedScope: "repository",
          effective: setup as unknown as Readonly<Record<string, unknown>>,
          sources: resolved.sources,
          baseline: globalConfig.config as unknown as Readonly<Record<string, unknown>> | null,
          repository: selectedConfig as unknown as Readonly<Record<string, unknown>>,
        }),
      })
    : environment.env;
  const repositorySelection = <Value>(field: QubeInitField, value: Value): Value | undefined => (
    scope === "repository" && resolved.sources[field] === "user-global" ? undefined : value
  );
  const buildInvocations = (planOnly: boolean): readonly QubeInitInvocation[] => scope === "global"
    ? Object.freeze([])
    : Object.freeze([
    {
      id: "aie",
      component: "aie",
      cwd: targetPath,
      env: childEnvironment,
      args: buildAieInitArgs(targetPath, aieTool, {
        dryRun: planOnly,
        prospectiveRoot: planOnly && prospectiveRoot,
        force,
        yes: true,
        defaults: false,
        workProvider: repositorySelection("workProviders", setup.workProviders[0]),
        reviewProvider: repositorySelection("workProviders", reviewProvider),
        ciProvider: repositorySelection("ciProviders", setup.ciProviders[0]),
        primaryHost: repositorySelection("hosts", primaryHarness),
        reviewMode: repositorySelection("review.mode", setup.review.mode),
        reviewAgents: setup.review.mode === "external"
          ? repositorySelection("review.externalReviewers", setup.review.externalReviewers)
          : undefined,
        localReviewAgents: setup.review.mode === "host"
          ? repositorySelection("review.harness", [primaryHarness])
          : undefined,
        isolatedReviewAgent: setup.review.mode === "isolated"
          ? repositorySelection("review.harness", reviewHarness)
          : undefined,
        reviewModels: setup.review.mode === "external"
          ? undefined
          : repositorySelection("review.models", setup.review.models),
        publisher: reviewProvider === "github"
          ? repositorySelection("review.publisher", setup.review.publisher)
          : undefined,
        configScope,
        continuousShipping: repositorySelection("continuousShipping", setup.continuousShipping),
        uiAuditEvidenceRoot: readOption<string>(flags, "ui-audit-evidence-root"),
        creditWarning: typeof flags["credit-warning"] === "boolean" ? flags["credit-warning"] : undefined,
      }),
    },
    {
      id: "aib",
      component: "aib",
      cwd: targetPath,
      env: childEnvironment,
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
      env: childEnvironment,
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
      env: childEnvironment,
      args: buildAiuInitArgs(aiuTool, { dryRun: planOnly, force, scope: setup.umpire.scope }),
    },
  ]);

  const planInvocations = buildInvocations(true);
  const planResults = await Promise.all(planInvocations.map(invocation =>
    dispatchInitChild(invocation.component, invocation.args, environment, invocation.cwd, invocation.env)));
  const firstPlanFailureIndex = planResults.findIndex(result => !result.ok);
  const targetArgument = readString(args.target);
  const rawPostInitActions = Object.freeze(planResults.flatMap(result => childPostInitActions(result.json)));
  const rawProviderActions = Object.freeze(planResults.flatMap(result => childProviderActions(result.json)));
  const providerPrerequisitesReady = scope === "repository" && !prospectiveRoot && repositoryHasOrigin(targetPath);
  const postInitActions = Object.freeze(rawPostInitActions.map(action => initOwnedAction(action, scope, targetArgument, "pending")));
  const providerActions = Object.freeze(rawProviderActions.map(action => initOwnedAction(
    action,
    scope,
    targetArgument,
    providerPrerequisitesReady ? "planned" : "pending",
  )));
  const pendingExternalActions: Array<Readonly<Record<string, unknown>>> = [
    ...postInitActions,
    ...(!providerPrerequisitesReady ? providerActions : []),
  ];
  if (scope === "repository" && setup.workProviders[0] === "github" && !providerPrerequisitesReady) {
    pendingExternalActions.push(Object.freeze({
      id: "labels-setup",
      status: "pending",
      handledBy: "qube init",
      reason: "Repository labels require a configured origin remote and authenticated provider access.",
      nextAction: `Add the repository origin and authenticate the provider, then rerun \`${initRerunCommand(scope, targetArgument)}\`.`,
    }));
  }
  if (scope === "global" && reviewProvider === "github" && setup.review.publisher === "github-app") {
    pendingExternalActions.push(Object.freeze({
      id: "github-app-publisher-readiness",
      status: "pending",
      handledBy: "qube init",
      reason: "QUBE Reviewer App identity and installation access must be verified before readiness can be claimed.",
      nextAction: "Rerun `qube init --global` to continue Reviewer App onboarding and readiness checks.",
    }));
  }
  const plan = {
    scope,
    ...(scope === "repository" ? { target: targetPath } : {}),
    resolved: setup,
    sources: resolved.sources,
    deviations: resolved.deviations,
    components: planInvocations.map((invocation, index) => planRow(invocation, planResults[index]!)),
    providerActions,
    postInitActions,
    diagnosticActions: scope === "repository"
      ? Object.freeze([Object.freeze({
          id: "aggregate-diagnostics",
          status: "planned",
          reason: "Run aggregate QUBE diagnostics after local repository setup succeeds.",
        })])
      : Object.freeze([]),
    pendingExternalActions,
    packageRequirements,
    ...(scope === "repository" ? {
      git: {
        operation: prospectiveRoot ? "initialize" : "skip",
        status: prospectiveRoot ? (gitState?.gitAvailable ? "planned" : "unavailable") : "ready",
        baseBranch: "main",
        reason: gitState?.reason,
      },
    } : {}),
    config: {
      scope: configScope,
      path: selectedConfigPath,
      operation: configOperation,
    },
    ...(configuration ? { configuration } : {}),
  };
  const planChanged = prospectiveRoot || configOperation !== "skip" || planResults.some(result => childChanged(result.json));
  const planStderr = planResults.map(result => result.stderr ?? "").join("");
  if (firstPlanFailureIndex >= 0) {
    const failure = planResults[firstPlanFailureIndex]!;
    const failedAction = planInvocations[firstPlanFailureIndex]!.id;
    const nextAction = initComponentFailureNextAction(scope, targetArgument, failedAction, failure.nextAction);
    const payload = {
      ok: false,
      command: "init",
      mode: "plan",
      answers,
      plan,
      failedAction: publicInitActionLabel(failedAction),
      error: failure.error,
      nextAction,
    };
    return json
      ? { exitCode: failure.exitCode || 1, jsonStdout: `${JSON.stringify(payload)}\n`, stderr: planStderr }
      : {
          exitCode: failure.exitCode || 1,
          stdout: "",
          stderr: renderInitFailure({
            actionId: failedAction,
            reason: failure.error ?? "QUBE setup planning failed.",
            nextAction,
          }),
        };
  }

  if (dryRun) {
    const readiness = pendingExternalActions.length > 0 ? "pending" : "planned";
    const payload = { ok: true, command: "init", scope, mode: "plan", changed: planChanged, answers, plan, ...(configuration ? { configuration } : {}), readiness, pendingExternalActions };
    if (json) return { exitCode: 0, jsonStdout: `${JSON.stringify(payload)}\n`, stderr: planStderr };
    return {
      exitCode: 0,
      stdout: renderInitOutput({
        scope,
        mode: "plan",
        changed: planChanged,
        answers,
        ...(configuration ? { configuration } : {}),
        primaryHarness: primaryHarnessPrompt,
        pendingNextActions: pendingExternalActions.flatMap(action => typeof action.nextAction === "string" ? [action.nextAction] : []),
      }),
      stderr: "",
    };
  }

  if (planChanged && !json && !useDefaults && process.stdin.isTTY === true) {
    const approved = await promptConfirm({
      command: initCommand,
      promptName: `apply ${scope} QUBE initialization changes`,
      jsonMode: false,
      yes: false,
      clack: {
        message: `Apply the planned ${scope} QUBE initialization changes?`,
        initialValue: true,
      },
    });
    if (!approved) {
      const error = `${scope === "global" ? "Global" : "Repository"} initialization changes were declined; no changes were made.`;
      const nextAction = `Rerun \`${initRerunCommand(scope, targetArgument)}\` when you are ready to apply the plan.`;
      return {
        exitCode: 2,
        stdout: "",
        stderr: renderInitFailure({ actionId: "config", reason: error, nextAction }),
      };
    }
  }

  let gitInitialized = false;
  if (prospectiveRoot) {
    const gitUnavailable = gitState?.gitAvailable === false;
    if (gitUnavailable) {
      const error = "Git is required to initialize the selected repository target but is not available on PATH.";
      const nextAction = "Install Git, then rerun `qube init <target> --git-init`.";
      const payload = { ok: false, command: "init", scope, mode: "apply", changed: false, answers, plan, failedAction: "Git initialization", error, nextAction };
      return json
        ? { exitCode: 1, jsonStdout: `${JSON.stringify(payload)}\n`, stderr: planStderr }
        : { exitCode: 1, stdout: "", stderr: renderInitFailure({ actionId: "git", reason: error, nextAction }) };
    }
    let gitApproved = flags["git-init"] === true;
    if (!gitApproved && !json && !useDefaults) {
      gitApproved = await promptConfirm({
        command: initCommand,
        promptName: "initialize Git in the selected repository target",
        jsonMode: false,
        yes: false,
        clack: {
          message: `QUBE repository setup requires Git. Initialize Git in ${targetPath}?`,
          initialValue: true,
        },
      });
    }
    if (!gitApproved) {
      const error = json || useDefaults
        ? "Repository initialization outside Git requires --git-init in non-interactive mode."
        : "Git initialization was declined; no changes were made.";
      const nextAction = `Rerun \`qube init ${readString(args.target) ?? "."} --git-init\` when you are ready to initialize this repository.`;
      const payload = { ok: false, command: "init", scope, mode: "apply", changed: false, answers, plan, failedAction: "Git initialization", error, nextAction };
      return json
        ? { exitCode: 2, jsonStdout: `${JSON.stringify(payload)}\n`, stderr: planStderr }
        : { exitCode: 2, stdout: "", stderr: renderInitFailure({ actionId: "git", reason: error, nextAction }) };
    }
    const initialized = spawnSync("git", ["-C", targetPath, "init", "--initial-branch", "main"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (initialized.status !== 0) {
      const error = initialized.stderr.trim() || "Git initialization failed.";
      const nextAction = `Correct Git access for ${targetPath}, then rerun \`qube init ${readString(args.target) ?? "."} --git-init\`.`;
      const payload = { ok: false, command: "init", scope, mode: "apply", changed: false, answers, plan, failedAction: "Git initialization", error, nextAction };
      return json
        ? { exitCode: initialized.status || 1, jsonStdout: `${JSON.stringify(payload)}\n`, stderr: planStderr }
        : { exitCode: initialized.status || 1, stdout: "", stderr: renderInitFailure({ actionId: "git", reason: error, nextAction }) };
    }
    gitInitialized = true;
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
      const payload = { ok: false, command: "init", mode: "apply", answers, plan, apply, failedAction: publicInitActionLabel("config"), error: message, nextAction };
      return json
        ? { exitCode: 1, jsonStdout: `${JSON.stringify(payload)}\n`, stderr: planStderr }
        : { exitCode: 1, stdout: "", stderr: renderInitFailure({ actionId: "config", reason: message, nextAction }) };
    }
  }
  let failedApply: QubeInitChildResult | undefined;
  let failedApplyAction: QubeInitComponentId | undefined;
  for (const invocation of applyInvocations) {
    const result = await dispatchInitChild(invocation.component, invocation.args, environment, invocation.cwd, invocation.env);
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
      failedApplyAction = invocation.id;
      break;
    }
  }
  if (!failedApply && scope === "repository" && setup.workProviders[0] === "github" && providerPrerequisitesReady) {
    const invocation: QubeInitInvocation = {
      id: "labels",
      component: "aie",
      cwd: targetPath,
      args: Object.freeze(["labels", "setup", "--json"]),
    };
    const result = await dispatchInitChild(invocation.component, invocation.args, environment, invocation.cwd);
    if (result.stderr) applyStderr.push(result.stderr);
    const pendingFailure = !result.ok && deferredProviderFailure(result.error);
    applySteps.push({
      id: invocation.id,
      status: result.ok ? (childChanged(result.json) ? "changed" : "unchanged") : pendingFailure ? "pending" : "failed",
      exitCode: result.exitCode,
      ...(result.ok ? {} : { error: result.error, ...(result.nextAction ? { nextAction: result.nextAction } : {}) }),
      result: result.json,
    });
    if (pendingFailure) {
      pendingExternalActions.push(Object.freeze({
        id: "labels-setup",
        status: "pending",
        handledBy: "qube init",
        reason: result.error ?? "Repository provider prerequisites are not ready.",
        nextAction: `Rerun \`${initRerunCommand(scope, targetArgument)}\` after repository identity and authentication are ready.`,
      }));
    } else if (!result.ok) {
      failedApply = result;
      failedApplyAction = invocation.id;
    }
  }
  const changed = gitInitialized || configOperation !== "skip" || applySteps.some(step => step.status === "changed");
  let reviewPublisherReadiness: InitPublisherReadiness | undefined;
  if (!failedApply && reviewProvider === "github" && setup.review.publisher === "github-app") {
    const doctorCwd = scope === "global" ? homeDirectory(environment) : targetPath;
    const doctor = await dispatchInitChild("aie", ["review", "doctor", "--json"], environment, doctorCwd);
    if (doctor.stderr) applyStderr.push(doctor.stderr);
    const observedReadiness = publisherReadinessFromChild(doctor);
    reviewPublisherReadiness = observedReadiness.state === "ready"
      ? observedReadiness
      : Object.freeze({
          ...observedReadiness,
          nextAction: `Rerun \`${initRerunCommand(scope, targetArgument)}\` to continue Reviewer App onboarding and readiness checks.`,
        });
    const publisherPendingIndex = pendingExternalActions.findIndex(action => action.id === "github-app-publisher-readiness");
    if (observedReadiness.state === "ready" && publisherPendingIndex >= 0) {
      pendingExternalActions.splice(publisherPendingIndex, 1);
    } else if (observedReadiness.state !== "ready" && publisherPendingIndex < 0) {
      pendingExternalActions.push(Object.freeze({
        id: "github-app-publisher-readiness",
        status: "pending",
        handledBy: "qube init",
        reason: `Reviewer App readiness is ${observedReadiness.state}.`,
        nextAction: reviewPublisherReadiness.nextAction,
      }));
    }
  }
  let aggregateDiagnostics: InitAggregateDiagnostics | undefined;
  if (!failedApply && scope === "repository") {
    aggregateDiagnostics = await runInitAggregateDiagnostics(environment, targetPath, targetArgument);
  }
  const apply = {
    changed,
    steps: Object.freeze(applySteps),
    pendingExternalActions: Object.freeze([...pendingExternalActions]),
    ...(reviewPublisherReadiness ? { reviewPublisherReadiness } : {}),
    ...(aggregateDiagnostics ? { aggregateDiagnostics } : {}),
  };
  const stderr = `${planStderr}${applyStderr.join("")}`;
  if (failedApply) {
    const failedAction = failedApplyAction ?? "aie";
    const nextAction = initComponentFailureNextAction(scope, targetArgument, failedAction, failedApply.nextAction);
    const payload = {
      ok: false,
      command: "init",
      mode: "apply",
      answers,
      plan,
      ...(configuration ? { configuration } : {}),
      apply,
      failedAction: publicInitActionLabel(failedAction),
      error: failedApply.error,
      nextAction,
    };
    return json
      ? { exitCode: failedApply.exitCode || 1, jsonStdout: `${JSON.stringify(payload)}\n`, stderr }
      : {
          exitCode: failedApply.exitCode || 1,
          stdout: "",
          stderr: renderInitFailure({
            actionId: failedAction,
            reason: failedApply.error ?? "QUBE setup failed.",
            nextAction,
          }),
        };
  }

  const readiness = pendingExternalActions.length > 0 || aggregateDiagnostics?.status === "attention" ? "pending" : "ready";
  const payload = { ok: true, command: "init", scope, mode: "apply", changed, answers, plan, ...(configuration ? { configuration } : {}), apply, readiness, pendingExternalActions };
  if (json) return { exitCode: 0, jsonStdout: `${JSON.stringify(payload)}\n`, stderr };
  return {
    exitCode: 0,
    stdout: renderInitOutput({
      scope,
      mode: "apply",
      changed,
      answers,
      ...(configuration ? { configuration } : {}),
      primaryHarness: primaryHarnessPrompt,
      pendingNextActions: [
        ...pendingExternalActions.flatMap(action => typeof action.nextAction === "string" ? [action.nextAction] : []),
        ...(aggregateDiagnostics?.nextAction ? [aggregateDiagnostics.nextAction] : []),
      ],
      ...(reviewPublisherReadiness ? { reviewPublisherReadiness } : {}),
    }),
    stderr: "",
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
      cwd: environment.cwd,
      env: environment.env,
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
  return ["qube", component, ...args].map(value => quoteShellArgument(value)).join(" ");
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

function installCompatibilityPayload(): Readonly<Record<string, unknown>> {
  const npmCommand = `npm install --global --ignore-scripts ${packageName}@${packageVersion}`;
  const pnpmCommand = `pnpm add --global --ignore-scripts ${packageName}@${packageVersion}`;
  return Object.freeze({
    ok: true,
    command: "install",
    mode: "migration",
    changed: false,
    packageInstallation: Object.freeze({
      owner: "package-manager",
      commands: Object.freeze([npmCommand, pnpmCommand]),
    }),
    setupCommand: "qube init",
    nextAction: "Install QUBE with npm or pnpm when needed, then run `qube init` for all QUBE setup and resume work.",
  });
}

function renderInstallCompatibility(): string {
  const payload = installCompatibilityPayload() as {
    readonly packageInstallation: { readonly commands: readonly string[] };
    readonly nextAction: string;
  };
  return [
    "QUBE package installation is now owned by npm or pnpm.",
    "",
    "Package installation:",
    ...payload.packageInstallation.commands.map(command => `  ${command}`),
    "",
    "QUBE setup:",
    "  qube init",
    "",
    "No package, configuration, provider, or repository changes were made.",
    `Next action: ${payload.nextAction}`,
    "",
  ].join("\n");
}

async function executeQubeInstall(flags: Readonly<Record<string, unknown>>): Promise<RuntimeCommandResult> {
  const compatibility = installCompatibilityPayload();
  const { ok: _ok, command: _command, ...result } = compatibility;
  void _ok;
  void _command;
  return flags.json === true
    ? { json: result }
    : { stdout: renderInstallCompatibility() };
}
function planQubeInstall(args: readonly string[]): CliExecution {
  const unsupported = args.filter(argument => argument !== "--json" && argument !== "--help" && argument !== "-h");
  if (unsupported.length > 0) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `QUBE install no longer accepts setup flags (${unsupported.join(", ")}). Install QUBE with npm or pnpm, then run qube init.\n`,
    };
  }
  const json = args.includes("--json");
  return json
    ? { exitCode: 0, stdout: `${JSON.stringify(installCompatibilityPayload())}\n`, stderr: "" }
    : { exitCode: 0, stdout: renderInstallCompatibility(), stderr: "" };
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
    if (token === "--global") {
      flags.global = true;
      continue;
    }
    if (token === "--git-init") {
      flags["git-init"] = true;
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
  options: { readonly translateJson?: boolean; readonly supportsJson?: boolean; readonly passthroughJson?: boolean; readonly qubePrimaryHelp?: boolean; readonly ttyPrompt?: boolean } = {}
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
        ttyPrompt: options.ttyPrompt === true
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

function readOption<Value extends string>(flags: Readonly<Record<string, unknown>>, key: string): Value | undefined {
  const value = flags[key];
  return typeof value === "string" ? value as Value : undefined;
}

function splitCsvOption(value: string): readonly string[] {
  return Object.freeze(value.split(",").map(token => token.trim()).filter(token => token.length > 0));
}

function readOptionList<Value extends string>(flags: Readonly<Record<string, unknown>>, key: string): readonly Value[] | undefined {
  const value = flags[key];
  const values = typeof value === "string"
    ? [value]
    : Array.isArray(value) && value.every(entry => typeof entry === "string")
      ? value as string[]
      : [];
  const tokens = values.flatMap(splitCsvOption) as unknown as readonly Value[];
  return tokens.length > 0 ? tokens : undefined;
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
    env: request.env,
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
