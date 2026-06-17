#!/usr/bin/env node
import { stderr, stdout } from "node:process";
import { pathToFileURL } from "node:url";

import {
  type AiqProfileName,
  type StageId,
  aiqProfileNames,
  aiqStageLadderIds,
  formatRunResultAsText,
  stageIds,
} from "@tjalve/aiq/api";

import { runAiqHook } from "../index.js";

const helpText = `AIQ hook adapter

Usage:
  aiq-hook [--up-to <0-9> | --only <0-9> | --stage <stage>] [--profile <fast|standard|deep>]

Defaults to cumulative stages through .aiq/progress.json current_stage when present; explicit stage/profile flags override that selection.
`;

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    stdout.write(helpText);
    return 0;
  }

  try {
    const result = await runAiqHook(parseHookArgs(argv.slice(2)));
    if (result.skipped || result.result === undefined) {
      stdout.write("AIQ hook skipped: no staged files selected.\n");
      return 0;
    }

    stdout.write(formatRunResultAsText(result.result));
    return result.exitCode;
  } catch (error) {
    stderr.write(`${formatError(error)}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseHookArgs(argv: string[]): { profile?: AiqProfileName; stages?: StageId[] } {
  let profile: AiqProfileName | undefined;
  let stages: StageId[] | undefined;
  let stageSelector: "--only" | "--stage" | "--up-to" | undefined;

  const assertSingleStageSelector = (next: "--only" | "--stage" | "--up-to"): void => {
    if (stageSelector !== undefined) {
      throw new Error("Specify only one of --only, --up-to, or --stage.");
    }

    stageSelector = next;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--only": {
        assertSingleStageSelector("--only");
        const stageIndex = parseStageIndex(argv[++index], "--only");
        const stage = aiqStageLadderIds[stageIndex];
        if (stage === undefined) {
          throw new Error("--only must be a stage index from 0 to 9.");
        }
        stages = [stage];
        break;
      }
      case "--up-to": {
        assertSingleStageSelector("--up-to");
        const stageIndex = parseStageIndex(argv[++index], "--up-to");
        stages = [...aiqStageLadderIds.slice(0, stageIndex + 1)];
        break;
      }
      case "--stage": {
        assertSingleStageSelector("--stage");
        const stage = argv[++index];
        if (stage === undefined || !stageIds.includes(stage as StageId)) {
          throw new Error(`--stage must be one of ${stageIds.join(", ")}.`);
        }
        stages = [stage as StageId];
        break;
      }
      case "--profile": {
        const value = argv[++index];
        if (value === undefined || !aiqProfileNames.includes(value as AiqProfileName)) {
          throw new Error(`--profile must be one of ${aiqProfileNames.join(", ")}.`);
        }
        profile = value as AiqProfileName;
        break;
      }
      default:
        throw new Error(`Unsupported aiq-hook option: ${arg}`);
    }
  }

  return {
    ...(profile === undefined ? {} : { profile }),
    ...(stages === undefined ? {} : { stages }),
  };
}

function parseStageIndex(value: string | undefined, option: string): number {
  if (value === undefined || !/^\d$/u.test(value)) {
    throw new Error(`${option} must be a stage index from 0 to 9.`);
  }

  const parsed = Number(value);
  if (aiqStageLadderIds[parsed] === undefined) {
    throw new Error(`${option} must be a stage index from 0 to 9.`);
  }

  return parsed;
}
