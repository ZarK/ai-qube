import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { findQubeComponent, planQubeCli, resolveCommand, resolveComponentCommand } from "../dist/index.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const binPath = fileURLToPath(new URL("../dist/bin/qube.js", import.meta.url));

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd: packageRoot,
    encoding: "utf8",
    env: { ...process.env, ...options.env }
  });
}

describe("qube composer CLI", () => {
  it("reports package version without invoking component tools", () => {
    const text = runCli(["--version"]);
    assert.equal(text.status, 0);
    assert.equal(text.stdout.trim(), "0.1.0");

    const json = runCli(["--version", "--json"]);
    assert.equal(json.status, 0);
    assert.deepEqual(JSON.parse(json.stdout), {
      ok: true,
      command: "version",
      package: {
        name: "@tjalve/qube",
        version: "0.1.0"
      },
      version: "0.1.0"
    });
  });

  it("lists standalone components without replacing them", () => {
    const result = runCli(["components", "--json"]);
    assert.equal(result.status, 0);

    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(
      parsed.components.map(component => [component.id, component.command, component.packageName]),
      [
        ["bootstrap", "aib", "@tjalve/aib"],
        ["executor", "aie", "@tjalve/aie"],
        ["quality", "aiq", "@tjalve/aiq"],
        ["umpire", "aiu", "@tjalve/aiu"]
      ]
    );
  });

  it("plans dispatch through the selected standalone command", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-path-cwd-"));
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-empty-package-root-"));
    const dir = mkdtempSync(path.join(tmpdir(), "qube-bin-"));
    const command = process.platform === "win32" ? "aib.cmd" : "aib";
    const commandPath = path.join(dir, command);
    await mkdir(dir, { recursive: true });
    await writeFile(commandPath, process.platform === "win32" ? "@echo off\r\necho aib %*\r\n" : "#!/usr/bin/env sh\necho aib \"$@\"\n");
    if (process.platform !== "win32") await chmod(commandPath, 0o755);

    const env = { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`, OS: process.env.OS };
    assert.equal(resolveCommand("aib", { cwd, env, packageRoot }), commandPath);

    const planned = planQubeCli(["run", "aib", "--", "init", "--dry-run"], { cwd, env, packageRoot });
    assert.equal(planned.exitCode, 0);
    assert.equal(planned.dispatch?.component.command, "aib");
    assert.equal(planned.dispatch?.resolution.source, "path");
    assert.deepEqual(planned.dispatch?.args, ["init", "--dry-run"]);

    const helpDispatch = planQubeCli(["run", "aib", "--help"], { cwd, env, packageRoot });
    assert.equal(helpDispatch.exitCode, 0);
    assert.equal(helpDispatch.dispatch?.component.command, "aib");
    assert.deepEqual(helpDispatch.dispatch?.args, ["--help"]);
  });

  it("prefers install-scoped component binaries over ambient PATH", async () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-install-root-"));
    const binDir = path.join(packageRoot, "node_modules", ".bin");
    const packageDir = path.join(packageRoot, "node_modules", "@tjalve", "aib");
    const pathDir = mkdtempSync(path.join(tmpdir(), "qube-global-bin-"));
    const command = process.platform === "win32" ? "aib.cmd" : "aib";
    const installCommandPath = path.join(binDir, command);
    const pathCommandPath = path.join(pathDir, command);
    await mkdir(binDir, { recursive: true });
    await mkdir(packageDir, { recursive: true });
    await writeFile(installCommandPath, process.platform === "win32" ? "@echo off\r\necho install-scoped %*\r\n" : "#!/usr/bin/env sh\necho install-scoped \"$@\"\n");
    await writeFile(pathCommandPath, process.platform === "win32" ? "@echo off\r\necho path %*\r\n" : "#!/usr/bin/env sh\necho path \"$@\"\n");
    await writeFile(path.join(packageDir, "package.json"), `${JSON.stringify({ name: "@tjalve/aib", version: "0.1.0" })}\n`);
    if (process.platform !== "win32") {
      await chmod(installCommandPath, 0o755);
      await chmod(pathCommandPath, 0o755);
    }

    const component = findQubeComponent("aib");
    assert.ok(component);
    const env = { PATH: `${pathDir}${path.delimiter}${process.env.PATH ?? ""}`, OS: process.env.OS };
    const resolution = resolveComponentCommand(component, { cwd: path.resolve("."), env, packageRoot });

    assert.equal(resolution?.commandPath, installCommandPath);
    assert.equal(resolution?.source, "install");
    assert.equal(resolution?.packageVersion, "0.1.0");
    assert.equal(resolveCommand("aib", { cwd: path.resolve("."), env, packageRoot }), installCommandPath);
  });

  it("refuses a stale same-package binary from PATH", async () => {
    const stalePackageRoot = mkdtempSync(path.join(tmpdir(), "qube-stale-aib-"));
    const binDir = path.join(stalePackageRoot, "bin");
    const command = process.platform === "win32" ? "aib.cmd" : "aib";
    const commandPath = path.join(binDir, command);
    await mkdir(binDir, { recursive: true });
    await writeFile(commandPath, process.platform === "win32" ? "@echo off\r\necho stale %*\r\n" : "#!/usr/bin/env sh\necho stale \"$@\"\n");
    await writeFile(path.join(stalePackageRoot, "package.json"), `${JSON.stringify({ name: "@tjalve/aib", version: "0.0.1" })}\n`);
    if (process.platform !== "win32") await chmod(commandPath, 0o755);

    const env = { PATH: binDir, OS: process.env.OS };
    const planned = planQubeCli(["run", "aib", "status"], { cwd: mkdtempSync(path.join(tmpdir(), "qube-stale-cwd-")), env, packageRoot: mkdtempSync(path.join(tmpdir(), "qube-empty-install-")) });

    assert.equal(planned.exitCode, 4);
    assert.match(planned.stderr, /Refusing aib from PATH/);
    assert.match(planned.stderr, /expected @tjalve\/aib@0\.1\.0, found 0\.0\.1/);
    assert.equal(planned.dispatch, undefined);
  });

  it("dispatches to resolved component command shims", async () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-dispatch-root-"));
    const dir = path.join(packageRoot, "node_modules", ".bin");
    const packageDir = path.join(packageRoot, "node_modules", "@tjalve", "aib");
    const command = process.platform === "win32" ? "aib.cmd" : "aib";
    const commandPath = path.join(dir, command);
    await mkdir(dir, { recursive: true });
    await mkdir(packageDir, { recursive: true });
    await writeFile(commandPath, process.platform === "win32" ? "@echo off\r\necho dispatched %*\r\n" : "#!/usr/bin/env sh\necho dispatched \"$@\"\n");
    await writeFile(path.join(packageDir, "package.json"), `${JSON.stringify({ name: "@tjalve/aib", version: "0.1.0" })}\n`);
    if (process.platform !== "win32") await chmod(commandPath, 0o755);

    const result = runCli(["aib", "status", "--json"], {
      env: {
        PATH: process.env.PATH ?? "",
        QUBE_TEST_PACKAGE_ROOT: packageRoot,
        OS: process.env.OS
      }
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /dispatched status --json/);
  });

  it("returns an actionable error when a component command is unavailable", () => {
    const component = findQubeComponent("@tjalve/aiq");
    assert.equal(component?.command, "aiq");

    const result = planQubeCli(["run", "aiq"], {
      cwd: mkdtempSync(path.join(tmpdir(), "qube-missing-cwd-")),
      env: { PATH: "" },
      packageRoot: mkdtempSync(path.join(tmpdir(), "qube-missing-root-"))
    });
    assert.equal(result.exitCode, 4);
    assert.match(result.stderr, /Cannot find aiq/);
    assert.match(result.stderr, /Install QUBE with its component dependencies/);
  });
});
