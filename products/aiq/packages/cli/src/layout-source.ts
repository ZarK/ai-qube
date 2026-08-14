import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  LayoutConsumptionError,
  applyLayoutToCandidateFiles,
  createLayoutConsumption,
  parseLayoutAffectedJson,
  parseLayoutInspectJson,
} from "@tjalve/aiq/engine";
import type { LayoutConsumption, LayoutConsumptionSource } from "@tjalve/aiq/model";

const execFileAsync = promisify(execFile);

export const layoutInspectFileName = "layout-inspect.json";
export const layoutAffectedFileName = "layout-affected.json";

export interface LayoutSourceOptions {
  affectedPath?: string;
  changedPaths?: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  inspectPath?: string;
  required: boolean;
}

export async function loadLayoutConsumption(
  options: LayoutSourceOptions,
): Promise<LayoutConsumption | undefined> {
  const env = options.env ?? process.env;
  const inspectPath = firstPresentPath([
    options.inspectPath,
    env.AIQ_LAYOUT_INSPECT,
    path.join(options.cwd, ".qube", "aiq", layoutInspectFileName),
  ]);
  const affectedPath = firstPresentPath([
    options.affectedPath,
    env.AIQ_LAYOUT_AFFECTED,
    path.join(options.cwd, ".qube", "aiq", layoutAffectedFileName),
  ]);

  if (inspectPath !== undefined || affectedPath !== undefined) {
    return loadLayoutFiles(inspectPath, affectedPath, options.changedPaths);
  }

  if (env.AIQ_AIE_BIN !== undefined && env.AIQ_AIE_BIN.trim().length > 0) {
    return loadLayoutFromAie(options.cwd, options.changedPaths ?? [], env.AIQ_AIE_BIN);
  }

  if (options.required) {
    throw new LayoutConsumptionError(
      "Layout inspect JSON is missing. Provide --layout-inspect or AIQ_LAYOUT_INSPECT, or run aie repo inspect --json.",
    );
  }

  return undefined;
}

export async function scopeFilesWithLayout(input: {
  files: readonly string[];
  cwd: string;
  layout: LayoutConsumption;
  requireProvenScope: boolean;
}): Promise<{ files: string[]; layout: LayoutConsumption; warnings: string[] }> {
  const scoped = applyLayoutToCandidateFiles(input);
  return { files: scoped.files, layout: scoped.layout, warnings: scoped.warnings };
}

async function loadLayoutFiles(
  inspectPath: string | undefined,
  affectedPath: string | undefined,
  candidatePaths: readonly string[] | undefined,
): Promise<LayoutConsumption> {
  if (affectedPath !== undefined && inspectPath === undefined) {
    const affected = parseLayoutAffectedJson(await readLayoutFile(affectedPath, "affected"));
    return createLayoutConsumption({
      inspect: affected.layout,
      affected,
      source: "layout-affected-json",
      ...(candidatePaths === undefined ? {} : { candidatePaths }),
    });
  }

  if (inspectPath === undefined) {
    throw new LayoutConsumptionError("Layout inspect JSON is missing.");
  }

  const inspect = parseLayoutInspectJson(await readLayoutFile(inspectPath, "inspect"));
  if (affectedPath === undefined) {
    return createLayoutConsumption({
      inspect,
      source: "layout-inspect-json",
      ...(candidatePaths === undefined ? {} : { candidatePaths }),
    });
  }

  const affected = parseLayoutAffectedJson(await readLayoutFile(affectedPath, "affected"));
  return createLayoutConsumption({
    inspect,
    affected,
    source: "layout-affected-json",
    ...(candidatePaths === undefined ? {} : { candidatePaths }),
  });
}

async function loadLayoutFromAie(
  cwd: string,
  changedPaths: readonly string[],
  aieBin: string,
): Promise<LayoutConsumption> {
  const aie = { command: aieBin, prefix: [] };
  const inspectText = await runAieJson(aie, ["repo", "inspect", "--json"], cwd);
  const affectedArgs = ["repo", "affected", "--json"];
  for (const changedPath of changedPaths) {
    affectedArgs.push("--changed", changedPath);
  }
  const affectedText = await runAieJson(aie, affectedArgs, cwd);
  return createLayoutConsumption({
    inspect: parseLayoutInspectJson(inspectText),
    affected: parseLayoutAffectedJson(affectedText),
    source: "aie-cli",
    candidatePaths: changedPaths,
  });
}

async function runAieJson(
  aie: { command: string; prefix: string[] },
  args: readonly string[],
  cwd: string,
): Promise<string> {
  try {
    const result = await execFileAsync(aie.command, [...aie.prefix, ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    throw new LayoutConsumptionError(
      `Failed to read layout JSON from aie ${args[1] ?? "repo"}. ${formatExecError(error)}`,
      { cause: error },
    );
  }
}

async function readLayoutFile(filePath: string, label: "inspect" | "affected"): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    throw new LayoutConsumptionError(
      `Layout ${label} JSON is missing or unreadable: ${filePath}.`,
      { cause: error },
    );
  }
}

function firstPresentPath(candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.trim().length > 0 && existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function formatExecError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { LayoutConsumption, LayoutConsumptionSource };
