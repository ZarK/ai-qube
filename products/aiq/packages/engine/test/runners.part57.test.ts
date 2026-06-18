import { describe, expect, it } from "vitest";
import { mkdtemp, os, path, runPlannedTask, tempDirs, writeFile } from "./runners-test-support.js";
describe("engine runners", () => {
  it("runs the shared security scan across the supported source and config file types", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-security-runner-"));
    tempDirs.push(tempDir);

    const flaggedFiles = [
      {
        content: 'export const token = "ghp_123456789012345678901234567890123456";\n',
        name: "secret.ts",
      },
      {
        content: '{"token":"ghp_123456789012345678901234567890123456"}\n',
        name: "secret.json",
      },
      {
        content: 'token = "ghp_123456789012345678901234567890123456"\n',
        name: "secret.py",
      },
      {
        content: 'token="ghp_123456789012345678901234567890123456"\n',
        name: "secret.sh",
      },
      {
        content: '@test "leaks a token" {\n  token="ghp_123456789012345678901234567890123456"\n}\n',
        name: "secret.bats",
      },
      {
        content: '$Token = "ghp_123456789012345678901234567890123456"\n',
        name: "secret.ps1",
      },
      {
        content: '<meta name="token" content="ghp_123456789012345678901234567890123456">\n',
        name: "secret.html",
      },
      {
        content: 'body { --token: "ghp_123456789012345678901234567890123456"; }\n',
        name: "secret.css",
      },
      {
        content: 'token: "ghp_123456789012345678901234567890123456"\n',
        name: "secret.yaml",
      },
      {
        content: 'token: "ghp_123456789012345678901234567890123456"\n',
        name: "secret.yml",
      },
      {
        content:
          "insert into secrets(token) values ('ghp_123456789012345678901234567890123456');\n",
        name: "secret.sql",
      },
      {
        content: 'variable "token" {\n  default = "ghp_123456789012345678901234567890123456"\n}\n',
        name: "secret.tf",
      },
      {
        content: 'token = "ghp_123456789012345678901234567890123456"\n',
        name: "secret.tfvars",
      },
      {
        content: 'token = "ghp_123456789012345678901234567890123456"\n',
        name: "secret.hcl",
      },
    ] as const;
    const flaggedPaths = await Promise.all(
      flaggedFiles.map(async ({ content, name }) => {
        const filePath = path.join(tempDir, name);
        await writeFile(filePath, content, "utf8");
        return filePath;
      }),
    );

    const result = await runPlannedTask(
      {
        fileCount: flaggedPaths.length,
        files: flaggedPaths,
        id: "test:1:security",
        stageId: "security",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        ...flaggedPaths.map((filePath) =>
          expect.objectContaining({ file: filePath, severity: "error", source: "aiq-security" }),
        ),
      ]),
    );
    expect(result.diagnostics).toHaveLength(flaggedPaths.length);
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 1,
      status: "failed",
      tool: "aiq-security",
    });
  });
});
