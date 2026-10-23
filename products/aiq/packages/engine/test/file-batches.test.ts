import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { batchFileArguments, fileArgumentBudget } from "../src/file-batches.js";
import { runPlannedTask } from "../src/runners.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("file argument batches", () => {
  it("preserves every file in bounded batches with quoting space", () => {
    const files = Array.from(
      { length: 970 },
      (_, index) => `C:/source files/${index}/${"name".repeat(30)}.ts`,
    );
    const batches = batchFileArguments(files);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toEqual(files);
    for (const batch of batches) {
      expect(batch.reduce((size, file) => size + file.length * 2 + 4, 0)).toBeLessThanOrEqual(
        fileArgumentBudget,
      );
    }
    expect(batchFileArguments([])).toEqual([]);
    expect(() => batchFileArguments(["x".repeat(fileArgumentBudget)])).toThrow(
      "command-line budget",
    );
  });

  it("runs a large Biome selection and retains diagnostics from every batch", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "aiq-file-batches-"));
    directories.push(directory);
    const argumentLength = Math.max(32_000, fileArgumentBudget * 2);
    const filePath = (index: number) =>
      path.join(directory, `${"source".repeat(10)}-${index}.json`);
    const fileCount = Math.floor(argumentLength / filePath(0).length) + 1;
    const files = Array.from({ length: fileCount }, (_, index) => filePath(index));
    await Promise.all(files.map((file) => writeFile(file, '{"value" :1}\n', "utf8")));
    expect(files.join(" ").length).toBeGreaterThan(argumentLength);
    const result = await runPlannedTask(
      {
        fileCount: files.length,
        files,
        id: "format:documents",
        stageId: "format",
      },
      directory,
    );
    expect(result.status).toBe("failed");
    expect(result.toolRuns.length).toBeGreaterThan(1);
    expect(new Set(result.diagnostics.map((diagnostic) => diagnostic.file))).toEqual(
      new Set(files),
    );
    expect(result.toolRuns.every((toolRun) => toolRun.args.join(" ").length < 8_000)).toBe(true);
  }, 20_000);
});
