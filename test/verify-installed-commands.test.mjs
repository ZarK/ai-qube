import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  assertNoSourceCheckoutRunner,
  assertPackDirOutsideCheckout,
  parseVerifyInstalledArgs,
  probeInstalledCommand,
  resolveInstalledCommand,
  runInstalledCommandVerification,
} from "../scripts/verify-installed-commands.mjs";
import { assertPrefixOutsideCheckout } from "../scripts/local-install-qube.mjs";
import { resolvePublishTag } from "../scripts/publish-packages.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function writeShim(prefix, command, body, exitCode = 0) {
  const binDir = path.join(prefix, "bin");
  mkdirSync(binDir, { recursive: true });
  const unix = path.join(binDir, command);
  const windows = path.join(binDir, `${command}.cmd`);
  writeFileSync(unix, `#!/bin/sh\n${body}\nexit ${exitCode}\n`);
  try {
    chmodSync(unix, 0o755);
  } catch {
    // Windows filesystems may reject POSIX mode bits.
  }
  writeFileSync(windows, `@echo off\r\n${body}\r\nexit /b ${exitCode}\r\n`);
}

describe("installed command verification", () => {
  it("parses plan and prefix flags", () => {
    assert.deepEqual(parseVerifyInstalledArgs(["--json", "--plan", "publish-plan.json", "--skip-pack"]), {
      json: true,
      help: false,
      plan: "publish-plan.json",
      prefix: undefined,
      repoRoot: undefined,
      packDir: undefined,
      skipPack: true,
      commands: undefined,
    });
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

  it("rejects source-checkout runner text", () => {
    assert.throws(() => assertNoSourceCheckoutRunner("run `node products/aie/bin/run doctor`", "init"), {
      reasonCode: "source-runner",
    });
    assert.doesNotThrow(() => assertNoSourceCheckoutRunner("run `qube aie doctor`", "init"));
  });

  it("skips pack and reports start checks for fixture commands", async () => {
    const prefix = mkdtempSync(path.join(os.tmpdir(), "qube-verify-skip-"));
    try {
      writeShim(prefix, "qube", "echo help");
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

  it("rejects a set tag that does not match the qube version", async () => {
    await assert.rejects(() => resolvePublishTag("publish-set-v0.0.0", repoRoot), /does not match/);
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
