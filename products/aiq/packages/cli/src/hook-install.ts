import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function renderPreCommitHookScript(entryPoint: string): string {
  if (!path.isAbsolute(entryPoint))
    throw new Error("The Quality entry point must be an absolute path.");
  return [
    "#!/usr/bin/env sh",
    "set -eu",
    `exec node ${quoteShell(entryPoint.replaceAll("\\", "/"))} hook run "$@"`,
    "",
  ].join("\n");
}

export async function installPreCommitHook(cwd: string, entryPoint: string): Promise<string> {
  const root = await gitPath(cwd, "--show-toplevel");
  const hooks = await gitPath(root, "--git-path", "hooks");
  const common = await gitPath(root, "--git-common-dir");
  const [realRoot, realHooks, realCommon] = await Promise.all([
    realpath(root),
    resolvePhysicalPath(hooks),
    realpath(common),
  ]);
  if (!isWithin(realRoot, realHooks) && !isWithin(realCommon, realHooks)) {
    throw new Error(`Refusing to install a hook outside the repository: ${hooks}`);
  }
  const target = path.join(realHooks, "pre-commit");
  const script = renderPreCommitHookScript(await realpath(entryPoint));
  await mkdir(realHooks, { recursive: true });
  if (await checkExistingHook(target, script)) return target;
  await writeFile(target, script, { flag: "wx", mode: 0o755 });
  await chmod(target, 0o755);
  return target;
}

async function checkExistingHook(target: string, script: string): Promise<boolean> {
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || (await readFile(target, "utf8")) !== script) {
      throw new Error(
        `A different pre-commit hook already exists: ${target}. Keep it or remove it before installing Quality.`,
      );
    }
    await chmod(target, 0o755);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function gitPath(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", ...args], {
    cwd,
    encoding: "utf8",
  });
  return path.resolve(cwd, stdout.trim());
}

async function resolvePhysicalPath(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch (error) {
    if (!isMissing(error)) throw error;
    return path.join(await resolvePhysicalPath(path.dirname(target)), path.basename(target));
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
