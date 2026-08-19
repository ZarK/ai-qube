import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import { buildShellCommandPlan } from "../dist/process_launch.js";

describe("cross-platform process launch", () => {
  it("uses cmd.exe directly for Windows command strings and cmd shims", () => {
    assert.deepEqual(buildShellCommandPlan("pnpm.cmd run verify", "win32"), {
      executable: "cmd.exe",
      args: ["/d", "/s", "/c", '"pnpm.cmd run verify"'],
      windowsVerbatimArguments: true,
    });
  });

  it("uses the POSIX command interpreter directly on Linux and macOS", () => {
    for (const platform of ["linux", "darwin"]) {
      assert.deepEqual(buildShellCommandPlan("pnpm run verify", platform), {
        executable: "/bin/sh",
        args: ["-c", "pnpm run verify"],
        windowsVerbatimArguments: false,
      });
    }
  });

  it("rejects an empty command before process launch", () => {
    assert.throws(() => buildShellCommandPlan("   ", "win32"), /must not be empty/);
  });

  it("executes the current platform plan without shell mode", () => {
    const command = `"${process.execPath}" -e "process.stdout.write('qube-process-ok')"`;
    const plan = buildShellCommandPlan(command);
    const result = spawnSync(plan.executable, plan.args, {
      encoding: "utf8",
      shell: false,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      windowsHide: true,
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "qube-process-ok");
  });
});
