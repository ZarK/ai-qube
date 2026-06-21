import { spawn } from "node:child_process";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineInstallerChoiceGroup, promptInstallerChoice, type InstallerChoiceGroup } from "@tjalve/qube-cli/installer";
import { defineArgument, defineCommand, defineExtensions, defineFlag } from "@tjalve/qube-cli/metadata";
import { createCommandRegistry } from "@tjalve/qube-cli/registry";
import { createCli, createCommand as createRuntimeCommand, createSchemaCommand, runCli, type RuntimeCommandResult } from "@tjalve/qube-cli/runtime";

import { findQubeComponent, qubeComponents, type QubeComponent } from "./components.js";
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
  description: "Print the install plan and commands without running package-manager commands.",
  type: "boolean"
});
const yesFlag = defineFlag({
  name: "yes",
  short: "y",
  description: "Use safe defaults for non-interactive installer decisions.",
  type: "boolean"
});

type InstallScope = "local" | "global";
type InstallPackageManager = "pnpm" | "npm";
type InstallHost = "generic" | "codex" | "opencode" | "claude-code";
type InstallWorkProvider = "github" | "local";
type InstallLifecycleScripts = "disabled" | "review";
type InstallMigration = "none" | "standalone-globals";
type YesNo = "yes" | "no";

interface InstallSelections {
  readonly scope: InstallScope;
  readonly packageManager: InstallPackageManager;
  readonly host: InstallHost;
  readonly workProvider: InstallWorkProvider;
  readonly lifecycleScripts: InstallLifecycleScripts;
  readonly docs: boolean;
  readonly migration: InstallMigration;
}

interface InstallCommandStep {
  readonly label: string;
  readonly command: string;
}

interface InstallPlan {
  readonly package: {
    readonly name: string;
    readonly version: string;
  };
  readonly selections: InstallSelections;
  readonly mode: "copy-commands";
  readonly dryRun: boolean;
  readonly commands: readonly InstallCommandStep[];
  readonly files: readonly string[];
  readonly notes: readonly string[];
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
const hostChoices = defineInstallerChoiceGroup({
  name: "host surface",
  message: "Which host surface should the install notes target?",
  defaultValue: "generic",
  choices: [
    {
      value: "generic",
      label: "Generic terminal",
      description: "No host-specific setup assumptions.",
      recommended: true
    },
    {
      value: "codex",
      label: "Codex",
      description: "Preserve AGENTS.md policy precedence and local todo expectations."
    },
    {
      value: "opencode",
      label: "OpenCode",
      description: "Use OpenCode commands and instruction files when a component init creates them."
    },
    {
      value: "claude-code",
      label: "Claude Code",
      description: "Keep Claude Code behavior separate from OpenCode and Codex."
    }
  ]
});
const workProviderChoices = defineInstallerChoiceGroup({
  name: "work provider",
  message: "Which work provider should the notes target?",
  defaultValue: "github",
  choices: [
    {
      value: "github",
      label: "GitHub",
      description: "Use GitHub issues, pull requests, and checks for issue-driven work.",
      recommended: true
    },
    {
      value: "local",
      label: "Local only",
      description: "Install QUBE without assuming a forge-backed work provider."
    }
  ]
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
      description: "Host surface to mention in setup notes.",
      type: "option",
      options: ["generic", "codex", "opencode", "claude-code"]
    }),
    defineFlag({
      name: "work-provider",
      description: "Work provider to mention in setup notes.",
      type: "option",
      options: ["github", "local"]
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

interface DirectQubeCommand {
  readonly command: ReturnType<typeof defineCommand>;
  readonly component: QubeComponent["command"];
  readonly supportsJson: boolean;
  readonly mapArgs: (args: readonly string[]) => readonly string[];
}

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
  createDirectCommand("review", "Show Executor review helpers.", "aie", "review", { supportsJson: false }),
  createDirectCommand("review gate", "Render configured review-agent gate prompts.", "aie", "review gate"),
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
  createDirectCommand("doctor", "Run Quality Control diagnostics.", "aiq", "doctor", { translateJson: true }),
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

let runtimeRegistry = createCommandRegistry({ commands: [componentsCommand, installCommand, ...directCommands, runCommand, ...componentCommands] });

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

function translateJsonFlag(args: readonly string[]): readonly string[] {
  return args.flatMap(arg => arg === "--json" ? ["--format", "json"] : [arg]);
}

async function executeDirectCommand(definition: DirectQubeCommand, args: readonly string[], environment: CliEnvironment): Promise<RuntimeCommandResult> {
  const mapped = mapDirectArgs(definition, args);
  if ("error" in mapped) {
    return { exitCode: mapped.error.exitCode, stdout: mapped.error.stdout, stderr: mapped.error.stderr };
  }
  return executeQubeDispatch(definition.component, mapped.args, environment);
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
  options: { readonly translateJson?: boolean; readonly supportsJson?: boolean } = {}
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
  const lifecycleScripts = await resolveInstallChoice(lifecycleChoices, readOption<InstallLifecycleScripts>(flags, "lifecycle-scripts"), flags);
  const docsValue = await resolveInstallChoice(docsChoices, readDocsFlag(flags), flags);
  const migration = await resolveInstallChoice(migrationChoices, readOption<InstallMigration>(flags, "migration"), flags);
  return {
    scope,
    packageManager,
    host,
    workProvider,
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
    mode: "copy-commands",
    dryRun,
    commands: createInstallCommands(selections),
    files: createInstallFiles(selections),
    notes: createInstallNotes(selections)
  };
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
    files.push("AGENTS.md policy notes");
  }
  if (selections.host === "opencode") {
    files.push(".opencode command notes");
  }
  if (selections.workProvider === "github") {
    files.push(".qube/aie/config.json provider notes");
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
  if (selections.workProvider === "github") {
    notes.push("GitHub-backed issue work remains owned by Executor commands after installation.");
  } else {
    notes.push("Local-only setup does not configure forge-backed issue or pull request workflows.");
  }
  if (selections.migration === "standalone-globals") {
    notes.push("After QUBE is verified, remove stale standalone global commands only after confirming no workflow still depends on them.");
  }
  return notes;
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
    `Lifecycle scripts: ${plan.selections.lifecycleScripts}`,
    `Docs/config notes: ${plan.selections.docs ? "included" : "omitted"}`,
    `Migration path: ${plan.selections.migration}`,
    "",
    "Commands to run:",
    ...plan.commands.flatMap((step, index) => [`${index + 1}. ${step.label}`, `   ${step.command}`]),
    "",
    "Notes:",
    ...plan.notes.map(note => `- ${note}`),
    ...(plan.files.length > 0 ? ["", "Docs/config notes to add:", ...plan.files.map(file => `- ${file}`)] : []),
    "",
    "No commands were run.",
    ""
  ].join("\n");
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
  return ["scope", "package-manager", "host", "work-provider", "lifecycle-scripts", "migration"].every(key => typeof flags[key] === "string")
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
  for (const key of ["scope", "package-manager", "host", "work-provider", "lifecycle-scripts", "migration"]) {
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

function spawnInput(request: DispatchRequest): [string, string[]] {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(request.commandPath)) {
    return [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", request.commandPath, ...request.args]];
  }
  return [request.commandPath, [...request.args]];
}
