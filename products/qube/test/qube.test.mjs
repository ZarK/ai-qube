import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { findQubeComponent, planQubeCli, resolveCommand } from "../dist/index.js";

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
    const dir = mkdtempSync(path.join(tmpdir(), "qube-bin-"));
    const command = process.platform === "win32" ? "aib.cmd" : "aib";
    const commandPath = path.join(dir, command);
    await mkdir(dir, { recursive: true });
    await writeFile(commandPath, process.platform === "win32" ? "@echo off\r\necho aib %*\r\n" : "#!/usr/bin/env sh\necho aib \"$@\"\n");
    if (process.platform !== "win32") await chmod(commandPath, 0o755);

    const env = { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`, OS: process.env.OS };
    assert.equal(resolveCommand("aib", { cwd: path.resolve("."), env }), commandPath);

    const planned = planQubeCli(["run", "aib", "--", "init", "--dry-run"], { cwd: path.resolve("."), env });
    assert.equal(planned.exitCode, 0);
    assert.equal(planned.dispatch?.component.command, "aib");
    assert.deepEqual(planned.dispatch?.args, ["init", "--dry-run"]);
  });

  it("dispatches to resolved component command shims", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "qube-dispatch-"));
    const command = process.platform === "win32" ? "aib.cmd" : "aib";
    const commandPath = path.join(dir, command);
    await mkdir(dir, { recursive: true });
    await writeFile(commandPath, process.platform === "win32" ? "@echo off\r\necho dispatched %*\r\n" : "#!/usr/bin/env sh\necho dispatched \"$@\"\n");
    if (process.platform !== "win32") await chmod(commandPath, 0o755);

    const result = runCli(["aib", "status", "--json"], {
      env: {
        PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
        OS: process.env.OS
      }
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /dispatched status --json/);
  });

  it("returns an actionable error when a component command is unavailable", () => {
    const component = findQubeComponent("@tjalve/aiq");
    assert.equal(component?.command, "aiq");

    const result = planQubeCli(["run", "aiq"], { cwd: path.resolve("."), env: { PATH: "" } });
    assert.equal(result.exitCode, 4);
    assert.match(result.stderr, /Cannot find aiq/);
    assert.match(result.stderr, /Install the standalone package/);
  });
});
