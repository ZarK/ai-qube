import { access } from "node:fs/promises";
import path from "node:path";

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function findNearestConfig(
  filePath: string,
  fileName: string,
): Promise<string | undefined> {
  let currentDir = path.resolve(path.dirname(filePath));
  const root = path.parse(currentDir).root;

  while (true) {
    const configPath = path.join(currentDir, fileName);
    if (await pathExists(configPath)) {
      return configPath;
    }

    if (currentDir === root) {
      return undefined;
    }

    currentDir = path.dirname(currentDir);
  }
}

export async function findNearestAnyConfig(
  filePath: string,
  fileNames: readonly string[],
): Promise<string | undefined> {
  const configPath = await findNearestAnyConfigPath(filePath, fileNames);
  return configPath === undefined ? undefined : path.dirname(configPath);
}

export async function findNearestAnyConfigPath(
  filePath: string,
  fileNames: readonly string[],
): Promise<string | undefined> {
  let currentDir = path.resolve(path.dirname(filePath));
  const root = path.parse(currentDir).root;

  while (true) {
    for (const fileName of fileNames) {
      const configPath = path.join(currentDir, fileName);
      if (await pathExists(configPath)) {
        return configPath;
      }
    }

    if (currentDir === root) {
      return undefined;
    }

    currentDir = path.dirname(currentDir);
  }
}

export async function hasAnyConfig(
  directoryPath: string,
  configNames: readonly string[],
): Promise<boolean> {
  for (const configName of configNames) {
    if (await pathExists(path.join(directoryPath, configName))) {
      return true;
    }
  }

  return false;
}
