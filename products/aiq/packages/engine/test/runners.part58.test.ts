import { describe, expect, it } from "vitest";
import {
  fixtureFile,
  mkdtemp,
  os,
  path,
  rm,
  runPlannedTask,
  tempDirs,
  writeFile,
} from "./runners-test-support.js";

const fakeGitHubToken = ["ghp", "123456789012345678901234567890123456"].join("_");

describe("engine runners", () => {
  it("fails the shared security scan when a selected file cannot be read", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-security-missing-file-"));
    tempDirs.push(tempDir);

    const missingFile = path.join(tempDir, "missing.ts");
    await writeFile(missingFile, `export const token = "${fakeGitHubToken}";\n`, "utf8");
    await rm(missingFile);

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [missingFile],
        id: "test:1:security-missing-file",
        stageId: "security",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.toolRuns).toEqual([]);
    expect(result.notes[0]).toContain("ENOENT");
    expect(result.diagnostics[0]).toMatchObject({
      file: missingFile,
      severity: "error",
      source: "aiq-security",
    });
  });

  it("fails e2e setup when selected TypeScript project has no e2e runner", async () => {
    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [fixtureFile],
        id: "test:1:e2e",
        stageId: "e2e",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.toolRuns).toEqual([]);
    expect(result.notes[0]).toContain("No e2e runner is configured");
    expect(result.diagnostics[0]).toMatchObject({
      severity: "error",
      source: "aiq-e2e",
    });
  });
});
