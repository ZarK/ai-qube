import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

export function resolvePackageBinaryPath(
  packageJsonSpecifier: string,
  relativeBinaryPath: string,
): string {
  try {
    const packageJsonPath = require.resolve(packageJsonSpecifier);
    return path.resolve(path.dirname(packageJsonPath), relativeBinaryPath);
  } catch {
    const packageName = packageJsonSpecifier.replace(/\/package\.json$/u, "");
    throw new Error(
      `Required tool dependency '${packageName}' is not installed or cannot be resolved from the engine package.`,
    );
  }
}

export function resolveNpmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function resolveMavenCommand(): string {
  return process.platform === "win32" ? "mvn.cmd" : "mvn";
}

export function resolveGradleCommand(): string {
  return process.platform === "win32" ? "gradle.bat" : "gradle";
}

export function resolveUvxCommand(): string {
  return process.platform === "win32" ? "uvx.exe" : "uvx";
}

export function resolveUvCommand(): string {
  return process.platform === "win32" ? "uv.exe" : "uv";
}

export function resolvePythonCommand(): string {
  return process.platform === "win32" ? "python" : "python3";
}

export function resolveTyCommand(): string {
  return process.platform === "win32" ? "ty.exe" : "ty";
}

export function resolveDotNetCommand(): string {
  return process.platform === "win32" ? "dotnet.exe" : "dotnet";
}

export async function resolveGoBinary(commandName: "go" | "gofmt"): Promise<string> {
  const { toolRunner } = await import("../tool-runner.js");
  return (
    (await toolRunner.resolveInstalledBinary(commandName)) ??
    (process.platform === "win32" ? `${commandName}.exe` : commandName)
  );
}

export async function resolveRustBinary(commandName: "cargo"): Promise<string> {
  const { toolRunner } = await import("../tool-runner.js");
  return (
    (await toolRunner.resolveInstalledBinary(commandName)) ??
    (process.platform === "win32" ? `${commandName}.exe` : commandName)
  );
}
