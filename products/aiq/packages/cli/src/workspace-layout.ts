import { glob, readFile } from "node:fs/promises";
import path from "node:path";

import { createLayoutConsumption } from "@tjalve/aiq/engine";
import type { LayoutConsumption, RepoLayoutInspection } from "@tjalve/aiq/model";
import { parse } from "yaml";

export async function inspectWorkspaceLayout(cwd: string): Promise<LayoutConsumption | undefined> {
  const patterns = await readWorkspacePatterns(cwd);
  if (patterns.length === 0) return undefined;
  const projects: RepoLayoutInspection["projects"][number][] = [];
  const excluded = patterns.filter((pattern) => pattern.startsWith("!"));
  for (const pattern of patterns.filter((entry) => !entry.startsWith("!"))) {
    for await (const manifest of glob(`${pattern}/package.json`, { cwd })) {
      const directory = path.dirname(manifest).replace(/\\/gu, "/");
      if (
        excluded.some((entry) =>
          [directory, `${directory}/`].some((candidate) =>
            path.posix.matchesGlob(candidate, entry.slice(1)),
          ),
        )
      )
        continue;
      if (projects.some((project) => project.path === directory)) continue;
      projects.push({
        id: directory,
        path: directory,
        kind: "package",
        packageName: null,
        packageManager: null,
        gates: [],
      });
    }
  }
  if (projects.length === 0) throw new Error("Workspace patterns selected no package members.");
  return createLayoutConsumption({
    inspect: {
      kind: "javascript-typescript-workspace",
      root: null,
      projects,
      remotes: [],
      rootMarkers: [],
      packageManagers: [],
      lockfiles: [],
      ciHints: [],
      generatedPaths: [],
      vendorPaths: [],
      warnings: [],
    },
    source: "workspace",
  });
}

async function readWorkspacePatterns(cwd: string): Promise<string[]> {
  try {
    const workspace = parse(await readFile(path.join(cwd, "pnpm-workspace.yaml"), "utf8"));
    return stringPatterns(workspace?.packages);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const pkg = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
  return stringPatterns(Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages);
}

function stringPatterns(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("Workspace packages must be an array of path patterns.");
  }
  return value;
}
