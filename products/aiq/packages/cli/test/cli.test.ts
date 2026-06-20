import { describe, expect, it } from "vitest";
import {
  MemoryInput,
  MemoryOutput,
  access,
  cliPackageJsonPath,
  createTypeScriptFixtureProject,
  mkdtemp,
  os,
  path,
  publishedPackageWorkspaces,
  readFile,
  repoRoot,
  runCli,
  tempDirs,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("prints the package version without first-run side effects", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-version-"));
    tempDirs.push(tempDir);
    const packageJson = JSON.parse(await readFile(cliPackageJsonPath, "utf8")) as {
      name: string;
      version: string;
    };
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "--version"], {
      cwd: tempDir,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toBe(`${packageJson.version}\n`);
    await expect(access(path.join(tempDir, ".aiq"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prints the package version envelope as JSON", async () => {
    const packageJson = JSON.parse(await readFile(cliPackageJsonPath, "utf8")) as {
      name: string;
      version: string;
    };
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "quality", "--version", "--json"], {
      cwd: process.cwd(),
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(JSON.parse(stdout.value)).toEqual({
      ok: true,
      command: "version",
      package: { name: packageJson.name, version: packageJson.version },
      version: packageJson.version,
    });
  });

  it("keeps -v reserved for version output", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-short-version-");
    const packageJson = JSON.parse(await readFile(cliPackageJsonPath, "utf8")) as {
      version: string;
    };
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "-v"], {
      cwd: project.root,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toBe(`${packageJson.version}\n`);
  });

  it("keeps published package metadata aligned with the clean repository", async () => {
    for (const workspace of publishedPackageWorkspaces) {
      const packageJson = JSON.parse(
        await readFile(path.join(repoRoot, workspace, "package.json"), "utf8"),
      ) as {
        bin?: Record<string, string>;
        dependencies?: Record<string, string>;
        description?: string;
        files: string[];
        name: string;
        publishConfig: { access: string; provenance: boolean };
        repository: { directory: string; type: string; url: string };
        version: string;
      };

      expect(packageJson.name).toBe("@tjalve/aiq");
      expect(packageJson.description).toContain("remediation guidance");
      expect(packageJson.publishConfig).toEqual({ access: "public", provenance: true });
      expect(packageJson.repository).toEqual({
        directory: workspace,
        type: "git",
        url: "git+https://github.com/ZarK/ai-quality.git",
      });
      expect(packageJson.files).toContain("dist");
      expect(
        Object.values(packageJson.bin ?? {}).every((binPath) => !binPath.startsWith("./")),
      ).toBe(true);

      for (const [dependencyName, dependencyVersion] of Object.entries(
        packageJson.dependencies ?? {},
      )) {
        expect(dependencyName.startsWith("@tjalve/aiq-")).toBe(false);
        if (dependencyName === "@tjalve/aiq") {
          expect(dependencyVersion).toBe(packageJson.version);
        }
      }
    }

    const packageReadme = await readFile(path.join(repoRoot, "packages", "cli", "README.md"), {
      encoding: "utf8",
    });
    expect(packageReadme).toContain(
      "Metric stages enforce SLOC, complexity, maintainability, and readability defaults for source and test code.",
    );
    expect(packageReadme).toContain("AIQ uses repository-native tool configs by default.");
    expect(packageReadme).toContain("Existing Biome config, `tsconfig.json`, Vitest/Jest config");
    expect(packageReadme).toContain("Default text output is compact");
    expect(packageReadme).toContain("Use `--verbose` for run metadata");
    expect(packageReadme).toContain("Use `--format json` for the complete machine-readable report");
    expect(packageReadme).toContain(
      "Treat metric remediation as behavior-preserving work, not architecture redesign.",
    );
    expect(packageReadme).toContain("Preserve public APIs, command behavior, tool selection");
    expect(packageReadme).toContain(
      "Do not use metric failures as authorization for feature changes",
    );
    expect(packageReadme).toContain("direct purpose-revealing names");
  });
});
