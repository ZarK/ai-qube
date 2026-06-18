import { describe, expect, it } from "vitest";
import {
  commandAvailable,
  createBashFixtureProject,
  createJavaMavenFixtureProject,
  createKotlinGradleFixtureProject,
  createPowerShellFixtureProject,
  hasGradleToolchain,
  hasMavenToolchain,
  hasPowerShellPesterToolchain,
  readFile,
  resolvePowerShellModuleAvailable,
  runEngine,
} from "./engine-test-support.js";
describe("engine foundation", () => {
  it("runs Bash stages against the fixture project and writes canonical artifacts", async () => {
    const project = await createBashFixtureProject("aiq-engine-bash-");
    const hasShellcheck = commandAvailable("shellcheck");
    const hasShfmt = commandAvailable("shfmt");
    const hasBats = commandAvailable("bats");
    const hasKcov = commandAvailable("kcov");

    const result = await runEngine({
      context: "cli",
      manifest: {
        files: [project.sourceFile],
        source: "direct",
      },
      mode: "check",
      outDir: project.root,
      stages: ["lint", "format", "unit", "coverage", "security"],
    });

    expect(result.artifacts.metricsPath).toBeDefined();
    expect(result.artifacts.planPath).toBeDefined();
    expect(result.artifacts.reportPath).toBeDefined();
    expect(result.stages).toHaveLength(5);
    expect(result.stages.find((stage) => stage.stageId === "security")?.toolRuns[0]).toMatchObject({
      exitCode: 0,
      status: "passed",
      tool: "aiq-security",
    });

    const lintStage = result.stages.find((stage) => stage.stageId === "lint");
    const formatStage = result.stages.find((stage) => stage.stageId === "format");
    const unitStage = result.stages.find((stage) => stage.stageId === "unit");
    const coverageStage = result.stages.find((stage) => stage.stageId === "coverage");

    if (hasShellcheck) {
      expect(lintStage?.status).toBe("passed");
      expect(lintStage?.toolRuns[0]).toMatchObject({ status: "passed", tool: "shellcheck" });
    } else {
      expect(lintStage?.status).toBe("failed");
    }

    if (hasShfmt) {
      expect(formatStage?.status).toBe("passed");
      expect(formatStage?.toolRuns[0]).toMatchObject({ status: "passed", tool: "shfmt" });
    } else {
      expect(formatStage?.status).toBe("failed");
    }

    if (hasBats) {
      expect(unitStage?.status).toBe("passed");
      expect(unitStage?.toolRuns[0]).toMatchObject({ status: "passed", tool: "bats" });
      expect(unitStage?.notes[0]).toContain("Bats ran");
    } else {
      expect(unitStage?.status).toBe("failed");
      expect(unitStage?.diagnostics[0]).toMatchObject({ source: "bats" });
    }

    if (hasBats && hasKcov) {
      expect(coverageStage?.status).toBe("passed");
      expect(coverageStage?.toolRuns[0]).toMatchObject({ status: "passed", tool: "kcov" });
      expect(coverageStage?.notes[0]).toContain("Bash coverage lines:");
    } else {
      expect(coverageStage?.status).toBe("failed");
      expect(coverageStage?.diagnostics[0]).toMatchObject({ source: hasBats ? "kcov" : "bats" });
    }
  }, 60_000);

  it.skipIf(!hasPowerShellPesterToolchain)(
    "runs PowerShell stages against the fixture project and writes canonical artifacts",
    async () => {
      const project = await createPowerShellFixtureProject("aiq-engine-powershell-");
      const hasPester = await resolvePowerShellModuleAvailable("Pester");
      const hasAnalyzer = await resolvePowerShellModuleAvailable("PSScriptAnalyzer");

      const result = await runEngine({
        context: "cli",
        manifest: {
          files: [project.sourceFile],
          source: "direct",
        },
        mode: "check",
        outDir: project.root,
        stages: ["lint", "format", "unit", "coverage", "security"],
      });

      expect(result.artifacts.metricsPath).toBeDefined();
      expect(result.artifacts.planPath).toBeDefined();
      expect(result.artifacts.reportPath).toBeDefined();
      expect(result.stages).toHaveLength(5);
      expect(
        result.stages.find((stage) => stage.stageId === "security")?.toolRuns[0],
      ).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "aiq-security",
      });

      const lintStage = result.stages.find((stage) => stage.stageId === "lint");
      const formatStage = result.stages.find((stage) => stage.stageId === "format");
      const unitStage = result.stages.find((stage) => stage.stageId === "unit");
      const coverageStage = result.stages.find((stage) => stage.stageId === "coverage");

      if (hasAnalyzer) {
        expect(lintStage?.status).toBe("passed");
        expect(lintStage?.toolRuns[0]).toMatchObject({
          status: "passed",
          tool: "psscriptanalyzer",
        });
        expect(formatStage?.status).toBe("passed");
        expect(formatStage?.toolRuns[0]).toMatchObject({
          status: "passed",
          tool: "invoke-formatter",
        });
      } else {
        expect(lintStage?.status).toBe("failed");
        expect(formatStage?.status).toBe("failed");
      }

      if (hasPester) {
        expect(unitStage?.status).toBe("passed");
        expect(unitStage?.toolRuns[0]).toMatchObject({ status: "passed", tool: "pester" });
        expect(unitStage?.notes[0]).toContain("Pester ran");

        expect(coverageStage?.status).toBe("passed");
        expect(coverageStage?.toolRuns[0]).toMatchObject({ status: "passed", tool: "pester" });
        expect(coverageStage?.notes[0]).toContain("PowerShell coverage lines:");
      } else {
        expect(unitStage?.status).toBe("failed");
        expect(unitStage?.diagnostics[0]).toMatchObject({ source: "pester" });
        expect(coverageStage?.status).toBe("failed");
        expect(coverageStage?.diagnostics[0]).toMatchObject({ source: "pester" });
      }
    },
    60_000,
  );

  it.skipIf(!hasMavenToolchain)(
    "runs Java Maven stages against the fixture project and writes canonical artifacts",
    async () => {
      const project = await createJavaMavenFixtureProject("aiq-engine-java-maven-");

      const result = await runEngine({
        context: "cli",
        manifest: {
          files: [project.sourceFile],
          source: "direct",
        },
        mode: "check",
        outDir: project.root,
        stages: [
          "lint",
          "format",
          "typecheck",
          "unit",
          "coverage",
          "complexity",
          "maintainability",
          "security",
        ],
      });

      expect(result.ok).toBe(true);
      expect(result.summary.diagnosticCount).toBe(0);
      expect(result.summary.notImplementedStageCount).toBe(0);
      expect(result.summary.status).toBe("passed");
      expect(result.stages.find((stage) => stage.stageId === "lint")?.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "maven-spotless",
      });
      expect(result.stages.find((stage) => stage.stageId === "format")?.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "maven-spotless",
      });
      expect(
        result.stages.find((stage) => stage.stageId === "typecheck")?.toolRuns[0],
      ).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "maven-build",
      });
      expect(
        result.stages.find((stage) => stage.stageId === "coverage")?.toolRuns[0],
      ).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "maven-test-coverage",
      });
      expect(
        result.stages.find((stage) => stage.stageId === "maintainability")?.notes.join(" "),
      ).toContain("Reused cached JVM metrics");

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
          toolRuns: Array<{ cacheHit?: boolean; tool: string }>;
        }>;
        summary: { diagnosticCount: number; status: string };
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

      expect(planJson.input.files).toEqual([project.sourceFile]);
      expect(planJson.stages).toEqual([
        "lint",
        "format",
        "typecheck",
        "unit",
        "coverage",
        "complexity",
        "maintainability",
        "security",
      ]);
      expect(reportJson.summary.diagnosticCount).toBe(0);
      expect(reportJson.summary.status).toBe("passed");
      expect(
        reportJson.stages.find((stage) => stage.stageId === "coverage")?.toolRuns[0],
      ).toMatchObject({
        tool: "maven-test-coverage",
      });
      expect(
        reportJson.stages.find((stage) => stage.stageId === "maintainability")?.notes.join(" "),
      ).toContain("Reused cached JVM metrics");
      expect(metricsEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            cacheHit: true,
            event: "cache.hit",
            stageId: "maintainability",
            tool: "lizard",
          }),
        ]),
      );
    },
    120_000,
  );

  it.skipIf(!hasGradleToolchain)(
    "runs Kotlin Gradle stages against the fixture project and writes canonical artifacts",
    async () => {
      const project = await createKotlinGradleFixtureProject("aiq-engine-kotlin-gradle-");

      const result = await runEngine({
        context: "cli",
        manifest: {
          files: [project.sourceFile],
          source: "direct",
        },
        mode: "check",
        outDir: project.root,
        stages: [
          "lint",
          "format",
          "typecheck",
          "unit",
          "coverage",
          "complexity",
          "maintainability",
          "security",
        ],
      });

      expect(result.ok).toBe(true);
      expect(result.summary.diagnosticCount).toBe(0);
      expect(result.summary.notImplementedStageCount).toBe(0);
      expect(result.summary.status).toBe("passed");
      expect(result.stages.find((stage) => stage.stageId === "lint")?.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "gradle-spotless",
      });
      expect(
        result.stages.find((stage) => stage.stageId === "typecheck")?.toolRuns[0],
      ).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "gradle-build",
      });
      expect(
        result.stages.find((stage) => stage.stageId === "coverage")?.toolRuns[0],
      ).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "gradle-test-coverage",
      });
      expect(
        result.stages.find((stage) => stage.stageId === "maintainability")?.notes.join(" "),
      ).toContain("Reused cached JVM metrics");
    },
    120_000,
  );
});
