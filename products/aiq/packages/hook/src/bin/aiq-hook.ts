#!/usr/bin/env node
import { stderr, stdout } from "node:process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { defineCommand, defineFlag } from "@tjalve/qube-cli/metadata";
import { createCommandRegistry } from "@tjalve/qube-cli/registry";
import { createCli, createCommand as createRuntimeCommand, createSchemaCommand, normalizeDefaultCommandInput, runCli, type RuntimeCommandResult } from "@tjalve/qube-cli/runtime";
import {
  type AiqProfileName,
  type StageId,
  aiqProfileNames,
  aiqStageLadderIds,
  formatRunResultAsText,
  stageIds,
} from "@tjalve/aiq/api";

import { runAiqHook } from "../index.js";

const requirePackage = createRequire(import.meta.url);
const packageJson = requirePackage("../../package.json") as { name: string; version: string };
const packageIdentity = { name: packageJson.name, version: packageJson.version };

const runCommand = defineCommand({
  kind: "command",
  name: "run",
  description: "Run AIQ checks for files selected by the host hook.",
  flags: [
    defineFlag({
      name: "up-to",
      description: "Run cumulative AIQ stages through the stage index.",
      type: "integer"
    }),
    defineFlag({
      name: "only",
      description: "Run only one AIQ stage index.",
      type: "integer"
    }),
    defineFlag({
      name: "stage",
      description: "Run one AIQ stage by id.",
      type: "option",
      options: stageIds
    }),
    defineFlag({
      name: "profile",
      description: "Select the AIQ execution profile.",
      type: "option",
      options: aiqProfileNames
    })
  ],
  examples: [
    {
      description: "Run the default hook checks.",
      command: "aiq-hook run"
    },
    {
      description: "Run stages through stage 4.",
      command: "aiq-hook run --up-to 4"
    }
  ],
  interactions: {
    nonInteractive: true,
    ttyPrompt: false
  }
});

let hookRegistry = createCommandRegistry({ commands: [runCommand] });

const hookCli = createCli({
  bin: "aiq-hook",
  packageName: packageIdentity.name,
  packageVersion: packageIdentity.version,
  description: "AIQ hook adapter.",
  registry: hookRegistry,
  commands: [
    createRuntimeCommand(runCommand, context => runHookCommand(context.argv)),
    createSchemaCommand({
      registry: () => hookRegistry,
      bin: "aiq-hook",
      packageName: packageIdentity.name,
      packageVersion: packageIdentity.version
    })
  ]
});
hookRegistry = hookCli.registry;

export async function main(argv: string[]): Promise<number> {
  return runAiqHookCli(argv.slice(2));
}

export async function runAiqHookCli(input: readonly string[]): Promise<number> {
  const result = await runCli(hookCli, normalizeDefaultCommandInput(input, { defaultCommand: "run" }));
  if (result.stdout.length > 0) stdout.write(result.stdout);
  if (result.stderr.length > 0) stderr.write(result.stderr);
  return result.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv);
}

async function runHookCommand(argv: readonly string[]): Promise<RuntimeCommandResult> {
  try {
    const result = await runAiqHook(parseHookArgs([...argv]));
    if (result.skipped || result.result === undefined) {
      return { stdout: "AIQ hook skipped: no staged files selected.\n" };
    }

    return {
      stdout: formatRunResultAsText(result.result),
      exitCode: result.exitCode
    };
  } catch (error) {
    return { stderr: `${formatError(error)}\n`, exitCode: 1 };
  }
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
