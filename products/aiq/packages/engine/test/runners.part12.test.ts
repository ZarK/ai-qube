import { describe, expect, it } from "vitest";
import {
  createCustomJavaScriptE2eProject,
  mkdtemp,
  os,
  path,
  runPlannedTask,
  tempDirs,
  writeFile,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it("passes e2e as noop when no JavaScript or TypeScript project files are selected", async () => {
    const textFile = path.join(await mkdtemp(path.join(os.tmpdir(), "aiq-e2e-no-js-")), "note.txt");
    tempDirs.push(path.dirname(textFile));
    await writeFile(textFile, "notes\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [textFile],
        id: "test:1:e2e-no-js",
        stageId: "e2e",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.toolRuns).toEqual([]);
    expect(result.notes[0]).toContain("No supported files were selected for e2e.");
  });

  it("fails e2e when a JavaScript package has no configured e2e runner", async () => {
    const project = await createCustomJavaScriptE2eProject({
      prefix: "aiq-js-e2e-none-",
    });

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:e2e-js-none",
        stageId: "e2e",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.toolRuns).toEqual([]);
    expect(result.notes[0]).toContain("No e2e runner is configured");
    expect(result.diagnostics[0]).toMatchObject({
      file: project.packageJsonPath,
      severity: "error",
      source: "aiq-e2e",
    });
  });

  it("runs e2e through a configured agent-browser audit script", async () => {
    const project = await createCustomJavaScriptE2eProject({
      e2eScript: "node e2e.cjs --agent-browser",
      prefix: "aiq-js-e2e-agent-browser-",
    });
    await writeFile(path.join(project.root, "e2e.cjs"), "process.exit(0);\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:e2e-js-agent-browser",
        stageId: "e2e",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.notes[0]).toBe("Agent-browser e2e audit passed.");
    expect(result.toolRuns[0]).toMatchObject({
      args: ["run", "aiq:e2e", "--"],
      status: "passed",
      tool: "agent-browser",
    });
  });
});
