import { describe, expect, it } from "vitest";
import {
  fixtureFile,
  fixturePythonFile,
  hasPythonQualityToolchain,
  mkdir,
  mkdtemp,
  os,
  path,
  runPlannedTask,
  tempDirs,
  vitestCliPath,
  writeFile,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it.skipIf(!hasPythonQualityToolchain)(
    "combines TypeScript and Python typecheck results in one stage",
    async () => {
      const result = await runPlannedTask(
        {
          fileCount: 2,
          files: [fixtureFile, fixturePythonFile],
          id: "test:1:typecheck-mixed",
          stageId: "typecheck",
        },
        process.cwd(),
      );

      expect(result.status).toBe("passed");
      expect(result.diagnostics).toEqual([]);
      expect(result.toolRuns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ exitCode: 0, status: "passed", tool: "tsc" }),
          expect.objectContaining({ exitCode: 0, status: "passed", tool: "ty" }),
        ]),
      );
    },
  );

  it("detects Vitest projects through common config file variants", async () => {
    const variants = [
      {
        configFileName: "vitest.config.cjs",
        configSource: "module.exports = {};\n",
        tempPrefix: "aiq-vitest-config-cjs-",
      },
      {
        configFileName: "vitest.config.cts",
        configSource: "export default {};\n",
        tempPrefix: "aiq-vitest-config-cts-",
      },
    ];

    for (const variant of variants) {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), variant.tempPrefix));
      tempDirs.push(tempDir);

      await mkdir(path.join(tempDir, "src"), { recursive: true });
      await writeFile(
        path.join(tempDir, "package.json"),
        `${JSON.stringify({ name: variant.tempPrefix, private: true, scripts: { test: "node runner.cjs" } }, null, 2)}\n`,
        "utf8",
      );
      await writeFile(path.join(tempDir, variant.configFileName), variant.configSource, "utf8");
      await writeFile(
        path.join(tempDir, "runner.cjs"),
        [
          'const { spawnSync } = require("node:child_process");',
          `const result = spawnSync(process.execPath, [${JSON.stringify(vitestCliPath)}, ...process.argv.slice(2)], { stdio: "inherit" });`,
          "process.exit(result.status ?? 1);",
          "",
        ].join("\n"),
        "utf8",
      );

      const sourceFile = path.join(tempDir, "src", "index.ts");
      await writeFile(sourceFile, "export const value = 1;\n", "utf8");
      await writeFile(
        path.join(tempDir, "src", "index.test.ts"),
        [
          'import { describe, expect, it } from "vitest";',
          'import { value } from "./index";',
          "",
          'describe("config detection", () => {',
          '  it("passes", () => {',
          "    expect(value).toBe(1);",
          "  });",
          "});",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [sourceFile],
          id: `test:1:unit-${variant.configFileName}`,
          stageId: "unit",
        },
        process.cwd(),
      );

      expect(result.status).toBe("passed");
      expect(result.diagnostics).toEqual([]);
      expect(result.notes[0]).toContain("Vitest ran");
      expect(result.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "vitest",
      });
    }
  });
});
