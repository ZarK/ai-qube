#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createCliError } from "@tjalve/cube-cli/errors";
import { createCli, createCommand, createSchemaCommand, createTopicCommand, runCli } from "@tjalve/cube-cli/runtime";

import { catalogInspectCommand, catalogTopic, consumerRegistry } from "./metadata.js";

interface CatalogItem {
  readonly id: string;
  readonly name: string;
  readonly status: "available" | "archived";
}

const catalog = new Map<string, CatalogItem>([
  ["alpha", { id: "alpha", name: "Alpha item", status: "available" }],
  ["bravo", { id: "bravo", name: "Bravo item", status: "archived" }]
]);

let runtimeRegistry = consumerRegistry;
const packageIdentity = {
  packageName: "read-only-consumer",
  packageVersion: "0.1.0"
};

export const consumerCli = createCli({
  bin: "consumer",
  ...packageIdentity,
  description: "Read-only consumer CLI validating @tjalve/cube-cli adoption.",
  registry: consumerRegistry,
  topics: [createTopicCommand(catalogTopic)],
  commands: [
    createCommand(catalogInspectCommand, ({ args }) => {
      const id = typeof args.id === "string" ? args.id : "";
      const item = catalog.get(id);

      if (item === undefined) {
        throw createCliError({
          command: "catalog inspect",
          kind: "catalog-item-not-found",
          operation: "inspect catalog item",
          likelyCause: `No catalog item matched "${id}".`,
          suggestedNextAction: "Choose an existing catalog item such as alpha or bravo.",
          category: "validation"
        });
      }

      return {
        json: {
          id: item.id,
          name: item.name,
          status: item.status,
          mutated: false
        },
        human: `READ-ONLY HANDLER EXECUTED\nCatalog item ${item.id}: ${item.name} (${item.status})\nNo state changed.\n`
      };
    }),
    createSchemaCommand({
      registry: () => runtimeRegistry,
      bin: "consumer",
      ...packageIdentity
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
