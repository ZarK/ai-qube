import { spawn } from "node:child_process";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const componentsCommand = defineCommand({
  kind: "command",
  name: "components",
  description: "List QUBE component packages and commands.",
  flags: [
    defineFlag({
      name: "json",
      description: "Render machine-readable JSON output.",
      type: "boolean"
    })
  ],
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
      description: "Run AIB status through QUBE.",
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
  aliases: component.id === component.command ? [] : [component.id],
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

let runtimeRegistry = createCommandRegistry({ commands: [componentsCommand, runCommand, ...componentCommands] });

export function planQubeCli(input: readonly string[], environment: CliEnvironment = defaultEnvironment()): CliExecution {
  const args = [...input];
  if (args[0] === "components") {
    if (args.includes("--json")) {
      return { exitCode: 0, stdout: `${JSON.stringify({ ok: true, command: "components", components: qubeComponents })}\n`, stderr: "" };
    }
    return { exitCode: 0, stdout: renderComponents(), stderr: "" };
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
          components: qubeComponents
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
