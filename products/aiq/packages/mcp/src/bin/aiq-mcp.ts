#!/usr/bin/env node
import { stderr } from "node:process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { startAiqMcpStdioServer } from "../index.js";

const requirePackage = createRequire(import.meta.url);
const packageJson = requirePackage("../../package.json") as { name: string; version: string };
const packageIdentity = { name: packageJson.name, version: packageJson.version };

export async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write("AIQ MCP adapter\n\nUsage:\n  aiq-mcp\n");
    return 0;
  }
  if (isVersionRequest(args)) {
    if (args.includes("--json")) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, command: "version", package: packageIdentity, version: packageIdentity.version })}\n`,
      );
    } else {
      process.stdout.write(`${packageIdentity.version}\n`);
    }
    return 0;
  }

  try {
    await startAiqMcpStdioServer();
    return 0;
  } catch (error) {
    stderr.write(`${formatError(error)}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv);
}

function isVersionRequest(args: readonly string[]): boolean {
  return (
    args.some((arg) => arg === "--version" || arg === "-v") &&
    args.every((arg) => arg === "--version" || arg === "-v" || arg === "--json")
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
