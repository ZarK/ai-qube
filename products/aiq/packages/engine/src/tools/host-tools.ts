import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

import { resolvePythonCommand } from "./binary-resolver.js";

export async function resolvePathCommand(command: string): Promise<string | undefined> {
  const extensions =
    process.platform === "win32" && path.extname(command) === ""
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (directory.length === 0) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = path.resolve(directory.replace(/^"|"$/gu, ""), `${command}${extension}`);
      try {
        await access(candidate, constants.X_OK);
        if ((await stat(candidate)).isFile()) {
          return candidate;
        }
      } catch {
        // Continue through the executable search path.
      }
    }
  }
  return undefined;
}

export async function requirePathCommand(command: string): Promise<string> {
  const resolved = await resolvePathCommand(command);
  if (resolved === undefined) {
    throw new Error(`${command} was not detected on PATH. Run aiq setup for required setup steps.`);
  }
  return resolved;
}

export async function resolvePythonInterpreter(): Promise<string> {
  return requirePathCommand(resolvePythonCommand());
}
