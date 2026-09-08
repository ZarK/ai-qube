import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  assertNoSourceCheckoutRunner,
  assertPackDirOutsideCheckout,
  installedBinDir,
  parseVerifyInstalledArgs,
  probeInstalledCommand,
  resolveInstalledCommand,
  runInstalledCommandVerification,
  selectPreparedReleasePackages,
} from "../scripts/verify-installed-commands.mjs";
import { assertPrefixOutsideCheckout } from "../scripts/local-install-qube.mjs";
import { buildArgvCommandPlan } from "../scripts/process-launch.mjs";
import { resolvePublishTag } from "../scripts/publish-packages.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function writeShim(prefix, command, body, exitCode = 0) {
  const binDir = path.join(prefix, "bin");
  mkdirSync(binDir, { recursive: true });
  const unix = path.join(binDir, command);
  const windows = path.join(process.platform === "win32" ? prefix : binDir, `${command}.cmd`);
  writeFileSync(unix, `#!/bin/sh\n${body}\nexit ${exitCode}\n`);
  try {
    chmodSync(unix, 0o755);
  } catch {
    // Windows filesystems may reject POSIX mode bits.
  }
  writeFileSync(windows, `@echo off\r\n${body}\r\nexit /b ${exitCode}\r\n`);
}

function writeIssueCommandShim(prefix, command, doctorOutput, doctorExitCode = 1) {
  const binDir = path.join(prefix, "bin");
  mkdirSync(binDir, { recursive: true });
  const unix = path.join(binDir, command);
  const windows = path.join(process.platform === "win32" ? prefix : binDir, `${command}.cmd`);
  writeFileSync(unix, `#!/bin/sh
if [ "$1" = "doctor" ] || { [ "$1" = "aie" ] && [ "$2" = "doctor" ]; }; then
  printf '%s\\n' '${doctorOutput}'
  exit ${doctorExitCode}
fi
printf '%s\\n' '{"ok":true}'
exit 0
`);
  try {
    chmodSync(unix, 0o755);
  } catch {
    // Windows filesystems may reject POSIX mode bits.
  }
  writeFileSync(windows, `@echo off\r\nif "%~1"=="doctor" goto doctor\r\nif "%~1"=="aie" if "%~2"=="doctor" goto doctor\r\necho {"ok":true}\r\nexit /b 0\r\n:doctor\r\necho ${doctorOutput}\r\nexit /b ${doctorExitCode}\r\n`);
}

describe("installed command verification", () => {
  it("parses plan and prefix flags", () => {
    assert.deepEqual(parseVerifyInstalledArgs(["--json", "--plan", "publish-plan.json", "--skip-pack"]), {
      json: true,
      help: false,
      releaseSet: false,
      plan: "publish-plan.json",
      prefix: undefined,
      repoRoot: undefined,
      packDir: undefined,
      skipPack: true,
      commands: undefined,
    });
  });

  it("parses the prepared release set and rejects ambiguous selection", () => {
    assert.equal(parseVerifyInstalledArgs(["--release-set", "--json"]).releaseSet, true);
    assert.throws(
      () => parseVerifyInstalledArgs(["--release-set", "--plan", "publish-plan.json"]),
      { reasonCode: "usage" },
    );
    assert.throws(
      () => parseVerifyInstalledArgs(["--release-set", "--command", "qube"]),
      { reasonCode: "usage" },
    );
  });

  it("uses direct process execution on POSIX and cmd.exe for Windows shims", () => {
    assert.deepEqual(buildArgvCommandPlan("npm", ["pack"], { platform: "linux" }), {
      command: "npm",
      args: ["pack"],
      windowsVerbatimArguments: false,
    });
    assert.deepEqual(buildArgvCommandPlan("C:\\Program Files\\nodejs\\npm.cmd", ["pack"], { platform: "win32", comspec: "C:\\Windows\\System32\\cmd.exe" }), {
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "C:\\Program Files\\nodejs\\npm.cmd", "pack"],
      windowsVerbatimArguments: false,
    });
    assert.deepEqual(buildArgvCommandPlan("C:\\Program Files\\nodejs\\node.exe", ["script.mjs"], { platform: "win32" }), {
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["script.mjs"],
      windowsVerbatimArguments: false,
    });
  });

  it("resolves the platform-specific global executable directory", () => {
    const prefix = mkdtempSync(path.join(os.tmpdir(), "qube-bin-layout-"));
    try {
      mkdirSync(path.join(prefix, "bin"));
      assert.equal(installedBinDir(prefix, "win32"), prefix);
      assert.equal(installedBinDir(prefix, "linux"), path.join(prefix, "bin"));
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });

  it("removes verifier-owned temporary directories", async () => {
    let ownedPrefix;
    const report = await runInstalledCommandVerification({
      repoRoot,
      releaseSet: true,
      skipPack: true,
      resolveReleasePackages: async () => ({ tag: "publish-set-v0.2.11", packages: [], commands: [] }),
    });
    ownedPrefix = report.prefix;
    assert.equal(report.ok, false);
    assert.equal(report.reasonCode, "usage");
    assert.equal(existsSync(ownedPrefix), false);
  });

  it("selects every package and command from the resolved prepared set", () => {
    const resolved = {
      packages: [
        { packageKey: "qube-core", packageName: "@tjalve/qube-core", version: "0.2.5", command: null },
        { packageKey: "aie", packageName: "@tjalve/aie", version: "0.2.8", command: "aie" },
        { packageKey: "qube", packageName: "@tjalve/qube", version: "0.2.11", command: "qube" },
      ],
    };
    const selected = selectPreparedReleasePackages({
      tag: "publish-set-v0.2.11",
      packages: [{ packageKey: "qube", packageName: "@tjalve/qube", version: "0.2.11" }],
    }, resolved);
    assert.equal(selected.tag, "publish-set-v0.2.11");
    assert.deepEqual(selected.packages, resolved.packages);
    assert.deepEqual(selected.commands, ["aie", "qube"]);
  });

  it("rejects empty and mismatched prepared release sets", () => {
    assert.throws(
      () => selectPreparedReleasePackages({ packages: [] }, { packages: [{}] }),
      { reasonCode: "empty-release-set" },
    );
    assert.throws(
      () => selectPreparedReleasePackages({
        packages: [{ packageKey: "qube", packageName: "@tjalve/qube", version: "0.2.11" }],
      }, {
        packages: [{ packageKey: "qube", packageName: "@tjalve/qube", version: "0.2.10", command: "qube" }],
      }),
      { reasonCode: "release-set-mismatch" },
    );
  });

  it("rejects prefix, pack dir, parent, and absolute escapes", () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), "qube-verify-root-"));
    try {
      writeFileSync(path.join(fixture, "package.json"), "{}\n");
      assert.throws(() => assertPrefixOutsideCheckout(fixture, path.join(fixture, "prefix")), {
        reasonCode: "prefix-inside-checkout",
      });
      assert.throws(() => assertPackDirOutsideCheckout(fixture, path.join(fixture, "packs")), {
        reasonCode: "pack-dir-inside-checkout",
      });
      assert.throws(() => assertPackDirOutsideCheckout(repoRoot, path.join(repoRoot, "tmp-pack")), {
        reasonCode: "pack-dir-inside-checkout",
      });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("rejects a symlink prefix that escapes the allowed root", {
    skip: process.platform === "win32",
  }, () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), "qube-verify-out-"));
    const fixture = mkdtempSync(path.join(os.tmpdir(), "qube-verify-link-"));
    try {
      const link = path.join(fixture, "escape");
      symlinkSync(outside, link);
      assert.throws(() => assertPrefixOutsideCheckout(outside, link), { reasonCode: "prefix-inside-checkout" });
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("probes installed shims and fails when a command does not start", async () => {
    // Released packages must start; a broken installed-command state fails the release process.
    const prefix = mkdtempSync(path.join(os.tmpdir(), "qube-verify-prefix-"));
    try {
      writeShim(prefix, "qube", "echo qube-ok");
      writeShim(prefix, "aie", "echo aie-ok");
      const good = probeInstalledCommand(prefix, "qube");
      assert.equal(good.command, "qube");
      assert.ok(resolveInstalledCommand(prefix, "aie"));

      writeShim(prefix, "aiu", "echo boom", 2);
      assert.throws(() => probeInstalledCommand(prefix, "aiu"), { reasonCode: "start-failed" });
      assert.equal(resolveInstalledCommand(prefix, "missing"), null);
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });

  it("accepts a prefix bin symlink that stays inside the install prefix", {
    skip: process.platform === "win32",
  }, () => {
    const prefix = mkdtempSync(path.join(os.tmpdir(), "qube-verify-link-in-"));
    try {
      const targetDir = path.join(prefix, "lib", "node_modules", "@tjalve", "aib");
      mkdirSync(targetDir, { recursive: true });
      const target = path.join(targetDir, "run");
      writeFileSync(target, "#!/bin/sh\necho aib-ok\n");
      chmodSync(target, 0o755);
      const binDir = path.join(prefix, "bin");
      mkdirSync(binDir, { recursive: true });
      symlinkSync(target, path.join(binDir, "aib"));
      assert.equal(resolveInstalledCommand(prefix, "aib"), path.join(binDir, "aib"));
      const probed = probeInstalledCommand(prefix, "aib");
      assert.equal(probed.status, 0);
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });

  it("accepts a relative prefix bin symlink that stays inside the install prefix", {
    skip: process.platform === "win32",
  }, () => {
    const prefix = mkdtempSync(path.join(os.tmpdir(), "qube-verify-link-rel-"));
    try {
      const targetDir = path.join(prefix, "lib", "node_modules", "@tjalve", "aib");
      mkdirSync(targetDir, { recursive: true });
      const target = path.join(targetDir, "run");
      writeFileSync(target, "#!/bin/sh\necho aib-ok\n");
      chmodSync(target, 0o755);
      const binDir = path.join(prefix, "bin");
      mkdirSync(binDir, { recursive: true });
      symlinkSync(path.relative(binDir, target), path.join(binDir, "aib"));
      assert.equal(resolveInstalledCommand(prefix, "aib"), path.join(binDir, "aib"));
      const probed = probeInstalledCommand(prefix, "aib");
      assert.equal(probed.status, 0);
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });

  it("rejects a prefix bin symlink that leaves the install prefix", {
    skip: process.platform === "win32",
  }, () => {
    const prefix = mkdtempSync(path.join(os.tmpdir(), "qube-verify-link-out-"));
    const outside = mkdtempSync(path.join(os.tmpdir(), "qube-verify-outside-"));
    try {
      const target = path.join(outside, "escape");
      writeFileSync(target, "#!/bin/sh\necho escaped\n");
      chmodSync(target, 0o755);
      const binDir = path.join(prefix, "bin");
      mkdirSync(binDir, { recursive: true });
      symlinkSync(target, path.join(binDir, "aib"));
      assert.equal(resolveInstalledCommand(prefix, "aib"), null);
      assert.throws(() => probeInstalledCommand(prefix, "aib"), { reasonCode: "missing-command" });
    } finally {
      rmSync(prefix, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects source-checkout runner text", () => {
    assert.throws(() => assertNoSourceCheckoutRunner("run `node products/aie/bin/run doctor`", "init"), {
      reasonCode: "source-runner",
    });
    assert.doesNotThrow(() => assertNoSourceCheckoutRunner("run `qube aie doctor`", "init"));
  });

  it("skips pack and reports start checks for fixture commands", async () => {
    const prefix = mkdtempSync(path.join(os.tmpdir(), "qube-verify-skip-"));
    try {
      writeIssueCommandShim(prefix, "qube", '{"ok":false,"command":"doctor","isRepo":false}');
      const report = await runInstalledCommandVerification({
        repoRoot,
        prefix,
        skipPack: true,
        commands: ["qube"],
      });
      assert.equal(report.ok, true, report.error);
      assert.deepEqual(report.probed.map(item => item.command), ["qube"]);
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });

  it("accepts the expected doctor diagnostic outside a repository", async () => {
    const prefix = mkdtempSync(path.join(os.tmpdir(), "qube-verify-doctor-"));
    try {
      writeIssueCommandShim(prefix, "aie", '{"ok":false,"command":"doctor","isRepo":false}');
      const report = await runInstalledCommandVerification({
        repoRoot,
        prefix,
        skipPack: true,
        commands: ["aie"],
      });
      assert.equal(report.ok, true, report.error);
      assert.equal(report.issueCommands.length, 3);
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });

  it("rejects malformed and crashed doctor diagnostics", async () => {
    const prefix = mkdtempSync(path.join(os.tmpdir(), "qube-verify-doctor-bad-"));
    try {
      for (const [output, exitCode, reasonCode] of [
        ['{"ok":false,"command":"doctor"}', 1, "invalid-doctor-diagnostic"],
        ["doctor crashed", 2, "start-failed"],
      ]) {
        writeIssueCommandShim(prefix, "aie", output, exitCode);
        const report = await runInstalledCommandVerification({
          repoRoot,
          prefix,
          skipPack: true,
          commands: ["aie"],
        });
        assert.equal(report.ok, false);
        assert.equal(report.reasonCode, reasonCode);
      }
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });

  it("rejects a set tag that does not match the qube version", async () => {
    await assert.rejects(() => resolvePublishTag("publish-set-v0.0.0", repoRoot), /does not match/);
  });

  it("uses verifyPackages from a filtered set plan so siblings stay local", async () => {
    const prefix = mkdtempSync(path.join(os.tmpdir(), "qube-verify-set-"));
    const planPath = path.join(repoRoot, "test", "tmp-verify-plan.json");
    try {
      writeIssueCommandShim(prefix, "qube", '{"ok":false,"command":"doctor","isRepo":false}');
      writeIssueCommandShim(prefix, "aie", '{"ok":false,"command":"doctor","isRepo":false}');
      writeFileSync(planPath, `${JSON.stringify({
        mode: "set",
        packages: [{ packageKey: "qube", packageName: "@tjalve/qube", version: "0.2.6", path: "products/qube", command: "qube" }],
        verifyPackages: [
          { packageKey: "qube", packageName: "@tjalve/qube", version: "0.2.6", path: "products/qube", command: "qube" },
          { packageKey: "aie", packageName: "@tjalve/aie", version: "0.2.5", path: "products/aie", command: "aie" },
        ],
      })}\n`);
      const report = await runInstalledCommandVerification({
        repoRoot,
        prefix,
        skipPack: true,
        planPath,
      });
      assert.equal(report.ok, true, report.error);
      assert.deepEqual(report.probed.map(item => item.command), ["qube", "aie"]);
    } finally {
      rmSync(prefix, { recursive: true, force: true });
      rmSync(planPath, { force: true });
    }
  });

  it("fails closed when neither a plan nor commands are provided", async () => {
    const prefix = mkdtempSync(path.join(os.tmpdir(), "qube-verify-empty-"));
    try {
      const report = await runInstalledCommandVerification({
        repoRoot,
        prefix,
        skipPack: true,
      });
      assert.equal(report.ok, false);
      assert.equal(report.reasonCode, "usage");
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });

  it("rejects a plan path outside the repository", async () => {
    const prefix = mkdtempSync(path.join(os.tmpdir(), "qube-verify-plan-"));
    try {
      const planPath = path.join(prefix, "plan.json");
      writeFileSync(planPath, "{\"packages\":[]}\n");
      const report = await runInstalledCommandVerification({
        repoRoot,
        prefix,
        skipPack: true,
        planPath,
      });
      assert.equal(report.ok, false);
      assert.equal(report.reasonCode, "path-escape");
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });
});
