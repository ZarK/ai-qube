import { describe, expect, it } from "vitest";
import {
  MemoryInput,
  MemoryOutput,
  countOccurrences,
  mkdir,
  mkdtemp,
  os,
  path,
  runCli,
  tempDirs,
  writeFile,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("deduplicates repeated missing setup guidance in default text output", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-repeated-setup-"));
    tempDirs.push(tempDir);
    const projectRoots = [path.join(tempDir, "one"), path.join(tempDir, "two")];
    for (const projectRoot of projectRoots) {
      await mkdir(projectRoot, { recursive: true });
      await writeFile(
        path.join(projectRoot, "go.mod"),
        "module example.com/aiq\n\ngo 1.22\n",
        "utf8",
      );
      await writeFile(
        path.join(projectRoot, "main.go"),
        "package main\n\nfunc main() {}\n",
        "utf8",
      );
    }

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const originalPath = process.env.PATH;
    process.env.PATH = "";

    try {
      const exitCode = await runCli(
        [
          "node",
          "aiq",
          "run",
          path.join("one", "main.go"),
          path.join("two", "main.go"),
          "--stage",
          "sloc",
        ],
        {
          cwd: tempDir,
          stderr,
          stdin: new MemoryInput(),
          stdout,
        },
      );

      expect(exitCode).toBe(1);
      expect(stderr.value).toBe("");
      expect(stdout.value).toContain("Status: failed");
      expect(stdout.value).toContain("Problems:");
      expect(stdout.value).toContain("Next: aiq setup");
      expect(countOccurrences(stdout.value, "lizard was not detected")).toBeLessThanOrEqual(1);
      expect(countOccurrences(stdout.value, "aiq setup")).toBeLessThanOrEqual(2);
      expect(stdout.value).not.toContain("Artifacts:");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("keeps external missing-tool setup guidance in JSON output", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-go-missing-lizard-json-"));
    tempDirs.push(tempDir);
    await writeFile(path.join(tempDir, "go.mod"), "module example.com/aiq\n\ngo 1.22\n", "utf8");
    await writeFile(path.join(tempDir, "main.go"), "package main\n\nfunc main() {}\n", "utf8");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const originalPath = process.env.PATH;
    process.env.PATH = "";

    try {
      const exitCode = await runCli(
        ["node", "aiq", "run", "main.go", "--stage", "sloc", "--format", "json"],
        {
          cwd: tempDir,
          stderr,
          stdin: new MemoryInput(),
          stdout,
        },
      );

      const output = JSON.parse(stdout.value) as {
        stages: Array<{ diagnostics: Array<{ message: string; source: string }> }>;
      };
      const diagnostic = output.stages[0]?.diagnostics[0];

      expect(exitCode).toBe(1);
      expect(stderr.value).toBe("");
      expect(diagnostic).toMatchObject({
        source: "lizard",
        message: expect.stringContaining("Run aiq setup"),
      });
      expect(diagnostic?.message).not.toContain("spawn");
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
