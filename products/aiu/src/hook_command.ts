import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { resolveTrustedCommandExecutable } from "./trusted_adapter.js";

export type AiuRepositoryPackageManager = "npm" | "pnpm";

export interface AiuHookCommandResolution {
  readonly commandPrefix: string;
  readonly source: "package-local" | "package-manager";
  readonly packageManager: AiuRepositoryPackageManager;
}

export function resolveAiuHookCommand(repoRoot: string, env: NodeJS.ProcessEnv = process.env): AiuHookCommandResolution {
  const packageManager = detectRepositoryPackageManager(repoRoot, env);
  const localBin = resolveLocalAiuBin(repoRoot, env);
  if (localBin) {
    const relativeBin = path.relative(repoRoot, localBin);
    const portableBin = relativeBin.startsWith(".") ? relativeBin : `.${path.sep}${relativeBin}`;
    return Object.freeze({
      commandPrefix: quoteShellWord(portableBin),
      source: "package-local" as const,
      packageManager,
    });
  }
  return Object.freeze({
    commandPrefix: packageManager === "pnpm" ? "pnpm exec aiu" : "npm exec -- aiu",
    source: "package-manager" as const,
    packageManager,
  });
}

export function detectRepositoryPackageManager(repoRoot: string, env: NodeJS.ProcessEnv = process.env): AiuRepositoryPackageManager {
  if (existsSync(path.join(repoRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(repoRoot, "package-lock.json"))) return "npm";
  try {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as unknown;
    if (isRecord(manifest) && typeof manifest.packageManager === "string") {
      if (manifest.packageManager.startsWith("pnpm@")) return "pnpm";
      if (manifest.packageManager.startsWith("npm@")) return "npm";
    }
  } catch {
    // Environment selection remains the bounded fallback when no repository manifest is readable.
  }
  return env.npm_config_user_agent?.startsWith("pnpm/") ? "pnpm" : "npm";
}

function resolveLocalAiuBin(repoRoot: string, env: NodeJS.ProcessEnv): string | undefined {
  const binDirectory = path.join(repoRoot, "node_modules", ".bin");
  const names = process.platform === "win32" ? ["aiu.cmd", "aiu.exe", "aiu"] : ["aiu"];
  for (const name of names) {
    const candidate = path.join(binDirectory, name);
    if (existsSync(candidate)) return candidate;
  }
  const resolved = resolveTrustedCommandExecutable("aiu", repoRoot, env);
  return resolved && isSameOrChildPath(resolved, binDirectory) ? resolved : undefined;
}

function quoteShellWord(value: string): string {
  if (/^[A-Za-z0-9_./:\\-]+$/u.test(value)) return value;
  return `"${value.replace(/(["\\])/gu, "\\$1")}"`;
}

function isSameOrChildPath(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizePath(candidate);
  const normalizedRoot = normalizePath(root);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
