#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { createCli, createCommand, createSchemaCommand, createTopicCommand, runCli } from "../runtime/index.js";
import { cacheClearCommand, cacheInspectCommand, cacheTopic, fixtureMetadata } from "./metadata.js";

let currentRegistry = fixtureMetadata;

export const fixtureCli = createCli({
  bin: "fixture",
  description: "Product-neutral fixture CLI for ai-qube-cli runtime tests.",
  registry: fixtureMetadata,
  topics: [createTopicCommand(cacheTopic)],
  commands: [
    createCommand(cacheInspectCommand, ({ args, flags }) => {
      const key = typeof args.key === "string" ? args.key : "all";
      if (flags.json === true) {
        return {
          stdout: `${JSON.stringify({ ok: true, command: "cache inspect", key })}\n`
        };
      }
      return { stdout: `EXECUTED cache inspect\nInspected cache key: ${key}\n` };
    }),
    createCommand(cacheClearCommand, ({ flags }) => {
      if (flags["dry-run"] === true) {
        return { stdout: "EXECUTED cache clear\nWould remove fixture cache entries.\n" };
      }
      return { stdout: "EXECUTED cache clear\nRemoved fixture cache entries.\n" };
    }),
    createSchemaCommand(() => currentRegistry, "fixture")
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
