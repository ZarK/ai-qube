import { describe, expect, it } from "vitest";
import {
  MemoryInput,
  MemoryOutput,
  mkdtemp,
  os,
  path,
  runCli,
  tempDirs,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("reports doctor checks and universal optional prerequisites in human-readable form", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-doctor-"));
    tempDirs.push(tempDir);
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "doctor"], {
      cwd: tempDir,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("AIQ doctor");
    expect(stdout.value).toContain("Config:");
    expect(stdout.value).toContain("Progress:");
    expect(stdout.value).toContain("Technologies:");
    expect(stdout.value).toContain("Node.js runtime");
    expect(stdout.value).toContain("Status:");
    expect(stdout.value).not.toContain("OK Git - not detected");
  });

  it("reports optional universal doctor prerequisites without failing the command", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-doctor-missing-"));
    tempDirs.push(tempDir);
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const originalPath = process.env.PATH;
    process.env.PATH = "";

    try {
      const exitCode = await runCli(["node", "aiq", "doctor", "--format", "json"], {
        cwd: tempDir,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      });

      expect(exitCode).toBe(0);
      expect(stderr.value).toBe("");
      const output = JSON.parse(stdout.value) as {
        checks: Array<{
          detail?: string;
          name: string;
          ok: boolean;
          required?: boolean;
          source?: string;
        }>;
        detectedTech: string[];
        ok: boolean;
      };
      expect(output.ok).toBe(true);
      expect(output.detectedTech).toEqual([]);
      expect(output.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "Node.js runtime", ok: true }),
          expect.objectContaining({ name: "npm package manager", ok: true }),
          expect.objectContaining({ name: "Git", ok: true }),
        ]),
      );
      expect(output.checks.find((check) => check.name === "Git")).toMatchObject({
        detail: expect.stringContaining("not detected"),
        required: false,
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
