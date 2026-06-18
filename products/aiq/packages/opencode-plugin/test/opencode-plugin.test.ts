import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { defaultConfig } from "../../config-schema/src/index.js";
import type { RunResult, StageId } from "../../model/src/index.js";

import {
  AiqOpenCodeAdapter,
  buildAiqOpenCodeHooks,
  formatAiqOpenCodeResult,
} from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("OpenCode adapter", () => {
  it("runs AIQ on explicit files with read-only defaults", async () => {
    const repoDir = await createWorkspace({
      "src/index.ts": "var failing = 1;\nexport { failing };\n",
    });

    const adapter = new AiqOpenCodeAdapter({
      cwd: repoDir,
      stages: ["lint"],
    });
    const result = await adapter.run({
      files: ["src/index.ts"],
    });

    expect(result.ok).toBe(false);
    expect(result.files).toEqual([path.join(repoDir, "src/index.ts")]);
    expect(result.report.context).toBe("opencode");
    expect(result.report.request.context).toBe("opencode");
    expect(result.publishDiagnostics).toBe(true);
    expect(result.diagnostics).not.toHaveLength(0);
    expect(result.planPath).toBeUndefined();
    expect(result.reportPath).toBeUndefined();
    expect(result.text).toContain("AIQ check");
  });

  it("hides diagnostics in the tool-facing result when opencode publishDiagnostics is disabled", async () => {
    const repoDir = await createWorkspace({
      "src/index.ts": "var failing = 1;\nexport { failing };\n",
    });

    const adapter = new AiqOpenCodeAdapter({
      cwd: repoDir,
      stages: ["lint"],
      resolveConfigImpl: async () => ({
        cadenceStages: [],
        changedOnly: true,
        config: defaultConfig,
        cwd: repoDir,
        stages: ["lint"],
        stageConfigurations: {
          lint: {
            languages: {
              typescript: {
                toolId: "biome",
              },
            },
          },
        },
        profile: "fast",
        publishDiagnostics: false,
        source: "defaults",
        surface: "opencode",
      }),
      writeArtifacts: false,
    });

    const result = await adapter.run({ files: ["src/index.ts"] });

    expect(result.publishDiagnostics).toBe(false);
    expect(result.diagnostics).toEqual([]);
    expect(result.text).toContain("Diagnostics are hidden");
  });

  it("builds OpenCode hooks with the expected aiq_check_files tool", async () => {
    const hooks = await buildAiqOpenCodeHooks({
      directory: "/tmp/project",
    });

    expect(hooks).toHaveProperty("tool.aiq_check_files");
    expect(hooks).toHaveProperty("tool.aiq_plan_files");
    expect(hooks).toHaveProperty("tool.aiq_status");
    expect(hooks).toHaveProperty("tool.aiq_doctor");
  });
});

async function createWorkspace(files: Record<string, string>): Promise<string> {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "aiq-opencode-"));
  tempDirs.push(repoDir);

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(repoDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, "utf8");
  }

  return repoDir;
}

function safeParseToolSchema(schema: unknown, value: unknown): { success: boolean } {
  if (
    typeof schema !== "object" ||
    schema === null ||
    !("safeParse" in schema) ||
    typeof schema.safeParse !== "function"
  ) {
    throw new TypeError("Expected a tool schema with safeParse().");
  }

  return schema.safeParse(value) as { success: boolean };
}
