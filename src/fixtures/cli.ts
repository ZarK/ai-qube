#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { createCliError } from "../errors/index.js";
import { defineExtensions } from "../metadata/index.js";
import { createCli, createCommand, createSchemaCommand, createTopicCommand, runCli } from "../runtime/index.js";
import { cacheClearCommand, cacheExplodeCommand, cacheInspectCommand, cacheTopic, cacheValidateCommand, fixtureMetadata } from "./metadata.js";

let currentRegistry = fixtureMetadata;
const packageMetadata = readPackageMetadata();

export const fixtureCli = createCli({
  bin: "fixture",
  description: "Product-neutral fixture CLI for ai-qube-cli runtime tests.",
  registry: fixtureMetadata,
  topics: [createTopicCommand(cacheTopic)],
  commands: [
    createCommand(cacheInspectCommand, ({ args }) => {
      const key = typeof args.key === "string" ? args.key : "all";
      return {
        json: { key },
        human: `EXECUTED cache inspect\nInspected cache key: ${key}\n`
      };
    }),
    createCommand(cacheClearCommand, ({ flags }) => {
      if (flags["dry-run"] === true) {
        return { stdout: "EXECUTED cache clear\nWould remove fixture cache entries.\n" };
      }
      return { stdout: "EXECUTED cache clear\nRemoved fixture cache entries.\n" };
    }),
    createCommand(cacheValidateCommand, () => {
      throw createCliError({
        kind: "cache-config-invalid",
        operation: "validate cache configuration",
        likelyCause: "The fixture cache configuration is missing a required directory.",
        suggestedNextAction: "Create the cache directory or update the cache configuration path.",
        category: "validation"
      });
    }),
    createCommand(cacheExplodeCommand, () => {
      throw new Error("Fixture exploded unexpectedly.");
    }),
    createSchemaCommand({
      registry: () => currentRegistry,
      bin: "fixture",
      packageName: packageMetadata.name,
      packageVersion: packageMetadata.version,
      extensions: defineExtensions({
        fixture: true,
        purpose: "schema-integration"
      })
    })
  ]
});

currentRegistry = fixtureCli.registry;

export async function runFixtureCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const result = await runCli(fixtureCli, argv);
  if (result.stdout.length > 0) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr.length > 0) {
    process.stderr.write(result.stderr);
  }
  return result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runFixtureCli();
}

function readPackageMetadata(): { readonly name: string; readonly version: string } {
  const parsed: unknown = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  if (!isPackageMetadata(parsed)) {
    throw new TypeError("package.json must include string name and version fields.");
  }
  return { name: parsed.name, version: parsed.version };
}

function isPackageMetadata(value: unknown): value is { readonly name: string; readonly version: string } {
  return isRecord(value) && typeof value.name === "string" && typeof value.version === "string";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
