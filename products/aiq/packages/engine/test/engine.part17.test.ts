import { describe, expect, it } from "vitest";
import {
  commandAvailable,
  createDotNetFixtureProject,
  createGoFixtureProject,
  createRustFixtureProject,
  createTerraformHclFixtureProject,
  fixturePythonFile,
  hasDotNet10Toolchain,
  hasGoToolchain,
  hasPythonQualityToolchain,
  hasRustCoverageToolchain,
  mkdtemp,
  os,
  path,
  readFile,
  runEngine,
  tempDirs,
  withExclusiveRust,
  withExclusiveToolLock,
} from "./engine-test-support.js";
describe("engine foundation", () => {
  it("runs Terraform and HCL stages against fixture projects and writes canonical artifacts", async () => {
    const project = await createTerraformHclFixtureProject("aiq-engine-terraform-hcl-");
    const hasTerraform = commandAvailable("terraform");
    const outDir = path.join(project.root, ".aiq-out");

    const result = await runEngine({
      context: "cli",
      manifest: {
        files: [project.terraformFile, project.hclFile],
        source: "mixed",
      },
      mode: "check",
      outDir,
      stages: ["lint", "format", "typecheck", "security"],
    });

    expect(result.artifacts.metricsPath).toBeDefined();
    expect(result.artifacts.planPath).toBeDefined();
    expect(result.artifacts.reportPath).toBeDefined();
    expect(result.stages).toHaveLength(4);

    const lintStage = result.stages.find((stage) => stage.stageId === "lint");
    const formatStage = result.stages.find((stage) => stage.stageId === "format");
    const typecheckStage = result.stages.find((stage) => stage.stageId === "typecheck");
    const securityStage = result.stages.find((stage) => stage.stageId === "security");

    if (hasTerraform) {
      expect(result.ok).toBe(true);
      expect(result.summary.diagnosticCount).toBe(0);
      expect(result.summary.notImplementedStageCount).toBe(0);
      expect(result.summary.status).toBe("passed");
      expect(lintStage?.status).toBe("passed");
      expect(lintStage?.toolRuns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ cacheHit: false, status: "passed", tool: "terraform-init" }),
          expect.objectContaining({
            cacheHit: false,
            status: "passed",
            tool: "terraform-validate",
          }),
          expect.objectContaining({
            cacheHit: false,
            status: "passed",
            tool: "terraform-hcl-lint",
          }),
        ]),
      );
      expect(formatStage?.status).toBe("passed");
      expect(formatStage?.toolRuns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "passed", tool: "terraform-fmt" }),
          expect.objectContaining({ status: "passed", tool: "terraform-hcl-format" }),
        ]),
      );
      expect(typecheckStage?.status).toBe("passed");
      expect(typecheckStage?.notes.join(" ")).toContain("Reused cached Terraform validation");
      expect(typecheckStage?.toolRuns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ cacheHit: true, status: "passed", tool: "terraform-init" }),
          expect.objectContaining({
            cacheHit: true,
            status: "passed",
            tool: "terraform-validate",
          }),
        ]),
      );
      expect(securityStage?.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "aiq-security",
      });
    } else {
      expect(result.ok).toBe(false);
      expect(result.summary.diagnosticCount).toBe(3);
      expect(result.summary.notImplementedStageCount).toBe(0);
      expect(result.summary.status).toBe("failed");
      expect(lintStage?.status).toBe("failed");
      expect(lintStage?.diagnostics[0]).toMatchObject({ source: "terraform" });
      expect(lintStage?.notes.join(" ")).toContain("aiq doctor");
      expect(lintStage?.notes.join(" ")).not.toContain("rewrite foundation slice");
      expect(formatStage?.status).toBe("failed");
      expect(formatStage?.diagnostics[0]).toMatchObject({ source: "terraform" });
      expect(formatStage?.notes.join(" ")).toContain("aiq doctor");
      expect(typecheckStage?.status).toBe("failed");
      expect(typecheckStage?.diagnostics[0]).toMatchObject({ source: "terraform" });
      expect(typecheckStage?.notes.join(" ")).toContain("aiq doctor");
      expect(securityStage?.status).toBe("passed");
    }

    const { metricsPath, planPath, reportPath } = result.artifacts;
    if (planPath === undefined || reportPath === undefined || metricsPath === undefined) {
      throw new Error("Expected plan, report, and metrics artifacts to be written.");
    }

    const planJson = JSON.parse(await readFile(planPath, "utf8")) as {
      input: { files: string[] };
      stages: string[];
    };
    const reportJson = JSON.parse(await readFile(reportPath, "utf8")) as {
      stages: Array<{
        notes: string[];
        stageId: string;
        status: string;
        toolRuns: Array<{ cacheHit?: boolean; tool: string }>;
      }>;
      summary: { diagnosticCount: number; notImplementedStageCount: number; status: string };
    };
    const metricsEvents = (await readFile(metricsPath, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            cacheHit?: boolean;
            event: string;
            stageId?: string;
            tool?: string;
          },
      );

    expect(planJson.input.files).toEqual([project.hclFile, project.terraformFile]);
    expect(planJson.stages).toEqual(["lint", "format", "typecheck", "security"]);

    if (hasTerraform) {
      expect(reportJson.summary.diagnosticCount).toBe(0);
      expect(reportJson.summary.notImplementedStageCount).toBe(0);
      expect(reportJson.summary.status).toBe("passed");
      expect(
        reportJson.stages.find((stage) => stage.stageId === "typecheck")?.notes.join(" "),
      ).toContain("Reused cached Terraform validation");
      expect(metricsEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            cacheHit: true,
            event: "cache.hit",
            stageId: "typecheck",
            tool: "terraform-validate",
          }),
        ]),
      );
    } else {
      expect(reportJson.summary.notImplementedStageCount).toBe(0);
      expect(reportJson.summary.status).toBe("failed");
      expect(reportJson.stages.filter((stage) => stage.status === "failed")).toHaveLength(3);
      expect(reportJson.stages.flatMap((stage) => stage.notes).join(" ")).not.toContain(
        "rewrite foundation slice",
      );
    }
  }, 20_000);
});
