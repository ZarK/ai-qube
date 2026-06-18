import { describe, expect, it } from "vitest";
import {
  MemoryInput,
  MemoryOutput,
  mkdir,
  mkdtemp,
  os,
  path,
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
    expect(stdout.value).toContain("AIQ run");
    expect(stdout.value).toContain("Status: failed");
    expect(stdout.value).toContain("- Unsupported projects:");
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
      expect(stdout.value).toContain("Missing tools:");
      expect(stdout.value).toContain("[stage 3 typecheck]");
      expect(stdout.value).toContain("aiq setup");
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
      expect(stdout.value).toContain("Missing tools:");
      expect(stdout.value).toContain("[stage 5 sloc]");
      expect(stdout.value).toContain("lizard");
      expect(stdout.value).toContain("aiq setup");
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
