import { describe, expect, it } from "vitest";
import {
  os,
  path,
  MemoryInput,
  MemoryOutput,
  mkdir,
  mkdtemp,
  readFile,
  runCli,
  tempDirs,
  writeFile,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("renders unsupported project runner output as failed text without placeholder status", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-unsupported-runner-"));
    tempDirs.push(tempDir);
    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(
      path.join(tempDir, "package.json"),
      `${JSON.stringify({ name: "unsupported-runner", scripts: { test: "node test.js" } }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(path.join(tempDir, "src", "index.ts"), "export const value = 1;\n", "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      ["node", "aiq", "run", "src/index.ts", "--stage", "unit", "--out-dir", tempDir],
      {
        cwd: tempDir,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("Total execution time:");
    expect(stdout.value).toContain("): FAILED");
    expect(stdout.value).toContain("Unsupported JavaScript/TypeScript test configuration");
    expect(stdout.value).not.toContain("Status: not_implemented");
    expect(stdout.value).not.toContain("not_implemented");
    expect(stdout.value).not.toContain("rewrite foundation slice");

    const reportJson = await readFile(path.join(tempDir, "aiq.report.json"), "utf8");
    expect(reportJson).not.toContain("not_implemented");
    expect(reportJson).not.toContain("rewrite foundation slice");
  });

  it("groups Python missing setup failures in text output", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-python-missing-setup-"));
    tempDirs.push(tempDir);
    await writeFile(path.join(tempDir, "main.py"), "print('hello')\n", "utf8");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const originalPath = process.env.PATH;
    process.env.PATH = "";

    try {
      const exitCode = await runCli(["node", "aiq", "run", "main.py", "--stage", "typecheck"], {
        cwd: tempDir,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      });

      expect(exitCode).toBe(1);
      expect(stderr.value).toBe("");
      expect(stdout.value).toContain("was not detected");
      expect(stdout.value).toContain("Stage 3 (typecheck): FAILED");
      expect(stdout.value).toContain("--verbose  # Debug stage");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("groups external-tool language setup failures in text output", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-go-missing-lizard-"));
    tempDirs.push(tempDir);
    await writeFile(path.join(tempDir, "go.mod"), "module example.com/aiq\n\ngo 1.22\n", "utf8");
    await writeFile(path.join(tempDir, "main.go"), "package main\n\nfunc main() {}\n", "utf8");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const originalPath = process.env.PATH;
    process.env.PATH = "";

    try {
      const exitCode = await runCli(["node", "aiq", "run", "main.go", "--stage", "sloc"], {
        cwd: tempDir,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      });

      expect(exitCode).toBe(1);
      expect(stderr.value).toBe("");
      expect(stdout.value).toContain("was not detected");
      expect(stdout.value).toContain("Stage 5 (sloc): FAILED");
      expect(stdout.value).toContain("lizard");
      expect(stdout.value).toContain("--verbose  # Debug stage");
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
