#!/usr/bin/env node
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createCliError } from "ai-qube-cli/errors";
import { createDryRunPlan, createDryRunPlanFields, renderDryRunPlan, renderMutationWarning } from "ai-qube-cli/mutation";
import { createCli, createCommand, createSchemaCommand, createTopicCommand, runCli } from "ai-qube-cli/runtime";

import { catalogPruneCommand, catalogTopic, consumerRegistry } from "./metadata.js";

interface CatalogItem {
  readonly id: string;
  readonly name: string;
  readonly status: "available" | "archived";
}

interface CatalogState {
  readonly items: readonly CatalogItem[];
}

let runtimeRegistry = consumerRegistry;

export const consumerCli = createCli({
  bin: "mutating-consumer",
  description: "Mutating consumer CLI validating ai-qube-cli dry-run adoption.",
  registry: consumerRegistry,
  topics: [createTopicCommand(catalogTopic)],
  commands: [
    createCommand(catalogPruneCommand, ({ args, flags }) => {
      const stateFile = resolveStateFile(args["state-file"]);
      const dryRun = flags["dry-run"] === true;
      const approved = flags.yes === true;

      if (!dryRun && !approved) {
        throw createCliError({
          command: "catalog prune",
          kind: "catalog-prune-approval-required",
          operation: "prune archived catalog items",
          likelyCause: "The command would modify a local state file, but neither --dry-run nor --yes was provided.",
          suggestedNextAction: "Run with --dry-run to preview changes, or rerun with --yes after reviewing the plan.",
          category: "safety",
          exitCode: 5
        });
      }

      const before = readCatalogState(stateFile);
      const archivedItems = before.items.filter((item) => item.status === "archived");
      const keptItems = before.items.filter((item) => item.status !== "archived");
      const plan = createDryRunPlan({
        command: "catalog prune",
        summary: `Remove ${archivedItems.length} archived catalog item${archivedItems.length === 1 ? "" : "s"} from consumer-owned local state.`,
        mutationCategories: ["local-files"],
        steps: [
          {
            action: "read",
            target: stateFile,
            category: "local-files",
            description: "Load the consumer-owned catalog state file."
          },
          {
            action: "write",
            target: stateFile,
            category: "local-files",
            description: `Persist catalog state without ${archivedItems.length} archived item${archivedItems.length === 1 ? "" : "s"}.`
          }
        ],
        rerunCommand: `mutating-consumer catalog prune ${shellQuote(stateFile)} --yes`
      });

      if (dryRun) {
        return {
          json: {
            ...createDryRunPlanFields(plan),
            stateFile,
            wouldRemove: archivedItems.map((item) => item.id),
            remaining: keptItems.map((item) => item.id)
          },
          human: `${renderDryRunPlan(plan)}State file not changed.\n`
        };
      }

      writeCatalogState(stateFile, { items: keptItems });
      return {
        json: {
          mutated: true,
          stateFile,
          removed: archivedItems.map((item) => item.id),
          remaining: keptItems.map((item) => item.id)
        },
        human: `${renderMutationWarning({
          command: "catalog prune",
          categories: ["local-files"],
          dryRun: catalogPruneCommand.interactions?.dryRun,
          message: "Consumer policy approved this local-file mutation with --yes."
        })}MUTATING HANDLER EXECUTED\nRemoved ${archivedItems.length} archived catalog item${archivedItems.length === 1 ? "" : "s"}.\n`
      };
    }),
    createSchemaCommand({
      registry: () => runtimeRegistry,
      bin: "mutating-consumer",
      packageName: "mutating-consumer",
      packageVersion: "0.1.0"
    })
  ]
});

runtimeRegistry = consumerCli.registry;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const result = await runCli(consumerCli, argv);
  if (result.stdout.length > 0) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr.length > 0) {
    process.stderr.write(result.stderr);
  }
  return result.exitCode;
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  process.exitCode = await main();
}

function resolveStateFile(value: unknown): string {
  return resolve(typeof value === "string" && value.length > 0 ? value : "catalog-state.json");
}

function readCatalogState(stateFile: string): CatalogState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(stateFile, "utf8"));
    if (!isCatalogState(parsed)) {
      throw new TypeError("catalog state must include an items array with id, name, and status fields");
    }
    return parsed;
  } catch (error) {
    throw createCliError({
      command: "catalog prune",
      kind: "catalog-state-invalid",
      operation: "read catalog state",
      likelyCause: error instanceof Error ? error.message : "The catalog state file could not be parsed.",
      suggestedNextAction: "Provide a readable JSON state file with an items array before retrying.",
      category: "validation",
      exitCode: 3
    });
  }
}

function writeCatalogState(stateFile: string, state: CatalogState): void {
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isCatalogState(value: unknown): value is CatalogState {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return false;
  }
  return value.items.every(isCatalogItem);
}

function isCatalogItem(value: unknown): value is CatalogItem {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && (value.status === "available" || value.status === "archived");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
