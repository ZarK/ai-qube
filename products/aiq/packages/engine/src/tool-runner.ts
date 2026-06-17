import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { createCacheService } from "./cache.js";
import type { CacheService } from "./contracts.js";

const execFileAsync = promisify(execFile);

type ExecFileError = NodeJS.ErrnoException & {
  code?: number | string;
  signal?: NodeJS.Signals | null;
  stderr?: string;
  stdout?: string;
};

export interface ToolRunOutcome {
  durationMs: number;
  exitCode: number | undefined;
  finishedAt: string;
  startedAt: string;
  stderr: string;
  stdout: string;
}

export interface ToolRunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  signal?: AbortSignal;
}

export class ToolRunner {
  constructor(private readonly cache: CacheService = createCacheService()) {}

  async run(command: string, args: string[], options: ToolRunOptions): Promise<ToolRunOutcome> {
    const startedAt = new Date();
    const maxBuffer = options.maxBuffer ?? 10 * 1024 * 1024;

    try {
      const execOptions: {
        cwd: string;
        encoding: "utf8";
        env?: NodeJS.ProcessEnv;
        maxBuffer: number;
        signal?: AbortSignal;
        windowsVerbatimArguments?: boolean;
      } = {
        cwd: options.cwd,
        encoding: "utf8",
        maxBuffer,
      };

      if (options.env !== undefined) {
        execOptions.env = {
          ...process.env,
          ...options.env,
        };
      }

      if (options.signal !== undefined) {
        execOptions.signal = options.signal;
      }

      const invocation = this.createExecFileInvocation(command, args);
      if (invocation.windowsVerbatimArguments) {
        execOptions.windowsVerbatimArguments = true;
      }
      const result = await execFileAsync(invocation.command, invocation.args, execOptions);
      const finishedAt = new Date();

      return {
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        exitCode: 0,
        finishedAt: finishedAt.toISOString(),
        startedAt: startedAt.toISOString(),
        stderr: result.stderr,
        stdout: result.stdout,
      };
    } catch (error) {
      if (this.isExecFileError(error)) {
        if (
          this.isAbortError(error) ||
          this.hasExecFileSignal(error) ||
          !this.isExpectedExecFileFailure(error)
        ) {
          throw error;
        }

        const finishedAt = new Date();

        return {
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          exitCode: typeof error.code === "number" ? error.code : undefined,
          finishedAt: finishedAt.toISOString(),
          startedAt: startedAt.toISOString(),
          stderr: typeof error.stderr === "string" ? error.stderr : "",
          stdout: typeof error.stdout === "string" ? error.stdout : "",
        };
      }

      throw error;
    }
  }

  async runNodeTool(
    scriptPath: string,
    args: string[],
    cwd: string,
    signal?: AbortSignal,
  ): Promise<ToolRunOutcome> {
    const options: ToolRunOptions = { cwd };
    if (signal !== undefined) {
      options.signal = signal;
    }
    return this.run(process.execPath, [scriptPath, ...args], options);
  }

  async resolveBinaryIfAvailable(commandNames: readonly string[]): Promise<string | undefined> {
    for (const commandName of commandNames) {
      const installedBinary = await this.resolveInstalledBinary(commandName);
      if (installedBinary !== undefined) {
        return installedBinary;
      }

      const lookupCommand = process.platform === "win32" ? "where" : "which";
      const outcome = await this.run(lookupCommand, [commandName], {
        cwd: process.cwd(),
      });
      if (outcome.exitCode === 0) {
        const resolved = this.selectResolvedCommandPath(outcome.stdout, commandName);
        if (resolved !== undefined) {
          return resolved;
        }

        return commandName;
      }
    }

    return undefined;
  }

  async resolveRequiredBinary(
    commandNames: readonly string[],
    toolName: string,
    installMessage: string,
  ): Promise<string> {
    const resolved = await this.resolveBinaryIfAvailable(commandNames);
    if (resolved !== undefined) {
      return resolved;
    }

    throw new Error(`${toolName} was not detected. ${installMessage}`);
  }

  async resolveInstalledBinary(commandName: string): Promise<string | undefined> {
    const cacheKey = this.cache.generateKey(["infrastructure", "binary", commandName]);
    const cached = await this.cache.getOrCreate(cacheKey, async () => {
      const asdfCommand = process.platform === "win32" ? "asdf.cmd" : "asdf";

      let result: ToolRunOutcome;
      try {
        result = await this.run(asdfCommand, ["which", commandName], {
          cwd: process.cwd(),
        });
      } catch (error) {
        if (this.isAbortError(error)) {
          throw error;
        }

        if (this.isLookupCommandFailure(error)) {
          return undefined;
        }

        throw error;
      }
      if (result.exitCode !== 0) {
        return undefined;
      }

      const resolvedPath = result.stdout.trim();
      return resolvedPath.length > 0 ? resolvedPath : undefined;
    });

    return cached.value;
  }

  async createRustProcessEnv(): Promise<NodeJS.ProcessEnv | undefined> {
    const cargoPath = await this.resolveInstalledBinary("cargo");
    const rustcPath = await this.resolveInstalledBinary("rustc");
    const cargoBin = cargoPath === undefined ? undefined : path.dirname(cargoPath);
    const rustcBin = rustcPath === undefined ? undefined : path.dirname(rustcPath);
    const homeCargoBin = path.join(os.homedir(), ".cargo", "bin");
    const pathEntries = [cargoBin, rustcBin, homeCargoBin].filter(
      (entry): entry is string => entry !== undefined && entry.length > 0,
    );

    if (pathEntries.length === 0) {
      return undefined;
    }

    const existingPath = process.env.PATH ?? "";
    const deduplicatedPathEntries = Array.from(new Set(pathEntries));
    const derivedAsdfRustVersion =
      cargoPath === undefined
        ? undefined
        : /^.*[\\/]\.asdf[\\/]installs[\\/]rust[\\/](.+?)[\\/]bin[\\/][^\\/]+$/u.exec(
            cargoPath,
          )?.[1];

    return {
      ...(process.env.ASDF_RUST_VERSION === undefined && derivedAsdfRustVersion === undefined
        ? {}
        : { ASDF_RUST_VERSION: process.env.ASDF_RUST_VERSION ?? derivedAsdfRustVersion }),
      PATH:
        existingPath.length > 0
          ? `${deduplicatedPathEntries.join(path.delimiter)}${path.delimiter}${existingPath}`
          : deduplicatedPathEntries.join(path.delimiter),
    };
  }

  async createJvmProcessEnv(): Promise<NodeJS.ProcessEnv | undefined> {
    const javaPath = await this.resolveInstalledBinary("java");
    if (javaPath === undefined) {
      return undefined;
    }

    const javaHome = path.dirname(path.dirname(javaPath));
    const javaBin = path.dirname(javaPath);
    const existingPath = process.env.PATH ?? "";

    return {
      JAVA_HOME: javaHome,
      PATH: existingPath.length > 0 ? `${javaBin}${path.delimiter}${existingPath}` : javaBin,
    };
  }

  async resolvePowerShellModuleManifest(moduleName: string): Promise<string | undefined> {
    const cacheKey = this.cache.generateKey(["infrastructure", "powershell-module", moduleName]);
    const cached = await this.cache.getOrCreate(cacheKey, async () => {
      const powerShellCommand = await this.resolveBinaryIfAvailable(
        process.platform === "win32"
          ? ["pwsh.exe", "pwsh", "powershell.exe", "powershell"]
          : ["pwsh"],
      );
      if (powerShellCommand === undefined) {
        return undefined;
      }

      const script = [
        "$ErrorActionPreference = 'Stop'",
        `$module = Get-Module -ListAvailable -Name ${this.toPowerShellStringLiteral(moduleName)} |`,
        "  Sort-Object Version -Descending |",
        "  Select-Object -First 1",
        "if ($null -ne $module) { $module.Path }",
        "",
      ].join("\n");
      const outcome = await this.run(
        powerShellCommand,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          script,
        ],
        { cwd: process.cwd() },
      );
      if (outcome.exitCode !== 0) {
        return undefined;
      }

      const resolvedPath = outcome.stdout.trim();
      return resolvedPath.length > 0 ? resolvedPath : undefined;
    });

    return cached.value;
  }

  async resolveRequiredPowerShellModuleManifest(moduleName: string): Promise<string> {
    const moduleManifestPath = await this.resolvePowerShellModuleManifest(moduleName);
    if (moduleManifestPath !== undefined) {
      return moduleManifestPath;
    }

    throw new Error(
      `${moduleName} was not detected. Install ${moduleName} to enable this PowerShell stage.`,
    );
  }

  async runPowerShellScript(
    script: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<ToolRunOutcome> {
    const powerShellCommand = await this.resolveRequiredBinary(
      process.platform === "win32"
        ? ["pwsh.exe", "pwsh", "powershell.exe", "powershell"]
        : ["pwsh"],
      "PowerShell",
      "Install PowerShell to enable PowerShell lint, format, and test stages.",
    );
    const options: ToolRunOptions = { cwd };
    if (signal !== undefined) {
      options.signal = signal;
    }
    return this.run(
      powerShellCommand,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      options,
    );
  }

  readProcessFailureMessage(
    toolName: string,
    stderr: string,
    stdout: string,
    exitCode: number | undefined,
  ): string {
    if (exitCode === undefined) {
      return `${toolName} was not detected. Run aiq setup for required setup steps.`;
    }

    const combined = this.joinOutputs(stderr, stdout).trim();
    if (combined.length > 0) {
      return combined;
    }

    return `${toolName} exited with code ${exitCode}.`;
  }

  joinOutputs(...values: string[]): string {
    return values.filter((value) => value.trim().length > 0).join("\n");
  }

  isMissingCommandOutcome(stderr: string, stdout: string, exitCode: number | undefined): boolean {
    if (exitCode === undefined) {
      return true;
    }

    const combined = this.joinOutputs(stderr, stdout).toLowerCase();
    return (
      exitCode !== 0 &&
      (combined.includes("command not found") ||
        combined.includes("no such file or directory") ||
        combined.includes("not recognized as the name of a cmdlet") ||
        combined.includes("cannot find the file specified"))
    );
  }

  isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
  }

  toPowerShellStringLiteral(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
  }

  private isExecFileError(error: unknown): error is ExecFileError {
    return (
      typeof error === "object" &&
      error !== null &&
      ("stdout" in error || "stderr" in error || "code" in error || "signal" in error)
    );
  }

  private hasExecFileSignal(error: ExecFileError): boolean {
    return typeof error.signal === "string" && error.signal.length > 0;
  }

  private isExpectedExecFileFailure(error: ExecFileError): boolean {
    return typeof error.code === "number" || error.code === "ENOENT" || error.code === "EFTYPE";
  }

  private isLookupCommandFailure(error: unknown): boolean {
    if (!this.isExecFileError(error) || this.hasExecFileSignal(error)) {
      return false;
    }

    return error.code === "ENOENT" || error.code === "EINVAL";
  }

  private requiresWindowsCommandShell(command: string): boolean {
    return process.platform === "win32" && /\.(?:bat|cmd)$/iu.test(command);
  }

  private selectResolvedCommandPath(stdout: string, commandName: string): string | undefined {
    const resolved = stdout
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

    if (process.platform !== "win32") {
      return resolved[0];
    }

    return (
      resolved.find((value) => this.hasWindowsExecutableExtension(value)) ??
      resolved.find((value) => path.basename(value).toLowerCase() === commandName.toLowerCase()) ??
      resolved[0]
    );
  }

  private hasWindowsExecutableExtension(command: string): boolean {
    return /\.(?:bat|cmd|com|exe)$/iu.test(command);
  }

  private createExecFileInvocation(
    command: string,
    args: string[],
  ): { args: string[]; command: string; windowsVerbatimArguments?: boolean } {
    if (!this.requiresWindowsCommandShell(command)) {
      return { args, command };
    }

    return {
      args: [
        "/d",
        "/s",
        "/c",
        [
          "call",
          this.quoteWindowsCommandArgument(command),
          ...args.map((arg) => this.quoteWindowsCommandArgument(arg)),
        ].join(" "),
      ],
      command: process.env.ComSpec ?? "cmd.exe",
      windowsVerbatimArguments: true,
    };
  }

  private quoteWindowsCommandArgument(value: string): string {
    const escaped = value
      .replaceAll("%", "^%")
      .replaceAll('"', '""')
      .replaceAll("\r", "")
      .replaceAll("\n", "");
    return `"${escaped}"`;
  }
}

export const toolRunner = new ToolRunner();
