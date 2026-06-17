#!/usr/bin/env node
import { stderr } from "node:process";

import { startAiqMcpStdioServer } from "../index.js";

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write("AIQ MCP adapter\n\nUsage:\n  aiq-mcp\n");
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

process.exitCode = await main(process.argv);

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
