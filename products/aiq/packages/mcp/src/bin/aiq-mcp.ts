#!/usr/bin/env node
import { stderr, stdout } from "node:process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { defineCommand } from "@tjalve/qube-cli/metadata";
import { createCommandRegistry } from "@tjalve/qube-cli/registry";
import { createCli, createCommand as createRuntimeCommand, createSchemaCommand, normalizeDefaultCommandInput, runCli, type RuntimeCommandResult } from "@tjalve/qube-cli/runtime";

import { startAiqMcpStdioServer } from "../index.js";

const requirePackage = createRequire(import.meta.url);
const packageJson = requirePackage("../../package.json") as { name: string; version: string };
const packageIdentity = { name: packageJson.name, version: packageJson.version };

const serveCommand = defineCommand({
  kind: "command",
  name: "serve",
  description: "Start the AIQ MCP stdio server.",
  examples: [
    {
      description: "Start the stdio server.",
      command: "aiq-mcp serve"
    }
  ],
  interactions: {
    nonInteractive: true,
    ttyPrompt: false
  }
});

let mcpRegistry = createCommandRegistry({ commands: [serveCommand] });

const mcpCli = createCli({
  bin: "aiq-mcp",
  packageName: packageIdentity.name,
  packageVersion: packageIdentity.version,
  description: "AIQ MCP adapter.",
  registry: mcpRegistry,
  commands: [
    createRuntimeCommand(serveCommand, serveMcpCommand),
    createSchemaCommand({
      registry: () => mcpRegistry,
      bin: "aiq-mcp",
      packageName: packageIdentity.name,
      packageVersion: packageIdentity.version
    })
  ]
});
mcpRegistry = mcpCli.registry;

export async function main(argv: string[]): Promise<number> {
  return runAiqMcpCli(argv.slice(2));
}

export async function runAiqMcpCli(input: readonly string[]): Promise<number> {
  const result = await runCli(mcpCli, normalizeDefaultCommandInput(input, { defaultCommand: "serve" }));
  if (result.stdout.length > 0) stdout.write(result.stdout);
  if (result.stderr.length > 0) stderr.write(result.stderr);
  return result.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv);
}

async function serveMcpCommand(): Promise<RuntimeCommandResult> {
  try {
    await startAiqMcpStdioServer();
    return {};
  } catch (error) {
    return { stderr: `${formatError(error)}\n`, exitCode: 1 };
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
