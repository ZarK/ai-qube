import { describe, expect, it } from "vitest";
import {
  chmod,
  createCustomJavaScriptE2eProject,
  mkdir,
  path,
  runPlannedTask,
  writeFile,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it("runs e2e through a configured Playwright project", async () => {
    const project = await createCustomJavaScriptE2eProject({
      packageJson: {
        devDependencies: {
          "@playwright/test": "1.0.0",
        },
        name: "aiq-js-e2e-playwright",
        private: true,
        scripts: {},
      },
      prefix: "aiq-js-e2e-playwright-",
    });
    const playwrightSummary = {
      suites: [{ specs: [{ tests: [{ results: [{ status: "passed" }] }] }] }],
    };
    await writeFile(
      path.join(project.root, "playwright.config.ts"),
      "export default {};\n",
      "utf8",
    );
    await writeFile(
      path.join(project.root, "playwright.cjs"),
      `console.log(${JSON.stringify(JSON.stringify(playwrightSummary))});\n`,
      "utf8",
    );
    const binDir = path.join(project.root, "node_modules", ".bin");
    await mkdir(binDir, { recursive: true });
    const playwrightBin =
      process.platform === "win32"
        ? path.join(binDir, "playwright.cmd")
        : path.join(binDir, "playwright");
    await writeFile(
      playwrightBin,
      process.platform === "win32"
        ? `@echo off\r\nnode "%~dp0\\..\\..\\playwright.cjs" %*\r\n`
        : `#!/usr/bin/env node\nrequire("../../playwright.cjs");\n`,
      "utf8",
    );
    if (process.platform !== "win32") {
      await chmod(playwrightBin, 0o755);
    }

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:e2e-js-playwright",
        stageId: "e2e",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.notes[0]).toBe("Playwright ran 1 e2e test: 1 passed, 0 failed.");
    expect(result.toolRuns[0]).toMatchObject({
      args: [
        "test",
        "--config",
        path.join(project.root, "playwright.config.ts"),
        "--reporter=json",
      ],
      status: "passed",
      tool: "playwright",
    });
  });

  it("runs e2e through an explicit package e2e script", async () => {
    const project = await createCustomJavaScriptE2eProject({
      e2eScript: "node e2e.cjs",
      prefix: "aiq-js-e2e-script-",
    });
    await writeFile(path.join(project.root, "e2e.cjs"), "process.exit(0);\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:e2e-js-script",
        stageId: "e2e",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.notes[0]).toBe("E2E script passed.");
    expect(result.toolRuns[0]).toMatchObject({
      args: ["run", "aiq:e2e", "--"],
      status: "passed",
      tool: "e2e",
    });
  });
});
