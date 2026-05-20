import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

async function readPackageJson() {
  return JSON.parse(await readProjectFile("package.json"));
}

async function readProjectFile(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("package metadata", () => {
  it("is ESM-first and targets Node.js 24+ with pnpm", async () => {
    const packageJson = await readPackageJson();

    assert.equal(packageJson.type, "module");
    assert.equal(packageJson.engines?.node, ">=24.0.0");
    assert.equal(packageJson.packageManager, "pnpm@11.0.4");
  });

  it("uses exact dependency versions", async () => {
    const packageJson = await readPackageJson();
    const versions = Object.values({
      ...packageJson.dependencies,
      ...packageJson.devDependencies
    });

    assert.ok(versions.length > 0);
    assert.deepEqual(
      versions,
      versions.filter((version) => /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version))
    );
  });

  it("does not define normal-use install lifecycle scripts", async () => {
    const packageJson = await readPackageJson();

    assert.equal(Object.hasOwn(packageJson.scripts ?? {}, "preinstall"), false);
    assert.equal(Object.hasOwn(packageJson.scripts ?? {}, "install"), false);
    assert.equal(Object.hasOwn(packageJson.scripts ?? {}, "postinstall"), false);
  });

  it("exports only implemented public surfaces", async () => {
    const packageJson = await readPackageJson();

    assert.deepEqual(packageJson.exports, {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js"
      },
      "./metadata": {
        types: "./dist/metadata/index.d.ts",
        import: "./dist/metadata/index.js"
      },
      "./registry": {
        types: "./dist/registry/index.d.ts",
        import: "./dist/registry/index.js"
      },
      "./help": {
        types: "./dist/help/index.d.ts",
        import: "./dist/help/index.js"
      },
      "./runtime": {
        types: "./dist/runtime/index.d.ts",
        import: "./dist/runtime/index.js"
      },
      "./schema": {
        types: "./dist/schema/index.d.ts",
        import: "./dist/schema/index.js"
      },
      "./errors": {
        types: "./dist/errors/index.d.ts",
        import: "./dist/errors/index.js"
      },
      "./output": {
        types: "./dist/output/index.d.ts",
        import: "./dist/output/index.js"
      },
      "./mutation": {
        types: "./dist/mutation/index.d.ts",
        import: "./dist/mutation/index.js"
      },
      "./terminal": {
        types: "./dist/terminal/index.d.ts",
        import: "./dist/terminal/index.js"
      },
      "./prompts": {
        types: "./dist/prompts/index.d.ts",
        import: "./dist/prompts/index.js"
      },
      "./redaction": {
        types: "./dist/redaction/index.d.ts",
        import: "./dist/redaction/index.js"
      }
    });
    assert.equal(Object.hasOwn(packageJson, "bin"), false);
    assert.deepEqual(packageJson.files, ["dist"]);
  });

  it("configures pnpm dependency safety gates for the project", async () => {
    const workspace = await readProjectFile("pnpm-workspace.yaml");

    assert.match(workspace, /minimumReleaseAge: 10080/);
    assert.match(workspace, /minimumReleaseAgeIgnoreMissingTime: false/);
    assert.match(workspace, /minimumReleaseAgeStrict: true/);
    assert.match(workspace, /trustPolicy: no-downgrade/);
    assert.match(workspace, /blockExoticSubdeps: true/);
    assert.match(workspace, /strictDepBuilds: true/);
    assert.match(workspace, /verifyDepsBeforeRun: error/);
    assert.match(workspace, /savePrefix: ""/);
  });
});
