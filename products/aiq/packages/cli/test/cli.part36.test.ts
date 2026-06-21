import { describe, expect, it } from "vitest";
import {
  MemoryInput,
  MemoryOutput,
  mkdir,
  mkdtemp,
  os,
  path,
  runCli,
  tempDirs,
  writeFile,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("walks up to parent config and lets invocation stages override it", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-config-parent-"));
    tempDirs.push(tempDir);

    const nestedDir = path.join(tempDir, "packages", "app");
    await mkdir(path.join(tempDir, ".qube", "aiq"), { recursive: true });
    await mkdir(path.join(nestedDir, "src"), { recursive: true });
    await writeFile(path.join(nestedDir, "src/index.ts"), "export const nested = true;\n", "utf8");
    await writeFile(
      path.join(tempDir, ".qube", "aiq", "config.json"),
      `${JSON.stringify(
        {
          version: 1,
          profiles: {
            standard: {
              changedOnly: false,
              stages: ["lint", "unit"],
            },
          },
          surfaces: {
            cli: {
              profile: "standard",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      ["node", "aiq", "plan", "src/index.ts", "--stage", "security", "--format", "json"],
      {
        cwd: nestedDir,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");

    const output = JSON.parse(stdout.value) as { stages: string[]; profile: string };
    expect(output.profile).toBe("standard");
    expect(output.stages).toEqual(["security"]);
  });

  it("lets invocation profile override the surface default profile", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-config-profile-"));
    tempDirs.push(tempDir);
    await mkdir(path.join(tempDir, ".qube", "aiq"), { recursive: true });
    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(path.join(tempDir, "src/index.ts"), "export const profile = true;\n", "utf8");
    await writeFile(
      path.join(tempDir, ".qube", "aiq", "config.json"),
      `${JSON.stringify(
        {
          version: 1,
          profiles: {
            deep: {
              changedOnly: false,
              stages: ["security"],
            },
          },
          surfaces: {
            cli: {
              profile: "fast",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      ["node", "aiq", "plan", "src/index.ts", "--profile", "deep", "--format", "json"],
      {
        cwd: tempDir,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");

    const output = JSON.parse(stdout.value) as { stages: string[]; profile: string };
    expect(output.profile).toBe("deep");
    expect(output.stages).toEqual(["security"]);
  });
});
