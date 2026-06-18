import { describe, expect, it } from "vitest";
import {
  fixtureTsconfig,
  lintFailureFixtureFile,
  mkdir,
  mkdtemp,
  os,
  path,
  readFile,
  runPlannedTask,
  tempDirs,
  writeFile,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it("runs Biome lint and returns structured diagnostics", async () => {
    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [lintFailureFixtureFile],
        id: "test:1:lint",
        stageId: "lint",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]).toMatchObject({
      code: "lint/style/noVar",
      file: lintFailureFixtureFile,
      severity: "error",
      source: "biome",
    });
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 1,
      status: "failed",
      tool: "biome",
    });
  });

  it("respects repository Biome config before linting", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-biome-native-config-"));
    tempDirs.push(tempDir);

    const sourceFile = path.join(tempDir, "index.ts");
    await writeFile(
      path.join(tempDir, "biome.json"),
      `${JSON.stringify({ linter: { rules: { style: { noVar: "off" } } } }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(sourceFile, "var value = 1;\nexport { value };\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [sourceFile],
        id: "test:1:lint-biome-native-config",
        stageId: "lint",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.notes[0]).toContain(path.join(tempDir, "biome.json"));
    expect(result.toolRuns[0]?.args).toContain(`--config-path=${path.join(tempDir, "biome.json")}`);
  });

  it("does not pass a Biome config when selected files do not share one", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-biome-partial-native-config-"));
    tempDirs.push(tempDir);

    const configuredDir = path.join(tempDir, "configured");
    await mkdir(configuredDir, { recursive: true });
    const configuredFile = path.join(configuredDir, "index.ts");
    const defaultFile = path.join(tempDir, "index.ts");
    await writeFile(
      path.join(configuredDir, "biome.json"),
      `${JSON.stringify({ linter: { rules: { style: { noVar: "off" } } } }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(configuredFile, "export const configured = 1;\n", "utf8");
    await writeFile(defaultFile, "export const fallback = 1;\n", "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 2,
        files: [configuredFile, defaultFile],
        id: "test:1:lint-biome-partial-native-config",
        stageId: "lint",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.toolRuns[0]?.args.some((arg) => arg.startsWith("--config-path="))).toBe(false);
  });

  it("runs TypeScript typecheck and parses real compiler diagnostics", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-tsc-runner-"));
    tempDirs.push(tempDir);

    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(
      path.join(tempDir, "tsconfig.json"),
      await readFile(fixtureTsconfig, "utf8"),
      "utf8",
    );

    const brokenFile = path.join(tempDir, "src", "index.ts");
    await writeFile(
      brokenFile,
      "const value: string = 42;\nexport const broken = value;\n",
      "utf8",
    );

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [brokenFile],
        id: "test:1:typecheck",
        stageId: "typecheck",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]).toMatchObject({
      code: "TS2322",
      file: brokenFile,
      severity: "error",
      source: "tsc",
    });
    expect(result.diagnostics[0]?.range).toMatchObject({
      startColumn: 7,
      startLine: 1,
    });
    expect(result.toolRuns[0]).toMatchObject({
      status: "failed",
      tool: "tsc",
    });
  });
});
