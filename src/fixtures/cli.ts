#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { createCliError } from "../errors/index.js";
import { defineExtensions } from "../metadata/index.js";
import { createDryRunPlan, createDryRunPlanFields, createSupplyChainBlock, renderDryRunPlan, renderMutationWarning, renderSupplyChainBlock } from "../mutation/index.js";
import { resolvePromptValue } from "../prompts/index.js";
import { createCli, createCommand, createSchemaCommand, createTopicCommand, runCli } from "../runtime/index.js";
import { cacheClearCommand, cacheExplodeCommand, cacheInspectCommand, cacheInstallCommand, cachePromptCommand, cacheTopic, cacheValidateCommand, fixtureMetadata } from "./metadata.js";

let currentRegistry = fixtureMetadata;
const packageMetadata = readPackageMetadata();
const packageIdentity = {
  packageName: packageMetadata.name,
  packageVersion: packageMetadata.version
};

export const fixtureCli = createCli({
  bin: "fixture",
  ...packageIdentity,
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
        const plan = createDryRunPlan({
          command: "cache clear",
          summary: "Remove fixture cache entries without touching external systems.",
          mutationCategories: ["local-files"],
          steps: [
            {
              action: "delete",
              target: "fixture-cache/*",
              category: "local-files",
              description: "Remove local fixture cache entries."
            }
          ],
          rerunCommand: "fixture cache clear --yes"
        });
        return { json: createDryRunPlanFields(plan), human: renderDryRunPlan(plan) };
      }
      return {
        human: `${renderMutationWarning({
          command: "cache clear",
          categories: ["local-files"],
          dryRun: cacheClearCommand.interactions?.dryRun,
          message: "Use --dry-run before removing fixture cache entries."
        })}EXECUTED cache clear\nRemoved fixture cache entries.\n`
      };
    }),
    createCommand(cacheInstallCommand, ({ flags }) => {
      const plan = createDryRunPlan({
        command: "cache install",
        summary: "Prepare dependency cache metadata without running package-manager commands.",
        mutationCategories: ["dependency", "local-files"],
        steps: [
          {
            action: "review",
            target: "fixture-lockfile metadata",
            category: "dependency",
            description: "Inspect consumer-provided dependency metadata."
          },
          {
            action: "write",
            target: "fixture dependency cache",
            category: "local-files",
            description: "Record cache entries after policy approval."
          }
        ],
        rerunCommand: "fixture cache install"
      });
      if (flags["dry-run"] === true) {
        return { json: createDryRunPlanFields(plan), human: `${renderDryRunPlan(plan)}No external commands executed.\n` };
      }
      const block = createSupplyChainBlock({
        command: "cache install",
        reason: "Dependency cache preparation requires consuming-package supply-chain approval.",
        sensitiveKinds: ["dependency", "package-manager"],
        checks: [
          {
            name: "package-age-gate",
            status: "needs-review",
            description: "Consumer policy must verify package age before execution."
          },
          {
            name: "lifecycle-scripts",
            status: "blocked",
            description: "Lifecycle scripts remain blocked unless the consuming package approves them."
          }
        ],
        suggestedNextAction: "Run --dry-run and apply the consuming package approval policy before retrying."
      });
      if (flags.json === true) {
        throw createCliError({
          command: "cache install",
          kind: "supply-chain-blocked",
          operation: "prepare dependency cache",
          likelyCause: "Dependency cache preparation requires consuming-package supply-chain approval.",
          suggestedNextAction: "Run --dry-run and apply the consuming package approval policy before retrying.",
          category: "safety",
          exitCode: 5
        });
      }
      return { exitCode: 5, human: `${renderSupplyChainBlock(block)}No external commands executed.\n` };
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
    createCommand(cachePromptCommand, async ({ flags }) => {
      const valueFlag = typeof flags.value === "string" ? flags.value : undefined;
      const useDefault = flags.defaults === true || flags.yes === true;
      const promptValue = await resolvePromptValue({
        command: cachePromptCommand,
        promptName: "cache value",
        value: valueFlag,
        defaultValue: useDefault ? "fixture-default" : undefined,
        defaults: flags.defaults === true,
        yes: flags.yes === true,
        jsonMode: flags.json === true,
        prompt: () => "interactive-value"
      });
      return {
        json: { promptValue },
        human: `Resolved prompt value: ${promptValue}\n`
      };
    }),
    createCommand(cacheExplodeCommand, () => {
      throw new Error("Fixture exploded unexpectedly.");
    }),
    createSchemaCommand({
      registry: () => currentRegistry,
      bin: "fixture",
      ...packageIdentity,
      sections: {
        config: {
          defaults: {
            output: "human",
            cacheDirectory: ".fixture-cache"
          },
          token: "ghp_1234567890abcdefghijklmnopqrstuvwxyz"
        },
        providers: {
          local: {
            available: true,
            capabilities: ["read", "dry-run"]
          }
        }
      },
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
