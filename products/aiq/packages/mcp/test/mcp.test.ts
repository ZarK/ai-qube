import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { defaultConfig } from "../../config-schema/src/index.js";
import type { RunResult, StageId } from "../../model/src/index.js";

import {
  AiqMcpAdapter,
  aiqExplainDiagnosticsInputSchema,
  createAiqMcpServer,
  formatDiagnosticExplanation,
} from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("MCP adapter", () => {
  it("runs AIQ checks for explicit files without exposing a fix path", async () => {
    const repoDir = await createWorkspace("var failing = 1;\nexport { failing };\n");
    const adapter = new AiqMcpAdapter({
      cwd: repoDir,
      stages: ["lint"],
    });

    const result = await adapter.check({
      files: ["index.ts"],
    });

    expect(result.ok).toBe(false);
    expect(result.files).toEqual([path.join(repoDir, "index.ts")]);
    expect(result.report.context).toBe("mcp");
    expect(result.report.request.context).toBe("mcp");
    expect(result.planPath).toBeUndefined();
    expect(result.reportPath).toBeUndefined();
    expect(result.text).toContain("AIQ check");
  });

  it("explains diagnostics from a canonical report artifact", async () => {
    const repoDir = await createWorkspace("var failing = 1;\nexport { failing };\n");
    const adapter = new AiqMcpAdapter({
      cwd: repoDir,
      stages: ["lint"],
      writeArtifacts: true,
    });

    const checkResult = await adapter.check({ files: ["index.ts"] });
    if (checkResult.reportPath === undefined) {
      throw new Error("Expected MCP report path.");
    }

    const explanation = await adapter.explain({ reportPath: checkResult.reportPath });

    expect(explanation.diagnosticCount).toBeGreaterThan(0);
    expect(explanation.text).toContain("AIQ diagnostics:");
    expect(explanation.text).toContain("[error]");
  });

  it("creates an MCP server with explicit check and explain tools", () => {
    const server = createAiqMcpServer({ writeArtifacts: false });
    expect(server).toBeDefined();
  });
});

async function createWorkspace(contents: string): Promise<string> {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "aiq-mcp-"));
  tempDirs.push(repoDir);

  await mkdir(path.join(repoDir, ".aiq"), { recursive: true });
  const filePath = path.join(repoDir, "index.ts");
  await writeFile(filePath, contents, "utf8");
  await readFile(filePath, "utf8");

  return repoDir;
}
