import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

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
  readonly args: readonly string[];
}

export interface CliEnvironment {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

const helpText = `${packageName} ${packageVersion}

${packageDescription}

Usage:
  qube components [--json]
  qube run <component> [-- <args...>]
  qube <component> [args...]
  qube --version [--json]

Components:
${qubeComponents.map(component => `  ${component.command.padEnd(4)} ${component.packageName.padEnd(13)} ${component.summary}`).join("\n")}
`;

export function planQubeCli(input: readonly string[], environment: CliEnvironment = defaultEnvironment()): CliExecution {
  const args = [...input];
  if (args.length === 0 || args.includes("--help") || args[0] === "help") {
    return { exitCode: 0, stdout: helpText, stderr: "" };
  }

  if (isVersionRequest(args)) {
    if (args.includes("--json")) {
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({ ok: true, command: "version", package: { name: packageName, version: packageVersion }, version: packageVersion })}\n`,
        stderr: ""
      };
    }
    return { exitCode: 0, stdout: `${packageVersion}\n`, stderr: "" };
  }

  if (args[0] === "components") {
    if (args.includes("--json")) {
      return { exitCode: 0, stdout: `${JSON.stringify({ ok: true, command: "components", components: qubeComponents })}\n`, stderr: "" };
    }
    return { exitCode: 0, stdout: renderComponents(), stderr: "" };
  }

  const dispatchInput = args[0] === "run" ? args.slice(1) : args;
  const [componentName, ...componentArgs] = dispatchInput;
  if (!componentName) {
    return { exitCode: 2, stdout: "", stderr: "Missing component. Run qube components to list available tools.\n" };
  }

  const component = findQubeComponent(componentName);
  if (!component) {
    return { exitCode: 2, stdout: "", stderr: `Unknown QUBE component: ${componentName}\nRun qube components to list available tools.\n` };
  }

  const commandPath = resolveCommand(component.command, environment);
  if (!commandPath) {
    return {
      exitCode: 4,
      stdout: "",
      stderr: `Cannot find ${component.command} for ${component.packageName}.\nInstall the standalone package or run from a workspace where ${component.command} is on PATH.\n`
    };
  }

  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    dispatch: {
      component,
      commandPath,
      args: stripSeparator(componentArgs)
    }
  };
}

export async function runQubeCli(input: readonly string[] = process.argv.slice(2)): Promise<number> {
  const planned = planQubeCli(input);
  if (planned.stdout.length > 0) process.stdout.write(planned.stdout);
  if (planned.stderr.length > 0) process.stderr.write(planned.stderr);
  if (!planned.dispatch) {
    process.exitCode = planned.exitCode === 0 ? process.exitCode : planned.exitCode;
    return planned.exitCode;
  }

  const exitCode = await dispatchCommand(planned.dispatch);
  process.exitCode = exitCode === 0 ? process.exitCode : exitCode;
  return exitCode;
}

export function resolveCommand(command: string, environment: CliEnvironment = defaultEnvironment()): string | undefined {
  const pathEntries = [
    path.join(environment.cwd, "node_modules", ".bin"),
    ...(environment.env.PATH ?? "").split(path.delimiter).filter(entry => entry.length > 0)
  ];
  for (const entry of pathEntries) {
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

function isVersionRequest(args: readonly string[]): boolean {
  return args.every(arg => arg === "--version" || arg === "-v" || arg === "--json") && args.some(arg => arg === "--version" || arg === "-v");
}

function stripSeparator(args: readonly string[]): readonly string[] {
  return args[0] === "--" ? args.slice(1) : args;
}

function renderComponents(): string {
  return `${qubeComponents.map(component => `${component.command}\t${component.packageName}\t${component.summary}`).join("\n")}\n`;
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
